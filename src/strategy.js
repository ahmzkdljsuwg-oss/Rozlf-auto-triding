'use strict';

const config = require('./config');
const indicators = require('./indicators');
const smc = require('./smc');
const { pipSize } = require('./market');

const clamp = (value, lo, hi) => Math.max(lo, Math.min(hi, value));
const round = (value, digits) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};
const finite = (value, fallback = 0) => (Number.isFinite(value) ? value : fallback);

function scoreTimeframe(ind, structure, direction, role) {
  const notesFor = [];
  const notesAgainst = [];
  let score = 0;

  if (direction > 0 && ind.trend === 'bullish') {
    score += 0.35; notesFor.push('EMA trend bullish');
  } else if (direction < 0 && ind.trend === 'bearish') {
    score += 0.35; notesFor.push('EMA trend bearish');
  } else if (ind.trend === 'neutral') {
    notesAgainst.push('EMA trend neutral');
  } else {
    score -= 0.4; notesAgainst.push('EMA trend opposes direction');
  }

  if (direction > 0 && ind.ema20 > ind.ema50) {
    score += 0.15; notesFor.push('EMA20 above EMA50');
  } else if (direction < 0 && ind.ema20 < ind.ema50) {
    score += 0.15; notesFor.push('EMA20 below EMA50');
  } else {
    score -= 0.15; notesAgainst.push('Short EMA alignment weak');
  }

  if (direction > 0) {
    if (ind.rsi >= 45 && ind.rsi <= 70) {
      score += 0.12; notesFor.push(`RSI constructive (${ind.rsi.toFixed(1)})`);
    } else if (ind.rsi > 78) {
      score -= 0.25; notesAgainst.push('RSI overbought');
    } else if (ind.rsi < 35) {
      score -= 0.1; notesAgainst.push('RSI weak for long');
    }
  } else if (ind.rsi >= 30 && ind.rsi <= 55) {
    score += 0.12; notesFor.push(`RSI constructive (${ind.rsi.toFixed(1)})`);
  } else if (ind.rsi < 22) {
    score -= 0.25; notesAgainst.push('RSI oversold');
  } else if (ind.rsi > 65) {
    score -= 0.1; notesAgainst.push('RSI strong against short');
  }

  if (direction > 0) {
    if (ind.macd_hist > 0 && ind.macd_hist >= ind.macd_hist_prev) {
      score += 0.15; notesFor.push('MACD momentum rising');
    } else if (ind.macd_hist < 0 && ind.macd_hist_prev > 0) {
      score -= 0.15; notesAgainst.push('MACD momentum fading');
    }
  } else if (ind.macd_hist < 0 && ind.macd_hist <= ind.macd_hist_prev) {
    score += 0.15; notesFor.push('MACD momentum falling');
  } else if (ind.macd_hist > 0 && ind.macd_hist_prev < 0) {
    score -= 0.15; notesAgainst.push('MACD momentum fading');
  }

  if (direction > 0 && ind.close > ind.bb_mid) {
    score += 0.08; notesFor.push('Price above Bollinger mid');
  } else if (direction < 0 && ind.close < ind.bb_mid) {
    score += 0.08; notesFor.push('Price below Bollinger mid');
  }

  if (role !== 'trigger') {
    const st = structure.structure;
    if (direction > 0 && (st.bos === 'bullish' || st.choch === 'bullish' || st.bias === 'bullish')) {
      score += 0.2; notesFor.push('Bullish market structure');
    } else if (direction < 0 && (st.bos === 'bearish' || st.choch === 'bearish' || st.bias === 'bearish')) {
      score += 0.2; notesFor.push('Bearish market structure');
    } else if (st.bias !== 'neutral') {
      score -= 0.12; notesAgainst.push('Market structure conflicts');
    }

    const sweep = structure.liquidity_sweep;
    if (direction > 0 && sweep.sweep === 'bullish') {
      score += 0.15; notesFor.push('Bullish liquidity sweep');
    } else if (direction < 0 && sweep.sweep === 'bearish') {
      score += 0.15; notesFor.push('Bearish liquidity sweep');
    }

    const blocks = structure.order_blocks;
    if (direction > 0 && blocks.some((b) => b.type === 'bullish')) {
      score += 0.07; notesFor.push('Bullish order block present');
    } else if (direction < 0 && blocks.some((b) => b.type === 'bearish')) {
      score += 0.07; notesFor.push('Bearish order block present');
    }

    const gaps = structure.fvg;
    if (direction > 0 && gaps.some((g) => g.type === 'bullish')) {
      score += 0.07; notesFor.push('Bullish FVG open');
    } else if (direction < 0 && gaps.some((g) => g.type === 'bearish')) {
      score += 0.07; notesFor.push('Bearish FVG open');
    }
  }

  if (role === 'trigger') {
    if (direction > 0 && ind.close > ind.high * 0.9995) {
      score += 0.08; notesFor.push('Price at candle high');
    }
    if (direction > 0 && ind.rsi_slope > 0) {
      score += 0.07; notesFor.push('RSI rising');
    }
    if (direction < 0 && ind.rsi_slope < 0) {
      score += 0.07; notesFor.push('RSI falling');
    }
  }

  return { score: clamp(score, -1, 1), notesFor, notesAgainst };
}

function noTrade(symbol, timeframe, confidence, reasonEn, reasonAr, extras = {}) {
  return {
    symbol, timeframe, side: 'NO TRADE', confidence,
    entry: 0, stop_loss: 0, take_profit: 0, atr: extras.atr || 0,
    reason_en: reasonEn, reason_ar: reasonAr,
    score: extras.score || 0, checks: extras.checks || {}, analysis: extras.analysis || {},
  };
}

function buildSignal(symbol, timeframe, snaps) {
  const inds = {};
  for (const [tf, snap] of Object.entries(snaps)) inds[tf] = indicators.analyzeCandles(snap.candles);

  const structures = {};
  for (const tf of ['H1', 'M15']) {
    if (snaps[tf]) structures[tf] = smc.analyzeStructure(snaps[tf].candles);
  }

  const d1 = inds.D1;
  const h1 = inds.H1 || inds.M15 || inds.M5;
  const m15 = inds.M15 || h1;
  const m5 = inds.M5 || m15;

  if (!h1 || !m15 || !m5) {
    return noTrade(symbol, timeframe, 0, 'Insufficient market data', 'بيانات السوق غير كافية');
  }

  const atr = finite(m15.atr || m5.atr);
  const pip = pipSize(symbol);
  const spread = config.MAX_SPREAD_PIPS * pip;

  let bullScore = 0;
  let bearScore = 0;
  const bullNotes = [];
  const bearNotes = [];
  const bullAgainst = [];
  const bearAgainst = [];
  const neutralStructure = {
    structure: { bos: null, choch: null, bias: 'neutral' },
    liquidity_sweep: { sweep: null }, order_blocks: [], fvg: [],
  };

  const weights = {
    D1: [0.2, 'bias'], H1: [0.3, 'trend'], M15: [0.3, 'setup'], M5: [0.2, 'trigger'],
  };
  for (const [tf, [weight, role]] of Object.entries(weights)) {
    const ind = inds[tf];
    if (!ind) continue;
    const st = structures[tf] || neutralStructure;
    const bull = scoreTimeframe(ind, st, 1, role);
    const bear = scoreTimeframe(ind, st, -1, role);
    bullScore += weight * bull.score;
    bearScore += weight * bear.score;
    bullNotes.push(...bull.notesFor.map((n) => `${tf}: ${n}`));
    bearNotes.push(...bear.notesFor.map((n) => `${tf}: ${n}`));
    bullAgainst.push(...bull.notesAgainst.map((n) => `${tf}: ${n}`));
    bearAgainst.push(...bear.notesAgainst.map((n) => `${tf}: ${n}`));
  }

  const adxVal = m15.adx;
  if (adxVal && adxVal < 16) {
    bullScore *= 0.7;
    bearScore *= 0.7;
  }

  let direction;
  let raw;
  let notesFor;
  let notesAgainst;
  if (bullScore >= bearScore) {
    direction = 1; raw = bullScore; notesFor = bullNotes; notesAgainst = bullAgainst;
  } else {
    direction = -1; raw = bearScore; notesFor = bearNotes; notesAgainst = bearAgainst;
  }

  const conflict = Math.abs(bullScore - bearScore) < 0.12;
  let confidence = clamp(0.5 + raw * 0.55, 0, 0.98);
  if (conflict) confidence *= 0.8;

  const checks = {
    adx: round(finite(adxVal), 2),
    atr: round(atr, 6),
    spread_pips_est: round(spread / pip, 2),
    bull_score: round(bullScore, 3),
    bear_score: round(bearScore, 3),
    conflict,
    notes_for: notesFor.slice(0, 6),
    notes_against: notesAgainst.slice(0, 4),
  };

  const analysis = {
    indicators: {},
    structure: structures,
    timestamps: {},
  };
  for (const tf of Object.keys(inds)) {
    const clean = {};
    for (const [k, v] of Object.entries(inds[tf])) {
      if (typeof v === 'number') clean[k] = Number.isFinite(v) ? round(v, 6) : 0;
      else if (typeof v !== 'object') clean[k] = v;
    }
    analysis.indicators[tf] = clean;
  }
  for (const [tf, snap] of Object.entries(snaps)) {
    analysis.timestamps[tf] = snap.candles[snap.candles.length - 1].time;
  }

  if (confidence < config.DEFAULT_MIN_CONFIDENCE || conflict || (adxVal && adxVal < 14)) {
    return noTrade(
      symbol, timeframe, round(confidence, 3),
      `No qualified setup: ${notesFor.slice(0, 3).join('/') || 'insufficient confluence'}`,
      'لا توجد فرصة مؤهلة: تقارب المؤشرات غير كافٍ',
      { atr: round(atr, 6), score: round(Math.max(bullScore, bearScore), 3), checks, analysis },
    );
  }

  const price = m5.close;
  const entry = price + (direction > 0 ? spread / 2 : -spread / 2);
  const slDistance = Math.max(atr * 1.3, 8 * pip);
  const tpDistance = slDistance * 2;
  const recent = snaps.M15.candles.slice(-12);
  const swingLow = Math.min(...recent.map((c) => c.low));
  const swingHigh = Math.max(...recent.map((c) => c.high));

  let stop;
  let target;
  if (direction > 0) {
    stop = Math.min(swingLow - 2 * pip, entry - slDistance);
    target = entry + Math.max(tpDistance, entry - stop);
  } else {
    stop = Math.max(swingHigh + 2 * pip, entry + slDistance);
    target = entry - Math.max(tpDistance, stop - entry);
  }

  if (Math.abs(entry - stop) < 4 * pip) stop = entry - direction * 4 * pip;
  if (Math.abs(target - entry) < 8 * pip) target = entry + direction * 8 * pip;

  const reasonEn = notesFor.slice(0, 5).join('; ') || 'Multi-timeframe confluence';
  const reasonAr = direction > 0
    ? 'تقاطع إيجابي على عدة أطر زمنية مع اتجاه واضح وبنية سوق داعمة'
    : 'تقاطع سلبي على عدة أطر زمنية مع اتجاه هابط وبنية سوق داعمة';

  return {
    symbol,
    timeframe,
    side: direction > 0 ? 'BUY' : 'SELL',
    confidence: round(confidence, 3),
    entry: round(entry, 6),
    stop_loss: round(stop, 6),
    take_profit: round(target, 6),
    atr: round(atr, 6),
    reason_en: reasonEn,
    reason_ar: reasonAr,
    score: round(raw, 3),
    checks,
    analysis,
  };
}

module.exports = { buildSignal };
