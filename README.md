# ArbitrageAI — Algorithmic Crypto Trading System

A full-stack quantitative trading platform integrating real-time 
market data from Binance.US, Kraken, and Coinbase with a 
regime-aware signal engine, custom backtesting framework, and 
live simulation tracking.

## Strategies
- Cross-exchange arbitrage (BinanceUS ↔ Kraken)
- Triangular arbitrage with ML cycle scoring
- Mean reversion quant trading with market regime detection

## Tech Stack
- Node.js / Express backend
- React / Vite frontend
- Tailwind CSS
- CCXT exchange library
- Custom technical indicators (RSI, Bollinger Bands, MACD, ATR, ADX)

## Key Features
- Adaptive market regime detection (Trending/Ranging/Volatile)
- Kelly Criterion position sizing
- Walk-forward backtesting with ablation testing
- Live simulation tracking for strategy validation
- Real-time dashboard with 8 analytical tabs

## Dashboard

Eight-tab React dashboard for monitoring and control.

| Tab | Purpose |
|---|---|
| Sim Results | Live simulation tracking — win rate, PnL, exit reasons, open positions |
| Quant | Regime grid per coin, actionable signals with indicator breakdown |
| Arb | Cross-exchange opportunities (BinanceUS ↔ Kraken) |
| Triangular | Triangular arb with ML cycle rankings |
| Intelligence | Hourly activity chart, top cycle leaderboard |
| Backtest | Full backtest with confidence analysis, ablation tests, coin breakdown |
| Trades | Completed real and simulated trades |
| Log | Event log with change-detection (no spam on repeated signals) |

---

## Strategies Implemented

### 1. Cross-Exchange Arbitrage
Scans the same trading pair across Binance.US and Kraken simultaneously, detecting price differences large enough to profit from after fees. Coinbase excluded from arb detection — its 0.6% taker fee requires a 0.78% gross spread to break even, which is rarely achievable on major pairs.

**Net profit formula:**
```
grossProfit = (sellPrice - buyPrice) / buyPrice
totalFees = buyFee + sellFee + withdrawalFee
netProfit = grossProfit - totalFees
```

### 2. Triangular Arbitrage (Binance.US)
Auto-generates all valid `USDT → A → B → USDT` cycles from 12 configured assets (28 cycles on Binance.US). Profits from price mismatches between three trading pairs on the same exchange — no inter-exchange transfer delays.

**Cycle math:**
```
unitsA  = 1 / leg1.ask
unitsB  = unitsA / leg2.ask  (forward) or unitsA × leg2.bid (reverse)
endUSDT = unitsB × leg3.bid
netProfit = (endUSDT - 1) - (fee × 3)
```

**ML Cycle Scoring Engine:**
```
score = (avgSpread × 0.40) + (hitRate × 0.30) +
        (volatility × 0.20) + (recency × 0.10)
```
Uses exponential weighted moving average (decay 0.92) to prioritize recently profitable cycles, with hourly activity tracking to identify optimal trading windows.

### 3. Quantitative Mean Reversion
Regime-aware strategy operating on 500 × 4h candles (~83 days of historical data). Detects when a coin has moved too far from its statistical mean and is likely to revert — completely independent of execution latency.

---

## Backtesting Framework

Custom walk-forward backtester (`src/backtester.js`) with realistic simulation.

**Methodology:**
- Slides forward candle by candle through 500 historical candles
- Entries at next candle open (no same-candle fills)
- TP/SL checked against candle high/low (not just close)
- 0.2% round-trip fee deducted from every trade
- Proper Sharpe annualization by actual trade frequency

**Metrics:**
- Win rate, PnL, profit factor, Sharpe ratio, max drawdown
- Performance by coin, strategy, regime, and confidence bucket
- Exit reason breakdown (TP vs SL vs time exit)
- Ablation testing — removes one component at a time to measure impact
- V3 preview — tests selective parameters alongside full system

---

## Setup
1. Clone the repo
2. Run `npm install`
3. Add your exchange API keys to `.env` (see `.env.example`)
4. Terminal 1: `node server.js`
5. Terminal 2: `npm run frontend`
6. Open `http://localhost:5173`

## Disclaimer
This is a research and educational project. 
Not financial advice. Trade at your own risk.


