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
// Snapshots feed live signal prices — keep them fresher than the scan cadence
const SNAP_TTL      = SETTINGS.SNAPSHOT_TTL_MS ?? 25_000;

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
    return !e || now - e.lastFetch >= SNAP_TTL;
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
            // ET date of the daily bar — until a symbol prints today, this
            // is YESTERDAY, and price/volume/changePct all describe the
            // prior session (see the staleness skip in the scanner).
            dailyBarDate: snap.dailyBar?.t ? ET_DAY.format(new Date(snap.dailyBar.t)) : null,
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

// ─── Batched multi-symbol bars ────────────────────────────────
// Alpaca's /v2/stocks/bars accepts a comma-separated symbol list and
// returns bars grouped per symbol — ONE request instead of N. Bars are
// the scan loop's hottest path (daily bars for every candidate, minute
// bars for every runner, every cycle), so everything below is batched;
// the single-symbol exports delegate here.

const mapBar = (b) => ({
  timestamp: new Date(b.t).getTime(),
  open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
  vwap: b.vw ?? 0,
});

// GET one batched bars query, following pagination. Returns { SYM: [raw bars] }.
async function batchedBars(symbols, params, maxPages = 5) {
  const out = {};
  let pageToken = null;
  for (let page = 0; page < maxPages; page++) {
    const url = `/v2/stocks/bars?symbols=${symbols.join(',')}&${params}`
              + (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : '');
    const data = await alpacaGet(url);
    for (const [sym, bars] of Object.entries(data.bars ?? {})) {
      (out[sym] ??= []).push(...bars);
    }
    pageToken = data.next_page_token;
    if (!pageToken) break;
  }
  return out;
}

// Start of today's extended session (04:00 ET) as an ISO timestamp.
function sessionStartISO() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', year: 'numeric', month: '2-digit',
      day: '2-digit', timeZoneName: 'longOffset',
    }).formatToParts(new Date()).map(p => [p.type, p.value])
  );
  const offset = parts.timeZoneName.replace('GMT', '') || '-05:00';  // e.g. '-04:00'
  return `${parts.year}-${parts.month}-${parts.day}T04:00:00${offset}`;
}

// ─── Daily bars for many symbols in one request ───────────────
// A `start` is REQUIRED: without it, Alpaca's daily-bars default window
// returns only TODAY's bar — which silently broke RVOL for every symbol
// (calculateRvol saw <5 bars and fell back to 1.0, so nothing ever
// cleared RVOL ≥3x). Bound the window generously, fetch ascending, and
// keep each symbol's most recent days+1 bars (today last).
export async function fetchDailyBarsMulti(symbols, days = 30) {
  const now = Date.now();
  const uncached = [...new Set(symbols)].filter(s => {
    const c = barCache[s];
    return !c || now - c.lastFetch >= CACHE_TTL;
  });

  if (uncached.length) {
    const start = new Date(now - (days * 2 + 10) * 86_400_000).toISOString().slice(0, 10);
    const params = `timeframe=1Day&start=${start}&limit=10000&feed=${FEED}&sort=asc`;
    // Chunk to keep URLs bounded and stay under the per-request bar cap
    for (let i = 0; i < uncached.length; i += 50) {
      const chunk = uncached.slice(i, i + 50);
      try {
        const grouped = await batchedBars(chunk, params);
        for (const sym of chunk) {
          barCache[sym] = { bars: (grouped[sym] ?? []).map(mapBar).slice(-(days + 1)), lastFetch: now };
        }
      } catch (err) {
        console.error(`[PriceHistory] fetchDailyBarsMulti (${chunk.length} syms):`, err.message);
      }
    }
  }

  const result = {};
  for (const s of symbols) result[s] = barCache[s]?.bars ?? [];
  return result;
}

// ─── Today's minute bars for many symbols in one request ──────
// Bounded to today's extended session (from 04:00 ET) so intraday
// indicators can never see a prior session's tape — the multi-symbol
// endpoint has no per-symbol limit, and "latest N bars" without a date
// bound would happily hand an afternoon scan yesterday's morning.
export async function fetchMinuteBarsMulti(symbols, minutes = 390) {
  const now = Date.now();
  const uncached = [...new Set(symbols)].filter(s => {
    const c = minuteCache[s];
    return !c || now - c.lastFetch >= MIN_CACHE_TTL;
  });

  if (uncached.length) {
    const params = `timeframe=1Min&start=${encodeURIComponent(sessionStartISO())}&limit=10000&feed=${FEED}&sort=asc`;
    for (let i = 0; i < uncached.length; i += 25) {
      const chunk = uncached.slice(i, i + 25);
      try {
        const grouped = await batchedBars(chunk, params);
        for (const sym of chunk) {
          minuteCache[sym] = { bars: (grouped[sym] ?? []).map(mapBar), lastFetch: now };
        }
      } catch (err) {
        console.error(`[PriceHistory] fetchMinuteBarsMulti (${chunk.length} syms):`, err.message);
      }
    }
  }

  const result = {};
  for (const s of symbols) result[s] = (minuteCache[s]?.bars ?? []).slice(-minutes);
  return result;
}

// ─── Single-symbol wrappers (delegate to the batched path) ────
export async function fetchDailyBars(symbol, days = 30) {
  return (await fetchDailyBarsMulti([symbol], days))[symbol] ?? [];
}

export async function fetchMinuteBars(symbol, minutes = 390) {
  return (await fetchMinuteBarsMulti([symbol], minutes))[symbol] ?? [];
}

// ─── Calculate RVOL from history + today's volume ─────────────
// Two refinements over the naive todayVolume / 20-day-mean:
//
//   MEDIAN baseline — a stock's own prior runner days are giant volume
//   spikes inside the lookback that inflate a mean baseline and mask a
//   fresh re-ignition off the base (e.g. SOAR: 20-day mean 153k vs median
//   19k — a 156k day reads 1.0x on the mean but 8x on the median).
//
//   TIME-OF-DAY pacing — today's volume is PARTIAL until the close, so a
//   full-day baseline understates RVOL all morning, the exact window
//   where runners are born (a stock pacing 5x at 10am read ~0.6x and got
//   filtered out). We compare against the volume expected *by this time
//   of day*, so "RVOL 3x" means the same thing at 10:00 as at 15:55.

const ET_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const ET_HM  = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false,
});

function etMinutesNow() {
  const p = Object.fromEntries(ET_HM.formatToParts(new Date()).map(x => [x.type, x.value]));
  return (Number(p.hour) % 24) * 60 + Number(p.minute);
}

// Fraction of a normal day's volume expected by now. Linear pacing over
// the 390-min RTH session, floored at 5% so pre-market/first-minutes
// RVOL is a meaningful pace rather than a divide-by-almost-zero.
function sessionVolumeFraction() {
  const m = etMinutesNow();
  const open = 9 * 60 + 30, close = 16 * 60;
  if (m >= close || m < 4 * 60) return 1;   // after close / overnight: day complete
  if (m <= open) return 0.05;               // pre-market floor
  return Math.max((m - open) / 390, 0.05);
}

export function calculateRvol(todayVolume, dailyBars) {
  if (!dailyBars || dailyBars.length < 5) return 1.0;
  const today = ET_DAY.format(new Date());
  const vols = dailyBars
    .filter(b => ET_DAY.format(new Date(b.timestamp)) !== today)  // drop today's partial bar
    .slice(-20)
    .map(b => b.volume)
    .filter(v => v > 0);
  if (!vols.length) return 1.0;
  const sorted = [...vols].sort((a, b) => a - b);
  const mid    = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const base   = median || (vols.reduce((s, v) => s + v, 0) / vols.length);
  if (base <= 0) return 1.0;
  const expectedByNow = base * sessionVolumeFraction();
  return +(todayVolume / expectedByNow).toFixed(2);
}

// ─── Latest cached daily bars for a symbol ───────────────────
export function getCachedDailyBars(symbol) {
  return barCache[symbol]?.bars ?? [];
}

// Today's ET calendar date — shared so the scanner can compare it against
// a snapshot's dailyBarDate.
export function etToday() {
  return ET_DAY.format(new Date());
}
