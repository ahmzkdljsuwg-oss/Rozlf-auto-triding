from .market_data import Candle


def find_swings(candles: list[Candle], lookback: int = 3) -> list[dict]:
    swings = []
    for i in range(lookback, len(candles) - lookback):
        window = candles[i - lookback:i + lookback + 1]
        if candles[i].high >= max(c.high for c in window):
            swings.append({"index": i, "price": candles[i].high, "type": "high", "time": candles[i].time})
        if candles[i].low <= min(c.low for c in window):
            swings.append({"index": i, "price": candles[i].low, "type": "low", "time": candles[i].time})
    return swings


def detect_bos_choch(candles: list[Candle], swings: list[dict]) -> dict:
    if len(candles) < 10 or not swings:
        return {"bos": None, "choch": None, "bias": "neutral", "break_level": None, "notes": []}

    highs = [s for s in swings if s["type"] == "high"]
    lows = [s for s in swings if s["type"] == "low"]
    last_close = candles[-1].close
    notes = []

    bos = None
    choch = None
    break_level = None

    if highs and last_close > highs[-1]["price"]:
        bos = "bullish"
        break_level = highs[-1]["price"]
        notes.append(f"Bullish BOS above {break_level:.5f}")
    elif lows and last_close < lows[-1]["price"]:
        bos = "bearish"
        break_level = lows[-1]["price"]
        notes.append(f"Bearish BOS below {break_level:.5f}")

    if len(highs) >= 2 and len(lows) >= 2:
        recent_highs = highs[-2:]
        recent_lows = lows[-2:]
        rising_highs = recent_highs[-1]["price"] > recent_highs[-2]["price"]
        rising_lows = recent_lows[-1]["price"] > recent_lows[-2]["price"]
        falling_highs = recent_highs[-1]["price"] < recent_highs[-2]["price"]
        falling_lows = recent_lows[-1]["price"] < recent_lows[-2]["price"]
        if falling_highs and falling_lows and bos == "bullish":
            choch = "bullish"
            notes.append("Bullish CHoCH: bearish structure broken")
        elif rising_highs and rising_lows and bos == "bearish":
            choch = "bearish"
            notes.append("Bearish CHoCH: bullish structure broken")

    bias = "bullish" if (bos == "bullish" or choch == "bullish") else "bearish" if (bos == "bearish" or choch == "bearish") else "neutral"
    return {"bos": bos, "choch": choch, "bias": bias, "break_level": break_level,
            "last_swing_high": highs[-1]["price"] if highs else None,
            "last_swing_low": lows[-1]["price"] if lows else None, "notes": notes}


def detect_fvg(candles: list[Candle], max_age: int = 40) -> list[dict]:
    gaps = []
    start = max(2, len(candles) - max_age)
    for i in range(start, len(candles)):
        prev2, cur = candles[i - 2], candles[i]
        if cur.low > prev2.high:
            gap = {"type": "bullish", "top": cur.low, "bottom": prev2.high, "index": i,
                   "time": cur.time, "filled": False}
        elif cur.high < prev2.low:
            gap = {"type": "bearish", "top": prev2.low, "bottom": cur.high, "index": i,
                   "time": cur.time, "filled": False}
        else:
            continue
        for later in candles[i + 1:]:
            if gap["type"] == "bullish" and later.low <= gap["bottom"]:
                gap["filled"] = True
                break
            if gap["type"] == "bearish" and later.high >= gap["top"]:
                gap["filled"] = True
                break
        gaps.append(gap)
    return gaps


def detect_order_blocks(candles: list[Candle], max_age: int = 60) -> list[dict]:
    blocks = []
    start = max(1, len(candles) - max_age)
    for i in range(start, len(candles)):
        cur = candles[i]
        body = abs(cur.close - cur.open)
        recent = candles[max(0, i - 10):i]
        if not recent:
            continue
        avg_body = sum(abs(c.close - c.open) for c in recent) / len(recent) or 1e-9
        if cur.close > cur.open and body > avg_body * 1.8:
            for j in range(i - 1, max(-1, i - 8), -1):
                if candles[j].close < candles[j].open:
                    blocks.append({"type": "bullish", "top": max(candles[j].open, candles[j].close),
                                   "bottom": candles[j].low, "index": j, "time": candles[j].time})
                    break
        elif cur.close < cur.open and body > avg_body * 1.8:
            for j in range(i - 1, max(-1, i - 8), -1):
                if candles[j].close > candles[j].open:
                    blocks.append({"type": "bearish", "top": candles[j].high,
                                   "bottom": min(candles[j].open, candles[j].close),
                                   "index": j, "time": candles[j].time})
                    break
    return blocks[-6:]


def detect_liquidity_sweep(candles: list[Candle], swings: list[dict], lookback: int = 20) -> dict:
    if len(candles) < lookback:
        return {"sweep": None, "level": None, "note": ""}
    recent = candles[-lookback:]
    highs = [s for s in swings if s["type"] == "high" and s["index"] < len(candles) - 2]
    lows = [s for s in swings if s["type"] == "low" and s["index"] < len(candles) - 2]
    last = candles[-1]

    if highs:
        prior_high = highs[-1]["price"]
        if last.high > prior_high and last.close < prior_high:
            return {"sweep": "bearish", "level": prior_high,
                    "note": "Liquidity swept above prior high then rejected"}
    if lows:
        prior_low = lows[-1]["price"]
        if last.low < prior_low and last.close > prior_low:
            return {"sweep": "bullish", "level": prior_low,
                    "note": "Liquidity swept below prior low then reclaimed"}
    return {"sweep": None, "level": None, "note": ""}


def analyze_structure(candles: list[Candle]) -> dict:
    swings = find_swings(candles)
    structure = detect_bos_choch(candles, swings)
    gaps = detect_fvg(candles)
    blocks = detect_order_blocks(candles)
    sweep = detect_liquidity_sweep(candles, swings)
    active_gaps = [g for g in gaps if not g["filled"]]
    return {
        "swings": swings[-8:],
        "structure": structure,
        "fvg": active_gaps[-3:],
        "order_blocks": blocks,
        "liquidity_sweep": sweep,
        "notes": structure["notes"] + ([sweep["note"]] if sweep["note"] else []),
    }
