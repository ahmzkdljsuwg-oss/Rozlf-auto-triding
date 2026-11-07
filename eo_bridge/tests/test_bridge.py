import asyncio
import os
import time

os.environ.setdefault("EO_BRIDGE_API_KEY", "test-key")

import httpx
import pytest
import pytest_asyncio

import eo_bridge.manager as manager
from eo_bridge.app import app
from eo_bridge.vendor.ExpertOptionsToolsV2.expertoption.asyncronous import TradingDisabledError

HEADERS = {"Authorization": "Bearer test-key", "X-EO-Token": "demo-token-123", "X-EO-Demo": "1"}

ASSETS = [
    {"id": 240, "symbol": "SMARTY", "is_active": 1, "profit": 78},
    {"id": 179, "symbol": "EURUSD_OTC", "is_active": 1, "profit": 80},
    {"id": 276, "symbol": "CRICKET", "is_active": 0, "profit": 0},
]


def candle_rows(count=5, base=None):
    if base is None:
        base = int(time.time()) - count * 60
    return [
        {
            "time": base + i * 60,
            "open": 1.1000 + i * 0.0001,
            "high": 1.1005 + i * 0.0001,
            "low": 1.0995 + i * 0.0001,
            "close": 1.1002 + i * 0.0001,
            "timeframe": 60,
            "volume": 10,
            "source": "historical",
        }
        for i in range(count)
    ]


class FakeSocket:
    connected = True


class FakeClient:
    """Stand-in for ExpertOptionAsync, mirroring only what the bridge calls."""

    def __init__(self, token, demo=True, url=None):
        self.token = token
        self.demo = demo
        self.client = FakeSocket()
        self.candle_cache = {}
        self.asset_timeframes = [5, 15, 30, 60, 300, 900]

    async def connect(self):
        self.client.connected = True

    async def disconnect(self):
        self.client.connected = False

    async def send_ping(self):
        return None

    async def fetch_profile(self):
        return {
            "id": 5551234,
            "email": "demo@example.com",
            "context": "demo",
            "currency": "USD",
            "demo_balance": 10020.5,
            "demo_equity": 10020.5,
            "demo_free_margin": 10020.5,
            "demo_used_margin": 0.0,
        }

    async def fetch_assets(self):
        return ASSETS

    async def fetch_timeframes(self):
        return [5, 15, 30, 60, 300, 900]

    async def get_candles(self, asset_id, period, offset, duration=1800, count_request=3, start_time=None, as_dataframe=True):
        if asset_id == 999:
            return []
        self.candle_cache.setdefault(asset_id, {})[period] = {
            "candles": candle_rows(),
            "expTimes": [1700000060, 1700000120, 1700000180],
        }
        return candle_rows()

    async def subscribe_symbol(self, asset_id, timeframes=None):
        async def gen():
            while True:
                yield {"asset_id": asset_id, "timeframe": 60, "time": 1700000060, "close": 1.2345}
                await asyncio.sleep(3600)

        return gen()


@pytest_asyncio.fixture
async def client(monkeypatch):
    monkeypatch.setattr(manager, "ExpertOptionAsync", FakeClient)
    manager.registry.sessions.clear()
    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://bridge") as c:
        yield c
    await manager.registry.close_all()


@pytest.mark.asyncio
async def test_requires_bridge_key(client):
    response = await client.get("/instruments", headers={"X-EO-Token": "t"})
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_session_verifies_and_returns_account(client):
    response = await client.get("/session", headers=HEADERS)
    assert response.status_code == 200
    body = response.json()
    assert body["connected"] is True
    assert body["account"]["balance"] == 10020.5
    assert body["account"]["type"] == "demo"
    assert body["account"]["used_margin"] == 0.0


@pytest.mark.asyncio
async def test_instruments_come_from_session_assets(client):
    response = await client.get("/instruments", headers=HEADERS)
    assert response.status_code == 200
    items = {i["symbol"]: i for i in response.json()["instruments"]}
    assert set(items) == {"SMARTY", "EURUSD_OTC", "CRICKET"}
    assert items["EURUSD_OTC"]["otc"] is True
    assert items["CRICKET"]["active"] is False


@pytest.mark.asyncio
async def test_candles_are_millisecond_timestamps(client):
    response = await client.get("/candles", params={"instrument_id": 240, "timeframe": "M1"}, headers=HEADERS)
    assert response.status_code == 200
    body = response.json()
    assert body["count"] == 5
    assert body["candles"][0]["time"] == pytest.approx(candle_rows()[0]["time"] * 1000, abs=1000)


@pytest.mark.asyncio
async def test_unknown_timeframe_is_rejected(client):
    response = await client.get("/candles", params={"instrument_id": 240, "timeframe": "M7"}, headers=HEADERS)
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_quote_returns_last_close(client):
    response = await client.get("/quote", params={"instrument_id": 240, "timeframe": "M1"}, headers=HEADERS)
    assert response.status_code == 200
    assert response.json()["price"] == pytest.approx(1.1006)


@pytest.mark.asyncio
async def test_expiries_come_from_session_exp_times(client):
    response = await client.get("/instrument/240/expiries", params={"timeframe": "M1"}, headers=HEADERS)
    assert response.status_code == 200
    assert response.json()["expiries"] == [60]


@pytest.mark.asyncio
async def test_empty_candles_are_reported_not_invented(client):
    response = await client.get("/candles", params={"instrument_id": 999, "timeframe": "M1"}, headers=HEADERS)
    assert response.status_code == 200, response.text
    assert response.json()["count"] == 0
    quote = await client.get("/quote", params={"instrument_id": 999, "timeframe": "M1"}, headers=HEADERS)
    assert quote.status_code in (409, 424)
    assert "price" not in quote.json()


@pytest.mark.asyncio
async def test_real_account_data_is_readable_while_trading_stays_disabled(client):
    headers = dict(HEADERS, **{"X-EO-Demo": "0"})
    response = await client.get("/session", headers=headers)
    assert response.status_code == 200
    body = response.json()
    assert body["account"]["type"] == "real"
    # the stand-in profile has no real balance: the bridge reports null, never a made-up figure
    assert body["account"]["balance"] is None
    candles = await client.get("/candles", params={"instrument_id": 240, "timeframe": "M1"}, headers=headers)
    assert candles.status_code == 200


@pytest.mark.asyncio
async def test_health_reports_trading_as_disabled(client):
    body = (await client.get("/health")).json()
    assert body["trading_enabled"] is False
    assert body["demo_only"] is True
    assert body["read_any_account"] is True


@pytest.mark.asyncio
async def test_a_stale_quote_is_refused_instead_of_reused(client):
    first = await client.get("/quote", params={"instrument_id": 240, "timeframe": "M1"}, headers=HEADERS)
    assert first.status_code == 200
    session = next(iter(manager.registry.sessions.values()))
    session.quotes.clear()

    async def old_candles(*_args, **_kwargs):
        return candle_rows(base=int(time.time()) - 3600)

    session.candles = old_candles
    stale = await client.get("/quote", params={"instrument_id": 240, "timeframe": "M1"}, headers=HEADERS)
    assert stale.status_code == 409
    assert stale.json()["error"]["code"] == "stale_data"


@pytest.mark.asyncio
async def test_calls_survive_a_dropped_socket(client, monkeypatch):
    first = await client.get("/session", headers=HEADERS)
    assert first.status_code == 200

    session = next(iter(manager.registry.sessions.values()))
    session.client.client.connected = False

    async def boom(*_args, **_kwargs):
        raise ConnectionError("socket closed")

    monkeypatch.setattr(session.client, "fetch_profile", boom)
    second = await client.get("/account", headers=HEADERS)
    assert second.status_code == 200
    assert second.json()["balance"] == 10020.5
    assert session.reconnects >= 1


def test_vendored_client_refuses_orders():
    from eo_bridge.vendor.ExpertOptionsToolsV2.expertoption.asyncronous import ExpertOptionAsync

    instance = ExpertOptionAsync.__new__(ExpertOptionAsync)
    for method in ("buy", "sell"):
        with pytest.raises(TradingDisabledError):
            asyncio.run(getattr(instance, method)(240, 10, 60))


@pytest.mark.asyncio
async def test_a_lost_connection_reports_an_error_instead_of_stale_data(client, monkeypatch):
    first = await client.get("/quote", params={"instrument_id": 240, "timeframe": "M1"}, headers=HEADERS)
    assert first.status_code == 200

    session = next(iter(manager.registry.sessions.values()))
    session.client.client.connected = False

    async def refuse(*_args, **_kwargs):
        raise ConnectionError("network down")

    monkeypatch.setattr(manager, "ExpertOptionAsync", lambda *a, **k: refuse())
    session.quotes.clear()
    lost = await client.get("/quote", params={"instrument_id": 240, "timeframe": "M1"}, headers=HEADERS)
    assert lost.status_code == 502
    assert lost.json()["error"]["code"] == "connect_failed"


@pytest.mark.asyncio
async def test_a_restarted_bridge_rebuilds_the_session_from_the_token(client):
    first = await client.get("/session", headers=HEADERS)
    assert first.status_code == 200
    assert len(manager.registry.sessions) == 1

    # A restart loses all in-memory sessions; the token header must bring it back.
    await manager.registry.close_all()
    manager.registry.sessions.clear()

    again = await client.get("/session", headers=HEADERS)
    assert again.status_code == 200
    assert again.json()["account"]["balance"] == 10020.5
    assert len(manager.registry.sessions) == 1
    assert next(iter(manager.registry.sessions.values())).reconnects >= 0
