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
    const payload = {
      symbol: signal.symbol,
      timeframe: signal.timeframe,
      side: signal.side,
      confidence: signal.confidence,
      entry: signal.entry,
      stop_loss: signal.stop_loss,
      take_profit: signal.take_profit,
      checks: signal.checks,
      context: marketContext,
    };

    const prompt = [
      'You are a conservative trading risk reviewer. Review this deterministic signal.',
      'Only judge whether the setup is coherent with the supplied live market snapshot.',
      'Never invent prices or results. Reply with JSON only:',
      '{"verdict":"AGREE"|"CAUTION"|"REJECT","confidence":0-1,"rationale":"one short sentence"}',
      JSON.stringify(payload).slice(0, 6000),
    ].join('\n');

    const url = `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${encodeURIComponent(this.model)}:generateContent?key=${encodeURIComponent(this.apiKey)}`;

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 220, responseMimeType: 'application/json' },
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
      const confidence = Number(parsed.confidence);
      return {
        verdict: String(parsed.verdict || 'CAUTION').toUpperCase().slice(0, 12),
        confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
        rationale: String(parsed.rationale || '').slice(0, 400),
        enabled: true,
      };
    } catch (err) {
      return { verdict: 'UNAVAILABLE', confidence: null, rationale: `Gemini unavailable: ${err.message}`, enabled: true };
    }
  }
}

module.exports = { GeminiAnalyzer };
