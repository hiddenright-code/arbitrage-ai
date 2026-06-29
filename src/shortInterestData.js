// ─────────────────────────────────────────────────────────────
// SHORTINTERESTDATA.JS — Real short-interest data layer
//
// Pulls and normalizes short-interest data from two providers and
// merges them into a single canonical shape used by the squeeze
// detector:
//
//   ORTEX  — real-time *estimated* short interest. The gold standard
//            for squeeze trading. Provides SI % of free float, days
//            to cover, cost-to-borrow (CTB), utilization, on-loan
//            shares, and short-interest trend. Paid API.
//
//   FINRA  — official *consolidated* short interest. Free, but
//            published only twice a month and lagged ~8 business
//            days. Provides settled shares-short, days-to-cover, and
//            average daily volume. Used as a ground-truth anchor and
//            a fallback when ORTEX is not configured.
//
// Merge strategy:
//   • ORTEX is primary for the real-time fields (SI%FF, CTB,
//     utilization, trend) — these drive squeeze timing.
//   • FINRA fills gaps (official shares-short / DTC) and validates.
//   • If neither is configured/available, returns hasRealData=false
//     so the detector falls back to its volume-pattern estimate.
//
// Everything is configurable via env (see .env example) because the
// exact ORTEX/FINRA endpoint shapes depend on your subscription tier.
// Field extraction is defensive — it tries several known field names.
// ─────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
import { SETTINGS } from './config.js';
dotenv.config();

const CFG = SETTINGS.SHORT_INTEREST;

// ─── Cache (SI changes slowly — cache aggressively) ──────────
const cache = {};  // symbol → { data, lastFetch }

// ─── HTTP helper with timeout ─────────────────────────────────
async function httpJson(url, opts = {}, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res  = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let body;
    try { body = text ? JSON.parse(text) : {}; }
    catch { body = { raw: text }; }
    return { ok: res.ok, status: res.status, body };
  } catch (err) {
    return { ok: false, status: 0, body: { error: err.message } };
  } finally {
    clearTimeout(timer);
  }
}

// Pull the first numeric value found among several candidate keys
function pickNum(obj, ...keys) {
  if (!obj) return null;
  for (const k of keys) {
    const v = obj[k];
    if (v != null && v !== '' && !isNaN(Number(v))) return Number(v);
  }
  return null;
}

// ─── ORTEX ────────────────────────────────────────────────────
// ORTEX v1 spreads the fuel metrics across FOUR endpoints (this matches
// the official ORTEX Python SDK):
//   • {exchange}/{ticker}/short_interest      → SI%FF, shares short, free float, on-loan
//   • stock/{exchange}/{ticker}/dtc           → days to cover
//   • stock/{exchange}/{ticker}/ctb/all       → cost to borrow
//   • stock/{exchange}/{ticker}/availability  → utilization / shares available
// short_interest is REQUIRED (the #1 metric); the other three are
// best-effort so a rate-limited TEST key still yields real fuel.

// Build a full ORTEX URL from a path template, asking for just the
// most-recent daily row (page_size=1) to keep payloads tiny.
function ortexUrl(pathTemplate, symbol, exchange) {
  const path = pathTemplate
    .replace('{ticker}',   encodeURIComponent(symbol))
    .replace('{exchange}', encodeURIComponent(exchange));
  return `${CFG.ORTEX_BASE_URL}${path}?page_size=1`;
}

// One ORTEX GET for a given exchange/country segment.
function ortexGet(pathTemplate, symbol, exchange) {
  return httpJson(ortexUrl(pathTemplate, symbol, exchange), {
    headers: {
      'Ortex-Api-Key': CFG.ORTEX_API_KEY,   // ORTEX header auth
      'Accept': 'application/json',
    },
  });
}

// GET one ORTEX endpoint and return its latest data row (or null).
async function ortexRow(pathTemplate, symbol, label) {
  let res = await ortexGet(pathTemplate, symbol, CFG.ORTEX_EXCHANGE);
  // A market-specific {exchange} (e.g. NASDAQ) 404s for any ticker listed
  // on a different market — and a scanner sees a mix of NASDAQ/NYSE names.
  // ORTEX also accepts a 2-char ISO country code, so retry once with 'US',
  // which resolves the correct US listing for any ticker.
  if (!res.ok && res.status === 404 && CFG.ORTEX_EXCHANGE.toUpperCase() !== 'US') {
    res = await ortexGet(pathTemplate, symbol, 'US');
  }
  if (!res.ok) {
    console.error(`[SI] ORTEX ${label} ${symbol} → ${res.status}`);
    return null;
  }
  const body = res.body;
  // Paginated responses use `rows`; some endpoints return `data`.
  const rows = Array.isArray(body?.rows) ? body.rows
             : Array.isArray(body?.data) ? body.data
             : body?.data ? [body.data]
             : body?.result ? [body.result]
             : body ? [body] : [];
  return rows[0] ?? null;
}

async function fetchOrtex(symbol) {
  if (!CFG.ORTEX_ENABLED) return null;

  // short_interest is the anchor; the rest are best-effort enrichers.
  const [si, dtc, ctb, avail] = await Promise.all([
    ortexRow(CFG.ORTEX_SI_PATH,    symbol, 'SI'),
    ortexRow(CFG.ORTEX_DTC_PATH,   symbol, 'DTC').catch(() => null),
    ortexRow(CFG.ORTEX_CTB_PATH,   symbol, 'CTB').catch(() => null),
    ortexRow(CFG.ORTEX_AVAIL_PATH, symbol, 'AVAIL').catch(() => null),
  ]);

  if (!si && !dtc && !ctb && !avail) return null;
  const s = si ?? {};

  const siPercentFloat = pickNum(s,
    'shortInterestPcFreeFloat', 'siPercentFreeFloat', 'shortInterestPercentFreeFloat',
    'freeFloatShortPercent', 'estimatedShortInterestPercentFreeFloat',
    'si_percent_freefloat', 'shortPercentFloat', 'shortInterestPercent');
  const sharesShort = pickNum(s,
    'shortInterest', 'sharesShort', 'shortShares', 'estimatedShortInterest',
    'sharesOnLoan', 'si');
  const freeFloat = pickNum(s,
    'freeFloat', 'free_float', 'floatShares', 'freeFloatShares');
  // % of free float currently on loan ≈ utilization proxy when avail missing
  const freeFloatOnLoan = pickNum(s,
    'freeFloatOnLoanPercent', 'pcFreeFloatOnLoan', 'freeFloatOnLoan');

  const daysToCover = pickNum(dtc ?? s,
    'daysToCover', 'daysToCoverNew', 'dtc', 'days_to_cover', 'value');
  const costToBorrow = pickNum(ctb ?? s,
    'costToBorrow', 'costToBorrowNew', 'ctbNew', 'ctb', 'cost_to_borrow',
    'costToBorrowAll', 'value');
  const utilization = pickNum(avail ?? s,
    'utilization', 'utilizationRate', 'util', 'utilisation') ?? freeFloatOnLoan;

  // Trend: prefer an explicit change field on the SI row.
  const siChange = pickNum(s,
    'sharesOnLoanChange', 'onLoanChange', 'siChange', 'shortInterestChange',
    'shortInterestChangePercent');
  let siTrend = null;
  if (siChange != null) {
    siTrend = siChange > 0 ? 'rising' : siChange < 0 ? 'falling' : 'flat';
  }

  const hasAny = [siPercentFloat, daysToCover, costToBorrow, utilization, sharesShort]
    .some(v => v != null);
  if (!hasAny) return null;

  return {
    source: 'ortex',
    siPercentFloat, daysToCover, costToBorrow, utilization,
    sharesShort, freeFloat, siTrend,
    asOf:  s.lastUpdated ?? s.asOf ?? s.date ?? s.timestamp ?? null,
    stale: false,
  };
}

// ─── FINRA (OAuth2 client credentials) ───────────────────────
let finraToken = { value: null, exp: 0 };

async function getFinraToken() {
  if (finraToken.value && Date.now() < finraToken.exp - 30_000) return finraToken.value;

  const basic = Buffer.from(`${CFG.FINRA_CLIENT_ID}:${CFG.FINRA_CLIENT_SECRET}`).toString('base64');
  const { ok, status, body } = await httpJson(
    `${CFG.FINRA_TOKEN_URL}?grant_type=client_credentials`,
    {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${basic}`,
        'Content-Type':  'application/x-www-form-urlencoded',
      },
    }
  );

  if (!ok || !body.access_token) {
    console.error(`[SI] FINRA token → ${status}`);
    return null;
  }
  finraToken = {
    value: body.access_token,
    exp:   Date.now() + (body.expires_in ?? 1800) * 1000,
  };
  return finraToken.value;
}

async function fetchFinra(symbol) {
  if (!CFG.FINRA_ENABLED) return null;

  // FINRA's consolidatedShortInterest is a PUBLIC Query API dataset — it
  // needs no OAuth token. (The old code required a bearer token from
  // FINRA_TOKEN_URL, but that endpoint 403s with "Invalid request — check
  // base url/path"; the real FIP OAuth host isn't reachable here, and it
  // isn't needed anyway.) getFinraToken() is kept below for deployments
  // that point FINRA_DATASET at an entitlement-gated dataset.
  const url = `${CFG.FINRA_BASE_URL}/data/group/${CFG.FINRA_GROUP}/name/${CFG.FINRA_DATASET}`;

  // FINRA partitions this dataset by settlementDate and the Query API
  // REJECTS sorting on a partition key unless it's pinned with an EQUAL
  // filter — so sortFields:['-settlementDate'] returns 400. Instead we
  // pull a trailing window of settlements (SI is published twice a month)
  // and pick the most recent two client-side.
  const end   = new Date();
  const start = new Date(end.getTime() - 180 * 24 * 60 * 60 * 1000);
  const ymd   = (d) => d.toISOString().slice(0, 10);

  const { ok, status, body } = await httpJson(url, {
    method: 'POST',
    headers: {
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    body: JSON.stringify({
      limit: 50,
      compareFilters: [
        { compareType: 'EQUAL', fieldName: 'symbolCode', fieldValue: symbol },
      ],
      dateRangeFilters: [
        { fieldName: 'settlementDate', startDate: ymd(start), endDate: ymd(end) },
      ],
    }),
  });

  if (!ok) {
    console.error(`[SI] FINRA ${symbol} → ${status}`);
    return null;
  }

  const rows = Array.isArray(body) ? body : (body?.data ?? body?.rows ?? []);
  if (!rows.length) return null;

  // API returns partition order, so sort most-recent settlement first.
  rows.sort((a, b) => String(b.settlementDate ?? '').localeCompare(String(a.settlementDate ?? '')));

  const latest = rows[0];
  const prev   = rows[1];

  const sharesShort = pickNum(latest,
    'currentShortPositionQuantity', 'shortInterestQuantity', 'currentShortPosition', 'shortPositionQuantity');
  // Prefer the previous settlement row; fall back to the prior figure
  // FINRA stamps on the latest row itself (so a 1-row window still trends).
  const prevShort = (prev ? pickNum(prev,
    'currentShortPositionQuantity', 'shortInterestQuantity', 'currentShortPosition', 'shortPositionQuantity') : null)
    ?? pickNum(latest, 'previousShortPositionQuantity');
  const daysToCover = pickNum(latest,
    'daysToCoverQuantity', 'daysToCover', 'shortInterestRatio');
  const avgDailyVol = pickNum(latest,
    'averageDailyVolumeQuantity', 'averageDailyVolume', 'avgDailyVolume');

  let siTrend = null;
  if (sharesShort != null && prevShort != null && prevShort > 0) {
    const chg = (sharesShort - prevShort) / prevShort;
    siTrend = chg > 0.02 ? 'rising' : chg < -0.02 ? 'falling' : 'flat';
  }

  if (sharesShort == null && daysToCover == null) return null;

  return {
    source: 'finra',
    siPercentFloat: null,        // FINRA doesn't provide free float
    daysToCover:    daysToCover ?? (sharesShort && avgDailyVol ? +(sharesShort / avgDailyVol).toFixed(2) : null),
    costToBorrow:   null,
    utilization:    null,
    sharesShort,
    freeFloat:      null,
    siTrend,
    asOf:  latest.settlementDate ?? null,
    stale: true,                 // FINRA is always lagged
  };
}

// ─── Merge ORTEX (primary) + FINRA (anchor/fallback) ─────────
function merge(symbol, ortex, finra, snapshotFloat) {
  const notes = [];
  if (!ortex && !finra) {
    // Distinguish "no provider configured" from "configured but the HTTP
    // fetch failed/returned nothing". Previously this always said
    // "No SI provider configured", which was misleading when /api/config
    // shows ortex:true / finra:true — the real cause was a failed fetch.
    // Check the backend log for the actual [SI] ORTEX/FINRA status codes.
    const configured = [];
    if (CFG.ORTEX_ENABLED) configured.push('ORTEX');
    if (CFG.FINRA_ENABLED) configured.push('FINRA');
    const note = configured.length
      ? `SI provider(s) configured (${configured.join(' + ')}) but returned no data — `
        + `fetch failed or unauthorized; see backend [SI] logs for status codes`
      : 'No SI provider configured';
    return {
      symbol, source: 'none', hasRealData: false,
      siPercentFloat: null, daysToCover: null, costToBorrow: null,
      utilization: null, sharesShort: null, freeFloat: null,
      siTrend: null, asOf: null, stale: false, notes: [note],
    };
  }

  const o = ortex ?? {};
  const f = finra ?? {};

  // Free float — prefer ORTEX, then the snapshot's float if we have one
  const freeFloat = o.freeFloat ?? snapshotFloat ?? null;

  // Shares short — prefer ORTEX real-time estimate, else FINRA official
  const sharesShort = o.sharesShort ?? f.sharesShort ?? null;

  // SI % of free float — prefer ORTEX; otherwise derive from FINRA
  // shares-short and whatever float we have.
  let siPercentFloat = o.siPercentFloat ?? null;
  if (siPercentFloat == null && sharesShort != null && freeFloat) {
    siPercentFloat = +((sharesShort / freeFloat) * 100).toFixed(2);
    notes.push('SI%FF derived from shares-short ÷ float');
  }

  if (ortex && finra) notes.push('ORTEX + FINRA merged');
  else if (ortex)     notes.push('ORTEX real-time');
  else                notes.push('FINRA official (lagged)');

  return {
    symbol,
    source:        ortex && finra ? 'merged' : (ortex ? 'ortex' : 'finra'),
    hasRealData:   true,
    siPercentFloat,
    daysToCover:   o.daysToCover  ?? f.daysToCover  ?? null,
    costToBorrow:  o.costToBorrow ?? null,
    utilization:   o.utilization  ?? null,
    sharesShort,
    freeFloat,
    siTrend:       o.siTrend ?? f.siTrend ?? null,
    asOf:          o.asOf ?? f.asOf ?? null,
    stale:         ortex ? false : true,
    notes,
  };
}

// ─── Public: get short interest for one symbol ───────────────
export async function getShortInterest(symbol, snapshotFloat = null) {
  const now    = Date.now();
  const cached = cache[symbol];
  if (cached && now - cached.lastFetch < CFG.CACHE_TTL_MS) return cached.data;

  // Fetch both providers in parallel; each fails soft to null
  const [ortex, finra] = await Promise.all([
    fetchOrtex(symbol).catch(() => null),
    fetchFinra(symbol).catch(() => null),
  ]);

  const data = merge(symbol, ortex, finra, snapshotFloat);
  cache[symbol] = { data, lastFetch: now };
  return data;
}

// ─── Public: batch with concurrency limit (respect rate limits) ─
export async function getShortInterestMulti(symbols, snapshotFloatMap = {}) {
  const out = {};
  const concurrency = CFG.MAX_CONCURRENCY ?? 5;
  const queue = [...symbols];

  async function worker() {
    while (queue.length) {
      const sym = queue.shift();
      out[sym] = await getShortInterest(sym, snapshotFloatMap[sym] ?? null);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, symbols.length) }, worker));
  return out;
}

// ─── Provider status (for /api/config + dashboard) ───────────
export function getProviderStatus() {
  return {
    ortex: CFG.ORTEX_ENABLED,
    finra: CFG.FINRA_ENABLED,
    anyRealData: CFG.ORTEX_ENABLED || CFG.FINRA_ENABLED,
  };
}
