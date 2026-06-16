// ─────────────────────────────────────────────────────────────
// LIVEEXECUTOR.JS — Manual trade execution + emergency controls
// Server-side only. Do NOT import from frontend.
// ─────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
import { placeBracketOrder, getBuyingPower, closeAllPositions, cancelAllOrders } from './exchangeClient.js';
import { SETTINGS } from './config.js';

dotenv.config();

const MAX_TRADE_USD = parseFloat(process.env.MAX_TRADE_AMOUNT_USD) || SETTINGS.CAPITAL_PER_TRADE;

// ─── Execute a manual penny stock trade with safety checks ────
export async function executeLiveTrade(signal, userConfirmed = false) {
  console.log('═══════════════════════════════════════════════════');
  console.log(`⚠️  LIVE TRADE — MAX RISK: $${MAX_TRADE_USD}`);
  console.log('═══════════════════════════════════════════════════');
  console.log(`Symbol:     ${signal.symbol}`);
  console.log(`Strategy:   ${signal.strategy}`);
  console.log(`Entry:      $${signal.price}`);
  console.log(`Take Profit:$${signal.takeProfit}`);
  console.log(`Stop Loss:  $${signal.stopLoss}`);
  console.log(`Confidence: ${signal.confidence}`);

  // SAFETY 1: Confidence threshold
  if (signal.confidence < SETTINGS.MIN_SIGNAL_SCORE) {
    return { success: false, reason: `Confidence ${signal.confidence} below minimum ${SETTINGS.MIN_SIGNAL_SCORE}` };
  }

  // SAFETY 2: User confirmation
  if (!userConfirmed) {
    return { success: false, reason: 'Awaiting user confirmation.', requiresConfirmation: true };
  }

  // SAFETY 3: Bracket order requires valid TP/SL
  if (!signal.takeProfit || !signal.stopLoss) {
    return { success: false, reason: 'Missing take-profit or stop-loss — refusing naked entry.' };
  }

  // SAFETY 4: Buying power
  const buyingPower = await getBuyingPower();
  if (buyingPower < MAX_TRADE_USD) {
    return { success: false, reason: `Insufficient buying power. Need $${MAX_TRADE_USD}, have $${buyingPower.toFixed(2)}` };
  }

  const tradeUSD = Math.min(MAX_TRADE_USD, buyingPower);
  const qty      = Math.floor(tradeUSD / signal.price);
  if (qty < 1) {
    return { success: false, reason: `Position too small for 1 share at $${signal.price}` };
  }

  console.log(`📊 Buying ${qty} shares ($${(qty * signal.price).toFixed(2)})`);

  let order;
  try {
    order = await placeBracketOrder({
      symbol:     signal.symbol,
      qty,
      entryPrice: signal.price,
      takeProfit: signal.takeProfit,
      stopLoss:   signal.stopLoss,
      type:       'limit',
    });
  } catch (err) {
    return { success: false, reason: `Order failed: ${err.message}` };
  }

  console.log('═══════════════════════════════════════════════════');
  console.log(`✅ BRACKET ORDER PLACED — ${qty} ${signal.symbol}`);
  console.log('═══════════════════════════════════════════════════');

  return {
    success: true,
    order,
    symbol:  signal.symbol,
    qty,
    tradeUSD: +(qty * signal.price).toFixed(2),
    takeProfit: signal.takeProfit,
    stopLoss:   signal.stopLoss,
  };
}

// ─── Emergency stop — liquidate everything ────────────────────
export async function emergencyStop() {
  console.log('🛑 EMERGENCY STOP — cancelling orders and closing all positions.');
  try {
    await cancelAllOrders();
    const closed = await closeAllPositions();
    return { stopped: true, positionsClosed: Array.isArray(closed) ? closed.length : 0 };
  } catch (err) {
    return { stopped: false, error: err.message };
  }
}
