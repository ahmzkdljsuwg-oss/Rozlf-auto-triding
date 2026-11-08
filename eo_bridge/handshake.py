"""ExpertOption WebSocket endpoint selection and handshake diagnostics.

A "WebSocket opening handshake timeout" is only a symptom. The cause is one of:
the regional host is unreachable from the host running the bridge (geo/network
block), TLS fails, the upgrade is refused, or an outbound proxy swallows the
CONNECT. This module finds out which one it is before the trading client is
built, so the bridge can fail over to a reachable regional endpoint instead of
just waiting longer.

No secret is ever placed in a probe: the handshake sent here is an unauthenticated
protocol upgrade, exactly what any browser sends before joining.
"""
from __future__ import annotations

import asyncio
import base64
import os
import ssl
import time
from typing import Any, Dict, List, Optional
from urllib.parse import urlparse

from .vendor.ExpertOptionsToolsV2.constants import DEFAULT_SERVER, SERVERS

DEFAULT_ORDER = ["EUROPE", "INDIA", "SINGAPORE", "HONG_KONG", "UNITED_STATES"]
PROBE_TIMEOUT = float(os.getenv("EO_BRIDGE_PROBE_TIMEOUT", "8"))
ENDPOINT_TTL = float(os.getenv("EO_BRIDGE_ENDPOINT_TTL", "300"))


def region_order() -> List[str]:
    """Regions to try, in order. A stale single-region pin would hide failover."""
    raw = os.getenv("EO_BRIDGE_REGION_ORDER", "").strip()
    if raw and raw.lower() != "auto":
        candidates = [part.strip().upper() for part in raw.split(",")]
        candidates = [name for name in candidates if name in SERVERS]
    else:
        pinned = os.getenv("EO_BRIDGE_REGION", "").strip().upper()
        candidates = ([pinned] if pinned in SERVERS else []) + DEFAULT_ORDER
    ordered: List[str] = []
    for name in candidates:
        if name not in ordered:
            ordered.append(name)
    return ordered or ["EUROPE"]


def url_for(region: str) -> str:
    return SERVERS.get(region) or DEFAULT_SERVER


def probe_key() -> str:
    """A valid Sec-WebSocket-Key: 16 random bytes, base64 (RFC 6455 §4.1)."""
    return base64.b64encode(os.urandom(16)).decode("ascii")


def region_for_url(url: str) -> Optional[str]:
    for name, target in SERVERS.items():
        if target == url:
            return name
    return None


def origin_header() -> str:
    return os.getenv("EO_BRIDGE_WS_ORIGIN", "https://app.expertoption.com")


def _proxy() -> Optional[str]:
    raw = os.getenv("EO_BRIDGE_WS_PROXY", "none").strip()
    if raw.lower() in {"", "none", "off", "false", "direct"}:
        return None
    return raw


def _classify(exc: BaseException) -> str:
    text = f"{type(exc).__name__}: {exc}".lower()
    if isinstance(exc, asyncio.TimeoutError) or "timeout" in text:
        return "timeout"
    if "name or service not known" in text or "nodename" in text or "getaddrinfo" in text:
        return "dns_error"
    if "certificate" in text or "ssl" in text or "tls" in text:
        return "tls_error"
    if "refused" in text:
        return "connection_refused"
    if "network is unreachable" in text or "no route" in text:
        return "network_unreachable"
    return "connect_error"


async def probe(region: str, url: Optional[str] = None, timeout: Optional[float] = None) -> Dict[str, Any]:
    """Open TCP+TLS and read the real upgrade response status for one region."""
    target = url or url_for(region)
    parsed = urlparse(target)
    host = parsed.hostname or ""
    port = parsed.port or (443 if parsed.scheme == "wss" else 80)
    path = parsed.path or "/"
    limit = float(timeout or PROBE_TIMEOUT)
    result: Dict[str, Any] = {
        "region": region,
        "url": target,
        "host": host,
        "port": port,
        "ok": False,
        "status": None,
        "tcp_ms": None,
        "handshake_ms": None,
        "error": None,
        "error_kind": None,
    }
    started = time.monotonic()
    writer = None
    try:
        context = ssl.create_default_context()
        reader, writer = await asyncio.wait_for(
            asyncio.open_connection(host, port, ssl=context, server_hostname=host),
            timeout=limit,
        )
        result["tcp_ms"] = round((time.monotonic() - started) * 1000, 1)
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {probe_key()}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            f"Origin: {origin_header()}\r\n"
            "User-Agent: ROZLF-bridge-handshake-probe\r\n\r\n"
        )
        writer.write(request.encode("ascii"))
        await asyncio.wait_for(writer.drain(), timeout=limit)
        head = await asyncio.wait_for(reader.readuntil(b"\r\n\r\n"), timeout=limit)
        result["handshake_ms"] = round((time.monotonic() - started) * 1000, 1)
        first = head.split(b"\r\n", 1)[0].decode("latin-1", "replace").strip()
        parts = first.split()
        status = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else None
        result["status"] = status
        result["ok"] = status == 101
        if status != 101:
            result["error"] = f"upgrade refused with HTTP {status}"
            result["error_kind"] = "upgrade_refused"
    except Exception as exc:  # noqa: BLE001 - diagnostics are the product here
        result["error_kind"] = _classify(exc)
        result["error"] = f"{type(exc).__name__}: {exc}"[:300]
        if result["tcp_ms"] is None:
            result["tcp_ms"] = round((time.monotonic() - started) * 1000, 1)
    finally:
        if writer is not None:
            try:
                writer.close()
                await asyncio.wait_for(writer.wait_closed(), timeout=3)
            except Exception:  # pragma: no cover - best effort
                pass
    return result


async def diagnose(regions: Optional[List[str]] = None, timeout: Optional[float] = None) -> List[Dict[str, Any]]:
    names = regions or region_order()
    return list(await asyncio.gather(*(probe(name, timeout=timeout) for name in names)))


_select_cache: Dict[str, Any] = {"at": 0.0, "region": None, "probes": []}


def cached_region() -> Optional[str]:
    if _select_cache["region"] and time.time() - _select_cache["at"] < ENDPOINT_TTL:
        return _select_cache["region"]
    return None


def cache_region(region: str, probes: Optional[List[Dict[str, Any]]] = None) -> None:
    _select_cache["region"] = region
    _select_cache["at"] = time.time()
    _select_cache["probes"] = probes or []


def clear_cache() -> None:
    _select_cache.update({"at": 0.0, "region": None, "probes": []})


def candidate_regions() -> List[str]:
    """Cached working region first, then the rest — used for failover on drops."""
    order = region_order()
    cached = cached_region()
    if cached and cached in order:
        order = [cached] + [name for name in order if name != cached]
    return order


def select_region_sync_result(probes: List[Dict[str, Any]]) -> Optional[str]:
    for item in probes:
        if item.get("ok"):
            return str(item["region"])
    return None
