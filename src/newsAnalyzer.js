// ─────────────────────────────────────────────────────────────
// NEWSANALYZER.JS — News catalyst detection via Alpaca News API
//
// Fetches recent news for a symbol, scores sentiment, and
// classifies the catalyst type. Catalyst presence and quality
// significantly boost (or suppress) signal confidence.
//
// Catalyst Quality Score (0-1):
//   Strong bullish:  FDA approval, buyout, earnings beat → 0.80-1.00
//   Moderate bullish: contract, partnership, trial success → 0.55-0.75
//   Weak bullish:    analyst upgrade, CEO buy → 0.30-0.50
//   Neutral:         no relevant news → 0.0
//   Bearish:         SEC probe, dilution, miss → negative modifier
//
// Recency decay: news older than 48h contributes less weight
// ─────────────────────────────────────────────────────────────

import dotenv from 'dotenv';
dotenv.config();

const DATA_URL = 'https://data.alpaca.markets';

const alpacaHeaders = {
  'APCA-API-KEY-ID':     process.env.ALPACA_API_KEY    ?? '',
  'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY ?? '',
};

// Cache: symbol → { articles, lastFetch, score }
const newsCache = {};
const CACHE_TTL = 10 * 60 * 1000;  // 10 min — news doesn't change that fast

// ─── Keyword libraries ────────────────────────────────────────

// Each entry: [regex, score (0-1), catalyst label]
const BULLISH_KEYWORDS = [
  // Regulatory / clinical wins — highest impact
  [/FDA (approves?|approval|cleared?|grants?)/i,    0.95, 'FDA Approval'],
  [/clinical trial (success|positive|met|results)/i, 0.90, 'Clinical Trial Success'],
  [/phase (2|3|iii|ii) (results|success|positive)/i, 0.88, 'Phase Trial Success'],
  [/breakthrough (therapy|designation)/i,             0.90, 'Breakthrough Designation'],
  // M&A / corporate events
  [/acqui(red|sition|iring)|buyout|merger/i,         0.92, 'M&A / Buyout'],
  [/tender offer|going private/i,                     0.88, 'Tender Offer'],
  // Earnings / revenue
  [/beat(s)? (expectation|estimate|consensus)/i,     0.82, 'Earnings Beat'],
  [/record (revenue|earnings|profit|sales)/i,        0.80, 'Record Earnings'],
  [/raised? (guidance|outlook)/i,                     0.75, 'Raised Guidance'],
  [/exceed(s|ed)? (expectation|estimate)/i,           0.75, 'Beat Estimates'],
  // Contracts / deals
  [/government contract|defense contract|DOD/i,      0.85, 'Government Contract'],
  [/(major|strategic)? (partnership|collaboration|agreement)/i, 0.70, 'Partnership'],
  [/signed? (contract|deal|agreement) with/i,        0.68, 'Contract Win'],
  // Short squeeze catalysts
  [/short squeeze|heavily shorted|short interest/i,  0.72, 'Short Squeeze Catalyst'],
  [/meme stock|reddit|wsb|wallstreetbets/i,           0.65, 'Retail Momentum'],
  // Insider / analyst
  [/insider (buying|bought|purchase)/i,               0.60, 'Insider Buy'],
  [/upgrade(d)? (to )?(buy|outperform|strong buy)/i, 0.58, 'Analyst Upgrade'],
  [/price target (raised?|increased?|lifted?)/i,      0.55, 'PT Raise'],
  // Capital / listing
  [/nasdaq uplisting|nyse uplisting/i,                0.78, 'Exchange Uplisting'],
  [/share buyback|stock repurchase/i,                 0.55, 'Buyback'],
  // Products / pipeline
  [/launch(ed|es|ing)? (product|treatment|drug|device)/i, 0.65, 'Product Launch'],
  [/patent (grant(ed)?|approved?)/i,                  0.62, 'Patent Grant'],
];

const BEARISH_KEYWORDS = [
  [/SEC (investigation|charges?|subpoena|probe)/i,   -0.85, 'SEC Action'],
  [/fraud|accounting irregulari|misappropriat/i,     -0.90, 'Fraud'],
  [/bankrupt(cy)?|chapter 11|chapter 7/i,            -0.95, 'Bankruptcy'],
  [/dilut(ion|ive)|offering price|public offering|ATM offering/i, -0.70, 'Dilution'],
  [/miss(ed)? (estimate|expectation|consensus)/i,    -0.65, 'Earnings Miss'],
  [/lower(ed)? guidance|lowered? outlook/i,          -0.60, 'Lowered Guidance'],
  [/downgrade(d)? (to )?(sell|underperform|hold)/i, -0.55, 'Analyst Downgrade'],
  [/class action|lawsuit|litigation/i,               -0.55, 'Lawsuit'],
  [/delist(ing)?|compliance notice/i,                -0.75, 'Delisting Risk'],
  [/reverse stock split/i,                            -0.60, 'Reverse Split'],
];

// ─── Score a single article ───────────────────────────────────
// Exported so the catalyst watchlist can reuse the exact same keyword
// scoring on the market-wide news feed.
export function scoreArticle(article) {
  const text      = `${article.headline ?? ''} ${article.summary ?? ''}`.toLowerCase();
  const createdAt = new Date(article.created_at).getTime();
  const ageHours  = (Date.now() - createdAt) / 3_600_000;

  // Recency decay: full weight up to 2h, then fades
  let recencyMult;
  if (ageHours < 2)   recencyMult = 1.00;
  else if (ageHours < 6)  recencyMult = 0.85;
  else if (ageHours < 24) recencyMult = 0.65;
  else if (ageHours < 48) recencyMult = 0.40;
  else                    recencyMult = 0.15;

  const catalysts = [];
  let bullScore   = 0;
  let bearScore   = 0;

  for (const [regex, score, label] of BULLISH_KEYWORDS) {
    if (regex.test(text)) {
      bullScore = Math.max(bullScore, score);
      catalysts.push({ label, score: +(score * recencyMult).toFixed(3), bullish: true });
    }
  }
  for (const [regex, score, label] of BEARISH_KEYWORDS) {
    if (regex.test(text)) {
      bearScore = Math.max(bearScore, Math.abs(score));
      catalysts.push({ label, score: +(score * recencyMult).toFixed(3), bullish: false });
    }
  }

  const netScore = (bullScore - bearScore) * recencyMult;

  return {
    headline:   article.headline,
    url:        article.url,
    source:     article.source,
    ageHours:   +ageHours.toFixed(1),
    catalysts,
    bullScore:  +bullScore.toFixed(3),
    bearScore:  +(bearScore).toFixed(3),
    netScore:   +netScore.toFixed(3),
    recencyMult,
  };
}

// ─── Fetch and analyze news for a symbol ─────────────────────
export async function analyzeNews(symbol) {
  const now    = Date.now();
  const cached = newsCache[symbol];
  if (cached && now - cached.lastFetch < CACHE_TTL) return cached.result;

  try {
    const url = `${DATA_URL}/v2/news?symbols=${symbol}&limit=10&sort=desc&feed=iex`;
    const res = await fetch(url, { headers: alpacaHeaders });
    if (!res.ok) throw new Error(`${res.status}`);

    const data     = await res.json();
    const articles = data.news ?? [];

    if (!articles.length) {
      const result = { symbol, catalystScore: 0, catalysts: [], articles: [], hasCatalyst: false };
      newsCache[symbol] = { lastFetch: now, result };
      return result;
    }

    // Score each article, take best bullish + worst bearish
    const scored     = articles.map(scoreArticle);
    const bestBull   = Math.max(...scored.map(a => a.bullScore * a.recencyMult), 0);
    const worstBear  = Math.max(...scored.map(a => a.bearScore * a.recencyMult), 0);
    const catalysts  = scored.flatMap(a => a.catalysts);
    const netScore   = +(bestBull - worstBear).toFixed(3);

    const result = {
      symbol,
      catalystScore: netScore,
      hasCatalyst:   netScore > 0.30,
      isBearish:     netScore < -0.30,
      catalysts:     [...new Map(catalysts.map(c => [c.label, c])).values()],
      topHeadline:   scored[0]?.headline ?? null,
      topSource:     scored[0]?.source   ?? null,
      topAgeHours:   scored[0]?.ageHours ?? null,
      articles:      scored.slice(0, 5),
    };

    newsCache[symbol] = { lastFetch: now, result };
    return result;
  } catch (err) {
    console.error(`[News] ${symbol}: ${err.message}`);
    const result = { symbol, catalystScore: 0, catalysts: [], articles: [], hasCatalyst: false };
    newsCache[symbol] = { lastFetch: now, result };
    return result;
  }
}

// ─── Batch news for multiple symbols ─────────────────────────
export async function analyzeNewsMulti(symbols) {
  const results = await Promise.all(symbols.map(analyzeNews));
  const map     = {};
  for (const r of results) map[r.symbol] = r;
  return map;
}
