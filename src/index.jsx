// ─────────────────────────────────────────────────────────────
// INDEX.JSX — ArbitrageAI + Quant Dashboard
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
  };
  return <span className={`px-2 py-0.5 rounded text-xs font-mono ${map[color] || map.gray}`}>{children}</span>;
};

const StatCard = ({ label, value, sub, color }) => {
  const c = color === 'green' ? 'text-emerald-400'
          : color === 'red'   ? 'text-red-400'
          : color === 'yellow'? 'text-amber-400'
          : color === 'cyan'  ? 'text-cyan-400'
          : 'text-white';
  return (
    <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
      <p className="text-gray-500 text-xs uppercase tracking-wide mb-1">{label}</p>
      <p className={`text-xl font-bold font-mono ${c}`}>{value}</p>
      {sub && <p className="text-gray-600 text-xs mt-1">{sub}</p>}
    </div>
  );
};

const RegimeBadge = ({ regime }) => {
  const map = {
    TRENDING_UP:   { color: 'green',  label: '↑ Trend Up'   },
    TRENDING_DOWN: { color: 'red',    label: '↓ Trend Down' },
    RANGING:       { color: 'blue',   label: '↔ Ranging'    },
    VOLATILE:      { color: 'yellow', label: '⚡ Volatile'   },
  };
  const r = map[regime] || { color: 'gray', label: regime || '?' };
  return <Badge color={r.color}>{r.label}</Badge>;
};

// ─── Arb opportunity card ─────────────────────────────────────
const ArbCard = ({ opp, index, onExecute, realMoneyMode, capitalPerTrade }) => {
  const isTri = opp.type === 'triangular';
  return (
    <div className="bg-gray-900 border border-gray-800 hover:border-gray-700 rounded-xl p-4 transition-colors">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="text-gray-600 text-xs w-5">#{index + 1}</span>
          <Badge color={isTri ? 'orange' : 'blue'}>{isTri ? '🔺 TRI' : '↔ CROSS'}</Badge>
          {isTri
            ? <span className="text-gray-300 text-xs font-mono">{opp.pairs?.join(' → ')}</span>
            : <><Badge color="blue">{opp.pair}</Badge>
               <span className="text-gray-400 text-xs">{opp.buyEx} → {opp.sellEx}</span></>
          }
        </div>
        <div className="flex items-center gap-2">
          <Badge color="green">+{opp.netPct}% net</Badge>
          <Badge color="gray">{opp.grossPct}% gross</Badge>
          <Badge color="red">-{opp.feesPct}% fees</Badge>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 md:grid-cols-4 gap-3 text-xs text-gray-500">
        {isTri
          ? <><span>Prices: <span className="text-white">{opp.prices?.map(p => `$${p}`).join(' / ')}</span></span>
               <span>Exchange: <span className="text-white">{opp.exchange}</span></span></>
          : <><span>Buy: <span className="text-white">${opp.ask?.toLocaleString()}</span></span>
               <span>Sell: <span className="text-white">${opp.bid?.toLocaleString()}</span></span></>
        }
        <span>Capital: <span className="text-white">${capitalPerTrade ?? 9}</span></span>
        <span>Est. profit: <span className="text-emerald-400">
          +${((opp.netPct / 100) * (capitalPerTrade ?? 9)).toFixed(4)}
        </span></span>
      </div>
      <div className="mt-3 flex items-center gap-2">
        <button onClick={() => onExecute(opp)}
          className={`px-3 py-1 rounded text-xs transition-colors ${
            realMoneyMode
              ? 'bg-red-600/20 hover:bg-red-600/40 border border-red-600/40 text-red-400'
              : 'bg-violet-600/20 hover:bg-violet-600/40 border border-violet-600/40 text-violet-400'
          }`}>
          {realMoneyMode ? '⚠️ Execute Real Trade' : '🔍 Simulate'}
        </button>
        <span className="text-gray-700 text-xs">{new Date(opp.timestamp).toLocaleTimeString()}</span>
      </div>
    </div>
  );
};

// ─── Signal card ──────────────────────────────────────────────
const SignalCard = ({ signal, index, onExecute, realMoneyMode }) => {
  const isPairs  = signal.strategy === 'pairs_trading';
  const isHold   = signal.type === 'HOLD';
  const isBuy    = signal.type === 'BUY';
  const confHigh = signal.confidence >= 0.65;
  const border   = isHold ? 'border-gray-800' : isBuy ? 'border-emerald-800/60' : 'border-red-800/60';

  return (
    <div className={`bg-gray-900 border ${border} hover:border-gray-600 rounded-xl p-4 transition-colors`}>
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-2">
          <span className="text-gray-600 text-xs w-5">#{index + 1}</span>
          <Badge color={
            signal.strategy === 'mean_reversion'   ? 'blue'   :
            signal.strategy === 'trend_following'  ? 'green'  :
            signal.strategy === 'pairs_trading'    ? 'purple' : 'gray'
          }>
            {signal.strategy === 'mean_reversion'  ? '↩ MR'    :
             signal.strategy === 'trend_following' ? '→ TREND' :
             signal.strategy === 'pairs_trading'   ? '⚖ PAIRS' : signal.strategy}
          </Badge>
          <span className="text-white text-xs font-mono font-bold">
            {isPairs ? signal.pair : signal.coin}
          </span>
          <Badge color={isBuy ? 'green' : isHold ? 'gray' : 'red'}>{signal.type}</Badge>
          {signal.regime && <RegimeBadge regime={signal.regime} />}
        </div>
        <div className="flex items-center gap-2">
          <Badge color={confHigh ? 'green' : 'yellow'}>
            {(signal.confidence * 100).toFixed(0)}% conf
          </Badge>
          <span className="text-gray-600 text-xs">{new Date(signal.timestamp).toLocaleTimeString()}</span>
        </div>
      </div>

      {/* Indicator readings */}
      {signal.indicators && (
        <div className="mt-2 flex flex-wrap gap-3 text-xs text-gray-500">
          {signal.indicators.rsi      != null && (
            <span>RSI <span className={signal.indicators.rsi < 35 ? 'text-emerald-400' : signal.indicators.rsi > 65 ? 'text-red-400' : 'text-white'}>
              {signal.indicators.rsi}
            </span></span>
          )}
          {signal.indicators.bbPctB   != null && <span>BB% <span className="text-white">{signal.indicators.bbPctB}</span></span>}
          {signal.indicators.macdHist != null && (
            <span>MACD <span className={signal.indicators.macdHist > 0 ? 'text-emerald-400' : 'text-red-400'}>
              {signal.indicators.macdHist > 0 ? '▲' : '▼'} {signal.indicators.macdHist}
            </span></span>
          )}
          {signal.indicators.volRatio != null && <span>Vol <span className={signal.indicators.volRatio > 1.5 ? 'text-amber-400' : 'text-white'}>{signal.indicators.volRatio}x</span></span>}
          {signal.price               != null && <span>Price <span className="text-white">${signal.price?.toLocaleString()}</span></span>}
        </div>
      )}

      {/* Pairs trading z-score */}
      {isPairs && signal.zScore != null && (
        <div className="mt-2 text-xs text-gray-500">
          Z-Score: <span className={Math.abs(signal.zScore) > 2.5 ? 'text-amber-400' : 'text-white'}>{signal.zScore}</span>
          <span className="ml-3 text-gray-600">{signal.action}</span>
        </div>
      )}

      {/* Reasons */}
      {signal.reasons?.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1">
          {signal.reasons.map((r, i) => (
            <span key={i} className="text-gray-600 text-xs bg-gray-800 px-2 py-0.5 rounded">{r}</span>
          ))}
        </div>
      )}

      {/* TP/SL */}
      {(signal.takeProfit || signal.stopLoss) && (
        <div className="mt-2 flex gap-4 text-xs">
          {signal.takeProfit && <span className="text-gray-500">TP: <span className="text-emerald-400">${signal.takeProfit?.toLocaleString()}</span></span>}
          {signal.stopLoss   && <span className="text-gray-500">SL: <span className="text-red-400">${signal.stopLoss?.toLocaleString()}</span></span>}
        </div>
      )}

      {/* Execute button — only for BUY signals with high confidence */}
      {isBuy && !isPairs && confHigh && (
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

// ─── Quant tab ────────────────────────────────────────────────
const QuantTab = ({ quantData, onExecute, realMoneyMode }) => {
  if (!quantData) return (
    <div className="text-center text-gray-600 py-16">
      Press <span className="text-cyan-400">Start</span> to begin quant scanning
    </div>
  );

  const { signals = [], regimes = {}, openPositions = [], stats = {}, coinsScanned } = quantData;
  const actionable = signals.filter(s => s.type === 'BUY' || s.type === 'SELL');
  const hold       = signals.filter(s => s.type === 'HOLD');

  return (
    <div className="space-y-6">
      {/* Regime overview grid */}
      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-3">Market Regimes — {coinsScanned} coins</p>
        <div className="grid grid-cols-3 md:grid-cols-5 gap-2">
          {Object.entries(regimes).map(([coin, r]) => (
            <div key={coin} className="bg-gray-900 border border-gray-800 rounded-lg p-2 text-center">
              <p className="text-white text-xs font-mono font-bold">{coin}</p>
              <div className="mt-1 flex justify-center"><RegimeBadge regime={r.regime} /></div>
              <p className="text-gray-600 text-xs mt-1">ADX {r.adx}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Stats row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard label="Quant Trades"  value={stats.trades ?? 0}    sub="Executed"                color="cyan" />
        <StatCard label="Win Rate"      value={stats.winRate ? `${stats.winRate}%` : '—'} sub="Signal accuracy" color={stats.winRate >= 60 ? 'green' : stats.trades > 0 ? 'red' : 'yellow'} />
        <StatCard label="Total P&L"     value={`${(stats.totalPnl ?? 0) >= 0 ? '+' : ''}$${(stats.totalPnl ?? 0).toFixed(4)}`} color={(stats.totalPnl ?? 0) >= 0 ? 'green' : 'red'} />
        <StatCard label="Open Positions" value={openPositions.length} sub="Active trades"           color={openPositions.length > 0 ? 'yellow' : 'gray'} />
      </div>

      {/* Open positions */}
      {openPositions.length > 0 && (
        <div>
          <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Open Positions</p>
          <div className="space-y-2">
            {openPositions.map((pos, i) => {
              const ageMins = Math.round((Date.now() - pos.openedAt) / 60000);
              return (
                <div key={i} className="bg-gray-900 border border-amber-800/40 rounded-xl p-3 flex items-center justify-between flex-wrap gap-2">
                  <div className="flex items-center gap-2">
                    <Badge color="yellow">OPEN</Badge>
                    <span className="text-white text-xs font-mono">{pos.coin}/USDT</span>
                    <Badge color="gray">{pos.strategy}</Badge>
                  </div>
                  <div className="flex gap-3 text-xs text-gray-500">
                    <span>Entry: <span className="text-white">${pos.entryPrice}</span></span>
                    <span>Size: <span className="text-white">${pos.tradeUSD}</span></span>
                    <span>TP: <span className="text-emerald-400">${pos.takeProfit}</span></span>
                    <span>SL: <span className="text-red-400">${pos.stopLoss}</span></span>
                    <span className="text-gray-600">{ageMins}m ago</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Actionable signals */}
      <div>
        <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">
          Actionable Signals ({actionable.length})
          <span className="ml-2 text-gray-600 normal-case">≥65% confidence = auto-execute eligible</span>
        </p>
        {actionable.length === 0 && (
          <div className="text-center text-gray-700 py-8 bg-gray-900 border border-gray-800 rounded-xl">
            No actionable signals right now — market conditions don't meet thresholds
          </div>
        )}
        <div className="space-y-2">
          {actionable.map((signal, i) => (
            <SignalCard key={i} signal={signal} index={i} onExecute={onExecute} realMoneyMode={realMoneyMode} />
          ))}
        </div>
      </div>

      {/* Hold signals (collapsed) */}
      {hold.length > 0 && (
        <details className="group">
          <summary className="text-gray-600 text-xs cursor-pointer hover:text-gray-400 select-none">
            ▶ {hold.length} HOLD signals (regime-based — no action)
          </summary>
          <div className="space-y-2 mt-2">
            {hold.map((signal, i) => (
              <SignalCard key={i} signal={signal} index={i} onExecute={onExecute} realMoneyMode={realMoneyMode} />
            ))}
          </div>
        </details>
      )}
    </div>
  );
};

// ─── Intelligence tab ─────────────────────────────────────────
const IntelligenceTab = ({ intelligence }) => {
  if (!intelligence) return (
    <div className="text-gray-600 text-center py-16">
      No intelligence data yet — let the bot scan for a few minutes.
    </div>
  );
  const { topCycles, hourlyActivity } = intelligence;
  const maxHits = Math.max(...(hourlyActivity?.map(h => h.hits) ?? [1]), 1);
  return (
    <div className="space-y-6">
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <p className="text-gray-400 text-xs uppercase tracking-wide mb-3">📊 Hourly Arb Activity</p>
        <div className="flex items-end gap-1 h-16">
          {(hourlyActivity ?? []).map(({ hour, hits }) => (
            <div key={hour} className="flex-1 flex flex-col items-center gap-1">
              <div className="w-full bg-emerald-500/40 rounded-sm" style={{ height: `${Math.max((hits / maxHits) * 100, 2)}%` }} title={`${hour}:00 — ${hits} hits`} />
              {hour % 4 === 0 && <span className="text-gray-600 text-xs">{hour}</span>}
            </div>
          ))}
        </div>
        <p className="text-gray-600 text-xs mt-2">Hour of day (UTC)</p>
      </div>
      <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
        <p className="text-gray-400 text-xs uppercase tracking-wide mb-3">🏆 Top Triangular Cycles (ML Score)</p>
        {(!topCycles || topCycles.length === 0) && <p className="text-gray-600 text-xs">Collecting data — needs 10 scans per cycle minimum.</p>}
        <div className="space-y-2">
          {(topCycles ?? []).map((c, i) => (
            <div key={c.id} className="flex items-center justify-between flex-wrap gap-2 border-b border-gray-800 pb-2 last:border-0">
              <div className="flex items-center gap-2">
                <span className="text-gray-600 text-xs w-4">#{i + 1}</span>
                <span className="text-orange-400 text-xs font-mono">{c.id}</span>
              </div>
              <div className="flex items-center gap-2 flex-wrap">
                <Badge color="yellow">score {c.score}</Badge>
                <Badge color="green">avg {c.avgSpread}%</Badge>
                <Badge color="blue">hit {c.hitRate}%</Badge>
                <span className="text-gray-600 text-xs">{c.scans} scans · last: {c.lastHit}</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// ─── Main app ─────────────────────────────────────────────────
export default function ArbitrageAgent() {
  const [config, setConfig]               = useState(null);
  const [opportunities, setOpportunities] = useState([]);
  const [crossCount, setCrossCount]       = useState(0);
  const [triCount, setTriCount]           = useState(0);
  const [balances, setBalances]           = useState({});
  const [exchangeStatus, setExchangeStatus] = useState({});
  const [arbTrades, setArbTrades]         = useState([]);
  const [quantTrades, setQuantTrades]     = useState([]);
  const [log, setLog]                     = useState([]);
  const [intelligence, setIntelligence]   = useState(null);
  const [quantData, setQuantData]         = useState(null);
  const [backtestData, setBacktestData]   = useState(null);
  const [backtestLoading, setBacktestLoading] = useState(false);
  const [simData, setSimData]             = useState(null);
  const [isRunning, setIsRunning]         = useState(false);
  const [realMoneyMode, setRealMoneyMode] = useState(false);
  const [activeTab, setActiveTab]         = useState('quant');
  const [lastArbScan, setLastArbScan]     = useState(null);
  const [lastQuantScan, setLastQuantScan] = useState(null);
  const [arbLoading, setArbLoading]       = useState(false);
  const [quantLoading, setQuantLoading]   = useState(false);
  const [arbStats, setArbStats]           = useState({ totalTrades: 0, wins: 0, totalPnl: 0 });
  const arbIntervalRef                     = useRef(null);
  const quantIntervalRef                   = useRef(null);
  const intelligenceIntervalRef            = useRef(null);
  const lastSignalKeyRef                   = useRef('');

  const addLog = useCallback((msg, type = 'info') => {
    setLog(prev => [{ id: Date.now() + Math.random(), msg, type, time: new Date().toLocaleTimeString() }, ...prev].slice(0, 150));
  }, []);

  // Load config on mount
  useEffect(() => {
    api.get('/api/config')
      .then(cfg => { setConfig(cfg); addLog(`⚙️ Config loaded — ${cfg.pairs.length} arb pairs, ${cfg.trackedCoins?.length ?? 9} quant coins`, 'info'); })
      .catch(() => addLog('❌ Backend unreachable. Is server.js running?', 'error'));
    fetchBalances();
    fetchStatus();
  }, []);

  const fetchBalances = useCallback(async () => {
    try { setBalances(await api.get('/api/balances')); } catch {}
  }, []);

  const fetchStatus = useCallback(async () => {
    try { setExchangeStatus(await api.get('/api/status')); } catch {}
  }, []);

  const fetchIntelligence = useCallback(async () => {
    try { setIntelligence(await api.get('/api/intelligence')); } catch {}
  }, []);

  const fetchSimData = useCallback(async () => {
    try {
      const data = await api.get('/api/quant/sim');
      setSimData(prev => ({ ...prev, ...data, openSimPositions: data.open }));
    } catch {}
  }, []);

  // ─── Arb scan ───────────────────────────────────────────────
  const runArbScan = useCallback(async () => {
    setArbLoading(true);
    try {
      const data = await api.get('/api/scan');
      setOpportunities(data.opportunities ?? []);
      setCrossCount(data.crossCount ?? 0);
      setTriCount(data.triCount ?? 0);
      setLastArbScan(data.scannedAt);
      if (data.opportunities?.length > 0) {
        const best = data.opportunities[0];
        addLog(`↔ Arb: ${data.opportunities.length} opp — best ${best.type === 'triangular' ? best.id : best.pair} +${best.netPct}%`, 'success');
      }
    } catch (err) {
      addLog(`❌ Arb scan error: ${err.message}`, 'error');
    } finally {
      setArbLoading(false);
    }
  }, [addLog]);

  // ─── Quant scan ─────────────────────────────────────────────
  const runQuantScan = useCallback(async () => {
    setQuantLoading(true);
    try {
      const data = await api.get('/api/quant/signals');
      setQuantData(data);
      setLastQuantScan(data.scannedAt);
      if (data.simStats) setSimData(data);

      const actionable = (data.signals ?? []).filter(s => s.type === 'BUY' || s.type === 'SELL');
      const newSignalKey = actionable.map(s => `${s.coin ?? s.pair}-${s.type}-${s.strategy}`).join(',');

      if (actionable.length > 0 && newSignalKey !== lastSignalKeyRef.current) {
        lastSignalKeyRef.current = newSignalKey;
        const best = actionable[0];
        addLog(`🧠 Quant: ${actionable.length} signal${actionable.length > 1 ? 's' : ''} — ${best.coin ?? best.pair} ${best.type} ${best.strategy} (${(best.confidence * 100).toFixed(0)}% conf)`, 'success');

        // Reset signal key when no actionable signals
      if (actionable.length === 0) lastSignalKeyRef.current = '';

      // Auto-execute HIGH confidence BUY signals in real money mode
        if (realMoneyMode && best.type === 'BUY' && best.confidence >= 0.65 && best.strategy !== 'pairs_trading') {
          addLog(`🤖 Auto-executing quant signal: ${best.coin} BUY (${(best.confidence * 100).toFixed(0)}% conf)`, 'warn');
          executeQuantTrade(best, true);
        }
      }

      // Log closed positions
      if (data.closedPositions?.length > 0) {
        for (const cp of data.closedPositions) {
          const pnlStr = cp.pnlUSD >= 0 ? `+$${cp.pnlUSD.toFixed(4)}` : `-$${Math.abs(cp.pnlUSD).toFixed(4)}`;
          addLog(`🔄 ${cp.coin} closed — ${cp.reason} | PnL: ${pnlStr}`, cp.pnlUSD >= 0 ? 'success' : 'error');
        }
      }
    } catch (err) {
      addLog(`❌ Quant scan error: ${err.message}`, 'error');
    } finally {
      setQuantLoading(false);
    }
  }, [realMoneyMode, addLog]);

  // ─── Scanning loop ───────────────────────────────────────────
  useEffect(() => {
    if (isRunning) {
      const interval = config?.scanIntervalMs ?? 4000;
      // Arb: every scan interval
      runArbScan();
      arbIntervalRef.current = setInterval(() => { runArbScan(); fetchBalances(); }, interval);
      // Quant: every 60s (candles are 1h, no need to scan faster)
      runQuantScan();
      quantIntervalRef.current = setInterval(runQuantScan, 60000);
      // Intelligence: every 30s
      // Intelligence: every 30s
      fetchIntelligence();
      intelligenceIntervalRef.current = setInterval(fetchIntelligence, 30000);
      // Sim data: every 60s
      fetchSimData();
      setInterval(fetchSimData, 60000);
    } else {
      clearInterval(arbIntervalRef.current);
      clearInterval(quantIntervalRef.current);
      clearInterval(intelligenceIntervalRef.current);
    }
    return () => {
      clearInterval(arbIntervalRef.current);
      clearInterval(quantIntervalRef.current);
      clearInterval(intelligenceIntervalRef.current);
    };
  }, [isRunning, runArbScan, runQuantScan, fetchBalances, fetchIntelligence, config]);

  // ─── Execute arb trade ───────────────────────────────────────
  const executeArbTrade = useCallback(async (opp, autoConfirmed = false) => {
    const label = opp.type === 'triangular' ? opp.id : opp.pair;
    if (!realMoneyMode) {
      addLog(`🔍 SIM (arb): ${label} +${opp.netPct}%`, 'warn');
      setArbTrades(prev => [{ id: Date.now(), label, type: opp.type, status: 'SIMULATED', netPct: opp.netPct, pnl: null, timestamp: new Date().toLocaleTimeString() }, ...prev].slice(0, 100));
      return;
    }
    const confirmed = autoConfirmed || window.confirm(`⚠️ REAL ARB TRADE\n${label} +${opp.netPct}% net\nContinue?`);
    if (!confirmed) return;
    addLog(`⚠️ LIVE ARB: ${label} +${opp.netPct}%`, 'error');
    try {
      const result = await api.post('/api/execute', { opportunity: opp, confirmed: true });
      if (result.success) {
        addLog(`✅ Arb success: +$${result.netProfit?.toFixed(4)}`, 'success');
        setArbStats(prev => ({ totalTrades: prev.totalTrades + 1, wins: prev.wins + 1, totalPnl: +(prev.totalPnl + result.netProfit).toFixed(4) }));
        setArbTrades(prev => [{ id: Date.now(), label, type: opp.type, status: 'FILLED', netPct: opp.netPct, pnl: result.netProfit, timestamp: new Date().toLocaleTimeString() }, ...prev].slice(0, 100));
        fetchBalances();
      } else {
        addLog(`❌ Arb failed: ${result.reason}`, 'error');
        if (result.URGENT) addLog('🚨 URGENT: Check exchanges — buy order may be open!', 'error');
        setArbTrades(prev => [{ id: Date.now(), label, type: opp.type, status: 'FAILED', netPct: opp.netPct, pnl: null, timestamp: new Date().toLocaleTimeString() }, ...prev].slice(0, 100));
      }
    } catch (err) {
      addLog(`❌ Arb execute error: ${err.message}`, 'error');
    }
  }, [realMoneyMode, addLog, fetchBalances]);

  // ─── Execute quant trade ─────────────────────────────────────
  const executeQuantTrade = useCallback(async (signal, autoConfirmed = false) => {
    const label = signal.coin ?? signal.pair;
    if (!realMoneyMode) {
      addLog(`🔍 SIM (quant): ${label} ${signal.type} via ${signal.strategy} (${(signal.confidence * 100).toFixed(0)}% conf)`, 'warn');
      setQuantTrades(prev => [{ id: Date.now(), label, strategy: signal.strategy, type: signal.type, status: 'SIMULATED', confidence: signal.confidence, pnl: null, timestamp: new Date().toLocaleTimeString() }, ...prev].slice(0, 100));
      return;
    }
    const confirmed = autoConfirmed || window.confirm(`⚠️ REAL QUANT TRADE\n${label} ${signal.type}\nStrategy: ${signal.strategy}\nConfidence: ${(signal.confidence * 100).toFixed(0)}%\nEntry: $${signal.price}\nTP: $${signal.takeProfit} | SL: $${signal.stopLoss}\nContinue?`);
    if (!confirmed) return;
    addLog(`⚠️ LIVE QUANT: ${label} ${signal.type} ${signal.strategy}`, 'error');
    try {
      const result = await api.post('/api/quant/execute', { signal, confirmed: true });
      if (result.success) {
        addLog(`✅ Quant position opened: ${label} $${result.tradeUSD}`, 'success');
        setQuantTrades(prev => [{ id: Date.now(), label, strategy: signal.strategy, type: signal.type, status: 'OPEN', confidence: signal.confidence, pnl: null, timestamp: new Date().toLocaleTimeString() }, ...prev].slice(0, 100));
        fetchBalances();
        setTimeout(runQuantScan, 2000); // Refresh positions
      } else {
        addLog(`❌ Quant failed: ${result.reason}`, 'error');
      }
    } catch (err) {
      addLog(`❌ Quant execute error: ${err.message}`, 'error');
    }
  }, [realMoneyMode, addLog, fetchBalances, runQuantScan]);

  const handleEmergencyStop = async () => {
    setIsRunning(false); setRealMoneyMode(false);
    [arbIntervalRef, quantIntervalRef, intelligenceIntervalRef].forEach(r => clearInterval(r.current));
    addLog('🛑 EMERGENCY STOP — check your exchanges immediately!', 'error');
    try { await api.post('/api/emergency-stop', {}); } catch {}
  };

  const exchanges    = config?.exchanges ?? ['BinanceUS', 'Kraken', 'Coinbase'];
  const totalBalance = Object.values(balances).reduce((s, v) => s + (v || 0), 0);
  const arbWinRate   = arbStats.totalTrades > 0 ? ((arbStats.wins / arbStats.totalTrades) * 100).toFixed(1) : '—';
  const quantStats   = quantData?.stats ?? {};

  const TABS = [
    { id: 'sim',           label: '📋 Sim Results',   count: simData?.simStats?.trades || null },
    { id: 'quant',         label: '🧠 Quant',        count: (quantData?.signals ?? []).filter(s => s.type === 'BUY' || s.type === 'SELL').length || null },
    { id: 'opportunities', label: '↔ Arb',             count: opportunities.length || null },
    { id: 'triangular',    label: '🔺 Triangular',     count: triCount > 0 ? triCount : null },
    { id: 'intelligence',  label: '📊 Intelligence',   count: null },
    { id: 'backtest',      label: '🔬 Backtest',       count: null },
    { id: 'trades',        label: 'Trades',            count: (arbTrades.length + quantTrades.length) || null },
    { id: 'log',           label: 'Log',               count: null },
    { id: 'status',        label: 'Status',            count: null },
  ];

  const shownArbOpps = activeTab === 'triangular'
    ? opportunities.filter(o => o.type === 'triangular')
    : opportunities;

  return (
    <div className="bg-gray-950 min-h-screen text-white font-mono text-sm">

      {/* ── Header ─────────────────────────────────────────── */}
      <div className="border-b border-gray-800 px-6 py-4">
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-base font-bold tracking-tight">
              ⚡ ArbitrageAI
              <span className="ml-2 text-xs text-gray-500 font-normal">
                {config ? `Arb: ${config.arbExchanges?.join(' ↔ ')} · Quant: ${config.trackedCoins?.length ?? 9} coins` : 'Connecting...'}
              </span>
            </h1>
            <p className="text-gray-600 text-xs mt-0.5">
              {lastArbScan && `Arb: ${new Date(lastArbScan).toLocaleTimeString()}`}
              {lastQuantScan && ` · Quant: ${new Date(lastQuantScan).toLocaleTimeString()}`}
              {(arbLoading || quantLoading) && <span className="ml-2 text-amber-400 animate-pulse">● Scanning...</span>}
            </p>
          </div>
          <div className="flex gap-2 items-center flex-wrap">
            <button
              onClick={() => {
                if (!realMoneyMode) {
                  if (window.confirm('⚠️ WARNING: This enables REAL trades with real money.\n\nAre you sure?')) {
                    setRealMoneyMode(true);
                    addLog('🔴 REAL MONEY MODE ON — arb + quant trades will execute', 'error');
                  }
                } else {
                  setRealMoneyMode(false);
                  addLog('🟡 Real money mode off', 'warn');
                }
              }}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-lg border text-xs transition-all ${
                realMoneyMode ? 'bg-red-500/20 border-red-500/50 text-red-400 animate-pulse' : 'bg-gray-800 border-gray-700 text-gray-400'
              }`}
            >
              <span className={`w-2 h-2 rounded-full ${realMoneyMode ? 'bg-red-400' : 'bg-gray-600'}`} />
              {realMoneyMode ? '⚠️ REAL MONEY' : 'Simulation'}
            </button>
            {realMoneyMode && (
              <button onClick={handleEmergencyStop} className="px-3 py-1.5 rounded-lg bg-red-700 hover:bg-red-600 border border-red-600 text-white text-xs font-bold">
                🛑 STOP
              </button>
            )}
            <button
              onClick={() => {
                const next = !isRunning;
                setIsRunning(next);
                addLog(next ? '🚀 Scanning started — arb + quant' : '⏸ Paused', next ? 'success' : 'warn');
              }}
              className={`px-4 py-1.5 rounded-lg text-xs font-bold transition-colors ${isRunning ? 'bg-amber-600 hover:bg-amber-500' : 'bg-emerald-700 hover:bg-emerald-600'} text-white`}
            >
              {isRunning ? '⏸ Pause' : '▶ Start'}
            </button>
          </div>
        </div>
      </div>

      {/* ── Stats ──────────────────────────────────────────── */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 px-6 py-4">
        <StatCard label="Total Balance"  value={`$${totalBalance.toFixed(2)}`}  sub={`${exchanges.length} exchanges`} color={totalBalance > 0 ? 'green' : 'yellow'} />
        <StatCard label="Arb P&L"        value={`${arbStats.totalPnl >= 0 ? '+' : ''}$${arbStats.totalPnl.toFixed(4)}`} sub={`${arbStats.totalTrades} arb trades`} color={arbStats.totalPnl >= 0 ? 'green' : 'red'} />
        <StatCard label="Quant P&L"      value={`${(quantStats.totalPnl ?? 0) >= 0 ? '+' : ''}$${(quantStats.totalPnl ?? 0).toFixed(4)}`} sub={`${quantStats.trades ?? 0} quant trades`} color={(quantStats.totalPnl ?? 0) >= 0 ? 'cyan' : 'red'} />
        <StatCard label="Mode"           value={realMoneyMode ? '🔴 LIVE' : '🟡 Sim'} sub={isRunning ? 'Scanning...' : 'Paused'} color={realMoneyMode ? 'red' : 'yellow'} />
      </div>
      <div className="grid gap-3 px-6 pb-4" style={{ gridTemplateColumns: `repeat(${exchanges.length}, 1fr)` }}>
        {exchanges.map(ex => (
          <StatCard key={ex} label={ex} value={`$${(balances[ex] ?? 0).toFixed(2)}`} sub="USDT" />
        ))}
      </div>

      {/* ── Tabs ───────────────────────────────────────────── */}
      <div className="px-6 border-b border-gray-800 flex gap-0 overflow-x-auto">
        {TABS.map(tab => (
          <button key={tab.id} onClick={() => setActiveTab(tab.id)}
            className={`px-4 py-2.5 text-xs font-mono whitespace-nowrap border-b-2 transition-colors ${
              activeTab === tab.id ? 'border-emerald-500 text-emerald-400' : 'border-transparent text-gray-500 hover:text-gray-300'
            }`}
          >
            {tab.label}
            {tab.count > 0 && <span className="ml-1.5 bg-emerald-600 text-white text-xs px-1.5 py-0.5 rounded-full">{tab.count}</span>}
          </button>
        ))}
      </div>

      {/* ── Tab content ────────────────────────────────────── */}
      <div className="px-6 py-4">

        {/* Sim Results */}
        {activeTab === 'sim' && (
          <div className="space-y-6">
            {/* Sim stats summary */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard label="Sim Trades"    value={simData?.simStats?.trades ?? 0}       sub="Completed"          color="cyan" />
              <StatCard label="Sim Win Rate"  value={simData?.simStats?.trades > 0 ? `${simData.simStats.winRate}%` : '—'} color={simData?.simStats?.winRate >= 50 ? 'green' : simData?.simStats?.trades > 0 ? 'red' : 'yellow'} />
              <StatCard label="Sim PnL"       value={`${(simData?.simStats?.totalPnl ?? 0) >= 0 ? '+' : ''}$${(simData?.simStats?.totalPnl ?? 0).toFixed(4)}`} color={(simData?.simStats?.totalPnl ?? 0) >= 0 ? 'green' : 'red'} />
              <StatCard label="Profit Factor" value={simData?.simStats?.profitFactor ?? 0} color={simData?.simStats?.profitFactor >= 1.2 ? 'green' : 'yellow'} />
            </div>

            {/* Exit reason breakdown */}
            {simData?.simStats?.byExitReason && Object.keys(simData.simStats.byExitReason).length > 0 && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <p className="text-gray-400 text-xs uppercase tracking-wide mb-3">Exit Reasons</p>
                <div className="flex gap-6 flex-wrap">
                  {Object.entries(simData.simStats.byExitReason).map(([reason, data]) => (
                    <div key={reason} className="text-xs">
                      <span className="text-gray-400">{reason}: </span>
                      <span className="text-white">{data.count} </span>
                      <span className={data.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>
                        {data.pnl >= 0 ? '+' : ''}${data.pnl.toFixed(4)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Open sim positions */}
            {(simData?.openSimPositions?.length > 0) && (
              <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                <p className="text-gray-400 text-xs uppercase tracking-wide mb-3">
                  Open Sim Positions ({simData.openSimPositions.length})
                </p>
                <div className="space-y-2">
                  {simData.openSimPositions.map((pos, i) => {
                    const ageMins = Math.round((Date.now() - pos.openedAt) / 60000);
                    return (
                      <div key={i} className="flex items-center justify-between flex-wrap gap-2 border-b border-gray-800 pb-2 last:border-0">
                        <div className="flex items-center gap-2">
                          <Badge color="cyan">SIM</Badge>
                          <span className="text-white text-xs font-mono">{pos.coin}</span>
                          <Badge color="gray">{pos.strategy}</Badge>
                          <Badge color={pos.confidence >= 0.75 ? 'green' : 'yellow'}>
                            {(pos.confidence * 100).toFixed(0)}% conf
                          </Badge>
                        </div>
                        <div className="flex gap-3 text-xs text-gray-500">
                          <span>Entry: <span className="text-white">${pos.entryPrice}</span></span>
                          <span>TP: <span className="text-emerald-400">${pos.takeProfit}</span></span>
                          <span>SL: <span className="text-red-400">${pos.stopLoss}</span></span>
                          <span className="text-gray-600">{ageMins}m open</span>
                        </div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Completed sim trades */}
            <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
              <p className="text-gray-400 text-xs uppercase tracking-wide mb-3">
                Completed Sim Trades
                <span className="ml-2 text-gray-600 normal-case">
                  Compare win rate here vs backtest 47.6% to validate the strategy
                </span>
              </p>
              {(!simData?.simStats?.trades || simData.simStats.trades === 0) && (
                <div className="text-center text-gray-600 py-8">
                  No completed sim trades yet — signals need to open and then hit TP, SL, or 48h timeout
                </div>
              )}
              <div className="space-y-2">
                {(simData?.history ?? []).map((t, i) => (
                  <div key={i} className={`border rounded-xl p-3 flex items-center justify-between flex-wrap gap-2 ${t.won ? 'border-emerald-800/40 bg-emerald-900/10' : 'border-red-800/40 bg-red-900/10'}`}>
                    <div className="flex items-center gap-2">
                      <Badge color={t.won ? 'green' : 'red'}>{t.exitReason}</Badge>
                      <span className="text-white text-xs font-mono">{t.coin}</span>
                      <Badge color="gray">{t.strategy}</Badge>
                      <Badge color={t.confidence >= 0.75 ? 'green' : 'yellow'}>
                        {(t.confidence * 100).toFixed(0)}% conf
                      </Badge>
                    </div>
                    <div className="flex gap-3 text-xs">
                      <span className={`font-mono font-bold ${t.won ? 'text-emerald-400' : 'text-red-400'}`}>
                        {t.netPnl >= 0 ? '+' : ''}${t.netPnl.toFixed(4)} ({t.netPct.toFixed(2)}%)
                      </span>
                      <span className="text-gray-500">Entry ${t.entryPrice}</span>
                      <span className="text-gray-500">Exit ${t.exitPrice}</span>
                      <span className="text-gray-600">{t.holdHours}h held</span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {!isRunning && (
              <div className="text-center text-gray-600 py-8">
                Press <span className="text-emerald-400">Start</span> to begin sim tracking
              </div>
            )}
          </div>
        )}

        {/* Quant */}
        {activeTab === 'quant' && (
          <QuantTab quantData={quantData} onExecute={executeQuantTrade} realMoneyMode={realMoneyMode} />
        )}

        {/* Arb + Triangular */}
        {(activeTab === 'opportunities' || activeTab === 'triangular') && (
          <div className="space-y-2">
            {!isRunning && <div className="text-center text-gray-600 py-16">Press <span className="text-emerald-400">Start</span> to scan</div>}
            {isRunning && shownArbOpps.length === 0 && !arbLoading && (
              <div className="text-center text-gray-600 py-16">
                No opportunities above {((config?.minProfitThreshold ?? 0.001) * 100).toFixed(1)}% threshold
                <p className="text-xs text-gray-700 mt-1">
                  {activeTab === 'triangular'
                    ? 'Triangular cycles need ~10 scans to warm up the ML ranker.'
                    : 'Cross-exchange: BinanceUS ↔ Kraken. Coinbase excluded (high fees).'}
                </p>
              </div>
            )}
            {shownArbOpps.map((opp, i) => (
              <ArbCard key={`${opp.id ?? opp.pair}-${i}`} opp={opp} index={i}
                onExecute={executeArbTrade} realMoneyMode={realMoneyMode} capitalPerTrade={config?.capitalPerTrade} />
            ))}
          </div>
        )}

        {/* Intelligence */}
        {activeTab === 'intelligence' && <IntelligenceTab intelligence={intelligence} />}

        {/* Backtest */}
        {activeTab === 'backtest' && (
          <div className="space-y-6">
            <div className="flex items-center justify-between">
              <div>
                <p className="text-white text-sm font-bold">Strategy Backtest</p>
                <p className="text-gray-500 text-xs mt-1">Runs signal engine against {500} × 4h candles (~83 days). Takes 15-30 seconds.</p>
              </div>
              <button
                onClick={async () => {
                  setBacktestLoading(true);
                  addLog('🔬 Running backtest — this takes ~20 seconds...', 'info');
                  try {
                    const data = await api.get('/api/backtest');
                    setBacktestData(data);
                    addLog(`✅ Backtest complete — ${data.totalTrades} trades, ${data.portfolioStats?.winRate}% win rate`, 'success');
                  } catch (err) {
                    addLog(`❌ Backtest failed: ${err.message}`, 'error');
                  } finally {
                    setBacktestLoading(false);
                  }
                }}
                disabled={backtestLoading}
                className="px-4 py-2 bg-cyan-700 hover:bg-cyan-600 disabled:bg-gray-700 disabled:text-gray-500 rounded-lg text-xs font-bold text-white transition-colors"
              >
                {backtestLoading ? '⏳ Running...' : '▶ Run Backtest'}
              </button>
            </div>

            {!backtestData && !backtestLoading && (
              <div className="text-center text-gray-600 py-16 bg-gray-900 border border-gray-800 rounded-xl">
                Click Run Backtest to test the strategy against historical data
              </div>
            )}

            {backtestLoading && (
              <div className="text-center text-cyan-400 py-16 bg-gray-900 border border-gray-800 rounded-xl animate-pulse">
                ⏳ Running backtest across {9} coins × 500 candles...
              </div>
            )}

            {backtestData && (
              <div className="space-y-6">
                {/* Portfolio summary */}
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                  <p className="text-gray-400 text-xs uppercase tracking-wide mb-3">Portfolio Summary — {backtestData.totalTrades} trades · {backtestData.duration}</p>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    <StatCard label="Win Rate"      value={`${backtestData.portfolioStats?.winRate ?? 0}%`}  color={backtestData.portfolioStats?.winRate >= 50 ? 'green' : 'red'} />
                    <StatCard label="Total PnL"     value={`${(backtestData.portfolioStats?.totalPnl ?? 0) >= 0 ? '+' : ''}$${(backtestData.portfolioStats?.totalPnl ?? 0).toFixed(4)}`} color={(backtestData.portfolioStats?.totalPnl ?? 0) >= 0 ? 'green' : 'red'} />
                    <StatCard label="Profit Factor" value={backtestData.portfolioStats?.profitFactor ?? 0}   color={backtestData.portfolioStats?.profitFactor >= 1.2 ? 'green' : 'red'} />
                    <StatCard label="Sharpe Ratio"  value={backtestData.portfolioStats?.sharpe ?? 0}         color={backtestData.portfolioStats?.sharpe >= 1 ? 'green' : 'yellow'} />
                  </div>
                </div>

                {/* Confidence bucket analysis */}
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                  <p className="text-gray-400 text-xs uppercase tracking-wide mb-3">Does Confidence Score Predict Outcomes?</p>
                  <div className="space-y-2">
                    {Object.entries(backtestData.portfolioStats?.byConfidenceBucket ?? {}).map(([bucket, data]) => (
                      <div key={bucket} className="flex items-center justify-between text-xs">
                        <span className="text-gray-400 w-24">{bucket}</span>
                        <div className="flex-1 mx-3 bg-gray-800 rounded-full h-2">
                          <div className="bg-emerald-500 h-2 rounded-full" style={{ width: `${data.winRate}%` }} />
                        </div>
                        <span className={`w-16 text-right ${data.winRate >= 50 ? 'text-emerald-400' : 'text-red-400'}`}>{data.winRate}% wins</span>
                        <span className="text-gray-600 w-16 text-right">{data.count} trades</span>
                        <span className={`w-20 text-right ${data.avgPnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{data.avgPnl >= 0 ? '+' : ''}${data.avgPnl}</span>
                      </div>
                    ))}
                  </div>
                  <p className="text-gray-600 text-xs mt-2">If higher confidence buckets show higher win rates, the scoring system is working correctly.</p>
                </div>

                {/* Per-coin results */}
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                  <p className="text-gray-400 text-xs uppercase tracking-wide mb-3">Results by Coin</p>
                  <div className="space-y-2">
                    {Object.entries(backtestData.coinResults ?? {}).sort((a, b) => b[1].totalPnl - a[1].totalPnl).map(([coin, r]) => (
                      <div key={coin} className="flex items-center justify-between flex-wrap gap-2 border-b border-gray-800 pb-2 last:border-0">
                        <span className="text-white text-xs font-mono w-12">{coin}</span>
                        <div className="flex gap-2 flex-wrap">
                          <Badge color={r.winRate >= 50 ? 'green' : 'red'}>{r.winRate}% WR</Badge>
                          <Badge color={r.totalPnl >= 0 ? 'green' : 'red'}>{r.totalPnl >= 0 ? '+' : ''}${r.totalPnl}</Badge>
                          <Badge color="gray">{r.totalTrades} trades</Badge>
                          <Badge color={r.sharpe >= 1 ? 'cyan' : 'gray'}>Sharpe {r.sharpe}</Badge>
                          <Badge color={r.maxDrawdown < 10 ? 'green' : 'red'}>DD {r.maxDrawdown}%</Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Strategy breakdown */}
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                  <p className="text-gray-400 text-xs uppercase tracking-wide mb-3">Results by Strategy</p>
                  <div className="space-y-2">
                    {Object.entries(backtestData.portfolioStats?.byStrategy ?? {}).map(([strategy, data]) => (
                      <div key={strategy} className="flex items-center justify-between text-xs border-b border-gray-800 pb-2 last:border-0">
                        <span className="text-gray-300 w-32">{strategy}</span>
                        <div className="flex gap-2">
                          <Badge color={data.winRate >= 50 ? 'green' : 'red'}>{data.winRate}% WR</Badge>
                          <Badge color={data.pnl >= 0 ? 'green' : 'red'}>{data.pnl >= 0 ? '+' : ''}${data.pnl}</Badge>
                          <Badge color="gray">{data.count} trades</Badge>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Ablation results */}
                {Object.keys(backtestData.ablation ?? {}).length > 0 && (
                  <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                    <p className="text-gray-400 text-xs uppercase tracking-wide mb-3">Ablation Tests — What happens when components are removed?</p>
                    {Object.entries(backtestData.ablation).map(([coin, results]) => (
                      <div key={coin} className="mb-4">
                        <p className="text-gray-500 text-xs mb-2">{coin}</p>
                        <div className="space-y-1">
                          {results.map((r, i) => (
                            <div key={i} className="flex items-center justify-between text-xs border-b border-gray-800 pb-1 last:border-0">
                              <span className={`w-48 ${i === 0 ? 'text-cyan-400 font-bold' : 'text-gray-400'}`}>{r.name}</span>
                              <div className="flex gap-2">
                                <Badge color={r.winRate >= 50 ? 'green' : 'red'}>{r.winRate}% WR</Badge>
                                <Badge color={r.totalPnl >= 0 ? 'green' : 'red'}>{r.totalPnl >= 0 ? '+' : ''}${r.totalPnl}</Badge>
                                <Badge color="gray">{r.trades} trades</Badge>
                                <Badge color={r.sharpe >= 1 ? 'cyan' : 'gray'}>Sharpe {r.sharpe}</Badge>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                    <p className="text-gray-600 text-xs mt-2">If removing a component improves results, consider dropping it. If it hurts, it's earning its place.</p>
                  </div>
                )}

                {/* V3 comparison */}
                {backtestData.v3 && (
                  <div className="bg-gray-900 border border-cyan-800/40 rounded-xl p-4">
                    <p className="text-cyan-400 text-xs uppercase tracking-wide mb-1">🔬 V3 Preview</p>
                    <p className="text-gray-600 text-xs mb-3">{backtestData.v3.label}</p>
                    <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
                      <StatCard label="V3 Win Rate"     value={`${backtestData.v3.portfolioStats?.winRate ?? 0}%`} color={backtestData.v3.portfolioStats?.winRate >= 50 ? 'green' : 'red'} />
                      <StatCard label="V3 Total PnL"    value={`${(backtestData.v3.portfolioStats?.totalPnl ?? 0) >= 0 ? '+' : ''}$${(backtestData.v3.portfolioStats?.totalPnl ?? 0).toFixed(4)}`} color={(backtestData.v3.portfolioStats?.totalPnl ?? 0) >= 0 ? 'green' : 'red'} />
                      <StatCard label="V3 Profit Factor" value={backtestData.v3.portfolioStats?.profitFactor ?? 0} color={backtestData.v3.portfolioStats?.profitFactor >= 1.2 ? 'green' : 'red'} />
                      <StatCard label="V3 Trades"       value={backtestData.v3.totalTrades} sub="vs 94 full system" color="cyan" />
                    </div>
                    <div className="space-y-2">
                      {Object.entries(backtestData.v3.coinResults ?? {}).sort((a, b) => b[1].totalPnl - a[1].totalPnl).map(([coin, r]) => (
                        <div key={coin} className="flex items-center justify-between flex-wrap gap-2 border-b border-gray-800 pb-1 last:border-0">
                          <span className="text-white text-xs font-mono w-12">{coin}</span>
                          <div className="flex gap-2 flex-wrap">
                            <Badge color={r.winRate >= 50 ? 'green' : 'red'}>{r.winRate}% WR</Badge>
                            <Badge color={r.totalPnl >= 0 ? 'green' : 'red'}>{r.totalPnl >= 0 ? '+' : ''}${r.totalPnl}</Badge>
                            <Badge color="gray">{r.totalTrades} trades</Badge>
                            <Badge color={r.sharpe >= 1 ? 'cyan' : 'gray'}>Sharpe {r.sharpe}</Badge>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Exit reason breakdown */}
                <div className="bg-gray-900 border border-gray-800 rounded-xl p-4">
                  <p className="text-gray-400 text-xs uppercase tracking-wide mb-3">Exit Reasons</p>
                  <div className="flex gap-4 flex-wrap">
                    {Object.entries(backtestData.portfolioStats?.byExitReason ?? {}).map(([reason, data]) => (
                      <div key={reason} className="text-xs">
                        <span className="text-gray-400">{reason}: </span>
                        <span className="text-white">{data.count} trades </span>
                        <span className={data.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}>{data.pnl >= 0 ? '+' : ''}${data.pnl.toFixed(4)}</span>
                      </div>
                    ))}
                  </div>
                </div>

              </div>
            )}
          </div>
        )}

        {/* Trades */}
        {activeTab === 'trades' && (
          <div className="space-y-4">
            {/* Quant trades */}
            {quantTrades.length > 0 && (
              <div>
                <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Quant Trades</p>
                <div className="space-y-2">
                  {quantTrades.map(t => (
                    <div key={t.id} className="bg-gray-900 border border-gray-800 rounded-xl p-3 flex items-center justify-between flex-wrap gap-2">
                      <div className="flex items-center gap-2">
                        <Badge color={t.status === 'OPEN' ? 'yellow' : t.status === 'SIMULATED' ? 'purple' : t.pnl > 0 ? 'green' : 'red'}>{t.status}</Badge>
                        <Badge color="cyan">🧠</Badge>
                        <span className="text-gray-300 text-xs">{t.label}</span>
                        <Badge color="gray">{t.strategy}</Badge>
                      </div>
                      <div className="flex items-center gap-3">
                        {t.pnl != null && <span className={`text-xs font-mono ${t.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(4)}</span>}
                        <span className="text-gray-600 text-xs">{t.timestamp}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* Arb trades */}
            {arbTrades.length > 0 && (
              <div>
                <p className="text-gray-500 text-xs uppercase tracking-wide mb-2">Arb Trades</p>
                <div className="space-y-2">
                  {arbTrades.map(t => (
                    <div key={t.id} className="bg-gray-900 border border-gray-800 rounded-xl p-3 flex items-center justify-between flex-wrap gap-2">
                      <div className="flex items-center gap-2">
                        <Badge color={t.status === 'FILLED' ? 'green' : t.status === 'SIMULATED' ? 'purple' : 'red'}>{t.status}</Badge>
                        <Badge color="blue">↔</Badge>
                        <span className="text-gray-300 text-xs">{t.label}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        {t.pnl != null && <span className={`text-xs font-mono ${t.pnl >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>{t.pnl >= 0 ? '+' : ''}${t.pnl.toFixed(4)}</span>}
                        <span className="text-gray-500 text-xs">+{t.netPct}%</span>
                        <span className="text-gray-600 text-xs">{t.timestamp}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {arbTrades.length === 0 && quantTrades.length === 0 && (
              <div className="text-center text-gray-600 py-16">No trades yet</div>
            )}
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

        {/* Status */}
        {activeTab === 'status' && (
          <div className="space-y-3 max-w-md">
            <p className="text-gray-500 text-xs mb-2">Exchange connections</p>
            {exchanges.map(ex => {
              const s = exchangeStatus[ex];
              return (
                <div key={ex} className="flex items-center justify-between bg-gray-900 border border-gray-800 rounded-lg px-3 py-2">
                  <span className="text-xs text-gray-300">{ex}</span>
                  <div className="flex items-center gap-2">
                    {s?.success && <span className="text-gray-500 text-xs">${(s.balance ?? 0).toFixed(2)}</span>}
                    <span className={`w-2 h-2 rounded-full ${s === undefined ? 'bg-gray-600' : s?.success ? 'bg-emerald-400 animate-pulse' : 'bg-red-500'}`} />
                    <span className={`text-xs ${s === undefined ? 'text-gray-500' : s?.success ? 'text-emerald-400' : 'text-red-400'}`}>
                      {s === undefined ? 'Loading...' : s?.success ? 'LIVE' : s?.error ?? 'ERR'}
                    </span>
                  </div>
                </div>
              );
            })}
            <button onClick={() => { fetchStatus(); fetchBalances(); addLog('🔄 Refreshed', 'info'); }}
              className="px-4 py-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-lg text-xs text-gray-300">
              ↻ Refresh
            </button>
            {config && (
              <div className="mt-4 bg-gray-900 border border-gray-800 rounded-xl p-4 text-xs text-gray-500 space-y-1">
                <p className="text-gray-300 font-bold mb-2">Active Config</p>
                <p>Arb pairs: <span className="text-white">{config.pairs?.join(', ')}</span></p>
                <p>Arb exchanges: <span className="text-white">{config.arbExchanges?.join(' ↔ ')}</span></p>
                <p>Quant coins: <span className="text-white">{config.trackedCoins?.join(', ')}</span></p>
                <p>Min profit: <span className="text-white">{(config.minProfitThreshold * 100).toFixed(1)}%</span></p>
                <p>Capital/trade: <span className="text-white">${config.capitalPerTrade}</span></p>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
