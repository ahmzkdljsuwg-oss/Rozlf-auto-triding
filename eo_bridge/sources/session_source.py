"""Adapter: the connected ExpertOption account's own session, read-only."""
from __future__ import annotations

import time
from typing import Any, Dict, List

from ..manager import BridgeError, Session
from .base import AssetRecord, Candle, DataSource, QuoteRecord, SourceError
from .model import normalize_assets


def _wrap(exc: Exception) -> SourceError:
    if isinstance(exc, BridgeError):
        return SourceError(str(exc), code=exc.code, status=exc.status)
    return SourceError(f"{type(exc).__name__}: {str(exc)[:200]}")


class ExpertOptionSessionSource(DataSource):
    """The account's own ExpertOption session, exposed through the unified API.

    The session already refuses orders (the vendored client raises
    TradingDisabledError), so this adapter cannot trade either.
    """

    name = "expertoption-session"
    title = "ExpertOption (connected account session)"
    read_only = True

    def __init__(self, session: Session):
        self.session = session

    def status(self) -> Dict[str, Any]:
        base = dict(self.session.status())
        base.update({
            "source": self.name,
            "read_only": True,
            "execution": "disabled",
            "ready": bool(base.get("connected")),
        })
        return base

    async def assets(self, refresh: bool = False) -> List[AssetRecord]:
        try:
            raw = await self.session.load_assets(refresh=refresh)
            timeframes = await self.session.load_timeframes()
        except Exception as exc:  # noqa: BLE001
            raise _wrap(exc) from exc
        return normalize_assets(raw, fallback_timeframes=timeframes)

    async def timeframes(self, refresh: bool = False) -> List[int]:
        try:
            return list(await self.session.load_timeframes(refresh=refresh))
        except Exception as exc:  # noqa: BLE001
            raise _wrap(exc) from exc

    async def candles(self, asset_id: Any, period: int, limit: int = 200) -> List[Candle]:
        try:
            rows = await self.session.candles(int(asset_id), int(period), int(limit))
        except Exception as exc:  # noqa: BLE001
            raise _wrap(exc) from exc
        out: List[Candle] = []
        for row in rows:
            out.append(Candle(
                time=int(float(row.get("time", 0)) * 1000),
                open=float(row.get("open", 0)),
                high=float(row.get("high", 0)),
                low=float(row.get("low", 0)),
                close=float(row.get("close", 0)),
                volume=float(row.get("volume") or 0),
                timeframe=int(row.get("timeframe") or period),
            ))
        return out

    async def quote(self, asset_id: Any, period: int = 60) -> QuoteRecord:
        try:
            data = await self.session.quote(int(asset_id), int(period))
        except Exception as exc:  # noqa: BLE001
            raise _wrap(exc) from exc
        return QuoteRecord(
            price=float(data.price),
            time=int(data.time),
            timeframe=int(period),
            age_ms=int(max(0.0, time.time() - float(data.updated_at)) * 1000),
            source=data.source,
        )

    def capabilities(self) -> Dict[str, Any]:
        caps = super().capabilities()
        caps.update({
            "payout": True,
            "live_updates": True,
            "historical": True,
            "auth": "session-token (X-EO-Token, never logged)",
        })
        return caps
