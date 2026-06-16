// ─────────────────────────────────────────────────────────────
// SHORTSQUEEZEDETECTOR.JS — Short squeeze pressure algorithm
//
// A short squeeze occurs when heavily-shorted stocks rise sharply,
// forcing short sellers to buy to cover losses, which drives the
// price higher in a self-reinforcing feedback loop.
//
// Squeeze Pressure Score (0-1) is built from 5 components:
//
// 1. VOLUME-TO-FLOAT RATIO (most important):
//    Today's volume / float_shares
//    > 100% of float traded  → maximum squeeze pressure
//    > 50%                   → extreme
//    > 20%                   → elevated
//    Rationale: If volume exceeds float, every short had to trade
//    against massive buy-side pressure — classic squeeze signature.
//
// 2. PRICE VELOCITY (squeeze in motion):
//    % change from low of day to current price
//    Parabolic intraday moves = shorts being squeezed right now
//
// 3. CONSECUTIVE SQUEEZE DAYS:
//    Multi-day runners trap progressively more shorts.
//    Day 3+ of consecutive positive closes = shorts deeply trapped.
//
// 4. DAYS-TO-COVER ESTIMATE (DTC):
//    DTC = estimated short interest / avg daily volume
//    High DTC (>5 days) means it would take many days to unwind
//    shorts — if price moves, pain compounds quickly.
//    (Estimated here from price/volume patterns; real SI data
//    from FINRA/ORTEX requires a premium data subscription.)
//
// 5. GAP ANALYSIS:
//    Gap-up opens trap shorts who held overnight.
//    Larger gap = more trapped shorts = more forced buying.
//
// Combined squeeze score feeds into signal confidence:
//   squeeze score × 0.25 added to signal confidence cap
// ─────────────────────────────────────────────────────────────

import { atr, volumeRatio } from './indicators.js';

// ─── Component 1: Volume-to-Float pressure ───────────────────
function volumeFloatPressure(todayVolume, floatShares) {
  if (!floatShares || floatShares <= 0) return 0.30;  // Unknown float = neutral
  const ratio = todayVolume / floatShares;
  if (ratio >= 1.0)  return 1.00;   // 100%+ of float traded — extreme squeeze
  if (ratio >= 0.50) return 0.85;   // 50%+ of float
  if (ratio >= 0.25) return 0.65;   // 25%+ of float
  if (ratio >= 0.10) return 0.45;   // 10%+ of float
  if (ratio >= 0.05) return 0.25;   // 5%+ of float
  return 0.10;
}

// ─── Component 2: Intraday price velocity ────────────────────
// Measures how far price has moved from day's low (squeeze momentum)
function intradayVelocity(price, dailyLow, dailyHigh) {
  if (!dailyLow || !dailyHigh || dailyLow <= 0) return 0;
  const range    = dailyHigh - dailyLow;
  const fromLow  = price - dailyLow;
  const pct      = range > 0 ? (fromLow / dailyLow) * 100 : 0;

  if (pct >= 30)  return 1.00;   // Price surged 30%+ from day low
  if (pct >= 20)  return 0.85;
  if (pct >= 15)  return 0.70;
  if (pct >= 10)  return 0.55;
  if (pct >= 5)   return 0.35;
  if (pct >= 2)   return 0.20;
  return 0.05;
}

// ─── Component 3: Consecutive positive days ──────────────────
function consecutiveUpDays(dailyBars) {
  if (!dailyBars || dailyBars.length < 2) return 0;
  let streak = 0;
  for (let i = dailyBars.length - 1; i >= 1; i--) {
    if (dailyBars[i].close > dailyBars[i - 1].close) {
      streak++;
    } else {
      break;
    }
  }
  if (streak >= 5) return 1.00;
  if (streak >= 3) return 0.75;
  if (streak >= 2) return 0.50;
  if (streak >= 1) return 0.25;
  return 0;
}

// ─── Component 4: Estimated DTC (Days-to-Cover) ─────────────
// Without real SI data, we estimate: stocks with persistent low
// average volume but a sudden surge suggest a trapped short base.
// High estimated DTC = more potential squeeze pain per day.
function estimatedDtcScore(todayVolume, dailyBars) {
  if (!dailyBars || dailyBars.length < 5) return 0.30;

  // 20-day average volume (excluding today)
  const hist   = dailyBars.slice(-21, -1);
  const avgVol = hist.reduce((s, b) => s + b.volume, 0) / (hist.length || 1);

  // If today's volume is 10x+ normal AND price is up = shorts trapped
  const rvol = avgVol > 0 ? todayVolume / avgVol : 1;

  // Rough DTC: assume short interest = 20% of float (typical for high-SI stocks)
  // We can only estimate here — real data from ORTEX/FINRA is more accurate
  // DTC = (float × SI%) / avgVol → higher DTC = more squeeze potential
  // We use RVOL as a proxy: surging volume against trapped shorts = squeeze
  if (rvol >= 15) return 0.90;
  if (rvol >= 10) return 0.75;
  if (rvol >= 5)  return 0.55;
  if (rvol >= 3)  return 0.35;
  return 0.15;
}

// ─── Component 5: Gap-up analysis ────────────────────────────
// Gap-up opens trap shorts who held overnight at a loss
function gapUpScore(openPrice, prevClose) {
  if (!prevClose || prevClose <= 0) return 0;
  const gapPct = ((openPrice - prevClose) / prevClose) * 100;

  if (gapPct >= 30)  return 1.00;   // 30%+ gap = massive overnight short pain
  if (gapPct >= 20)  return 0.85;
  if (gapPct >= 10)  return 0.70;
  if (gapPct >= 5)   return 0.50;
  if (gapPct >= 2)   return 0.30;
  if (gapPct > 0)    return 0.10;
  return 0;  // Gapped down or flat = no bullish gap pressure
}

// ─── Main squeeze detector ────────────────────────────────────
export function detectSqueezeSetup(snapshot, dailyBars) {
  const {
    symbol, price, open, dailyHigh, dailyLow,
    volume, prevClose, floatShares,
  } = snapshot;

  // Component scores
  const volFloat  = volumeFloatPressure(volume, floatShares);
  const velocity  = intradayVelocity(price, dailyLow, dailyHigh);
  const streak    = consecutiveUpDays(dailyBars);
  const dtcScore  = estimatedDtcScore(volume, dailyBars);
  const gapScore  = gapUpScore(open, prevClose);

  // Weighted squeeze score
  const squeezeScore = (
    volFloat  * 0.30 +   // Volume vs float = most important
    velocity  * 0.25 +   // Intraday speed (squeeze in motion)
    dtcScore  * 0.20 +   // Estimated DTC (trapped shorts)
    gapScore  * 0.15 +   // Gap-up trapping
    streak    * 0.10     // Multi-day runner
  );

  // Classify squeeze intensity
  let intensity;
  if (squeezeScore >= 0.75)      intensity = 'EXTREME';
  else if (squeezeScore >= 0.55) intensity = 'HIGH';
  else if (squeezeScore >= 0.35) intensity = 'MODERATE';
  else                           intensity = 'LOW';

  // Build reasons list for signal display
  const reasons = [];
  const gap     = prevClose > 0 ? ((open - prevClose) / prevClose * 100) : 0;
  const fromLow = dailyLow  > 0 ? ((price - dailyLow) / dailyLow * 100)  : 0;

  if (floatShares > 0) {
    const vfRatio = (volume / floatShares * 100).toFixed(0);
    reasons.push(`${vfRatio}% of float traded today`);
  }
  if (fromLow >= 5)  reasons.push(`Up ${fromLow.toFixed(1)}% from day low`);
  if (gap >= 2)      reasons.push(`Gapped up ${gap.toFixed(1)}% at open`);

  const hist = dailyBars?.slice(-21, -1) ?? [];
  const avgVol = hist.length ? hist.reduce((s, b) => s + b.volume, 0) / hist.length : 0;
  const rvol   = avgVol > 0 ? (volume / avgVol).toFixed(1) : '?';
  if (parseFloat(rvol) >= 3) reasons.push(`${rvol}x normal volume (shorts covering)`);

  const consecutiveDays = (() => {
    let d = 0;
    if (!dailyBars || dailyBars.length < 2) return d;
    for (let i = dailyBars.length - 1; i >= 1; i--) {
      if (dailyBars[i].close > dailyBars[i - 1].close) d++; else break;
    }
    return d;
  })();
  if (consecutiveDays >= 2) reasons.push(`Day ${consecutiveDays} of consecutive gains`);

  return {
    symbol,
    squeezeScore: +squeezeScore.toFixed(3),
    intensity,
    isSqueezePlay: squeezeScore >= 0.35,
    components: {
      volumeToFloat: +volFloat.toFixed(3),
      intradayVelocity: +velocity.toFixed(3),
      estimatedDtc:     +dtcScore.toFixed(3),
      gapUp:            +gapScore.toFixed(3),
      consecutiveStreak: +streak.toFixed(3),
    },
    reasons,
    // Data note for UI
    dataNote: 'Short interest estimated from volume patterns. Connect ORTEX/FINRA for real SI%.',
  };
}
