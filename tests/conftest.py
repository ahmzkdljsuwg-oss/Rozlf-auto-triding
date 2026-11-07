import math
import sys
import time
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.market_data import Candle, MarketSnapshot  # noqa: E402


class FakeMarket:
    """Deterministic market used by tests; never touches the network."""

    def __init__(self, start: float = 1.10, trend: float = 0.00002):
        self.start = start
        self.trend = trend
        self.price = start

    def _candles(self, n: int = 240) -> list[Candle]:
        out = []
        base = time.time() - n * 300
        price = self.start
        for i in range(n):
            drift = self.trend * i
            wave = math.sin(i / 7.0) * 0.0012
            close = self.start + drift + wave
            open_ = close - self.trend
            high = max(open_, close) + 0.0007
            low = min(open_, close) - 0.0007
            out.append(Candle(int(base + i * 300), open_, high, low, close, 100 + i))
        return out

    def get(self, symbol: str, timeframe: str, max_age: float = 60) -> MarketSnapshot:
        candles = self._candles()
        return MarketSnapshot(
            symbol=symbol, timeframe=timeframe, candles=candles,
            price=candles[-1].close, previous_close=candles[-2].close,
            fetched_at=time.time(), source="test", is_stale=False,
        )

    def latest_price(self, symbol: str) -> float:
        return self._candles()[-1].close

    def price(self, symbol: str) -> float:
        return self.latest_price(symbol)

    def spread_pips(self, symbol: str, atr: float | None = None) -> float:
        return 1.0

    def close(self):
        pass


@pytest.fixture
def fake_market():
    return FakeMarket()
