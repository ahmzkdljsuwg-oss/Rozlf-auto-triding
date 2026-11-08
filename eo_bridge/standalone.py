"""Stdlib-only ExpertOption bridge (read-only).

Same routes and JSON shapes as app.py, but with no FastAPI/uvicorn dependency so
the bridge can run inside the existing Node service on any host that has
python3. The vendored `websockets` package supplies the client transport.

It never sends an order: the vendored client's buy/sell raise.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Dict, List, Optional
from urllib.parse import parse_qs, urlparse

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from eo_bridge.manager import (  # noqa: E402
    SUPPORTED_PERIODS,
    TIMEFRAME_SECONDS,
    BridgeError,
    registry,
)

VERSION = "1.3.0"
BRIDGE_KEY = os.getenv("EO_BRIDGE_API_KEY", "")
ALLOWED_DEMO_ONLY = os.getenv("EO_BRIDGE_DEMO_ONLY", "true").lower() != "false"
TRADING_ENABLED = False
READ_ANY_ACCOUNT = os.getenv("EO_BRIDGE_ALLOW_REAL_READ", "true").lower() != "false"
WATCHDOG_INTERVAL = float(os.getenv("EO_BRIDGE_WATCHDOG_SECONDS", "25"))

logging.basicConfig(
    level=os.getenv("EO_BRIDGE_LOG_LEVEL", "INFO"),
    format="%(asctime)s %(levelname)s %(name)s %(message)s",
)
for noisy in ("ExpertOption", "websockets"):
    logging.getLogger(noisy).setLevel(logging.WARNING)
log = logging.getLogger("rozlf.eo_bridge.standalone")


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str):
        super().__init__(message)
        self.status = status
        self.code = code


def _truthy(value: Any, default: bool = True) -> bool:
    if value is None:
        return default
    if isinstance(value, str):
        return value.strip().lower() not in {"", "0", "false", "no", "off"}
    if isinstance(value, (int, float)):
        return value != 0
    return bool(value)


def classify_asset(asset: dict, symbol: str, name: str) -> str:
    text = f"{symbol} {name}".upper()
    if "SMRTY" in text or "SMARTY" in text:
        return "smarty"
    if re.search(r"CRICKET|FOOTBALL|AI[ _-]?INDEX|LUXURY|INDEX", text):
        return "index"
    if "OTC" in text:
        return "otc"
    if re.search(r"BTC|ETH|LTC|XRP|DOGE|SOL|ADA|BNB|CRYPTO", text):
        return "crypto"
    if re.search(r"OIL|GOLD|SILVER|XAU|XAG|BRENT|WTI|GAS", text):
        return "commodity"
    if re.search(r"^(AAPL|TSLA|AMZN|MSFT|META|NFLX|GOOGL|NVDA)", text):
        return "stock"
    if re.search(r"[A-Z]{3}[_/]?[A-Z]{3}", text):
        return "forex"
    return "other"


def normalize_asset(asset: dict, fallback_timeframes: Optional[List[int]] = None) -> Dict[str, Any]:
    symbol = str(asset.get("symbol") or asset.get("asset") or asset.get("name") or "").strip()
    name = str(asset.get("name") or asset.get("title") or symbol).strip()
    asset_id = asset.get("id", asset.get("asset_id", asset.get("instrument_id")))
    raw_active = asset.get("is_active", asset.get("active", asset.get("enabled")))
    timeframes = asset.get("timeframes")
    if not isinstance(timeframes, list) or not timeframes:
        timeframes = list(fallback_timeframes or [])
    return {
        "id": asset_id,
        "symbol": symbol,
        "name": name,
        "active": _truthy(raw_active),
        "active_known": raw_active is not None,
        "payout": asset.get("profit", asset.get("payout")),
        "otc": "OTC" in f"{symbol} {name}".upper(),
        "category": classify_asset(asset, symbol, name),
        "raw_type": asset.get("type") or asset.get("category"),
        "timeframes": [int(t) for t in timeframes if str(t).isdigit()],
    }


def expiry_seconds(exp_times: List[int]) -> List[int]:
    if len(exp_times) < 2:
        return []
    diffs = sorted({int(b) - int(a) for a, b in zip(exp_times, exp_times[1:]) if b > a})
    return [d for d in diffs if d in {5, 10, 15, 30, 60, 120, 180, 300, 600, 900, 1200, 1800, 3600}]


def asset_expiries(session, asset_id: int) -> List[int]:
    client = session.client
    cache = getattr(client, "candle_cache", {}) if client else {}
    for payload in (cache.get(asset_id) or {}).values():
        found = expiry_seconds(payload.get("expTimes") or [])
        if found:
            return found
    return []


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


class LoopThread:
    """One asyncio loop for the whole process; HTTP threads submit into it."""

    def __init__(self) -> None:
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self._run, name="bridge-loop", daemon=True)

    def _run(self) -> None:
        asyncio.set_event_loop(self.loop)
        self.loop.run_forever()

    def start(self) -> None:
        self.thread.start()
        asyncio.run_coroutine_threadsafe(self._watchdog(), self.loop)

    def call(self, coro, timeout: float = 60.0):
        return asyncio.run_coroutine_threadsafe(coro, self.loop).result(timeout)

    async def _watchdog(self) -> None:
        while True:
            await asyncio.sleep(WATCHDOG_INTERVAL)
            for session in list(registry.sessions.values()):
                try:
                    await session.keepalive()
                except Exception as exc:  # noqa: BLE001 - watchdog must never die
                    log.warning("Watchdog error: %s: %s", type(exc).__name__, str(exc)[:200])


LOOP = LoopThread()


async def guarded(coro):
    try:
        return await coro
    except BridgeError as exc:
        raise ApiError(exc.status, exc.code, str(exc)[:300]) from exc
    except ApiError:
        raise
    except Exception as exc:  # noqa: BLE001 - never leak a token in an error body
        log.warning("Bridge call failed: %s: %s", type(exc).__name__, str(exc)[:200])
        raise ApiError(502, "upstream_error", f"{type(exc).__name__}: {str(exc)[:200]}") from exc


def resolve_session(token: Optional[str], demo_header: Optional[str]):
    if not token:
        raise ApiError(401, "missing_session", "Missing X-EO-Token header")
    demo = (demo_header or "1").strip() not in {"0", "false", "False", "real"}
    if not demo and not READ_ANY_ACCOUNT:
        raise ApiError(
            403,
            "real_read_disabled",
            "Reading a real account is disabled (EO_BRIDGE_ALLOW_REAL_READ=false).",
        )
    if not demo:
        log.info("Reading a real ExpertOption account (read-only, no order can be sent)")
    return registry.get(token.strip(), demo)


def period_of(timeframe: Optional[str]) -> int:
    if not timeframe:
        raise ApiError(422, "bad_timeframe", "timeframe is required")
    key = str(timeframe).strip().upper()
    if key in TIMEFRAME_SECONDS:
        return TIMEFRAME_SECONDS[key]
    if key.isdigit() and int(key) in SUPPORTED_PERIODS:
        return int(key)
    raise ApiError(422, "bad_timeframe", f"Unsupported timeframe: {timeframe}")


def _int(query: Dict[str, List[str]], name: str, default: Optional[int] = None) -> Optional[int]:
    raw = (query.get(name) or [None])[0]
    if raw is None or raw == "":
        return default
    try:
        return int(raw)
    except ValueError:
        raise ApiError(422, "bad_query", f"{name} must be an integer")


class Handler(BaseHTTPRequestHandler):
    server_version = f"ROZLF-EO-Bridge/{VERSION}"
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt: str, *args: Any) -> None:  # noqa: D401 - quieter access log
        log.debug("%s - %s", self.address_string(), fmt % args)

    def _send(self, status: int, payload: Dict[str, Any]) -> None:
        body = json.dumps(payload, default=str).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except BrokenPipeError:
            pass

    def _authorized(self) -> bool:
        if not BRIDGE_KEY:
            raise ApiError(503, "key_missing", "EO_BRIDGE_API_KEY is not configured")
        header = self.headers.get("Authorization") or ""
        if header.strip() != f"Bearer {BRIDGE_KEY}":
            raise ApiError(401, "unauthorized", "Unauthorized")
        return True

    def do_GET(self) -> None:  # noqa: N802 - http.server API
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        try:
            self._send(200, self.route(parsed.path.rstrip("/") or "/", query))
        except ApiError as err:
            self._send(err.status, {"error": {"code": err.code, "message": str(err)}})
        except Exception as exc:  # noqa: BLE001 - keep the service alive
            log.exception("Unhandled bridge error")
            self._send(500, {"error": {"code": "internal", "message": type(exc).__name__}})

    def route(self, path: str, query: Dict[str, List[str]]) -> Dict[str, Any]:
        if path == "/health":
            return {
                "ok": True,
                "service": "rozlf-eo-bridge",
                "version": VERSION,
                "runtime": "stdlib",
                "demo_only": ALLOWED_DEMO_ONLY,
                "trading_enabled": TRADING_ENABLED,
                "read_any_account": READ_ANY_ACCOUNT,
                "key_configured": bool(BRIDGE_KEY),
                "sessions": registry.describe(),
                "time": int(time.time()),
            }
        self._authorized()
        token = self.headers.get("X-EO-Token")
        demo_header = self.headers.get("X-EO-Demo")
        if path == "/session":
            session = resolve_session(token, demo_header)
            account = LOOP.call(guarded(session.account()))
            return {
                "connected": True,
                "verified": True,
                "verified_at": int(time.time()),
                "account": account,
                "status": session.status(),
            }
        if path == "/account":
            session = resolve_session(token, demo_header)
            data = LOOP.call(guarded(session.account()))
            data["updated_at"] = int(time.time())
            return data
        if path == "/instruments":
            session = resolve_session(token, demo_header)
            refresh = (query.get("refresh") or [""])[0].lower() in {"1", "true", "yes"}
            assets = LOOP.call(guarded(session.load_assets(refresh=refresh)), timeout=90)
            timeframes = LOOP.call(guarded(session.load_timeframes()), timeout=60)
            items = []
            for asset in assets:
                if not isinstance(asset, dict):
                    continue
                norm = normalize_asset(asset, fallback_timeframes=timeframes)
                if norm["symbol"] and norm["id"] is not None:
                    items.append(norm)
            return {
                "source": "expertoption-session",
                "count": len(items),
                "active_count": len([a for a in items if a["active"]]),
                "timeframes": timeframes,
                "timeframes_source": session.timeframes_source,
                "instruments": items,
                "updated_at": int(time.time()),
            }
        if path == "/candles":
            instrument_id = _int(query, "instrument_id")
            if instrument_id is None:
                raise ApiError(422, "bad_query", "instrument_id is required")
            timeframe = (query.get("timeframe") or ["M1"])[0]
            limit = max(10, min(_int(query, "limit", 300) or 300, 1000))
            session = resolve_session(token, demo_header)
            period = period_of(timeframe)
            reason = None
            try:
                rows = LOOP.call(guarded(session.candles(instrument_id, period, limit, allow_inactive=True)), timeout=90)
            except ApiError as err:
                if err.code not in {"no_candles", "asset_not_found"}:
                    raise
                reason = err.code
                rows = []
            return {
                "instrument_id": instrument_id,
                "timeframe": timeframe,
                "period_seconds": period,
                "candles": serialize_candles(rows, period),
                "count": len(rows),
                "source": "expertoption-session",
                "reason": reason,
                "updated_at": int(time.time()),
            }
        if path == "/quote":
            instrument_id = _int(query, "instrument_id")
            if instrument_id is None:
                raise ApiError(422, "bad_query", "instrument_id is required")
            timeframe = (query.get("timeframe") or ["M1"])[0]
            stream = (query.get("stream") or ["false"])[0].lower() in {"1", "true", "yes"}
            session = resolve_session(token, demo_header)
            period = period_of(timeframe)
            if stream:
                session.start_stream(instrument_id, period)
            data = LOOP.call(guarded(session.quote(instrument_id, period)), timeout=60)
            return {
                "instrument_id": instrument_id,
                "timeframe": timeframe,
                "period_seconds": period,
                "price": data.price,
                "time": data.time,
                "source": data.source,
                "age_ms": int((time.time() - data.updated_at) * 1000),
            }
        match = re.fullmatch(r"/instrument/(\d+)(/expiries)?", path)
        if match:
            instrument_id = int(match.group(1))
            session = resolve_session(token, demo_header)
            timeframe = (query.get("timeframe") or ["M1"])[0]
            period = period_of(timeframe)
            if match.group(2):
                LOOP.call(guarded(session.candles(instrument_id, period, 60)), timeout=90)
                values = asset_expiries(session, instrument_id)
                return {
                    "instrument_id": instrument_id,
                    "expiries": values,
                    "source": "session-exp-times" if values else "unavailable",
                }
            LOOP.call(guarded(session.load_assets()), timeout=90)
            timeframes = LOOP.call(guarded(session.load_timeframes()), timeout=60)
            raw = session.find_asset(instrument_id)
            asset = normalize_asset(raw, fallback_timeframes=timeframes) if raw else None
            result: Dict[str, Any] = {
                "instrument_id": instrument_id,
                "asset": asset,
                "timeframes": timeframes,
                "expiries": asset_expiries(session, instrument_id),
                "listed": bool(asset),
                "updated_at": int(time.time()),
            }
            probe = (query.get("probe") or ["true"])[0].lower() not in {"0", "false", "no"}
            if probe:
                if period not in timeframes and timeframes:
                    period = timeframes[0]
                try:
                    rows = LOOP.call(
                        guarded(session.candles(instrument_id, period, 60, allow_inactive=True)),
                        timeout=90,
                    )
                    result["probe"] = {
                        "ok": True,
                        "period_seconds": period,
                        "count": len(rows),
                        "last_time": int(float(rows[-1].get("time", 0)) * 1000) if rows else None,
                        "last_close": float(rows[-1].get("close", 0)) if rows else None,
                    }
                except ApiError as err:
                    result["probe"] = {
                        "ok": False,
                        "period_seconds": period,
                        "code": err.code,
                        "message": str(err)[:200],
                    }
            return result
        raise ApiError(404, "not_found", f"No route {path}")


def main() -> None:
    port = int(os.getenv("EO_BRIDGE_PORT", "8011"))
    host = os.getenv("EO_BRIDGE_HOST", "127.0.0.1")
    if not BRIDGE_KEY:
        log.error("EO_BRIDGE_API_KEY is not set: refusing to start without bridge auth")
        sys.exit(2)
    LOOP.start()
    server = ThreadingHTTPServer((host, port), Handler)
    server.daemon_threads = True
    log.info("ROZLF ExpertOption bridge %s listening on %s:%s (demo_only=%s)", VERSION, host, port, ALLOWED_DEMO_ONLY)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
