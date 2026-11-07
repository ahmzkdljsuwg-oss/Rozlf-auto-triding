"""HTTP stand-in for the ROZLF ExpertOption bridge, used only by the e2e test.

It mirrors the response shapes of eo_bridge/app.py so the Node adapter is
exercised over a real socket (auth header, timeouts, parsing) without any
ExpertOption credentials.
"""

import math
import os
import time

import uvicorn
from fastapi import FastAPI, Header, HTTPException, Query

API_KEY = os.environ.get("EO_BRIDGE_API_KEY", "test-key")
START = time.time()

INSTRUMENTS = [
    {"id": "240", "symbol": "SMARTY", "name": "Smarty", "category": "smarty", "otc": False, "active": True, "payout": 82, "timeframes": [60, 300]},
    {"id": "179", "symbol": "EURUSD_OTC", "name": "EUR/USD OTC", "category": "otc", "otc": True, "active": True, "payout": 78, "timeframes": [60, 300]},
    {"id": "276", "symbol": "CRICKET", "name": "Cricket Index", "category": "index", "otc": False, "active": False, "payout": 80, "timeframes": [60]},
    {"id": "500", "symbol": "BTCUSD", "name": "BTC/USD", "category": "crypto", "otc": False, "active": True, "payout": 74, "timeframes": [60]},
]

STEP = {"M1": 60, "M5": 300, "M15": 900}

app = FastAPI()


def check(authorization: str = Header(default="")):
    if authorization != f"Bearer {API_KEY}":
        raise HTTPException(status_code=401, detail="bridge key rejected")


def build_candles(instrument_id: str, timeframe: str, limit: int):
    if instrument_id == "999":
        return []
    step = STEP.get(timeframe, 60)
    now = int(time.time() // step) * step
    rows = []
    price = 1.1000
    for i in range(limit):
        open_ = price
        drift = 0.00004 + math.sin(i / 7) * 0.000012
        close = open_ + drift
        rows.append({
            "time": (now - (limit - 1 - i) * step) * 1000,
            "open": open_,
            "high": max(open_, close) + 0.00002,
            "low": min(open_, close) - 0.00002,
            "close": close,
            "volume": 100,
        })
        price = close
    return rows


@app.get("/health")
def health():
    return {
        "ok": True,
        "service": "rozlf-eo-bridge",
        "version": "test",
        "trading_enabled": False,
        "read_any_account": True,
        "key_configured": True,
        "session_connected": True,
        "upstream": "fake",
    }


@app.get("/session")
def session(authorization: str = Header(default=""), x_eo_token: str = Header(default="")):
    check(authorization)
    if not x_eo_token:
        raise HTTPException(status_code=401, detail="session token missing")
    return {
        "ok": True,
        "connected": True,
        "account": {"login": "900001", "type": "demo", "currency": "USD", "balance": 10000, "equity": 10000, "free_margin": 10000, "used_margin": 0},
        "expires_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(START + 3600)),
    }


@app.get("/account")
def account(authorization: str = Header(default="")):
    check(authorization)
    return {"ok": True, "account": {"login": "900001", "type": "demo", "currency": "USD", "balance": 10000, "equity": 10000, "free_margin": 10000, "used_margin": 0}}


@app.get("/instruments")
def instruments(authorization: str = Header(default="")):
    check(authorization)
    return {"ok": True, "instruments": INSTRUMENTS}


@app.get("/candles")
def get_candles(
    instrument_id: str,
    timeframe: str = "M1",
    limit: int = Query(default=200, ge=1, le=500),
    authorization: str = Header(default=""),
):
    check(authorization)
    rows = build_candles(instrument_id, timeframe, limit)
    return {"ok": True, "count": len(rows), "candles": rows}


@app.get("/quote")
def quote(instrument_id: str, timeframe: str = "M1", authorization: str = Header(default="")):
    check(authorization)
    rows = build_candles(instrument_id, timeframe, 2)
    if not rows:
        raise HTTPException(status_code=424, detail="no market data for this asset")
    return {"ok": True, "price": rows[-1]["close"], "time": rows[-1]["time"]}


@app.get("/instrument/{instrument_id}/expiries")
def expiries(instrument_id: str, timeframe: str = "M1", authorization: str = Header(default="")):
    check(authorization)
    return {"ok": True, "expiries": [30, 60, 120, 180, 300]}


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=int(os.environ.get("PORT", "8099")), log_level="warning")
