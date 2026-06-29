// ─────────────────────────────────────────────────────────────
// INDEX.JSX — Penny Stock Runner Dashboard
// ─────────────────────────────────────────────────────────────

import React, { useState, useEffect, useRef, useCallback } from 'react';

const API_URL = 'http://localhost:3001';
const api = {
  get:  (p)    => fetch(`${API_URL}${p}`).then(r => r.json()),
  post: (p, b) => fetch(`${API_URL}${p}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
  }).then(r => r.json()),
};

// ─── UI primitives ────────────────────────────────────────────
const Badge = ({ color, children }) => {
  const map = {
    green:  'bg-emerald-500/15 text-emerald-400 border border-emerald-500/30',
    red:    'bg-red-500/15 text-red-400 border border-red-500/30',
    yellow: 'bg-amber-500/15 text-amber-400 border border-amber-500/30',
    blue:   'bg-sky-500/15 text-sky-400 border border-sky-500/30',
    purple: 'bg-violet-500/15 text-violet-400 border border-violet-500/30',
    orange: 'bg-orange-500/15 text-orange-400 border border-orange-500/30',
    gray:   'bg-gray-500/15 text-gray-400 border border-gray-500/30',
    cyan:   'bg-cyan-500/15 text-cyan-400 border border-cyan-500/30',
    pink:   'bg-pink-500/15 text-pink-400 border border-pink-500/30',
  };
  return <span className={`px-2 py-0.5 rounded text-xs font-mono ${map[color] || map.gray}`}>{children}</span>;
};

const StatCard = ({ label, value, sub, color }) => {
  const c = color === 'green' ? 'text-emerald-400'
          : color === 'red'   ? 'text-red-400'
          : color === 'yellow'? 'text-amber-400'
          : color === 'cyan'  ? 'text-cyan-400'
          : color === 'pink'  ? 'text-pink-400'
          : 'text-white';
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <p className="text-gray-500 text-xs uppercase tracking-wide mb-1">{label}</p>
      <p className={`text-xl font-bold font-mono ${c}`}>{value}</p>
      {sub && <p className="text-gray-600 text-xs mt-1">{sub}</p>}
    </div>
  );
};

const STRATEGY_LABELS = {
  volume_surge:           { color: 'green',  label: '📈 VOL SURGE' },
  short_squeeze:          { color: 'pink',   label: '🩳 SQUEEZE' },
  vwap_reclaim:           { color: 'blue',   label: '↗ VWAP' },
  opening_range_breakout: { color: 'orange', label: '🚀 ORB' },
  news_catalyst:          { color: 'purple', label: '📰 NEWS' },
};

const TierBadge = ({ tier }) => {
  const map = {
    STRONG_BUY: { color: 'green',  label: '★ STRONG BUY' },
    BUY:        { color: 'cyan',   label: 'BUY' },
    WATCH:      { color: 'yellow', label: '👁 WATCH' },
    HIGH:       { color: 'green',  label: 'HIGH' },
    MEDIUM:     { color: 'yellow', label: 'MED' },
    LOW:        { color: 'gray',   label: 'LOW' },
  };
  const r = map[tier] || { color: 'gray', label: tier };
  return <Badge color={r.color}>{r.label}</Badge>;
};

// ─── Signal card ──────────────────────────────────────────────
const SignalCard = ({ signal, index, onExecute, realMoneyMode }) => {
  const strat = STRATEGY_LABELS[signal.strategy] || { color: 'gray', label: signal.strategy };
  const confHigh = signal.confidence >= 0.75;
  const border = signal.gated ? 'border-gray-800 opacity-60' : confHigh ? 'border-emerald-700/60' : 'border-gray-700';

  return (
    <div className={`bg-gray-900 border ${border} hover:border-gray-500 rounded-xl p-4 transition-colors`}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="text-gray-600 text-xs w-5">#{index + 1}</span>
          <span className="text-white text-sm font-mono font-bold">{signal.symbol}</span>
          <Badge color={strat.color}>{strat.label}</Badge>
          {signal.tier && <TierBadge tier={signal.tier} />}
          {signal.squeezeIntensity && signal.squeezeIntensity !== 'LOW' && (
            <Badge color="pink">🔥 {signal.squeezeIntensity} SQUEEZE</Badge>
          )}
        </div>
        <div className="flex items-center gap-2">
          <Badge color={confHigh ? 'green' : 'yellow'}>{(signal.confidence * 100).toFixed(0)}% conf</Badge>
          <span className="text-gray-600 text-xs">{new Date(signal.timestamp).toLocaleTimeString()}</span>
        </div>
      </div>

      {/* Metrics row */}
      <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-500">
        {signal.price     != null && <span>Price <span className="text-white">${signal.price?.toFixed(3)}</span></span>}
        {signal.rvol      != null && <span>RVOL <span className="text-amber-400">{signal.rvol}x</span></span>}
        {signal.changePct != null && <span>Chg <span className={signal.changePct >= 0 ? 'text-emerald-400' : 'text-red-400'}>{signal.changePct >= 0 ? '+' : ''}{signal.changePct?.toFixed(1)}%</span></span>}
        {signal.vwap      ? <span>VWAP <span className="text-white">${signal.vwap?.toFixed(3)}</span></span> : null}
        {signal.volume    != null && <span>Vol <span className="text-white">{(signal.volume / 1e6).toFixed(1)}M</span></span>}
      </div>

      {/* Squeeze score + sub-scores */}
      {signal.squeezeScore != null && (
        <div className="mt-2 text-xs text-gray-500">
          Squeeze: <span className="text-pink-400 font-bold">{(signal.squeezeScore * 100).toFixed(0)}/100</span>
          <span className="ml-2 text-gray-600">({signal.squeezeIntensity}{signal.squeezeType ? ` · ${signal.squeezeType.replace(/_/g, ' ').toLowerCase()}` : ''})</span>
          {signal.squeezeFuel != null && (
            <span className="ml-2 text-gray-600">⛽ fuel {(signal.squeezeFuel * 100).toFixed(0)} · 🔥 ignition {(signal.squeezeIgnition * 100).toFixed(0)}</span>
          )}
        </div>
      )}

      {/* Real short-interest data (ORTEX / FINRA) */}
      {signal.shortInterest && (
        <div className="mt-2 flex flex-wrap gap-3 text-xs bg-pink-500/5 border border-pink-500/20 rounded px-2 py-1">
          <span className="text-pink-300 font-bold uppercase">{signal.shortInterest.source}</span>
          {signal.shortInterest.siPercentFloat != null && <span className="text-gray-400">SI <span className="text-pink-400">{signal.shortInterest.siPercentFloat.toFixed(1)}%</span> float</span>}
          {signal.shortInterest.daysToCover   != null && <span className="text-gray-400">DTC <span className="text-white">{signal.shortInterest.daysToCover.toFixed(1)}d</span></span>}
          {signal.shortInterest.costToBorrow  != null && <span className="text-gray-400">CTB <span className="text-amber-400">{signal.shortInterest.costToBorrow.toFixed(0)}%</span></span>}
          {signal.shortInterest.utilization   != null && <span className="text-gray-400">Util <span className="text-white">{signal.shortInterest.utilization.toFixed(0)}%</span></span>}
          {signal.shortInterest.siTrend       && <span className={signal.shortInterest.siTrend === 'rising' ? 'text-red-400' : 'text-gray-500'}>SI {signal.shortInterest.siTrend}</span>}
          {signal.shortInterest.stale && <span className="text-gray-600">(lagged)</span>}
        </div>
      )}

      {/* News headline */}
      {signal.topHeadline && (
        <div className="mt-2 text-xs text-violet-300 bg-violet-500/5 border border-violet-500/20 rounded px-2 py-1">
          📰 {signal.topHeadline} <span className="text-gray-600">— {signal.topSource}</span>
        </div>
      )}

      {/* Reasons */}
      {signal.reasons?.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {signal.reasons.map((r, i) => (
            <span key={i} className="text-gray-500 text-xs bg-gray-800 px-2 py-0.5 rounded">{r}</span>
          ))}
        </div>
      )}

      {/* TP/SL */}
      {(signal.takeProfit || signal.stopLoss) && (
        <div className="mt-2 flex gap-4 text-xs">
          {signal.stopLoss   && <span className="text-gray-500">SL <span className="text-red-400">${signal.stopLoss?.toFixed(3)}</span></span>}
          {signal.takeProfit && <span className="text-gray-500">TP <span className="text-emerald-400">${signal.takeProfit?.toFixed(3)}</span></span>}
          {signal.takeProfitAggressive && <span className="text-gray-500">TP+ <span className="text-emerald-300">${signal.takeProfitAggressive?.toFixed(3)}</span></span>}
        </div>
      )}

      {signal.gated && (
        <div className="mt-2 text-xs text-amber-400">⏸ Gated: {signal.gateReason}</div>
      )}

      {/* Execute */}
      {!signal.gated && (
        <div className="mt-3">
          <button onClick={() => onExecute(signal)}
            className={`px-3 py-1 rounded text-xs transition-colors ${
              realMoneyMode
                ? 'bg-red-600/20 hover:bg-red-600/40 border border-red-600/40 text-red-400'
                : 'bg-cyan-600/20 hover:bg-cyan-600/40 border border-cyan-600/40 text-cyan-400'
            }`}>
            {realMoneyMode ? '⚠️ Execute Real Trade' : '🔍 Simulate Signal'}
          </button>
        </div>
      )}
    </div>
  );
};

// ─── Runner card ──────────────────────────────────────────────
const RunnerCard = ({ runner }) => {
  const s = runner.score;
  return (
    <div className="bg-gray-900 border border-gray-800 hover:border-gray-700 rounded-xl p-3 transition-colors">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="text-white text-sm font-mono font-bold">{runner.symbol}</span>
          <TierBadge tier={runner.tier} />
          <Badge color="gray">score {(s.total * 100).toFixed(0)}</Badge>
          {runner.squeeze?.isSqueezePlay && runner.squeeze.intensity !== 'LOW' && (
            <Badge color="pink">🔥 {runner.squeeze.intensity}</Badge>
          )}
          {runner.squeeze?.shortInterest?.siPercentFloat != null && (
            <Badge color="pink">SI {runner.squeeze.shortInterest.siPercentFloat.toFixed(0)}%</Badge>
          )}
          {runner.news?.hasCatalyst && <Badge color="purple">📰 {runner.news.catalysts[0]?.label}</Badge>}
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span>${runner.price?.toFixed(3)}</span>
          <span className="text-amber-400">{runner.rvol}x RVOL</span>
          <span className={runner.changePct >= 0 ? 'text-emerald-400' : 'text-red-400'}>
            {runner.changePct >= 0 ? '+' : ''}{runner.changePct?.toFixed(1)}%
          </span>
        </div>
      </div>
      {/* Score breakdown bar */}
      <div className="mt-2 flex gap-1 h-1.5">
        <div className="bg-amber-500"  style={{ width: `${s.rvol * 35}%` }}  title={`RVOL ${s.rvol}`} />
        <div className="bg-emerald-500" style={{ width: `${s.momentum * 30}%` }} title={`Momentum ${s.momentum}`} />
        <div className="bg-sky-500"    style={{ width: `${s.technical * 20}%` }} title={`Technical ${s.technical}`} />
        <div className="bg-violet-500" style={{ width: `${s.float * 15}%` }} title={`Float ${s.float}`} />
      </div>
    </div>
  );
};

// ─── Building (anticipation) card — a pre-run setup ──────────
const BuildingCard = ({ b }) => {
  const a = b.anticipation ?? {};
  const c = a.components ?? {};
  const cat = b.catalyst;
  const readyColor = b.readiness === 'PRIMED' ? 'green' : b.readiness === 'BUILDING' ? 'cyan' : 'gray';
  return (
    <div className="bg-gray-900 border border-gray-800 hover:border-gray-700 rounded-xl p-3 transition-colors">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="text-white text-sm font-mono font-bold">{b.symbol}</span>
          <Badge color={readyColor}>{b.readiness}</Badge>
          <Badge color="gray">setup {Math.round((b.setupScore ?? 0) * 100)}</Badge>
          {cat && <Badge color="purple">📰 {cat.catalyst?.label} · {cat.status?.toLowerCase()} {cat.dayCount}d</Badge>}
        </div>
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span>${b.price?.toFixed(3)}</span>
          <span className={b.changePct >= 0 ? 'text-emerald-400' : 'text-red-400'}>
            {b.changePct >= 0 ? '+' : ''}{b.changePct?.toFixed(1)}%
          </span>
          <span className="text-gray-600" title="ignition (low = not yet firing)">ign {Math.round((a.ignition ?? 0) * 100)}</span>
        </div>
      </div>
      {/* Setup component bar: fuel · catalyst · coil · stir */}
      <div className="mt-2 flex gap-1 h-1.5">
        <div className="bg-pink-500"   style={{ width: `${(c.fuel ?? 0) * 25}%` }}     title={`Fuel ${c.fuel}`} />
        <div className="bg-purple-500" style={{ width: `${(c.catalyst ?? 0) * 35}%` }} title={`Catalyst ${c.catalyst}`} />
        <div className="bg-sky-500"    style={{ width: `${(c.coil ?? 0) * 25}%` }}     title={`Coil ${c.coil}`} />
        <div className="bg-amber-500"  style={{ width: `${(c.stir ?? 0) * 15}%` }}     title={`Stir ${c.stir}`} />
      </div>
      {a.reasons?.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {a.reasons.slice(0, 5).map((r, i) => (
            <span key={i} className="text-xs text-gray-400 bg-gray-800/60 rounded px-1.5 py-0.5">{r}</span>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Main app ─────────────────────────────────────────────────
export default function PennyStockBot() {
  const [config, setConfig]         = useState(null);
  const [scan, setScan]             = useState(null);
  const [account, setAccount]       = useState(null);
  const [marketHealth, setMarketHealth] = useState(null);
  const [simData, setSimData]       = useState(null);
  const [trades, setTrades]         = useState([]);
  const [log, setLog]               = useState([]);
  const [isRunning, setIsRunning]   = useState(false);
  const [realMoneyMode, setRealMoneyMode] = useState(false);
  const [activeTab, setActiveTab]   = useState('signals');
  const [loading, setLoading]       = useState(false);
  const [lastScan, setLastScan]     = useState(null);
  const scanIntervalRef             = useRef(null);

  const addLog = useCallback((msg, type = 'info') => {
    setLog(prev => [{ id: Date.now() + Math.random(), msg, type, time: new Date().toLocaleTimeString() }, ...prev].slice(0, 150));
  }, []);

  useEffect(() => {
    api.get('/api/config')
      .then(cfg => { setConfig(cfg); addLog(`⚙️ Config — $${cfg.priceRange?.[0]}–$${cfg.priceRange?.[1]} | RVOL ≥${cfg.minRvol}x | up ≥${cfg.minChangePct}%`, 'info'); })
      .catch(() => addLog('❌ Backend unreachable. Is server.js running?', 'error'));
    api.get('/api/account').then(setAccount).catch(() => {});
  }, []);

  const runScan = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get('/api/scan');
      setScan(data);
      setMarketHealth(data.marketHealth);
      setSimData({ stats: data.simStats, open: data.openSimPositions });
      setLastScan(data.scannedAt);

      if (data.signals?.length > 0) {
        const best = data.signals[0];
        addLog(`🎯 ${data.signalCount} signals — top: ${best.symbol} ${best.strategy} (${(best.confidence * 100).toFixed(0)}%)`, 'success');

        // Auto-execute STRONG signals in real money mode
        if (realMoneyMode && best.tier === 'HIGH' && !best.gated &&
            best.confidence >= (config?.autoExecuteThreshold ?? 0.75)) {
          addLog(`🤖 Auto-executing: ${best.symbol} (${(best.confidence * 100).toFixed(0)}% conf)`, 'warn');
          executeTrade(best, true);
        }
      } else {
        addLog(`🔍 Scanned ${data.runnerCount} runners — no qualifying signals`, 'info');
      }

      if (data.closedSimPositions?.length > 0) {
        for (const cp of data.closedSimPositions) {
          addLog(`📋 Sim closed ${cp.symbol} — ${cp.exitReason} | ${cp.netPnl >= 0 ? '+' : ''}$${cp.netPnl.toFixed(2)} (${cp.netPct}%)`, cp.won ? 'success' : 'error');
        }
      }
    } catch (err) {
      addLog(`❌ Scan error: ${err.message}`, 'error');
    } finally {
      setLoading(false);
    }
  }, [realMoneyMode, config, addLog]);

  useEffect(() => {
    if (isRunning) {
      const interval = config?.scanIntervalMs ?? 30000;
      runScan();
      scanIntervalRef.current = setInterval(runScan, interval);
    } else {
      clearInterval(scanIntervalRef.current);
    }
    return () => clearInterval(scanIntervalRef.current);
  }, [isRunning, runScan, config]);

  const executeTrade = useCallback(async (signal, autoConfirmed = false) => {
    if (!realMoneyMode) {
      addLog(`🔍 SIM: ${signal.symbol} ${signal.strategy} (${(signal.confidence * 100).toFixed(0)}%)`, 'warn');
      setTrades(prev => [{ id: Date.now(), symbol: signal.symbol, strategy: signal.strategy, status: 'SIMULATED', confidence: signal.confidence, pnl: null, timestamp: new Date().toLocaleTimeString() }, ...prev].slice(0, 100));
      return;
    }
    const confirmed = autoConfirmed || window.confirm(
      `⚠️ REAL TRADE\n${signal.symbol} — ${signal.strategy}\nConfidence: ${(signal.confidence * 100).toFixed(0)}%\nEntry: $${signal.price}\nTP: $${signal.takeProfit} | SL: $${signal.stopLoss}\nContinue?`);
    if (!confirmed) return;
    addLog(`⚠️ LIVE: ${signal.symbol} ${signal.strategy}`, 'error');
    try {
      const result = await api.post('/api/quant/execute', { signal, confirmed: true });
      if (result.success) {
        addLog(`✅ Order placed: ${result.qty} ${signal.symbol} ($${result.tradeUSD})`, 'success');
        setTrades(prev => [{ id: Date.now(), symbol: signal.symbol, strategy: signal.strategy, status: 'OPEN', confidence: signal.confidence, pnl: null, timestamp: new Date().toLocaleTimeString() }, ...prev].slice(0, 100));
        api.get('/api/account').then(setAccount).catch(() => {});
      } else {
        addLog(`❌ Rejected: ${result.reason}`, 'error');
      }
    } catch (err) {
      addLog(`❌ Execute error: ${err.message}`, 'error');
    }
  }, [realMoneyMode, addLog]);

  const handleEmergencyStop = async () => {
    setIsRunning(false); setRealMoneyMode(false);
    clearInterval(scanIntervalRef.current);
    addLog('🛑 EMERGENCY STOP — liquidating all positions!', 'error');
    try {
      const r = await api.post('/api/emergency-stop', {});
      addLog(`🛑 Stopped — ${r.positionsClosed ?? 0} positions closed`, 'error');
    } catch {}
  };

  const signals    = scan?.signals ?? [];
  const runners    = scan?.runners ?? [];
  const building   = scan?.building ?? [];
  const simStats   = simData?.stats ?? {};
  const portfolioValue = account ? parseFloat(account.portfolio_value) : 0;
  const buyingPower    = account ? parseFloat(account.buying_power) : 0;

  const mhColor = marketHealth?.regime === 'RISK_ON' ? 'green'
                : marketHealth?.regime === 'RISK_OFF' ? 'red' : 'yellow';

  const TABS = [
    { id: 'signals',  label: '🎯 Signals',  count: signals.length || null },
    { id: 'building', label: '🌱 Building',  count: building.length || null },
    { id: 'runners',  label: '🏃 Runners',  count: runners.length || null },
    { id: 'sim',      label: '📋 Sim',      count: simStats.trades || null },
    { id: 'trades',   label: 'Trades',      count: trades.length || null },
    { id: 'log',      label: 'Log',         count: null },
    { id: 'config',   label: 'Config',      count: null },
  ];

  return (
    <div className="bg-gray-950 min-h-screen text-white font-mono text-sm">
      {/* Header */}
      <div className="border-b border-gray-800 px-6 py-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-base font-bold tracking-tight">
              🏃 Penny Stock Runner Bot
              <span className="ml-2 text-xs text-gray-500 font-normal">
                {config ? `${config.broker?.broker} ${config.broker?.paper ? '· PAPER' : '· LIVE'}` : 'Connecting...'}
              </span>
            </h1>
            <p className="text-gray-600 text-xs mt-0.5">
              {lastScan && `Last scan: ${new Date(lastScan).toLocaleTimeString()}`}
              {loading && <span className="ml-2 text-amber-400 animate-pulse">● Scanning...</span>}
              {marketHealth && <span className="ml-2">· Market: <span className={`text-${mhColor === 'green' ? 'emerald' : mhColor === 'red' ? 'red' : 'amber'}-400`}>{marketHealth.regime}</span></span>}
            </p>
          </div>
          <div className="flex gap-2 items-center flex-wrap">
            <button
              onClick={() => {
                if (!realMoneyMode) {
                  if (window.confirm('⚠️ Enable REAL trades?\n\nMake sure ALPACA_PAPER is set correctly. Continue?')) {
                    setRealMoneyMode(true);
                    addLog('🔴 REAL MONEY MODE ON', 'error');
                  }
                } else { setRealMoneyMode(false); addLog('🟡 Sim mode', 'warn'); }
              }}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs transition-all ${
                realMoneyMode ? 'bg-red-500/20 border-red-500/50 text-red-400 animate-pulse' : 'bg-gray-800 border-gray-700 text-gray-400'
              }`}>
              <span className={`w-2 h-2 rounded-full ${realMoneyMode ? 'bg-red-400' : 'bg-gray-600'}`} />
              {realMoneyMode ? '⚠️ REAL MONEY' : 'Simulation'}
            </button>
            {realMoneyMode && (
              <button onClick={handleEmergencyStop} className="px-3 py-1.5 rounded-lg bg-red-700 hover:bg-red-600 border border-red-600 text-white text-xs font-bold">
                🛑 STOP
              </button>
            )}
            <button
              onClick={() => { const next = !isRunning; setIsRunning(next); addLog(next ? '🚀 Scanning started' : '⏸ Paused', next ? 'success' : 'warn'); }}
              className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-colors ${isRunning ? 'bg-amber-600 hover:bg-amber-500' : 'bg-emerald-700 hover:bg-emerald-600'} text-white`}>
              {isRunning ? '⏸ Pause' : '▶ Start'}
            </button>
          </div>
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 px-6 py-4">
        <StatCard label="Portfolio Value" value={`$${portfolioValue.toFixed(2)}`} sub={`Buying power $${buyingPower.toFixed(2)}`} color={portfolioValue > 0 ? 'green' : 'yellow'} />
        <StatCard label="Runners Found" value={runners.length} sub={`${scan?.strongBuys ?? 0} strong buys`} color="cyan" />
        <StatCard label="Sim Win Rate" value={simStats.trades > 0 ? `${simStats.winRate}%` : '—'} sub={`${simStats.trades ?? 0} sim trades`} color={simStats.winRate >= 50 ? 'green' : simStats.trades > 0 ? 'red' : 'yellow'} />
        <StatCard label="Mode" value={realMoneyMode ? '🔴 LIVE' : '🟡 Sim'} sub={isRunning ? 'Scanning...' : 'Paused'} color={realMoneyMode ? 'red' : 'yellow'} />
      </div>

      {/* Market health banner */}
      {marketHealth && (
        <div className="px-6 pb-2">
          <div className={`rounded-lg px-3 py-2 text-xs border ${
            mhColor === 'green' ? 'bg-emerald-500/10 border-emerald-500/30 text-emerald-400' :
            mhColor === 'red'   ? 'bg-red-500/10 border-red-500/30 text-red-400' :
            'bg-amber-500/10 border-amber-500/30 text-amber-400'}`}>
            🌐 {marketHealth.reason} · SPY {marketHealth.spyChange >= 0 ? '+' : ''}{marketHealth.spyChange}% · QQQ {marketHealth.qqqChange >= 0 ? '+' : ''}{marketHealth.qqqChange}%
          </div>
        </div>
      )}

      {/* Tabs */}
      <div className="px-6 border-b border-gray-800 flex gap-0 overflow-x-auto">
        {TABS.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2.5 text-xs font-mono whitespace-nowrap border-b-2 transition-colors ${
              activeTab === tab.id ? 'border-emerald-500 text-emerald-400' : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}>
            {tab.label}
            {tab.count > 0 && <span className="ml-1.5 bg-emerald-600 text-white text-xs px-1.5 py-0.5 rounded-full">{tab.count}</span>}
          </button>
        ))}
      </div>

      {/* Content */}
      <div className="px-6 py-4">
        {/* Signals */}
        {activeTab === 'signals' && (
          <div className="space-y-2">
            {!isRunning && <div className="text-center text-gray-600 py-16">Press <span className="text-emerald-400">Start</span> to scan for runners</div>}
            {isRunning && signals.length === 0 && !loading && (
              <div className="text-center text-gray-600 py-16">
                No qualifying signals right now
                <p className="text-xs text-gray-700 mt-1">Runners need RVOL ≥{config?.minRvol}x + up ≥{config?.minChangePct}% with technical/squeeze/news confirmation</p>
              </div>
            )}
            {signals.map((signal, i) => (
              <SignalCard key={`${signal.symbol}-${i}`} signal={signal} index={i} onExecute={executeTrade} realMoneyMode={realMoneyMode} />
            ))}
          </div>
        )}

        {/* Building (anticipation tier — pre-run setups) */}
        {activeTab === 'building' && (
          <div className="space-y-2">
            <div className="text-xs text-gray-500 bg-gray-900/40 border border-gray-800 rounded-lg px-3 py-2 mb-1">
              🌱 <span className="text-emerald-400">Anticipated</span> — loaded squeeze fuel + fresh catalyst + coiling base, <span className="text-gray-300">not yet ignited</span>. Watch-only; these are setups <em>before</em> the run, not buy signals.
            </div>
            {building.length === 0 && (
              <div className="text-center text-gray-600 py-16">
                Nothing building right now
                <p className="text-xs text-gray-700 mt-1">Catalyst names that are coiling but haven't run yet will appear here</p>
              </div>
            )}
            {building.map((b) => <BuildingCard key={b.symbol} b={b} />)}
          </div>
        )}

        {/* Runners */}
        {activeTab === 'runners' && (
          <div className="space-y-2">
            {runners.length === 0 && <div className="text-center text-gray-600 py-16">No runners found — press Start</div>}
            {runners.map((runner) => <RunnerCard key={runner.symbol} runner={runner} />)}
            {runners.length > 0 && (
              <p className="text-gray-600 text-xs mt-3">
                Score bar: <span className="text-amber-400">RVOL</span> · <span className="text-emerald-400">Momentum</span> · <span className="text-sky-400">Technical</span> · <span className="text-violet-400">Float</span>
              </p>
            )}
          </div>
        )}

        {/* Sim */}
        {activeTab === 'sim' && (
          <div className="space-y-6">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard label="Sim Trades"    value={simStats.trades ?? 0} sub="Completed" color="cyan" />
              <StatCard label="Win Rate"      value={simStats.trades > 0 ? `${simStats.winRate}%` : '—'} color={simStats.winRate >= 50 ? 'green' : simStats.trades > 0 ? 'red' : 'yellow'} />
              <StatCard label="Total PnL"     value={`${(simStats.totalPnl ?? 0) >= 0 ? '+' : ''}$${(simStats.totalPnl ?? 0).toFixed(2)}`} color={(simStats.totalPnl ?? 0) >= 0 ? 'green' : 'red'} />
              <StatCard label="Profit Factor" value={simStats.profitFactor ?? 0} color={simStats.profitFactor >= 1.2 ? 'green' : 'yellow'} />
            </div>
            {simStats.byStrategy && Object.keys(simStats.byStrategy).length > 0 && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <p className="text-gray-400 text-xs uppercase tracking-wide mb-3">By Strategy</p>
                <div className="space-y-2">
                  {Object.entries(simStats.byStrategy).map(([strat, d]) => (
                    <div key={strat} className="flex items-center justify-between text-xs border-b border-gray-800 pb-2 last:border-0">
                      <span className="text-gray-300">{STRATEGY_LABELS[strat]?.label ?? strat}</span>
                      <div className="flex gap-2">
                        <Badge color={d.wins / d.count >= 0.5 ? 'green' : 'red'}>{((d.wins / d.count) * 100).toFixed(0)}% WR</Badge>
                        <Badge color={d.pnl >= 0 ? 'green' : 'red'}>{d.pnl >= 0 ? '+' : ''}${d.pnl.toFixed(2)}</Badge>
                        <Badge color="gray">{d.count} trades</Badge>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {(simData?.open?.length > 0) && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <p className="text-gray-400 text-xs uppercase tracking-wide mb-3">Open Sim Positions ({simData.open.length})</p>
                <div className="space-y-2">
                  {simData.open.map((pos, i) => (
                    <div key={i} className="flex items-center justify-between flex-wrap gap-2 border-b border-gray-800 pb-2 last:border-0">
                      <div className="flex items-center gap-2">
                        <Badge color="cyan">SIM</Badge>
                        <span className="text-white text-xs font-mono">{pos.symbol}</span>
                        <Badge color="gray">{pos.strategy}</Badge>
                      </div>
                      <div className="flex gap-3 text-xs text-gray-500">
                        <span>Entry ${pos.entryPrice?.toFixed(3)}</span>
                        <span className="text-emerald-400">TP ${pos.takeProfit?.toFixed(3)}</span>
                        <span className="text-red-400">SL ${pos.stopLoss?.toFixed(3)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* Trades */}
        {activeTab === 'trades' && (
          <div className="space-y-2">
            {trades.length === 0 && <div className="text-center text-gray-600 py-16">No trades yet</div>}
            {trades.map(t => (
              <div key={t.id} className="bg-gray-900 border border-gray-800 rounded-xl p-3 flex items-center justify-between flex-wrap gap-2">
                <div className="flex items-center gap-2">
                  <Badge color={t.status === 'OPEN' ? 'yellow' : t.status === 'SIMULATED' ? 'purple' : 'green'}>{t.status}</Badge>
                  <span className="text-gray-300 text-xs font-mono">{t.symbol}</span>
                  <Badge color="gray">{t.strategy}</Badge>
                  <Badge color="cyan">{(t.confidence * 100).toFixed(0)}%</Badge>
                </div>
                <span className="text-gray-600 text-xs">{t.timestamp}</span>
              </div>
            ))}
          </div>
        )}

        {/* Log */}
        {activeTab === 'log' && (
          <div className="space-y-1 max-h-[60vh] overflow-y-auto">
            {log.length === 0 && <div className="text-center text-gray-600 py-16">Log empty</div>}
            {log.map(l => (
              <div key={l.id} className={`rounded-lg px-3 py-2 text-xs flex gap-3 ${
                l.type === 'success' ? 'bg-emerald-500/10 text-emerald-400' :
                l.type === 'error'   ? 'bg-red-500/10 text-red-400' :
                l.type === 'warn'    ? 'bg-amber-500/10 text-amber-400' :
                'bg-gray-800/50 text-gray-400'}`}>
                <span className="text-gray-600 shrink-0">{l.time}</span>
                <span>{l.msg}</span>
              </div>
            ))}
          </div>
        )}

        {/* Config */}
        {activeTab === 'config' && config && (
          <div className="bg-gray-900 border border-gray-800 rounded-xl p-4 text-xs text-gray-500 space-y-1 max-w-lg">
            <p className="text-gray-300 font-bold mb-2">Active Config</p>
            <p>Broker: <span className="text-white">{config.broker?.broker} ({config.broker?.paper ? 'Paper' : 'Live'})</span></p>
            <p>Short interest: <span className="text-white">
              ORTEX {config.shortInterestProviders?.ortex ? '✅' : '❌'} · FINRA {config.shortInterestProviders?.finra ? '✅' : '❌'}
              {!config.shortInterestProviders?.anyRealData && <span className="text-amber-400"> (estimated — add keys for real SI)</span>}
            </span></p>
            <p>Price range: <span className="text-white">${config.priceRange?.[0]} – ${config.priceRange?.[1]}</span></p>
            <p>Min RVOL: <span className="text-white">{config.minRvol}x</span></p>
            <p>Min change: <span className="text-white">{config.minChangePct}%</span></p>
            <p>Min daily volume: <span className="text-white">{(config.minDailyVolume / 1e6).toFixed(1)}M shares</span></p>
            <p>Score weights: <span className="text-white">RVOL {config.scoreWeights?.rvol} · Mom {config.scoreWeights?.momentum} · Tech {config.scoreWeights?.technical} · Float {config.scoreWeights?.float}</span></p>
            <p>Stop loss: <span className="text-white">{(config.stopLossPct * 100).toFixed(0)}%</span> · Take profit: <span className="text-white">{(config.takeProfitPct * 100).toFixed(0)}%</span></p>
            <p>Capital/trade: <span className="text-white">${config.capitalPerTrade}</span> (max ${config.maxPositionSize})</p>
            <p>Max positions: <span className="text-white">{config.riskControls?.maxOpenPositions}</span> · Daily loss cap: <span className="text-white">${config.riskControls?.maxDailyLossUsd}</span></p>
            <p>Auto-execute ≥ <span className="text-white">{(config.autoExecuteThreshold * 100).toFixed(0)}%</span> confidence</p>
          </div>
        )}
      </div>
    </div>
  );
}
