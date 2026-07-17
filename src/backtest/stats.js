// ─────────────────────────────────────────────────────────────
// BACKTEST/STATS.JS — Performance statistics for a trade list
//
// Reports what a validation actually needs:
//   • Overall + per-strategy + per-exit-reason breakdowns
//   • Expectancy per trade (the number that decides if an edge exists)
//   • Profit factor, max drawdown, daily Sharpe (annualized)
//   • FIRST-HALF vs SECOND-HALF chronological split — a cheap
//     out-of-sample smell test: an edge that only exists in one half
//     is probably noise or regime luck, not an edge.
// ─────────────────────────────────────────────────────────────

function agg(trades) {
  if (!trades.length) {
    return { trades: 0, wins: 0, losses: 0, winRate: 0, totalPnl: 0, avgPnl: 0,
             avgWin: 0, avgLoss: 0, profitFactor: 0, expectancyPct: 0, avgHoldMin: 0 };
  }
  const wins   = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);
  const totalPnl  = trades.reduce((s, t) => s + t.pnl, 0);
  const grossWin  = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  return {
    trades:       trades.length,
    wins:         wins.length,
    losses:       losses.length,
    winRate:      +(wins.length / trades.length * 100).toFixed(1),
    totalPnl:     +totalPnl.toFixed(2),
    avgPnl:       +(totalPnl / trades.length).toFixed(4),
    avgWin:       wins.length   ? +(grossWin / wins.length).toFixed(4)    : 0,
    avgLoss:      losses.length ? +(grossLoss / losses.length).toFixed(4) : 0,
    profitFactor: grossLoss === 0 ? (grossWin > 0 ? Infinity : 0) : +(grossWin / grossLoss).toFixed(3),
    expectancyPct: +(trades.reduce((s, t) => s + t.pnlPct, 0) / trades.length).toFixed(3),
    avgHoldMin:   Math.round(trades.reduce((s, t) => s + t.holdMin, 0) / trades.length),
  };
}

function groupBy(trades, key) {
  const out = {};
  for (const t of trades) (out[t[key]] ??= []).push(t);
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, agg(v)]));
}

export function computeStats(trades, tradingDays, capital = 1000) {
  const byDay = {};
  for (const t of trades) (byDay[t.date] ??= []).push(t);

  // Equity curve over every trading day (flat days count — they shape
  // drawdown duration and the Sharpe denominator).
  let equity = capital, peak = capital, maxDD = 0;
  const dailyReturns = [];
  const curve = [];
  for (const day of tradingDays) {
    const pnl = (byDay[day] ?? []).reduce((s, t) => s + t.pnl, 0);
    dailyReturns.push(pnl / equity);
    equity += pnl;
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
    curve.push({ date: day, equity: +equity.toFixed(2), dayPnl: +pnl.toFixed(2) });
  }

  const mean = dailyReturns.reduce((s, r) => s + r, 0) / (dailyReturns.length || 1);
  const sd   = Math.sqrt(dailyReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / (dailyReturns.length || 1));
  const sharpe = sd > 0 ? +(mean / sd * Math.sqrt(252)).toFixed(2) : 0;

  // Chronological halves (out-of-sample smell test).
  const mid   = Math.floor(tradingDays.length / 2);
  const half1 = new Set(tradingDays.slice(0, mid));
  const firstHalf  = trades.filter(t => half1.has(t.date));
  const secondHalf = trades.filter(t => !half1.has(t.date));

  return {
    overall:      agg(trades),
    byStrategy:   groupBy(trades, 'strategy'),
    byExitReason: groupBy(trades, 'exitReason'),
    byTier:       groupBy(trades, 'tier'),
    halves: {
      first:  { days: mid, ...agg(firstHalf) },
      second: { days: tradingDays.length - mid, ...agg(secondHalf) },
    },
    equity: {
      start: capital,
      end:   +equity.toFixed(2),
      returnPct: +(((equity - capital) / capital) * 100).toFixed(2),
      maxDrawdownPct: +(maxDD * 100).toFixed(2),
      sharpe,
      curve,
    },
    tradingDays: tradingDays.length,
  };
}

// ─── Console report ───────────────────────────────────────────
const pad = (v, n) => String(v).padStart(n);

export function printReport(stats, meta) {
  const o = stats.overall, e = stats.equity;
  const line = '═'.repeat(66);
  console.log(`\n${line}\n  BACKTEST REPORT — ${meta.start} → ${meta.end}  (${stats.tradingDays} trading days)\n${line}`);
  console.log(`  Strategy code: LIVE modules (scanner/signals replayed tick-by-tick)`);
  console.log(`  Universe: ${meta.universeSize} penny candidates (incl. delisted) · tick ${meta.tickMinutes}m · slippage ${meta.slippageBps}bps/side\n`);

  console.log(`  Trades: ${o.trades}   Win rate: ${o.winRate}%   Profit factor: ${o.profitFactor}`);
  console.log(`  Expectancy: ${o.expectancyPct}%/trade   Avg win: $${o.avgWin}  Avg loss: -$${o.avgLoss}   Avg hold: ${o.avgHoldMin}m`);
  console.log(`  Equity: $${e.start} → $${e.end}  (${e.returnPct >= 0 ? '+' : ''}${e.returnPct}%)   MaxDD: ${e.maxDrawdownPct}%   Sharpe(d): ${e.sharpe}`);
  if (meta.spyReturnPct != null) {
    const beat = e.returnPct - meta.spyReturnPct;
    console.log(`  Benchmark: SPY buy-and-hold same window ${meta.spyReturnPct >= 0 ? '+' : ''}${meta.spyReturnPct}%  →  strategy ${beat >= 0 ? 'BEATS' : 'TRAILS'} market by ${beat.toFixed(2)}pp`);
  }
  const tune = Object.entries(meta.tuning ?? {}).filter(([, v]) => v);
  console.log(`  Tuning: ${tune.length ? tune.map(([k, v]) => `${k}=${v}`).join(' · ') : 'baseline (no levers active)'}\n`);

  console.log('  Per strategy:');
  console.log(`    ${'strategy'.padEnd(24)}${pad('n', 5)}${pad('win%', 7)}${pad('PF', 7)}${pad('exp%/tr', 9)}${pad('P&L$', 9)}`);
  for (const [k, s] of Object.entries(stats.byStrategy)) {
    console.log(`    ${k.padEnd(24)}${pad(s.trades, 5)}${pad(s.winRate, 7)}${pad(s.profitFactor, 7)}${pad(s.expectancyPct, 9)}${pad(s.totalPnl, 9)}`);
  }

  console.log('\n  Exits:');
  for (const [k, s] of Object.entries(stats.byExitReason)) {
    console.log(`    ${k.padEnd(24)}${pad(s.trades, 5)}${pad(s.totalPnl, 9)}$`);
  }

  const h = stats.halves;
  console.log('\n  Out-of-sample smell test (chronological halves):');
  console.log(`    first  ${pad(h.first.days, 3)}d: ${pad(h.first.trades, 4)} trades  win ${pad(h.first.winRate, 5)}%  PF ${pad(h.first.profitFactor, 6)}  exp ${pad(h.first.expectancyPct, 7)}%`);
  console.log(`    second ${pad(h.second.days, 3)}d: ${pad(h.second.trades, 4)} trades  win ${pad(h.second.winRate, 5)}%  PF ${pad(h.second.profitFactor, 6)}  exp ${pad(h.second.expectancyPct, 7)}%`);

  console.log(`\n  Caveats (read these before believing anything):`);
  console.log(`   • IEX feed — volumes are the IEX slice of the tape (thin for pennies);`);
  console.log(`     RVOL is self-consistent (IEX vs IEX baseline) but absolute volume floors differ from SIP.`);
  console.log(`   • No news/catalyst/real-SI boosts in replay — live signals have MORE information.`);
  console.log(`   • Fills are pessimistic (limit-only entries, stop-first ambiguity, ${meta.slippageBps}bps/side).`);
  console.log(`   • ${o.trades < 100 ? `SMALL SAMPLE (${o.trades} trades) — treat every number above as provisional.` : 'Sample OK, but regimes change; re-run rolling windows.'}`);
  console.log(line + '\n');
}
