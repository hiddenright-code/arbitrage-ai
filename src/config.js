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
