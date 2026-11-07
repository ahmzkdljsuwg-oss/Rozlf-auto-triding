import math
from dataclasses import dataclass, field

from . import config, indicators, smc
from .market_data import MarketSnapshot, pip_size


@dataclass
class Signal:
    symbol: str
    timeframe: str
    side: str  # BUY / SELL / NO TRADE
    confidence: float
    entry: float
    stop_loss: float
    take_profit: float
    atr: float
    reason_en: str
    reason_ar: str
    score: float = 0.0
    checks: dict = field(default_factory=dict)
    analysis: dict = field(default_factory=dict)


def _clamp(v, lo, hi):
    return max(lo, min(hi, v))


def _score_timeframe(ind: dict, structure: dict, direction: int, role: str) -> tuple[float, list[str], list[str]]:
    """Returns (score in -1..1, bullish notes, bearish notes)."""
    notes_for: list[str] = []
    notes_against: list[str] = []
    score = 0.0

    trend = ind["trend"]
    if direction > 0 and trend == "bullish":
        score += 0.35
        notes_for.append("EMA trend bullish")
    elif direction < 0 and trend == "bearish":
        score += 0.35
        notes_for.append("EMA trend bearish")
    elif trend == "neutral":
        notes_against.append("EMA trend neutral")
    else:
        score -= 0.4
        notes_against.append("EMA trend opposes direction")

    if direction > 0 and ind["ema20"] > ind["ema50"]:
        score += 0.15
        notes_for.append("EMA20 above EMA50")
    elif direction < 0 and ind["ema20"] < ind["ema50"]:
        score += 0.15
        notes_for.append("EMA20 below EMA50")
    else:
        score -= 0.15
        notes_against.append("Short EMA alignment weak")

    if direction > 0:
        if 45 <= ind["rsi"] <= 70:
            score += 0.12
            notes_for.append(f"RSI constructive ({ind['rsi']:.1f})")
        elif ind["rsi"] > 78:
            score -= 0.25
            notes_against.append("RSI overbought")
        elif ind["rsi"] < 35:
            score -= 0.1
            notes_against.append("RSI weak for long")
    else:
        if 30 <= ind["rsi"] <= 55:
            score += 0.12
            notes_for.append(f"RSI constructive ({ind['rsi']:.1f})")
        elif ind["rsi"] < 22:
            score -= 0.25
            notes_against.append("RSI oversold")
        elif ind["rsi"] > 65:
            score -= 0.1
            notes_against.append("RSI strong against short")

    if direction > 0:
        if ind["macd_hist"] > 0 and ind["macd_hist"] >= ind["macd_hist_prev"]:
            score += 0.15
            notes_for.append("MACD momentum rising")
        elif ind["macd_hist"] < 0 < ind["macd_hist_prev"]:
            score -= 0.15
            notes_against.append("MACD momentum fading")
    else:
        if ind["macd_hist"] < 0 and ind["macd_hist"] <= ind["macd_hist_prev"]:
            score += 0.15
            notes_for.append("MACD momentum falling")
        elif ind["macd_hist"] > 0 > ind["macd_hist_prev"]:
            score -= 0.15
            notes_against.append("MACD momentum fading")

    if direction > 0 and ind["close"] > ind["bb_mid"]:
        score += 0.08
        notes_for.append("Price above Bollinger mid")
    elif direction < 0 and ind["close"] < ind["bb_mid"]:
        score += 0.08
        notes_for.append("Price below Bollinger mid")

    if role != "trigger":
        st = structure["structure"]
        if direction > 0 and (st["bos"] == "bullish" or st["choch"] == "bullish" or st["bias"] == "bullish"):
            score += 0.2
            notes_for.append("Bullish market structure")
        elif direction < 0 and (st["bos"] == "bearish" or st["choch"] == "bearish" or st["bias"] == "bearish"):
            score += 0.2
            notes_for.append("Bearish market structure")
        elif st["bias"] != "neutral":
            score -= 0.12
            notes_against.append("Market structure conflicts")

        sweep = structure["liquidity_sweep"]
        if direction > 0 and sweep["sweep"] == "bullish":
            score += 0.15
            notes_for.append("Bullish liquidity sweep")
        elif direction < 0 and sweep["sweep"] == "bearish":
            score += 0.15
            notes_for.append("Bearish liquidity sweep")

        blocks = structure["order_blocks"]
        if direction > 0 and any(b["type"] == "bullish" for b in blocks):
            score += 0.07
            notes_for.append("Bullish order block present")
        elif direction < 0 and any(b["type"] == "bearish" for b in blocks):
            score += 0.07
            notes_for.append("Bearish order block present")

        gaps = structure["fvg"]
        if direction > 0 and any(g["type"] == "bullish" for g in gaps):
            score += 0.07
            notes_for.append("Bullish FVG open")
        elif direction < 0 and any(g["type"] == "bearish" for g in gaps):
            score += 0.07
            notes_for.append("Bearish FVG open")

    if role == "trigger":
        if direction > 0 and ind["close"] > ind["high"] * 0.9995:
            score += 0.08
            notes_for.append("Price at candle high")
        if direction > 0 and ind["rsi_slope"] > 0:
            score += 0.07
            notes_for.append("RSI rising")
        if direction < 0 and ind["rsi_slope"] < 0:
            score += 0.07
            notes_for.append("RSI falling")

    return _clamp(score, -1.0, 1.0), notes_for, notes_against


def build_signal(symbol: str, timeframe: str, snaps: dict[str, MarketSnapshot]) -> Signal:
    """snaps is keyed by timeframe: D1, H1, M15, M5."""
    inds = {tf: indicators.analyze_candles(s.candles) for tf, s in snaps.items()}
    structures = {tf: smc.analyze_structure(s.candles) for tf, s in snaps.items() if tf in ("H1", "M15")}

    d1 = inds.get("D1")
    h1 = inds.get("H1") or inds.get("M15") or inds.get("M5")
    m15 = inds.get("M15") or h1
    m5 = inds.get("M5") or m15

    if not h1 or not m15 or not m5:
        return Signal(symbol, timeframe, "NO TRADE", 0, 0, 0, 0, 0,
                      "Insufficient market data", "بيانات السوق غير كافية")

    atr = m15["atr"] or m5["atr"]
    pip = pip_size(symbol)
    spread = config.MAX_SPREAD_PIPS * pip

    bull_score = 0.0
    bear_score = 0.0
    bull_notes: list[str] = []
    bear_notes: list[str] = []
    bull_against: list[str] = []
    bear_against: list[str] = []

    weights = {"D1": (0.20, "bias"), "H1": (0.30, "trend"), "M15": (0.30, "setup"), "M5": (0.20, "trigger")}
    for tf, (weight, role) in weights.items():
        ind = inds.get(tf)
        if not ind:
            continue
        st = structures.get(tf, {"structure": {"bos": None, "choch": None, "bias": "neutral"},
                                 "liquidity_sweep": {"sweep": None}, "order_blocks": [], "fvg": []})
        s_bull, n_bull, a_bull = _score_timeframe(ind, st, 1, role)
        s_bear, n_bear, a_bear = _score_timeframe(ind, st, -1, role)
        bull_score += weight * s_bull
        bear_score += weight * s_bear
        bull_notes += [f"{tf}: {n}" for n in n_bull]
        bear_notes += [f"{tf}: {n}" for n in n_bear]
        bull_against += [f"{tf}: {n}" for n in a_bull]
        bear_against += [f"{tf}: {n}" for n in a_bear]

    # ADX regime filter
    adx_val = m15["adx"]
    if adx_val and adx_val < 16:
        bull_score *= 0.7
        bear_score *= 0.7

    if bull_score >= bear_score:
        direction = 1
        raw = bull_score
        notes_for, notes_against = bull_notes, bull_against
    else:
        direction = -1
        raw = bear_score
        notes_for, notes_against = bear_notes, bear_against

    conflict = abs(bull_score - bear_score) < 0.12
    confidence = _clamp(0.5 + raw * 0.55, 0, 0.98)
    if conflict:
        confidence *= 0.8

    checks = {
        "adx": round(adx_val, 2),
        "atr": round(atr, 6),
        "spread_pips_est": round(spread / pip, 2),
        "bull_score": round(bull_score, 3),
        "bear_score": round(bear_score, 3),
        "conflict": conflict,
        "notes_for": notes_for[:6],
        "notes_against": notes_against[:4],
    }

    min_conf = config.DEFAULT_MIN_CONFIDENCE
    if confidence < min_conf or conflict or adx_val and adx_val < 14:
        return Signal(symbol, timeframe, "NO TRADE", round(confidence, 3), 0, 0, 0,
                      round(atr, 6),
                      "No qualified setup: " + ("/".join(notes_for[:3]) or "insufficient confluence"),
                      "لا توجد فرصة مؤهلة: تقارب المؤشرات غير كافٍ",
                      score=round(max(bull_score, bear_score), 3), checks=checks,
                      analysis={"timestamps": {tf: s.candles[-1].time for tf, s in snaps.items()}})

    price = m5["close"]
    entry = price + (spread / 2 if direction > 0 else -spread / 2)
    sl_distance = max(atr * 1.3, 8 * pip)
    tp_distance = sl_distance * 2.0

    swing_low = min(c.low for c in snaps["M15"].candles[-12:])
    swing_high = max(c.high for c in snaps["M15"].candles[-12:])
    if direction > 0:
        stop = min(swing_low - 2 * pip, entry - sl_distance)
        target = entry + max(tp_distance, entry - stop)
    else:
        stop = max(swing_high + 2 * pip, entry + sl_distance)
        target = entry - max(tp_distance, stop - entry)

    # Guard against absurd risk relative to ATR
    if abs(entry - stop) < 4 * pip:
        stop = entry - direction * 4 * pip
    if abs(target - entry) < 8 * pip:
        target = entry + direction * 8 * pip

    reason_en = "; ".join(notes_for[:5]) or "Multi-timeframe confluence"
    reason_ar = (
        "تقاطع إيجابي على عدة أطر زمنية مع اتجاه واضح وبنية سوق داعمة"
        if direction > 0 else
        "تقاطع سلبي على عدة أطر زمنية مع اتجاه هابط وبنية سوق داعمة"
    )

    return Signal(
        symbol=symbol, timeframe=timeframe, side="BUY" if direction > 0 else "SELL",
        confidence=round(confidence, 3), entry=round(entry, 6),
        stop_loss=round(stop, 6), take_profit=round(target, 6), atr=round(atr, 6),
        reason_en=reason_en, reason_ar=reason_ar,
        score=round(raw, 3), checks=checks,
        analysis={
            "indicators": {tf: {k: round(v, 6) if isinstance(v, float) else v
                                for k, v in inds[tf].items() if not isinstance(v, dict)}
                           for tf in inds},
            "structure": {tf: structures[tf] for tf in structures},
            "timestamps": {tf: s.candles[-1].time for tf, s in snaps.items()},
        },
    )
