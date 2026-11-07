"""ROZLF ExpertOption bridge service (read-only).

Runs the vendored ExpertOptionsToolsV2 client so the Node backend can read the
connected ExpertOption account's own assets, quotes and candles. It never sends
an order: the vendored client's buy/sell methods raise TradingDisabledError.

Auth: every request must carry `Authorization: Bearer $EO_BRIDGE_API_KEY`
(the same value the Node backend sends). The ExpertOption session token travels
only in the `X-EO-Token` header and is never logged.
"""
from __future__ import annotations

import asyncio
import logging
import os
import time
from typing import Any, Dict, List, Optional

from fastapi import Depends, FastAPI, Header, HTTPException, Query
from fastapi.responses import JSONResponse

from .manager import (
    SUPPORTED_PERIODS,
    TIMEFRAME_SECONDS,
    BridgeError,
    Quote,
    registry,
)

VERSION = "1.1.0"
BRIDGE_KEY = os.getenv("EO_BRIDGE_API_KEY", "")
# Order submission is not implemented at all: the vendored client's buy/sell
# raise TradingDisabledError. EO_BRIDGE_DEMO_ONLY therefore only describes the
# execution policy; it never gates reading data from a real account.
ALLOWED_DEMO_ONLY = os.getenv("EO_BRIDGE_DEMO_ONLY", "true").lower() != "false"
TRADING_ENABLED = False
READ_ANY_ACCOUNT = os.getenv("EO_BRIDGE_ALLOW_REAL_READ", "true").lower() != "false"

logging.basicConfig(
    level=os.getenv("EO_BRIDGE_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
for noisy in ("ExpertOption", "websockets"):
    logging.getLogger(noisy).setLevel(logging.WARNING)

log = logging.getLogger("rozlf.eo_bridge.api")

app = FastAPI(title="ROZLF ExpertOption Bridge", version=VERSION, docs_url=None, redoc_url=None)


def require_key(authorization: Optional[str] = Header(default=None)) -> None:
    if not BRIDGE_KEY:
        raise HTTPException(status_code=503, detail="EO_BRIDGE_API_KEY is not configured")
    expected = f"Bearer {BRIDGE_KEY}"
    if not authorization or authorization.strip() != expected:
        raise HTTPException(status_code=401, detail="Unauthorized")


def resolve_session(x_eo_token: Optional[str], x_eo_demo: Optional[str]):
    if not x_eo_token:
        raise HTTPException(status_code=401, detail="Missing X-EO-Token header")
    demo = (x_eo_demo or "1").strip() not in {"0", "false", "False", "real"}
    if not demo and not READ_ANY_ACCOUNT:
        raise HTTPException(
            status_code=403,
            detail={
                "code": "real_read_disabled",
                "message": "Reading a real account is disabled (EO_BRIDGE_ALLOW_REAL_READ=false). "
                           "This is a read-only restriction, not a trading one.",
            },
        )
    if not demo:
        log.info("Reading a real ExpertOption account (read-only, no order can be sent)")
    return registry.get(x_eo_token.strip(), demo)


def period_of(timeframe: str) -> int:
    if timeframe is None:
        raise HTTPException(status_code=422, detail="timeframe is required")
    key = str(timeframe).strip().upper()
    if key in TIMEFRAME_SECONDS:
        return TIMEFRAME_SECONDS[key]
    if key.isdigit() and int(key) in SUPPORTED_PERIODS:
        return int(key)
    raise HTTPException(status_code=422, detail=f"Unsupported timeframe: {timeframe}")


def normalize_asset(asset: dict) -> Dict[str, Any]:
    symbol = str(asset.get("symbol") or asset.get("name") or "").strip()
    return {
        "id": asset.get("id"),
        "symbol": symbol,
        "name": asset.get("name") or symbol,
        "active": bool(asset.get("is_active")),
        "payout": asset.get("profit"),
        "otc": symbol.upper().endswith("_OTC") or "OTC" in symbol.upper(),
        "category": asset.get("type") or asset.get("category"),
        "timeframes": asset.get("timeframes") or [],
    }


def expiry_seconds(exp_times: List[int]) -> List[int]:
    """Derive supported durations from the session's own expiry timestamps."""
    if len(exp_times) < 2:
        return []
    diffs = sorted({int(b) - int(a) for a, b in zip(exp_times, exp_times[1:]) if b > a})
    return [d for d in diffs if d in {5, 10, 15, 30, 60, 120, 180, 300, 600, 900, 1200, 1800, 3600}]


def asset_expiries(session, asset_id: int) -> List[int]:
    client = session.client
    cache = getattr(client, "candle_cache", {}) if client else {}
    found: List[int] = []
    for payload in (cache.get(asset_id) or {}).values():
        found = expiry_seconds(payload.get("expTimes") or [])
        if found:
            return found
    return found


def serialize_candles(rows: List[dict], period: int) -> List[dict]:
    out = []
    for row in rows:
        out.append({
            "time": int(float(row.get("time", 0)) * 1000),
            "open": float(row.get("open", 0)),
            "high": float(row.get("high", 0)),
            "low": float(row.get("low", 0)),
            "close": float(row.get("close", 0)),
            "volume": float(row.get("volume") or 0),
            "timeframe": int(row.get("timeframe") or period),
        })
    return out


async def guarded(coro):
    try:
        return await coro
    except BridgeError as exc:
        raise HTTPException(status_code=exc.status, detail={"code": exc.code, "message": str(exc)})
    except HTTPException:
        raise
    except Exception as exc:  # noqa: BLE001 - never leak a token in an error body
        log.warning("Bridge call failed: %s: %s", type(exc).__name__, str(exc)[:200])
        raise HTTPException(
            status_code=502,
            detail={"code": "upstream_error", "message": f"{type(exc).__name__}: {str(exc)[:200]}"},
        )


@app.get("/health")
async def health() -> Dict[str, Any]:
    return {
        "ok": True,
        "service": "rozlf-eo-bridge",
        "version": VERSION,
        "demo_only": ALLOWED_DEMO_ONLY,
        "trading_enabled": TRADING_ENABLED,
        "read_any_account": READ_ANY_ACCOUNT,
        "key_configured": bool(BRIDGE_KEY),
        "sessions": registry.describe(),
        "time": int(time.time()),
    }


@app.get("/session", dependencies=[Depends(require_key)])
async def session_info(
    x_eo_token: Optional[str] = Header(default=None),
    x_eo_demo: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    session = resolve_session(x_eo_token, x_eo_demo)
    account = await guarded(session.account())
    return {
        "connected": True,
        "verified": True,
        "verified_at": int(time.time()),
        "account": account,
        "status": session.status(),
    }


@app.get("/account", dependencies=[Depends(require_key)])
async def account(
    x_eo_token: Optional[str] = Header(default=None),
    x_eo_demo: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    session = resolve_session(x_eo_token, x_eo_demo)
    data = await guarded(session.account())
    data["updated_at"] = int(time.time())
    return data


@app.get("/instruments", dependencies=[Depends(require_key)])
async def instruments(
    refresh: bool = Query(default=False),
    x_eo_token: Optional[str] = Header(default=None),
    x_eo_demo: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    session = resolve_session(x_eo_token, x_eo_demo)
    assets = await guarded(session.load_assets(refresh=refresh))
    items = [normalize_asset(a) for a in assets if normalize_asset(a)["symbol"]]
    return {
        "source": "expertoption-session",
        "count": len(items),
        "instruments": items,
        "updated_at": int(time.time()),
    }


@app.get("/candles", dependencies=[Depends(require_key)])
async def candles(
    instrument_id: int = Query(...),
    timeframe: str = Query(...),
    limit: int = Query(default=300, ge=10, le=1000),
    x_eo_token: Optional[str] = Header(default=None),
    x_eo_demo: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    session = resolve_session(x_eo_token, x_eo_demo)
    period = period_of(timeframe)
    supported = await guarded(session.load_timeframes())
    if supported and period not in supported:
        raise HTTPException(
            status_code=422,
            detail={"code": "timeframe_unsupported", "message": f"{timeframe} is not offered by this session",
                    "timeframes": supported},
        )
    rows = await guarded(session.candles(instrument_id, period, limit))
    return {
        "instrument_id": instrument_id,
        "timeframe": timeframe,
        "period_seconds": period,
        "candles": serialize_candles(rows, period),
        "count": len(rows),
        "source": "expertoption-session",
        "updated_at": int(time.time()),
    }


@app.get("/quote", dependencies=[Depends(require_key)])
async def quote(
    instrument_id: int = Query(...),
    timeframe: str = Query(default="M1"),
    stream: bool = Query(default=False),
    x_eo_token: Optional[str] = Header(default=None),
    x_eo_demo: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    session = resolve_session(x_eo_token, x_eo_demo)
    period = period_of(timeframe)
    if stream:
        session.start_stream(instrument_id, period)
    data: Quote = await guarded(session.quote(instrument_id, period))
    return {
        "instrument_id": instrument_id,
        "timeframe": timeframe,
        "period_seconds": period,
        "price": data.price,
        "time": data.time,
        "source": data.source,
        "age_ms": int((time.time() - data.updated_at) * 1000),
    }


@app.get("/instrument/{instrument_id}/expiries", dependencies=[Depends(require_key)])
async def expiries(
    instrument_id: int,
    timeframe: str = Query(default="M1"),
    x_eo_token: Optional[str] = Header(default=None),
    x_eo_demo: Optional[str] = Header(default=None),
) -> Dict[str, Any]:
    session = resolve_session(x_eo_token, x_eo_demo)
    period = period_of(timeframe)
    await guarded(session.candles(instrument_id, period, 60))
    values = asset_expiries(session, instrument_id)
    return {
        "instrument_id": instrument_id,
        "expiries": values,
        "source": "session-exp-times" if values else "unavailable",
    }


@app.exception_handler(HTTPException)
async def http_error(_request, exc: HTTPException) -> JSONResponse:
    detail = exc.detail
    body = detail if isinstance(detail, dict) else {"message": str(detail)}
    return JSONResponse(status_code=exc.status_code, content={"error": body})


WATCHDOG_INTERVAL = float(os.getenv("EO_BRIDGE_WATCHDOG_SECONDS", "25"))


async def _watchdog() -> None:
    while True:
        await asyncio.sleep(WATCHDOG_INTERVAL)
        for session in list(registry.sessions.values()):
            try:
                await session.keepalive()
            except Exception as exc:  # noqa: BLE001 - watchdog must never die
                log.warning("Watchdog error: %s", type(exc).__name__)


@app.on_event("startup")
async def _startup() -> None:
    log.info("ROZLF ExpertOption bridge %s started (demo_only=%s)", VERSION, ALLOWED_DEMO_ONLY)
    asyncio.create_task(_watchdog())


@app.on_event("shutdown")
async def _shutdown() -> None:
    await registry.close_all()
