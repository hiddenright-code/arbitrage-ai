// ─────────────────────────────────────────────────────────────
// PRICEHISTORY.JS — Stock price data via Alpaca Data API v2
//
// Endpoints used:
//   /v1beta1/screener/stocks/most-actives — discover high-volume stocks
//   /v2/stocks/snapshots           — current price, VWAP, daily bar
//   /v2/stocks/{sym}/bars (1Day)   — daily OHLCV for RVOL avg
//   /v2/stocks/{sym}/bars (1Min)   — intraday data for chart signals
// ─────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
import { SETTINGS } from './config.js';
dotenv.config();

const DATA_URL = 'https://data.alpaca.markets';
const FEED     = SETTINGS.DATA_FEED;

const alpacaHeaders = {
  'APCA-API-KEY-ID':     process.env.ALPACA_API_KEY    ?? '',
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY ?? '',
};

// ─── Caches ───────────────────────────────────────────────────
const barCache      = {};  // symbol → { bars, lastFetch }
const minuteCache   = {};  // symbol → { bars, lastFetch }
const snapshotCache = {};  // symbol → { data, lastFetch }
const CACHE_TTL     = SETTINGS.CACHE_TTL_MS;
const MIN_CACHE_TTL = 60_000;  // 1 min cache for minute bars

// ─── Alpaca GET helper ────────────────────────────────────────
async function alpacaGet(path) {
  const res = await fetch(`${DATA_URL}${path}`, { headers: alpacaHeaders });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Alpaca ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

// ─── Fetch most-active stocks by volume ──────────────────────
export async function fetchMostActive(top = 100) {
  try {
    // Alpaca's most-actives screener lives under the v1beta1 screener API
    // (not /v2/stocks). It takes `by` (volume|trades) and `top`; no feed param.
    const data = await alpacaGet(`/v1beta1/screener/stocks/most-actives?by=volume&top=${top}`);
    return data.most_actives ?? [];
  } catch (err) {
    console.error('[PriceHistory] fetchMostActive:', err.message);
    return [];
  }
}

// ─── Fetch snapshots for multiple symbols ─────────────────────
// Returns { SYMBOL: { price, open, dailyHigh, dailyLow, volume, vwap, prevClose, changePct, ... } }
export async function fetchSnapshots(symbols) {
  if (!symbols.length) return {};
  const now = Date.now();

  const uncached = symbols.filter(s => {
    const e = snapshotCache[s];
    return !e || now - e.lastFetch >= CACHE_TTL;
  });

  if (uncached.length) {
    try {
      const data = await alpacaGet(
        `/v2/stocks/snapshots?symbols=${uncached.join(',')}&feed=${FEED}`
      );

      for (const [sym, snap] of Object.entries(data)) {
        if (!snap) continue;
        const price     = snap.latestTrade?.p ?? snap.minuteBar?.c ?? 0;
        const prevClose = snap.prevDailyBar?.c ?? 0;
        const open      = snap.dailyBar?.o ?? 0;
        const high      = snap.dailyBar?.h ?? 0;
        const low       = snap.dailyBar?.l ?? 0;
        const volume    = snap.dailyBar?.v ?? 0;
        const vwap      = snap.dailyBar?.vw ?? 0;
        const changePct = prevClose > 0 ? ((price - prevClose) / prevClose) * 100 : 0;

        snapshotCache[sym] = {
          lastFetch: now,
          data: {
            symbol:    sym,
            price:     +price.toFixed(4),
            open:      +open.toFixed(4),
            dailyHigh: +high.toFixed(4),
            dailyLow:  +low.toFixed(4),
            volume,
            vwap:      +vwap.toFixed(4),
            prevClose: +prevClose.toFixed(4),
            changePct: +changePct.toFixed(2),
            bid:       snap.latestQuote?.bp ?? price,
            ask:       snap.latestQuote?.ap ?? price,
            timestamp: now,
          },
        };
      }
    } catch (err) {
      console.error('[PriceHistory] fetchSnapshots:', err.message);
    }
  }

  const result = {};
  for (const s of symbols) {
    if (snapshotCache[s]) result[s] = snapshotCache[s].data;
  }
  return result;
}

export async function fetchSnapshot(symbol) {
  const snaps = await fetchSnapshots([symbol]);
  return snaps[symbol] ?? null;
}

// ─── Fetch daily bars (for RVOL average + trend) ──────────────
export async function fetchDailyBars(symbol, days = 30) {
  const now = Date.now();
  const cached = barCache[symbol];
  if (cached && now - cached.lastFetch < CACHE_TTL) return cached.bars;

  try {
    const data = await alpacaGet(
      `/v2/stocks/${symbol}/bars?timeframe=1Day&limit=${days + 1}&feed=${FEED}&sort=asc`
    );
    const bars = (data.bars ?? []).map(b => ({
      timestamp: new Date(b.t).getTime(),
      open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
      vwap: b.vw ?? 0,
    }));
    barCache[symbol] = { bars, lastFetch: now };
    return bars;
  } catch (err) {
    console.error(`[PriceHistory] fetchDailyBars ${symbol}:`, err.message);
    return barCache[symbol]?.bars ?? [];
  }
}

// ─── Fetch intraday minute bars ───────────────────────────────
export async function fetchMinuteBars(symbol, minutes = 390) {
  const now = Date.now();
  const cached = minuteCache[symbol];
  if (cached && now - cached.lastFetch < MIN_CACHE_TTL) return cached.bars;

  try {
    const data = await alpacaGet(
      `/v2/stocks/${symbol}/bars?timeframe=1Min&limit=${minutes}&feed=${FEED}&sort=asc`
    );
    const bars = (data.bars ?? []).map(b => ({
      timestamp: new Date(b.t).getTime(),
      open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
      vwap: b.vw ?? 0,
    }));
    minuteCache[symbol] = { bars, lastFetch: now };
    return bars;
  } catch (err) {
    console.error(`[PriceHistory] fetchMinuteBars ${symbol}:`, err.message);
    return minuteCache[symbol]?.bars ?? [];
  }
}

// ─── Calculate RVOL from history + today's volume ─────────────
// Uses 20-day average (excluding today) as baseline
export function calculateRvol(todayVolume, dailyBars) {
  if (!dailyBars || dailyBars.length < 5) return 1.0;
  const hist = dailyBars.slice(-21, -1);   // Exclude today's bar
  if (!hist.length) return 1.0;
  const avg = hist.reduce((s, b) => s + b.volume, 0) / hist.length;
  if (avg === 0) return 1.0;
  return +(todayVolume / avg).toFixed(2);
}

// ─── Latest cached daily bars for a symbol ───────────────────
export function getCachedDailyBars(symbol) {
  return barCache[symbol]?.bars ?? [];
}
