import json

import httpx

from . import config


PROMPT = """You are a conservative forex and gold market analyst.
Review the structured analysis below and decide whether the proposed trade has a genuine edge.
Only use the supplied data. Do not invent prices or news.
Reply with compact JSON only:
{"verdict":"BUY"|"SELL"|"NO_TRADE","confidence":0.0-1.0,"rationale":"<= 45 words"}

Rules:
- Prefer NO_TRADE when signals conflict, structure is unclear, or volatility is abnormal.
- The proposed direction is a hypothesis, not an instruction.
- Never suggest increasing risk.

ANALYSIS:
{payload}
"""


class GeminiAnalyzer:
    def __init__(self):
        self.enabled = bool(config.GEMINI_API_KEY)
        self.model = config.GEMINI_MODEL
        self.last_error: str | None = None

    def review(self, signal, market_context: dict) -> dict:
        if not self.enabled:
            return {"enabled": False, "verdict": "UNAVAILABLE", "confidence": 0.0,
                    "rationale": "Gemini API key not configured; deterministic engine only."}

        payload = {
            "symbol": signal.symbol,
            "timeframe": signal.timeframe,
            "proposed_side": signal.side,
            "proposed_entry": signal.entry,
            "proposed_stop_loss": signal.stop_loss,
            "proposed_take_profit": signal.take_profit,
            "deterministic_confidence": signal.confidence,
            "deterministic_reason": signal.reason_en,
            "market_context": market_context,
        }
        url = f"https://generativelanguage.googleapis.com/v1beta/models/{self.model}:generateContent"
        body = {
            "contents": [{"role": "user", "parts": [{"text": PROMPT.format(
                payload=json.dumps(payload, default=str)[:12000])}]}],
            "generationConfig": {"temperature": 0.2, "maxOutputTokens": 300,
                                 "responseMimeType": "application/json"},
        }
        try:
            resp = httpx.post(url, params={"key": config.GEMINI_API_KEY}, json=body, timeout=25.0)
            resp.raise_for_status()
            data = resp.json()
            text = data["candidates"][0]["content"]["parts"][0]["text"]
            parsed = json.loads(text)
            verdict = str(parsed.get("verdict", "NO_TRADE")).upper().replace(" ", "_")
            if verdict not in ("BUY", "SELL", "NO_TRADE"):
                verdict = "NO_TRADE"
            confidence = max(0.0, min(1.0, float(parsed.get("confidence", 0))))
            self.last_error = None
            return {
                "enabled": True, "verdict": verdict, "confidence": round(confidence, 3),
                "rationale": str(parsed.get("rationale", ""))[:400],
            }
        except Exception as exc:  # network, quota, schema
            self.last_error = str(exc)[:300]
            return {"enabled": True, "verdict": "UNAVAILABLE", "confidence": 0.0,
                    "rationale": f"Gemini unavailable: {self.last_error}"}
