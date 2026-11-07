'use strict';

function ema(values, period) {
  const n = values.length;
  const out = new Array(n);
  if (!n) return out;
  const alpha = 2 / (period + 1);
  out[0] = values[0];
  for (let i = 1; i < n; i += 1) out[i] = alpha * values[i] + (1 - alpha) * out[i - 1];
  return out;
}

function sma(values, period) {
  const n = values.length;
  const out = new Array(n).fill(NaN);
  if (n < period) return out;
  let sum = 0;
  for (let i = 0; i < n; i += 1) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

function rsi(values, period = 14) {
  const n = values.length;
  const out = new Array(n).fill(NaN);
  if (n <= period) return out;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= period; i += 1) {
    const delta = values[i] - values[i - 1];
    if (delta > 0) avgGain += delta;
    else avgLoss += -delta;
  }
  avgGain /= period;
  avgLoss /= period;
  for (let i = period; i < n; i += 1) {
    if (i > period) {
      const delta = values[i] - values[i - 1];
      const gain = delta > 0 ? delta : 0;
      const loss = delta < 0 ? -delta : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
    }
    const rs = avgLoss !== 0 ? avgGain / avgLoss : 100;
    out[i] = 100 - 100 / (1 + rs);
  }
  return out;
}

function macd(values, fast = 12, slow = 26, signal = 9) {
  const fastEma = ema(values, fast);
  const slowEma = ema(values, slow);
  const line = fastEma.map((v, i) => v - slowEma[i]);
  const signalLine = ema(line, signal);
  const hist = line.map((v, i) => v - signalLine[i]);
  return { line, signalLine, hist };
}

function bollinger(values, period = 20, mult = 2) {
  const mid = sma(values, period);
  const low = new Array(values.length).fill(NaN);
  const high = new Array(values.length).fill(NaN);
  for (let i = period - 1; i < values.length; i += 1) {
    let mean = 0;
    for (let j = i - period + 1; j <= i; j += 1) mean += values[j];
    mean /= period;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j += 1) variance += (values[j] - mean) ** 2;
    const std = Math.sqrt(variance / period);
    low[i] = mid[i] - mult * std;
    high[i] = mid[i] + mult * std;
  }
  return { low, mid, high };
}

function atr(candles, period = 14) {
  const n = candles.length;
  const out = new Array(n).fill(NaN);
  if (n < period + 1) return out;
  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i += 1) {
    const c = candles[i];
    const prevClose = candles[i - 1].close;
    tr[i] = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  }
  let sum = 0;
  for (let i = 1; i <= period; i += 1) sum += tr[i];
  out[period] = sum / period;
  for (let i = period + 1; i < n; i += 1) {
    out[i] = (out[i - 1] * (period - 1) + tr[i]) / period;
  }
  return out;
}

function adx(candles, period = 14) {
  const n = candles.length;
  if (n < period * 2) {
    return {
      adx: new Array(n).fill(NaN),
      plusDi: new Array(n).fill(NaN),
      minusDi: new Array(n).fill(NaN),
    };
  }
  const plusDm = new Array(n).fill(0);
  const minusDm = new Array(n).fill(0);
  const tr = new Array(n).fill(0);
  for (let i = 1; i < n; i += 1) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
    const prevClose = candles[i - 1].close;
    tr[i] = Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - prevClose),
      Math.abs(candles[i].low - prevClose),
    );
  }
  const atrS = new Array(n).fill(0);
  const plusS = new Array(n).fill(0);
  const minusS = new Array(n).fill(0);
  for (let i = 1; i <= period; i += 1) {
    atrS[period] += tr[i];
    plusS[period] += plusDm[i];
    minusS[period] += minusDm[i];
  }
  for (let i = period + 1; i < n; i += 1) {
    atrS[i] = atrS[i - 1] - atrS[i - 1] / period + tr[i];
    plusS[i] = plusS[i - 1] - plusS[i - 1] / period + plusDm[i];
    minusS[i] = minusS[i - 1] - minusS[i - 1] / period + minusDm[i];
  }
  const plusDi = new Array(n).fill(0);
  const minusDi = new Array(n).fill(0);
  const dx = new Array(n).fill(0);
  for (let i = 0; i < n; i += 1) {
    const safe = atrS[i] > 0 ? atrS[i] : NaN;
    plusDi[i] = Number.isFinite(plusS[i] / safe) ? (100 * plusS[i]) / safe : 0;
    minusDi[i] = Number.isFinite(minusS[i] / safe) ? (100 * minusS[i]) / safe : 0;
    const sum = plusDi[i] + minusDi[i];
    dx[i] = sum > 0 ? (100 * Math.abs(plusDi[i] - minusDi[i])) / sum : 0;
  }
  const adxOut = new Array(n).fill(NaN);
  const start = period * 2;
  if (n > start) {
    let sumDx = 0;
    for (let i = period + 1; i <= start; i += 1) sumDx += dx[i];
    adxOut[start] = sumDx / period;
    for (let i = start + 1; i < n; i += 1) {
      adxOut[i] = (adxOut[i - 1] * (period - 1) + dx[i]) / period;
    }
  }
  return { adx: adxOut, plusDi, minusDi };
}

function analyzeCandles(candles) {
  const closes = candles.map((c) => c.close);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const last = candles.length - 1;
  const prev = candles.length - 2;

  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema200 = closes.length >= 200
    ? ema(closes, 200)
    : ema(closes, Math.max(50, Math.floor(closes.length / 2)));
  const rsi14 = rsi(closes, 14);
  const macdData = macd(closes);
  const bb = bollinger(closes, 20, 2);
  const atr14 = atr(candles, 14);
  const adxData = adx(candles, 14);
  const sma20 = sma(closes, 20);

  const price = closes[last];
  const bandwidth = bb.mid[last] ? ((bb.high[last] - bb.low[last]) / bb.mid[last]) * 100 : 0;

  let trend = 'neutral';
  if (price > ema50[last] && ema50[last] > ema200[last]) trend = 'bullish';
  else if (price < ema50[last] && ema50[last] < ema200[last]) trend = 'bearish';

  const rsiVal = Number.isFinite(rsi14[last]) ? rsi14[last] : 50;
  const rsiPrev = Number.isFinite(rsi14[prev]) ? rsi14[prev] : rsiVal;
  const atrVal = Number.isFinite(atr14[last]) ? atr14[last] : 0;
  const adxVal = Number.isFinite(adxData.adx[last]) ? adxData.adx[last] : 0;

  return {
    price,
    ema20: ema20[last],
    ema50: ema50[last],
    ema200: ema200[last],
    rsi: rsiVal,
    rsi_slope: rsiVal - rsiPrev,
    macd: macdData.line[last],
    macd_signal: macdData.signalLine[last],
    macd_hist: macdData.hist[last],
    macd_hist_prev: macdData.hist[prev],
    bb_low: bb.low[last],
    bb_mid: bb.mid[last],
    bb_high: bb.high[last],
    bb_bandwidth: bandwidth,
    atr: atrVal,
    adx: adxVal,
    plus_di: Number.isFinite(adxData.plusDi[last]) ? adxData.plusDi[last] : 0,
    minus_di: Number.isFinite(adxData.minusDi[last]) ? adxData.minusDi[last] : 0,
    sma20: Number.isFinite(sma20[last]) ? sma20[last] : price,
    trend,
    volatility_pct: price ? (atrVal / price) * 100 : 0,
    high: highs[last],
    low: lows[last],
    close: closes[last],
  };
}

module.exports = { ema, sma, rsi, macd, bollinger, atr, adx, analyzeCandles };
