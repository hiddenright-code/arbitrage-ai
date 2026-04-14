// ─────────────────────────────────────────────────────────────
// CYCLEANALYZER.JS — ML scoring engine for triangular arb cycles
//
// How it works:
//   1. Generates all valid USDT→A→B→USDT triangular cycles from
//      the assets list in config, filtering to pairs that actually
//      exist on Binance.US.
//   2. Every scan records the gross spread found for each cycle.
//   3. Each cycle accumulates a score based on:
//        - avgSpread:  exponentially-weighted moving average of spreads
//        - hitRate:    % of scans where the cycle was profitable
//        - volatility: spread standard deviation (more = more opp)
//        - recency:    timestamp decay — cycles profitable recently rank higher
//   4. Before each scan, cycles are ranked by score and the top N
//      are prioritized, reducing API calls and latency.
//   5. Time-of-day patterns are logged so the dashboard can show
//      which hours tend to be most active.
// ─────────────────────────────────────────────────────────────

import { SETTINGS } from './config.js';

const { ANALYZER } = SETTINGS;

// ─── In-memory state ──────────────────────────────────────────
// cycleStats[cycleId] = {
//   cycle:        { a, b, pairs: [p1, p2, p3] }
//   scans:        number,
//   hits:         number,    — scans where netProfit > threshold
//   spreadHistory: number[], — last VOLATILITY_WINDOW gross spreads
//   ewmaSpread:   number,    — exponentially weighted moving avg spread
//   lastHitTime:  number,    — timestamp of last profitable scan
//   score:        number,    — composite score (0–1)
//   hourlyHits:   number[24] — hits per hour of day
// }
const cycleStats = {};

// All valid cycles discovered on this exchange
let allCycles = [];
let cyclesInitialized = false;

// ─── Generate all USDT→A→B→USDT cycles ───────────────────────
// For each pair (A, B) where A ≠ B, the cycle is:
//   Step 1: Buy A with USDT   (A/USDT — buy side)
//   Step 2: Buy B with A      (B/A    — buy side)  OR sell A for B
//   Step 3: Sell B for USDT   (B/USDT — sell side)
//
// We only include cycles where all 3 pairs exist on the exchange.
export function generateCycles(availablePairs) {
  const pairSet   = new Set(availablePairs);
  const assets    = SETTINGS.TRIANGULAR_ASSETS;
  const cycles    = [];

  for (let i = 0; i < assets.length; i++) {
    for (let j = 0; j < assets.length; j++) {
      if (i === j) continue;
      const a = assets[i];
      const b = assets[j];

      // Path 1: USDT → A → B → USDT
      // Requires: A/USDT, B/A (or A/B), B/USDT
      const p1 = `${a}/USDT`;
      const p2 = `${b}/${a}`;   // buy B with A
      const p3 = `${b}/USDT`;

      if (pairSet.has(p1) && pairSet.has(p2) && pairSet.has(p3)) {
        const id = `${a}→${b}→USDT`;
        cycles.push({ id, a, b, pairs: [p1, p2, p3], direction: 'forward' });
      }

      // Path 2: USDT → A → USDT via B (reverse middle leg)
      // Requires: A/USDT, A/B (sell A for B), B/USDT
      const p2r = `${a}/${b}`; // sell A for B
      if (pairSet.has(p1) && pairSet.has(p2r) && pairSet.has(p3)) {
        const id = `${a}→(via ${b})→USDT`;
        cycles.push({ id, a, b, pairs: [p1, p2r, p3], direction: 'reverse' });
      }
    }
  }

  // Deduplicate
  const seen = new Set();
  return cycles.filter(c => {
    const key = c.pairs.join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── Initialize cycle stats ───────────────────────────────────
export function initCycles(availablePairs) {
  allCycles = generateCycles(availablePairs);
  console.log(`🔺 CycleAnalyzer: ${allCycles.length} triangular cycles generated`);

  for (const cycle of allCycles) {
    if (!cycleStats[cycle.id]) {
      cycleStats[cycle.id] = {
        cycle,
        scans:        0,
        hits:         0,
        spreadHistory: [],
        ewmaSpread:   0,
        lastHitTime:  0,
        score:        0,
        hourlyHits:   new Array(24).fill(0),
      };
    }
  }

  cyclesInitialized = true;
  return allCycles;
}

// ─── Get ranked cycles for next scan ─────────────────────────
// Returns cycles sorted by score, top N first.
// Cycles with no history are interleaved so they get explored.
export function getRankedCycles() {
  if (!cyclesInitialized || allCycles.length === 0) return allCycles;

  const scored   = allCycles.filter(c => (cycleStats[c.id]?.scans ?? 0) >= ANALYZER.MIN_HISTORY);
  const unscored = allCycles.filter(c => (cycleStats[c.id]?.scans ?? 0) <  ANALYZER.MIN_HISTORY);

  scored.sort((a, b) => (cycleStats[b.id]?.score ?? 0) - (cycleStats[a.id]?.score ?? 0));

  // Top N scored cycles + all unscored (so new cycles get explored)
  return [...scored.slice(0, ANALYZER.TOP_CYCLES), ...unscored];
}

// ─── Record a scan result for a cycle ────────────────────────
export function recordScan(cycleId, grossSpread, wasHit) {
  const stat = cycleStats[cycleId];
  if (!stat) return;

  const now  = Date.now();
  const hour = new Date(now).getHours();

  stat.scans++;
  if (wasHit) {
    stat.hits++;
    stat.lastHitTime = now;
    stat.hourlyHits[hour]++;
  }

  // Update EWMA spread
  stat.ewmaSpread = stat.scans === 1
    ? grossSpread
    : ANALYZER.DECAY_FACTOR * stat.ewmaSpread + (1 - ANALYZER.DECAY_FACTOR) * grossSpread;

  // Maintain rolling spread history for volatility
  stat.spreadHistory.push(grossSpread);
  if (stat.spreadHistory.length > ANALYZER.VOLATILITY_WINDOW) {
    stat.spreadHistory.shift();
  }

  // Recompute score
  stat.score = computeScore(stat);
}

// ─── Compute composite score (0–1) ───────────────────────────
function computeScore(stat) {
  if (stat.scans < ANALYZER.MIN_HISTORY) return 0;

  const w = ANALYZER.SCORE_WEIGHTS;

  // 1. avgSpread component — normalize to 0–1 (0.5% spread = 1.0)
  const spreadScore = Math.min(stat.ewmaSpread / 0.005, 1.0);

  // 2. hitRate component
  const hitRate = stat.hits / stat.scans;

  // 3. volatility component — std dev of recent spreads
  const spreads = stat.spreadHistory;
  const mean    = spreads.reduce((s, x) => s + x, 0) / spreads.length;
  const variance = spreads.reduce((s, x) => s + (x - mean) ** 2, 0) / spreads.length;
  const stdDev  = Math.sqrt(variance);
  const volScore = Math.min(stdDev / 0.003, 1.0); // normalize: 0.3% stddev = 1.0

  // 4. recency component — decay since last hit (half-life ~10 min)
  const minutesSinceHit = stat.lastHitTime
    ? (Date.now() - stat.lastHitTime) / 60000
    : 999;
  const recencyScore = Math.exp(-minutesSinceHit / 10);

  return (
    w.avgSpread  * spreadScore +
    w.hitRate    * hitRate     +
    w.volatility * volScore    +
    w.recency    * recencyScore
  );
}

// ─── Get top cycles by score (for dashboard) ─────────────────
export function getTopCycles(n = 10) {
  return Object.values(cycleStats)
    .filter(s => s.scans >= ANALYZER.MIN_HISTORY)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map(s => ({
      id:          s.cycle.id,
      pairs:       s.cycle.pairs,
      score:       +s.score.toFixed(4),
      avgSpread:   +(s.ewmaSpread * 100).toFixed(4),
      hitRate:     +(s.hits / s.scans * 100).toFixed(1),
      scans:       s.scans,
      hits:        s.hits,
      lastHit:     s.lastHitTime ? new Date(s.lastHitTime).toLocaleTimeString() : 'Never',
      bestHour:    s.hourlyHits.indexOf(Math.max(...s.hourlyHits)),
    }));
}

// ─── Get hourly activity summary (for dashboard chart) ───────
export function getHourlyActivity() {
  const totals = new Array(24).fill(0);
  for (const stat of Object.values(cycleStats)) {
    for (let h = 0; h < 24; h++) {
      totals[h] += stat.hourlyHits[h];
    }
  }
  return totals.map((hits, hour) => ({ hour, hits }));
}

// ─── Get all cycle stats (for debugging / status tab) ────────
export function getAllStats() {
  return Object.values(cycleStats)
    .sort((a, b) => b.score - a.score)
    .map(s => ({
      id:        s.cycle.id,
      pairs:     s.cycle.pairs,
      score:     +s.score.toFixed(4),
      avgSpread: +(s.ewmaSpread * 100).toFixed(4) + '%',
      hitRate:   s.scans > 0 ? +(s.hits / s.scans * 100).toFixed(1) + '%' : '—',
      scans:     s.scans,
      hits:      s.hits,
    }));
}
