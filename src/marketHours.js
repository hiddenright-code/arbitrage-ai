// ─────────────────────────────────────────────────────────────
// MARKETHOURS.JS — Trading-window gate (US Eastern, holiday-aware)
//
// The scan pipeline fires a burst of Alpaca/ORTEX/FINRA/news calls every
// cycle. Outside trading hours that's pure waste — penny runners only move
// when the tape is live. This module decides whether we're inside the
// active window so the server can skip the pipeline when we're not.
//
// Source of truth is Alpaca's /v2/calendar, which lists the real trading
// days AND each day's extended-hours session bounds (session_open /
// session_close). That means holidays and early-close days are handled
// automatically. If the lookup is unavailable we fall back to a weekday +
// configured-hours heuristic so the gate still behaves sensibly offline.
// ─────────────────────────────────────────────────────────────

import { SETTINGS } from './config.js';
import { getMarketCalendar } from './exchangeClient.js';

const ET_TZ = 'America/New_York';

// Current wall-clock in US Eastern, broken into the parts we need.
function nowInET() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: ET_TZ, weekday: 'short', year: 'numeric', month: '2-digit',
      day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).formatToParts(new Date()).map(p => [p.type, p.value])
  );
  const hour   = Number(parts.hour) % 24;   // some platforms emit '24' at midnight
  const minute = Number(parts.minute);
  return {
    date:    `${parts.year}-${parts.month}-${parts.day}`,
    weekday: parts.weekday,                 // 'Mon' … 'Sun'
    minutes: hour * 60 + minute,
    label:   `${pad(hour)}:${pad(minute)} ET`,
  };
}

const pad = (n) => String(n).padStart(2, '0');
const cfgMin = ({ hour, minute }) => hour * 60 + minute;
const minLabel = (min) => `${pad(Math.floor(min / 60))}:${pad(min % 60)}`;

// Accepts "HH:MM" (calendar `open`/`close`) or "HHMM" (`session_open`/
// `session_close`) and returns minutes since ET midnight.
function hmToMinutes(s) {
  if (s == null) return null;
  const str = String(s);
  const [h, m] = str.includes(':')
    ? str.split(':').map(Number)
    : [Number(str.slice(0, -2)), Number(str.slice(-2))];
  return Number.isFinite(h) && Number.isFinite(m) ? h * 60 + m : null;
}

// The calendar entry changes at most once per day — cache it.
//   entry object → trading day
//   null         → confirmed non-trading day (holiday/weekend)
//   undefined    → lookup failed → caller uses the weekday fallback
let dayCache = { date: null, entry: undefined };
async function calendarEntry(dateStr) {
  if (dayCache.date === dateStr) return dayCache.entry;
  let entry;
  try {
    const cal = await getMarketCalendar(dateStr, dateStr);
    entry = (Array.isArray(cal) ? cal.find(c => c.date === dateStr) : null) ?? null;
  } catch {
    entry = undefined;
  }
  dayCache = { date: dateStr, entry };
  return entry;
}

// Decide whether the scanner should be running right now.
// Returns { active, session, reason, etTime, date, extended }.
export async function getMarketWindow() {
  const t = nowInET();
  const extended  = SETTINGS.SCAN_EXTENDED_HOURS;
  const isWeekend = t.weekday === 'Sat' || t.weekday === 'Sun';
  const entry     = isWeekend ? null : await calendarEntry(t.date);

  let tradingDay, rthOpen, rthClose, extOpen, extClose;
  if (entry) {
    tradingDay = true;
    rthOpen  = hmToMinutes(entry.open)          ?? cfgMin(SETTINGS.MARKET_OPEN);
    rthClose = hmToMinutes(entry.close)         ?? cfgMin(SETTINGS.MARKET_CLOSE);
    extOpen  = hmToMinutes(entry.session_open)  ?? cfgMin(SETTINGS.PRE_MARKET);
    extClose = hmToMinutes(entry.session_close) ?? cfgMin(SETTINGS.AFTER_MARKET);
  } else {
    // null → confirmed closed; undefined → lookup failed, assume a weekday trades
    tradingDay = entry === undefined ? !isWeekend : false;
    rthOpen  = cfgMin(SETTINGS.MARKET_OPEN);
    rthClose = cfgMin(SETTINGS.MARKET_CLOSE);
    extOpen  = cfgMin(SETTINGS.PRE_MARKET);
    extClose = cfgMin(SETTINGS.AFTER_MARKET);
  }

  const winOpen  = extended ? extOpen  : rthOpen;
  const winClose = extended ? extClose : rthClose;
  const base = { active: false, session: 'closed', etTime: t.label, date: t.date, extended };

  if (!tradingDay) {
    return { ...base, reason: isWeekend
      ? `Weekend (${t.weekday}) — market closed`
      : `Market holiday (${t.date}) — market closed` };
  }
  if (t.minutes < winOpen) {
    return { ...base, reason: `Closed — ${extended ? 'pre-market' : 'regular session'} opens ${minLabel(winOpen)} ET` };
  }
  if (t.minutes >= winClose) {
    return { ...base, reason: `Closed — ${extended ? 'after-hours' : 'regular session'} ended ${minLabel(winClose)} ET` };
  }

  const session = t.minutes < rthOpen ? 'pre-market'
                : t.minutes < rthClose ? 'regular'
                : 'after-hours';
  return { ...base, active: true, session, reason: `Open — ${session} session` };
}
