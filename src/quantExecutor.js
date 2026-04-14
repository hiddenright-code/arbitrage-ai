// ─────────────────────────────────────────────────────────────
// QUANTEXECUTOR.JS — Executes quant signals + sim trade tracking
// ─────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
import { placeLimitOrder, getBalance, getExchanges } from './exchangeClient.js';
import { SETTINGS } from './config.js';
import { SIGNAL_TYPES } from './signalEngine.js';

dotenv.config();

const exchanges = getExchanges();

const MAX_TRADE_USD          = parseFloat(process.env.MAX_TRADE_AMOUNT_USD) || SETTINGS.CAPITAL_PER_TRADE;
const EXCHANGE               = SETTINGS.TRIANGULAR_EXCHANGE;
const MIN_CONFIDENCE         = 0.65;
const KELLY_FRACTION         = 0.25;
const MAX_OPEN_POSITIONS     = 3;
const MAX_DAILY_LOSS_USD     = 5;
const MAX_CONSECUTIVE_LOSSES = 3;
const COOLDOWN_MINUTES       = 60;
const TAKER_FEE              = SETTINGS.FEES[SETTINGS.TRIANGULAR_EXCHANGE];
const ROUND_TRIP_FEE         = TAKER_FEE * 2;
const SIM_CAPITAL            = MAX_TRADE_USD;

// ─── State ────────────────────────────────────────────────────
const openPositions  = {};   // Real positions
const simPositions   = {};   // Simulated positions being tracked
const tradeHistory   = [];   // Completed real trades (for Kelly)
const simHistory     = [];   // Completed sim trades (for validation)

let dailyLossTracker  = { date: null, loss: 0 };
let consecutiveLosses = 0;
let coolingDownUntil  = 0;

// Per-coin SL cooldown — prevents repeated knife-catching
// After a stop loss, no re-entry for 1 full 4h candle (4 hours)
const coinSLCooldown = {}; // coin → timestamp of last SL hit
const COIN_SL_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours

// ─── Kelly Criterion ──────────────────────────────────────────
function kellySize(availableCapital) {
  if (tradeHistory.length < 50) {
    console.log(`[Kelly] Only ${tradeHistory.length}/50 trades — using fixed sizing`);
    return Math.min(MAX_TRADE_USD, availableCapital * 0.05);
  }

  const wins   = tradeHistory.filter(t => t.pnl > 0);
  const losses = tradeHistory.filter(t => t.pnl <= 0);
  if (wins.length === 0 || losses.length === 0) {
    return Math.min(MAX_TRADE_USD, availableCapital * 0.05);
  }

  const winRate  = wins.length / tradeHistory.length;
  const lossRate = 1 - winRate;
  const avgWin   = wins.reduce((s, t) => s + t.pnl, 0) / wins.length;
  const avgLoss  = Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length);
  const b        = avgWin / avgLoss;
  const kelly    = (b * winRate - lossRate) / b;
  const frac     = kelly * KELLY_FRACTION;

  if (frac <= 0) return Math.min(MAX_TRADE_USD * 0.5, availableCapital * 0.02);
  return +Math.min(availableCapital * Math.min(frac, 0.10), MAX_TRADE_USD).toFixed(2);
}

// ─── Record real trade result ─────────────────────────────────
export function recordTradeResult(pnl, strategy) {
  tradeHistory.push({ pnl, strategy, timestamp: Date.now() });
  if (tradeHistory.length > 200) tradeHistory.shift();

  // Daily loss tracking
  const today = new Date().toDateString();
  if (dailyLossTracker.date !== today) dailyLossTracker = { date: today, loss: 0 };
  if (pnl < 0) dailyLossTracker.loss += Math.abs(pnl);

  // Consecutive loss cooldown
  if (pnl < 0) {
    consecutiveLosses++;
    if (consecutiveLosses >= MAX_CONSECUTIVE_LOSSES) {
      coolingDownUntil = Date.now() + COOLDOWN_MINUTES * 60 * 1000;
      consecutiveLosses = 0;
      console.log(`🛑 ${MAX_CONSECUTIVE_LOSSES} consecutive losses — cooling down ${COOLDOWN_MINUTES}m`);
    }
  } else {
    consecutiveLosses = 0;
  }
}

// ─── Open a simulated position ────────────────────────────────
export function openSimPosition(signal) {
  // Block if already open
  if (simPositions[signal.coin]) return null;
  if (!signal.takeProfit || !signal.stopLoss) return null;

  // Block if SL cooldown active for this coin (SL hit in last 4h)
  const recentSLHit = simHistory.some(t =>
    t.coin === signal.coin &&
    t.exitReason === 'stop_loss' &&
    Date.now() - t.closedAt < COIN_SL_COOLDOWN_MS
  );
  if (recentSLHit) return null;

  const pos = {
    coin:       signal.coin,
    strategy:   signal.strategy,
    confidence: signal.confidence,
    entryPrice: signal.price,
    takeProfit: signal.takeProfit,
    stopLoss:   signal.stopLoss,
    capital:    SIM_CAPITAL,
    openedAt:   Date.now(),
    status:     'OPEN',
  };

  simPositions[signal.coin] = pos;
  console.log(`📋 Sim position opened: ${signal.coin} @ $${signal.price} | TP: $${signal.takeProfit} | SL: $${signal.stopLoss}`);
  return pos;
}

// ─── Check sim positions against current prices ───────────────
export function checkSimPositions(candleMap) {
  const closed = [];

  for (const [coin, pos] of Object.entries(simPositions)) {
    const candles = candleMap[coin];
    if (!candles?.length) continue;

    // Use the live (unclosed) candle for position monitoring
    const currentPrice = candles[candles.length - 1].close;
    const highPrice    = candles[candles.length - 1].high;
    const lowPrice     = candles[candles.length - 1].low;

    let exitPrice  = null;
    let exitReason = null;

    // Check SL/TP against candle high/low for realism
    if (lowPrice <= pos.stopLoss) {
      exitPrice  = pos.stopLoss;
      exitReason = 'stop_loss';
    } else if (highPrice >= pos.takeProfit) {
      exitPrice  = pos.takeProfit;
      exitReason = 'take_profit';
    } else if (Date.now() - pos.openedAt > 48 * 60 * 60 * 1000) {
      exitPrice  = currentPrice;
      exitReason = 'time_exit';
    }

    if (exitReason) {
      const grossPnl = (exitPrice - pos.entryPrice) / pos.entryPrice * pos.capital;
      const feeCost  = pos.capital * ROUND_TRIP_FEE;
      const netPnl   = grossPnl - feeCost;
      const netPct   = (netPnl / pos.capital) * 100;
      const holdMs   = Date.now() - pos.openedAt;
      const holdHours = Math.round(holdMs / 3600000);

      const result = {
        coin,
        strategy:   pos.strategy,
        confidence: pos.confidence,
        entryPrice: pos.entryPrice,
        exitPrice,
        exitReason,
        takeProfit: pos.takeProfit,
        stopLoss:   pos.stopLoss,
        capital:    pos.capital,
        grossPnl:   +grossPnl.toFixed(4),
        feeCost:    +feeCost.toFixed(4),
        netPnl:     +netPnl.toFixed(4),
        netPct:     +netPct.toFixed(3),
        won:        netPnl > 0,
        holdHours,
        openedAt:   pos.openedAt,
        closedAt:   Date.now(),
      };

      simHistory.push(result);
      if (simHistory.length > 200) simHistory.shift();
      delete simPositions[coin];
      closed.push(result);

      console.log(`📋 Sim closed: ${coin} | ${exitReason} | PnL: $${netPnl.toFixed(4)} (${netPct.toFixed(2)}%)`);
    }
  }

  return closed;
}

// ─── Get sim stats ────────────────────────────────────────────
export function getSimStats() {
  if (simHistory.length === 0) {
    return {
      trades: 0, wins: 0, losses: 0, winRate: 0,
      totalPnl: 0, avgPnl: 0, avgWin: 0, avgLoss: 0,
      profitFactor: 0, openCount: Object.keys(simPositions).length,
    };
  }

  const wins   = simHistory.filter(t => t.won);
  const losses = simHistory.filter(t => !t.won);
  const totalPnl = simHistory.reduce((s, t) => s + t.netPnl, 0);
  const grossWins = wins.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));

  return {
    trades:       simHistory.length,
    wins:         wins.length,
    losses:       losses.length,
    winRate:      +(wins.length / simHistory.length * 100).toFixed(1),
    totalPnl:     +totalPnl.toFixed(4),
    avgPnl:       +(totalPnl / simHistory.length).toFixed(4),
    avgWin:       wins.length   ? +(grossWins / wins.length).toFixed(4)           : 0,
    avgLoss:      losses.length ? +(grossLoss / losses.length).toFixed(4)         : 0,
    profitFactor: grossLoss === 0 ? grossWins : +(grossWins / grossLoss).toFixed(3),
    openCount:    Object.keys(simPositions).length,
    // Breakdown by exit reason
    byExitReason: simHistory.reduce((acc, t) => {
      if (!acc[t.exitReason]) acc[t.exitReason] = { count: 0, pnl: 0 };
      acc[t.exitReason].count++;
      acc[t.exitReason].pnl += t.netPnl;
      return acc;
    }, {}),
  };
}

// ─── Get sim history ──────────────────────────────────────────
export function getSimHistory() {
  return [...simHistory].reverse(); // Most recent first
}

// ─── Get open sim positions ───────────────────────────────────
export function getOpenSimPositions() {
  return Object.values(simPositions);
}

// ─── Execute real signal ──────────────────────────────────────
export async function executeQuantSignal(signal, confirmed = false) {
  if (signal.type !== SIGNAL_TYPES.BUY) {
    return { success: false, reason: `Signal type ${signal.type} — only BUY on spot` };
  }
  if (signal.strategy === 'pairs_trading') {
    return { success: false, reason: 'Pairs trading requires shorting — not supported' };
  }
  if (signal.confidence < MIN_CONFIDENCE) {
    return { success: false, reason: `Confidence ${signal.confidence} below ${MIN_CONFIDENCE}` };
  }

  // Portfolio risk controls
  const now = Date.now();
  if (now < coolingDownUntil) {
    const minsLeft = Math.round((coolingDownUntil - now) / 60000);
    return { success: false, reason: `Cooldown — ${minsLeft}m remaining` };
  }
  if (Object.keys(openPositions).length >= MAX_OPEN_POSITIONS) {
    return { success: false, reason: `Max ${MAX_OPEN_POSITIONS} positions reached` };
  }
  const today = new Date().toDateString();
  if (dailyLossTracker.date !== today) dailyLossTracker = { date: today, loss: 0 };
  if (dailyLossTracker.loss >= MAX_DAILY_LOSS_USD) {
    return { success: false, reason: `Daily loss limit $${MAX_DAILY_LOSS_USD} reached` };
  }
  if (openPositions[signal.coin]) {
    return { success: false, reason: `Already in position for ${signal.coin}` };
  }

  // Per-coin SL cooldown check
  const lastSL = coinSLCooldown[signal.coin];
  if (lastSL && Date.now() - lastSL < COIN_SL_COOLDOWN_MS) {
    const minsLeft = Math.round((COIN_SL_COOLDOWN_MS - (Date.now() - lastSL)) / 60000);
    return { success: false, reason: `${signal.coin} in SL cooldown — ${minsLeft}m remaining` };
  }
  if (!confirmed) {
    return { success: false, reason: 'Confirmation required', requiresConfirmation: true };
  }

  const balance = await getBalance(EXCHANGE, 'USDT');
  if (balance < 5) {
    return { success: false, reason: `Insufficient balance: $${balance.toFixed(2)}` };
  }

  const tradeUSD   = kellySize(balance);
  const symbol     = `${signal.coin}/USDT`;
  const entryPrice = signal.price;
  const amount     = +(tradeUSD / entryPrice).toFixed(6);

  let order;
  try {
    order = await placeLimitOrder(EXCHANGE, symbol, 'buy', amount, entryPrice);
  } catch (err) {
    return { success: false, reason: `Order failed: ${err.message}` };
  }

  openPositions[signal.coin] = {
    coin: signal.coin, symbol, side: 'long',
    entryPrice, amount, tradeUSD,
    stopLoss: signal.stopLoss, takeProfit: signal.takeProfit,
    strategy: signal.strategy, orderId: order.orderId,
    openedAt: Date.now(), confidence: signal.confidence,
  };

  return { success: true, order, position: openPositions[signal.coin], tradeUSD };
}

// ─── Manage real positions ────────────────────────────────────
export async function managePositions(candleMap) {
  const actions = [];

  for (const [coin, pos] of Object.entries(openPositions)) {
    const candles = candleMap[coin];
    if (!candles?.length) continue;

    const c            = candles[candles.length - 1];
    const currentPrice = c.close;
    const pnlPct       = (currentPrice - pos.entryPrice) / pos.entryPrice;
    const pnlUSD       = pnlPct * pos.tradeUSD;
    let action         = null;

    if (c.low <= pos.stopLoss) {
      action = { coin, reason: 'Stop loss hit', currentPrice: pos.stopLoss, pnlUSD, pnlPct };
    } else if (c.high >= pos.takeProfit) {
      action = { coin, reason: 'Take profit hit', currentPrice: pos.takeProfit, pnlUSD, pnlPct };
    } else if (Date.now() - pos.openedAt > 48 * 60 * 60 * 1000) {
      action = { coin, reason: 'Time exit (48h)', currentPrice, pnlUSD, pnlPct };
    }

    if (action) {
      try {
        // Use market order for exits — certainty of fill matters
        await exchanges[EXCHANGE].createMarketSellOrder(pos.symbol, pos.amount);
        recordTradeResult(pnlUSD, pos.strategy);

        // If stopped out, record SL cooldown for this coin
        if (action.reason === 'Stop loss hit') {
          coinSLCooldown[coin] = Date.now();
          console.log(`⏳ ${coin} SL cooldown started — no re-entry for 4h`);
        }

        delete openPositions[coin];
        actions.push({ ...action, closed: true });
      } catch (err) {
        console.error(`Failed to close ${coin}:`, err.message);
        actions.push({ ...action, closed: false, error: err.message });
      }
    }
  }

  return actions;
}

// ─── Getters ──────────────────────────────────────────────────
export function getOpenPositions() { return Object.values(openPositions); }

export function getTradeStats() {
  if (tradeHistory.length === 0) return { trades: 0, winRate: 0, avgPnl: 0, totalPnl: 0 };
  const wins     = tradeHistory.filter(t => t.pnl > 0);
  const totalPnl = tradeHistory.reduce((s, t) => s + t.pnl, 0);
  return {
    trades:   tradeHistory.length,
    winRate:  +(wins.length / tradeHistory.length * 100).toFixed(1),
    avgPnl:   +(totalPnl / tradeHistory.length).toFixed(4),
    totalPnl: +totalPnl.toFixed(4),
  };
}
