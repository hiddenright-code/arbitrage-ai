// ─────────────────────────────────────────────────────────────
// PRICEHISTORY.JS — Fetches & caches OHLCV candle data
// Uses Binance.US 1h candles. No auth required for market data.
// ─────────────────────────────────────────────────────────────

import ccxt from 'ccxt';
import dotenv from 'dotenv';
dotenv.config();

// Public client — no API keys needed for OHLCV
const exchange = new ccxt.binanceus({
  enableRateLimit: true,
  options: { defaultType: 'spot' },
});

// Cache: symbol → { candles, lastFetch }
const cache = {};
const CACHE_TTL_MS  = 5 * 60 * 1000;  // Refresh every 5 min — candles only close once per hour
const CANDLE_LIMIT  = 500;          // 100 × 1h = ~4 days of data
const TIMEFRAME     = '4h';

// Coins to track (base assets — USDT pairs)
export const TRACKED_COINS = [
  'BTC', 'ETH', 'SOL', 'ADA',
  'DOGE', 'LTC', 'XRP', 'LINK', 'AVAX',
];

// ─── Fetch candles for one symbol ────────────────────────────
async function fetchCandles(symbol) {
  try {
    const raw = await exchange.fetchOHLCV(symbol, TIMEFRAME, undefined, CANDLE_LIMIT);
    // raw: [ [timestamp, open, high, low, close, volume], ... ]
    return raw.map(([timestamp, open, high, low, close, volume]) => ({
      timestamp, open, high, low, close, volume,
    }));
  } catch (err) {
    console.error(`[PriceHistory] Failed to fetch ${symbol}:`, err.message);
    return null;
  }
}

// ─── Get candles (with cache) ─────────────────────────────────
export async function getCandles(symbol) {
  const now = Date.now();
  const entry = cache[symbol];

  if (entry && now - entry.lastFetch < CACHE_TTL_MS) {
    return entry.candles;
  }

  const candles = await fetchCandles(symbol);
  if (candles && candles.length > 0) {
    cache[symbol] = { candles, lastFetch: now };
    return candles;
  }

  // Return stale cache if fetch failed
  return entry?.candles ?? null;
}

// Cache for 1h candles (used for pullback entry timing only)
const cache1h = {};

export async function getCandles1h(symbol) {
  const now = Date.now();
  const entry = cache1h[symbol];
  if (entry && now - entry.lastFetch < CACHE_TTL_MS) return entry.candles;

  try {
    const raw = await exchange.fetchOHLCV(symbol, '1h', undefined, 50);
    const candles = raw.map(([timestamp, open, high, low, close, volume]) => ({
      timestamp, open, high, low, close, volume,
    }));
    cache1h[symbol] = { candles, lastFetch: now };
    return candles;
  } catch {
    return entry?.candles ?? null;
  }
}

// ─── Refresh all tracked coins ────────────────────────────────
export async function refreshAll() {
  const results = {};
  await Promise.all(
    TRACKED_COINS.map(async (coin) => {
      const symbol  = `${coin}/USDT`;
      const candles = await getCandles(symbol);
      if (candles) {
        results[coin] = candles;
        console.log(`[PriceHistory] ${coin}: ${candles.length} candles loaded`);
      }
    })
  );
  return results;
}

// ─── Get latest price from cache ─────────────────────────────
export function getLatestPrice(coin) {
  const entry = cache[`${coin}/USDT`];
  if (!entry?.candles?.length) return null;
  return entry.candles[entry.candles.length - 1].close;
}

// ─── Get all cached candles ───────────────────────────────────
export function getAllCached() {
  const result = {};
  for (const [symbol, entry] of Object.entries(cache)) {
    const coin = symbol.replace('/USDT', '');
    result[coin] = entry.candles;
  }
  return result;
}
