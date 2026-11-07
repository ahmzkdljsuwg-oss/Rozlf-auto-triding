'use strict';

const config = require('./config');

class GeminiAnalyzer {
  constructor(apiKey = config.GEMINI_API_KEY, model = config.GEMINI_MODEL) {
    this.apiKey = apiKey;
    this.model = model;
  }

  get enabled() {
    return Boolean(this.apiKey);
  }

  async review(signal, marketContext = {}) {
    if (!this.enabled) {
      return { verdict: 'UNAVAILABLE', confidence: null, rationale: 'Gemini API key not configured', enabled: false };
    }
    // Only verified live values from the deterministic scan are sent. Gemini is
    // asked to judge them, never to invent prices or outcomes.
    const payload = {
      symbol: signal.symbol,
      timeframe: signal.timeframe,
      side: signal.side,
      confidence: signal.confidence,
      entry: signal.entry,
      stop_loss: signal.stop_loss,
      take_profit: signal.take_profit,
      atr: signal.atr,
      checks: signal.checks,
      structure: signal.structure || signal.analysis?.structure || {},
      indicators_by_timeframe: signal.analysis?.indicators || {},
      candle_timestamps: signal.analysis?.timestamps || {},
      context: marketContext,
    };

    const prompt = [
      'You are the second-stage risk reviewer for ROZLF AUTO TRADER.',
      'The deterministic engine has already computed the signal from real market candles.',
      'Verify that the signal is coherent across timeframes, trend, support/resistance, RSI,',
      'MACD, EMA, Bollinger Bands, ATR and SMC concepts (BOS, CHoCH, FVG, order blocks,',
      'liquidity sweeps). Reject contradictory, incomplete or weak setups.',
      'Do not invent any price, indicator value or outcome. Use only the JSON below.',
      'Reply with JSON only:',
      '{"verdict":"AGREE"|"CAUTION"|"REJECT","confidence":0-1,',
      '"rationale":"short reason","reasons":["..."],"risk_notes":["..."]}',
      JSON.stringify(payload).slice(0, 14000),
    ].join('\n');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 420, responseMimeType: 'application/json' },
        }),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        const text = (await response.text()).slice(0, 160);
        return {
          verdict: 'UNAVAILABLE', confidence: null,
          rationale: `Gemini HTTP ${response.status}: ${text}`, enabled: true,
        };
      }
      const data = await response.json();
      const parts = data?.candidates?.[0]?.content?.parts || [];
      let text = parts.map((p) => p.text || '').join('').trim();
      text = text.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
      let parsed;
      try { parsed = JSON.parse(text); } catch { parsed = null; }
      if (!parsed || typeof parsed !== 'object') {
        return { verdict: 'UNAVAILABLE', confidence: null, rationale: 'Unparseable Gemini response', enabled: true };
      }
      const verdict = String(parsed.verdict || '').toUpperCase();
      if (!['AGREE', 'CAUTION', 'REJECT'].includes(verdict)) {
        return { verdict: 'UNAVAILABLE', confidence: null, rationale: 'Gemini returned no valid verdict', enabled: true };
      }
      const confidence = Number(parsed.confidence);
      return {
        verdict,
        confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
        rationale: String(parsed.rationale || '').slice(0, 400),
        reasons: Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 6).map((r) => String(r).slice(0, 200)) : [],
        risk_notes: Array.isArray(parsed.risk_notes) ? parsed.risk_notes.slice(0, 4).map((r) => String(r).slice(0, 200)) : [],
        enabled: true,
      };
    } catch (err) {
      return { verdict: 'UNAVAILABLE', confidence: null, rationale: `Gemini unavailable: ${err.message}`, enabled: true };
    }
  }

  async analyzeChartImage({ imageBase64, mimeType, marketType = 'unknown', symbol = 'unknown', timeframe = 'unknown' }) {
    if (!this.enabled) throw new Error('GEMINI_API_KEY is not configured');
    const clean = String(imageBase64 || '').replace(/^data:[^,]+,/, '');
    if (!clean || clean.length > 7_000_000) throw new Error('Image is missing or too large (max about 5 MB)');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) {
      throw new Error('Only PNG, JPEG and WEBP images are supported');
    }
    const prompt = [
      'You are ROZLF chart-analysis assistant. Analyze ONLY what is visible in this chart image.',
      'The market may be Forex, OTC, Smarty, crypto, stocks, or another instrument.',
      'Do not claim to access broker account data, live prices, or hidden candles.',
      'Do not invent exact prices, expiry, candle times, or indicators that are not readable.',
      'If the screenshot is unclear or missing price scale/timeframe, say so and lower confidence.',
      'Assess trend and market structure; BOS/CHoCH only when visually supported; liquidity sweep, support/resistance zones, order blocks and FVG only when visible.',
      'Return JSON only with keys: market_type, symbol_seen, timeframe_seen, direction (BUY/SELL/WAIT), confidence (0-100), trend, structure, key_zones, setup, invalidation, expiry_guidance, reasons (array), limitations (array).',
      'Never describe a signal as guaranteed. For OTC/Smarty explicitly state image-only analysis and that no verified broker feed was used.',
      `User hints: market=${marketType}; symbol=${symbol}; timeframe=${timeframe}.`,
    ].join('\n');
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ role: 'user', parts: [
          { text: prompt },
          { inline_data: { mime_type: mimeType, data: clean } },
        ] }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 900, responseMimeType: 'application/json' },
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!response.ok) throw new Error(`Gemini image analysis failed (HTTP ${response.status})`);
    const data = await response.json();
    let text = (data?.candidates?.[0]?.content?.parts || []).map((part) => part.text || '').join('').trim();
    text = text.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    let result;
    try { result = JSON.parse(text); } catch { throw new Error('AI returned an unreadable analysis'); }
    const direction = String(result.direction || 'WAIT').toUpperCase();
    result.direction = ['BUY', 'SELL', 'WAIT'].includes(direction) ? direction : 'WAIT';
    result.confidence = Math.max(0, Math.min(100, Number(result.confidence) || 0));
    result.market_type = String(result.market_type || marketType).slice(0, 80);
    result.symbol_seen = String(result.symbol_seen || symbol).slice(0, 80);
    result.timeframe_seen = String(result.timeframe_seen || timeframe).slice(0, 40);
    result.image_only = true;
    result.execution_allowed = false;
    return result;
  }

}

class MistralAnalyzer {
  constructor(apiKey = config.MISTRAL_API_KEY, model = config.MISTRAL_MODEL) {
    this.apiKey = apiKey;
    this.model = model;
  }

  get enabled() { return Boolean(this.apiKey); }

  async review(signal, marketContext = {}) {
    if (!this.enabled) return { verdict: 'UNAVAILABLE', confidence: null, rationale: 'Mistral API key not configured', enabled: false };
    const payload = {
      symbol: signal.symbol, timeframe: signal.timeframe, side: signal.side,
      confidence: signal.confidence, entry: signal.entry, stop_loss: signal.stop_loss,
      take_profit: signal.take_profit, atr: signal.atr, checks: signal.checks,
      structure: signal.structure || signal.analysis?.structure || {},
      indicators_by_timeframe: signal.analysis?.indicators || {},
      candle_timestamps: signal.analysis?.timestamps || {}, context: marketContext,
    };
    const prompt = [
      'You are the second-stage risk reviewer for ROZLF.',
      'Review only the supplied deterministic signal and verified market data.',
      'Check trend, timeframe agreement, support/resistance, RSI, MACD, EMA, Bollinger, ATR and SMC evidence.',
      'Never invent prices, indicators, candles, market access or outcomes. Reject contradictory or incomplete setups.',
      'Return JSON only: {"verdict":"AGREE|CAUTION|REJECT","confidence":0-1,"rationale":"short reason","reasons":[],"risk_notes":[]}',
      JSON.stringify(payload).slice(0, 14000),
    ].join('\n');
    try {
      const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({ model: this.model, temperature: 0.1, max_tokens: 500,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'You are a cautious trading risk reviewer. Output valid JSON only.' },
            { role: 'user', content: prompt },
          ] }),
        signal: AbortSignal.timeout(30000),
      });
      if (!response.ok) {
        const detail = (await response.text()).slice(0, 160);
        return { verdict: 'UNAVAILABLE', confidence: null, rationale: `Mistral HTTP ${response.status}: ${detail}`, enabled: true };
      }
      const data = await response.json();
      let raw = data?.choices?.[0]?.message?.content || '';
      if (Array.isArray(raw)) raw = raw.map(x => x.text || '').join('');
      raw = String(raw).replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
      const parsed = JSON.parse(raw);
      const verdict = String(parsed.verdict || '').toUpperCase();
      if (!['AGREE', 'CAUTION', 'REJECT'].includes(verdict)) {
        return { verdict: 'UNAVAILABLE', confidence: null, rationale: 'Mistral returned no valid verdict', enabled: true };
      }
      const confidence = Number(parsed.confidence);
      return {
        verdict,
        confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
        rationale: String(parsed.rationale || '').slice(0, 400),
        reasons: Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 6).map(x => String(x).slice(0, 200)) : [],
        risk_notes: Array.isArray(parsed.risk_notes) ? parsed.risk_notes.slice(0, 4).map(x => String(x).slice(0, 200)) : [],
        enabled: true,
      };
    } catch (err) {
      return { verdict: 'UNAVAILABLE', confidence: null, rationale: `Mistral unavailable: ${err.message}`, enabled: true };
    }
  }

  async analyzeMarketSnapshot(snapshot) {
    if (!this.enabled) throw new Error('MISTRAL_API_KEY is not configured');
    const prompt = [
      'You are the market analyst for ROZLF AUTO TRADER.',
      'You receive a verified numeric snapshot computed from real candles of one asset.',
      'Decide the next short-term move for the stated expiry: UP, DOWN or NO TRADE.',
      'Rules: never invent prices, candles or indicators; use only the supplied numbers.',
      'Choose NO TRADE when trend, momentum and structure disagree, when ADX is weak,',
      'when price sits inside the chop between support and resistance, or when the data is thin.',
      'Return JSON only: {"direction":"UP|DOWN|NO_TRADE","confidence":0-100,',
      '"reasons":["short reason in Arabic"],"expiry_note":"one short sentence"}.',
      JSON.stringify(snapshot).slice(0, 16000),
    ].join('\n');
    let response;
    try {
      response = await fetch('https://api.mistral.ai/v1/chat/completions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.1,
          max_tokens: 600,
          response_format: { type: 'json_object' },
          messages: [
            { role: 'system', content: 'You are a cautious market analyst. Output valid JSON only. Never invent data.' },
            { role: 'user', content: prompt },
          ],
        }),
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      const timedOut = err?.name === 'TimeoutError' || err?.name === 'AbortError';
      throw new Error(timedOut ? 'Mistral request timed out' : `Mistral request failed: ${err.message}`);
    }
    if (response.status === 401 || response.status === 403) throw new Error('Mistral rejected the API key (HTTP 401)');
    if (response.status === 429) throw new Error('Mistral rate limit reached (HTTP 429)');
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 160);
      throw new Error(`Mistral HTTP ${response.status}: ${detail}`);
    }
    const data = await response.json();
    let raw = data?.choices?.[0]?.message?.content || '';
    if (Array.isArray(raw)) raw = raw.map((x) => x.text || '').join('');
    raw = String(raw).replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    let parsed;
    try { parsed = JSON.parse(raw); } catch { throw new Error('Mistral returned an unreadable analysis'); }
    const direction = String(parsed.direction || '').toUpperCase().replace(/[\s-]+/g, '_');
    if (!['UP', 'DOWN', 'NO_TRADE'].includes(direction)) throw new Error('Mistral returned an invalid direction');
    const confidence = Number(parsed.confidence);
    return {
      direction,
      confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(100, confidence)) / 100 : null,
      reasons: Array.isArray(parsed.reasons) ? parsed.reasons.slice(0, 6).map((r) => String(r).slice(0, 200)) : [],
      expiry_note: parsed.expiry_note ? String(parsed.expiry_note).slice(0, 200) : null,
      model: this.model,
    };
  }

  async analyzeChartImage({ imageBase64, mimeType, marketType = 'unknown', symbol = 'unknown', timeframe = 'unknown' }) {
    if (!this.enabled) throw new Error('MISTRAL_API_KEY is not configured');
    const clean = String(imageBase64 || '').replace(/^data:[^,]+,/, '');
    if (!clean || clean.length > 7_000_000) throw new Error('Image is missing or too large (max about 5 MB)');
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(mimeType)) {
      throw new Error('Only PNG, JPEG and WEBP images are supported');
    }
    const prompt = [
      'You are ROZLF chart-analysis assistant. Analyze ONLY what is visible in this chart image.',
      'The market may be Forex, OTC, Smarty, or a synthetic index.',
      'Do not claim access to broker account data, live prices, or hidden candles.',
      'Never invent exact prices, expiry, candle times, or indicators that are not readable.',
      'If the screenshot is unclear, return WAIT and explain the limitation.',
      'Assess trend, market structure, BOS/CHoCH, liquidity sweeps, support/resistance, order blocks and FVG only when visually supported.',
      'Return JSON only with keys: market_type, symbol_seen, timeframe_seen, direction (BUY/SELL/WAIT), confidence (0-100), trend, structure, key_zones, setup, invalidation, expiry_guidance, reasons (array), limitations (array).',
      'Never describe a signal as guaranteed. For OTC/Smarty state clearly that this is image-only analysis and no verified broker feed was used.',
      `User hints: market=${marketType}; symbol=${symbol}; timeframe=${timeframe}.`,
    ].join('\n');
    const response = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
      body: JSON.stringify({
        model: this.model,
        temperature: 0.1,
        max_tokens: 900,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: 'You are a cautious chart analyst. Return valid JSON only.' },
          { role: 'user', content: [
            { type: 'text', text: prompt },
            { type: 'image_url', image_url: `data:${mimeType};base64,${clean}` },
          ] },
        ],
      }),
      signal: AbortSignal.timeout(45000),
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 180);
      throw new Error(`Mistral image analysis failed (HTTP ${response.status}): ${detail}`);
    }
    const data = await response.json();
    let raw = data?.choices?.[0]?.message?.content || '';
    if (Array.isArray(raw)) raw = raw.map((part) => part.text || '').join('');
    raw = String(raw).replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    let result;
    try { result = JSON.parse(raw); } catch { throw new Error('Mistral returned an unreadable image analysis'); }
    const direction = String(result.direction || 'WAIT').toUpperCase();
    result.direction = ['BUY', 'SELL', 'WAIT'].includes(direction) ? direction : 'WAIT';
    result.confidence = Math.max(0, Math.min(100, Number(result.confidence) || 0));
    result.market_type = String(result.market_type || marketType).slice(0, 80);
    result.symbol_seen = String(result.symbol_seen || symbol).slice(0, 80);
    result.timeframe_seen = String(result.timeframe_seen || timeframe).slice(0, 40);
    result.image_only = true;
    result.execution_allowed = false;
    return result;
  }
}

class RozlfAnalyzer {
  constructor() {
    // Mistral is the only configured AI provider; never silently fall back to Gemini.
    this.primary = new MistralAnalyzer();
  }
  get enabled() { return this.primary.enabled; }
  review(signal, context) { return this.primary.review(signal, context); }
  analyzeChartImage(args) { return this.primary.analyzeChartImage(args); }
}

module.exports = { GeminiAnalyzer, MistralAnalyzer, RozlfAnalyzer };
