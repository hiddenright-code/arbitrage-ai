// ─────────────────────────────────────────────────────────────
// INDICATORS.JS — Pure technical indicator math (no dependencies)
// All functions take an array of candles: { open, high, low, close, volume }
// ─────────────────────────────────────────────────────────────

// ─── Helpers ──────────────────────────────────────────────────
const closes  = c => c.map(x => x.close);
const highs   = c => c.map(x => x.high);
const lows    = c => c.map(x => x.low);
const volumes = c => c.map(x => x.volume);

function mean(arr) {
  return arr.reduce((s, x) => s + x, 0) / arr.length;
}

function stddev(arr) {
  const m = mean(arr);
  return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
}

// ─── SMA ──────────────────────────────────────────────────────
export function sma(candles, period) {
  const cl = closes(candles);
  if (cl.length < period) return null;
  return mean(cl.slice(-period));
}

// ─── EMA ──────────────────────────────────────────────────────
export function ema(candles, period) {
  const cl = closes(candles);
  if (cl.length < period) return null;
  const k = 2 / (period + 1);
  let e = mean(cl.slice(0, period));
  for (let i = period; i < cl.length; i++) {
    e = cl[i] * k + e * (1 - k);
  }
  return e;
}

function emaArr(arr, period) {
  if (arr.length < period) return [];
  const k = 2 / (period + 1);
  const result = [mean(arr.slice(0, period))];
  for (let i = period; i < arr.length; i++) {
    result.push(arr[i] * k + result[result.length - 1] * (1 - k));
  }
  return result;
}

// ─── RSI ──────────────────────────────────────────────────────
// Returns current RSI value (0-100)
export function rsi(candles, period = 14) {
  const cl = closes(candles);
  if (cl.length < period + 1) return null;

  const changes = cl.slice(1).map((v, i) => v - cl[i]);
  const gains   = changes.map(c => Math.max(c, 0));
  const losses  = changes.map(c => Math.abs(Math.min(c, 0)));

  // Initial averages
  let avgGain = mean(gains.slice(0, period));
  let avgLoss = mean(losses.slice(0, period));

  // Smooth remaining
  for (let i = period; i < changes.length; i++) {
    avgGain = (avgGain * (period - 1) + gains[i])  / period;
    avgLoss = (avgLoss * (period - 1) + losses[i]) / period;
  }

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return +(100 - (100 / (1 + rs))).toFixed(2);
}

// ─── Bollinger Bands ──────────────────────────────────────────
// Returns { upper, middle, lower, width, pct_b }
export function bollingerBands(candles, period = 20, mult = 2) {
  const cl = closes(candles);
  if (cl.length < period) return null;

  const slice  = cl.slice(-period);
  const middle = mean(slice);
  const sd     = stddev(slice);
  const upper  = middle + mult * sd;
  const lower  = middle - mult * sd;
  const price  = cl[cl.length - 1];
  const width  = (upper - lower) / middle; // normalized band width
  const pct_b  = (price - lower) / (upper - lower); // 0=lower, 1=upper

  return {
    upper:  +upper.toFixed(6),
    middle: +middle.toFixed(6),
    lower:  +lower.toFixed(6),
    width:  +width.toFixed(6),
    pct_b:  +pct_b.toFixed(4),
    price,
  };
}

// ─── MACD ─────────────────────────────────────────────────────
// Returns { macd, signal, histogram }
export function macd(candles, fast = 12, slow = 26, signal = 9) {
  const cl = closes(candles);
  if (cl.length < slow + signal) return null;

  const fastEma = emaArr(cl, fast);
  const slowEma = emaArr(cl, slow);

  // Align arrays (slow EMA is shorter)
  const offset    = slow - fast;
  const macdLine  = slowEma.map((v, i) => fastEma[i + offset] - v);
  const sigLine   = emaArr(macdLine, signal);

  // Align signal to macdLine
  const macdTrim  = macdLine.slice(macdLine.length - sigLine.length);
  const histogram = macdTrim.map((v, i) => v - sigLine[i]);

  return {
    macd:      +macdTrim[macdTrim.length - 1].toFixed(6),
    signal:    +sigLine[sigLine.length - 1].toFixed(6),
    histogram: +histogram[histogram.length - 1].toFixed(6),
    // Trend: positive histogram = bullish momentum
    bullish:   histogram[histogram.length - 1] > 0,
    // Crossover detection
    crossedUp:   histogram[histogram.length - 1] > 0 && histogram[histogram.length - 2] <= 0,
    crossedDown: histogram[histogram.length - 1] < 0 && histogram[histogram.length - 2] >= 0,
  };
}

// ─── ATR (Average True Range) ─────────────────────────────────
// Returns current ATR value (measure of volatility)
export function atr(candles, period = 14) {
  if (candles.length < period + 1) return null;
  const slice = candles.slice(-(period + 1));

  const trueRanges = slice.slice(1).map((c, i) => {
    const prev = slice[i].close;
    return Math.max(
      c.high - c.low,
      Math.abs(c.high - prev),
      Math.abs(c.low  - prev)
    );
  });

  return +(mean(trueRanges)).toFixed(6);
}

// ─── ADX (Average Directional Index) ─────────────────────────
// Returns { adx, trending } — ADX > 25 = trending, < 20 = ranging
export function adx(candles, period = 14) {
  if (candles.length < period * 2) return null;

  const slice = candles.slice(-(period * 2));
  const trList = [], dmPlusList = [], dmMinusList = [];

  for (let i = 1; i < slice.length; i++) {
    const curr = slice[i], prev = slice[i - 1];
    const upMove   = curr.high - prev.high;
    const downMove = prev.low  - curr.low;

    trList.push(Math.max(curr.high - curr.low, Math.abs(curr.high - prev.close), Math.abs(curr.low - prev.close)));
    dmPlusList.push(upMove   > downMove && upMove   > 0 ? upMove   : 0);
    dmMinusList.push(downMove > upMove  && downMove > 0 ? downMove : 0);
  }

  // Wilder smoothing
  let tr14 = trList.slice(0, period).reduce((s, x) => s + x, 0);
  let dp14 = dmPlusList.slice(0, period).reduce((s, x) => s + x, 0);
  let dm14 = dmMinusList.slice(0, period).reduce((s, x) => s + x, 0);

  const dxList = [];
  for (let i = period; i < trList.length; i++) {
    tr14 = tr14 - tr14 / period + trList[i];
    dp14 = dp14 - dp14 / period + dmPlusList[i];
    dm14 = dm14 - dm14 / period + dmMinusList[i];

    const diPlus  = (dp14 / tr14) * 100;
    const diMinus = (dm14 / tr14) * 100;
    const dx      = Math.abs(diPlus - diMinus) / (diPlus + diMinus) * 100;
    dxList.push(dx);
  }

  const adxVal = mean(dxList.slice(-period));
  return {
    adx:      +adxVal.toFixed(2),
    trending: adxVal > 25,
    ranging:  adxVal < 20,
  };
}

// ─── Z-Score (for pairs trading) ─────────────────────────────
// Returns z-score of current spread vs historical mean/stddev
// candles1 and candles2 must have same length
export function zScore(candles1, candles2, period = 30) {
  const c1 = closes(candles1).slice(-period);
  const c2 = closes(candles2).slice(-period);
  if (c1.length < period || c2.length < period) return null;

  // Use log ratio as spread (more stable than price difference)
  const spreads = c1.map((v, i) => Math.log(v / c2[i]));
  const m       = mean(spreads);
  const sd      = stddev(spreads);
  if (sd === 0) return null;

  const currentSpread = spreads[spreads.length - 1];
  return +((currentSpread - m) / sd).toFixed(4);
}

// ─── VWAP ─────────────────────────────────────────────────────
// Volume-weighted average price over the candle window
export function vwap(candles) {
  if (!candles.length) return null;
  let totalPV = 0, totalV = 0;
  for (const c of candles) {
    const typicalPrice = (c.high + c.low + c.close) / 3;
    totalPV += typicalPrice * c.volume;
    totalV  += c.volume;
  }
  return totalV === 0 ? null : +(totalPV / totalV).toFixed(6);
}

// ─── Volume spike detection ───────────────────────────────────
// Returns ratio of current volume vs average — > 2.0 = spike
export function volumeRatio(candles, period = 20) {
  const vols = volumes(candles);
  if (vols.length < period + 1) return null;
  const avgVol = mean(vols.slice(-period - 1, -1));
  const curVol = vols[vols.length - 1];
  return avgVol === 0 ? null : +(curVol / avgVol).toFixed(3);
}

// ─── Compute all indicators at once ───────────────────────────
export function computeAll(candles) {
  return {
    rsi:    rsi(candles, 14),
    bb:     bollingerBands(candles, 20, 2),
    macd:   macd(candles, 12, 26, 9),
    atr:    atr(candles, 14),
    adx:    adx(candles, 14),
    ema9:   ema(candles, 9),
    ema21:  ema(candles, 21),
    ema50:  ema(candles, 50),
    vwap:   vwap(candles),
    volRatio: volumeRatio(candles, 20),
    price:  candles[candles.length - 1]?.close,
  };
}
