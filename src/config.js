// ─────────────────────────────────────────────────────────────
// CONFIG.JS — Penny Stock Runner Bot Settings
// ─────────────────────────────────────────────────────────────

export const SETTINGS = {

  // ── Broker ───────────────────────────────────────────────────
  BROKER:        'Alpaca',
  PAPER_TRADING: process.env.ALPACA_PAPER !== 'false',  // Paper trade by default

  // ── Penny Stock Universe Filters ─────────────────────────────
  PRICE_MIN:          0.10,       // Minimum price ($)
  PRICE_MAX:          5.00,       // Maximum price — penny stock threshold
  // Minimum daily volume floor. This is an ABSOLUTE pre-filter (RVOL is the
  // real gate downstream). It must be scaled to the data feed: the free IEX
  // feed only prints ~2-3% of consolidated tape, so a SIP-scale 500K floor
  // rejects nearly every real penny runner (a name up +300% can show <150K
  // on IEX). On IEX we drop the floor and lean on RVOL; on SIP we use the
  // full consolidated threshold. See VOLUME_FLOOR getter below.
  MIN_DAILY_VOLUME_SIP: 500_000,  // consolidated-tape floor
  MIN_DAILY_VOLUME_IEX:  20_000,  // IEX-only floor (~2-3% of tape)
  TOP_ACTIVE_STOCKS:  100,        // Scan top N most-active stocks for candidates

  // ── Runner Criteria (all must pass to be a candidate) ────────
  MIN_RVOL:          3.0,         // Relative volume ≥3x avg = unusual activity
  RVOL_STRONG:      10.0,         // ≥10x = explosive (strong conviction)
  MIN_CHANGE_PCT:    5.0,         // Must be up ≥5% today (momentum confirmation)
  STRONG_CHANGE_PCT: 20.0,        // ≥20% = strong runner

  // ── In-Play Registry (don't drop a name the moment it pauses) ─
  // A penny runner is choppy and multi-day: it pops, consolidates, then
  // often puts in a second leg. The plain scorer was dropping clearly-active
  // names (high RVOL, hard-to-borrow, low float) on a weak momentum score.
  // This keeps a name "in play" across scans/days once it shows real volume,
  // and rescues it from a SKIP classification.
  INPLAY: {
    ENABLED:        process.env.INPLAY !== 'false',
    RVOL_INPLAY:    5.0,    // RVOL ≥ this ⇒ in-play regardless of momentum score
    ACTIVE_RVOL:    3.0,    // ≥ this ⇒ status ACTIVE
    COOL_RVOL:      1.5,    // between COOL and ACTIVE (or holding price) ⇒ COOLING
    FADE_PRICE_PCT: 0.70,   // price < 70% of peak AND volume gone ⇒ FADED
    HARD_TO_BORROW_CTB: 50, // cost-to-borrow ≥ this ⇒ keep (shorts pressured)
    LOW_FLOAT:      10_000_000, // float < this + elevated vol ⇒ keep
    MAX_DAYS:       3,      // track up to 3 trading days for a second leg
    MAX_INPLAY:     40,
    PERSIST_PATH:   process.env.INPLAY_PERSIST_PATH || 'data/inplay.json',
  },

  // ── Float Tier Thresholds (shares) ───────────────────────────
  // Smaller float = fewer shares to push price = bigger % moves
  FLOAT_SMALL:  10_000_000,       // <10M   = explosive potential
  FLOAT_MEDIUM: 50_000_000,       // <50M   = good
  FLOAT_LARGE:  200_000_000,      // <200M  = acceptable

  // ── Signal Thresholds ────────────────────────────────────────
  MIN_SIGNAL_SCORE:       0.45,
  AUTO_EXECUTE_THRESHOLD: 0.75,

  // ── Anticipation Tier ("BUILDING" — pre-run setups) ──────────
  // The runner scanner only surfaces stocks already moving (up ≥5% + RVOL
  // ≥3x). This tier surfaces the SETUP *before* ignition: loaded squeeze
  // fuel + a fresh catalyst + a coiling/accumulation base, on names that
  // have NOT yet run. Watch-only by default — it never auto-trades a pre-run
  // setup (pure anticipation fades; confirmation is what you execute on).
  ANTICIPATION: {
    ENABLED:          process.env.ANTICIPATION !== 'false',
    MIN_SETUP_SCORE:  0.40,   // setup strength required to surface as BUILDING
    IGNITION_CEILING: 0.45,   // above this it's already firing → it's a runner, not "building"
    MAX_CHANGE_PCT:   8.0,     // already up more than this ⇒ not "pre-run" anymore
    MAX_BUILDING:     15,      // cap the list
    AUTO_ARM:         process.env.ANTICIPATION_AUTO_ARM === 'true',  // off: watch-only
    // A confirmed/confirming fresh catalyst is itself a pre-run thesis, so a
    // penny name on the watchlist surfaces even if the blended setup is soft.
    CATALYST_OVERRIDE: ['CONFIRMED', 'CONFIRMING'],
    // Setup score weights (re-normalized over available components). Catalyst
    // and loaded fuel are the real anticipation drivers; coil/stir refine.
    WEIGHTS: { fuel: 0.25, catalyst: 0.35, coil: 0.25, stir: 0.15 },
  },

  // ── Trade Sizing ─────────────────────────────────────────────
  CAPITAL_PER_TRADE: 9,           // Default USD per position
  MAX_POSITION_SIZE: 25,          // Hard cap USD per position
  MAX_SLIPPAGE_PCT:  0.03,        // 3% max slippage (penny stocks gap)

  // ── Risk Management ──────────────────────────────────────────
  STOP_LOSS_PCT:            0.08,  // 8% hard stop
  TAKE_PROFIT_PCT:          0.25,  // Primary target: +25%
  TAKE_PROFIT_AGGRESSIVE:   0.50,  // Extended target: +50%
  MAX_HOLD_HOURS:           7,     // Max 7 hours — must exit by close
  MAX_OPEN_POSITIONS:       3,
  MAX_DAILY_LOSS_USD:       25,
  MAX_CONSECUTIVE_LOSSES:   3,
  COOLDOWN_MINUTES:         60,

  // ── Runner Scoring Weights (must sum to 1.0) ─────────────────
  SCORE_WEIGHTS: {
    rvol:      0.35,   // Relative volume — primary runner indicator
    momentum:  0.30,   // % price gain today
    technical: 0.20,   // VWAP position, RSI, range position
    float:     0.15,   // Float size (smaller = higher score)
  },

  // ── Short Interest Data Providers (ORTEX + FINRA) ────────────
  // Real short-interest data dramatically improves squeeze detection.
  // Both are optional — without them the detector falls back to a
  // volume-pattern estimate. Configure via .env (see .env example).
  SHORT_INTEREST: {
    // ORTEX — real-time estimated SI, CTB, utilization, DTC (paid API).
    // Use the trial key ORTEX_API_KEY=TEST to verify wiring for free.
    // The fuel metrics live across FOUR v1 endpoints (matches the
    // official ORTEX SDK); each path template substitutes {exchange}
    // and {ticker} per call. Override only if your tier differs.
    ORTEX_ENABLED:  !!process.env.ORTEX_API_KEY,
    ORTEX_API_KEY:  process.env.ORTEX_API_KEY  || '',
    ORTEX_BASE_URL: process.env.ORTEX_BASE_URL || 'https://api.ortex.com',
    // ORTEX resolves the {exchange} segment as either a market (NASDAQ,
    // NYSE, …) or a 2-char ISO country code. A hardcoded single market
    // breaks any ticker listed elsewhere (e.g. AMC/F/GME are NYSE, so
    // NASDAQ 404s). 'US' lets ORTEX pick the right US listing for any
    // ticker — the correct default for a US penny-stock scanner.
    ORTEX_EXCHANGE: process.env.ORTEX_EXCHANGE || 'US',
    ORTEX_SI_PATH:    process.env.ORTEX_SI_PATH    || '/api/v1/{exchange}/{ticker}/short_interest',
    ORTEX_DTC_PATH:   process.env.ORTEX_DTC_PATH   || '/api/v1/stock/{exchange}/{ticker}/dtc',
    ORTEX_CTB_PATH:   process.env.ORTEX_CTB_PATH   || '/api/v1/stock/{exchange}/{ticker}/ctb/all',
    ORTEX_AVAIL_PATH: process.env.ORTEX_AVAIL_PATH || '/api/v1/stock/{exchange}/{ticker}/availability',

    // FINRA — official consolidated short interest (free, OAuth2, lagged)
    FINRA_ENABLED:       !!(process.env.FINRA_CLIENT_ID && process.env.FINRA_CLIENT_SECRET),
    FINRA_CLIENT_ID:     process.env.FINRA_CLIENT_ID     || '',
    FINRA_CLIENT_SECRET: process.env.FINRA_CLIENT_SECRET || '',
    FINRA_TOKEN_URL:     process.env.FINRA_TOKEN_URL     || 'https://api.finra.org/oauth/v1/token',
    FINRA_BASE_URL:      process.env.FINRA_BASE_URL      || 'https://api.finra.org',
    FINRA_GROUP:         process.env.FINRA_GROUP         || 'otcMarket',
    FINRA_DATASET:       process.env.FINRA_DATASET       || 'consolidatedShortInterest',

    CACHE_TTL_MS:    Number(process.env.SI_CACHE_TTL_MS) || 15 * 60 * 1000, // 15 min
    MAX_CONCURRENCY: 5,    // Parallel SI lookups per scan (rate-limit guard)
  },

  // ── Short Squeeze Scoring (Fuel + Ignition model) ────────────
  // A squeeze needs BOTH a loaded powder keg (short-side fuel) and a
  // lit fuse (price/volume ignition). Each is scored independently,
  // then blended — with a synergy bonus when both are strong.
  SQUEEZE: {
    // FUEL — the short-side setup (from real SI data). Re-normalized
    // over whichever components are available.
    FUEL_WEIGHTS: {
      siPercentFloat: 0.40,  // SI as % of free float — #1 squeeze fuel
      daysToCover:    0.25,  // short-interest ratio (exit difficulty)
      costToBorrow:   0.20,  // borrow-fee pain forcing covers
      utilization:    0.15,  // lendable-share exhaustion (hard-to-borrow)
    },
    // IGNITION — the squeeze firing now (from price/volume)
    IGNITION_WEIGHTS: {
      volumeToFloat: 0.30,
      velocity:      0.30,
      gapUp:         0.20,
      rvol:          0.10,
      consecutive:   0.10,
    },
    FUEL_WEIGHT:     0.55,  // setup weighted slightly higher than trigger
    IGNITION_WEIGHT: 0.45,
    SYNERGY_BONUS:   0.15,  // added when fuel ≥0.6 AND ignition ≥0.6
    SYNERGY_FLOOR:   0.60,  // threshold each side must clear for synergy
    // When no real SI data, fuel is estimated → discount its reliability
    ESTIMATED_FUEL_DISCOUNT: 0.85,
    // Intensity tier cutoffs
    TIERS: { EXTREME: 0.75, HIGH: 0.55, MODERATE: 0.35 },
  },

  // ── Catalyst Watchlist (hybrid model — slow layer) ───────────
  // Proactively scans the market-wide news feed for fresh catalysts on
  // penny-priced names and tracks them over multiple days. A name that
  // "confirms" (holds gains / follows through) feeds the intraday scanner
  // and boosts its signal — so a catalyst is tracked BEFORE it shows the
  // volume the runner scanner keys off. Entries still trigger intraday.
  CATALYST: {
    ENABLED:        process.env.CATALYST_WATCHLIST !== 'false',
    NEWS_FEED_LIMIT: Number(process.env.CATALYST_NEWS_LIMIT) || 50,
    MIN_CATALYST_SCORE: 0.55,   // bullish strength required to add a name
    PRICE_MAX:      Number(process.env.CATALYST_PRICE_MAX) || 10,  // track a bit above $5 to catch pre-run names
    WATCHLIST_MAX_DAYS: 10,     // expire a name after N trading days w/o a run
    MAX_WATCHLIST:  60,
    FADE_DROP_PCT:  0.15,       // >15% below catalyst price ⇒ FADING
    SCAN_INTERVAL_MS: Number(process.env.CATALYST_SCAN_MS) || 10 * 60 * 1000,  // slow layer cadence
    PERSIST_PATH:   process.env.CATALYST_PERSIST_PATH || 'data/watchlist.json',
  },

  // ── Fees ─────────────────────────────────────────────────────
  FEES: { Alpaca: 0.0 },          // Commission-free

  // ── Scanning ─────────────────────────────────────────────────
  SCAN_INTERVAL_MS:     30_000,   // 30s during market hours
  PRE_MARKET_SCAN_MS:  120_000,   // 2 min in pre-market
  CACHE_TTL_MS:    5 * 60 * 1000, // 5 min general cache (bars, slow data)
  // Snapshots must be fresher than the scan cadence — signals priced off
  // a 5-min-old quote on a fast penny mover are worthless.
  SNAPSHOT_TTL_MS: 25_000,
  // Parallel per-symbol history fetches per scan (Alpaca rate-limit guard)
  SCANNER_CONCURRENCY: 8,
  // Reject signals whose bid/ask spread exceeds this fraction of mid —
  // with an 8% stop, an 8%+ spread means the trade loses before it starts.
  MAX_SPREAD_PCT: 0.08,

  // ── Candle History ───────────────────────────────────────────
  DAILY_BARS_LOOKBACK:  30,       // 30 trading days for RVOL avg
  MINUTE_BARS_LOOKBACK: 390,      // Full day in 1-min bars (6.5h × 60)

  // ── Macro Health Tickers ─────────────────────────────────────
  SPY_SYMBOL: 'SPY',
  QQQ_SYMBOL: 'QQQ',

  // ── Market Hours (US Eastern) ────────────────────────────────
  // These are fallbacks only — the live gate prefers Alpaca's /v2/calendar
  // (real trading days + per-day session bounds, so holidays and early
  // closes are handled automatically). Used when that lookup is unavailable.
  MARKET_OPEN:  { hour: 9,  minute: 30 },
  MARKET_CLOSE: { hour: 16, minute: 0  },
  PRE_MARKET:   { hour: 4,  minute: 0  },   // extended-hours open
  AFTER_MARKET: { hour: 20, minute: 0  },   // extended-hours close

  // ── Market-Hours Gate ────────────────────────────────────────
  // When enabled, the scan pipeline (and every Alpaca/ORTEX/FINRA/news
  // call it makes) is skipped while the market is closed — so a real
  // deployment doesn't burn API quota overnight, on weekends, or on
  // holidays. Account/status endpoints stay live regardless.
  //   MARKET_GATE=false        → disable the gate (always scan; useful
  //                              for off-hours testing)
  //   SCAN_EXTENDED_HOURS=false → gate to regular hours only (9:30–16:00);
  //                              default includes pre-market→after-hours,
  //                              where penny runners often gap.
  MARKET_GATE_ENABLED: process.env.MARKET_GATE !== 'false',
  SCAN_EXTENDED_HOURS: process.env.SCAN_EXTENDED_HOURS !== 'false',

  // ── Display ──────────────────────────────────────────────────
  MAX_SIGNALS:       10,   // Top N signals to return
  MAX_RUNNERS:       20,   // Top N runner candidates to track

  // ── Alpaca Data Feed ─────────────────────────────────────────
  // 'iex' = free tier (IEX exchange subset)
  // 'sip' = paid consolidated tape
  DATA_FEED: process.env.ALPACA_FEED || 'iex',
};

// Effective absolute volume floor for the active feed (see the IEX/SIP
// thresholds above). Derived here so every consumer — scanner pre-filter
// and /api/config — sees one feed-correct value.
SETTINGS.MIN_DAILY_VOLUME = SETTINGS.DATA_FEED === 'sip'
  ? SETTINGS.MIN_DAILY_VOLUME_SIP
  : SETTINGS.MIN_DAILY_VOLUME_IEX;
