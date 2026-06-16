// ─────────────────────────────────────────────────────────────
// REGIMEDETECTOR.JS — Market health / risk-on filter
//
// Penny stock runners perform best when the broad market is
// "risk-on" (SPY/QQQ green, not crashing). When the market is
// selling off hard, small-caps get hit hardest and runners fail.
//
// This module produces a market-wide risk gate that the signal
// engine uses to suppress or allow new long entries:
//
//   RISK_ON   — SPY & QQQ flat/up → trade runners normally
//   NEUTRAL   — mixed → trade only high-conviction setups
//   RISK_OFF  — broad selloff → suppress new entries
//
// Method: intraday % change of SPY and QQQ vs prior close, plus
// position relative to VWAP.
// ─────────────────────────────────────────────────────────────

export const MARKET_REGIMES = {
  RISK_ON:  'RISK_ON',
  NEUTRAL:  'NEUTRAL',
  RISK_OFF: 'RISK_OFF',
};

// ─── Assess broad market health from index snapshots ─────────
// snapshots: { SPY: {changePct, price, vwap}, QQQ: {...} }
export function assessMarketHealth(snapshots = {}) {
  const spy = snapshots.SPY;
  const qqq = snapshots.QQQ;

  if (!spy && !qqq) {
    return {
      regime: MARKET_REGIMES.NEUTRAL,
      confidence: 0,
      reason: 'No index data — defaulting to neutral',
      allowEntries: true,
      requireHighConviction: false,
    };
  }

  const spyChg = spy?.changePct ?? 0;
  const qqqChg = qqq?.changePct ?? 0;
  const avgChg = (spyChg + qqqChg) / ((spy ? 1 : 0) + (qqq ? 1 : 0) || 1);

  // VWAP positioning adds confirmation
  const spyAboveVwap = spy?.vwap > 0 ? spy.price > spy.vwap : null;
  const qqqAboveVwap = qqq?.vwap > 0 ? qqq.price > qqq.vwap : null;

  let regime, reason, allowEntries, requireHighConviction;

  if (avgChg <= -1.5) {
    regime = MARKET_REGIMES.RISK_OFF;
    reason = `Broad selloff (SPY ${spyChg.toFixed(2)}%, QQQ ${qqqChg.toFixed(2)}%) — small caps at risk`;
    allowEntries = false;
    requireHighConviction = true;
  } else if (avgChg <= -0.5 || spyAboveVwap === false) {
    regime = MARKET_REGIMES.NEUTRAL;
    reason = `Soft tape (SPY ${spyChg.toFixed(2)}%, QQQ ${qqqChg.toFixed(2)}%) — high-conviction only`;
    allowEntries = true;
    requireHighConviction = true;
  } else {
    regime = MARKET_REGIMES.RISK_ON;
    reason = `Risk-on (SPY ${spyChg.toFixed(2)}%, QQQ ${qqqChg.toFixed(2)}%) — runners favored`;
    allowEntries = true;
    requireHighConviction = false;
  }

  return {
    regime,
    confidence: +Math.min(Math.abs(avgChg) / 2, 1).toFixed(3),
    reason,
    allowEntries,
    requireHighConviction,
    spyChange: +spyChg.toFixed(2),
    qqqChange: +qqqChg.toFixed(2),
    spyAboveVwap,
    qqqAboveVwap,
  };
}
