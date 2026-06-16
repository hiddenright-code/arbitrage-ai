// ─────────────────────────────────────────────────────────────
// EXCHANGECLIENT.JS — Alpaca broker client (trading + account)
// Server-side only. Do NOT import from frontend.
//
// Uses the Alpaca Trading API v2 for order placement, account
// info, and position management. Market data lives in
// priceHistory.js. Paper trading by default.
// ─────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
import { SETTINGS } from './config.js';

dotenv.config();

const PAPER       = SETTINGS.PAPER_TRADING;
const TRADING_URL = PAPER
  ? 'https://paper-api.alpaca.markets'
  : 'https://api.alpaca.markets';

const ALPACA_API_KEY    = process.env.ALPACA_API_KEY;
const ALPACA_SECRET_KEY = process.env.ALPACA_SECRET_KEY;

console.log('🔐 Checking Alpaca credentials:');
console.log(`  API Key:    ${ALPACA_API_KEY ? '✅ Loaded' : '❌ Missing'}`);
console.log(`  Secret:     ${ALPACA_SECRET_KEY ? '✅ Loaded' : '❌ Missing'}`);
console.log(`  Mode:       ${PAPER ? '📝 PAPER TRADING' : '🔴 LIVE TRADING'}`);

const headers = {
  'APCA-API-KEY-ID':     ALPACA_API_KEY    ?? '',
  'APCA-API-SECRET-KEY': ALPACA_SECRET_KEY ?? '',
  'Content-Type':        'application/json',
};

// ─── Alpaca request helpers ───────────────────────────────────
async function alpacaRequest(method, path, body = null) {
  const opts = { method, headers };
  if (body) opts.body = JSON.stringify(body);

  const res = await fetch(`${TRADING_URL}${path}`, opts);
  const text = await res.text();
  let data;
  try { data = text ? JSON.parse(text) : {}; }
  catch { data = { raw: text }; }

  if (!res.ok) {
    throw new Error(`Alpaca ${res.status}: ${data.message ?? text.slice(0, 200)}`);
  }
  return data;
}

// ─── Account ──────────────────────────────────────────────────
export async function getAccount() {
  try {
    return await alpacaRequest('GET', '/v2/account');
  } catch (err) {
    console.error('[Broker] getAccount:', err.message);
    return null;
  }
}

export async function getBuyingPower() {
  const account = await getAccount();
  return account ? parseFloat(account.buying_power) : 0;
}

export async function getCash() {
  const account = await getAccount();
  return account ? parseFloat(account.cash) : 0;
}

// ─── Positions ────────────────────────────────────────────────
export async function getPositions() {
  try {
    return await alpacaRequest('GET', '/v2/positions');
  } catch (err) {
    console.error('[Broker] getPositions:', err.message);
    return [];
  }
}

export async function getPosition(symbol) {
  try {
    return await alpacaRequest('GET', `/v2/positions/${symbol}`);
  } catch {
    return null;  // No position
  }
}

// ─── Orders ───────────────────────────────────────────────────

// Place a bracket order: entry + take-profit + stop-loss in one shot.
// This is the safest way to trade penny stocks — exits are pre-set
// the moment the entry fills, so a fast reversal can't wipe the gain.
export async function placeBracketOrder({ symbol, qty, entryPrice, takeProfit, stopLoss, type = 'limit' }) {
  const order = {
    symbol,
    qty:  String(qty),
    side: 'buy',
    type,                          // 'limit' or 'market'
    time_in_force: 'day',          // Penny stock plays are intraday
    order_class: 'bracket',
    take_profit: { limit_price: String(takeProfit) },
    stop_loss:   { stop_price:  String(stopLoss) },
  };
  if (type === 'limit') order.limit_price = String(entryPrice);

  return alpacaRequest('POST', '/v2/orders', order);
}

// Simple market/limit order (no bracket)
export async function placeOrder(symbol, side, qty, type = 'market', limitPrice = null) {
  const order = {
    symbol,
    qty:  String(qty),
    side,
    type,
    time_in_force: 'day',
  };
  if (type === 'limit' && limitPrice) order.limit_price = String(limitPrice);

  const result = await alpacaRequest('POST', '/v2/orders', order);
  return { success: true, orderId: result.id, symbol, side, qty, status: result.status };
}

// Close an entire position at market
export async function closePosition(symbol) {
  try {
    return await alpacaRequest('DELETE', `/v2/positions/${symbol}`);
  } catch (err) {
    throw new Error(`Failed to close ${symbol}: ${err.message}`);
  }
}

// Cancel all open orders (used by emergency stop)
export async function cancelAllOrders() {
  try {
    return await alpacaRequest('DELETE', '/v2/orders');
  } catch (err) {
    console.error('[Broker] cancelAllOrders:', err.message);
    return [];
  }
}

// Liquidate everything — emergency
export async function closeAllPositions() {
  try {
    return await alpacaRequest('DELETE', '/v2/positions?cancel_orders=true');
  } catch (err) {
    console.error('[Broker] closeAllPositions:', err.message);
    return [];
  }
}

// ─── Market clock ─────────────────────────────────────────────
export async function getMarketClock() {
  try {
    return await alpacaRequest('GET', '/v2/clock');
  } catch (err) {
    console.error('[Broker] getMarketClock:', err.message);
    return { is_open: false };
  }
}

export async function isMarketOpen() {
  const clock = await getMarketClock();
  return clock?.is_open ?? false;
}

// ─── Connection test ──────────────────────────────────────────
export async function testConnection() {
  try {
    const account = await getAccount();
    if (!account) return { success: false, error: 'No account returned' };
    return {
      success:      true,
      accountId:    account.id,
      buyingPower:  parseFloat(account.buying_power),
      cash:         parseFloat(account.cash),
      portfolioValue: parseFloat(account.portfolio_value),
      status:       account.status,
      paper:        PAPER,
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export function getBrokerInfo() {
  return { broker: 'Alpaca', paper: PAPER, tradingUrl: TRADING_URL };
}
