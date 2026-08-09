// ─────────────────────────────────────────────────────────────
// BACKTEST/INDEX.JS — CLI orchestrator
//
//   npm run backtest                    # last 60 trading-calendar days
//   npm run backtest -- --days 120     # longer window
//   npm run backtest -- --start 2026-03-01 --end 2026-06-30
//   npm run backtest -- --slippage 100 --tick 3 --capital 5000
//
// Pipeline per run:
//   1. Universe: every listed US equity, ACTIVE + DELISTED (survivorship
//      honesty), reduced to symbols that ever traded penny-ish in range.
//   2. Daily bars (split-adjusted) for the universe → per-day candidate
//      pre-filter: only symbol-days whose daily bar could possibly have
//      triggered the runner gate get minute-level replay. This is a pure
//      superset filter — it can't create signals, only skip dead days.
//   3. Each candidate day is replayed tick-by-tick through the LIVE
//      scanner/signal code (see simulate.js) with pessimistic fills.
//   4. Stats + report; full trade list saved to data/backtests/.
// ─────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { SETTINGS } from '../config.js';
import { listAllEquities, fetchDailyRange, fetchMinuteDay, etDateOfTimestamp } from './data.js';
import { simulateDay } from './simulate.js';
import { computeStats, printReport } from './stats.js';

const S = SETTINGS;

// ─── Args ─────────────────────────────────────────────────────
function parseArgs(argv) {
  const a = { days: 60, tick: 5, slippage: 50, capital: 1000 };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i], v = argv[i + 1];
    if (k === '--days')     a.days = Number(v);
    if (k === '--start')    a.start = v;
    if (k === '--end')      a.end = v;
    if (k === '--tick')     a.tick = Number(v);
    if (k === '--slippage') a.slippage = Number(v);
    if (k === '--capital')  a.capital = Number(v);
  }
  return a;
}

const iso = (d) => d.toISOString().slice(0, 10);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const end   = args.end   ?? iso(new Date(Date.now() - 86_400_000));           // yesterday
  const start = args.start ?? iso(new Date(Date.parse(end) - args.days * 86_400_000));
  console.log(`\n▶ Backtest ${start} → ${end} · tick ${args.tick}m · slippage ${args.slippage}bps/side`);

  // 1. Universe (active + delisted equities)
  console.log('▶ Loading asset list (active + delisted)...');
  const allSymbols = await listAllEquities();
  console.log(`  ${allSymbols.length} listed US equities`);

  // 2. Daily bars for everything (cached per symbol on disk).
  //    Pull extra lookback so day 1 of the window has a full RVOL baseline.
  const lookbackStart = iso(new Date(Date.parse(start) - 70 * 86_400_000));
  console.log('▶ Fetching daily bars (split-adjusted; first run is slow, then cached)...');
  const daily = await fetchDailyRange(allSymbols, lookbackStart, end, {
    onProgress: (done, total) => {
      if (done % 2000 === 0 || done === total) console.log(`  daily bars ${done}/${total} symbols`);
    },
  });

  // Reduce to the penny universe: anything that EVER closed in-band with
  // real volume inside the window (superset of what the gate can trigger).
  const universe = allSymbols.filter(sym => (daily[sym] ?? []).some(b => {
    const d = etDateOfTimestamp(b.timestamp);
    return d >= start && b.close >= S.PRICE_MIN && b.close <= S.PRICE_MAX * 1.2
        && b.volume >= S.MIN_DAILY_VOLUME;
  }));
  console.log(`  ${universe.length} penny-universe symbols in range`);

  // Trading-day calendar from SPY's daily bars.
  const spyDays = (daily.SPY ?? []).map(b => etDateOfTimestamp(b.timestamp))
    .filter(d => d >= start && d <= end);
  if (!spyDays.length) throw new Error('No SPY daily bars — cannot build the trading calendar');

  // Index daily bars by symbol/date for prevClose + prior-window slicing.
  const byDate = {};   // sym → Map(date → idx)
  for (const sym of [...universe, 'SPY', 'QQQ']) {
    const m = new Map();
    (daily[sym] ?? []).forEach((b, i) => m.set(etDateOfTimestamp(b.timestamp), i));
    byDate[sym] = m;
  }

  // 3. Day loop
  const allTrades = [];
  let dayN = 0;
  for (const day of spyDays) {
    dayN++;
    // Candidate pre-filter from the day's DAILY bar: the runner gate needs
    // up ≥5% intraday and volume ≥ floor — a day whose high never reached
    // +5% over prev close (or had no volume) can't produce a signal.
    const candidates = [];
    const prevClose = {};
    const priorDaily = {};
    for (const sym of universe) {
      const idx = byDate[sym].get(day);
      if (idx == null || idx === 0) continue;
      const bars = daily[sym];
      const dBar = bars[idx], pBar = bars[idx - 1];
      if (!pBar?.close) continue;
      if (dBar.volume < S.MIN_DAILY_VOLUME) continue;
      const maxChg = ((dBar.high - pBar.close) / pBar.close) * 100;
      const minChg = S.STRATEGY_TUNING?.RULESET === 'v3'
        ? S.STRATEGY_TUNING.EARLY_MIN_CHANGE_PCT : S.MIN_CHANGE_PCT;
      if (maxChg < minChg) continue;
      const loPx = Math.min(dBar.open, dBar.low), hiPx = Math.max(dBar.open, dBar.high);
      if (hiPx < S.PRICE_MIN || loPx > S.PRICE_MAX) continue;
      candidates.push(sym);
      prevClose[sym]  = pBar.close;
      priorDaily[sym] = bars.slice(Math.max(0, idx - 21), idx);   // ≤ D-1 only (no look-ahead)
    }

    if (!candidates.length) { progress(dayN, spyDays.length, day, 0, 0, allTrades.length); continue; }

    // Minute bars: candidates + SPY/QQQ for the health gate.
    const minuteBars = await fetchMinuteDay([...candidates, 'SPY', 'QQQ'], day);
    const spyIdx = byDate.SPY.get(day), qqqIdx = byDate.QQQ?.get(day);
    prevClose.SPY = spyIdx > 0 ? daily.SPY[spyIdx - 1].close : 0;
    prevClose.QQQ = qqqIdx > 0 ? daily.QQQ[qqqIdx - 1].close : 0;

    const trades = simulateDay({
      dateEt: day,
      minuteBars: Object.fromEntries(candidates.map(s => [s, minuteBars[s] ?? []])),
      prevClose, priorDaily,
      indexMinute: { SPY: minuteBars.SPY ?? [], QQQ: minuteBars.QQQ ?? [] },
    }, { tickMinutes: args.tick, slippageBps: args.slippage });

    allTrades.push(...trades);
    progress(dayN, spyDays.length, day, candidates.length, trades.length, allTrades.length);
  }

  // 4. Stats + persistence
  const stats = computeStats(allTrades, spyDays, args.capital);
  // SPY buy-and-hold over the same window — "outperforming the market"
  // means beating this line, not just being green.
  const spyWindow = (daily.SPY ?? []).filter(b => {
    const d = etDateOfTimestamp(b.timestamp);
    return d >= start && d <= end;
  });
  const spyReturnPct = spyWindow.length >= 2
    ? +(((spyWindow.at(-1).close - spyWindow[0].close) / spyWindow[0].close) * 100).toFixed(2)
    : null;
  const meta  = { start, end, tickMinutes: args.tick, slippageBps: args.slippage,
                  universeSize: universe.length, spyReturnPct,
                  tuning: { ...S.STRATEGY_TUNING },
                  generatedAt: new Date().toISOString() };
  printReport(stats, meta);

  const outDir = path.join(process.cwd(), 'data', 'backtests');
  fs.mkdirSync(outDir, { recursive: true });
  const variant = [
    S.STRATEGY_TUNING.RULESET !== 'v2' ? S.STRATEGY_TUNING.RULESET : null,
    S.STRATEGY_TUNING.VOLUME_SURGE_MIN_CONF > 0 ? `vsconf${S.STRATEGY_TUNING.VOLUME_SURGE_MIN_CONF}` : null,
    S.STRATEGY_TUNING.VOLUME_SURGE_REQUIRE_VWAP ? 'vsvwap' : null,
    S.STRATEGY_TUNING.ENTRY_REQUIRE_VWAP ? 'entryvwap' : null,
    S.STRATEGY_TUNING.STRATEGIES_ENABLED?.length ? `only-${S.STRATEGY_TUNING.STRATEGIES_ENABLED.join('+')}` : null,
  ].filter(Boolean).join('-') || 'baseline';
  const outFile = path.join(outDir, `bt-${start}_${end}_${variant}.json`);
  fs.writeFileSync(outFile, JSON.stringify({ meta, stats, trades: allTrades }, null, 2));
  console.log(`Full trade list + stats saved → ${path.relative(process.cwd(), outFile)}\n`);
}

function progress(n, total, day, candidates, dayTrades, totalTrades) {
  if (candidates > 0 || n % 10 === 0 || n === total) {
    console.log(`  [${String(n).padStart(3)}/${total}] ${day}  candidates ${String(candidates).padStart(3)} · trades today ${dayTrades} · total ${totalTrades}`);
  }
}

main().catch(err => { console.error('\n✖ Backtest failed:', err.message); process.exit(1); });
