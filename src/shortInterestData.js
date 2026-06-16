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
async function fetchOrtex(symbol) {
  if (!CFG.ORTEX_ENABLED) return null;

  const path = CFG.ORTEX_SI_PATH
    .replace('{ticker}',   encodeURIComponent(symbol))
    .replace('{exchange}', encodeURIComponent(CFG.ORTEX_EXCHANGE));
  const url = `${CFG.ORTEX_BASE_URL}${path}`;

  const { ok, status, body } = await httpJson(url, {
    headers: {
      'Ortex-Api-Key':  CFG.ORTEX_API_KEY,   // ORTEX header auth
      'Authorization': `Bearer ${CFG.ORTEX_API_KEY}`, // some tiers use bearer
      'Accept': 'application/json',
    },
  });

  if (!ok) {
    console.error(`[SI] ORTEX ${symbol} → ${status}`);
    return null;
  }

  // ORTEX wraps payloads differently by endpoint — unwrap defensively
  const d = body?.data ?? body?.rows?.[0] ?? body?.result ?? body ?? {};

  const siPercentFloat = pickNum(d,
    'shortInterestPcFreeFloat', 'siPercentFreeFloat', 'shortInterestPercentFreeFloat',
    'freeFloatShortPercent', 'si_percent_freefloat', 'shortPercentFloat');
  const daysToCover = pickNum(d,
    'daysToCover', 'daysToCoverNew', 'dtc', 'days_to_cover');
  const costToBorrow = pickNum(d,
    'costToBorrow', 'costToBorrowNew', 'ctbNew', 'ctb', 'cost_to_borrow');
  const utilization = pickNum(d,
    'utilization', 'utilizationRate', 'util', 'utilisation');
  const sharesShort = pickNum(d,
    'shortInterest', 'sharesShort', 'shortShares', 'estimatedShortInterest', 'si');
  const freeFloat = pickNum(d,
    'freeFloat', 'free_float', 'floatShares', 'freeFloatShares');
  const sharesOnLoanChange = pickNum(d,
    'sharesOnLoanChange', 'onLoanChange', 'siChange', 'shortInterestChange');

  // Derive trend from ORTEX change field when present
  let siTrend = null;
  if (sharesOnLoanChange != null) {
    siTrend = sharesOnLoanChange > 0 ? 'rising' : sharesOnLoanChange < 0 ? 'falling' : 'flat';
  }

  const hasAny = [siPercentFloat, daysToCover, costToBorrow, utilization, sharesShort]
    .some(v => v != null);
  if (!hasAny) return null;

  return {
    source: 'ortex',
    siPercentFloat, daysToCover, costToBorrow, utilization,
    sharesShort, freeFloat, siTrend,
    asOf:  d.lastUpdated ?? d.asOf ?? d.date ?? null,
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
  const token = await getFinraToken();
  if (!token) return null;

  const url = `${CFG.FINRA_BASE_URL}/data/group/${CFG.FINRA_GROUP}/name/${CFG.FINRA_DATASET}`;

  // FINRA Query API: fetch the two most recent settlement records for
  // this symbol so we can compute the short-interest trend.
  const { ok, status, body } = await httpJson(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    body: JSON.stringify({
      limit: 2,
      compareFilters: [
        { compareType: 'EQUAL', fieldName: 'symbolCode', fieldValue: symbol },
      ],
      // Most-recent settlement first
      sortFields: ['-settlementDate'],
    }),
  });

  if (!ok) {
    console.error(`[SI] FINRA ${symbol} → ${status}`);
    return null;
  }

  const rows = Array.isArray(body) ? body : (body?.data ?? body?.rows ?? []);
  if (!rows.length) return null;

  const latest = rows[0];
  const prev   = rows[1];

  const sharesShort = pickNum(latest,
    'currentShortPositionQuantity', 'shortInterestQuantity', 'currentShortPosition', 'shortPositionQuantity');
  const prevShort = prev ? pickNum(prev,
    'currentShortPositionQuantity', 'shortInterestQuantity', 'currentShortPosition', 'shortPositionQuantity') : null;
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
    return {
      symbol, source: 'none', hasRealData: false,
      siPercentFloat: null, daysToCover: null, costToBorrow: null,
      utilization: null, sharesShort: null, freeFloat: null,
      siTrend: null, asOf: null, stale: false, notes: ['No SI provider configured'],
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
