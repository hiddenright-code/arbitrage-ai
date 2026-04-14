// ─────────────────────────────────────────────────────────────
// CONFIG.JS — Single source of truth
// ─────────────────────────────────────────────────────────────

export const SETTINGS = {

  // ── Cross-exchange arb ──────────────────────────────────────
  // Coinbase stays connected for balance display only —
  // its 0.6% fee requires ~0.78% gross spread to break even,
  // which almost never occurs on major pairs.
  EXCHANGES:     ['BinanceUS', 'Kraken', 'Coinbase'],
  ARB_EXCHANGES: ['BinanceUS', 'Kraken'], // Only these two for cross-exchange scanning

  PAIRS: [
    'BTC/USDT', 'ETH/USDT', 'SOL/USDT',
    'DOGE/USDT', 'LTC/USDT', 'XRP/USDT',
    'LINK/USDT', 'AVAX/USDT', 'ADA/USDT',
  ],
  
  // ── Triangular arb (Binance.US only) ───────────────────────
  TRIANGULAR_EXCHANGE: 'BinanceUS',

  // Assets used to auto-generate USDT→A→B→USDT cycles
  TRIANGULAR_ASSETS: [
    'BTC', 'ETH', 'SOL', 'BNB',
    'DOGE', 'LTC', 'XRP', 'LINK',
    'AVAX', 'ADA', 'DOT', 'MATIC',
  ],

  // ── Fees ───────────────────────────────────────────────────
  FEES: {
    BinanceUS: 0.001,   // 0.10%
    Coinbase:  0.006,   // 0.60%
    Kraken:    0.0016,  // 0.16%
  },

  WITHDRAWAL_FEES: {
    BinanceUS: 0.0004,
    Coinbase:  0.001,
    Kraken:    0.0002,
  },

  // ── Thresholds ─────────────────────────────────────────────
  MIN_PROFIT_THRESHOLD:   0.001,  // show cycles within 0.2% of breakeven
  AUTO_EXECUTE_THRESHOLD: 0.003,  // 0.3% net before auto-fire
  MAX_SLIPPAGE_PCT:       0.005,

  // ── Capital ────────────────────────────────────────────────
  CAPITAL_PER_TRADE: 9,

  // ── Scanning ───────────────────────────────────────────────
  SCAN_INTERVAL_MS: 4000,

  // ── Cycle analyzer weights (ML scoring) ────────────────────
  ANALYZER: {
    MIN_HISTORY:       10,   // Min scans before trusting a score
    DECAY_FACTOR:      0.92, // Exponential decay — recent data weighted more
    TOP_CYCLES:        20,   // Top-ranked cycles to prioritize each scan
    VOLATILITY_WINDOW: 30,   // Recent spread window for volatility calc
    SCORE_WEIGHTS: {
      avgSpread:  0.40, // Historical average gross spread
      hitRate:    0.30, // % of scans that crossed profit threshold
      volatility: 0.20, // Spread variance — higher = more opportunity
      recency:    0.10, // How recently this cycle was last profitable
    },
  },
};
