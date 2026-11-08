"""ExpertOption session manager.

Wraps the vendored ExpertOptionsToolsV2 WebSocket client and exposes only
read-only account and market data. The client's buy/sell methods raise, and
nothing in this module sends an order.

The session token is never logged and never stored on disk: it lives in memory
for the lifetime of the connection, keyed by a hash.
"""
from __future__ import annotations

import asyncio
import hashlib
import logging
import os
import sys
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional

VENDOR_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "vendor")
if VENDOR_DIR not in sys.path:
    sys.path.insert(0, VENDOR_DIR)

from .vendor.ExpertOptionsToolsV2.constants import DEFAULT_SERVER, SERVERS  # noqa: E402
from .vendor.ExpertOptionsToolsV2.expertoption.asyncronous import ExpertOptionAsync  # noqa: E402
from . import handshake  # noqa: E402

log = logging.getLogger("rozlf.eo_bridge")

TIMEFRAME_SECONDS = {
    "S5": 5, "S10": 10, "S15": 15, "S30": 30,
    "M1": 60, "M2": 120, "M3": 180, "M5": 300, "M10": 600,
    "M15": 900, "M30": 1800,
    "H1": 3600, "H4": 14400, "D1": 86400,
}
SUPPORTED_PERIODS = tuple(sorted(set(TIMEFRAME_SECONDS.values())))

CONNECT_RETRIES = int(os.getenv("EO_BRIDGE_CONNECT_RETRIES", "3"))
CONNECT_BACKOFF = float(os.getenv("EO_BRIDGE_CONNECT_BACKOFF", "1.0"))
QUOTE_MAX_AGE_SECONDS = float(os.getenv("EO_BRIDGE_QUOTE_MAX_AGE_SECONDS", "20"))
CANDLE_TIMEOUT = float(os.getenv("EO_BRIDGE_CANDLE_TIMEOUT", "20"))
# Initial ExpertOption WebSocket setup fetches profile and assets; allow a slower first handshake.
CONNECT_TIMEOUT = float(os.getenv("EO_BRIDGE_CONNECT_TIMEOUT", "40"))
MAX_SESSIONS = int(os.getenv("EO_BRIDGE_MAX_SESSIONS", "4"))
SERVER_REGION = os.getenv("EO_BRIDGE_REGION", "EUROPE").upper()
# Chart timeframes ExpertOption publishes. Used when the session does not answer
# getCandlesTimeframes, so the backend never asks for a timeframe it cannot get.
DEFAULT_TIMEFRAMES = [5, 60, 300, 900, 1800, 3600, 14400, 86400]


class BridgeError(Exception):
    def __init__(self, message: str, code: str = "bridge_error", status: int = 502):
        super().__init__(message)
        self.code = code
        self.status = status


def session_key(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()[:24]


def base_url() -> str:
    return SERVERS.get(SERVER_REGION) or DEFAULT_SERVER


def _truthy(value: Any) -> bool:
    if isinstance(value, str):
        return value.strip().lower() not in {"", "0", "false", "no", "off"}
    return bool(value)


@dataclass
class Quote:
    price: float
    time: int
    timeframe: int
    updated_at: float
    source: str


@dataclass
class Session:
    token: str
    demo: bool
    client: Optional[ExpertOptionAsync] = None
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)
    quotes: Dict[str, Quote] = field(default_factory=dict)
    subscription_tasks: Dict[str, asyncio.Task] = field(default_factory=dict)
    assets: List[dict] = field(default_factory=list)
    assets_at: float = 0.0
    timeframes: List[int] = field(default_factory=list)
    timeframes_at: float = 0.0
    timeframes_source: str = "unknown"
    profile: Dict[str, Any] = field(default_factory=dict)
    connected_at: Optional[float] = None
    last_ok_at: Optional[float] = None
    last_error: Optional[str] = None
    reconnects: int = 0
    endpoint_region: Optional[str] = None
    handshake_probes: List[Dict[str, Any]] = field(default_factory=list)

    @property
    def key(self) -> str:
        return session_key(self.token)

    async def _resolve_endpoints(self) -> List[str]:
        """Probe regional endpoints and return them best-first.

        A handshake timeout usually means this host cannot reach that regional
        host (geo block, filtered network) — more waiting does not fix it, moving
        to a reachable region does.
        """
        order = handshake.candidate_regions()
        cached = handshake.cached_region()
        if cached:
            self.endpoint_region = cached
            return [handshake.url_for(cached)] + [handshake.url_for(r) for r in order if r != cached]
        probes = await handshake.diagnose(order)
        self.handshake_probes = probes
        healthy = [p for p in probes if p.get("ok")]
        if not healthy:
            summary = "; ".join(
                f"{p['region']}: {p.get('error_kind') or 'failed'}" for p in probes
            )[:400]
            self.last_error = f"handshake_unreachable: {summary}"
            log.warning("No ExpertOption endpoint answered a handshake: %s", summary)
            raise BridgeError(
                "No ExpertOption WebSocket endpoint completed a handshake from this host "
                f"({summary})",
                code="handshake_unreachable",
                status=503,
            )
        healthy.sort(key=lambda p: p.get("handshake_ms") or 1e9)
        chosen = str(healthy[0]["region"])
        handshake.cache_region(chosen, probes)
        self.endpoint_region = chosen
        log.info(
            "ExpertOption endpoint %s handshake ok in %sms",
            chosen, healthy[0].get("handshake_ms"),
        )
        rest = [name for name in order if name != chosen]
        return [handshake.url_for(chosen)] + [handshake.url_for(name) for name in rest]

    async def ensure_client(self) -> ExpertOptionAsync:
        if self.client and self.client.client.connected:
            return self.client
        if self.client:
            try:
                await self.client.disconnect()
            except Exception:  # pragma: no cover - best effort cleanup
                pass
            self.client = None
            self.quotes.clear()
            self.reconnects += 1
        try:
            urls = await self._resolve_endpoints()
        except BridgeError:
            raise
        last: Optional[Exception] = None
        for attempt in range(CONNECT_RETRIES):
            for url in urls:
                try:
                    client = ExpertOptionAsync(self.token, demo=self.demo, url=url)
                    await asyncio.wait_for(client.connect(), timeout=CONNECT_TIMEOUT)
                    self.client = client
                    self.endpoint_region = handshake.region_for_url(url) or self.endpoint_region
                    self.quotes.clear()
                    self.connected_at = time.time()
                    self.last_ok_at = time.time()
                    self.last_error = None
                    if attempt or self.reconnects:
                        log.info("ExpertOption session reconnected (attempt %s)", attempt + 1)
                    return client
                except ValueError as exc:
                    # The server answered: this token is not accepted. Retrying
                    # cannot help, so report it precisely instead of hanging.
                    message = str(exc)[:200]
                    self.last_error = f"session_invalid: {message}"
                    log.warning("ExpertOption rejected the session token: %s", message)
                    raise BridgeError(
                        f"ExpertOption rejected the session token ({message})",
                        code="session_invalid",
                        status=401,
                    ) from exc
                except asyncio.TimeoutError as exc:
                    self.last_error = "connect_timeout"
                    log.warning("ExpertOption connect timed out after %ss on %s", CONNECT_TIMEOUT, url)
                    handshake.clear_cache()
                    urls = await self._resolve_endpoints()
                    last = exc
                except Exception as exc:  # noqa: BLE001 - surfaced to the caller
                    last = exc
                    self.reconnects += 1
                    self.last_error = f"{type(exc).__name__}: {exc}"[:300]
                    log.warning("ExpertOption connect attempt %s failed on %s: %s", attempt + 1, url, self.last_error)
            await asyncio.sleep(CONNECT_BACKOFF * (2 ** attempt))
        if self.last_error == "connect_timeout":
            raise BridgeError(
                "ExpertOption did not answer before the connection timeout",
                code="connect_timeout",
                status=504,
            )
        raise BridgeError(
            f"Could not connect to ExpertOption: {self.last_error or last}",
            code="connect_failed",
            status=502,
        )

    async def call_connected(self, fn):
        """Run fn(client) with one transparent reconnect on a dropped socket."""
        client = await self.ensure_client()
        try:
            result = await fn(client)
            self.last_ok_at = time.time()
            return result
        except BridgeError:
            raise
        except Exception as exc:  # noqa: BLE001
            self.last_error = f"{type(exc).__name__}: {exc}"[:300]
            log.warning("ExpertOption call failed, reconnecting: %s", self.last_error)
            try:
                await client.disconnect()
            except Exception:  # pragma: no cover
                pass
            self.client = None
            client = await self.ensure_client()
            result = await fn(client)
            self.last_ok_at = time.time()
            return result

    async def load_profile(self) -> Dict[str, Any]:
        profile = await self.call_connected(lambda c: c.fetch_profile())
        self.profile = profile or {}
        return self.profile

    async def load_assets(self, refresh: bool = False) -> List[dict]:
        if self.assets and not refresh and time.time() - self.assets_at < 60:
            return self.assets
        assets = await self.call_connected(lambda c: c.fetch_assets())
        # The platform has returned both a list and an id-keyed mapping over
        # time; accept either so no asset silently disappears.
        if isinstance(assets, dict):
            assets = list(assets.values())
        self.assets = [a for a in (assets or []) if isinstance(a, dict)]
        self.assets_at = time.time()
        return self.assets

    def find_asset(self, asset_id: Any) -> Optional[dict]:
        target = str(asset_id)
        for asset in self.assets:
            if str(asset.get("id")) == target:
                return asset
        return None

    async def load_timeframes(self, refresh: bool = False) -> List[int]:
        if self.timeframes and not refresh and time.time() - self.timeframes_at < 600:
            return self.timeframes
        try:
            values = await self.call_connected(lambda c: c.fetch_timeframes())
        except BridgeError:
            values = []
        cleaned = sorted({
            int(v) for v in (values or [])
            if str(v).strip().isdigit() and int(v) in SUPPORTED_PERIODS
        })
        if cleaned:
            self.timeframes_source = "session"
        else:
            cleaned = list(DEFAULT_TIMEFRAMES)
            self.timeframes_source = "default"
        self.timeframes = cleaned
        self.timeframes_at = time.time()
        return self.timeframes

    async def candles(
        self, asset_id: int, period: int, limit: int, allow_inactive: bool = True
    ) -> List[dict]:
        await self.load_assets()
        asset = self.find_asset(asset_id)
        if asset is None:
            raise BridgeError(
                f"Asset {asset_id} is not in this account's asset list",
                code="asset_not_found",
                status=409,
            )
        if not _truthy(asset.get("is_active")) and not allow_inactive:
            raise BridgeError(
                f"Asset {asset_id} is not active on this account",
                code="asset_inactive",
                status=409,
            )
        supported = await self.load_timeframes()
        if period not in supported:
            raise BridgeError(
                f"{period}s is not a candle timeframe of this session",
                code="timeframe_unsupported",
                status=422,
            )
        cache = (getattr(self.client, "candle_cache", None) or {}).get(int(asset_id), {}) or {}
        cached_count = len((cache.get(period) or {}).get("candles", []))
        need = max(10, int(limit or 300))
        duration = max(period * (need + 20), 1800)
        count_request = 1 if cached_count >= need else 2
        async with self.lock:
            async def _read(client):
                kwargs = {"duration": duration, "count_request": count_request, "as_dataframe": False}
                try:
                    return await client.get_candles(
                        int(asset_id), int(period), 0, allow_inactive=True, **kwargs
                    )
                except TypeError:
                    # Older vendored clients do not take allow_inactive.
                    return await client.get_candles(int(asset_id), int(period), 0, **kwargs)

            try:
                rows = await asyncio.wait_for(
                    self.call_connected(_read),
                    timeout=CANDLE_TIMEOUT,
                )
            except asyncio.TimeoutError:
                raise BridgeError("Candle request timed out", code="candle_timeout", status=504)
            except ValueError as exc:
                raise BridgeError(str(exc)[:200], code="candle_rejected", status=409)
        rows = list(rows or [])
        rows.sort(key=lambda r: float(r.get("time", 0)))
        if limit and len(rows) > limit:
            rows = rows[-limit:]
        if not rows:
            raise BridgeError("No candles returned for this asset", code="no_candles", status=424)
        return rows

    async def account(self) -> Dict[str, Any]:
        profile = await self.load_profile()
        demo = self.demo
        balance = profile.get("demo_balance" if demo else "real_balance")

        def pick(*names):
            for name in names:
                value = profile.get(name)
                if value is not None:
                    return value
            return None

        return {
            "login": profile.get("id") or profile.get("uid") or profile.get("login"),
            "email": profile.get("email"),
            "type": "demo" if demo else "real",
            "currency": profile.get("currency") or profile.get("currency_sign") or "USD",
            "balance": balance,
            "equity": pick("demo_equity", "equity", "balance"),
            "free_margin": pick("demo_free_margin", "free_margin"),
            "used_margin": pick("demo_used_margin", "used_margin"),
            "context": profile.get("context"),
        }

    async def quote(self, asset_id: int, period: int) -> Quote:
        key = f"{asset_id}:{period}"
        cached = self.quotes.get(key)
        if cached and time.time() - cached.updated_at < 3:
            return cached
        try:
            rows = await self.candles(asset_id, period, 2)
        except BridgeError as exc:
            if exc.code != "no_candles":
                raise
            rows = []
        if not rows:
            if cached and time.time() - cached.updated_at <= QUOTE_MAX_AGE_SECONDS:
                return cached
            raise BridgeError("No candles returned for this asset", code="no_candles", status=424)
        last = rows[-1]
        max_age = period * 2 + QUOTE_MAX_AGE_SECONDS
        if time.time() - float(last["time"]) > max_age:
            raise BridgeError(
                f"Last candle is {int(time.time() - float(last['time']))}s old (limit {int(max_age)}s)",
                code="stale_data",
                status=409,
            )
        quote = Quote(
            price=float(last["close"]),
            time=int(float(last["time"]) * 1000),
            timeframe=period,
            updated_at=time.time(),
            source="candles",
        )
        self.quotes[key] = quote
        return quote

    def start_stream(self, asset_id: int, period: int) -> None:
        key = f"{asset_id}:{period}"
        existing = self.subscription_tasks.get(key)
        if existing and not existing.done():
            return
        self.subscription_tasks[key] = asyncio.create_task(self._stream(asset_id, period, key))

    async def _stream(self, asset_id: int, period: int, key: str) -> None:
        while True:
            try:
                client = await self.ensure_client()
                subscription = await client.subscribe_symbol(asset_id, [period])
                async for candle in subscription:
                    self.quotes[key] = Quote(
                        price=float(candle["close"]),
                        time=int(float(candle["time"]) * 1000),
                        timeframe=period,
                        updated_at=time.time(),
                        source="stream",
                    )
            except asyncio.CancelledError:  # pragma: no cover
                raise
            except Exception as exc:  # noqa: BLE001 - reconnect loop
                self.last_error = f"{type(exc).__name__}: {exc}"[:300]
                log.warning("Market stream for %s dropped: %s", key, self.last_error)
                self.client = None
                await asyncio.sleep(2)

    async def keepalive(self) -> None:
        try:
            client = await self.ensure_client()
            await client.send_ping()
        except Exception as exc:  # noqa: BLE001 - watchdog
            self.last_error = f"{type(exc).__name__}: {exc}"[:300]
            log.warning("Keepalive failed: %s", self.last_error)
            self.client = None

    async def close(self) -> None:
        for task in self.subscription_tasks.values():
            task.cancel()
        self.subscription_tasks.clear()
        if self.client:
            try:
                await self.client.disconnect()
            except Exception:  # pragma: no cover
                pass
        self.client = None
        self.quotes.clear()

    def status(self) -> Dict[str, Any]:
        return {
            "session": self.key,
            "demo": self.demo,
            "connected": bool(self.client and self.client.client.connected),
            "connected_at": self.connected_at,
            "last_ok_at": self.last_ok_at,
            "last_error": self.last_error,
            "reconnects": self.reconnects,
            "assets_cached": len(self.assets),
            "timeframes": self.timeframes,
            "timeframes_source": self.timeframes_source,
            "endpoint_region": self.endpoint_region,
            "handshake": self.handshake_probes,
            "streams": [k for k, t in self.subscription_tasks.items() if not t.done()],
        }


class SessionRegistry:
    def __init__(self) -> None:
        self.sessions: Dict[str, Session] = {}

    def get(self, token: str, demo: bool) -> Session:
        if not token:
            raise BridgeError("Missing ExpertOption session token", code="no_token", status=401)
        key = session_key(token)
        session = self.sessions.get(key)
        if session is None:
            if len(self.sessions) >= MAX_SESSIONS:
                oldest = min(self.sessions.values(), key=lambda s: s.connected_at or 0)
                self.sessions.pop(oldest.key, None)
                asyncio.create_task(oldest.close())
            session = Session(token=token, demo=demo)
            self.sessions[key] = session
        elif session.demo != demo:
            session.demo = demo
        return session

    async def close_all(self) -> None:
        for session in list(self.sessions.values()):
            await session.close()
        self.sessions.clear()

    def describe(self) -> List[Dict[str, Any]]:
        return [s.status() for s in self.sessions.values()]


registry = SessionRegistry()
