// ─────────────────────────────────────────────────────────────
// SIGNALENGINE.JS — Generates BUY/SELL/HOLD signals
//
// Strategy selection based on regime:
//   RANGING      → RSI + Bollinger Bands mean reversion
//   TRENDING_UP  → EMA crossover + MACD momentum
//   TRENDING_DOWN→ No longs. MACD crossdown = short signal (logged only)
//   VOLATILE     → No new entries. Exit open positions.
//
// Pairs trading (BTC/ETH, ETH/LTC, BTC/LTC):
//   Always active regardless of regime.
//   Fires when Z-score diverges beyond ±2 std deviations.
//
// Signal confidence scoring:
//   Each confirming indicator adds to the score.
//   Score >= 0.65 = HIGH confidence → auto-execute eligible
//   Score >= 0.45 = MEDIUM confidence → alert only
//   Score <  0.45 = LOW → ignore
// ─────────────────────────────────────────────────────────────

import { computeAll, zScore, rsi, bollingerBands, macd, ema } from './indicators.js';
import { REGIMES } from './regimeDetector.js';

export const SIGNAL_TYPES = {
  BUY:  'BUY',
  SELL: 'SELL',
  HOLD: 'HOLD',
  EXIT: 'EXIT',  // Close existing position
};

// Pairs to monitor for statistical arbitrage
export const PAIRS_TO_WATCH = [
  { a: 'BTC', b: 'ETH',  name: 'BTC/ETH'  },
  { a: 'ETH', b: 'LTC',  name: 'ETH/LTC'  },
  { a: 'BTC', b: 'LTC',  name: 'BTC/LTC'  },
  { a: 'ETH', b: 'SOL',  name: 'ETH/SOL'  },
  { a: 'BTC', b: 'XRP',  name: 'BTC/XRP'  },
];

// ─── Mean reversion signal (for RANGING regime) ───────────────
function meanReversionSignal(coin, candles, indicators) {
  const { rsi: rsiVal, bb, macd: macdVal, volRatio, price } = indicators;
  if (!rsiVal || !bb || !macdVal) return null;

  const reasons  = [];
  let buyScore   = 0;
  let sellScore  = 0;

  // RSI oversold (< 35 in crypto, more extreme than stock market 30)
  if (rsiVal < 35) { buyScore  += 0.30; reasons.push(`RSI ${rsiVal} oversold`); }
  if (rsiVal > 65) { sellScore += 0.30; reasons.push(`RSI ${rsiVal} overbought`); }

  // Bollinger Band touch
  if (bb.pct_b < 0.05) { buyScore  += 0.30; reasons.push(`Price at lower BB (pct_b: ${bb.pct_b})`); }
  if (bb.pct_b > 0.95) { sellScore += 0.30; reasons.push(`Price at upper BB (pct_b: ${bb.pct_b})`); }

  // MACD histogram direction confirmation
  if (macdVal.bullish && buyScore  > 0) { buyScore  += 0.20; reasons.push('MACD bullish'); }
  if (!macdVal.bullish && sellScore > 0) { sellScore += 0.20; reasons.push('MACD bearish'); }

  // Volume confirmation (volume spike adds conviction)
  if (volRatio && volRatio > 1.5) {
    if (buyScore > sellScore)  { buyScore  += 0.15; reasons.push(`Vol spike ${volRatio}x`); }
    if (sellScore > buyScore)  { sellScore += 0.15; reasons.push(`Vol spike ${volRatio}x`); }
  }

  // Price below VWAP = slight buy bias in ranging market
  if (indicators.vwap && price < indicators.vwap && buyScore > 0) {
    buyScore += 0.05;
    reasons.push('Below VWAP');
  }

 if (buyScore >= 0.45) {
      const roundTripFee = 0.002;
      const tpDistance = Math.abs(bb.middle - price) / price;
      if (tpDistance < roundTripFee * 3) return null;

      return {
        type:       SIGNAL_TYPES.BUY,
        strategy:   'mean_reversion',
        coin,
        confidence: +Math.min(buyScore, 1).toFixed(3),
        reasons,
        price,
        takeProfit: +bb.middle.toFixed(6),
        stopLoss:   +(bb.lower * 0.995).toFixed(6),
      };
    }

  if (sellScore >= 0.45) {
    return {
      type:       SIGNAL_TYPES.SELL,
      strategy:   'mean_reversion',
      coin,
      confidence: +Math.min(sellScore, 1).toFixed(3),
      reasons,
      price,
      takeProfit: +bb.middle.toFixed(6),
      stopLoss:   +(bb.upper * 1.005).toFixed(6),
    };
  }

  return null;
}

// ─── Trend following signal (for TRENDING_UP regime) ─────────
function trendFollowingSignal(coin, candles, indicators, candles1h) {
  const { rsi: rsiVal, macd: macdVal, ema9, ema21, ema50, bb, volRatio, price, atr } = indicators;
  if (!rsiVal || !macdVal || !ema9 || !ema21) return null;

  const reasons = [];
  let score     = 0;

  // 4h EMA stack confirms trend exists (regime filter)
  const prevCandles = candles.slice(0, -1);
  const prevEma9    = ema(prevCandles, 9);
  const prevEma21   = ema(prevCandles, 21);
  const crossedUp   = prevEma9 && prevEma21 && prevEma9 <= prevEma21 && ema9 > ema21;

  if (crossedUp)                  { score += 0.25; reasons.push('4h EMA 9 crossed above EMA 21'); }
  else if (ema9 > ema21)          { score += 0.10; reasons.push('4h EMA 9 above EMA 21'); }
  if (ema50 && price > ema50)     { score += 0.15; reasons.push('Price above 4h EMA 50'); }
  if (macdVal.bullish)            { score += 0.10; reasons.push('4h MACD bullish'); }

  // Two-timeframe entry: require 1h RSI pullback below 40
  // This gets us into the trend at a better price instead of chasing
  if (candles1h && candles1h.length >= 14) {
    const rsi1h = rsi(candles1h.slice(0, -1), 14); // closed 1h candles only
    if (rsi1h !== null) {
      if (rsi1h < 40) {
        score += 0.35;
        reasons.push(`1h RSI ${rsi1h} pullback — good entry on dip`);
      } else if (rsi1h < 50) {
        score += 0.15;
        reasons.push(`1h RSI ${rsi1h} mild pullback`);
      } else {
        // No pullback — trend may be extended, reduce score
        score -= 0.10;
        reasons.push(`1h RSI ${rsi1h} — no pullback, entry may be late`);
      }
    }
  }

  if (volRatio && volRatio > 1.3) { score += 0.10; reasons.push(`Vol ${volRatio}x`); }
  if (macdVal.crossedUp)          { score += 0.15; reasons.push('4h MACD crossed up'); }

  if (score >= 0.45) {
    const atrVal = atr || (bb ? (bb.upper - bb.lower) / 4 : price * 0.02);
    return {
      type:       SIGNAL_TYPES.BUY,
      strategy:   'trend_following',
      coin,
      confidence: +Math.min(score, 1).toFixed(3),
      reasons,
      price,
      takeProfit: +(price + atrVal * 2).toFixed(6),
      stopLoss:   +(price - atrVal * 1).toFixed(6),
    };
  }

  return null;
}

// ─── Pairs trading signal ─────────────────────────────────────
function pairsSignal(pair, candlesA, candlesB) {
  if (!candlesA || !candlesB) return null;

  const z = zScore(candlesA, candlesB, 30);
  if (z === null) return null;

  const priceA = candlesA[candlesA.length - 1].close;
  const priceB = candlesB[candlesB.length - 1].close;

  // Z > +2: A is overpriced relative to B → sell A, buy B
  if (z > 2.0) {
    return {
      type:       SIGNAL_TYPES.SELL,
      strategy:   'pairs_trading',
      pair:       pair.name,
      coinA:      pair.a,
      coinB:      pair.b,
      action:     `Sell ${pair.a}, Buy ${pair.b}`,
      zScore:     z,
      confidence: +Math.min((z - 2) / 2 + 0.5, 1).toFixed(3),
      priceA,
      priceB,
      reasons:    [`Z-score ${z} > 2.0 — ${pair.a} overpriced vs ${pair.b}`],
      // Exit when Z-score reverts toward 0
      exitZScore: 0.5,
    };
  }

  // Z < -2: A is underpriced relative to B → buy A, sell B
  if (z < -2.0) {
    return {
      type:       SIGNAL_TYPES.BUY,
      strategy:   'pairs_trading',
      pair:       pair.name,
      coinA:      pair.a,
      coinB:      pair.b,
      action:     `Buy ${pair.a}, Sell ${pair.b}`,
      zScore:     z,
      confidence: +Math.min((Math.abs(z) - 2) / 2 + 0.5, 1).toFixed(3),
      priceA,
      priceB,
      reasons:    [`Z-score ${z} < -2.0 — ${pair.a} underpriced vs ${pair.b}`],
      exitZScore: -0.5,
    };
  }

  return null;
}

// ─── Main: generate all signals ───────────────────────────────
export function generateSignals(candleMap, regimes, candles1hMap = {}) {
  const signals = [];
  const coins   = Object.keys(candleMap);

  // Macro filter: if BTC is trending down or volatile, suppress all mean reversion longs
  const btcRegime = regimes['BTC'];
  const btcBearish = btcRegime && (
    btcRegime.regime === REGIMES.TRENDING_DOWN ||
    btcRegime.regime === REGIMES.VOLATILE
  );

  // Single-asset signals
  for (const coin of coins) {
    const candles = candleMap[coin];
    if (!candles || candles.length < 30) continue;

    // CRITICAL: Remove the last candle — it hasn't closed yet.
    // Signals must only be generated on confirmed closed candles
    // to prevent "phantom" signals that vanish before the hour ends.
    const closedCandles = candles.slice(0, -1);
    if (closedCandles.length < 30) continue;

    const indicators = computeAll(closedCandles);
    const regime     = regimes[coin];
    if (!regime) continue;

    let signal = null;

    switch (regime.regime) {
      case REGIMES.RANGING:
        if (!btcBearish) {
          signal = meanReversionSignal(coin, closedCandles, indicators);
        } else {
          signal = {
            type:       SIGNAL_TYPES.HOLD,
            strategy:   'macro_filter',
            coin,
            confidence: 0,
            reasons:    ['BTC macro downtrend — suppressing mean reversion longs'],
            price:      indicators.price,
          };
        }
        break;
      case REGIMES.TRENDING_UP:
        // Disabled — 0% WR across 38 live sim trades confirms backtest finding
        signal = null;
        break;
      case REGIMES.VOLATILE:
        // In volatile conditions — no new entries, flag for exit
        signal = {
          type:       SIGNAL_TYPES.HOLD,
          strategy:   'volatility_pause',
          coin,
          confidence: regime.confidence,
          reasons:    [`Volatile regime — pausing new entries (${regime.reason})`],
          price:      indicators.price,
        };
        break;
      case REGIMES.TRENDING_DOWN:
        signal = {
          type:       SIGNAL_TYPES.HOLD,
          strategy:   'trend_down_avoid',
          coin,
          confidence: regime.confidence,
          reasons:    [`Downtrend — avoiding longs (${regime.reason})`],
          price:      indicators.price,
        };
        break;
    }

    if (signal) {
      signals.push({
        ...signal,
        regime:    regime.regime,
        timestamp: Date.now(),
        indicators: {
          rsi:      indicators.rsi,
          bbPctB:   indicators.bb?.pct_b,
          macdHist: indicators.macd?.histogram,
          ema9:     indicators.ema9,
          ema21:    indicators.ema21,
          volRatio: indicators.volRatio,
          atr:      indicators.atr,
        },
      });
    }
  }

  // Pairs trading signals (regime-independent)
  for (const pair of PAIRS_TO_WATCH) {
    const candlesA = candleMap[pair.a];
    const candlesB = candleMap[pair.b];
    if (!candlesA || !candlesB) continue;

    const candlesAClosed = candlesA.slice(0, -1);
    const candlesBClosed = candlesB.slice(0, -1);
    const signal = pairsSignal(pair, candlesAClosed, candlesBClosed);
    if (signal) {
      signals.push({
        ...signal,
        timestamp: Date.now(),
      });
    }
  }

  // Sort by confidence descending
  const typeOrder = { BUY: 0, SELL: 1, EXIT: 2, HOLD: 3 };
  const sorted = signals.sort((a, b) => {
    if (b.confidence !== a.confidence) return b.confidence - a.confidence;
    return (typeOrder[a.type] ?? 9) - (typeOrder[b.type] ?? 9);
  });

  
  return sorted;
}
