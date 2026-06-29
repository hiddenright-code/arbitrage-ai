// ─────────────────────────────────────────────────────────────
// CATALYSTWATCHLIST.JS — The "slow" layer of the hybrid model
//
// The intraday scanner only ever sees a stock AFTER it's already moving
// on volume. Research on penny runners says the edge often shows up a
// catalyst FIRST — the run develops over the following hours/days. This
// module closes that gap:
//
//   1. DISCOVER — poll the market-wide Alpaca news feed and score every
//      headline with the same keyword engine the signal layer uses. Fresh
//      *bullish* catalysts on penny-priced names get added to a watchlist.
//   2. CONFIRM  — track each name day-over-day. A catalyst that follows
//      through (holds gains, doesn't fade) is promoted PENDING → CONFIRMING
//      → CONFIRMED. One that fades or dilutes is demoted and expired.
//   3. FEED     — the runner scanner merges the active watchlist into its
//      candidate pool, and a CONFIRMED catalyst boosts the intraday signal.
//      Entries still trigger intraday — this only improves *discovery*.
//
//   Dilution kill-switch: an offering/ATM/dilution headline on a watched
//   name flags it (the classic penny run-killer). EDGAR 424B5/S-3 scraping
//   would be more precise but sec.gov isn't reachable here, so v1 keys off
//   the news feed, which surfaces "prices offering" headlines directly.
//
// State is persisted to disk so the watchlist survives restarts (catalysts
// span days; the process may not).
// ─────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { SETTINGS } from './config.js';
import { scoreArticle } from './newsAnalyzer.js';
import { fetchSnapshots } from './priceHistory.js';

dotenv.config();

const CFG       = SETTINGS.CATALYST;
const DATA_URL  = 'https://data.alpaca.markets';
const PRICE_MIN = SETTINGS.PRICE_MIN;

const alpacaHeaders = {
  'APCA-API-KEY-ID':     process.env.ALPACA_API_KEY    ?? '',
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY ?? '',
};

// Dilution / offering language — the canonical penny-run killer. Broader
// than the bearish news list so it also catches registered directs,
// warrants, shelf takedowns and priced offerings.
const DILUTION_RE = /\b(dilut\w*|offering|registered direct|at[- ]the[- ]market|\bATM\b|shelf|S-1|S-3|424B|warrant\w*|priced its|pricing of|reverse (stock )?split)\b/i;

// symbol → entry
let watchlist = {};

// ─── ET calendar date (watchlist day-counter ticks on ET date change) ─
function etDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());   // 'YYYY-MM-DD'
}

// ─── Persistence ──────────────────────────────────────────────
function persistPath() {
  return path.isAbsolute(CFG.PERSIST_PATH)
    ? CFG.PERSIST_PATH
    : path.join(process.cwd(), CFG.PERSIST_PATH);
}

function load() {
  try {
    const raw = fs.readFileSync(persistPath(), 'utf8');
    watchlist = JSON.parse(raw) ?? {};
    console.log(`[Catalyst] Loaded ${Object.keys(watchlist).length} watchlist names from disk`);
  } catch {
    watchlist = {};
  }
}

function save() {
  try {
    const p = persistPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(watchlist, null, 2));
  } catch (err) {
    console.error('[Catalyst] save failed:', err.message);
  }
}

load();

// ─── Market-wide news feed ────────────────────────────────────
async function fetchLatestNews(limit) {
  try {
    const res = await fetch(`${DATA_URL}/v1beta1/news?limit=${limit}&sort=desc`, { headers: alpacaHeaders });
    if (!res.ok) {
      console.error(`[Catalyst] news feed → ${res.status}`);
      return [];
    }
    const data = await res.json();
    return data.news ?? [];
  } catch (err) {
    console.error('[Catalyst] news feed:', err.message);
    return [];
  }
}

// Reduce the feed to one best bullish article + a dilution flag per symbol.
function bestCatalystPerSymbol(news) {
  const out = {};   // symbol → { article, scored, dilution }
  for (const article of news) {
    const text     = `${article.headline ?? ''} ${article.summary ?? ''}`;
    const dilution = DILUTION_RE.test(text);
    const scored   = scoreArticle(article);   // { bullScore, bearScore, catalysts, ... }
    for (const sym of (article.symbols ?? [])) {
      if (!/^[A-Z]{1,5}$/.test(sym)) continue;   // skip odd tickers
      const cur = out[sym];
      // Keep the strongest bullish article; OR-in any dilution signal.
      if (!cur || scored.bullScore > cur.scored.bullScore) {
        out[sym] = { article, scored, dilution: dilution || cur?.dilution || false };
      } else if (dilution) {
        cur.dilution = true;
      }
    }
  }
  return out;
}

// ─── Add / refresh a watchlist entry ─────────────────────────
function addCatalyst(symbol, snap, article, scored) {
  const today = etDate();
  const label = scored.catalysts.find(c => c.bullish)?.label ?? 'News catalyst';

  if (watchlist[symbol]) {
    // Refresh the catalyst if this one is stronger / newer; keep history.
    const e = watchlist[symbol];
    if (scored.bullScore >= (e.catalyst.score ?? 0)) {
      e.catalyst = catalystObj(article, scored, label);
    }
    e.lastPrice = snap.price;
    return e;
  }

  watchlist[symbol] = {
    symbol,
    addedAt:       Date.now(),
    firstSeenDate: today,
    lastDate:      today,
    dayCount:      0,
    firstPrice:    snap.price,    // catalyst-day reference price
    lastPrice:     snap.price,
    highestPrice:  snap.price,
    status:        'PENDING',
    dilutionFlag:  false,
    catalyst:      catalystObj(article, scored, label),
    confirmation:  { followThroughPct: 0, heldGains: true, sustained: false },
    history:       [{ date: today, price: snap.price, volume: snap.volume }],
  };
  return watchlist[symbol];
}

function catalystObj(article, scored, label) {
  return {
    type:     label,
    label,
    score:    +scored.bullScore.toFixed(3),
    headline: article.headline ?? null,
    source:   article.source ?? null,
    url:      article.url ?? null,
    at:       article.created_at ?? null,
  };
}

// ─── Public: scan the news feed for new catalysts ────────────
export async function scanCatalysts() {
  if (!CFG.ENABLED) return { enabled: false };

  const news = await fetchLatestNews(CFG.NEWS_FEED_LIMIT);
  if (!news.length) return { enabled: true, scanned: 0, added: [], flagged: [], size: Object.keys(watchlist).length };

  const perSymbol = bestCatalystPerSymbol(news);
  const symbols   = Object.keys(perSymbol);

  // Price-gate the universe: snapshot every mentioned symbol, keep pennies.
  const snaps = await fetchSnapshots(symbols);

  const added = [], flagged = [];
  for (const sym of symbols) {
    const snap = snaps[sym];
    if (!snap || !snap.price) continue;
    if (snap.price < PRICE_MIN || snap.price > CFG.PRICE_MAX) continue;   // penny band only

    const { article, scored, dilution } = perSymbol[sym];

    // Dilution kill-switch — flag if already watched, never add fresh.
    if (dilution) {
      if (watchlist[sym]) {
        watchlist[sym].dilutionFlag = true;
        watchlist[sym].status       = 'DILUTION_RISK';
      }
      flagged.push(sym);
      continue;
    }

    if (scored.bullScore >= CFG.MIN_CATALYST_SCORE) {
      addCatalyst(sym, snap, article, scored);
      added.push(sym);
    }
  }

  prune();
  save();
  return { enabled: true, scanned: news.length, added, flagged, size: Object.keys(watchlist).length };
}

// ─── Public: update multi-day confirmation on the watched set ─
export async function updateConfirmation() {
  if (!CFG.ENABLED) return;
  const symbols = Object.keys(watchlist);
  if (!symbols.length) return;

  const snaps = await fetchSnapshots(symbols);
  const today = etDate();

  for (const sym of symbols) {
    const e    = watchlist[sym];
    const snap = snaps[sym];
    if (!snap || !snap.price) continue;

    // Tick the day-counter once per ET trading date.
    if (e.lastDate !== today) {
      e.dayCount += 1;
      e.lastDate  = today;
      e.history.push({ date: today, price: snap.price, volume: snap.volume });
      if (e.history.length > 30) e.history.shift();
    }

    e.lastPrice    = snap.price;
    e.highestPrice = Math.max(e.highestPrice ?? snap.price, snap.price);

    const followThrough = e.firstPrice > 0 ? (snap.price - e.firstPrice) / e.firstPrice : 0;
    const heldGains     = snap.price >= e.firstPrice;
    const sustained     = snap.price >= e.firstPrice && e.dayCount >= 1;

    e.confirmation = {
      followThroughPct: +(followThrough * 100).toFixed(2),
      heldGains,
      sustained,
    };

    // State machine
    if (e.dilutionFlag) {
      e.status = 'DILUTION_RISK';
    } else if (followThrough <= -CFG.FADE_DROP_PCT) {
      e.status = 'FADING';
    } else if (sustained && followThrough > 0) {
      e.status = 'CONFIRMED';
    } else if (snap.price > e.firstPrice) {
      e.status = 'CONFIRMING';
    } else {
      e.status = 'PENDING';
    }
  }

  prune();
  save();
}

// ─── Expiry / pruning ─────────────────────────────────────────
function prune() {
  for (const [sym, e] of Object.entries(watchlist)) {
    const tooOld   = e.dayCount > CFG.WATCHLIST_MAX_DAYS;
    const fadedOut = e.status === 'FADING' && e.dayCount >= 2;
    const diluted  = e.dilutionFlag && e.dayCount >= 1;
    if (tooOld || fadedOut || diluted) delete watchlist[sym];
  }
  // Cap size — keep the strongest/most-confirmed names.
  const syms = Object.keys(watchlist);
  if (syms.length > CFG.MAX_WATCHLIST) {
    const rank = { CONFIRMED: 3, CONFIRMING: 2, PENDING: 1, FADING: 0, DILUTION_RISK: -1 };
    syms.sort((a, b) =>
      (rank[watchlist[b].status] ?? 0) - (rank[watchlist[a].status] ?? 0) ||
      (watchlist[b].catalyst.score ?? 0) - (watchlist[a].catalyst.score ?? 0)
    );
    for (const sym of syms.slice(CFG.MAX_WATCHLIST)) delete watchlist[sym];
  }
}

// ─── Accessors ────────────────────────────────────────────────

// All non-disqualified names — fed into the intraday candidate pool.
export function getActiveSymbols() {
  return Object.values(watchlist)
    .filter(e => e.status !== 'DILUTION_RISK' && e.status !== 'FADING')
    .map(e => e.symbol);
}

// Per-symbol context for the signal layer (boost / kill-switch).
export function getCatalystContext(symbol) {
  return watchlist[symbol] ?? null;
}

export function getWatchlist() {
  const rank = { CONFIRMED: 3, CONFIRMING: 2, PENDING: 1, FADING: 0, DILUTION_RISK: -1 };
  return Object.values(watchlist)
    .sort((a, b) => (rank[b.status] ?? 0) - (rank[a.status] ?? 0) || b.addedAt - a.addedAt);
}

export function getWatchlistStats() {
  const all = Object.values(watchlist);
  const by  = all.reduce((acc, e) => { acc[e.status] = (acc[e.status] ?? 0) + 1; return acc; }, {});
  return { total: all.length, byStatus: by, enabled: CFG.ENABLED };
}
