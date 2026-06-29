// ─────────────────────────────────────────────────────────────
// ANTICIPATION.JS — "BUILDING" tier: pre-run setup scoring
//
// The runner scanner is confirmation-only — it needs the move already
// underway (up ≥5% + RVOL ≥3x). This module scores the SETUP *before*
// ignition, so a stock that's loaded but hasn't popped yet still surfaces:
//
//   FUEL     — loaded shorts (real ORTEX SI) or unusual-volume-on-a-quiet
//              base (estimate). Reuses the squeeze detector's fuel score.
//   CATALYST — a fresh news catalyst on the multi-day watchlist that's
//              holding / confirming but hasn't triggered intraday yet.
//   COIL     — a tight consolidation / accumulation base: higher lows,
//              volume creeping in, price coiling under resistance, and
//              crucially NOT already extended (we want pre-breakout).
//   STIR     — faint early signs (reclaiming VWAP, off the lows) WITHOUT
//              full ignition — the fuse starting to catch.
//
// A name qualifies as BUILDING only when the setup is strong AND ignition
// is still low (otherwise it's just a runner). Watch-only by design.
// ─────────────────────────────────────────────────────────────

import { SETTINGS } from './config.js';

const A = SETTINGS.ANTICIPATION;

// ─── COIL / accumulation base score (from daily bars) ────────
// Rewards tight consolidation, higher lows, volume creep and coiling
// under resistance; penalizes names already extended off their base.
function coilScore(snapshot, dailyBars) {
  const bars = dailyBars ?? [];
  if (bars.length < 10) return { score: 0.2, notes: ['thin history'] };

  const recent = bars.slice(-10);
  const prior  = bars.slice(-25, -10);
  const closes = recent.map(b => b.close);
  const highs  = recent.map(b => b.high);
  const lows   = recent.map(b => b.low);
  const price  = snapshot.price;
  const notes  = [];
  let score = 0;

  // 1. Tight range = consolidation (coil). Range over last 10d vs price.
  const hi = Math.max(...highs), lo = Math.min(...lows);
  const rangePct = lo > 0 ? (hi - lo) / lo : 1;
  if (rangePct <= 0.25)      { score += 0.30; notes.push(`tight ${(rangePct * 100).toFixed(0)}% base`); }
  else if (rangePct <= 0.45) { score += 0.18; notes.push(`coiling ${(rangePct * 100).toFixed(0)}% range`); }

  // 2. Higher lows over the last few sessions = accumulation.
  const l = lows.slice(-4);
  if (l.length >= 3 && l[0] < l[l.length - 1] && l.every((v, i) => i === 0 || v >= l[i - 1] * 0.98)) {
    score += 0.22; notes.push('higher lows');
  }

  // 3. Volume creep — recent avg volume rising vs the prior window.
  const recentVol = recent.reduce((s, b) => s + b.volume, 0) / recent.length;
  const priorVol  = prior.length ? prior.reduce((s, b) => s + b.volume, 0) / prior.length : recentVol;
  if (priorVol > 0 && recentVol >= priorVol * 1.3) { score += 0.20; notes.push('volume building'); }

  // 4. Coiling under resistance — price near the top of its base (ready).
  if (hi > lo) {
    const pos = (price - lo) / (hi - lo);
    if (pos >= 0.6 && pos <= 0.98) { score += 0.18; notes.push('coiling under resistance'); }
  }

  // 5. Penalty — already extended off the base = we missed "pre-run".
  const baseAvg = closes.reduce((s, c) => s + c, 0) / closes.length;
  if (baseAvg > 0 && price > baseAvg * 1.4) { score -= 0.25; notes.push('already extended'); }

  return { score: +Math.max(0, Math.min(score, 1)).toFixed(3), notes };
}

// ─── STIR — faint early ignition (fuse catching, not yet firing) ─
function stirScore(snapshot) {
  let score = 0;
  const notes = [];
  const { price, vwap, dailyLow, changePct } = snapshot;

  if (vwap > 0 && price > vwap)          { score += 0.4; notes.push('back above VWAP'); }
  if (dailyLow > 0) {
    const offLow = (price - dailyLow) / dailyLow * 100;
    if (offLow >= 3 && offLow < 15)      { score += 0.35; notes.push(`+${offLow.toFixed(1)}% off lows`); }
  }
  if (changePct > 0 && changePct < A.MAX_CHANGE_PCT) { score += 0.25; notes.push(`green ${changePct.toFixed(1)}%`); }

  return { score: +Math.min(score, 1).toFixed(3), notes };
}

// ─── CATALYST readiness (from the watchlist context) ─────────
function catalystScore(catalyst) {
  if (!catalyst) return { score: 0, notes: [] };
  if (catalyst.dilutionFlag) return { score: 0, notes: ['dilution risk'] };

  const byStatus = { CONFIRMED: 1.0, CONFIRMING: 0.8, PENDING: 0.55, FADING: 0.1 };
  let score = byStatus[catalyst.status] ?? 0.4;
  // Blend in the raw catalyst strength.
  score = score * 0.7 + (catalyst.catalyst?.score ?? 0) * 0.3;

  const notes = [`${catalyst.catalyst?.label ?? 'catalyst'} (${catalyst.status?.toLowerCase()} ${catalyst.dayCount ?? 0}d)`];
  return { score: +Math.min(score, 1).toFixed(3), notes };
}

// ─── Master: score a pre-run setup ───────────────────────────
// squeeze = detectSqueezeSetup() output (gives us .fuel + .ignition)
// catalyst = getCatalystContext() (may be null)
export function scoreAnticipation({ snapshot, dailyBars, squeeze, catalyst }) {
  // Drop the squeeze detector's "SI estimated — connect ORTEX/FINRA" note:
  // it's stale here (ORTEX is connected; building names just use estimated
  // fuel to avoid rate-limiting the watchlist on every scan).
  const fuel = {
    score: squeeze?.fuel ?? 0,
    notes: (squeeze?.reasons ?? []).filter(r => !/estimated from volume/i.test(r)).slice(0, 2),
  };
  const cat  = catalystScore(catalyst);
  const coil = coilScore(snapshot, dailyBars);
  const stir = stirScore(snapshot);

  // Weighted blend, re-normalized over components that carry signal.
  const W = A.WEIGHTS;
  const parts = [
    ['fuel',     fuel.score, W.fuel],
    ['catalyst', cat.score,  W.catalyst],
    ['coil',     coil.score, W.coil],
    ['stir',     stir.score, W.stir],
  ];
  const totalW = parts.reduce((s, [, , w]) => s + w, 0);
  const score  = +(parts.reduce((s, [, v, w]) => s + v * w, 0) / totalW).toFixed(3);

  // Readiness tier — how close to ignition.
  const ignition = squeeze?.ignition ?? 0;
  const readiness = score >= 0.70 ? 'PRIMED'
                  : score >= 0.55 ? 'BUILDING'
                  : 'EARLY';

  const reasons = [
    ...cat.notes,
    ...fuel.notes,
    ...coil.notes,
    ...stir.notes,
  ].slice(0, 6);

  return {
    setupScore: score,
    readiness,
    ignition,
    components: { fuel: fuel.score, catalyst: cat.score, coil: coil.score, stir: stir.score },
    reasons,
  };
}

// Gate: is this a BUILDING candidate? Not yet ignited, and either a strong
// blended setup OR a fresh confirming/confirmed catalyst (which is itself a
// pre-run thesis even when the technical setup is still soft).
export function isBuilding(anticipation, snapshot, catalyst = null) {
  const notIgnited = anticipation.ignition < A.IGNITION_CEILING
                  && (snapshot.changePct ?? 0) < A.MAX_CHANGE_PCT;
  if (!notIgnited) return false;

  const catalystThesis = catalyst
    && !catalyst.dilutionFlag
    && A.CATALYST_OVERRIDE.includes(catalyst.status);

  return anticipation.setupScore >= A.MIN_SETUP_SCORE || catalystThesis;
}
