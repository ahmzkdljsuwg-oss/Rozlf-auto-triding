"""Unified read-only data-source contract for ROZLF.

Every market-data provider ROZLF can use is wrapped in one adapter exposing the
same five calls — assets, quote, candles, timeframes, status — so the rest of the
system never depends on a specific vendor's payload shape. All providers are
read-only by construction: no adapter has an order method, and none may be added
to this interface.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional


class SourceError(Exception):
    """A provider could not answer. Never carries credentials."""

    def __init__(self, message: str, code: str = "source_error", status: int = 502):
        super().__init__(message)
        self.code = code
        self.status = status

    def as_dict(self) -> Dict[str, Any]:
        return {"code": self.code, "message": str(self)}


class SourceUnavailable(SourceError):
    """The provider is not configured or not permitted on this host."""

    def __init__(self, message: str, code: str = "source_unavailable"):
        super().__init__(message, code=code, status=503)


class DataUnavailable(SourceError):
    """The provider is reachable but has no trustworthy data right now."""

    def __init__(self, message: str, code: str = "data_unavailable"):
        super().__init__(message, code=code, status=424)


@dataclass
class AssetRecord:
    id: Optional[Any]
    symbol: str
    name: str
    market: str
    active: bool
    active_known: bool
    otc: bool = False
    payout: Optional[float] = None
    timeframes: List[int] = field(default_factory=list)
    raw_type: Optional[str] = None

    def key(self) -> str:
        return str(self.id)

    def as_legacy_dict(self) -> Dict[str, Any]:
        """Shape kept from the pre-unification bridge response."""
        data = self.as_dict()
        data["category"] = self.market
        return data

    def as_dict(self) -> Dict[str, Any]:
        return {
            "id": self.id,
            "symbol": self.symbol,
            "name": self.name,
            "market": self.market,
            "active": self.active,
            "active_known": self.active_known,
            "otc": self.otc,
            "payout": self.payout,
            "timeframes": list(self.timeframes),
            "raw_type": self.raw_type,
        }


@dataclass
class Candle:
    time: int  # milliseconds, candle open time
    open: float
    high: float
    low: float
    close: float
    volume: float = 0.0
    timeframe: int = 0

    def as_dict(self) -> Dict[str, Any]:
        return {
            "time": self.time,
            "open": self.open,
            "high": self.high,
            "low": self.low,
            "close": self.close,
            "volume": self.volume,
            "timeframe": self.timeframe,
        }


@dataclass
class QuoteRecord:
    price: float
    time: int  # ms
    timeframe: int
    age_ms: int = 0
    source: str = "candles"

    def as_dict(self) -> Dict[str, Any]:
        return {
            "price": self.price,
            "time": self.time,
            "timeframe": self.timeframe,
            "age_ms": self.age_ms,
            "source": self.source,
        }


class DataSource(ABC):
    """One provider of market data. Read-only by design."""

    name: str = "unnamed"
    title: str = ""
    read_only: bool = True

    @abstractmethod
    def status(self) -> Dict[str, Any]:
        """Connection state of this provider right now."""

    @abstractmethod
    async def assets(self, refresh: bool = False) -> List[AssetRecord]:
        """The provider's own instrument list (never a hard-coded one)."""

    @abstractmethod
    async def timeframes(self, refresh: bool = False) -> List[int]:
        """Periods in seconds the provider can chart."""

    @abstractmethod
    async def candles(self, asset_id: Any, period: int, limit: int = 200) -> List[Candle]:
        """Historical candles, oldest first."""

    @abstractmethod
    async def quote(self, asset_id: Any, period: int = 60) -> QuoteRecord:
        """Latest price, refused when it is stale."""

    def capabilities(self) -> Dict[str, Any]:
        return {
            "name": self.name,
            "title": self.title,
            "read_only": True,
            "assets": True,
            "quote": True,
            "candles": True,
            "live_updates": True,
            "payout": False,
        }
