'use strict';

/*
 * Automatic ExpertOption analysis pipeline.
 *
 * Everything here consumes candles returned by the authorized gateway session
 * (src/expertoption-session.js). If the session is not verified, if the asset
 * is not in the live instrument list, if candles are stale or too few, the
 * result is an explicit NO TRADE with a machine-readable reason. Prices and
 * indicators are never invented, and no order can be produced by this module.
 */
const config = require('./config');
const { analyzeCandles } = require('./indicators');
const { analyzeStructure, findSwings } = require('./smc');

const EXPIRY_TIMEFRAME = {
  '30s': 'M1',
  '1m': 'M1',
  '2m': 'M1',
  '3m': 'M1',
  '5m': 'M5',
};

const EXPIRY_LABELS = {
  '30s': { en: '30 seconds', ar: '30 ثانية' },
  '1m': { en: '1 minute', ar: 'دقيقة' },
  '2m': { en: '2 minutes', ar: 'دقيقتان' },
  '3m': { en: '3 minutes', ar: '3 دقائق' },
  '5m': { en: '5 minutes', ar: '5 دقائق' },
};

// Requested assets. The numeric ids come from an unofficial community project
// and are only trusted after a match against the live instrument list.
const REQUESTED_ASSETS = [
  { key: 'smarty', label_en: 'Smarty', label_ar: 'Smarty', legacy_id: '240', match: [/^smarty$/i, /smarty/i] },
  { key: 'cricket-index', label_en: 'Cricket Index', label_ar: 'Cricket Index', legacy_id: '276', match: [/cricket/i] },
  { key: 'football-index', label_en: 'Football Index', label_ar: 'Football Index', legacy_id: '278', match: [/football/i] },
  { key: 'ai-index', label_en: 'AI Index', label_ar: 'AI Index', legacy_id: '285', match: [/^ai[\s_-]*index/i] },
  { key: 'luxury-index', label_en: 'Luxury Index', label_ar: 'Luxury Index', legacy_id: '286', match: [/luxur/i] },
  { key: 'eurusd-otc', label_en: 'EUR/USD OTC', label_ar: 'EUR/USD (OTC)', legacy_id: '179', match: [/eur\s*\/?\s*usd.*otc/i, /^eurusd[\s_-]*otc/i] },
  { key: 'gbpusd-otc', label_en: 'GBP/USD OTC', label_ar: 'GBP/USD (OTC)', legacy_id: '180', match: [/gbp\s*\/?\s*usd.*otc/i, /^gbpusd[\s_-]*otc/i] },
  { key: 'usdjpy-otc', label_en: 'USD/JPY OTC', label_ar: 'USD/JPY (OTC)', legacy_id: '181', match: [/usd\s*\/?\s*jpy.*otc/i, /^usdjpy[\s_-]*otc/i] },
  { key: 'usdchf-otc', label_en: 'USD/CHF OTC', label_ar: 'USD/CHF (OTC)', legacy_id: '182', match: [/usd\s*\/?\s*chf.*otc/i, /^usdchf[\s_-]*otc/i] },
];

const ASSET_KEYS = new Set(REQUESTED_ASSETS.map((a) => a.key));
const EXPIRY_KEYS = new Set(Object.keys(EXPIRY_TIMEFRAME));

function instrumentHaystack(instrument) {
  return `${instrument.name || ''} ${instrument.symbol || ''} ${instrument.id || ''}`;
}

function resolveInstrument(instruments, assetKey) {
  const request = REQUESTED_ASSETS.find((a) => a.key === assetKey);
  if (!request) return null;
  const list = Array.isArray(instruments) ? instruments : [];
  for (const pattern of request.match) {
    const byName = list.find((i) => pattern.test(instrumentHaystack(i)));
    if (byName && !pattern.test(String(byName.id))) return { instrument: byName, resolved_by: 'name' };
  }
  const byId = list.find((i) => String(i.id) === String(request.legacy_id));
  if (byId) return { instrument: byId, resolved_by: 'legacy_id' };
  return null;
}

function describeAssets(instruments) {
  return REQUESTED_ASSETS.map((request) => {
    const resolved = resolveInstrument(instruments, request.key);
    return {
      key: request.key,
      label_en: request.label_en,
      label_ar: request.label_ar,
      requested_id: request.legacy_id,
      available: Boolean(resolved),
      id: resolved ? resolved.instrument.id : null,
      name: resolved ? resolved.instrument.name : null,
      category: resolved ? resolved.instrument.category : null,
      otc: resolved ? resolved.instrument.otc : /otc/i.test(request.label_en),
      resolved_by: resolved ? resolved.resolved_by : null,
    };
  });
}

function supportResistance(candles, lookback = 80) {
  const window = candles.slice(-Math.max(30, lookback));
  if (window.length < 10) return null;
  const swings = findSwings(window).filter((s) => s && Number.isFinite(s.price));
  const highs = swings.filter((s) => s.type === 'high').slice(-4);
  const lows = swings.filter((s) => s.type === 'low').slice(-4);
  const price = window[window.length - 1].close;
  const above = highs.map((s) => s.price).filter((p) => p > price).sort((a, b) => a - b);
  const below = lows.map((s) => s.price).filter((p) => p < price).sort((a, b) => b - a);
  const resistance = above[0] ?? Math.max(...window.slice(-20).map((c) => c.high));
  const support = below[0] ?? Math.min(...window.slice(-20).map((c) => c.low));
  return {
    support: Number(support.toFixed(6)),
    resistance: Number(resistance.toFixed(6)),
    nearest_swing_high: highs.length ? Number(highs[highs.length - 1].price.toFixed(6)) : null,
    nearest_swing_low: lows.length ? Number(lows[lows.length - 1].price.toFixed(6)) : null,
    method: 'swing pivots + recent range',
  };
}

function ruleScore(ind, structure, sr) {
  let score = 0;
  const notes = { en: [], ar: [] };
  if (ind.trend === 'bullish') { score += 1; notes.en.push('EMA50 above EMA200 with price above trend'); notes.ar.push('المتوسط 50 فوق 200 والسعر فوق الاتجاه'); }
  if (ind.trend === 'bearish') { score -= 1; notes.en.push('EMA50 below EMA200 with price below trend'); notes.ar.push('المتوسط 50 تحت 200 والسعر تحت الاتجاه'); }
  if (ind.close > ind.ema20) score += 0.5; else score -= 0.5;
  if (ind.macd_hist > 0 && ind.macd_hist >= ind.macd_hist_prev) { score += 1; notes.en.push('MACD histogram positive and rising'); notes.ar.push('هيستوجرام MACD موجب وصاعد'); }
  if (ind.macd_hist < 0 && ind.macd_hist <= ind.macd_hist_prev) { score -= 1; notes.en.push('MACD histogram negative and falling'); notes.ar.push('هيستوجرام MACD سالب وهابط'); }
  if (ind.rsi > 55) { score += 0.5; notes.en.push(`RSI ${ind.rsi.toFixed(1)} favours upside`); notes.ar.push(`RSI ${ind.rsi.toFixed(1)} لصالح الصعود`); }
  if (ind.rsi < 45) { score -= 0.5; notes.en.push(`RSI ${ind.rsi.toFixed(1)} favours downside`); notes.ar.push(`RSI ${ind.rsi.toFixed(1)} لصالح الهبوط`); }
  if (ind.rsi >= 78 || ind.rsi <= 22) { score *= 0.5; notes.en.push('RSI is at an extreme, momentum may exhaust'); notes.ar.push('RSI في منطقة متطرفة واحتمال استنفاد الزخم'); }
  if (structure?.bos === 'bullish' || (structure?.bias === 'bullish' && !structure?.choch)) score += 0.5;
  if (structure?.bos === 'bearish' || (structure?.bias === 'bearish' && !structure?.choch)) score -= 0.5;
  if (structure?.choch === 'bullish') { score += 0.5; notes.en.push('CHoCH bullish'); notes.ar.push('CHoCH صاعد'); }
  if (structure?.choch === 'bearish') { score -= 0.5; notes.en.push('CHoCH bearish'); notes.ar.push('CHoCH هابط'); }
  if (ind.adx < 18) { score *= 0.6; notes.en.push('ADX below 18: weak trend'); notes.ar.push('ADX أقل من 18: اتجاه ضعيف'); }
  if (sr && ind.close > sr.resistance) notes.en.push('Price is trading above the nearest swing resistance');
  if (sr && ind.close < sr.support) notes.en.push('Price is trading below the nearest swing support');
  return { score, notes };
}

function fail(code, message_en, message_ar, extra = {}) {
  return {
    ok: false,
    direction: 'NO TRADE',
    reason_code: code,
    reason_en: message_en,
    reason_ar: message_ar,
    execution_allowed: false,
    data_verified: false,
    ...extra,
  };
}

function tfMs(timeframe) {
  const { TIMEFRAME_MS } = require('./expertoption-session');
  return TIMEFRAME_MS[timeframe] || 60_000;
}

async function analyzeAsset({
  session, assetKey, expiry, analyzer, now = Date.now(),
  minCandles = config.EXPERTOPTION_MIN_CANDLES,
  maxCandleAgeSeconds = config.EXPERTOPTION_MAX_CANDLE_AGE_SECONDS,
} = {}) {
  if (!session) return fail('no_session', 'No ExpertOption session is attached.', 'لا توجد جلسة ExpertOption متصلة.');
  if (!ASSET_KEYS.has(String(assetKey))) return fail('bad_asset', 'Unknown asset.', 'أصل غير معروف.');
  if (!EXPIRY_KEYS.has(String(expiry))) return fail('bad_expiry', 'Unsupported duration.', 'مدة غير مدعومة.');
  if (!session.verified) {
    return fail('not_connected', session.lastError || 'ExpertOption session is not verified.', 'جلسة ExpertOption غير متحققة.');
  }

  let instruments;
  try {
    instruments = await session.markets();
  } catch (err) {
    return fail(err.code || 'markets_failed', `Instrument list unavailable: ${err.message}`, 'قائمة الأصول غير متاحة من البوابة.', { upstream_code: err.code || null });
  }
  const resolved = resolveInstrument(instruments, assetKey);
  if (!resolved) {
    return fail('asset_not_found', 'The asset is not available in this account instrument list.', 'الأصل غير موجود في قائمة أصول الحساب.', {
      requested_id: REQUESTED_ASSETS.find((a) => a.key === assetKey)?.legacy_id || null,
    });
  }
  const instrument = resolved.instrument;
  const timeframe = EXPIRY_TIMEFRAME[expiry];

  let candles;
  try {
    candles = await session.candles({ instrumentId: instrument.id, timeframe, limit: 260 });
  } catch (err) {
    return fail(err.code || 'candles_failed', `Candles unavailable: ${err.message}`, 'الشموع غير متاحة من البوابة.', {
      instrument, timeframe, upstream_code: err.code || null,
    });
  }
  if (candles.length < minCandles) {
    return fail('insufficient_data', `Only ${candles.length} candles were returned; ${minCandles} are required.`, `عدد الشموع ${candles.length} فقط والمطلوب ${minCandles}.`, {
      instrument, timeframe, candles: candles.length,
    });
  }

  const last = candles[candles.length - 1];
  const ageSeconds = Math.max(0, Math.round((now - last.time) / 1000));
  const allowedAge = Math.min(maxCandleAgeSeconds, Math.max(90, fiveIntervals(timeframe)));
  const priceTime = new Date(last.time).toISOString();
  if (ageSeconds > allowedAge) {
    return fail('stale_data', `Last candle is ${ageSeconds}s old (allowed ${allowedAge}s).`, `آخر شمعة عمرها ${ageSeconds} ثانية والمسموح ${allowedAge} ثانية.`, {
      instrument, timeframe, candles: candles.length, last_candle_at: priceTime, age_seconds: ageSeconds,
    });
  }

  const analysisWindow = candles.slice(-200);
  const ind = analyzeCandles(analysisWindow);
  const structure = analyzeStructure(analysisWindow.slice(-140));
  const sr = supportResistance(analysisWindow);
  const { score, notes } = ruleScore(ind, structure, sr);
  const rulesDirection = score >= 2.5 ? 'UP' : (score <= -2.5 ? 'DOWN' : 'NO TRADE');
  const rulesConfidence = Math.max(0, Math.min(0.92, 0.45 + Math.abs(score) * 0.09));

  const snapshot = {
    asset: { key: assetKey, id: instrument.id, name: instrument.name, category: instrument.category, otc: instrument.otc },
    expiry, timeframe,
    price: ind.price,
    last_candle_at: priceTime,
    age_seconds: ageSeconds,
    candles: candles.length,
    trend: ind.trend,
    indicators: {
      ema20: round(ind.ema20), ema50: round(ind.ema50), ema200: round(ind.ema200),
      rsi: round(ind.rsi), rsi_slope: round(ind.rsi_slope),
      macd: round(ind.macd, 8), macd_signal: round(ind.macd_signal, 8), macd_hist: round(ind.macd_hist, 8),
      bb_low: round(ind.bb_low), bb_mid: round(ind.bb_mid), bb_high: round(ind.bb_high),
      atr: round(ind.atr, 8), adx: round(ind.adx), sma20: round(ind.sma20),
    },
    support_resistance: sr,
    structure: {
      bias: structure?.bias || null,
      bos: structure?.bos || null,
      choch: structure?.choch || null,
      break_level: structure?.break_level ?? null,
      fvg: (structure?.fvg || []).map((g) => ({ type: g.type, top: round(g.top), bottom: round(g.bottom) })),
      order_blocks: (structure?.order_blocks || []).map((b) => ({ type: b.type, top: round(b.top), bottom: round(b.bottom) })),
      liquidity_sweep: structure?.liquidity_sweep || null,
    },
    rules: { direction: rulesDirection, score: round(score, 2), confidence: round(rulesConfidence, 3), notes: notes.en },
  };

  let ai = { reviewed: false, direction: null, confidence: null, reasons: [], error: null };
  if (analyzer && analyzer.enabled && typeof analyzer.analyzeMarketSnapshot === 'function') {
    try {
      const review = await analyzer.analyzeMarketSnapshot(snapshot);
      if (review && review.direction) {
        ai = { reviewed: true, degree: 'ok', direction: review.direction, confidence: review.confidence, reasons: review.reasons || [], expiry_note: review.expiry_note || null, error: null };
      } else {
        ai.error = review?.error || 'AI review returned no direction';
      }
    } catch (err) {
      ai.error = String(err.message || 'AI review failed').slice(0, 200);
    }
  } else if (analyzer && !analyzer.enabled) {
    ai.error = 'MISTRAL_API_KEY is not configured; rules-only analysis';
  } else {
    ai.error = 'No AI analyzer is attached';
  }

  let direction = rulesDirection;
  const reasons = [];
  let conflict = false;
  if (ai.reviewed) {
    const aiDirection = ai.direction === 'NO_TRADE' ? 'NO TRADE' : ai.direction;
    if (aiDirection === rulesDirection) {
      direction = rulesDirection;
    } else if (aiDirection === 'NO TRADE' || rulesDirection === 'NO TRADE') {
      direction = 'NO TRADE';
      conflict = rulesDirection !== 'NO TRADE' && aiDirection !== 'NO TRADE';
    } else {
      direction = 'NO TRADE';
      conflict = true;
    }
  }
  const confidence = ai.reviewed && direction !== 'NO TRADE'
    ? Math.min(rulesConfidence, Number(ai.confidence) || rulesConfidence)
    : rulesConfidence;

  if (direction !== 'NO TRADE' && confidence < 0.55) {
    direction = 'NO TRADE';
  }

  let reasonCode = null;
  let reasonEn = null;
  let reasonAr = null;
  if (direction === 'NO TRADE') {
    if (conflict) {
      reasonCode = 'ai_conflict';
      reasonEn = 'The rule engine and the AI review disagree, so no trade is taken.';
      reasonAr = 'قواعد التحليل ومراجعة الذكاء الاصطناعي غير متفقين، لذلك لا توجد صفقة.';
    } else if (rulesDirection === 'NO TRADE') {
      reasonCode = 'weak_setup';
      reasonEn = 'Trend, momentum and structure are not aligned enough for a high-quality setup.';
      reasonAr = 'الاتجاه والزخم والبنية غير متوافقين بما يكفي لفرصة واضحة.';
    } else {
      reasonCode = 'low_confidence';
      reasonEn = 'Confidence stayed below the 55% threshold.';
      reasonAr = 'نسبة الثقة أقل من حد 55%.';
    }
  }

  const reasonsAr = [];
  if (structure?.bos) reasonsAr.push(`BOS ${structure.bos === 'bullish' ? 'صاعد' : 'هابط'} عند ${structure.break_level ?? '—'}`);
  if (structure?.choch) reasonsAr.push(`CHoCH ${structure.choch === 'bullish' ? 'صاعد' : 'هابط'}`);
  if (structure?.fvg?.length) reasonsAr.push(`${structure.fvg.length} فجوة FVG غير مغلقة`);
  if (structure?.order_blocks?.length) reasonsAr.push(`${structure.order_blocks.length} منطقة Order Block`);
  if (structure?.liquidity_sweep?.sweep) reasonsAr.push(`سحب سيولة ${structure.liquidity_sweep.sweep === 'bullish' ? 'سفلي' : 'علوي'}`);
  if (ai.reasons?.length) reasonsAr.push(...ai.reasons);

  if (!reasonAr) {
    reasonEn = (notes.en && notes.en[0]) || 'Trend, momentum and structure align for this direction.';
    reasonAr = (notes.ar && notes.ar[0]) || (reasonsAr[0]) || 'توافق الاتجاه والزخم والبنية يدعم هذه الإشارة.';
  }

  return {
    ok: true,
    direction,
    confidence: round(confidence, 3),
    price: round(ind.price),
    price_time: priceTime,
    last_update: new Date().toISOString(),
    age_seconds: ageSeconds,
    timeframe,
    expiry,
    expiry_label_en: EXPIRY_LABELS[expiry].en,
    expiry_label_ar: EXPIRY_LABELS[expiry].ar,
    candles: candles.length,
    trend: ind.trend,
    indicators: snapshot.indicators,
    support_resistance: sr,
    structure: snapshot.structure,
    rules: snapshot.rules,
    reason_code: reasonCode,
    reason_en: reasonEn,
    reason_ar: reasonAr,
    ai: { reviewed: ai.reviewed, direction: ai.direction, confidence: ai.confidence, reasons: ai.reasons || [], expiry_note: ai.expiry_note || null, error: ai.error },
    conflict,
    asset: snapshot.asset,
    source: {
      provider: 'ExpertOption authorized gateway',
      instrument_id: instrument.id,
      resolved_by: resolved.resolved_by,
      account_session_data: true,
      verified: true,
    },
    reasons_en: notes.en.concat(ai.reasons || []),
    reasons_ar: reasonsAr.length ? reasonsAr : notes.ar,
    execution_allowed: false,
    data_verified: true,
    disclaimer: 'Analytical output only. No order is placed. No profit is guaranteed.',
  };
}

function fiveIntervals(timeframe) {
  const { TIMEFRAME_MS } = require('./expertoption-session');
  return ((TIMEFRAME_MS[timeframe] || 60_000) / 1000) * 5;
}

function round(value, digits = 6) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Number(n.toFixed(digits));
}

module.exports = {
  REQUESTED_ASSETS,
  ASSET_KEYS,
  EXPIRY_KEYS,
  EXPIRY_TIMEFRAME,
  EXPIRY_LABELS,
  resolveInstrument,
  describeAssets,
  supportResistance,
  analyzeAsset,
};
