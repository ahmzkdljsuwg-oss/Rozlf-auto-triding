import asyncio
import time

import pytest

from eo_bridge.sources import model, registry
from eo_bridge.sources.base import AssetRecord, Candle, DataSource, QuoteRecord, SourceError, SourceUnavailable
from eo_bridge.sources.verification import candle_problems, verify_instrument, verify_many

PAYLOAD = [
    {"id": 240, "symbol": "SMARTY", "name": "Smarty", "is_active": 1, "profit": 78},
    {"id": 276, "symbol": "CRICKET", "name": "Cricket Index", "is_active": 0},
    {"id": 278, "symbol": "FOOTBALL", "name": "Football Index", "is_active": 1},
    {"id": 285, "symbol": "AI", "name": "AI Index", "is_active": 1},
    {"id": 286, "symbol": "LUXURY", "name": "Luxury Index", "is_active": 1},
    {"id": 179, "symbol": "EURUSD_OTC", "name": "EUR/USD OTC", "is_active": 1, "profit": 80},
    {"id": 180, "symbol": "GBPUSD_OTC", "name": "GBP/USD OTC", "is_active": 1},
    {"id": 181, "symbol": "USDJPY_OTC", "name": "USD/JPY OTC", "is_active": 1},
    {"id": 1, "symbol": "EURUSD", "name": "EUR/USD", "is_active": 1},
    {"id": 2, "symbol": "GBPUSD", "name": "GBP/USD", "is_active": 1},
    {"id": 3, "symbol": "USDJPY", "name": "USD/JPY", "is_active": 1},
    {"id": 4, "symbol": "AUDUSD", "name": "AUD/USD", "is_active": 1},
    {"id": 500, "symbol": "BTCUSD", "name": "BTC/USD", "is_active": 1},
    {"id": 501, "symbol": "XAUUSD", "name": "Gold", "is_active": 1},
    {"id": 502, "symbol": "AAPL", "name": "Apple", "is_active": 1},
]


def records():
    return model.normalize_assets(PAYLOAD, fallback_timeframes=[60, 300, 900])


def series(period=60, count=40, last_age=30, step=None):
    now = int(time.time())
    step = step or period
    start = now - last_age - step * (count - 1)
    out = []
    price = 1.1000
    for i in range(count):
        t = (start + i * step) * 1000
        out.append(Candle(time=t, open=price, high=price + 0.0004, low=price - 0.0004,
                          close=price + 0.0001, volume=10, timeframe=period))
        price += 0.0001
    return out


class FakeSource(DataSource):
    name = "fake"
    title = "Fake provider"

    def __init__(self, *, connected=True, candles=None, quote_ok=True, tf=(60, 300, 900)):
        self._connected = connected
        self._candles = candles
        self._quote_ok = quote_ok
        self._tf = list(tf)

    def status(self):
        return {"source": self.name, "connected": self._connected}

    async def assets(self, refresh=False):
        return records()

    async def timeframes(self, refresh=False):
        return list(self._tf)

    async def candles(self, asset_id, period, limit=200):
        if self._candles is not None:
            return list(self._candles)[-limit:]
        return series(period)[-limit:]

    async def quote(self, asset_id, period=60):
        if not self._quote_ok:
            raise SourceError("stale", code="stale_data", status=409)
        return QuoteRecord(price=1.1, time=int(time.time() * 1000), timeframe=period, age_ms=500)


def run(coro):
    return asyncio.run(coro)


def test_classification_covers_requested_markets():
    by_symbol = {a.symbol: a for a in records()}
    assert by_symbol["SMARTY"].market == "smarty"
    assert by_symbol["CRICKET"].market == "index"
    assert by_symbol["EURUSD_OTC"].market == "otc"
    assert by_symbol["EURUSD_OTC"].otc is True
    assert by_symbol["EURUSD"].market == "forex"
    assert by_symbol["BTCUSD"].market == "crypto"
    assert by_symbol["XAUUSD"].market == "commodity"
    assert by_symbol["AAPL"].market == "stock"
    assert by_symbol["CRICKET"].active is False
    assert by_symbol["SMARTY"].payout == 78.0
    assert by_symbol["CRICKET"].payout is None


def test_unknown_name_is_not_guessed_into_a_market():
    record = model.normalize_asset({"id": 9, "symbol": "ZZZQ", "name": "Mystery"})
    assert record.market == "other"


def test_legacy_dict_keeps_category_key():
    record = model.normalize_asset(PAYLOAD[0])
    data = record.as_legacy_dict()
    assert data["category"] == data["market"] == "smarty"
    assert data["id"] == 240


def test_wanted_coverage_matches_real_list_and_reports_missing():
    coverage = model.match_wanted(records())
    found = {c["requested"]: c for c in coverage}
    assert found["Smarty"]["asset"]["id"] == 240
    assert found["EUR/USD OTC"]["asset"]["id"] == 179
    assert found["EUR/USD"]["asset"]["id"] == 1
    assert found["GBP/JPY"]["found"] is False
    assert [c["requested"] for c in coverage if not c["found"]]


def test_search_filters_market_and_query():
    assets = records()
    otc = model.search(assets, "", "otc")
    assert otc and all(a.market == "otc" for a in otc)
    sm = model.search(assets, "smart")
    assert [a.symbol for a in sm] == ["SMARTY"]
    assert model.search(assets, "", "all", only_active=True)
    assert all(a.active for a in model.search(assets, "", "all", only_active=True))


def test_market_summary_counts_every_bucket():
    summary = model.market_summary(records())
    assert summary["smarty"] == 1 and summary["otc"] == 3 and summary["index"] == 4


def test_candle_problems_detects_duplicates_gaps_and_bad_ohlc():
    good = series()
    assert candle_problems(good, 60) == []
    dup = series()
    dup.append(dup[-1])
    assert any("duplicate" in p or "increasing" in p for p in candle_problems(dup, 60))
    gap = series()
    gap.append(Candle(time=gap[-1].time + 60_000 * 10, open=1, high=1, low=1, close=1))
    assert any("gap" in p for p in candle_problems(gap, 60))
    bad = series()
    bad[0] = Candle(time=bad[0].time, open=1.2, high=1.1, low=0.9, close=1.0)
    assert "OHLC bounds are inconsistent" in candle_problems(bad, 60)
    assert candle_problems([], 60) == ["no candles"]


def test_verify_passes_on_fresh_consistent_data():
    report = run(verify_instrument(FakeSource(), asset_id=240))
    assert report["passed"] is True
    assert report["verdict"] == "verified"
    assert {c["id"] for c in report["checks"]} == {
        "listed", "identity", "quote", "candles", "integrity", "fresh", "timeframes", "connection"}
    assert all(c["ok"] for c in report["checks"])


def test_verify_fails_when_candles_are_stale():
    stale = series(last_age=60 * 30)
    report = run(verify_instrument(FakeSource(candles=stale), asset_id=240))
    assert report["passed"] is False
    fresh = {c["id"]: c for c in report["checks"]}["fresh"]
    assert fresh["ok"] is False and "الحد" in fresh["detail"]


def test_verify_fails_when_asset_missing():
    report = run(verify_instrument(FakeSource(), symbol="GBP/JPY"))
    assert report["passed"] is False and report["verdict"] == "not_listed"
    assert all(c["ok"] is False for c in report["checks"])


def test_verify_fails_when_disconnected():
    report = run(verify_instrument(FakeSource(connected=False), asset_id=240))
    assert report["passed"] is False
    connection = {c["id"]: c for c in report["checks"]}["connection"]
    assert connection["ok"] is False and "غير متصل" in connection["detail"]


def test_verify_reports_unsupported_timeframe_instead_of_faking_it():
    src = FakeSource(tf=[60])
    report = run(verify_instrument(src, asset_id=240, timeframes=[60, 1800]))
    tf_check = {c["id"]: c for c in report["checks"]}["timeframes"]
    first, second = tf_check["timeframes"]
    assert first["ok"] is True
    assert second["ok"] is False and "غير مدعوم" in second["detail"]


def test_verify_many_summarises_pass_and_fail():
    report = run(verify_many(FakeSource(), [{"id": 240}, {"symbol": "GBP/JPY"}]))
    assert report["total"] == 2 and report["passed"] == 1 and report["failed"] == 1


def test_registry_refuses_without_token_and_lists_honest_capabilities():
    with pytest.raises(SourceUnavailable):
        registry.resolve("expertoption-session", "", True)
    with pytest.raises(SourceUnavailable):
        registry.resolve("nope", "token", True)
    described = registry.describe()
    assert registry.names() == ["expertoption-session"]
    assert [d["id"] for d in described if d["available"]] == ["expertoption-session"]
    assert all(d["why"] for d in described)
