// ─────────────────────────────────────────────────────────────
// BACKTEST/SIMULATE.JS — Event-driven replay of the live strategy
//
// The point of this simulator is that it runs THE SAME CODE the bot
// trades with — scoreCandidate / classifySignal / detectSqueezeSetup /
// generateSignals / calculateRvol are imported from the live modules,
// not re-implemented. The backtest can therefore only disagree with
// live behavior through data and fills, never through drifted logic.
//
// Anti-fantasy rules (every one of these makes results WORSE, on
// purpose — an edge that survives pessimism is an edge):
//   • Decisions at tick T use only bars with timestamp ≤ T.
//   • Entries are limit orders at the signal price, filled only when a
//     LATER bar trades through the limit (open if it gaps below).
//   • Slippage haircut on every fill, both sides (penny spreads are
//     real: config below, default 50bps/side).
//   • If one bar spans both stop and target, the STOP fills (worst case).
//   • Positions force-flat by 15:55 ET (the live bot is intraday).
//   • One trade per symbol per day; live portfolio caps enforced
//     (max concurrent positions, daily loss cap).
//   • No news / catalyst / real-SI boosts — those can't be honestly
//     reconstructed for the past, so signals run WITHOUT their help.
// ─────────────────────────────────────────────────────────────

import { SETTINGS } from '../config.js';
import { scoreCandidate, classifySignal } from '../pennyStockScanner.js';
import { detectSqueezeSetup } from '../shortSqueezeDetector.js';
import { generateSignals } from '../signalEngine.js';
import { calculateRvol } from '../priceHistory.js';
import { assessMarketHealth } from '../regimeDetector.js';
import { etMidnightEpoch } from './data.js';

const S = SETTINGS;
const RTH_OPEN = 9 * 60 + 30, FLAT_BY = 15 * 60 + 55;

// ─── Snapshot builder: what the live bot would have seen at tick T ─
// `bars` are the day's minute bars ascending; `upto` is an index bound
// (exclusive) into bars — everything ≤ tick.
function buildSnapshot(symbol, bars, upto, prevClose) {
  if (upto === 0) return null;
  let vol = 0, pv = 0, high = -Infinity, low = Infinity;
  for (let i = 0; i < upto; i++) {
    const b = bars[i];
    vol += b.volume;
    pv  += (b.vwap || b.close) * b.volume;
    if (b.high > high) high = b.high;
    if (b.low  < low)  low  = b.low;
  }
  const last  = bars[upto - 1];
  const price = last.close;
  return {
    symbol,
    price:     +price.toFixed(4),
    open:      +bars[0].open.toFixed(4),
    dailyHigh: +high.toFixed(4),
    dailyLow:  +low.toFixed(4),
    volume:    vol,
    vwap:      vol > 0 ? +(pv / vol).toFixed(4) : 0,
    prevClose: +prevClose.toFixed(4),
    changePct: prevClose > 0 ? +(((price - prevClose) / prevClose) * 100).toFixed(2) : 0,
    bid: price, ask: price,       // no historical quotes — slippage model carries the spread cost
    floatShares: 0,               // unknown historically → float scores neutral (as live does w/o SI)
  };
}

// Live position sizing (quantExecutor's confidence scaling, pre-Kelly).
function positionSizeUSD(confidence) {
  const convScale = Math.min(Math.max((confidence - 0.5) / 0.5, 0), 1);
  return +(S.CAPITAL_PER_TRADE + (S.MAX_POSITION_SIZE - S.CAPITAL_PER_TRADE) * convScale).toFixed(2);
}

// v3: equal-risk sizing. Every trade risks the same dollars; the stop
// distance (ATR-scaled) converts that into shares. Confidence no longer
// scales size — the campaign proved confidence ≈ lateness, so scaling
// with it meant betting most on the latest entries.
function qtyForSignal(sig) {
  if (S.STRATEGY_TUNING?.RULESET === 'v3' && sig.stopLoss < sig.price) {
    const riskPerShare = sig.price - sig.stopLoss;
    let qty = Math.floor(S.STRATEGY_TUNING.RISK_PER_TRADE_USD / riskPerShare);
    qty = Math.min(qty, Math.floor(S.MAX_POSITION_SIZE / sig.price));   // notional cap holds
    return qty;
  }
  return Math.floor(positionSizeUSD(sig.confidence) / sig.price);
}

// ─── Simulate one trading day ─────────────────────────────────
// dayData: {
//   dateEt, minuteBars: {SYM: bars}, prevClose: {SYM: n},
//   priorDaily: {SYM: bars(<= D-1)}, indexMinute: {SPY: bars, QQQ: bars},
// }
// opts: { tickMinutes, slippageBps, maxConcurrent, onTrade }
export function simulateDay(dayData, opts) {
  const { dateEt, minuteBars, prevClose, priorDaily, indexMinute } = dayData;
  const { tickMinutes = 5, slippageBps = 50, maxConcurrent = S.MAX_OPEN_POSITIONS } = opts;
  const slip = slippageBps / 10_000;

  const midnight = etMidnightEpoch(dateEt);
  const minuteOf = (ts) => Math.floor((ts - midnight) / 60_000);

  const symbols = Object.keys(minuteBars).filter(s => (minuteBars[s]?.length ?? 0) > 0);
  // Per-symbol ascending cursor into its bars (index of first bar > tick).
  const cursor = Object.fromEntries(symbols.map(s => [s, 0]));

  const open     = {};     // symbol → position
  const pending  = {};     // symbol → resting limit order
  const tradedToday = new Set();
  const trades   = [];
  let dailyLoss  = 0;

  const advance = (sym, tickMin) => {
    const bars = minuteBars[sym];
    let i = cursor[sym];
    while (i < bars.length && minuteOf(bars[i].timestamp) <= tickMin) i++;
    cursor[sym] = i;
    return i;
  };

  const record = (sym, pos, exitPrice, reason, exitMin) => {
    const exit = exitPrice * (1 - slip);                    // sell-side slippage
    const pnl  = +(((exit - pos.entry) / pos.entry) * pos.usd).toFixed(4);
    if (pnl < 0) dailyLoss += -pnl;
    trades.push({
      date: dateEt, symbol: sym, strategy: pos.strategy, confidence: pos.confidence,
      tier: pos.tier, entry: +pos.entry.toFixed(4), exit: +exit.toFixed(4),
      exitReason: reason, usd: pos.usd, qty: pos.qty,
      pnl, pnlPct: +(((exit - pos.entry) / pos.entry) * 100).toFixed(3),
      holdMin: exitMin - pos.entryMin, entryMin: pos.entryMin,
    });
    delete open[sym];
  };

  // Walk bars in (tickStart, tickEnd] for fills/exits of resting orders
  // and open positions. Bars, not ticks, decide fills — a stop that's hit
  // between scan ticks still fires.
  const processBars = (sym, fromIdx, toIdx) => {
    const bars = minuteBars[sym];
    for (let i = fromIdx; i < toIdx; i++) {
      const b = bars[i];
      const m = minuteOf(b.timestamp);

      // 1. Resting entry?
      const ord = pending[sym];
      if (ord && m >= ord.placedMin + 1) {                 // strictly after the signal tick
        if (Object.keys(open).length < maxConcurrent && dailyLoss < S.MAX_DAILY_LOSS_USD) {
          let fill = null;
          if (b.open <= ord.limit) fill = b.open;          // gapped below the limit
          else if (b.low <= ord.limit) fill = ord.limit;
          if (fill != null) {
            const entry = fill * (1 + slip);               // buy-side slippage
            open[sym] = { ...ord, entry, entryMin: m };
            delete pending[sym];
          }
        } else {
          delete pending[sym];                             // caps full — order dies
        }
      }

      // 2. Open position exits (stop checked FIRST — pessimistic). The
      //    stop used here is the one standing BEFORE this bar; trailing
      //    updates below only bind on LATER bars, so there is no bet on
      //    intrabar high-before-low ordering.
      const pos = open[sym];
      if (pos && m > pos.entryMin) {
        const stopReason = pos.trailArmed && pos.stop >= pos.entry ? 'trail_stop' : null;
        if (b.open <= pos.stop)        record(sym, pos, b.open, stopReason ?? 'stop_gap', m);
        else if (b.low <= pos.stop)    record(sym, pos, pos.stop, stopReason ?? 'stop_loss', m);
        else if (b.open >= pos.target) record(sym, pos, b.open, 'target_gap', m);
        else if (b.high >= pos.target) record(sym, pos, pos.target, 'take_profit', m);
        else if (m >= FLAT_BY)         record(sym, pos, b.close, 'eod_flat', m);
        else if (pos.trail) {
          // v3 let-winners-run: at +TRAIL_ARM_R the stop ratchets to
          // breakeven, then trails TRAIL_DISTANCE below the high-water
          // mark. Ratchet only — the stop never loosens.
          pos.highSince = Math.max(pos.highSince ?? pos.entry, b.high);
          if (!pos.trailArmed && pos.highSince >= pos.trail.armAt) {
            pos.trailArmed = true;
            pos.stop = Math.max(pos.stop, pos.entry);
          }
          if (pos.trailArmed) {
            pos.stop = Math.max(pos.stop, pos.highSince - pos.trail.distance);
          }
        }
      } else if (pos && m >= FLAT_BY) {
        record(sym, pos, b.close, 'eod_flat', m);
      }
    }
  };

  // ─── Main tick loop: 9:35 → 15:30 ──────────────────────────
  for (let tick = RTH_OPEN + tickMinutes; tick <= 15 * 60 + 30; tick += tickMinutes) {
    // Advance all cursors; process fills/exits on the bars just consumed.
    for (const sym of symbols) {
      const from = cursor[sym];
      const to   = advance(sym, tick);
      if (to > from) processBars(sym, from, to);
    }

    // Market-health gate from index minute bars (same regime logic as live).
    let health = null;
    if (indexMinute) {
      const spySnap = buildSnapshot('SPY', indexMinute.SPY ?? [], cursorBound(indexMinute.SPY, midnight, tick), prevClose.SPY ?? 0);
      const qqqSnap = buildSnapshot('QQQ', indexMinute.QQQ ?? [], cursorBound(indexMinute.QQQ, midnight, tick), prevClose.QQQ ?? 0);
      health = assessMarketHealth({ SPY: spySnap ?? undefined, QQQ: qqqSnap ?? undefined });
    }

    // Signal pass on symbols not yet traded/holding/pending.
    for (const sym of symbols) {
      if (open[sym] || pending[sym] || tradedToday.has(sym)) continue;
      const upto = cursor[sym];
      const snap = buildSnapshot(sym, minuteBars[sym], upto, prevClose[sym] ?? 0);
      if (!snap) continue;

      // The live scanner's gates, at this tick's state. Under v3 the
      // momentum gate widens to EARLY_MIN_CHANGE_PCT — the signal layer
      // then only lets STRUCTURAL strategies fire below the full gate.
      const minChange = S.STRATEGY_TUNING?.RULESET === 'v3'
        ? S.STRATEGY_TUNING.EARLY_MIN_CHANGE_PCT
        : S.MIN_CHANGE_PCT;
      if (snap.price < S.PRICE_MIN || snap.price > S.PRICE_MAX) continue;
      if (snap.volume < S.MIN_DAILY_VOLUME) continue;
      snap.rvol = calculateRvol(snap.volume, priorDaily[sym] ?? [], { atEtMinutes: tick });
      if (snap.rvol < S.MIN_RVOL || snap.changePct < minChange) continue;

      // Score with the LIVE scorer; gate-passers rescued to WATCH (live rule).
      const bars120 = minuteBars[sym].slice(Math.max(0, upto - 120), upto);
      const score   = scoreCandidate({ symbol: sym, snapshot: snap, dailyBars: priorDaily[sym], minuteBars: bars120 });
      let tier      = classifySignal(score.total);
      if (tier === 'SKIP') tier = 'WATCH';

      const runner  = { symbol: sym, tier, score, snapshot: snap, rvol: snap.rvol, changePct: snap.changePct };
      const squeeze = detectSqueezeSetup(snap, priorDaily[sym] ?? [], null);   // estimated fuel (no historical SI)
      const signals = generateSignals([runner], {}, { [sym]: squeeze }, { [sym]: bars120 });
      const sig     = signals[0];
      if (!sig || sig.type !== 'BUY') continue;

      // Live market-health gating.
      if (health && !health.allowEntries) continue;
      if (health?.requireHighConviction && sig.confidence < 0.70) continue;
      if (sig.confidence < S.MIN_SIGNAL_SCORE) continue;

      const qty = qtyForSignal(sig);
      if (qty < 1) continue;

      pending[sym] = {
        limit: sig.price, stop: sig.stopLoss, target: sig.takeProfit,
        trail: sig.trail ?? null,
        strategy: sig.strategy, confidence: sig.confidence, tier: sig.tier,
        usd: +(qty * sig.price).toFixed(2), qty, placedMin: tick,
      };
      tradedToday.add(sym);
    }
  }

  // Flush the tail of the session (15:30 → close) for exits/EOD flat.
  for (const sym of symbols) {
    const from = cursor[sym];
    const to   = minuteBars[sym].length;
    if (to > from) processBars(sym, from, to);
    const pos = open[sym];
    if (pos) {   // no bars after 15:55 (thin name) — flat at last trade
      const last = minuteBars[sym][to - 1];
      record(sym, pos, last.close, 'eod_flat', minuteOf(last.timestamp));
    }
  }

  return trades;
}

// Index of first bar strictly after `tick` for an already-sorted bar array.
function cursorBound(bars, midnight, tick) {
  if (!bars?.length) return 0;
  let i = 0;
  while (i < bars.length && Math.floor((bars[i].timestamp - midnight) / 60_000) <= tick) i++;
  return i;
}
