// ─────────────────────────────────────────────────────────────
// SHORTSQUEEZEDETECTOR.JS — State-of-the-art squeeze scoring
//
// A short squeeze needs TWO things to happen together:
//
//   FUEL (the loaded powder keg) — a large, trapped short position.
//     Measured from REAL short-interest data (ORTEX / FINRA):
//       • SI % of free float   — the single most important metric.
//                                 >20% high, >40% extreme.
//       • Days to Cover (DTC)  — SI ÷ avg daily volume. How many days
//                                 of buying shorts need to exit. >5 is hard.
//       • Cost to Borrow (CTB) — annualized fee to stay short. Rising/
//                                 high CTB (>20%, sometimes >100%) means
//                                 shorts are bleeding and pressured to cover.
//       • Utilization          — % of lendable shares already lent. ~100%
//                                 = no shares left to borrow = hard-to-borrow.
//       • SI trend             — shorts ADDING into a rising price = the
//                                 most dangerous (deeply trapped) setup.
//
//   IGNITION (the lit fuse) — the squeeze actually firing now.
//     Measured from price/volume action:
//       • Volume-to-float, intraday velocity, gap-up, RVOL, up-day streak.
//
// High SI with no price action is a trap that never springs. A price
// spike with no trapped shorts is just momentum, not a squeeze. The
// edge is in the OVERLAP — so we score each side independently, blend
// them, and add a synergy bonus when both are strong simultaneously.
//
// When no real SI data is available the detector still works: fuel is
// estimated from volume patterns and flagged as lower-confidence.
// ─────────────────────────────────────────────────────────────

import { SETTINGS } from './config.js';

const SQ = SETTINGS.SQUEEZE;

// ─── FUEL component scorers (from real SI data) ──────────────

function scoreSiPercentFloat(si) {
  if (si == null) return null;
  if (si >= 50) return 1.00;   // Extraordinarily shorted
  if (si >= 40) return 0.92;
  if (si >= 30) return 0.80;
  if (si >= 20) return 0.65;   // "High SI" threshold
  if (si >= 15) return 0.50;
  if (si >= 10) return 0.35;
  if (si >= 5)  return 0.20;
  return 0.05;
}

function scoreDaysToCover(dtc) {
  if (dtc == null) return null;
  if (dtc >= 10) return 1.00;
  if (dtc >= 7)  return 0.85;
  if (dtc >= 5)  return 0.70;  // Classic "hard to cover"
  if (dtc >= 3)  return 0.50;
  if (dtc >= 2)  return 0.35;
  if (dtc >= 1)  return 0.20;
  return 0.05;
}

function scoreCostToBorrow(ctb) {
  if (ctb == null) return null;   // annualized %
  if (ctb >= 100) return 1.00;    // Brutal borrow fees
  if (ctb >= 50)  return 0.88;
  if (ctb >= 30)  return 0.72;
  if (ctb >= 20)  return 0.58;
  if (ctb >= 10)  return 0.42;
  if (ctb >= 5)   return 0.25;
  if (ctb >= 1)   return 0.12;
  return 0.05;
}

function scoreUtilization(util) {
  if (util == null) return null;  // %
  if (util >= 99) return 1.00;    // No shares left to borrow
  if (util >= 95) return 0.85;
  if (util >= 90) return 0.70;    // Hard-to-borrow territory
  if (util >= 80) return 0.50;
  if (util >= 60) return 0.30;
  if (util >= 40) return 0.15;
  return 0.05;
}

// Weighted fuel from whichever real components are present, with the
// weights re-normalized over only the available ones.
function fuelFromRealData(si) {
  const parts = [
    ['siPercentFloat', scoreSiPercentFloat(si.siPercentFloat), SQ.FUEL_WEIGHTS.siPercentFloat],
    ['daysToCover',    scoreDaysToCover(si.daysToCover),       SQ.FUEL_WEIGHTS.daysToCover],
    ['costToBorrow',   scoreCostToBorrow(si.costToBorrow),     SQ.FUEL_WEIGHTS.costToBorrow],
    ['utilization',    scoreUtilization(si.utilization),       SQ.FUEL_WEIGHTS.utilization],
  ].filter(([, score]) => score != null);

  const components = {};
  for (const [name, score] of parts) components[name] = +score.toFixed(3);

  if (!parts.length) return { score: null, components };

  const totalW = parts.reduce((s, [, , w]) => s + w, 0);
  let fuel = parts.reduce((s, [, score, w]) => s + score * w, 0) / totalW;

  // SI-trend modifier: shorts adding into strength = more trapped.
  if (si.siTrend === 'rising')      fuel = Math.min(fuel * 1.10, 1);
  else if (si.siTrend === 'falling') fuel = fuel * 0.85; // already covering

  return { score: +Math.min(fuel, 1).toFixed(3), components };
}

// Fallback fuel estimate from volume patterns (no real SI data).
// Surging volume against a normally-quiet name implies a trapped base.
function fuelFromEstimate(snapshot, dailyBars) {
  const hist   = dailyBars?.slice(-21, -1) ?? [];
  const avgVol = hist.length ? hist.reduce((s, b) => s + b.volume, 0) / hist.length : 0;
  const rvol   = avgVol > 0 ? snapshot.volume / avgVol : 1;

  let est;
  if (rvol >= 15) est = 0.80;
  else if (rvol >= 10) est = 0.65;
  else if (rvol >= 5)  est = 0.48;
  else if (rvol >= 3)  est = 0.32;
  else est = 0.15;

  est *= SQ.ESTIMATED_FUEL_DISCOUNT;  // lower confidence than real data
  return { score: +est.toFixed(3), components: { estimatedFromRvol: +rvol.toFixed(1) } };
}

// ─── IGNITION component scorers (from price/volume) ──────────

function scoreVolumeToFloat(volume, floatShares) {
  if (!floatShares || floatShares <= 0) return null;
  const ratio = volume / floatShares;
  if (ratio >= 1.0)  return 1.00;   // Entire float churned — explosive
  if (ratio >= 0.50) return 0.85;
  if (ratio >= 0.25) return 0.65;
  if (ratio >= 0.10) return 0.45;
  if (ratio >= 0.05) return 0.25;
  return 0.10;
}

function scoreVelocity(price, dailyLow) {
  if (!dailyLow || dailyLow <= 0) return 0;
  const pct = ((price - dailyLow) / dailyLow) * 100;
  if (pct >= 30) return 1.00;
  if (pct >= 20) return 0.85;
  if (pct >= 15) return 0.70;
  if (pct >= 10) return 0.55;
  if (pct >= 5)  return 0.35;
  if (pct >= 2)  return 0.20;
  return 0.05;
}

function scoreGapUp(open, prevClose) {
  if (!prevClose || prevClose <= 0) return 0;
  const gap = ((open - prevClose) / prevClose) * 100;
  if (gap >= 30) return 1.00;
  if (gap >= 20) return 0.85;
  if (gap >= 10) return 0.70;
  if (gap >= 5)  return 0.50;
  if (gap >= 2)  return 0.30;
  if (gap > 0)   return 0.10;
  return 0;
}

function scoreRvol(volume, dailyBars) {
  const hist   = dailyBars?.slice(-21, -1) ?? [];
  const avgVol = hist.length ? hist.reduce((s, b) => s + b.volume, 0) / hist.length : 0;
  const rvol   = avgVol > 0 ? volume / avgVol : 1;
  if (rvol >= 15) return 1.00;
  if (rvol >= 10) return 0.80;
  if (rvol >= 5)  return 0.55;
  if (rvol >= 3)  return 0.35;
  return 0.10;
}

function consecutiveUpDays(dailyBars) {
  if (!dailyBars || dailyBars.length < 2) return 0;
  let streak = 0;
  for (let i = dailyBars.length - 1; i >= 1; i--) {
    if (dailyBars[i].close > dailyBars[i - 1].close) streak++; else break;
  }
  return streak;
}

function scoreConsecutive(streak) {
  if (streak >= 5) return 1.00;
  if (streak >= 3) return 0.75;
  if (streak >= 2) return 0.50;
  if (streak >= 1) return 0.25;
  return 0;
}

function ignitionScore(snapshot, dailyBars, floatShares) {
  const { price, open, dailyLow, prevClose, volume } = snapshot;

  const parts = [
    ['volumeToFloat', scoreVolumeToFloat(volume, floatShares), SQ.IGNITION_WEIGHTS.volumeToFloat],
    ['velocity',      scoreVelocity(price, dailyLow),          SQ.IGNITION_WEIGHTS.velocity],
    ['gapUp',         scoreGapUp(open, prevClose),             SQ.IGNITION_WEIGHTS.gapUp],
    ['rvol',          scoreRvol(volume, dailyBars),            SQ.IGNITION_WEIGHTS.rvol],
    ['consecutive',   scoreConsecutive(consecutiveUpDays(dailyBars)), SQ.IGNITION_WEIGHTS.consecutive],
  ].filter(([, score]) => score != null);

  const components = {};
  for (const [name, score] of parts) components[name] = +score.toFixed(3);

  const totalW = parts.reduce((s, [, , w]) => s + w, 0) || 1;
  const score  = parts.reduce((s, [, sc, w]) => s + sc * w, 0) / totalW;
  return { score: +Math.min(score, 1).toFixed(3), components };
}

// ─── Squeeze "type" tag — helps explain WHY it's a squeeze ──
function classifyType(si, fuel, ignition) {
  if (si?.utilization >= 90 && (si?.costToBorrow ?? 0) >= 20) return 'HARD_TO_BORROW';
  if ((si?.siPercentFloat ?? 0) >= 30)                        return 'HIGH_SHORT_INTEREST';
  if ((si?.daysToCover ?? 0) >= 5)                            return 'HIGH_DAYS_TO_COVER';
  if (ignition >= 0.6 && fuel < 0.4)                          return 'MOMENTUM_ONLY';
  if (fuel >= 0.6 && ignition < 0.4)                          return 'LOADED_NOT_FIRING';
  return 'DEVELOPING';
}

// ─── Main squeeze detector ────────────────────────────────────
// shortInterest is the normalized object from shortInterestData.js
// (may be null / hasRealData=false → estimate fallback).
export function detectSqueezeSetup(snapshot, dailyBars, shortInterest = null) {
  const si = shortInterest ?? { hasRealData: false };
  const hasRealData = !!si.hasRealData;

  // Prefer real free float for float-based math
  const floatShares = si.freeFloat || snapshot.floatShares || 0;

  // FUEL (short-side setup)
  const fuelResult = hasRealData
    ? fuelFromRealData(si)
    : fuelFromEstimate(snapshot, dailyBars);
  // If real data existed but yielded no scorable component, fall back.
  const fuel = fuelResult.score ?? fuelFromEstimate(snapshot, dailyBars).score;

  // IGNITION (price/volume trigger)
  const ign = ignitionScore(snapshot, dailyBars, floatShares);

  // Blend
  let score = fuel * SQ.FUEL_WEIGHT + ign.score * SQ.IGNITION_WEIGHT;

  // Synergy bonus — the real edge is both firing at once
  let synergy = false;
  if (fuel >= SQ.SYNERGY_FLOOR && ign.score >= SQ.SYNERGY_FLOOR) {
    score += SQ.SYNERGY_BONUS;
    synergy = true;
  }
  score = +Math.min(Math.max(score, 0), 1).toFixed(3);

  // Intensity tier
  const T = SQ.TIERS;
  const intensity = score >= T.EXTREME ? 'EXTREME'
                  : score >= T.HIGH    ? 'HIGH'
                  : score >= T.MODERATE? 'MODERATE'
                  : 'LOW';

  const squeezeType = classifyType(si, fuel, ign.score);

  // ── Human-readable reasons ──────────────────────────────────
  const reasons = [];
  if (hasRealData) {
    if (si.siPercentFloat != null) reasons.push(`SI ${si.siPercentFloat.toFixed(1)}% of float${si.siPercentFloat >= 20 ? ' (high)' : ''}`);
    if (si.daysToCover    != null) reasons.push(`${si.daysToCover.toFixed(1)} days to cover`);
    if (si.costToBorrow   != null) reasons.push(`Cost to borrow ${si.costToBorrow.toFixed(0)}%`);
    if (si.utilization    != null) reasons.push(`${si.utilization.toFixed(0)}% utilization${si.utilization >= 90 ? ' (hard to borrow)' : ''}`);
    if (si.siTrend === 'rising')   reasons.push('Short interest rising into strength');
  } else {
    reasons.push('SI estimated from volume (connect ORTEX/FINRA for real data)');
  }

  const fromLow = snapshot.dailyLow > 0 ? ((snapshot.price - snapshot.dailyLow) / snapshot.dailyLow * 100) : 0;
  const gap     = snapshot.prevClose > 0 ? ((snapshot.open - snapshot.prevClose) / snapshot.prevClose * 100) : 0;
  if (floatShares > 0) reasons.push(`${(snapshot.volume / floatShares * 100).toFixed(0)}% of float traded`);
  if (fromLow >= 5) reasons.push(`Up ${fromLow.toFixed(1)}% from day low`);
  if (gap >= 2)     reasons.push(`Gapped up ${gap.toFixed(1)}%`);
  if (synergy)      reasons.push('⚡ Fuel + ignition aligned');

  return {
    symbol:       snapshot.symbol,
    squeezeScore: score,
    intensity,
    squeezeType,
    isSqueezePlay: score >= T.MODERATE,
    synergy,
    // Sub-scores
    fuel:     +fuel.toFixed(3),
    ignition: ign.score,
    // Real SI snapshot (null fields when unavailable)
    shortInterest: hasRealData ? {
      source:         si.source,
      siPercentFloat: si.siPercentFloat,
      daysToCover:    si.daysToCover,
      costToBorrow:   si.costToBorrow,
      utilization:    si.utilization,
      sharesShort:    si.sharesShort,
      freeFloat:      si.freeFloat,
      siTrend:        si.siTrend,
      asOf:           si.asOf,
      stale:          si.stale,
    } : null,
    components: {
      fuel:     fuelResult.components,
      ignition: ign.components,
    },
    dataSource: hasRealData ? si.source : 'estimated',
    reasons,
  };
}
