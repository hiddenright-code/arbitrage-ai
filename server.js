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
import { getMarketWindow } from './src/marketHours.js';
import {
  scanCatalysts, updateConfirmation,
  getWatchlist, getWatchlistStats,
} from './src/catalystWatchlist.js';
import { markInPlay, getInPlayList } from './src/inPlay.js';
import { executeLiveTrade, emergencyStop } from './src/liveExecutor.js';
import { scanRunners } from './src/pennyStockScanner.js';
import { analyzeNewsMulti } from './src/newsAnalyzer.js';
import { detectSqueezeSetup } from './src/shortSqueezeDetector.js';
import { getShortInterest, getShortInterestMulti, getProviderStatus } from './src/shortInterestData.js';
import { assessMarketHealth } from './src/regimeDetector.js';
import { generateSignals } from './src/signalEngine.js';
import { fetchSnapshots, fetchDailyBarsMulti, fetchMinuteBarsMulti } from './src/priceHistory.js';
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
  // 1. Discover + score runners (confirmed) and BUILDING setups (pre-run)
  const { runners, building } = await scanRunners();

  if (!runners.length) {
    // Still surface anticipation candidates even when nothing has ignited.
    return { runners: [], signals: [], building, marketHealth: null, scannedAt: Date.now() };
  }

  const symbols = runners.map(r => r.symbol);

  // 2. Enrich: news + squeeze + intraday bars (in parallel)
  const [newsMap, indexSnaps] = await Promise.all([
    analyzeNewsMulti(symbols),
    fetchSnapshots([SETTINGS.SPY_SYMBOL, SETTINGS.QQQ_SYMBOL]),
  ]);

  // Pull real short-interest data (ORTEX + FINRA) for the runner set
  const floatMap = {};
  for (const r of runners) floatMap[r.symbol] = r.snapshot.floatShares ?? null;
  const siMap = await getShortInterestMulti(symbols, floatMap);

  // Batched: one daily-bars and one minute-bars request for the whole
  // runner set (both usually cache hits — the scanner just fetched them).
  const [dailyMap, minuteBarsMap] = await Promise.all([
    fetchDailyBarsMulti(symbols, 30),
    fetchMinuteBarsMulti(symbols, 120),
  ]);

  const squeezeMap = {};
  for (const r of runners) {
    const si = siMap[r.symbol] ?? null;
    // Backfill real free float onto the snapshot so all downstream
    // float math (squeeze + scoring) uses ground-truth when available
    if (si?.freeFloat) r.snapshot.floatShares = si.freeFloat;
    squeezeMap[r.symbol] = detectSqueezeSetup(r.snapshot, dailyMap[r.symbol], si);
    // Stash real SI (float / cost-to-borrow) on the in-play registry so the
    // next scan can score this name on its true float and keep it alive
    // while shorts are pressured.
    if (si?.hasRealData) {
      markInPlay(r.symbol, { price: r.price, rvol: r.rvol, changePct: r.changePct },
        { freeFloat: si.freeFloat, costToBorrow: si.costToBorrow, siPercentFloat: si.siPercentFloat });
    }
  }

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

  return { runners: enrichedRunners, signals, building, marketHealth, newsMap, squeezeMap, scannedAt: Date.now() };
}

async function getScan(force = false) {
  // Market-hours gate: outside the trading window, skip the entire pipeline
  // (no Alpaca/ORTEX/FINRA/news calls) and serve an empty, labeled scan.
  // Disable with MARKET_GATE=false for off-hours testing.
  const market = SETTINGS.MARKET_GATE_ENABLED
    ? await getMarketWindow()
    : { active: true, session: 'gate-disabled', reason: 'Market gate disabled', etTime: null };

  if (!market.active) {
    lastScan = { runners: [], signals: [], building: [], marketHealth: null, marketStatus: market, scannedAt: Date.now() };
    return lastScan;
  }

  if (!force && Date.now() - lastScan.scannedAt < SCAN_CACHE_MS) return lastScan;
  lastScan = { ...(await runScanPipeline()), marketStatus: market };
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
      building:     scan.building ?? [],
      marketHealth: scan.marketHealth,
      marketStatus: scan.marketStatus ?? null,
      strongBuys:   scan.signals.filter(s => s.tier === 'HIGH').length,
      buildingCount: (scan.building ?? []).length,
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
    res.json({ runners: scan.runners, count: scan.runners.length, marketStatus: scan.marketStatus ?? null, scannedAt: scan.scannedAt });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/inplay — names still "in play" (active/cooling) from prior scans,
// kept alive across pauses for a potential second leg.
app.get('/api/inplay', (req, res) => {
  res.json({ inPlay: getInPlayList() });
});

// GET /api/anticipated — pre-run "BUILDING" setups (watch-only tier).
// Loaded squeeze fuel + fresh catalyst + coiling base, NOT yet ignited.
app.get('/api/anticipated', async (req, res) => {
  try {
    const scan = await getScan();
    const building = scan.building ?? [];
    res.json({ building, count: building.length, marketStatus: scan.marketStatus ?? null, scannedAt: scan.scannedAt });
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
      marketStatus:       scan.marketStatus ?? null,
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

// Debug endpoint — verify ORTEX/FINRA data is returning correctly for a symbol.
// Example: GET /api/debug/short-interest/GME
app.get('/api/debug/short-interest/:symbol', async (req, res) => {
  try {
    const si = await getShortInterest(req.params.symbol.toUpperCase());
    res.json(si);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/clock', async (req, res) => {
  res.json(await getMarketClock());
});

// GET /api/market-status — the scanner's trading-window gate (extended
// hours, holiday-aware). Tells the dashboard whether/why the bot is idle.
app.get('/api/market-status', async (req, res) => {
  try {
    res.json({ gateEnabled: SETTINGS.MARKET_GATE_ENABLED, ...(await getMarketWindow()) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// GET /api/watchlist — the multi-day catalyst watchlist (slow layer).
app.get('/api/watchlist', (req, res) => {
  res.json({ ...getWatchlistStats(), watchlist: getWatchlist() });
});

// POST /api/catalysts/scan — force an immediate catalyst news sweep.
app.post('/api/catalysts/scan', async (req, res) => {
  try {
    const result = await scanCatalysts();
    await updateConfirmation();
    res.json(result);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/config', (req, res) => {
  res.json({
    broker:            getBrokerInfo(),
    shortInterestProviders: getProviderStatus(),
    priceRange:        [SETTINGS.PRICE_MIN, SETTINGS.PRICE_MAX],
    minRvol:           SETTINGS.MIN_RVOL,
    minChangePct:      SETTINGS.MIN_CHANGE_PCT,
    dataFeed:          SETTINGS.DATA_FEED,
    minDailyVolume:    SETTINGS.MIN_DAILY_VOLUME,   // feed-aware (IEX vs SIP)
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

  // Warm the scan cache on boot (respects the market-hours gate)
  console.log(`   Gate:       ${SETTINGS.MARKET_GATE_ENABLED ? `ON (${SETTINGS.SCAN_EXTENDED_HOURS ? 'extended hours 04:00–20:00 ET' : 'regular hours 09:30–16:00 ET'})` : 'OFF (always scan)'}`);
  console.log(`   Catalyst:   ${SETTINGS.CATALYST.ENABLED ? `watchlist ON (news sweep every ${Math.round(SETTINGS.CATALYST.SCAN_INTERVAL_MS / 60000)}m)` : 'OFF'}\n`);
  getScan(true).then(s => {
    if (s.marketStatus && !s.marketStatus.active) {
      console.log(`⏸️  Scanner idle — ${s.marketStatus.reason} (${s.marketStatus.etTime})`);
    } else {
      console.log(`✅ Initial scan: ${s.runners.length} runners, ${s.signals.length} signals`);
    }
  }).catch(e => console.error('Initial scan failed:', e.message));

  // ─── Catalyst watchlist — the always-on "slow" layer ────────
  // Runs regardless of the intraday gate: catalysts break overnight and
  // pre-market, and a confirmed name feeds the scanner the moment it opens.
  if (SETTINGS.CATALYST.ENABLED) {
    const sweep = async () => {
      try {
        const r = await scanCatalysts();
        await updateConfirmation();
        if (r.added?.length || r.flagged?.length) {
          console.log(`📰 Catalyst sweep: +${r.added.length} new${r.flagged.length ? `, ${r.flagged.length} dilution-flagged` : ''} | watchlist ${r.size}`);
        }
      } catch (e) { console.error('[Catalyst] sweep failed:', e.message); }
    };
    sweep();   // initial
    setInterval(sweep, SETTINGS.CATALYST.SCAN_INTERVAL_MS);
  }

  // ─── Real-position reconciler ───────────────────────────────
  // Bracket TP/SL fills happen at the broker; book them (daily-loss cap,
  // cooldowns, freed slots) even when no dashboard is polling /api/signals.
  // No-ops instantly when there are no tracked positions.
  setInterval(() => {
    managePositions().then(actions => {
      for (const a of actions) {
        if (a.closed) console.log(`[Positions] ${a.symbol}: ${a.reason} | PnL $${(a.pnlUSD ?? 0).toFixed(2)}`);
      }
    }).catch(e => console.error('[Positions] reconcile failed:', e.message));
  }, 60_000);
});
