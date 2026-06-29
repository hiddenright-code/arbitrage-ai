// ─────────────────────────────────────────────────────────────
// PENNYSTOCKSCANNER.JS — Runner Discovery & Scoring Engine
//
// The Runner Algorithm — how penny stock candidates are found:
//
//  Step 1 — DISCOVER: Pull top 100 most-active stocks from Alpaca.
//            Filter to price $0.10–$5.00 with ≥500K volume today.
//
//  Step 2 — FILTER: Must pass both:
//            • RVOL ≥ 3x (3× more volume than its 20-day average)
//            • Price up ≥ 5% today (confirmed momentum)
//
//  Step 3 — SCORE each candidate (0–1.0 total):
//
//    RVOL score (35% weight):
//      3–5x    → 0.30
//      5–10x   → 0.55
//      10–20x  → 0.80
//      20x+    → 1.00
//
//    Momentum score (30% weight):
//      5–10%   → 0.25
//      10–20%  → 0.50
//      20–50%  → 0.75
//      50%+    → 1.00
//
//    Technical score (20% weight):
//      + Above VWAP         → +0.35
//      + RSI < 70 (healthy) → +0.25
//      + Price in top 50% of day's range → +0.25
//      + MACD bullish       → +0.15
//
//    Float score (15% weight):
//      <5M shares    → 1.00 (explosive potential)
//      5–10M shares  → 0.85
//      10–20M shares → 0.70
//      20–50M shares → 0.50
//      50–200M shares→ 0.30
//      >200M shares  → 0.10
//
//  Step 4 — CLASSIFY:
//      ≥ 0.70 → STRONG_BUY  (high conviction runner)
//      ≥ 0.55 → BUY         (solid setup)
//      ≥ 0.40 → WATCH       (developing setup)
//      < 0.40 → skip
// ─────────────────────────────────────────────────────────────

import { SETTINGS } from './config.js';
import { computeAll } from './indicators.js';
import {
  fetchMostActive,
  fetchSnapshots,
  fetchDailyBars,
  fetchMinuteBars,
  calculateRvol,
} from './priceHistory.js';
import { getActiveSymbols, getCatalystContext } from './catalystWatchlist.js';
import { detectSqueezeSetup } from './shortSqueezeDetector.js';
import { scoreAnticipation, isBuilding } from './anticipation.js';

const { SCORE_WEIGHTS, PRICE_MIN, PRICE_MAX, MIN_DAILY_VOLUME,
        MIN_RVOL, MIN_CHANGE_PCT, MAX_RUNNERS, ANTICIPATION } = SETTINGS;

// ─── Component scoring functions ─────────────────────────────

function scoreRvol(rvol) {
  if (rvol >= 20) return 1.00;
  if (rvol >= 10) return 0.80;
  if (rvol >= 7)  return 0.65;
  if (rvol >= 5)  return 0.55;
  if (rvol >= 3)  return 0.30;
  return 0;
}

function scoreMomentum(changePct) {
  if (changePct >= 100) return 1.00;
  if (changePct >= 50)  return 0.90;
  if (changePct >= 30)  return 0.75;
  if (changePct >= 20)  return 0.55;
  if (changePct >= 10)  return 0.38;
  if (changePct >= 5)   return 0.20;
  return 0;
}

function scoreFloat(floatShares) {
  if (!floatShares || floatShares <= 0) return 0.30;  // Unknown = neutral
  if (floatShares < 5_000_000)   return 1.00;
  if (floatShares < 10_000_000)  return 0.85;
  if (floatShares < 20_000_000)  return 0.70;
  if (floatShares < 50_000_000)  return 0.50;
  if (floatShares < 200_000_000) return 0.30;
  return 0.10;
}

function scoreTechnical(snapshot, indicators) {
  let score   = 0;
  const notes = [];

  const { price, vwap, dailyHigh, dailyLow } = snapshot;

  if (vwap > 0 && price > vwap) {
    score += 0.35;
    notes.push(`Above VWAP $${vwap}`);
  } else if (vwap > 0) {
    notes.push(`Below VWAP $${vwap} — bearish bias`);
  }

  if (indicators?.rsi != null) {
    if (indicators.rsi < 70 && indicators.rsi > 30) {
      score += 0.25;
      notes.push(`RSI ${indicators.rsi} — healthy range`);
    } else if (indicators.rsi >= 70) {
      score -= 0.10;
      notes.push(`RSI ${indicators.rsi} — extended/overheated`);
    }
  }

  if (dailyHigh > 0 && dailyLow >= 0 && price > 0) {
    const range = dailyHigh - dailyLow;
    if (range > 0) {
      const pos = (price - dailyLow) / range;
      if (pos >= 0.5) {
        score += 0.25;
        notes.push(`Price at ${(pos * 100).toFixed(0)}% of day range (upper half)`);
      }
    }
  }

  if (indicators?.macd?.bullish) {
    score += 0.15;
    notes.push('MACD bullish momentum');
  }

  return { score: Math.max(0, Math.min(1, score)), notes };
}

// ─── Master scorer ────────────────────────────────────────────
export function scoreCandidate({ symbol, snapshot, dailyBars, minuteBars }) {
  const rvol      = snapshot.rvol      ?? 0;
  const changePct = snapshot.changePct ?? 0;
  const floatSh   = snapshot.floatShares ?? 0;

  const rvol_s = scoreRvol(rvol);
  const mom_s  = scoreMomentum(changePct);
  const flt_s  = scoreFloat(floatSh);

  // Use minute bars for intraday indicators, fall back to daily
  const barsForTech = minuteBars?.length >= 20
    ? minuteBars.slice(-60)     // Last 60 min bars
    : (dailyBars ?? []).slice(-20);

  const indicators = barsForTech.length >= 14 ? computeAll(barsForTech) : null;

  const { score: tech_s, notes: techNotes } = scoreTechnical(snapshot, indicators);

  const total = (
    rvol_s * SCORE_WEIGHTS.rvol     +
    mom_s  * SCORE_WEIGHTS.momentum +
    tech_s * SCORE_WEIGHTS.technical +
    flt_s  * SCORE_WEIGHTS.float
  );

  return {
    total:     +total.toFixed(3),
    rvol:      +rvol_s.toFixed(3),
    momentum:  +mom_s.toFixed(3),
    technical: +tech_s.toFixed(3),
    float:     +flt_s.toFixed(3),
    breakdown: { rvol, changePct, floatSh, price: snapshot.price, vwap: snapshot.vwap, techNotes },
  };
}

// ─── Signal classification ────────────────────────────────────
export function classifySignal(score) {
  if (score >= 0.70) return 'STRONG_BUY';
  if (score >= 0.55) return 'BUY';
  if (score >= 0.40) return 'WATCH';
  return 'SKIP';
}

// ─── Main scanner ─────────────────────────────────────────────
export async function scanRunners() {
  console.log('[Scanner] Starting penny stock scan...');

  // 1. Get most-active stocks
  const mostActive = await fetchMostActive(SETTINGS.TOP_ACTIVE_STOCKS);
  if (!mostActive.length) {
    console.log('[Scanner] No most-active data returned');
    return { runners: [], building: [] };
  }

  // 2. Pull snapshots for the most-active set PLUS any catalyst-watchlist
  //    names (hybrid model — a confirmed catalyst gets tracked intraday
  //    even before it cracks the most-actives list).
  const watchlistSymbols = getActiveSymbols();
  const symbols   = [...new Set([...mostActive.map(s => s.symbol), ...watchlistSymbols])];
  const snapshots = await fetchSnapshots(symbols);

  // 3. Pre-filter by penny stock criteria (price + volume). Catalyst-
  //    watchlist names bypass the volume floor — we track them on the
  //    catalyst, so a quiet name coiling on news still reaches scoring.
  const watchSet = new Set(watchlistSymbols);
  const pennySymbols = Object.entries(snapshots)
    .filter(([sym, snap]) => {
      const p = snap.price;
      if (p < PRICE_MIN || p > PRICE_MAX) return false;
      return snap.volume >= MIN_DAILY_VOLUME || watchSet.has(sym);
    })
    .map(([sym]) => sym);

  console.log(`[Scanner] ${pennySymbols.length} penny stock candidates (price $${PRICE_MIN}–$${PRICE_MAX}, vol ≥${MIN_DAILY_VOLUME.toLocaleString()} on ${SETTINGS.DATA_FEED} feed)`);

  if (!pennySymbols.length) return { runners: [], building: [] };

  // 4. Fetch daily bars for RVOL calculation (batched but serial to avoid rate limits)
  const runners  = [];
  const building = [];   // pre-run "BUILDING" setups (anticipation tier)

  await Promise.all(
    pennySymbols.map(async (symbol) => {
      try {
        const snap = snapshots[symbol];

        // Fetch 30 days of daily bars to compute RVOL baseline
        const dailyBars = await fetchDailyBars(symbol, 30);
        const rvol      = calculateRvol(snap.volume, dailyBars);
        snap.rvol       = rvol;
        const catalyst  = getCatalystContext(symbol);   // null unless on the watchlist

        // ── Confirmed RUNNER: move already underway (RVOL + momentum) ──
        if (rvol >= MIN_RVOL && snap.changePct >= MIN_CHANGE_PCT) {
          const minuteBars = await fetchMinuteBars(symbol, 120);
          const score      = scoreCandidate({ symbol, snapshot: snap, dailyBars, minuteBars });
          const tier       = classifySignal(score.total);
          if (tier === 'SKIP') return;

          runners.push({
            symbol, tier, score, snapshot: snap, catalyst, rvol,
            changePct: snap.changePct, price: snap.price, volume: snap.volume,
            vwap: snap.vwap, dailyHigh: snap.dailyHigh, dailyLow: snap.dailyLow,
            scannedAt: Date.now(),
          });
          return;
        }

        // ── Not yet running → score the pre-run SETUP (anticipation) ──
        if (!ANTICIPATION.ENABLED) return;
        const squeeze      = detectSqueezeSetup(snap, dailyBars, null);   // estimated fuel
        const anticipation = scoreAnticipation({ snapshot: snap, dailyBars, squeeze, catalyst });
        if (isBuilding(anticipation, snap, catalyst)) {
          building.push({
            symbol, tier: 'BUILDING', readiness: anticipation.readiness,
            setupScore: anticipation.setupScore, anticipation, squeeze, catalyst,
            snapshot: snap, rvol, changePct: snap.changePct, price: snap.price,
            volume: snap.volume, vwap: snap.vwap, scannedAt: Date.now(),
          });
        }
      } catch (err) {
        console.error(`[Scanner] ${symbol} error:`, err.message);
      }
    })
  );

  // 5. Sort each list by strength, cap, return both.
  const sortedRunners  = runners.sort((a, b) => b.score.total - a.score.total).slice(0, MAX_RUNNERS);
  const sortedBuilding = building.sort((a, b) => b.setupScore - a.setupScore).slice(0, ANTICIPATION.MAX_BUILDING);

  console.log(`[Scanner] Found ${sortedRunners.length} runners (${runners.filter(r => r.tier === 'STRONG_BUY').length} STRONG_BUY) · ${sortedBuilding.length} building`);
  return { runners: sortedRunners, building: sortedBuilding };
}
