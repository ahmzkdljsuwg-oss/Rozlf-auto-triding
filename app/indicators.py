import numpy as np

from .market_data import Candle


def ema(values: np.ndarray, period: int) -> np.ndarray:
    values = np.asarray(values, dtype=float)
    if len(values) == 0:
        return values
    alpha = 2.0 / (period + 1.0)
    out = np.empty_like(values)
    out[0] = values[0]
    for i in range(1, len(values)):
        out[i] = alpha * values[i] + (1 - alpha) * out[i - 1]
    return out


def sma(values: np.ndarray, period: int) -> np.ndarray:
    values = np.asarray(values, dtype=float)
    out = np.full_like(values, np.nan)
    if len(values) < period:
        return out
    cumsum = np.cumsum(np.insert(values, 0, 0.0))
    out[period - 1:] = (cumsum[period:] - cumsum[:-period]) / period
    return out


def rsi(values: np.ndarray, period: int = 14) -> np.ndarray:
    values = np.asarray(values, dtype=float)
    out = np.full_like(values, np.nan)
    if len(values) <= period:
        return out
    delta = np.diff(values)
    gains = np.where(delta > 0, delta, 0.0)
    losses = np.where(delta < 0, -delta, 0.0)
    avg_gain = gains[:period].mean()
    avg_loss = losses[:period].mean()
    for i in range(period, len(values)):
        if i > period:
            avg_gain = (avg_gain * (period - 1) + gains[i - 1]) / period
            avg_loss = (avg_loss * (period - 1) + losses[i - 1]) / period
        rs = avg_gain / avg_loss if avg_loss != 0 else 100.0
        out[i] = 100.0 - (100.0 / (1.0 + rs))
    return out


def macd(values: np.ndarray, fast: int = 12, slow: int = 26, signal: int = 9):
    values = np.asarray(values, dtype=float)
    macd_line = ema(values, fast) - ema(values, slow)
    signal_line = ema(macd_line, signal)
    hist = macd_line - signal_line
    return macd_line, signal_line, hist


def bollinger(values: np.ndarray, period: int = 20, mult: float = 2.0):
    values = np.asarray(values, dtype=float)
    mid = sma(values, period)
    std = np.full_like(values, np.nan)
    for i in range(period - 1, len(values)):
        std[i] = values[i - period + 1:i + 1].std()
    return mid - mult * std, mid, mid + mult * std


def atr(candles: list[Candle], period: int = 14) -> np.ndarray:
    n = len(candles)
    out = np.full(n, np.nan)
    if n < period + 1:
        return out
    tr = np.zeros(n)
    for i in range(1, n):
        h, l, pc = candles[i].high, candles[i].low, candles[i - 1].close
        tr[i] = max(h - l, abs(h - pc), abs(l - pc))
    out[period] = tr[1:period + 1].mean()
    for i in range(period + 1, n):
        out[i] = (out[i - 1] * (period - 1) + tr[i]) / period
    return out


def adx(candles: list[Candle], period: int = 14):
    n = len(candles)
    if n < period * 2:
        return np.full(n, np.nan), np.full(n, np.nan), np.full(n, np.nan)
    plus_dm = np.zeros(n)
    minus_dm = np.zeros(n)
    tr = np.zeros(n)
    for i in range(1, n):
        up = candles[i].high - candles[i - 1].high
        down = candles[i - 1].low - candles[i].low
        plus_dm[i] = up if (up > down and up > 0) else 0.0
        minus_dm[i] = down if (down > up and down > 0) else 0.0
        h, l, pc = candles[i].high, candles[i].low, candles[i - 1].close
        tr[i] = max(h - l, abs(h - pc), abs(l - pc))
    atr_s = np.zeros(n)
    plus_s = np.zeros(n)
    minus_s = np.zeros(n)
    atr_s[period] = tr[1:period + 1].sum()
    plus_s[period] = plus_dm[1:period + 1].sum()
    minus_s[period] = minus_dm[1:period + 1].sum()
    for i in range(period + 1, n):
        atr_s[i] = atr_s[i - 1] - atr_s[i - 1] / period + tr[i]
        plus_s[i] = plus_s[i - 1] - plus_s[i - 1] / period + plus_dm[i]
        minus_s[i] = minus_s[i - 1] - minus_s[i - 1] / period + minus_dm[i]
    safe_atr = np.where(atr_s > 0, atr_s, np.nan)
    plus_di = np.nan_to_num(100 * plus_s / safe_atr, nan=0.0)
    minus_di = np.nan_to_num(100 * minus_s / safe_atr, nan=0.0)
    di_sum = plus_di + minus_di
    dx = np.nan_to_num(100 * np.abs(plus_di - minus_di) / np.where(di_sum > 0, di_sum, np.nan), nan=0.0)
    adx_out = np.full(n, np.nan)
    start = period * 2
    if n > start:
        adx_out[start] = dx[period + 1:start + 1].mean()
        for i in range(start + 1, n):
            adx_out[i] = (adx_out[i - 1] * (period - 1) + dx[i]) / period
    return adx_out, plus_di, minus_di


def analyze_candles(candles: list[Candle]) -> dict:
    closes = np.array([c.close for c in candles], dtype=float)
    highs = np.array([c.high for c in candles], dtype=float)
    lows = np.array([c.low for c in candles], dtype=float)

    ema20 = ema(closes, 20)
    ema50 = ema(closes, 50)
    ema200 = ema(closes, 200) if len(closes) >= 200 else ema(closes, max(50, len(closes) // 2))
    rsi14 = rsi(closes, 14)
    macd_line, signal_line, hist = macd(closes)
    bb_low, bb_mid, bb_high = bollinger(closes, 20, 2.0)
    atr14 = atr(candles, 14)
    adx14, plus_di, minus_di = adx(candles, 14)
    sma20 = sma(closes, 20)

    last = -1
    prev = -2
    price = closes[last]
    bandwidth = (bb_high[last] - bb_low[last]) / bb_mid[last] * 100 if bb_mid[last] else 0

    trend = "neutral"
    if price > ema50[last] > ema200[last]:
        trend = "bullish"
    elif price < ema50[last] < ema200[last]:
        trend = "bearish"

    rsi_val = float(rsi14[last]) if not np.isnan(rsi14[last]) else 50.0
    rsi_slope = rsi_val - (float(rsi14[prev]) if not np.isnan(rsi14[prev]) else rsi_val)

    return {
        "price": price,
        "ema20": float(ema20[last]),
        "ema50": float(ema50[last]),
        "ema200": float(ema200[last]),
        "rsi": rsi_val,
        "rsi_slope": rsi_slope,
        "macd": float(macd_line[last]),
        "macd_signal": float(signal_line[last]),
        "macd_hist": float(hist[last]),
        "macd_hist_prev": float(hist[prev]),
        "bb_low": float(bb_low[last]),
        "bb_mid": float(bb_mid[last]),
        "bb_high": float(bb_high[last]),
        "bb_bandwidth": float(bandwidth),
        "atr": float(atr14[last]) if not np.isnan(atr14[last]) else 0.0,
        "adx": float(adx14[last]) if not np.isnan(adx14[last]) else 0.0,
        "plus_di": float(plus_di[last]) if not np.isnan(plus_di[last]) else 0.0,
        "minus_di": float(minus_di[last]) if not np.isnan(minus_di[last]) else 0.0,
        "sma20": float(sma20[last]) if not np.isnan(sma20[last]) else price,
        "trend": trend,
        "volatility_pct": float(atr14[last] / price * 100) if not np.isnan(atr14[last]) and price else 0.0,
        "high": float(highs[last]),
        "low": float(lows[last]),
        "close": float(closes[last]),
    }
