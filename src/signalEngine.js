// ─────────────────────────────────────────────────────────────
// SIGNALENGINE.JS — Penny Stock Signal Generation
//
// Generates actionable BUY signals for penny stock runners.
// Signals are ranked by confidence (0-1).
//
// Signal Strategies:
//
//  1. VOLUME_SURGE — Core penny stock signal.
//     RVOL ≥3x with price up ≥5% + technical confirmation.
//     Confidence = runner score × catalyst multiplier.
//
//  2. SHORT_SQUEEZE — Squeeze pressure ≥ MODERATE.
//     High volume-to-float ratio + parabolic intraday move.
//     News catalyst or RVOL ≥10x gives extra conviction.
//
//  3. VWAP_RECLAIM — Price crosses above VWAP on volume.
//     Entry after a dip that held VWAP as support.
//     Requires RVOL ≥2x on the reclaim candle.
//
//  4. OPENING_RANGE_BREAKOUT (ORB) — Price breaks above
//     the high of the first 15 minutes of trading.
//     One of the most reliable intraday penny setups.
//
//  5. NEWS_CATALYST_PLAY — Strong catalyst (score ≥0.65)
//     even on moderate RVOL. News-driven moves can be large.
//
// Confidence modifiers:
//   News catalyst present:   × 1.20 (capped at 1.0)
//   Short squeeze HIGH+:     × 1.15
//   No news, low RVOL:       × 0.85
//
// Final confidence tiers:
//   ≥0.75 → HIGH  — auto-execute eligible
//   ≥0.55 → MEDIUM — alert only
//   <0.55 → LOW   — suppress
// ─────────────────────────────────────────────────────────────

import { SETTINGS } from './config.js';
import { computeAll, vwap } from './indicators.js';

export const SIGNAL_TYPES = {
  BUY:  'BUY',
  SELL: 'SELL',
  HOLD: 'HOLD',
  EXIT: 'EXIT',
};

const { STOP_LOSS_PCT, TAKE_PROFIT_PCT, TAKE_PROFIT_AGGRESSIVE, MIN_SIGNAL_SCORE } = SETTINGS;

// ─── Helpers ──────────────────────────────────────────────────

function stopLoss(price)         { return +(price * (1 - STOP_LOSS_PCT)).toFixed(4); }
function takeProfit(price)        { return +(price * (1 + TAKE_PROFIT_PCT)).toFixed(4); }
function takeProfitAgg(price)     { return +(price * (1 + TAKE_PROFIT_AGGRESSIVE)).toFixed(4); }

function capConfidence(raw) { return +Math.min(raw, 1.0).toFixed(3); }

// ─── 1. Volume Surge Signal ───────────────────────────────────
function volumeSurgeSignal(runner, newsData, squeezeData) {
  const { symbol, score, snapshot } = runner;
  const { price, rvol, changePct, vwap: vwapPrice } = snapshot;

  if (score.total < MIN_SIGNAL_SCORE) return null;

  let confidence = score.total;
  const reasons  = [];

  reasons.push(`RVOL ${rvol}x — ${rvol >= 10 ? 'explosive' : 'elevated'} volume`);
  reasons.push(`Up ${changePct.toFixed(1)}% today`);

  if (vwapPrice > 0 && price > vwapPrice) {
    reasons.push(`Holding above VWAP $${vwapPrice.toFixed(3)}`);
  }

  // News boost
  if (newsData?.hasCatalyst) {
    const boost = newsData.catalystScore * 0.20;
    confidence  = Math.min(confidence + boost, 1.0);
    reasons.push(`Catalyst: ${newsData.catalysts[0]?.label ?? 'recent news'}`);
  }

  // Squeeze boost
  if (squeezeData?.isSqueezePlay && squeezeData.intensity !== 'LOW') {
    const squeezeMult = { MODERATE: 1.08, HIGH: 1.12, EXTREME: 1.18 }[squeezeData.intensity] ?? 1;
    confidence = Math.min(confidence * squeezeMult, 1.0);
    reasons.push(`Squeeze pressure: ${squeezeData.intensity} (${squeezeData.reasons[0] ?? ''})`);
  }

  return {
    type:       SIGNAL_TYPES.BUY,
    strategy:   'volume_surge',
    symbol,
    confidence: capConfidence(confidence),
    reasons,
    price,
    stopLoss:    stopLoss(price),
    takeProfit:  takeProfit(price),
    takeProfitAggressive: takeProfitAgg(price),
    score,
    rvol:        runner.rvol,
    changePct:   runner.changePct,
    vwap:        vwapPrice,
    dailyHigh:   snapshot.dailyHigh,
    dailyLow:    snapshot.dailyLow,
    volume:      snapshot.volume,
  };
}

// ─── 2. Short Squeeze Signal ──────────────────────────────────
function shortSqueezeSignal(runner, newsData, squeezeData) {
  if (!squeezeData?.isSqueezePlay) return null;
  if (squeezeData.squeezeScore < 0.35) return null;

  const { symbol, snapshot } = runner;
  const { price, rvol, changePct } = snapshot;

  let confidence = squeezeData.squeezeScore;
  const reasons  = [...squeezeData.reasons];

  // News multiplier — squeeze + catalyst is extremely powerful
  if (newsData?.hasCatalyst) {
    confidence = Math.min(confidence * 1.25, 1.0);
    reasons.push(`Catalyst: ${newsData.catalysts[0]?.label ?? 'recent news'}`);
  }

  // RVOL multiplier
  if (rvol >= 10) {
    confidence = Math.min(confidence * 1.15, 1.0);
    reasons.push(`${rvol}x volume — shorts aggressively covering`);
  }

  if (confidence < MIN_SIGNAL_SCORE) return null;

  return {
    type:       SIGNAL_TYPES.BUY,
    strategy:   'short_squeeze',
    symbol,
    confidence: capConfidence(confidence),
    reasons,
    price,
    stopLoss:    stopLoss(price),
    takeProfit:  takeProfitAgg(price),    // Squeezes can run hard — target aggressive level
    takeProfitAggressive: +(price * 2).toFixed(4),  // 100% target for extreme squeezes
    squeezeScore:     squeezeData.squeezeScore,
    squeezeIntensity: squeezeData.intensity,
    squeezeType:      squeezeData.squeezeType,
    squeezeFuel:      squeezeData.fuel,
    squeezeIgnition:  squeezeData.ignition,
    shortInterest:    squeezeData.shortInterest,   // real SI from ORTEX/FINRA
    rvol,
    changePct,
    volume:  snapshot.volume,
    dailyHigh: snapshot.dailyHigh,
    dailyLow:  snapshot.dailyLow,
  };
}

// ─── 3. VWAP Reclaim Signal ───────────────────────────────────
function vwapReclaimSignal(symbol, minuteBars, snapshot, newsData) {
  if (!minuteBars || minuteBars.length < 20) return null;

  const price    = snapshot.price;
  const vwapVal  = snapshot.vwap;
  if (!vwapVal || vwapVal <= 0) return null;

  // Price must now be above VWAP
  if (price <= vwapVal) return null;

  // Check that the recent low was below VWAP (pullback + reclaim pattern)
  const recent   = minuteBars.slice(-15);
  const hadDip   = recent.some(b => b.low < vwapVal);
  if (!hadDip) return null;

  // Volume on reclaim should be above average
  const indicators = computeAll(minuteBars.slice(-30));
  if (!indicators.volRatio || indicators.volRatio < 1.5) return null;

  let confidence = 0.52;
  const reasons  = [`Price reclaimed VWAP $${vwapVal.toFixed(3)}`];
  reasons.push(`Volume ${indicators.volRatio.toFixed(1)}x on reclaim`);

  if (newsData?.hasCatalyst) {
    confidence = Math.min(confidence + 0.12, 1.0);
    reasons.push(`Catalyst: ${newsData.catalysts[0]?.label ?? 'recent news'}`);
  }
  if (snapshot.rvol >= 5) {
    confidence = Math.min(confidence + 0.08, 1.0);
    reasons.push(`RVOL ${snapshot.rvol}x backing the reclaim`);
  }

  if (confidence < MIN_SIGNAL_SCORE) return null;

  return {
    type:       SIGNAL_TYPES.BUY,
    strategy:   'vwap_reclaim',
    symbol,
    confidence: capConfidence(confidence),
    reasons,
    price,
    stopLoss:    +(vwapVal * 0.98).toFixed(4),    // Stop just below VWAP
    takeProfit:  takeProfit(price),
    takeProfitAggressive: takeProfitAgg(price),
    vwap: vwapVal,
    volRatio: indicators.volRatio,
    dailyHigh: snapshot.dailyHigh,
    dailyLow:  snapshot.dailyLow,
    volume:    snapshot.volume,
  };
}

// ─── 4. Opening Range Breakout (ORB) ─────────────────────────
// First 15 minutes of trading sets the opening range.
// Breakout above the high of that range = bullish ORB signal.
function orbSignal(symbol, minuteBars, snapshot, newsData) {
  if (!minuteBars || minuteBars.length < 20) return null;

  const price = snapshot.price;

  // Identify opening range: first 15 min bars (sorted chronologically)
  // Bars are sorted asc by time, so first bars = market open
  const todayStart = minuteBars.findIndex(b => {
    const d = new Date(b.timestamp);
    return d.getUTCHours() >= 13 && d.getUTCMinutes() >= 30;  // 9:30 AM ET = 13:30 UTC
  });

  const orbBars = todayStart >= 0
    ? minuteBars.slice(todayStart, todayStart + 15)
    : minuteBars.slice(0, 15);

  if (orbBars.length < 5) return null;

  const orbHigh = Math.max(...orbBars.map(b => b.high));
  const orbLow  = Math.min(...orbBars.map(b => b.low));

  // Must be breaking above ORB high now
  if (price <= orbHigh * 1.002) return null;  // 0.2% buffer to avoid fakeouts

  // Check volume is elevated on the breakout
  const indicators = computeAll(minuteBars.slice(-30));
  if (!indicators.volRatio || indicators.volRatio < 1.5) return null;

  let confidence = 0.58;
  const reasons  = [
    `ORB breakout: $${price.toFixed(3)} above opening range high $${orbHigh.toFixed(3)}`,
    `Opening range: $${orbLow.toFixed(3)} – $${orbHigh.toFixed(3)}`,
  ];

  if (newsData?.hasCatalyst) {
    confidence = Math.min(confidence + 0.15, 1.0);
    reasons.push(`Catalyst: ${newsData.catalysts[0]?.label ?? 'recent news'}`);
  }
  if (snapshot.rvol >= 5) {
    confidence = Math.min(confidence + 0.10, 1.0);
    reasons.push(`RVOL ${snapshot.rvol}x on breakout`);
  }
  if (indicators.volRatio >= 2) {
    confidence = Math.min(confidence + 0.05, 1.0);
    reasons.push(`Volume ${indicators.volRatio.toFixed(1)}x surging`);
  }

  if (confidence < MIN_SIGNAL_SCORE) return null;

  return {
    type:       SIGNAL_TYPES.BUY,
    strategy:   'opening_range_breakout',
    symbol,
    confidence: capConfidence(confidence),
    reasons,
    price,
    stopLoss:   +(orbLow * 0.99).toFixed(4),       // Stop below ORB low
    takeProfit:  takeProfit(price),
    takeProfitAggressive: takeProfitAgg(price),
    orbHigh,
    orbLow,
    volRatio:   indicators.volRatio,
    dailyHigh:  snapshot.dailyHigh,
    dailyLow:   snapshot.dailyLow,
    volume:     snapshot.volume,
  };
}

// ─── 5. News Catalyst Play ────────────────────────────────────
function newsCatalystSignal(symbol, snapshot, newsData) {
  if (!newsData?.hasCatalyst) return null;
  if (newsData.catalystScore < 0.55) return null;
  if (snapshot.changePct < 2) return null;       // Must have some price follow-through

  const { price, rvol, changePct } = snapshot;
  let confidence = Math.min(newsData.catalystScore * 0.80, 0.80);
  const reasons  = [
    `${newsData.catalysts[0]?.label ?? 'Catalyst'}: "${newsData.topHeadline?.slice(0, 80)}..."`,
    `Catalyst score: ${(newsData.catalystScore * 100).toFixed(0)}/100`,
  ];

  if (newsData.topAgeHours < 4)  reasons.push(`Breaking news (${newsData.topAgeHours.toFixed(1)}h ago)`);
  if (rvol && rvol >= 3)         reasons.push(`RVOL ${rvol}x — market reacting to news`);
  if (changePct > 0)             reasons.push(`Up ${changePct.toFixed(1)}% today`);

  if (rvol >= 5) confidence = Math.min(confidence + 0.08, 1.0);
  if (rvol >= 10) confidence = Math.min(confidence + 0.08, 1.0);

  if (confidence < MIN_SIGNAL_SCORE) return null;

  return {
    type:       SIGNAL_TYPES.BUY,
    strategy:   'news_catalyst',
    symbol,
    confidence: capConfidence(confidence),
    reasons,
    price,
    stopLoss:    stopLoss(price),
    takeProfit:  takeProfit(price),
    takeProfitAggressive: takeProfitAgg(price),
    catalystScore: newsData.catalystScore,
    topHeadline:   newsData.topHeadline,
    topSource:     newsData.topSource,
    rvol,
    changePct,
    dailyHigh:  snapshot.dailyHigh,
    dailyLow:   snapshot.dailyLow,
    volume:     snapshot.volume,
  };
}

// ─── Main: generate signals for all runners ───────────────────
export function generateSignals(runners, newsMap = {}, squeezeMap = {}, minuteBarsMap = {}) {
  const signals = [];

  for (const runner of runners) {
    const { symbol, snapshot } = runner;
    const newsData    = newsMap[symbol]    ?? null;
    const squeezeData = squeezeMap[symbol] ?? null;
    const minuteBars  = minuteBarsMap[symbol] ?? null;
    const catalyst    = runner.catalyst ?? null;   // multi-day watchlist context

    // Skip if news is bearish (dilution, SEC probe, etc.)
    if (newsData?.isBearish) continue;
    // Dilution kill-switch — a watchlist name flagged for an offering is
    // the classic run-killer; never signal it regardless of momentum.
    if (catalyst?.dilutionFlag || catalyst?.status === 'DILUTION_RISK') continue;

    // Generate all applicable signals for this runner
    const candidates = [
      volumeSurgeSignal(runner, newsData, squeezeData),
      shortSqueezeSignal(runner, newsData, squeezeData),
      vwapReclaimSignal(symbol, minuteBars, snapshot, newsData),
      orbSignal(symbol, minuteBars, snapshot, newsData),
      newsCatalystSignal(symbol, snapshot, newsData),
    ].filter(Boolean);

    // Per symbol: take the highest-confidence signal only
    if (candidates.length) {
      const best = candidates.sort((a, b) => b.confidence - a.confidence)[0];

      // Multi-day catalyst boost — a name whose catalyst has already been
      // confirming/holding for days is higher conviction than a same-day
      // pop. Applied here so it lifts whichever strategy fired.
      if (catalyst && (catalyst.status === 'CONFIRMED' || catalyst.status === 'CONFIRMING')) {
        const mult = catalyst.status === 'CONFIRMED' ? 1.12 : 1.06;
        best.confidence = capConfidence(best.confidence * mult);
        best.reasons = [
          `Catalyst ${catalyst.status.toLowerCase()} ${catalyst.dayCount}d: ${catalyst.catalyst?.label ?? 'news'} (${catalyst.confirmation?.followThroughPct ?? 0}% since)`,
          ...best.reasons,
        ];
        best.catalystContext = {
          status: catalyst.status, dayCount: catalyst.dayCount,
          label: catalyst.catalyst?.label, followThroughPct: catalyst.confirmation?.followThroughPct,
        };
      }

      signals.push({
        ...best,
        timestamp:    Date.now(),
        tier:         best.confidence >= 0.75 ? 'HIGH' : best.confidence >= 0.55 ? 'MEDIUM' : 'LOW',
        otherSignals: candidates.slice(1).map(s => ({ strategy: s.strategy, confidence: s.confidence })),
      });
    }
  }

  // Sort by confidence descending
  return signals
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, SETTINGS.MAX_SIGNALS);
}

// ─── Compatibility export (old server.js API shape) ──────────
export { generateSignals as default };
