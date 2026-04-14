// ─────────────────────────────────────────────────────────────
// SERVER.JS — ArbitrageAI + Quant Trading Backend
// ─────────────────────────────────────────────────────────────

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { SETTINGS } from './src/config.js';
import {
  fetchRealPrices, detectOpportunities, scanTriangularCycles,
  getCycleIntelligence, getBalance, testConnection,
} from './src/exchangeClient.js';
import { executeLiveTrade, emergencyStop } from './src/liveExecutor.js';
import { refreshAll, getAllCached, TRACKED_COINS, getCandles1h } from './src/priceHistory.js';
import { detectAllRegimes } from './src/regimeDetector.js';
import { generateSignals } from './src/signalEngine.js';
import {
  executeQuantSignal, managePositions,
  getOpenPositions, getTradeStats,
  openSimPosition, checkSimPositions,
  getSimStats, getSimHistory, getOpenSimPositions,
} from './src/quantExecutor.js';
import { runBacktest } from './src/backtester.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// ─── Warm up candle cache on startup ─────────────────────────
console.log('📡 Loading price history...');
refreshAll().then(() => console.log('✅ Price history loaded'));

// ─── ARBITRAGE ENDPOINTS ──────────────────────────────────────

app.get('/api/prices', async (req, res) => {
  try { res.json(await fetchRealPrices()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/scan', async (req, res) => {
  try {
    const [prices, triOpps] = await Promise.all([fetchRealPrices(), scanTriangularCycles()]);
    const crossOpps = detectOpportunities(prices);
    const all = [...crossOpps, ...triOpps].sort((a, b) => b.netPct - a.netPct);
    res.json({ opportunities: all, crossCount: crossOpps.length, triCount: triOpps.length, scannedAt: Date.now() });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/intelligence', (req, res) => {
  try { res.json(getCycleIntelligence()); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/balances', async (req, res) => {
  const balances = {};
  for (const ex of SETTINGS.EXCHANGES) {
    try { balances[ex] = await getBalance(ex, 'USDT'); }
    catch { balances[ex] = 0; }
  }
  res.json(balances);
});

app.get('/api/status', async (req, res) => {
  const results = {};
  for (const ex of SETTINGS.EXCHANGES) { results[ex] = await testConnection(ex); }
  res.json(results);
});

app.get('/api/config', (req, res) => {
  res.json({
    pairs: SETTINGS.PAIRS, exchanges: SETTINGS.EXCHANGES,
    arbExchanges: SETTINGS.ARB_EXCHANGES,
    triangularExchange: SETTINGS.TRIANGULAR_EXCHANGE,
    minProfitThreshold: SETTINGS.MIN_PROFIT_THRESHOLD,
    autoExecuteThreshold: SETTINGS.AUTO_EXECUTE_THRESHOLD,
    capitalPerTrade: SETTINGS.CAPITAL_PER_TRADE,
    fees: SETTINGS.FEES, scanIntervalMs: SETTINGS.SCAN_INTERVAL_MS,
    trackedCoins: TRACKED_COINS,
  });
});

app.post('/api/execute', async (req, res) => {
  const { opportunity, confirmed } = req.body;
  if (!opportunity) return res.status(400).json({ error: 'No opportunity provided' });
  if (!confirmed)   return res.status(400).json({ error: 'confirmed must be true' });
  try { res.json(await executeLiveTrade(opportunity, true)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── POST /api/emergency-stop ─────────────────────────────────
app.post('/api/emergency-stop', async (req, res) => {
  res.json(await emergencyStop());
});

// ─── GET /api/backtest ────────────────────────────────────────
// Runs full backtest against historical candles already in cache
// Warning: takes 10-30 seconds to complete
app.get('/api/backtest', async (req, res) => {
  try {
    console.log('[Backtest] Request received — running...');
    await refreshAll();
    const candleMap   = getAllCached();
    const candles1hMap = {};
    await Promise.all(
      TRACKED_COINS.map(async (coin) => {
        candles1hMap[coin] = await getCandles1h(`${coin}/USDT`);
      })
    );
    const results = await runBacktest(candleMap, candles1hMap);
    res.json(results);
  } catch (err) {
    console.error('[Backtest error]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── QUANT ENDPOINTS ──────────────────────────────────────────

// GET /api/quant/signals
// Refreshes candles, detects regimes, generates signals for all coins
app.get('/api/quant/signals', async (req, res) => {
  try {
    // Refresh candles (respects 60s cache — won't hammer API)
    await refreshAll();
    const candleMap = getAllCached();

    if (Object.keys(candleMap).length === 0) {
      return res.json({ signals: [], regimes: {}, message: 'Candle data loading...' });
    }

    // Build closed-candle map for signal generation
    const closedCandleMap = {};
    for (const [coin, candles] of Object.entries(candleMap)) {
      closedCandleMap[coin] = candles.slice(0, -1);
    }
    const regimes = detectAllRegimes(closedCandleMap);

    // Fetch 1h candles for pullback entry detection
    const candles1hMap = {};
    await Promise.all(
      TRACKED_COINS.map(async (coin) => {
        candles1hMap[coin] = await getCandles1h(`${coin}/USDT`);
      })
    );

    const signals = generateSignals(closedCandleMap, regimes, candles1hMap);

    // Check/manage real positions
    const closedPositions = await managePositions(candleMap);

    // Check sim positions against live candle data
    const closedSimPositions = checkSimPositions(candleMap);

    // Open sim positions for new BUY signals above threshold
    const newSimPositions = [];
    for (const signal of signals) {
      if (
        signal.type === 'BUY' &&
        signal.confidence >= 0.45 &&
        signal.strategy !== 'pairs_trading' &&
        signal.takeProfit &&
        signal.stopLoss
      ) {
        const simPos = openSimPosition(signal);
        if (simPos) newSimPositions.push(simPos);
      }
    }

    res.json({
      signals,
      regimes,
      closedPositions,
      openPositions:      getOpenPositions(),
      stats:              getTradeStats(),
      // Sim tracking
      closedSimPositions,
      newSimPositions,
      openSimPositions:   getOpenSimPositions(),
      simStats:           getSimStats(),
      scannedAt:          Date.now(),
      coinsScanned:       Object.keys(candleMap).length,
    });
  } catch (err) {
    console.error('[Quant signals error]', err);
    res.status(500).json({ error: err.message });
  }
});

// ─── GET /api/quant/positions ─────────────────────────────────
app.get('/api/quant/positions', (req, res) => {
  res.json({
    positions:    getOpenPositions(),
    stats:        getTradeStats(),
    simPositions: getOpenSimPositions(),
    simStats:     getSimStats(),
  });
});

// ─── GET /api/quant/sim ───────────────────────────────────────
app.get('/api/quant/sim', (req, res) => {
  res.json({
    history:  getSimHistory(),
    stats:    getSimStats(),
    open:     getOpenSimPositions(),
  });
});

// POST /api/quant/execute
// Execute a specific quant signal
app.post('/api/quant/execute', async (req, res) => {
  const { signal, confirmed } = req.body;
  if (!signal)    return res.status(400).json({ error: 'No signal provided' });
  if (!confirmed) return res.status(400).json({ error: 'confirmed must be true' });
  try {
    const result = await executeQuantSignal(signal, true);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── Start ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`\n🚀 ArbitrageAI server on http://localhost:${PORT}`);
  console.log(`   Arb:   ${SETTINGS.ARB_EXCHANGES.join(' ↔ ')} | ${SETTINGS.PAIRS.length} pairs`);
  console.log(`   Quant: ${TRACKED_COINS.join(', ')}`);
  console.log(`   Min profit: ${SETTINGS.MIN_PROFIT_THRESHOLD * 100}%\n`);
});
