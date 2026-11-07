"""Contract tests for the Windows MT5 bridge using an in-process fake terminal."""
import hashlib
import hmac
import os
import sys
import time
from pathlib import Path
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

TOKEN = "test-token"
SECRET = "test-secret"
os.environ["MT5_BRIDGE_TOKEN"] = TOKEN
os.environ["MT5_BRIDGE_SECRET"] = SECRET

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "mt5_bridge"))
import bridge  # noqa: E402


class FakeMT5:
    POSITION_TYPE_BUY = 0
    DEAL_ENTRY_OUT = 1
    DEAL_TYPE_BUY = 0
    ORDER_TYPE_BUY = 0
    ORDER_TYPE_SELL = 1
    ORDER_FILLING_FOK = 0
    ORDER_FILLING_IOC = 1
    ORDER_FILLING_RETURN = 2
    ORDER_TIME_GTC = 0
    TRADE_ACTION_DEAL = 1
    TRADE_RETCODE_DONE = 10009
    TRADE_RETCODE_PLACED = 10008

    def __init__(self):
        self.trade_mode = 0
        self.opened = []
        self.closed = set()

    def initialize(self, **kwargs):
        self.trade_mode = 0 if kwargs["login"] == 900123 else 2
        return True

    def shutdown(self):
        return True

    def last_error(self):
        return (0, "ok")

    def account_info(self):
        return SimpleNamespace(
            login=900123, server="MetaQuotes-Demo", balance=10000.0, equity=10000.0,
            margin_free=10000.0, margin=0.0, margin_level=0.0, currency="USD",
            leverage=100, trade_mode=self.trade_mode,
        )

    def symbol_select(self, symbol, enable):
        return symbol in {"EURUSD", "XAUUSD"}

    def symbol_info(self, symbol):
        return SimpleNamespace(filling_mode=1)

    def symbol_info_tick(self, symbol):
        return SimpleNamespace(bid=1.1000, ask=1.1002)

    def positions_get(self, ticket=None):
        if ticket is None:
            return list(self.opened)
        return [p for p in self.opened if p.ticket == ticket]

    def history_deals_get(self, position):
        if position not in self.closed:
            return []
        return [
            SimpleNamespace(entry=0, type=0, volume=0.1, price=1.1002, profit=0.0,
                            swap=0.0, commission=-0.1, symbol="EURUSD", time=1700000000),
            SimpleNamespace(entry=1, type=0, volume=0.1, price=1.1050, profit=4.8,
                            swap=0.0, commission=-0.1, symbol="EURUSD", time=1700003600),
        ]

    def order_send(self, payload):
        if payload.get("position"):
            ticket = int(payload["position"])
            self.opened = [p for p in self.opened if p.ticket != ticket]
            self.closed.add(ticket)
            return SimpleNamespace(retcode=self.TRADE_RETCODE_DONE, order=ticket,
                                  price=payload["price"], comment="closed")
        ticket = 555001 + len(self.opened) + len(self.closed)
        self.opened.append(SimpleNamespace(
            ticket=ticket, symbol=payload["symbol"],
            type=self.POSITION_TYPE_BUY, volume=payload["volume"],
            price_open=payload["price"], price_current=payload["price"],
            sl=payload.get("sl", 0), tp=payload.get("tp", 0), profit=0.0, time=1700000000,
        ))
        return SimpleNamespace(retcode=self.TRADE_RETCODE_DONE, order=ticket,
                              price=payload["price"], comment="done")


@pytest.fixture()
def client(monkeypatch):
    fake = FakeMT5()
    monkeypatch.setattr(bridge, "mt5", fake)
    bridge._state.update({"initialized": False, "login": "", "server": ""})
    return TestClient(bridge.app), fake


def signed(method, path, body=b""):
    stamp = str(int(time.time()))
    signature = hmac.new(
        SECRET.encode(), f"{stamp}\n{method}\n{path}\n{body.decode()}".encode(), hashlib.sha256
    ).hexdigest()
    return {
        "X-Bridge-Token": TOKEN, "X-Bridge-Timestamp": stamp,
        "X-Bridge-Signature": signature, "Content-Type": "application/json",
    }


def test_requests_without_signature_are_rejected(client):
    http, _ = client
    assert http.get("/ping").status_code == 401
    assert http.get("/ping", headers={"X-Bridge-Token": TOKEN}).status_code == 401


def test_signed_ping_and_account_sync(client):
    http, _ = client
    assert http.get("/ping", headers=signed("GET", "/ping")).status_code == 200
    login = http.post("/connect", headers=signed("POST", "/connect", b'{"login":"900123","password":"x","server":"MetaQuotes-Demo","account_type":"demo"}'),
                      content=b'{"login":"900123","password":"x","server":"MetaQuotes-Demo","account_type":"demo"}')
    assert login.status_code == 200, login.text
    data = login.json()
    assert data["is_demo"] is True and data["balance"] == 10000.0
    account = http.get("/account", headers=signed("GET", "/account"))
    assert account.json()["margin_free"] == 10000.0
    assert account.json()["margin_used"] == 0.0


def test_real_account_is_refused(client):
    http, _ = client
    body = b'{"login":"1","password":"x","account_type":"real"}'
    res = http.post("/connect", headers=signed("POST", "/connect", body), content=body)
    assert res.status_code == 403


def test_order_and_close_require_real_ticket(client):
    http, fake = client
    http.post("/connect", headers=signed("POST", "/connect", b'{"login":"900123","password":"x","account_type":"demo"}'),
              content=b'{"login":"900123","password":"x","account_type":"demo"}')
    body = b'{"symbol":"EURUSD","side":"BUY","lot":0.1,"stop_loss":1.0950,"take_profit":1.1100}'
    res = http.post("/order", headers=signed("POST", "/order", body), content=body)
    assert res.status_code == 200 and res.json()["accepted"] is True
    ticket = res.json()["ticket"]
    assert ticket.isdigit()
    close_body = ('{"order_id":"%s","symbol":"EURUSD","side":"BUY","lot":0.1}' % ticket).encode()
    closed = http.post("/close", headers=signed("POST", "/close", close_body), content=close_body)
    assert closed.status_code == 200 and closed.json()["accepted"] is True
    history = http.get(f"/history?ticket={ticket}", headers=signed("GET", f"/history?ticket={ticket}"))
    assert history.json()["found"] is True
