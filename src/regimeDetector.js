// ─────────────────────────────────────────────────────────────
// REGIMEDETECTOR.JS — Detects market regime per coin
//
// Regime = the current market condition:
//   TRENDING_UP   — strong uptrend, use momentum/trend strategies
//   TRENDING_DOWN — strong downtrend, avoid longs
//   RANGING       — sideways, use mean reversion strategies
//   VOLATILE      — high volatility, reduce position size
//
// Method:
//   1. ADX > 25 → trending. ADX < 20 → ranging.
//   2. Bollinger Band width: narrow = ranging, wide = volatile/trending
//   3. EMA alignment: 9 > 21 > 50 = bullish trend, inverse = bearish
// ─────────────────────────────────────────────────────────────

import { adx, bollingerBands, ema } from './indicators.js';

export const REGIMES = {
  TRENDING_UP:   'TRENDING_UP',
  TRENDING_DOWN: 'TRENDING_DOWN',
  RANGING:       'RANGING',
  VOLATILE:      'VOLATILE',
};

// Historical band width averages per coin (updated as we see data)
const bandWidthHistory = {};

// Regime memory for hysteresis — prevents rapid flipping near boundaries
const regimeMemory = {};

// ─── Detect regime for a single coin ─────────────────────────
export function detectRegime(coin, candles) {
  if (!candles || candles.length < 50) {
    return { regime: REGIMES.RANGING, confidence: 0, reason: 'Insufficient data' };
  }

  const adxResult = adx(candles, 14);
  const bb        = bollingerBands(candles, 20, 2);
  const ema9val   = ema(candles, 9);
  const ema21val  = ema(candles, 21);
  const ema50val  = ema(candles, 50);

  if (!adxResult || !bb || !ema9val || !ema21val || !ema50val) {
    return { regime: REGIMES.RANGING, confidence: 0, reason: 'Indicator calculation failed' };
  }

  // Track band width history for this coin
  if (!bandWidthHistory[coin]) bandWidthHistory[coin] = [];
  bandWidthHistory[coin].push(bb.width);
  if (bandWidthHistory[coin].length > 50) bandWidthHistory[coin].shift();

  const avgWidth   = bandWidthHistory[coin].reduce((s, x) => s + x, 0) / bandWidthHistory[coin].length;
  const widthRatio = bb.width / avgWidth; // > 1.5 = unusually wide = volatile

  const price = candles[candles.length - 1].close;
  const bullishEma = ema9val > ema21val && ema21val > ema50val;
  const bearishEma = ema9val < ema21val && ema21val < ema50val;

  let regime, confidence, reason;

  // Volatile: band width is 1.5x+ wider than average
  if (widthRatio > 1.5) {
    regime     = REGIMES.VOLATILE;
    confidence = Math.min(widthRatio / 2, 1);
    reason     = `BB width ${(widthRatio).toFixed(2)}x above avg — high volatility`;
  }
  // Strong trend: ADX > 25 + EMA alignment
  else if (adxResult.trending) {
    if (bullishEma && price > ema21val) {
      regime     = REGIMES.TRENDING_UP;
      confidence = Math.min(adxResult.adx / 50, 1);
      reason     = `ADX ${adxResult.adx} + bullish EMA stack`;
    } else if (bearishEma && price < ema21val) {
      regime     = REGIMES.TRENDING_DOWN;
      confidence = Math.min(adxResult.adx / 50, 1);
      reason     = `ADX ${adxResult.adx} + bearish EMA stack`;
    } else {
      // ADX trending but EMA mixed — treat as volatile
      regime     = REGIMES.VOLATILE;
      confidence = 0.5;
      reason     = `ADX ${adxResult.adx} but mixed EMA — transitioning`;
    }
  }
  // Ranging: ADX < 20, narrow bands
  else if (adxResult.ranging && widthRatio < 1.2) {
    regime     = REGIMES.RANGING;
    confidence = Math.min((25 - adxResult.adx) / 25, 1);
    reason     = `ADX ${adxResult.adx} + narrow BB width — range-bound`;
  }
  // Default to ranging
  else {
    regime     = REGIMES.RANGING;
    confidence = 0.4;
    reason     = `ADX ${adxResult.adx} — weak trend, default ranging`;
  }

  // Hysteresis: don't switch regime unless signal is strong enough
  // Prevents strategy thrashing near ADX/BB boundaries
  const previous = regimeMemory[coin];
  if (previous && previous.regime !== regime) {
    const adxBuffer   = 3;
    const movedEnough =
      (regime === REGIMES.TRENDING_UP   && adxResult.adx > 25 + adxBuffer) ||
      (regime === REGIMES.RANGING       && adxResult.adx < 20 - adxBuffer) ||
      (regime === REGIMES.VOLATILE      && widthRatio > 1.5 + 0.2)         ||
      (regime === REGIMES.TRENDING_DOWN && adxResult.adx > 25 + adxBuffer);

    if (!movedEnough) {
      regime     = previous.regime;
      confidence = +(previous.confidence * 0.9).toFixed(3);
      reason     = `Holding ${previous.regime} — boundary buffer active`;
    }
  }

  regimeMemory[coin] = { regime, confidence };

  return {
    regime,
    confidence: +confidence.toFixed(3),
    reason,
    adx:          adxResult.adx,
    bbWidth:      +bb.width.toFixed(4),
    bbWidthRatio: +widthRatio.toFixed(3),
    ema9:         +ema9val.toFixed(4),
    ema21:        +ema21val.toFixed(4),
    ema50:        +ema50val.toFixed(4),
    bullishEma,
    bearishEma,
  };
}

// ─── Detect regimes for all coins ────────────────────────────
export function detectAllRegimes(candleMap) {
  const regimes = {};
  for (const [coin, candles] of Object.entries(candleMap)) {
    regimes[coin] = detectRegime(coin, candles);
  }
  return regimes;
}
