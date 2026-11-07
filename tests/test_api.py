import pytest
from fastapi.testclient import TestClient

from app.api import engine
from app.db import Database
from app.main import app


@pytest.fixture
def client(tmp_path, fake_market):
    original_db, original_market = engine.db, engine.market
    engine.db = Database(str(tmp_path / "test.db"))
    engine.market = fake_market
    engine.account = None
    engine.broker = None
    engine.running = False
    engine.emergency = False
    engine.platform = ""
    engine.account_type = "demo"
    engine.execution_mode = "simulated"
    engine.opportunities = []
    with TestClient(app) as c:
        yield c
    engine.stop()
    engine.account = None
    engine.broker = None
    engine.db.close()
    engine.db = original_db
    engine.market = original_market


def test_health_and_config(client):
    assert client.get("/api/health").status_code == 200
    cfg = client.get("/api/config").json()
    assert cfg["app"] == "ROZLF AUTO TRADER"
    assert cfg["real_trading_approved"] is False
    real = [a for a in cfg["account_types"] if a["id"] == "real"][0]
    assert real["enabled"] is False


def test_real_account_is_locked(client):
    r = client.post("/api/connect", json={
        "platform": "mt5", "account_type": "real", "login": "12345", "password": "x", "server": "Live",
    })
    assert r.status_code == 403


def test_bot_requires_account(client):
    assert client.post("/api/bot/start").status_code == 400


def test_demo_connect_status_and_disconnect(client):
    r = client.post("/api/connect", json={
        "platform": "mt5", "account_type": "demo", "login": "12345678", "password": "secret", "server": "Demo",
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["execution_mode"] == "simulated"
    assert "secret" not in r.text

    status = client.get("/api/status").json()
    assert status["account_type"] == "demo"
    assert status["balance"] == 10000
    assert status["platform"] == "mt5"

    trades = client.get("/api/trades").json()
    assert trades["trades"] == []

    assert client.post("/api/disconnect").json()["connected"] is False


def test_expertoption_is_analysis_only(client):
    r = client.post("/api/connect", json={
        "platform": "expertoption", "account_type": "demo", "login": "user@example.com", "password": "pw",
    })
    assert r.status_code == 200, r.text
    assert r.json()["execution_mode"] == "analysis_only"


def test_risk_settings_roundtrip_and_validation(client):
    client.post("/api/connect", json={
        "platform": "mt5", "account_type": "demo", "login": "87654321", "password": "pw", "server": "Demo",
    })
    current = client.get("/api/risk").json()
    assert current["risk_percent"] == 0.5

    payload = {
        "risk_percent": 0.8, "daily_loss_limit_percent": 2.5, "max_open_trades": 2,
        "max_daily_trades": 6, "min_confidence": 0.65, "max_spread_pips": 2.0,
    }
    r = client.post("/api/risk", json=payload)
    assert r.status_code == 200
    assert client.get("/api/risk").json()["risk_percent"] == 0.8

    bad = dict(payload, risk_percent=50)
    assert client.post("/api/risk", json=bad).status_code == 422


def test_emergency_stop(client):
    client.post("/api/connect", json={
        "platform": "mt5", "account_type": "demo", "login": "55555555", "password": "pw", "server": "Demo",
    })
    r = client.post("/api/bot/emergency")
    assert r.status_code == 200
    assert r.json()["status"]["emergency"] is True
    assert client.post("/api/bot/start").status_code == 400


def test_chart_path_traversal_blocked(client):
    assert client.get("/api/charts/..%2F..%2Fetc%2Fpasswd").status_code in (400, 404)
    assert client.get("/api/charts/missing.png").status_code == 404
