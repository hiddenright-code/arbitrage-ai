// ─────────────────────────────────────────────────────────────
// EXCHANGECLIENT.JS — Exchange connections + arb detection
// Server-side only. Do NOT import from frontend.
// ─────────────────────────────────────────────────────────────

import ccxt from 'ccxt';
import dotenv from 'dotenv';
import { SETTINGS } from './config.js';
import { initCycles, getRankedCycles, recordScan, getTopCycles, getHourlyActivity } from './cycleAnalyzer.js';

dotenv.config();

const BINANCEUS_API_KEY = process.env.BINANCE_API_KEY;
const BINANCEUS_SECRET  = process.env.BINANCE_SECRET_KEY;
const COINBASE_API_KEY  = process.env.COINBASE_API_KEY;
const COINBASE_SECRET   = process.env.COINBASE_SECRET_KEY;
const KRAKEN_API_KEY    = process.env.KRAKEN_API_KEY;
const KRAKEN_SECRET     = process.env.KRAKEN_SECRET_KEY;

console.log('🔐 Checking API keys:');
console.log(`  Binance.US: ${BINANCEUS_API_KEY ? '✅ Loaded' : '❌ Missing'}`);
console.log(`  Coinbase:   ${COINBASE_API_KEY  ? '✅ Loaded' : '❌ Missing'}`);
console.log(`  Kraken:     ${KRAKEN_API_KEY    ? '✅ Loaded' : '❌ Missing'}`);

// ─── Initialize exchanges ─────────────────────────────────────
const exchangeConfigs = {
  BinanceUS: { class: ccxt.binanceus, apiKey: BINANCEUS_API_KEY, secret: BINANCEUS_SECRET },
  Coinbase:  { class: ccxt.coinbase,  apiKey: COINBASE_API_KEY,  secret: COINBASE_SECRET  },
  Kraken:    { class: ccxt.kraken,    apiKey: KRAKEN_API_KEY,    secret: KRAKEN_SECRET    },
};

const exchanges = {};
for (const [name, cfg] of Object.entries(exchangeConfigs)) {
  if (cfg.apiKey) {
    try {
      exchanges[name] = new cfg.class({
        apiKey: cfg.apiKey, secret: cfg.secret,
        enableRateLimit: true, options: { defaultType: 'spot' },
      });
      console.log(`✅ ${name} initialized`);
    } catch (err) {
      console.error(`❌ ${name} init failed:`, err.message);
    }
  } else {
    console.log(`⚠️  ${name} disabled — no API keys`);
  }
}

// ─── Bootstrap triangular cycles once Binance.US is ready ────
let triCyclesReady = false;

async function bootstrapTriangularCycles() {
  const ex = exchanges[SETTINGS.TRIANGULAR_EXCHANGE];
  if (!ex) {
    console.log('⚠️  Triangular arb disabled — BinanceUS not initialized');
    return;
  }
  try {
    console.log('🔺 Loading Binance.US markets for cycle generation...');
    await ex.loadMarkets();
    const available = Object.keys(ex.markets);
    initCycles(available);
    triCyclesReady = true;
    console.log(`✅ Triangular cycles ready`);
  } catch (err) {
    console.error('❌ Failed to load markets for cycle generation:', err.message);
  }
}

bootstrapTriangularCycles();

// ─── Fetch cross-exchange prices ──────────────────────────────
// Uses ARB_EXCHANGES only (excludes Coinbase) for opportunity detection.
// Still fetches Coinbase for balance display via /api/balances.
export async function fetchRealPrices(pairs = SETTINGS.PAIRS, exchangeNames = SETTINGS.ARB_EXCHANGES) {
  const prices = {};
  pairs.forEach(pair => { prices[pair] = {}; });

  await Promise.all(
    exchangeNames.map(async (name) => {
      const ex = exchanges[name];
      if (!ex) return;
      // Fetch all pairs for this exchange in parallel
      await Promise.all(
        pairs.map(async (pair) => {
          try {
            const ob = await ex.fetchOrderBook(pair, 5);
            prices[pair][name] = {
              bid: ob.bids[0]?.[0] ?? 0,
              ask: ob.asks[0]?.[0] ?? 0,
              bidVol: ob.bids[0]?.[1] ?? 0,
              askVol: ob.asks[0]?.[1] ?? 0,
              timestamp: Date.now(),
            };
          } catch {
            prices[pair][name] = { bid: 0, ask: 0, error: true };
          }
        })
      );
      console.log(`📊 ${name}: fetched ${pairs.length} pairs`);
    })
  );

  return prices;
}

// ─── Detect cross-exchange opportunities ─────────────────────
export function detectOpportunities(prices) {
  const opps = [];
  const { FEES, WITHDRAWAL_FEES, MIN_PROFIT_THRESHOLD, ARB_EXCHANGES } = SETTINGS;

  for (const [pair, exPrices] of Object.entries(prices)) {
    for (const buyEx of ARB_EXCHANGES) {
      for (const sellEx of ARB_EXCHANGES) {
        if (buyEx === sellEx) continue;
        const ask = exPrices[buyEx]?.ask;
        const bid = exPrices[sellEx]?.bid;
        if (!ask || !bid || ask <= 0 || bid <= 0) continue;
        if (exPrices[buyEx]?.error || exPrices[sellEx]?.error) continue;

        const grossProfit = (bid - ask) / ask;
        const totalFees   = FEES[buyEx] + FEES[sellEx] + WITHDRAWAL_FEES[buyEx];
        const netProfit   = grossProfit - totalFees;

        if (netProfit > MIN_PROFIT_THRESHOLD) {
          opps.push({
            type: 'cross',
            pair, buyEx, sellEx, ask, bid,
            grossPct: +(grossProfit * 100).toFixed(4),
            netPct:   +(netProfit   * 100).toFixed(4),
            feesPct:  +(totalFees   * 100).toFixed(4),
            timestamp: Date.now(),
          });
        }
      }
    }
  }

  return opps.sort((a, b) => b.netPct - a.netPct).slice(0, 10);
}

// ─── Scan triangular cycles ───────────────────────────────────
// Fetches ticker data for all unique pairs in ranked cycles,
// computes the 3-leg cycle profit, records results in cycleAnalyzer.
export async function scanTriangularCycles() {
  if (!triCyclesReady) return [];

  const ex = exchanges[SETTINGS.TRIANGULAR_EXCHANGE];
  if (!ex) return [];

  const cycles       = getRankedCycles();
  const fee          = SETTINGS.FEES[SETTINGS.TRIANGULAR_EXCHANGE];
  const threshold    = SETTINGS.MIN_PROFIT_THRESHOLD;
  const opportunities = [];

  // Collect all unique pairs needed across all cycles
  const uniquePairs = [...new Set(cycles.flatMap(c => c.pairs))];

  // Fetch all tickers in one batch call (much faster than per-pair)
  let tickers = {};
  try {
    // fetchTickers with a list is faster than N individual calls
    const raw = await ex.fetchTickers(uniquePairs);
    tickers = raw;
  } catch {
    // Fallback: fetch individually if batch not supported
    await Promise.all(
      uniquePairs.map(async (pair) => {
        try {
          tickers[pair] = await ex.fetchTicker(pair);
        } catch {
          tickers[pair] = null;
        }
      })
    );
  }

  for (const cycle of cycles) {
    const [p1, p2, p3] = cycle.pairs;
    const t1 = tickers[p1];
    const t2 = tickers[p2];
    const t3 = tickers[p3];

    if (!t1?.ask || !t2?.ask || !t3?.bid) continue;
    if (t1.ask <= 0 || t2.ask <= 0 || t3.bid <= 0) continue;

    // Simulate the 3-leg cycle with $1 of USDT:
    //   Step 1: Buy A with USDT → spend ask1, get (1/ask1) units of A
    //   Step 2: Buy B with A   → spend ask2, get (1/ask1/ask2) units of B
    //   Step 3: Sell B for USDT → receive bid3 per B
    // End USDT = (1 / ask1 / ask2) * bid3
    const unitsA = 1 / t1.ask;
    const unitsB = cycle.direction === 'forward'
      ? unitsA / t2.ask
      : unitsA * t2.bid;
    const endUsdt     = unitsB * t3.bid;
    const grossProfit = endUsdt - 1;
    const totalFees   = fee * 3;
    const netProfit   = grossProfit - totalFees;

    console.log(`🔺 ${cycle.id} | gross: ${(grossProfit*100).toFixed(4)}% | net: ${(netProfit*100).toFixed(4)}%`);
    const wasHit = netProfit > threshold;
    recordScan(cycle.id, grossProfit, wasHit);

    if (wasHit) {
      opportunities.push({
        type:      'triangular',
        id:        cycle.id,
        exchange:  SETTINGS.TRIANGULAR_EXCHANGE,
        pairs:     cycle.pairs,
        prices:    [t1.ask, t2.ask, t3.bid],
        grossPct:  +(grossProfit * 100).toFixed(4),
        netPct:    +(netProfit   * 100).toFixed(4),
        feesPct:   +(totalFees   * 100).toFixed(4),
        timestamp: Date.now(),
      });
    }
  }

  return opportunities.sort((a, b) => b.netPct - a.netPct).slice(0, 10);
}

// ─── Get cycle intelligence (for dashboard) ──────────────────
export function getCycleIntelligence() {
  return {
    topCycles:      getTopCycles(15),
    hourlyActivity: getHourlyActivity(),
  };
}

// ─── Balance ─────────────────────────────────────────────────
export async function getBalance(exchangeName, currency = 'USDT') {
  const ex = exchanges[exchangeName];
  if (!ex) return 0;
  try {
    const bal = await ex.fetchBalance();
    return bal[currency]?.free ?? 0;
  } catch (err) {
    console.error(`Balance failed ${exchangeName}:`, err.message);
    return 0;
  }
}

// ─── Place limit order ────────────────────────────────────────
export async function placeLimitOrder(exchangeName, pair, side, amount, price) {
  const ex = exchanges[exchangeName];
  if (!ex) throw new Error(`${exchangeName} not initialized`);
  const order = await ex.createLimitOrder(pair, side, amount, price);
  return { success: true, orderId: order.id, exchange: exchangeName, side, amount, price, status: order.status };
}

// ─── Test connection ──────────────────────────────────────────
export async function testConnection(exchangeName) {
  const ex = exchanges[exchangeName];
  if (!ex) return { success: false, error: 'Not initialized' };
  try {
    const bal = await ex.fetchBalance();
    return { success: true, balance: bal.total?.USDT ?? 0 };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

export function getAvailableExchanges() {
  return Object.keys(exchanges);
}

export function getExchanges() {
  return exchanges;
}
