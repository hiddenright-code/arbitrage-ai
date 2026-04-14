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

## Backtest Results
- 48.6% win rate across 74 trades
- Profit Factor: 1.513
- Sharpe Ratio: 5.33
- 73.9% win rate on high-confidence signals (0.75+)

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