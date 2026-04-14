// ─────────────────────────────────────────────────────────────
// BACKTESTER.JS — Runs signal engine against historical data
//
// Methodology:
//   1. Takes the 500 4h candles already loaded in priceHistory
//   2. Walks forward candle by candle using a sliding window
//   3. At each step, runs regime detection + signal engine
//      on CLOSED candles only (same discipline as live bot)
//   4. When a signal fires above threshold, simulates a trade:
//      - Entry at next candle open (realistic — you can't fill
//        on the same candle that generated the signal)
//      - Tracks price forward until TP, SL, or 48h time exit
//   5. Records every trade and computes full statistics
//
// Reports:
//   - Net PnL after fees
//   - Win rate overall and per strategy/regime
//   - Max drawdown
//   - Sharpe ratio
//   - Whether confidence score correlates with win rate
//   - Ablation results (what happens without each component)
// ─────────────────────────────────────────────────────────────

import { detectAllRegimes } from './regimeDetector.js';
import { generateSignals } from './signalEngine.js';
import { computeAll, rsi } from './indicators.js';
import { SETTINGS } from './config.js';

const TAKER_FEE        = SETTINGS.FEES.BinanceUS;
const ROUND_TRIP_FEE   = TAKER_FEE * 2;
const MIN_CANDLES      = 60;
const SIGNAL_THRESHOLD = 0.45;

// V3 test config
const V3_COINS         = ['XRP', 'BTC', 'SOL', 'LINK', 'AVAX'];
const V3_THRESHOLD     = 0.75;
const V3_MEAN_REV_ONLY = true;
// V3 uses 1.5x ATR stops instead of 1x — tested in simulateTrade via signal.stopLoss
// which is now calculated using V3.SL_ATR_MULT in signalEngine

// ─── Simulate one trade forward ───────────────────────────────
// Given entry candle index, walk forward until TP/SL/timeout
function simulateTrade(candles, entryIndex, signal, capitalUSD) {
  const entryCandle = candles[entryIndex];
  if (!entryCandle) return null;

  // Realistic entry: open of the NEXT candle after signal
  const entryPrice  = entryCandle.open;

  
  const takeProfit  = signal.takeProfit;
  const stopLoss    = signal.stopLoss;

  // Max hold: 12 candles × 4h = 48 hours
  const maxHold     = 12;
  const amount      = capitalUSD / entryPrice;

  let exitPrice     = null;
  let exitReason    = null;
  let exitIndex     = entryIndex;

  for (let i = entryIndex; i < Math.min(entryIndex + maxHold, candles.length); i++) {
    const c = candles[i];

    // Check if stop loss hit (low touched SL)
    if (c.low <= stopLoss) {
      exitPrice  = stopLoss;
      exitReason = 'stop_loss';
      exitIndex  = i;
      break;
    }

    // Check if take profit hit (high touched TP)
    if (c.high >= takeProfit) {
      exitPrice  = takeProfit;
      exitReason = 'take_profit';
      exitIndex  = i;
      break;
    }

    // Time exit: last candle in window
    if (i === Math.min(entryIndex + maxHold - 1, candles.length - 1)) {
      exitPrice  = c.close;
      exitReason = 'time_exit';
      exitIndex  = i;
    }
  }

  if (!exitPrice) return null;

  const grossPnl   = (exitPrice - entryPrice) * amount;
  const feeCost    = capitalUSD * ROUND_TRIP_FEE;
  const netPnl     = grossPnl - feeCost;
  const netPct     = (netPnl / capitalUSD) * 100;
  const holdCandles = exitIndex - entryIndex;

  return {
    entryPrice:  +entryPrice.toFixed(6),
    exitPrice:   +exitPrice.toFixed(6),
    takeProfit,
    stopLoss,
    exitReason,
    holdCandles,
    holdHours:   holdCandles * 4,
    grossPnl:    +grossPnl.toFixed(6),
    feeCost:     +feeCost.toFixed(6),
    netPnl:      +netPnl.toFixed(6),
    netPct:      +netPct.toFixed(4),
    won:         netPnl > 0,
  };
}

// ─── Run backtest for one coin ────────────────────────────────
function backtestCoin(coin, candles, candles1h, capitalUSD, options = {}) {
  const {
    minConfidence   = SIGNAL_THRESHOLD,
    useBtcFilter    = true,
    useRegime       = true,
    useVolume       = true,
    useVwap         = true,
    useMacd         = true,
    use1hPullback   = true,
  } = options;

  const trades    = [];
  const signals   = [];
  let   equity    = capitalUSD;
  let   peak      = capitalUSD;
  let   maxDD     = 0;

  // Walk forward from MIN_CANDLES to end
  for (let i = MIN_CANDLES; i < candles.length - 1; i++) {
    // Use candles up to (but not including) current — closed candles only
    const window    = candles.slice(0, i);
    const window1h  = candles1h ? candles1h.slice(0, Math.min(i * 4, candles1h.length)) : null;

    // Build single-coin candle map
    const candleMap = { [coin]: window };
    const candleMap1h = window1h ? { [coin]: window1h } : {};

    // Detect regime
    let regimes;
    if (useRegime) {
      regimes = detectAllRegimes(candleMap);
    } else {
      // Ablation: force RANGING for all coins
      regimes = { [coin]: { regime: 'RANGING', confidence: 1, adx: 15, bbWidth: 0.02, bbWidthRatio: 1.0, ema9: 0, ema21: 0, ema50: 0 } };
    }

    // Apply ablation options by temporarily modifying indicator output
    let coinSignals;
    try {
      coinSignals = generateSignals(candleMap, regimes, candleMap1h);
    } catch {
      continue;
    }

   // Filter to this coin's actionable signals
  const actionable = coinSignals.filter(s =>
      s.coin === coin &&
      s.type === 'BUY' &&
      s.confidence >= minConfidence &&
      s.takeProfit &&
      s.stopLoss &&
      (!options.meanRevOnly || s.strategy === 'mean_reversion')
    );

    if (actionable.length === 0) continue;

    const signal = actionable[0]; // Take highest confidence signal

    // Simulate the trade starting at the NEXT candle
    const result = simulateTrade(candles, i, signal, Math.min(equity * 0.05, 9));
    if (!result) continue;

    // Record signal
    signals.push({
      candleIndex: i,
      timestamp:   candles[i].timestamp,
      coin,
      strategy:    signal.strategy,
      regime:      regimes[coin]?.regime,
      confidence:  signal.confidence,
      ...result,
    });

    // Only count as executed trade if confidence above threshold
    if (signal.confidence >= minConfidence) {
      equity += result.netPnl;
      trades.push({
        ...signals[signals.length - 1],
        equityAfter: +equity.toFixed(4),
      });

      // Track drawdown
      if (equity > peak) peak = equity;
      const dd = ((peak - equity) / peak) * 100;
      if (dd > maxDD) maxDD = dd;

      // Skip forward past this trade's exit to avoid overlapping trades
      i += Math.max(result.holdCandles, 1);
    }
  }

  return { trades, signals, finalEquity: equity, maxDrawdown: +maxDD.toFixed(4) };
}

// ─── Compute statistics from trade list ──────────────────────
function computeStats(trades, initialCapital) {
  if (trades.length === 0) {
    return {
      totalTrades: 0, wins: 0, losses: 0, winRate: 0,
      totalPnl: 0, avgPnl: 0, avgWin: 0, avgLoss: 0,
      profitFactor: 0, sharpe: 0, maxDrawdown: 0,
      byExitReason: {}, byStrategy: {}, byRegime: {},
      byConfidenceBucket: {},
    };
  }

  const wins   = trades.filter(t => t.won);
  const losses = trades.filter(t => !t.won);

  const totalPnl  = trades.reduce((s, t) => s + t.netPnl, 0);
  const avgPnl    = totalPnl / trades.length;
  const avgWin    = wins.length   ? wins.reduce((s, t)   => s + t.netPnl, 0) / wins.length   : 0;
  const avgLoss   = losses.length ? losses.reduce((s, t) => s + t.netPnl, 0) / losses.length : 0;

  const grossWins  = wins.reduce((s, t)   => s + t.netPnl, 0);
  const grossLoss  = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));
  const profitFactor = grossLoss === 0 ? grossWins : grossWins / grossLoss;

  // Sharpe ratio — properly annualized
  // Step 1: returns as fraction of TOTAL capital (not per-trade capital)
  // initialCapital passed in represents total portfolio value
  const portfolioReturns = trades.map(t => t.netPnl / initialCapital);

  // Step 2: annualization factor based on actual trade frequency
  // Not candles per year — trades per year based on observed frequency
  const daysTested      = trades.length > 1
    ? (trades[trades.length - 1].timestamp - trades[0].timestamp) / (1000 * 60 * 60 * 24)
    : 83; // fallback
  const tradesPerYear   = daysTested > 0
    ? (trades.length / daysTested) * 365
    : trades.length;
  const annFactor       = Math.sqrt(Math.max(tradesPerYear, 1));

  // Step 3: compute Sharpe with risk-free rate of 0
  const meanRet = portfolioReturns.reduce((s, r) => s + r, 0) / portfolioReturns.length;
  const stdRet  = Math.sqrt(
    portfolioReturns.reduce((s, r) => s + (r - meanRet) ** 2, 0) / portfolioReturns.length
  );
  const sharpe  = stdRet === 0 ? 0 : +(( meanRet / stdRet) * annFactor).toFixed(3);

  // Breakdown by exit reason
  const byExitReason = {};
  for (const t of trades) {
    if (!byExitReason[t.exitReason]) byExitReason[t.exitReason] = { count: 0, pnl: 0 };
    byExitReason[t.exitReason].count++;
    byExitReason[t.exitReason].pnl += t.netPnl;
  }

  // Breakdown by strategy
  const byStrategy = {};
  for (const t of trades) {
    if (!byStrategy[t.strategy]) byStrategy[t.strategy] = { count: 0, wins: 0, pnl: 0 };
    byStrategy[t.strategy].count++;
    if (t.won) byStrategy[t.strategy].wins++;
    byStrategy[t.strategy].pnl += t.netPnl;
  }
  for (const s of Object.values(byStrategy)) {
    s.winRate = +((s.wins / s.count) * 100).toFixed(1);
    s.pnl     = +s.pnl.toFixed(4);
  }

  // Breakdown by regime
  const byRegime = {};
  for (const t of trades) {
    const r = t.regime || 'UNKNOWN';
    if (!byRegime[r]) byRegime[r] = { count: 0, wins: 0, pnl: 0 };
    byRegime[r].count++;
    if (t.won) byRegime[r].wins++;
    byRegime[r].pnl += t.netPnl;
  }
  for (const r of Object.values(byRegime)) {
    r.winRate = +((r.wins / r.count) * 100).toFixed(1);
    r.pnl     = +r.pnl.toFixed(4);
  }

  // Confidence bucket analysis — does higher confidence = better results?
  const buckets = { '0.45-0.54': [], '0.55-0.64': [], '0.65-0.74': [], '0.75-0.84': [], '0.85+': [] };
  for (const t of trades) {
    const c = t.confidence;
    if      (c < 0.55) buckets['0.45-0.54'].push(t);
    else if (c < 0.65) buckets['0.55-0.64'].push(t);
    else if (c < 0.75) buckets['0.65-0.74'].push(t);
    else if (c < 0.85) buckets['0.75-0.84'].push(t);
    else               buckets['0.85+'].push(t);
  }
  const byConfidenceBucket = {};
  for (const [bucket, ts] of Object.entries(buckets)) {
    if (ts.length === 0) continue;
    const bWins = ts.filter(t => t.won);
    byConfidenceBucket[bucket] = {
      count:   ts.length,
      winRate: +((bWins.length / ts.length) * 100).toFixed(1),
      avgPnl:  +(ts.reduce((s, t) => s + t.netPnl, 0) / ts.length).toFixed(4),
    };
  }

  return {
    totalTrades:   trades.length,
    wins:          wins.length,
    losses:        losses.length,
    winRate:       +((wins.length / trades.length) * 100).toFixed(1),
    totalPnl:      +totalPnl.toFixed(4),
    avgPnl:        +avgPnl.toFixed(4),
    avgWin:        +avgWin.toFixed(4),
    avgLoss:       +avgLoss.toFixed(4),
    profitFactor:  +profitFactor.toFixed(3),
    sharpe:        +sharpe.toFixed(3),
    byExitReason,
    byStrategy,
    byRegime,
    byConfidenceBucket,
  };
}

// ─── Run ablation tests ───────────────────────────────────────
// Tests what happens when each component is removed
async function runAblation(coin, candles, candles1h, capitalUSD) {
  const configs = [
    { name: 'Full system',          options: {} },
    { name: 'No regime detector',   options: { useRegime: false } },
    { name: 'No 1h pullback',       options: { use1hPullback: false } },
    { name: 'Lower threshold 0.35', options: { minConfidence: 0.35 } },
    { name: 'Higher threshold 0.75',options: { minConfidence: 0.75 } },
  ];

  const results = [];
  for (const cfg of configs) {
    const { trades, finalEquity, maxDrawdown } = backtestCoin(coin, candles, candles1h, capitalUSD, cfg.options);
    const stats = computeStats(trades, capitalUSD);
    results.push({
      name:        cfg.name,
      trades:      stats.totalTrades,
      winRate:     stats.winRate,
      totalPnl:    stats.totalPnl,
      sharpe:      stats.sharpe,
      maxDrawdown,
      finalEquity: +finalEquity.toFixed(4),
    });
  }
  return results;
}

// ─── Main backtest runner ─────────────────────────────────────
export async function runBacktest(candleMap, candles1hMap, capitalPerCoin = 9) {
  console.log('[Backtester] Starting backtest...');
  const startTime = Date.now();

  const allTrades   = [];
  const coinResults = {};
  const ablation    = {};

  // V3 test: run separately with V3 config
  const v3Trades = [];
  const v3CoinResults = {};

  for (const [coin, candles] of Object.entries(candleMap)) {
    if (!candles || candles.length < MIN_CANDLES + 10) continue;

    // V3 run — only V3 coins, 0.75 threshold, mean reversion only, reclaim entry
    if (V3_COINS.includes(coin)) {
      const candles1h = candles1hMap?.[coin] ?? null;
      const { trades: v3t, finalEquity: v3eq, maxDrawdown: v3dd } = backtestCoin(
        coin, candles, candles1h, capitalPerCoin,
        { minConfidence: V3_THRESHOLD, meanRevOnly: V3_MEAN_REV_ONLY }
      );
      const v3stats = computeStats(v3t, capitalPerCoin);
      v3CoinResults[coin] = {
        ...v3stats,
        maxDrawdown: v3dd,
        finalEquity: +v3eq.toFixed(4),
        returnPct:   +(((v3eq - capitalPerCoin) / capitalPerCoin) * 100).toFixed(2),
      };
      v3Trades.push(...v3t.map(t => ({ ...t, coin })));
    }
  }

  for (const [coin, candles] of Object.entries(candleMap)) {
    if (!candles || candles.length < MIN_CANDLES + 10) {
      console.log(`[Backtester] ${coin}: insufficient data (${candles?.length} candles), skipping`);
      continue;
    }

    console.log(`[Backtester] ${coin}: testing ${candles.length} candles...`);
    const candles1h = candles1hMap?.[coin] ?? null;

    const { trades, finalEquity, maxDrawdown } = backtestCoin(coin, candles, candles1h, capitalPerCoin);
    const stats = computeStats(trades, capitalPerCoin);

    coinResults[coin] = {
      ...stats,
      maxDrawdown,
      finalEquity:    +finalEquity.toFixed(4),
      startEquity:    capitalPerCoin,
      returnPct:      +(((finalEquity - capitalPerCoin) / capitalPerCoin) * 100).toFixed(2),
      candlesTested:  candles.length,
      daysTested:     Math.round(candles.length * 4 / 24),
    };

    allTrades.push(...trades.map(t => ({ ...t, coin })));

    // Run ablation for BTC and ETH only (most data, most representative)
    if (coin === 'BTC' || coin === 'ETH') {
      ablation[coin] = await runAblation(coin, candles, candles1h, capitalPerCoin);
    }
  }

  // Portfolio-level stats
  const portfolioStats = computeStats(allTrades, capitalPerCoin * Object.keys(coinResults).length);

  const duration = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`[Backtester] Done in ${duration}s — ${allTrades.length} total trades across ${Object.keys(coinResults).length} coins`);

  const v3PortfolioStats = computeStats(v3Trades, capitalPerCoin * V3_COINS.length);

  return {
    portfolioStats,
    coinResults,
    ablation,
    totalTrades:      allTrades.length,
    coinsTestedCount: Object.keys(coinResults).length,
    duration:         `${duration}s`,
    generatedAt:      Date.now(),
    v3: {
      label:          'V3: Mean reversion only, 5 coins, 0.75+ threshold, reclaim entry',
      portfolioStats: v3PortfolioStats,
      coinResults:    v3CoinResults,
      totalTrades:    v3Trades.length,
    },
  };
}
