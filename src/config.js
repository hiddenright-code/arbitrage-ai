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
  MIN_DAILY_VOLUME:   500_000,    // 500K min shares/day (avoids illiquid traps)
  TOP_ACTIVE_STOCKS:  100,        // Scan top N most-active stocks for candidates

  // ── Runner Criteria (all must pass to be a candidate) ────────
  MIN_RVOL:          3.0,         // Relative volume ≥3x avg = unusual activity
  RVOL_STRONG:      10.0,         // ≥10x = explosive (strong conviction)
  MIN_CHANGE_PCT:    5.0,         // Must be up ≥5% today (momentum confirmation)
  STRONG_CHANGE_PCT: 20.0,        // ≥20% = strong runner

  // ── Float Tier Thresholds (shares) ───────────────────────────
  // Smaller float = fewer shares to push price = bigger % moves
  FLOAT_SMALL:  10_000_000,       // <10M   = explosive potential
  FLOAT_MEDIUM: 50_000_000,       // <50M   = good
  FLOAT_LARGE:  200_000_000,      // <200M  = acceptable

  // ── Signal Thresholds ────────────────────────────────────────
  MIN_SIGNAL_SCORE:       0.45,
  AUTO_EXECUTE_THRESHOLD: 0.75,

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
    ORTEX_EXCHANGE: process.env.ORTEX_EXCHANGE || 'NASDAQ',
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

  // ── Fees ─────────────────────────────────────────────────────
  FEES: { Alpaca: 0.0 },          // Commission-free

  // ── Scanning ─────────────────────────────────────────────────
  SCAN_INTERVAL_MS:     30_000,   // 30s during market hours
  PRE_MARKET_SCAN_MS:  120_000,   // 2 min in pre-market
  CACHE_TTL_MS:    5 * 60 * 1000, // 5 min general cache

  // ── Candle History ───────────────────────────────────────────
  DAILY_BARS_LOOKBACK:  30,       // 30 trading days for RVOL avg
  MINUTE_BARS_LOOKBACK: 390,      // Full day in 1-min bars (6.5h × 60)

  // ── Macro Health Tickers ─────────────────────────────────────
  SPY_SYMBOL: 'SPY',
  QQQ_SYMBOL: 'QQQ',

  // ── Market Hours (US Eastern) ────────────────────────────────
  MARKET_OPEN:  { hour: 9,  minute: 30 },
  MARKET_CLOSE: { hour: 16, minute: 0  },
  PRE_MARKET:   { hour: 4,  minute: 0  },

  // ── Display ──────────────────────────────────────────────────
  MAX_SIGNALS:       10,   // Top N signals to return
  MAX_RUNNERS:       20,   // Top N runner candidates to track

  // ── Alpaca Data Feed ─────────────────────────────────────────
  // 'iex' = free tier (IEX exchange subset)
  // 'sip' = paid consolidated tape
  DATA_FEED: process.env.ALPACA_FEED || 'iex',
};
