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

A state-of-the-art **Fuel + Ignition** model. A squeeze needs *both* a
loaded powder keg (a large trapped short position) and a lit fuse (price/
volume firing). Each side is scored independently, blended, then given a
**synergy bonus** when both are strong at once — the real edge.

### Fuel — the short-side setup (from REAL short-interest data)
Pulled live from **ORTEX** and **FINRA** (see below):
- **SI % of free float** (40%) — the #1 squeeze metric. >20% high, >40% extreme.
- **Days to Cover** (25%) — short interest ÷ avg daily volume. >5 = hard to exit.
- **Cost to Borrow** (20%) — annualized borrow fee. High/rising = shorts bleeding.
- **Utilization** (15%) — % of lendable shares lent. ~100% = hard-to-borrow.
- **SI trend** modifier — shorts *adding* into a rising price = most trapped.

### Ignition — the squeeze firing now (from price/volume)
- Volume-to-float, intraday velocity, gap-up, RVOL, consecutive up-days.

Final score blends fuel (55%) and ignition (45%), +15% synergy bonus when
both clear 0.60. Output includes a **squeeze type** tag
(`HARD_TO_BORROW`, `HIGH_SHORT_INTEREST`, `HIGH_DAYS_TO_COVER`,
`MOMENTUM_ONLY`, `LOADED_NOT_FIRING`, `DEVELOPING`) and intensity tiers
`LOW → MODERATE → HIGH → EXTREME`.

If neither data provider is configured, fuel is **estimated** from volume
patterns and flagged as lower-confidence — the bot still runs, just blind
to the short side.

### Real data sources (`shortInterestData.js`)
| Provider | What it gives | Notes |
|---|---|---|
| **ORTEX** | SI%, DTC, cost-to-borrow, utilization, SI trend | Real-time estimates, paid API. The squeeze edge. |
| **FINRA** | Official settled shares-short, DTC, avg volume | Free, OAuth2, published twice/month (~8-day lag). Ground-truth anchor. |

ORTEX is primary for live fields; FINRA fills gaps and validates. Data is
merged into one shape, cached 15 min, and fails soft to the estimate.
Endpoints and auth are env-configurable (see `.env example`).

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
