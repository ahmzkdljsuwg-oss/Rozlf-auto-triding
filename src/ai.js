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
}

module.exports = { GeminiAnalyzer };
