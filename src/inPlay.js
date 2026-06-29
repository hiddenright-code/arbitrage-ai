// ─────────────────────────────────────────────────────────────
// INPLAY.JS — "in-play" registry (don't write a runner off too fast)
//
// Penny runners are choppy and multi-day: pop → consolidate → second leg.
// The plain per-scan scorer was dropping clearly-active names (high RVOL,
// hard-to-borrow, low float) the moment momentum paused, and a SKIP at one
// snapshot wrote them off entirely.
//
// This registry remembers a name once it shows real volume and keeps it
// tracked across scans and across days, with a status that reflects whether
// it's still active, just cooling, or genuinely faded:
//
//   ACTIVE   — RVOL still elevated (≥ ACTIVE_RVOL)
//   COOLING  — pulled back / lighter volume but still holding near highs
//   FADED    — volume gone AND well off the peak ⇒ eligible to expire
//
// Stored short-interest (real float / cost-to-borrow from ORTEX/FINRA, fed
// in after enrichment) is kept so the next scan can score the name on its
// real float and keep it alive while shorts are pressured.
// ─────────────────────────────────────────────────────────────

import fs from 'fs';
import path from 'path';
import { SETTINGS } from './config.js';

const CFG = SETTINGS.INPLAY;

let registry = {};   // symbol → entry

function etDate() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
}

// ─── Persistence ──────────────────────────────────────────────
function persistPath() {
  return path.isAbsolute(CFG.PERSIST_PATH) ? CFG.PERSIST_PATH : path.join(process.cwd(), CFG.PERSIST_PATH);
}
function load() {
  try { registry = JSON.parse(fs.readFileSync(persistPath(), 'utf8')) ?? {};
        console.log(`[InPlay] Loaded ${Object.keys(registry).length} in-play names from disk`); }
  catch { registry = {}; }
}
function save() {
  try { const p = persistPath(); fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, JSON.stringify(registry, null, 2)); }
  catch (err) { console.error('[InPlay] save failed:', err.message); }
}
load();

// ─── Status machine ───────────────────────────────────────────
function computeStatus(e) {
  const offPeak = e.peakPrice > 0 ? e.lastPrice / e.peakPrice : 1;
  if (e.lastRvol < CFG.COOL_RVOL && offPeak < CFG.FADE_PRICE_PCT) return 'FADED';
  if (e.lastRvol >= CFG.ACTIVE_RVOL) return 'ACTIVE';
  return 'COOLING';
}

// Record / refresh a name that's showing real volume. `si` is optional
// (the enriched ORTEX/FINRA snapshot) and is merged in when available.
export function markInPlay(symbol, { price, rvol, changePct }, si = null) {
  if (!CFG.ENABLED) return null;
  const today = etDate();
  const e = registry[symbol];

  if (!e) {
    registry[symbol] = {
      symbol, firstSeen: Date.now(), firstDate: today, lastDate: today, dayCount: 0,
      peakRvol: rvol, peakPrice: price, peakChangePct: changePct,
      lastRvol: rvol, lastPrice: price, lastChangePct: changePct,
      status: 'ACTIVE', si: si ?? null,
    };
  } else {
    if (e.lastDate !== today) { e.dayCount += 1; e.lastDate = today; }
    e.peakRvol      = Math.max(e.peakRvol, rvol);
    e.peakPrice     = Math.max(e.peakPrice, price);
    e.peakChangePct = Math.max(e.peakChangePct, changePct);
    e.lastRvol = rvol; e.lastPrice = price; e.lastChangePct = changePct;
    if (si) e.si = si;
    e.status = computeStatus(e);
  }
  return registry[symbol];
}

// Update a name that's already in-play but wasn't a runner this scan
// (paused / cooling) — keeps it alive instead of dropping it.
export function updateInPlay(symbol, { price, rvol, changePct }) {
  const e = registry[symbol];
  if (!e) return null;
  const today = etDate();
  if (e.lastDate !== today) { e.dayCount += 1; e.lastDate = today; }
  e.lastRvol = rvol; e.lastPrice = price; e.lastChangePct = changePct;
  e.peakRvol = Math.max(e.peakRvol, rvol);
  e.peakPrice = Math.max(e.peakPrice, price);
  e.status = computeStatus(e);
  return e;
}

export function prune() {
  for (const [sym, e] of Object.entries(registry)) {
    if (e.dayCount > CFG.MAX_DAYS) { delete registry[sym]; continue; }
    if (e.status === 'FADED' && e.dayCount >= 1) delete registry[sym];   // gone a day
  }
  const syms = Object.keys(registry);
  if (syms.length > CFG.MAX_INPLAY) {
    const rank = { ACTIVE: 2, COOLING: 1, FADED: 0 };
    syms.sort((a, b) => (rank[registry[b].status] ?? 0) - (rank[registry[a].status] ?? 0) || registry[b].peakRvol - registry[a].peakRvol);
    for (const s of syms.slice(CFG.MAX_INPLAY)) delete registry[s];
  }
  save();
}

// ─── Accessors ────────────────────────────────────────────────
export function getInPlay(symbol)        { return registry[symbol] ?? null; }
export function getInPlaySymbols()       { return Object.values(registry).filter(e => e.status !== 'FADED').map(e => e.symbol); }
export function getInPlayList()          { return Object.values(registry).sort((a, b) => b.peakRvol - a.peakRvol); }
export function persist()                { save(); }
