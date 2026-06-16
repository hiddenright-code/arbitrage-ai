# 🏃 Penny Stock Runner Bot

An algorithmic day-trading scanner that hunts the best penny-stock
**runners** — low-priced, high-volume momentum stocks — and ranks them
for profitability using a multi-factor scoring engine with baked-in
**short-squeeze detection** and **news-catalyst analysis**.

Powered by [Alpaca](https://alpaca.markets) for both market data and
commission-free order execution. **Paper trading by default.**

> ⚠️ Penny stocks are extremely volatile and risky. This is a research
> and educational project. Not financial advice. Trade at your own risk.

---

## The Runner Algorithm

Every scan runs a 5-stage pipeline:

### 1. Discover
Pull Alpaca's top 100 most-active stocks, then filter the universe to
genuine penny-stock candidates:
- Price **$0.10 – $5.00**
- Volume **≥ 500K shares** today (avoids illiquid traps)

### 2. Filter (both must pass)
- **RVOL ≥ 3×** — trading at 3× its own 20-day average volume (unusual activity)
- **Up ≥ 5%** today — confirmed momentum, not a falling knife

### 3. Score (0–1.0, weighted)

| Factor | Weight | What it measures |
|---|---|---|
| **RVOL** | 35% | Relative volume — the #1 runner indicator |
| **Momentum** | 30% | % price gain today |
| **Technical** | 20% | VWAP position, RSI health, range position, MACD |
| **Float** | 15% | Smaller float = bigger moves per dollar of buying |

### 4. Enrich — Short Squeeze + News
Each candidate is run through the squeeze detector and news analyzer
(see below), which boost or suppress final signal confidence.

### 5. Classify & Gate
- **≥ 0.70 → STRONG_BUY** (auto-execute eligible)
- **≥ 0.55 → BUY**
- **≥ 0.40 → WATCH**

A broad-market **risk gate** (SPY/QQQ health) suppresses new entries
during market-wide selloffs, when small caps get hit hardest.

---

## 🩳 Short Squeeze Detection (`shortSqueezeDetector.js`)

A weighted squeeze-pressure score (0–1) built from five components:

1. **Volume-to-Float ratio** (30%) — if today's volume exceeds the float,
   every short had to trade against massive buy pressure — classic squeeze.
2. **Intraday velocity** (25%) — parabolic moves off the day's low =
   shorts being squeezed in real time.
3. **Estimated Days-to-Cover** (20%) — surging volume against a trapped
   short base. *(Estimated from volume patterns; connect ORTEX/FINRA for
   real short-interest data.)*
4. **Gap-up analysis** (15%) — gap-up opens trap overnight shorts.
5. **Consecutive up-days** (10%) — multi-day runners trap progressively
   more shorts.

Intensity tiers: `LOW → MODERATE → HIGH → EXTREME`. A `short_squeeze`
signal targets aggressive profit levels because squeezes can run hard.

---

## 📰 News Catalyst Analysis (`newsAnalyzer.js`)

Pulls recent headlines from the Alpaca News API and scores them against
keyword libraries with **recency decay** (fresh news weighted higher):

- **Bullish catalysts:** FDA approvals, clinical-trial wins, M&A/buyouts,
  earnings beats, government contracts, uplistings, short-squeeze chatter, …
- **Bearish flags:** SEC probes, dilution/offerings, bankruptcy, delisting,
  reverse splits, earnings misses — these **suppress** or veto signals.

A strong catalyst multiplies signal confidence (e.g. squeeze + catalyst
is an especially powerful combination) and can trigger a standalone
`news_catalyst` signal.

---

## Signal Strategies (`signalEngine.js`)

| Strategy | Trigger |
|---|---|
| `volume_surge` | Core setup — RVOL + momentum + technical confirmation |
| `short_squeeze` | Squeeze pressure ≥ MODERATE (volume/float + velocity) |
| `vwap_reclaim` | Price reclaims VWAP on a volume spike after a dip |
| `opening_range_breakout` | Breaks above the first-15-min high (ORB) |
| `news_catalyst` | Strong catalyst with price follow-through |

Each signal ships with an entry, **stop-loss**, and **take-profit** (plus
an aggressive extended target). Every real order is placed as an Alpaca
**bracket order** so exits are pre-set the instant the entry fills.

---

## Risk Management (`quantExecutor.js`)

- Bracket orders (entry + TP + SL atomically)
- Confidence-scaled position sizing, with a Kelly overlay after 30 trades
- Hard caps: max position size, max open positions, daily-loss limit
- Consecutive-loss cooldown + per-symbol cooldown after a stop-out
- Max-hold time exit (must be flat before close)
- 🛑 Emergency stop — cancels all orders and liquidates everything

---

## Tech Stack
- Node.js / Express backend
- React / Vite frontend, Tailwind CSS
- Alpaca Trading API v2 + Market Data API v2 (REST, no SDK dependency)
- Custom technical indicators (RSI, Bollinger Bands, MACD, ATR, VWAP, ADX)

---

## Dashboard

| Tab | Purpose |
|---|---|
| 🎯 Signals | Ranked actionable signals with squeeze/news/TP-SL detail |
| 🏃 Runners | All scored runner candidates with factor breakdown bars |
| 📋 Sim | Live simulation tracking — win rate, PnL, per-strategy stats |
| Trades | Executed and simulated trades |
| Log | Event log |
| Config | Active settings and thresholds |

---

## Setup

1. Clone the repo and run `npm install`
2. Create a free Alpaca account → generate **paper trading** API keys
3. Copy `.env example` to `.env` and add your keys:
   ```
   ALPACA_API_KEY=...
   ALPACA_SECRET_KEY=...
   ALPACA_PAPER=true
   ALPACA_FEED=iex
   ```
4. Verify the connection: `npm run test-connection`
5. Terminal 1: `npm run backend`
6. Terminal 2: `npm run frontend`
7. Open `http://localhost:5173`

The bot starts in **Simulation** mode. Real trading requires explicitly
enabling Real Money mode in the UI **and** setting `ALPACA_PAPER=false`.

## Disclaimer
This is a research and educational project. Penny stocks carry a high risk
of total loss. Not financial advice. Trade at your own risk.
