import asyncio
import os

import pytest

from eo_bridge import handshake
from eo_bridge import manager


class FakeWriter:
    def __init__(self):
        self.payload = b""

    def write(self, data):
        self.payload += data

    async def drain(self):
        return None

    def close(self):
        return None

    async def wait_closed(self):
        return None


class FakeReader:
    def __init__(self, head):
        self.head = head

    async def readuntil(self, sep):
        return self.head


def test_region_order_prefers_explicit_list(monkeypatch):
    monkeypatch.setenv("EO_BRIDGE_REGION_ORDER", "singapore, EUROPE, bogus, singapore")
    assert handshake.region_order() == ["SINGAPORE", "EUROPE"]


def test_region_order_fails_over_after_a_stale_pin(monkeypatch):
    monkeypatch.delenv("EO_BRIDGE_REGION_ORDER", raising=False)
    monkeypatch.setenv("EO_BRIDGE_REGION", "INDIA")
    order = handshake.region_order()
    assert order[0] == "INDIA"
    assert "EUROPE" in order
    assert len(order) == len(set(order))


def test_region_order_without_pin_is_auto(monkeypatch):
    monkeypatch.delenv("EO_BRIDGE_REGION_ORDER", raising=False)
    monkeypatch.setenv("EO_BRIDGE_REGION", "NOPE")
    assert handshake.region_order() == handshake.DEFAULT_ORDER


def test_proxy_defaults_to_direct_connection(monkeypatch):
    monkeypatch.delenv("EO_BRIDGE_WS_PROXY", raising=False)
    assert handshake._proxy() is None
    monkeypatch.setenv("EO_BRIDGE_WS_PROXY", "none")
    assert handshake._proxy() is None
    monkeypatch.setenv("EO_BRIDGE_WS_PROXY", "http://proxy.local:3128")
    assert handshake._proxy() == "http://proxy.local:3128"


@pytest.mark.parametrize(
    "exc,kind",
    [
        (asyncio.TimeoutError(), "timeout"),
        (OSError("[Errno -2] Name or service not known"), "dns_error"),
        (OSError("[Errno 111] Connection refused"), "connection_refused"),
        (OSError("Network is unreachable"), "network_unreachable"),
        (RuntimeError("certificate verify failed"), "tls_error"),
        (RuntimeError("weird"), "connect_error"),
    ],
)
def test_error_classification(exc, kind):
    assert handshake._classify(exc) == kind


@pytest.mark.asyncio
async def test_probe_reports_a_completed_upgrade(monkeypatch):
    writer = FakeWriter()

    async def fake_open(*args, **kwargs):
        return FakeReader(b"HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\n\r\n"), writer

    monkeypatch.setattr(asyncio, "open_connection", fake_open)
    result = await handshake.probe("EUROPE", timeout=2)
    assert result["ok"] is True
    assert result["status"] == 101
    assert b"Sec-WebSocket-Version: 13" in writer.payload
    assert b"Origin: https://app.expertoption.com" in writer.payload


@pytest.mark.asyncio
async def test_probe_reports_a_refused_upgrade(monkeypatch):
    async def fake_open(*args, **kwargs):
        return FakeReader(b"HTTP/1.1 403 Forbidden\r\n\r\n"), FakeWriter()

    monkeypatch.setattr(asyncio, "open_connection", fake_open)
    result = await handshake.probe("EUROPE", timeout=2)
    assert result["ok"] is False
    assert result["status"] == 403
    assert result["error_kind"] == "upgrade_refused"


@pytest.mark.asyncio
async def test_probe_reports_a_connect_timeout(monkeypatch):
    async def fake_open(*args, **kwargs):
        raise asyncio.TimeoutError()

    monkeypatch.setattr(asyncio, "open_connection", fake_open)
    result = await handshake.probe("HONG_KONG", timeout=1)
    assert result["ok"] is False
    assert result["error_kind"] == "timeout"


@pytest.mark.asyncio
async def test_diagnose_covers_every_requested_region(monkeypatch):
    async def fake_probe(region, url=None, timeout=None):
        return {"region": region, "ok": region == "SINGAPORE", "error_kind": None}

    monkeypatch.setattr(handshake, "probe", fake_probe)
    probes = await handshake.diagnose(["EUROPE", "SINGAPORE"])
    assert [p["region"] for p in probes] == ["EUROPE", "SINGAPORE"]
    assert handshake.select_region_sync_result(probes) == "SINGAPORE"


@pytest.mark.asyncio
async def test_session_fails_over_to_a_reachable_region(monkeypatch):
    calls = []

    class FlakyClient:
        def __init__(self, token, demo=True, url=None):
            self.url = url
            self.client = type("S", (), {"connected": False})()
            calls.append(url)

        async def connect(self):
            if "fr24g1eu" in self.url:
                raise OSError("Network is unreachable")
            self.client.connected = True

    async def fake_diagnose(regions=None, timeout=None):
        # Probes say EUROPE is healthy, but the upgrade then fails at the socket
        # level: the session must still move to the next regional endpoint.
        return [
            {"region": "EUROPE", "ok": True, "handshake_ms": 10.0},
            {"region": "INDIA", "ok": True, "handshake_ms": 30.0},
        ]

    monkeypatch.setattr(manager, "ExpertOptionAsync", FlakyClient)
    monkeypatch.setattr(manager.handshake, "diagnose", fake_diagnose)
    monkeypatch.setattr(manager, "CONNECT_RETRIES", 1)
    monkeypatch.setattr(manager, "CONNECT_BACKOFF", 0.0)
    handshake.clear_cache()
    session = manager.Session(token="t0ken-failover", demo=True)
    client = await session.ensure_client()
    assert session.endpoint_region == "INDIA"
    assert client.url == handshake.url_for("INDIA")
    assert calls[0] == handshake.url_for("EUROPE")
    assert calls[1] == handshake.url_for("INDIA")
    handshake.clear_cache()


@pytest.mark.asyncio
async def test_no_reachable_region_reports_handshake_unreachable(monkeypatch):
    async def fake_diagnose(regions=None, timeout=None):
        return [{"region": r, "ok": False, "error_kind": "timeout"} for r in (regions or [])]

    monkeypatch.setattr(manager.handshake, "diagnose", fake_diagnose)
    handshake.clear_cache()
    session = manager.Session(token="t0ken-blocked", demo=True)
    with pytest.raises(manager.BridgeError) as err:
        await session.ensure_client()
    assert err.value.code == "handshake_unreachable"
    assert err.value.status == 503


@pytest.mark.asyncio
async def test_handshake_endpoint_requires_the_bridge_key(monkeypatch):
    import httpx

    from eo_bridge.app import app

    async def fake_diagnose(regions=None, timeout=None):
        return [{"region": "EUROPE", "ok": True, "status": 101, "handshake_ms": 12.0}]

    monkeypatch.setattr(handshake, "diagnose", fake_diagnose)
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://bridge") as client:
        denied = await client.get("/handshake")
        allowed = await client.get("/handshake", headers={"Authorization": "Bearer test-key"})
    assert denied.status_code == 401
    assert allowed.status_code == 200
    body = allowed.json()
    assert body["reachable"] == ["EUROPE"]
    assert body["probes"][0]["status"] == 101
