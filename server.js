// ─────────────────────────────────────────────────────────────
// SERVER.JS — Penny Stock Runner Bot Backend
//
// Pipeline (per scan):
//   1. Scan most-active stocks → filter to penny runners (RVOL + momentum)
//   2. Enrich each runner with news catalysts + short-squeeze pressure
//   3. Assess broad market health (SPY/QQQ risk gate)
//   4. Generate ranked BUY signals
//   5. Track simulated positions to validate strategy live
// ─────────────────────────────────────────────────────────────

import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { SETTINGS } from './src/config.js';
import {
  getAccount, getPositions, getBuyingPower,
  testConnection, getMarketClock, getBrokerInfo,
} from './src/exchangeClient.js';
import { executeLiveTrade, emergencyStop } from './src/liveExecutor.js';
import { scanRunners } from './src/pennyStockScanner.js';
import { analyzeNewsMulti } from './src/newsAnalyzer.js';
import { detectSqueezeSetup } from './src/shortSqueezeDetector.js';
import { assessMarketHealth } from './src/regimeDetector.js';
import { generateSignals } from './src/signalEngine.js';
import { fetchSnapshots, fetchDailyBars, fetchMinuteBars } from './src/priceHistory.js';
import {
  executeQuantSignal, managePositions,
  getOpenPositions, getTradeStats,
  openSimPosition, checkSimPositions,
  getSimStats, getSimHistory, getOpenSimPositions,
} from './src/quantExecutor.js';

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// In-memory cache of the latest full scan (so multiple dashboard
// tabs don't each trigger a fresh scan)
let lastScan = { runners: [], signals: [], marketHealth: null, scannedAt: 0 };
const SCAN_CACHE_MS = 15_000;

// ─── Core scan pipeline ───────────────────────────────────────
async function runScanPipeline() {
  // 1. Discover + score runners
  const runners = await scanRunners();

  if (!runners.length) {
    return { runners: [], signals: [], marketHealth: null, scannedAt: Date.now() };
  }

  const symbols = runners.map(r => r.symbol);

  // 2. Enrich: news + squeeze + intraday bars (in parallel)
  const [newsMap, indexSnaps] = await Promise.all([
    analyzeNewsMulti(symbols),
    fetchSnapshots([SETTINGS.SPY_SYMBOL, SETTINGS.QQQ_SYMBOL]),
  ]);

  const squeezeMap    = {};
  const minuteBarsMap = {};
  await Promise.all(
    runners.map(async (r) => {
      const dailyBars = await fetchDailyBars(r.symbol, 30);
      squeezeMap[r.symbol]    = detectSqueezeSetup(r.snapshot, dailyBars);
      minuteBarsMap[r.symbol] = await fetchMinuteBars(r.symbol, 120);
    })
  );

  // 3. Market health gate
  const marketHealth = assessMarketHealth(indexSnaps);

  // 4. Generate signals
  let signals = generateSignals(runners, newsMap, squeezeMap, minuteBarsMap);

  // Apply market-health gate
  if (marketHealth && !marketHealth.allowEntries) {
    signals = signals.map(s => ({ ...s, gated: true, gateReason: marketHealth.reason }));
  } else if (marketHealth?.requireHighConviction) {
    signals = signals.map(s =>
      s.confidence < 0.70 ? { ...s, gated: true, gateReason: 'Soft tape — high-conviction only' } : s
    );
  }

  // Attach enrichment to runners for dashboard display
  const enrichedRunners = runners.map(r => ({
    ...r,
    news:    newsMap[r.symbol]    ?? null,
    squeeze: squeezeMap[r.symbol] ?? null,
  }));

  return { runners: enrichedRunners, signals, marketHealth, newsMap, squeezeMap, scannedAt: Date.now() };
}

async function getScan(force = false) {
  if (!force && Date.now() - lastScan.scannedAt < SCAN_CACHE_MS) return lastScan;
  lastScan = await runScanPipeline();
  return lastScan;
}

// ─── RUNNER / SIGNAL ENDPOINTS ────────────────────────────────

// GET /api/scan — full runner scan with signals
app.get('/api/scan', async (req, res) => {
  try {
    const scan = await getScan(req.query.force === 'true');

    // Track sim positions on the freshly-scanned snapshots
    const snapshotMap = {};
    for (const r of scan.runners) snapshotMap[r.symbol] = r.snapshot;

    const closedSim = checkSimPositions(snapshotMap);
    const newSim    = [];
    for (const signal of scan.signals) {
      if (signal.type === 'BUY' && signal.confidence >= SETTINGS.MIN_SIGNAL_SCORE && !signal.gated) {
        const pos = openSimPosition(signal);
        if (pos) newSim.push(pos);
      }
    }

    res.json({
      runners:      scan.runners,
      signals:      scan.signals,
      marketHealth: scan.marketHealth,
      strongBuys:   scan.signals.filter(s => s.tier === 'HIGH').length,
      closedSimPositions: closedSim,
      newSimPositions:    newSim,
      openSimPositions:   getOpenSimPositions(),
      simStats:           getSimStats(),
      runnerCount:  scan.runners.length,
      signalCount:  scan.signals.length,
      scannedAt:    scan.scannedAt,
    });
  } catch (err) {
    console.error('[Scan error]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/runners — just the ranked runner list
app.get('/api/runners', async (req, res) => {
  try {
    const scan = await getScan();
    res.json({ runners: scan.runners, count: scan.runners.length, scannedAt: scan.scannedAt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/signals — ranked actionable signals
app.get('/api/signals', async (req, res) => {
  try {
    const scan = await getScan();

    // Manage real positions + sim tracking
    const snapshotMap = {};
    for (const r of scan.runners) snapshotMap[r.symbol] = r.snapshot;
    const closedPositions    = await managePositions(snapshotMap);
    const closedSimPositions = checkSimPositions(snapshotMap);

    const newSimPositions = [];
    for (const signal of scan.signals) {
      if (signal.type === 'BUY' && signal.confidence >= SETTINGS.MIN_SIGNAL_SCORE && !signal.gated) {
        const pos = openSimPosition(signal);
        if (pos) newSimPositions.push(pos);
      }
    }

    res.json({
      signals:            scan.signals,
      marketHealth:       scan.marketHealth,
      closedPositions,
      openPositions:      getOpenPositions(),
      stats:              getTradeStats(),
      closedSimPositions,
      newSimPositions,
      openSimPositions:   getOpenSimPositions(),
      simStats:           getSimStats(),
      scannedAt:          scan.scannedAt,
    });
  } catch (err) {
    console.error('[Signals error]', err);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/news/:symbol — detailed news for one symbol
app.get('/api/news/:symbol', async (req, res) => {
  try {
    const { analyzeNews } = await import('./src/newsAnalyzer.js');
    res.json(await analyzeNews(req.params.symbol.toUpperCase()));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ─── ACCOUNT / BROKER ENDPOINTS ───────────────────────────────

app.get('/api/account', async (req, res) => {
  try {
    const account = await getAccount();
    res.json(account ?? { error: 'No account' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/positions', async (req, res) => {
  try {
    res.json({
      broker:       await getPositions(),
      tracked:      getOpenPositions(),
      stats:        getTradeStats(),
      simPositions: getOpenSimPositions(),
      simStats:     getSimStats(),
    });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/balances', async (req, res) => {
  try {
    const account = await getAccount();
    res.json({
      Alpaca: account ? parseFloat(account.cash) : 0,
      buyingPower:    account ? parseFloat(account.buying_power) : 0,
      portfolioValue: account ? parseFloat(account.portfolio_value) : 0,
    });
  } catch { res.json({ Alpaca: 0 }); }
});

app.get('/api/status', async (req, res) => {
  res.json({ Alpaca: await testConnection() });
});

app.get('/api/clock', async (req, res) => {
  res.json(await getMarketClock());
});

app.get('/api/config', (req, res) => {
  res.json({
    broker:            getBrokerInfo(),
    priceRange:        [SETTINGS.PRICE_MIN, SETTINGS.PRICE_MAX],
    minRvol:           SETTINGS.MIN_RVOL,
    minChangePct:      SETTINGS.MIN_CHANGE_PCT,
    minDailyVolume:    SETTINGS.MIN_DAILY_VOLUME,
    scoreWeights:      SETTINGS.SCORE_WEIGHTS,
    minSignalScore:    SETTINGS.MIN_SIGNAL_SCORE,
    autoExecuteThreshold: SETTINGS.AUTO_EXECUTE_THRESHOLD,
    capitalPerTrade:   SETTINGS.CAPITAL_PER_TRADE,
    maxPositionSize:   SETTINGS.MAX_POSITION_SIZE,
    stopLossPct:       SETTINGS.STOP_LOSS_PCT,
    takeProfitPct:     SETTINGS.TAKE_PROFIT_PCT,
    riskControls: {
      maxOpenPositions:    SETTINGS.MAX_OPEN_POSITIONS,
      maxDailyLossUsd:     SETTINGS.MAX_DAILY_LOSS_USD,
      maxConsecutiveLosses: SETTINGS.MAX_CONSECUTIVE_LOSSES,
      maxHoldHours:        SETTINGS.MAX_HOLD_HOURS,
    },
    scanIntervalMs:    SETTINGS.SCAN_INTERVAL_MS,
  });
});

// ─── EXECUTION ENDPOINTS ──────────────────────────────────────

// Manual single-trade execution
app.post('/api/execute', async (req, res) => {
  const { signal, confirmed } = req.body;
  if (!signal)    return res.status(400).json({ error: 'No signal provided' });
  if (!confirmed) return res.status(400).json({ error: 'confirmed must be true' });
  try { res.json(await executeLiveTrade(signal, true)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

// Quant auto-execution (with full risk controls + bracket order)
app.post('/api/quant/execute', async (req, res) => {
  const { signal, confirmed } = req.body;
  if (!signal)    return res.status(400).json({ error: 'No signal provided' });
  if (!confirmed) return res.status(400).json({ error: 'confirmed must be true' });
  try { res.json(await executeQuantSignal(signal, true)); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/emergency-stop', async (req, res) => {
  res.json(await emergencyStop());
});

// ─── SIM ENDPOINT ─────────────────────────────────────────────
app.get('/api/sim', (req, res) => {
  res.json({ history: getSimHistory(), stats: getSimStats(), open: getOpenSimPositions() });
});

// ─── Start ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  const info = getBrokerInfo();
  console.log(`\n🚀 Penny Stock Runner Bot on http://localhost:${PORT}`);
  console.log(`   Broker:     ${info.broker} (${info.paper ? 'PAPER' : 'LIVE'})`);
  console.log(`   Universe:   $${SETTINGS.PRICE_MIN}–$${SETTINGS.PRICE_MAX} | RVOL ≥${SETTINGS.MIN_RVOL}x | up ≥${SETTINGS.MIN_CHANGE_PCT}%`);
  console.log(`   Signals:    volume_surge, short_squeeze, vwap_reclaim, ORB, news_catalyst`);
  console.log(`   Risk:       max ${SETTINGS.MAX_OPEN_POSITIONS} positions | $${SETTINGS.MAX_DAILY_LOSS_USD}/day loss cap\n`);

  // Warm the scan cache on boot
  getScan(true).then(s => console.log(`✅ Initial scan: ${s.runners.length} runners, ${s.signals.length} signals`))
    .catch(e => console.error('Initial scan failed:', e.message));
});
