// ─────────────────────────────────────────────────────────────
// QUANTEXECUTOR.JS — Penny stock trade execution + sim tracking
//
// Handles:
//   • Real order placement via Alpaca bracket orders
//   • Position sizing (volatility-adjusted + Kelly when data allows)
//   • Risk controls (daily loss cap, consecutive-loss cooldown,
//     per-symbol cooldown, max open positions)
//   • Simulated position tracking to validate the strategy live
//     before risking real capital
// ─────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
import { placeBracketOrder, getBuyingPower, closePosition } from './exchangeClient.js';
import { SETTINGS } from './config.js';
import { SIGNAL_TYPES } from './signalEngine.js';

dotenv.config();

const MAX_TRADE_USD          = parseFloat(process.env.MAX_TRADE_AMOUNT_USD) || SETTINGS.CAPITAL_PER_TRADE;
const MAX_POSITION_SIZE      = SETTINGS.MAX_POSITION_SIZE;
const MIN_CONFIDENCE         = SETTINGS.AUTO_EXECUTE_THRESHOLD;
const KELLY_FRACTION         = 0.25;
const MAX_OPEN_POSITIONS     = SETTINGS.MAX_OPEN_POSITIONS;
const MAX_DAILY_LOSS_USD     = SETTINGS.MAX_DAILY_LOSS_USD;
const MAX_CONSECUTIVE_LOSSES = SETTINGS.MAX_CONSECUTIVE_LOSSES;
const COOLDOWN_MINUTES       = SETTINGS.COOLDOWN_MINUTES;
const MAX_HOLD_MS            = SETTINGS.MAX_HOLD_HOURS * 60 * 60 * 1000;
const SIM_CAPITAL            = MAX_TRADE_USD;

// ─── State ────────────────────────────────────────────────────
const openPositions  = {};   // Real positions:  symbol → position
const simPositions   = {};   // Simulated positions
const tradeHistory   = [];   // Completed real trades (for Kelly)
const simHistory     = [];   // Completed sim trades (for validation)

let dailyLossTracker  = { date: null, loss: 0 };
let consecutiveLosses = 0;
let coolingDownUntil  = 0;

// Per-symbol cooldown after a stop-out — avoid re-buying a falling knife
const symbolCooldown      = {};
const SYMBOL_COOLDOWN_MS   = 30 * 60 * 1000;  // 30 min

// ─── Position sizing ──────────────────────────────────────────
// Penny stocks are volatile — size DOWN as confidence/squeeze rises
// is wrong; instead we scale UP slightly with conviction but always
// cap hard. Kelly kicks in only after 30 completed trades.
function positionSize(availableCapital, confidence) {
  // Base size scales with confidence between MAX_TRADE_USD and MAX_POSITION_SIZE
  const convScale = Math.min(Math.max((confidence - 0.5) / 0.5, 0), 1);
  let size = MAX_TRADE_USD + (MAX_POSITION_SIZE - MAX_TRADE_USD) * convScale;

  // Kelly overlay once we have enough trade history
  if (tradeHistory.length >= 30) {
    const wins   = tradeHistory.filter(t => t.pnl > 0);
    const losses = tradeHistory.filter(t => t.pnl <= 0);
    if (wins.length && losses.length) {
      const winRate  = wins.length / tradeHistory.length;
      const avgWin   = wins.reduce((s, t) => s + t.pnl, 0) / wins.length;
      const avgLoss  = Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length);
      const b        = avgWin / avgLoss;
      const kelly    = (b * winRate - (1 - winRate)) / b;
      const frac     = Math.max(kelly * KELLY_FRACTION, 0);
      const kellySize = availableCapital * Math.min(frac, 0.10);
      size = Math.min(size, kellySize || size);
    }
  }

  return +Math.min(size, MAX_POSITION_SIZE, availableCapital).toFixed(2);
}

// ─── Record real trade result ─────────────────────────────────
export function recordTradeResult(pnl, strategy) {
  tradeHistory.push({ pnl, strategy, timestamp: Date.now() });
  if (tradeHistory.length > 200) tradeHistory.shift();

  const today = new Date().toDateString();
  if (dailyLossTracker.date !== today) dailyLossTracker = { date: today, loss: 0 };
  if (pnl < 0) dailyLossTracker.loss += Math.abs(pnl);

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
  if (simPositions[signal.symbol]) return null;
  if (!signal.takeProfit || !signal.stopLoss) return null;

  // Block if symbol stopped out recently
  const recentSL = simHistory.some(t =>
    t.symbol === signal.symbol &&
    t.exitReason === 'stop_loss' &&
    Date.now() - t.closedAt < SYMBOL_COOLDOWN_MS
  );
  if (recentSL) return null;

  const pos = {
    symbol:     signal.symbol,
    strategy:   signal.strategy,
    confidence: signal.confidence,
    entryPrice: signal.price,
    takeProfit: signal.takeProfit,
    stopLoss:   signal.stopLoss,
    capital:    SIM_CAPITAL,
    openedAt:   Date.now(),
    status:     'OPEN',
  };

  simPositions[signal.symbol] = pos;
  console.log(`📋 Sim opened: ${signal.symbol} @ $${signal.price} | TP $${signal.takeProfit} | SL $${signal.stopLoss} | ${signal.strategy}`);
  return pos;
}

// ─── Check sim positions against current snapshots ────────────
// snapshotMap: { SYMBOL: { price, dailyHigh, dailyLow, ... } }
export function checkSimPositions(snapshotMap) {
  const closed = [];

  for (const [symbol, pos] of Object.entries(simPositions)) {
    const snap = snapshotMap[symbol];
    if (!snap) continue;

    const currentPrice = snap.price;
    const high         = snap.dailyHigh || currentPrice;
    const low          = snap.dailyLow  || currentPrice;

    let exitPrice  = null;
    let exitReason = null;

    if (low <= pos.stopLoss) {
      exitPrice  = pos.stopLoss;
      exitReason = 'stop_loss';
    } else if (high >= pos.takeProfit) {
      exitPrice  = pos.takeProfit;
      exitReason = 'take_profit';
    } else if (Date.now() - pos.openedAt > MAX_HOLD_MS) {
      exitPrice  = currentPrice;
      exitReason = 'time_exit';
    }

    if (exitReason) {
      const pnlPct   = (exitPrice - pos.entryPrice) / pos.entryPrice;
      const netPnl   = pnlPct * pos.capital;   // Alpaca is commission-free
      const holdHours = Math.round((Date.now() - pos.openedAt) / 3_600_000);

      const result = {
        symbol,
        strategy:   pos.strategy,
        confidence: pos.confidence,
        entryPrice: pos.entryPrice,
        exitPrice,
        exitReason,
        takeProfit: pos.takeProfit,
        stopLoss:   pos.stopLoss,
        capital:    pos.capital,
        netPnl:     +netPnl.toFixed(4),
        netPct:     +(pnlPct * 100).toFixed(3),
        won:        netPnl > 0,
        holdHours,
        openedAt:   pos.openedAt,
        closedAt:   Date.now(),
      };

      simHistory.push(result);
      if (simHistory.length > 200) simHistory.shift();
      delete simPositions[symbol];
      closed.push(result);

      console.log(`📋 Sim closed: ${symbol} | ${exitReason} | PnL $${netPnl.toFixed(4)} (${(pnlPct*100).toFixed(2)}%)`);
    }
  }

  return closed;
}

// ─── Sim stats ────────────────────────────────────────────────
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
  const totalPnl  = simHistory.reduce((s, t) => s + t.netPnl, 0);
  const grossWins = wins.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));

  return {
    trades:       simHistory.length,
    wins:         wins.length,
    losses:       losses.length,
    winRate:      +(wins.length / simHistory.length * 100).toFixed(1),
    totalPnl:     +totalPnl.toFixed(4),
    avgPnl:       +(totalPnl / simHistory.length).toFixed(4),
    avgWin:       wins.length   ? +(grossWins / wins.length).toFixed(4)   : 0,
    avgLoss:      losses.length ? +(grossLoss / losses.length).toFixed(4) : 0,
    profitFactor: grossLoss === 0 ? grossWins : +(grossWins / grossLoss).toFixed(3),
    openCount:    Object.keys(simPositions).length,
    byStrategy:   simHistory.reduce((acc, t) => {
      if (!acc[t.strategy]) acc[t.strategy] = { count: 0, pnl: 0, wins: 0 };
      acc[t.strategy].count++;
      acc[t.strategy].pnl += t.netPnl;
      if (t.won) acc[t.strategy].wins++;
      return acc;
    }, {}),
    byExitReason: simHistory.reduce((acc, t) => {
      if (!acc[t.exitReason]) acc[t.exitReason] = { count: 0, pnl: 0 };
      acc[t.exitReason].count++;
      acc[t.exitReason].pnl += t.netPnl;
      return acc;
    }, {}),
  };
}

export function getSimHistory() { return [...simHistory].reverse(); }
export function getOpenSimPositions() { return Object.values(simPositions); }

// ─── Execute a real signal via Alpaca bracket order ──────────
export async function executeQuantSignal(signal, confirmed = false) {
  if (signal.type !== SIGNAL_TYPES.BUY) {
    return { success: false, reason: `Signal type ${signal.type} — only BUY supported` };
  }
  if (signal.confidence < MIN_CONFIDENCE) {
    return { success: false, reason: `Confidence ${signal.confidence} below ${MIN_CONFIDENCE}` };
  }

  // Risk controls
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
  if (openPositions[signal.symbol]) {
    return { success: false, reason: `Already in position for ${signal.symbol}` };
  }
  const lastCooldown = symbolCooldown[signal.symbol];
  if (lastCooldown && now - lastCooldown < SYMBOL_COOLDOWN_MS) {
    const minsLeft = Math.round((SYMBOL_COOLDOWN_MS - (now - lastCooldown)) / 60000);
    return { success: false, reason: `${signal.symbol} in cooldown — ${minsLeft}m remaining` };
  }
  if (!confirmed) {
    return { success: false, reason: 'Confirmation required', requiresConfirmation: true };
  }

  const buyingPower = await getBuyingPower();
  if (buyingPower < MAX_TRADE_USD) {
    return { success: false, reason: `Insufficient buying power: $${buyingPower.toFixed(2)}` };
  }

  const tradeUSD    = positionSize(buyingPower, signal.confidence);
  const entryPrice  = signal.price;
  const qty         = Math.floor(tradeUSD / entryPrice);   // Whole shares for penny stocks
  if (qty < 1) {
    return { success: false, reason: `Position too small — $${tradeUSD} / $${entryPrice} < 1 share` };
  }

  let order;
  try {
    order = await placeBracketOrder({
      symbol:     signal.symbol,
      qty,
      entryPrice,
      takeProfit: signal.takeProfit,
      stopLoss:   signal.stopLoss,
      type:       'limit',
    });
  } catch (err) {
    return { success: false, reason: `Order failed: ${err.message}` };
  }

  openPositions[signal.symbol] = {
    symbol:     signal.symbol,
    side:       'long',
    entryPrice, qty, tradeUSD,
    stopLoss:   signal.stopLoss,
    takeProfit: signal.takeProfit,
    strategy:   signal.strategy,
    orderId:    order.id,
    openedAt:   Date.now(),
    confidence: signal.confidence,
  };

  console.log(`✅ Bracket order placed: ${qty} ${signal.symbol} @ $${entryPrice} | TP $${signal.takeProfit} | SL $${signal.stopLoss}`);
  return { success: true, order, position: openPositions[signal.symbol], tradeUSD, qty };
}

// ─── Manage real positions (time-based exit safety net) ──────
// Alpaca brackets handle TP/SL automatically; this enforces the
// max-hold time limit (must be flat before close) and reconciles state.
export async function managePositions(snapshotMap) {
  const actions = [];

  for (const [symbol, pos] of Object.entries(openPositions)) {
    const snap = snapshotMap[symbol];
    const currentPrice = snap?.price ?? pos.entryPrice;
    const pnlPct = (currentPrice - pos.entryPrice) / pos.entryPrice;
    const pnlUSD = pnlPct * pos.tradeUSD;

    if (Date.now() - pos.openedAt > MAX_HOLD_MS) {
      try {
        await closePosition(symbol);
        recordTradeResult(pnlUSD, pos.strategy);
        if (pnlUSD < 0) symbolCooldown[symbol] = Date.now();
        delete openPositions[symbol];
        actions.push({ symbol, reason: 'Time exit (max hold)', currentPrice, pnlUSD, pnlPct, closed: true });
        console.log(`⏰ ${symbol} time-exit closed | PnL $${pnlUSD.toFixed(2)}`);
      } catch (err) {
        actions.push({ symbol, reason: 'Time exit', closed: false, error: err.message });
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
