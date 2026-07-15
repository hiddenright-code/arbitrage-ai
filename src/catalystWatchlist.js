// ─────────────────────────────────────────────────────────────
// CATALYSTWATCHLIST.JS — The "slow" layer of the hybrid model (v2)
//
// The intraday scanner only ever sees a stock AFTER it's already moving
// on volume. Research on penny runners says the edge often shows up as a
// catalyst FIRST — the run develops over the following hours/days. This
// module closes that gap:
//
//   1. DISCOVER — incrementally poll the market-wide Alpaca news feed
//      (cursor-based, so each sweep only processes articles it hasn't
//      seen) and score every headline with the shared keyword engine.
//      Fresh, genuinely bullish catalysts on penny-priced names get
//      added to a persistent watchlist.
//   2. CONFIRM  — track each name day-over-day. A catalyst that follows
//      through (holds gains, no dump off the high) is promoted
//      PENDING → CONFIRMING → CONFIRMED. One that fades is demoted
//      and expired.
//   3. FEED     — the runner scanner merges the active watchlist into
//      its candidate pool, and a CONFIRMED catalyst boosts the intraday
//      signal. Entries still trigger intraday — discovery only.
//
// v2 classifier rules (why a headline does/doesn't make the list):
//   • Catalysts are tiered. HARD = a real corporate event (FDA, M&A,
//     contract, earnings, uplisting…). SOFT = sentiment/attention
//     (squeeze chatter, analyst notes, retail buzz). SOFT needs a much
//     higher score, because sentiment headlines are where the false
//     positives live.
//   • Negative-context guard: "Bearish Bets Surge on X" mentions short
//     interest but is not a bullish catalyst. Any negative-framing match
//     blocks admission outright.
//   • Freshness: the article must be recent (≤ MAX_AGE_HOURS); scores
//     are recency-weighted so a stale headline can't add a name.
//   • Dilution kill-switch: offering/ATM/warrant/reverse-split language
//     flags a watched name (the classic run-killer) and blocks fresh
//     admission. (EDGAR 424B5/S-3 would be more precise, but sec.gov
//     isn't reachable from this environment; the news feed surfaces
//     priced-offering headlines directly.)
//
// State (watchlist + news cursor + seen article IDs) persists to disk so
// multi-day tracking survives restarts.
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

// ─── Classifier vocabulary ────────────────────────────────────

// Event-type catalysts (label → tier). HARD events move stocks on their
// own; SOFT ones are attention/sentiment and need a much higher bar.
const HARD_CATALYSTS = new Set([
  'FDA Approval', 'Clinical Trial Success', 'Phase Trial Success',
  'Breakthrough Designation', 'M&A / Buyout', 'Tender Offer',
  'Earnings Beat', 'Record Earnings', 'Raised Guidance', 'Beat Estimates',
  'Government Contract', 'Partnership', 'Contract Win',
  'Exchange Uplisting', 'Product Launch', 'Patent Grant',
]);

// Negative framing that disqualifies a headline as a *bullish* catalyst
// even when it trips a bullish keyword (e.g. "Bearish Bets Surge on X"
// matches the short-interest pattern but is not a buy-side event).
const NEGATIVE_CONTEXT_RE = new RegExp([
  'bearish (bets?|wagers?|options)', 'short sellers? (circle|target|pile)',
  'sell-?off', 'plunge\\w*', 'tumbl\\w+', 'slump\\w*', 'sink(s|ing)?',
  'crash\\w*', 'downgrad\\w+', 'investigat\\w+', 'probe', 'recall',
  'halt(ed)?', 'suspend\\w+', 'delist\\w*', 'going concern', 'lawsuit',
  'fraud', 'bankrupt\\w*',
].join('|'), 'i');

// Dilution / offering language — the canonical penny-run killer. Scoped
// to finance phrasing so "company begins offering new service" doesn't
// false-positive.
const DILUTION_RE = new RegExp([
  '(public|direct|underwritten|follow-on|secondary|units?|shelf)\\s+offering',
  'offering\\s+of\\s+(shares|units|common|securities)',
  'priced\\s+(its|an?|the)\\b[^.]{0,60}offering',
  'at-the-market', 'registered direct', '\\bS-[13]\\b', '\\b424B\\d?\\b',
  'dilut\\w+', 'warrant (exercise|inducement)',
  'reverse (stock )?split', 'convertible (note|debenture)',
  '(securities|equity|share) purchase agreement', 'equity line',
].join('|'), 'i');

// ─── State ────────────────────────────────────────────────────
let watchlist = {};        // symbol → entry
let newsCursor = null;     // ISO created_at of the newest article processed
let seenIds = new Set();   // recently-processed article IDs (cursor-overlap dedupe)
const SEEN_CAP = 500;

// ─── ET calendar date (watchlist day-counter ticks on ET date change) ─
function etDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());   // 'YYYY-MM-DD'
}

// Weekends must not burn watchlist days — a Friday catalyst would lose 2
// of its N expiry days to Sat/Sun with zero trading in between.
function isEtWeekend() {
  const wd = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', weekday: 'short',
  }).format(new Date());
  return wd === 'Sat' || wd === 'Sun';
}

// ─── Persistence (versioned; migrates the v1 plain-map format) ─
function persistPath() {
  return path.isAbsolute(CFG.PERSIST_PATH)
    ? CFG.PERSIST_PATH
    : path.join(process.cwd(), CFG.PERSIST_PATH);
}

function load() {
  try {
    const raw = JSON.parse(fs.readFileSync(persistPath(), 'utf8'));
    if (raw?.version === 2) {
      watchlist  = raw.watchlist ?? {};
      newsCursor = raw.newsCursor ?? null;
      seenIds    = new Set(raw.seenIds ?? []);
    } else if (raw && typeof raw === 'object') {
      watchlist = raw;   // v1 file: plain symbol → entry map
      for (const e of Object.values(watchlist)) {
        e.baselineVolume ??= e.history?.[0]?.volume ?? 0;
        e.newsHits       ??= 1;
      }
    }
    const n = Object.keys(watchlist).length;
    if (n) console.log(`[Catalyst] Loaded ${n} watchlist names from disk`);
  } catch {
    watchlist = {};
  }
}

function save() {
  try {
    const p = persistPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({
      version: 2,
      newsCursor,
      seenIds: [...seenIds].slice(-SEEN_CAP),
      watchlist,
    }, null, 2));
  } catch (err) {
    console.error('[Catalyst] save failed:', err.message);
  }
}

load();

// ─── Incremental market-wide news fetch ───────────────────────
// First sweep: one page of the latest headlines. After that: only
// articles newer than the cursor, paginated, capped per sweep — so a
// 10-minute cadence can't miss a burst and never re-scores old news.
async function fetchNewArticles() {
  const articles = [];
  let pageToken  = null;

  for (let page = 0; page < 5; page++) {
    let url = `${DATA_URL}/v1beta1/news?limit=${CFG.NEWS_FEED_LIMIT}&sort=desc`;
    if (newsCursor) url += `&start=${encodeURIComponent(newsCursor)}`;
    if (pageToken)  url += `&page_token=${encodeURIComponent(pageToken)}`;

    let data;
    try {
      const res = await fetch(url, { headers: alpacaHeaders });
      if (!res.ok) {
        console.error(`[Catalyst] news feed → ${res.status}`);
        break;
      }
      data = await res.json();
    } catch (err) {
      console.error('[Catalyst] news feed:', err.message);
      break;
    }

    const batch = (data.news ?? []).filter(a => a.id == null || !seenIds.has(a.id));
    articles.push(...batch);

    pageToken = data.next_page_token;
    if (!newsCursor || !pageToken || articles.length >= CFG.MAX_ARTICLES_PER_SWEEP) break;
  }

  // Advance the cursor to the newest article seen; remember IDs so the
  // inclusive cursor boundary can't double-process.
  for (const a of articles) {
    if (a.id != null) seenIds.add(a.id);
    if (a.created_at && (!newsCursor || a.created_at > newsCursor)) newsCursor = a.created_at;
  }
  if (seenIds.size > SEEN_CAP) seenIds = new Set([...seenIds].slice(-SEEN_CAP));

  return articles;
}

// ─── Classify one article ─────────────────────────────────────
// Returns { admitScore, label, tier, dilution, negative } — admitScore
// is the net bull-minus-bear score, recency-weighted, zeroed when the
// article is stale or negatively framed. Exported for tuning/testing.
export function classify(article) {
  const text     = `${article.headline ?? ''} ${article.summary ?? ''}`;
  const dilution = DILUTION_RE.test(text);
  const negative = NEGATIVE_CONTEXT_RE.test(text);
  const scored   = scoreArticle(article);   // bullScore/bearScore raw, netScore recency-weighted

  const best  = scored.catalysts.filter(c => c.bullish)
    .sort((a, b) => b.score - a.score)[0] ?? null;
  const label = best?.label ?? null;
  const tier  = label ? (HARD_CATALYSTS.has(label) ? 'HARD' : 'SOFT') : null;

  const fresh = scored.ageHours <= CFG.MAX_AGE_HOURS;
  const admitScore = (!fresh || negative || dilution) ? 0 : Math.max(scored.netScore, 0);

  return { admitScore, label, tier, dilution, negative, scored, article };
}

// Reduce a sweep's articles to one decision per symbol: the strongest
// admissible catalyst + an OR of any dilution flags + a hit count.
function classifyBySymbol(articles) {
  const out = {};   // symbol → { best, dilution, hits }
  for (const article of articles) {
    const c = classify(article);
    for (const sym of (article.symbols ?? [])) {
      if (!/^[A-Z]{1,5}$/.test(sym)) continue;
      const cur = (out[sym] ??= { best: null, dilution: false, hits: 0 });
      cur.dilution ||= c.dilution;
      if (c.admitScore > 0 && c.tier) {
        cur.hits += 1;
        if (!cur.best || c.admitScore > cur.best.admitScore) cur.best = c;
      }
    }
  }
  return out;
}

// Admission bar: HARD events at the base threshold, SOFT (sentiment)
// events only when unusually strong.
function passesAdmission(best) {
  if (!best) return false;
  const bar = best.tier === 'HARD' ? CFG.MIN_CATALYST_SCORE : CFG.SOFT_MIN_SCORE;
  return best.admitScore >= bar;
}

// ─── Watchlist entry construction / refresh ──────────────────
function catalystObj(c) {
  return {
    type:     c.label,
    label:    c.label,
    tier:     c.tier,
    score:    +c.admitScore.toFixed(3),
    headline: c.article.headline ?? null,
    source:   c.article.source ?? null,
    url:      c.article.url ?? null,
    at:       c.article.created_at ?? null,
  };
}

function addOrRefresh(symbol, snap, best, hits) {
  const today = etDate();
  const e = watchlist[symbol];

  if (e) {
    e.newsHits += hits;
    if (best.admitScore >= (e.catalyst.score ?? 0)) e.catalyst = catalystObj(best);
    e.lastPrice = snap.price;
    return e;
  }

  watchlist[symbol] = {
    symbol,
    addedAt:        Date.now(),
    firstSeenDate:  today,
    lastDate:       today,
    dayCount:       0,
    firstPrice:     snap.price,     // catalyst-day reference price
    lastPrice:      snap.price,
    highestPrice:   snap.price,
    baselineVolume: snap.volume ?? 0,
    newsHits:       hits,
    status:         'PENDING',
    dilutionFlag:   false,
    catalyst:       catalystObj(best),
    confirmation:   { followThroughPct: 0, heldGains: true, sustained: false, volumeExpansion: 1 },
    history:        [{ date: today, price: snap.price, volume: snap.volume ?? 0 }],
  };
  return watchlist[symbol];
}

// ─── Public: scan the news feed for new catalysts ────────────
export async function scanCatalysts() {
  if (!CFG.ENABLED) return { enabled: false };

  const articles = await fetchNewArticles();
  const empty = { enabled: true, scanned: articles.length, added: [], flagged: [], size: Object.keys(watchlist).length };
  if (!articles.length) return empty;

  const perSymbol = classifyBySymbol(articles);

  // Snapshot ONLY symbols we might act on: admissible candidates, plus
  // already-watched names with fresh dilution news. (v1 snapshotted every
  // ticker mentioned anywhere in the feed — pure quota burn.)
  const candidates = [];
  const flagged    = [];
  for (const [sym, info] of Object.entries(perSymbol)) {
    if (info.dilution && watchlist[sym]) {
      watchlist[sym].dilutionFlag = true;
      watchlist[sym].status       = 'DILUTION_RISK';
      flagged.push(sym);
      continue;
    }
    if (!info.dilution && passesAdmission(info.best)) candidates.push(sym);
  }

  let added = [];
  if (candidates.length) {
    const snaps = await fetchSnapshots(candidates);
    for (const sym of candidates) {
      const snap = snaps[sym];
      if (!snap?.price) continue;
      if (snap.price < PRICE_MIN || snap.price > CFG.PRICE_MAX) continue;   // penny band only
      addOrRefresh(sym, snap, perSymbol[sym].best, perSymbol[sym].hits);
      added.push(sym);
    }
  }

  prune();
  save();
  return { enabled: true, scanned: articles.length, added, flagged, size: Object.keys(watchlist).length };
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
    if (!snap?.price) continue;

    // Tick the day-counter once per ET trading date (weekends don't count).
    if (e.lastDate !== today && !isEtWeekend()) {
      e.dayCount += 1;
      e.lastDate  = today;
      e.history.push({ date: today, price: snap.price, volume: snap.volume ?? 0 });
      if (e.history.length > 30) e.history.shift();
    }

    e.lastPrice    = snap.price;
    e.highestPrice = Math.max(e.highestPrice ?? snap.price, snap.price);

    const followThrough = e.firstPrice > 0 ? (snap.price - e.firstPrice) / e.firstPrice : 0;
    const drawdown      = e.highestPrice > 0 ? (e.highestPrice - snap.price) / e.highestPrice : 0;
    // Volume expansion vs the catalyst-day baseline — the research's
    // "sustained interest" tell. >1 means buyers are still showing up.
    const volumeExpansion = e.baselineVolume > 0
      ? +((snap.volume ?? 0) / e.baselineVolume).toFixed(2)
      : 1;

    e.confirmation = {
      followThroughPct: +(followThrough * 100).toFixed(2),
      heldGains:        snap.price >= e.firstPrice,
      sustained:        snap.price > e.firstPrice && e.dayCount >= 1,
      volumeExpansion,
    };

    // State machine. Dilution is sticky; a deep retrace off the
    // post-catalyst high is the dump phase even if still green vs day 0.
    const ranThenDumped = e.highestPrice > e.firstPrice * 1.15 && drawdown >= CFG.DRAWDOWN_FADE_PCT;
    if (e.dilutionFlag) {
      e.status = 'DILUTION_RISK';
    } else if (followThrough <= -CFG.FADE_DROP_PCT || ranThenDumped) {
      e.status = 'FADING';
    } else if (e.confirmation.sustained && followThrough >= 0.02) {
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
const STATUS_RANK = { CONFIRMED: 3, CONFIRMING: 2, PENDING: 1, FADING: 0, DILUTION_RISK: -1 };

function prune() {
  for (const [sym, e] of Object.entries(watchlist)) {
    const tooOld   = e.dayCount > CFG.WATCHLIST_MAX_DAYS;
    const fadedOut = e.status === 'FADING' && e.dayCount >= 2;
    const diluted  = e.dilutionFlag && e.dayCount >= 1;
    if (tooOld || fadedOut || diluted) delete watchlist[sym];
  }
  // Cap size — keep the strongest / most-confirmed names.
  const syms = Object.keys(watchlist);
  if (syms.length > CFG.MAX_WATCHLIST) {
    syms.sort((a, b) =>
      (STATUS_RANK[watchlist[b].status] ?? 0) - (STATUS_RANK[watchlist[a].status] ?? 0) ||
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
  return Object.values(watchlist)
    .sort((a, b) => (STATUS_RANK[b.status] ?? 0) - (STATUS_RANK[a.status] ?? 0) || b.addedAt - a.addedAt);
}

export function getWatchlistStats() {
  const all = Object.values(watchlist);
  const by  = all.reduce((acc, e) => { acc[e.status] = (acc[e.status] ?? 0) + 1; return acc; }, {});
  return { total: all.length, byStatus: by, enabled: CFG.ENABLED, cursor: newsCursor };
}
