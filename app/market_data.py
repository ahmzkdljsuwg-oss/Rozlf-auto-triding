import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

import httpx

from . import config


YAHOO_SYMBOLS = {
    "EURUSD": "EURUSD=X",
    "GBPUSD": "GBPUSD=X",
    "USDJPY": "USDJPY=X",
    "AUDUSD": "AUDUSD=X",
    "USDCAD": "USDCAD=X",
    "NZDUSD": "NZDUSD=X",
    "XAUUSD": "GC=F",
}

INTERVAL_MAP = {"M5": "5m", "M15": "15m", "H1": "1h", "H4": "1h", "D1": "1d"}
RANGE_MAP = {"M5": "5d", "M15": "5d", "H1": "1mo", "H4": "1mo", "D1": "6mo"}

PIP_SIZE = {
    "EURUSD": 0.0001, "GBPUSD": 0.0001, "AUDUSD": 0.0001,
    "USDCAD": 0.0001, "NZDUSD": 0.0001,
    "USDJPY": 0.01, "XAUUSD": 0.1,
}

# Typical demo spread in pips, widened when volatility is high.
BASE_SPREAD_PIPS = {
    "EURUSD": 0.8, "GBPUSD": 1.1, "USDJPY": 0.9, "AUDUSD": 1.0,
    "USDCAD": 1.3, "NZDUSD": 1.5, "XAUUSD": 2.5,
}


@dataclass
class Candle:
    time: int
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0


@dataclass
class MarketSnapshot:
    symbol: str
    timeframe: str
    candles: list[Candle]
    price: float
    previous_close: float
    fetched_at: float
    source: str = "yahoo"
    is_stale: bool = False
    extra: dict = field(default_factory=dict)

    @property
    def timeframe_seconds(self) -> int:
        return {"M5": 300, "M15": 900, "H1": 3600, "H4": 14400, "D1": 86400}.get(self.timeframe, 300)


class MarketDataError(Exception):
    pass


class MarketDataService:
    def __init__(self, timeout: float = 12.0):
        self._client = httpx.Client(
            timeout=timeout,
            headers={"User-Agent": "Mozilla/5.0 (compatible; RozlfAutoTrader/1.0)"},
        )
        self._cache: dict[tuple[str, str], MarketSnapshot] = {}
        self.last_error: str | None = None
        self.connected = False

    def close(self):
        self._client.close()

    def _fetch_yahoo(self, symbol: str, timeframe: str) -> MarketSnapshot:
        ysym = YAHOO_SYMBOLS.get(symbol)
        if not ysym:
            raise MarketDataError(f"Unsupported symbol: {symbol}")
        interval = INTERVAL_MAP[timeframe]
        rng = RANGE_MAP[timeframe]
        url = f"https://query1.finance.yahoo.com/v8/finance/chart/{ysym}"
        params = {"interval": interval, "range": rng, "includePrePost": "false"}
        last_exc = None
        for attempt in range(3):
            try:
                resp = self._client.get(url, params=params)
                if resp.status_code == 429:
                    time.sleep(1.5 * (attempt + 1))
                    continue
                resp.raise_for_status()
                payload = resp.json()
                result = payload.get("chart", {}).get("result")
                if not result:
                    raise MarketDataError(payload.get("chart", {}).get("error", {}).get("description", "no data"))
                data = result[0]
                timestamps = data.get("timestamp") or []
                quote = (data.get("indicators", {}).get("quote") or [{}])[0]
                opens = quote.get("open") or []
                highs = quote.get("high") or []
                lows = quote.get("low") or []
                closes = quote.get("close") or []
                volumes = quote.get("volume") or []
                candles: list[Candle] = []
                for i, ts in enumerate(timestamps):
                    try:
                        o, h, l, c = opens[i], highs[i], lows[i], closes[i]
                    except IndexError:
                        continue
                    if None in (o, h, l, c):
                        continue
                    v = volumes[i] if i < len(volumes) and volumes[i] is not None else 0
                    candles.append(Candle(int(ts), float(o), float(h), float(l), float(c), float(v)))
                if len(candles) < 60:
                    raise MarketDataError(f"insufficient candles for {symbol} {timeframe}")
                if timeframe == "H4":
                    candles = self._aggregate(candles, 4)
                meta = data.get("meta", {})
                price = float(meta.get("regularMarketPrice") or candles[-1].close)
                prev = float(meta.get("chartPreviousClose") or meta.get("previousClose") or candles[0].open)
                now = time.time()
                stale = (now - candles[-1].time) > (self._tf_seconds(timeframe) * 4)
                self.connected = True
                self.last_error = None
                return MarketSnapshot(
                    symbol=symbol, timeframe=timeframe, candles=candles, price=price,
                    previous_close=prev, fetched_at=now, is_stale=stale,
                    extra={"market_time": meta.get("regularMarketTime"), "exchange": meta.get("exchangeName")},
                )
            except (httpx.HTTPError, ValueError, KeyError) as exc:
                last_exc = exc
                time.sleep(0.8 * (attempt + 1))
        self.connected = False
        self.last_error = str(last_exc)
        raise MarketDataError(f"{symbol} {timeframe}: {last_exc}")

    @staticmethod
    def _tf_seconds(tf: str) -> int:
        return {"M5": 300, "M15": 900, "H1": 3600, "H4": 14400, "D1": 86400}.get(tf, 300)

    @staticmethod
    def _aggregate(candles: list[Candle], factor: int) -> list[Candle]:
        out: list[Candle] = []
        for i in range(0, len(candles) - factor + 1, factor):
            chunk = candles[i:i + factor]
            out.append(Candle(
                time=chunk[0].time, open=chunk[0].open, high=max(c.high for c in chunk),
                low=min(c.low for c in chunk), close=chunk[-1].close,
                volume=sum(c.volume for c in chunk),
            ))
        return out

    def get(self, symbol: str, timeframe: str, max_age: float = 20.0) -> MarketSnapshot:
        key = (symbol, timeframe)
        cached = self._cache.get(key)
        if cached and (time.time() - cached.fetched_at) < max_age:
            return cached
        snap = self._fetch_yahoo(symbol, timeframe)
        self._cache[key] = snap
        return snap

    def latest_price(self, symbol: str) -> float:
        snap = self.get(symbol, "M5", max_age=15)
        return snap.price

    def spread_pips(self, symbol: str, atr: float | None = None) -> float:
        base = BASE_SPREAD_PIPS.get(symbol, 1.0)
        if atr:
            pip = PIP_SIZE.get(symbol, 0.0001)
            # widen spread with volatility, capped at 3x base
            base = min(base * 3, max(base, base * (atr / (pip * 15))))
        return round(base, 2)


def pip_size(symbol: str) -> float:
    return PIP_SIZE.get(symbol, 0.0001)


def pip_value_per_lot(symbol: str) -> float:
    # Approximate USD value of one pip for 1 standard lot.
    return 10.0 if symbol != "XAUUSD" else 10.0
