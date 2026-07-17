// ─────────────────────────────────────────────────────────────
// BACKTEST/DATA.JS — Historical data layer for the backtester
//
// Design notes (the ways backtests lie, and how this layer avoids them):
//
//   SURVIVORSHIP BIAS — the universe is built from Alpaca's FULL asset
//   list including *inactive* (delisted) symbols, then filtered per-day
//   by what the stock looked like ON that day. Testing only today's
//   survivors flatters any strategy that trades names which later died —
//   which for penny stocks is many of them.
//
//   CORPORATE ACTIONS — all bars are fetched with adjustment=split.
//   Raw bars turn a 1-for-10 reverse split into a fake +900% "runner".
//
//   LOOK-AHEAD — this layer only *serves* data; the simulator asks for
//   bars strictly before/at each decision point. Nothing here peeks.
//
// Everything is cached on disk (data/backtest-cache/) so re-runs and
// longer windows are incremental instead of re-downloading the world.
// ─────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { SETTINGS } from '../config.js';
dotenv.config();

const DATA_URL    = 'https://data.alpaca.markets';
const TRADING_URL = SETTINGS.PAPER_TRADING
  ? 'https://paper-api.alpaca.markets'
  : 'https://api.alpaca.markets';
const FEED = SETTINGS.DATA_FEED;

const HEADERS = {
  'APCA-API-KEY-ID':     process.env.ALPACA_API_KEY    ?? '',
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY ?? '',
};

const CACHE_ROOT = path.join(process.cwd(), 'data', 'backtest-cache');

// ─── Small utils ──────────────────────────────────────────────
const mapBar = (b) => ({
  timestamp: new Date(b.t).getTime(),
  open: b.o, high: b.h, low: b.l, close: b.c, volume: b.v,
  vwap: b.vw ?? 0,
});

function readCache(rel) {
  try { return JSON.parse(fs.readFileSync(path.join(CACHE_ROOT, rel), 'utf8')); }
  catch { return null; }
}
function writeCache(rel, obj) {
  const p = path.join(CACHE_ROOT, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj));
}

async function alpacaGet(base, pathAndQuery) {
  const res = await fetch(`${base}${pathAndQuery}`, { headers: HEADERS });
  if (res.status === 429) {                       // rate limited — back off once
    await new Promise(r => setTimeout(r, 30_000));
    return alpacaGet(base, pathAndQuery);
  }
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    throw new Error(`Alpaca ${res.status}: ${txt.slice(0, 160)}`);
  }
  return res.json();
}

// Batched multi-symbol bars with pagination (backtest variant: explicit
// start/end + split adjustment; separate from the live now-anchored path).
async function batchedBars(symbols, params, maxPages = 40) {
  const out = {};
  let pageToken = null;
  for (let page = 0; page < maxPages; page++) {
    const url = `/v2/stocks/bars?symbols=${symbols.join(',')}&${params}`
              + (pageToken ? `&page_token=${encodeURIComponent(pageToken)}` : '');
    const data = await alpacaGet(DATA_URL, url);
    for (const [sym, bars] of Object.entries(data.bars ?? {})) {
      (out[sym] ??= []).push(...bars);
    }
    pageToken = data.next_page_token;
    if (!pageToken) break;
  }
  return out;
}

// ─── Asset list (active + inactive — survivorship honesty) ────
export async function listAllEquities() {
  const cached = readCache('assets.json');
  if (cached?.fetchedAt && Date.now() - cached.fetchedAt < 7 * 86_400_000) return cached.symbols;

  const symbols = [];
  for (const status of ['active', 'inactive']) {
    const assets = await alpacaGet(TRADING_URL, `/v2/assets?asset_class=us_equity&status=${status}`);
    for (const a of assets) {
      // Listed exchanges only (matches the live most-actives universe; OTC
      // isn't tradable through this bot) and plain 1–5 letter tickers.
      if (!['NYSE', 'NASDAQ', 'AMEX', 'ARCA', 'BATS'].includes(a.exchange)) continue;
      if (!/^[A-Z]{1,5}$/.test(a.symbol)) continue;
      symbols.push(a.symbol);
    }
  }
  const unique = [...new Set(symbols)];
  writeCache('assets.json', { fetchedAt: Date.now(), symbols: unique });
  return unique;
}

// ─── Daily bars for a date range (per-symbol disk cache) ──────
// Returns { SYM: [bars asc] }. Only re-downloads symbols whose cached
// range doesn't cover [start, end].
export async function fetchDailyRange(symbols, startISO, endISO, { chunkSize = 200, onProgress } = {}) {
  const result  = {};
  const missing = [];

  for (const sym of symbols) {
    const c = readCache(`daily/${sym}.json`);
    if (c && c.start <= startISO && c.end >= endISO && c.adjustment === 'split') {
      result[sym] = c.bars.filter(b => {
        const d = new Date(b.timestamp).toISOString().slice(0, 10);
        return d >= startISO && d <= endISO;
      });
    } else {
      missing.push(sym);
    }
  }

  const params = `timeframe=1Day&start=${startISO}&end=${endISO}&limit=10000&adjustment=split&feed=${FEED}&sort=asc`;
  for (let i = 0; i < missing.length; i += chunkSize) {
    const chunk = missing.slice(i, i + chunkSize);
    const grouped = await batchedBars(chunk, params);
    for (const sym of chunk) {
      const bars = (grouped[sym] ?? []).map(mapBar);
      writeCache(`daily/${sym}.json`, { start: startISO, end: endISO, adjustment: 'split', bars });
      result[sym] = bars;
    }
    onProgress?.(Math.min(i + chunkSize, missing.length), missing.length);
  }
  return result;
}

// ─── Minute bars for ONE ET trading day (per day+symbol cache) ─
// Covers the extended session 04:00–20:00 ET of `dateEt` (YYYY-MM-DD).
export async function fetchMinuteDay(symbols, dateEt, { chunkSize = 25 } = {}) {
  const result  = {};
  const missing = [];
  for (const sym of symbols) {
    const c = readCache(`min/${dateEt}/${sym}.json`);
    if (c) result[sym] = c.bars;
    else missing.push(sym);
  }
  if (missing.length) {
    const offset = etOffset(dateEt);
    const start  = encodeURIComponent(`${dateEt}T04:00:00${offset}`);
    const end    = encodeURIComponent(`${dateEt}T20:00:00${offset}`);
    const params = `timeframe=1Min&start=${start}&end=${end}&limit=10000&adjustment=split&feed=${FEED}&sort=asc`;
    for (let i = 0; i < missing.length; i += chunkSize) {
      const chunk = missing.slice(i, i + chunkSize);
      const grouped = await batchedBars(chunk, params);
      for (const sym of chunk) {
        const bars = (grouped[sym] ?? []).map(mapBar);
        writeCache(`min/${dateEt}/${sym}.json`, { bars });
        result[sym] = bars;
      }
    }
  }
  return result;
}

// ─── ET helpers ───────────────────────────────────────────────
// UTC offset (e.g. '-04:00') for a given ET calendar date — DST-correct.
export function etOffset(dateEt) {
  const probe = new Date(`${dateEt}T12:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', timeZoneName: 'longOffset',
  }).formatToParts(probe);
  const tz = parts.find(p => p.type === 'timeZoneName')?.value ?? 'GMT-05:00';
  return tz.replace('GMT', '') || '-05:00';
}

// Epoch ms of ET midnight for a date — lets the simulator turn bar
// timestamps into minute-of-day with plain arithmetic (no Intl per bar).
export function etMidnightEpoch(dateEt) {
  return Date.parse(`${dateEt}T00:00:00${etOffset(dateEt)}`);
}

// Hoisted formatter + memo — this gets called once per bar across the
// whole universe (millions of calls); constructing Intl formatters per
// call turns a 2-second pass into minutes.
const ET_DAY_FMT = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const etDayMemo = new Map();
export function etDateOfTimestamp(ts) {
  // Daily bars repeat the same handful of timestamps across thousands of
  // symbols — memoize on the raw ms value.
  let d = etDayMemo.get(ts);
  if (!d) {
    d = ET_DAY_FMT.format(new Date(ts));
    if (etDayMemo.size < 5000) etDayMemo.set(ts, d);
    else return d;
  }
  return d;
}
