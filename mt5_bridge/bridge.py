"""ROZLF MT5 bridge.

Runs on a Windows machine or VPS beside the MetaTrader 5 terminal. The Render
backend authenticates every request with a shared token and an HMAC signature;
this process never exposes the MT5 password anywhere and never accepts a real
account while ROZLF runs in demo mode.
"""
import hashlib
import hmac
import os
import time
from datetime import datetime, timezone
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

try:  # imported only on Windows with the terminal installed
    import MetaTrader5 as mt5
except ImportError:  # keeps the module importable for linting on Linux
    mt5 = None

BRIDGE_TOKEN = os.environ.get("MT5_BRIDGE_TOKEN", "")
BRIDGE_SECRET = os.environ.get("MT5_BRIDGE_SECRET", "")
ALLOWED_SKEW_SECONDS = int(os.environ.get("MT5_BRIDGE_MAX_SKEW_SECONDS", "300"))
MAGIC = int(os.environ.get("MT5_BRIDGE_MAGIC", "20260101"))
DEVIATION = int(os.environ.get("MT5_BRIDGE_DEVIATION", "20"))

app = FastAPI(title="ROZLF MT5 Bridge", docs_url=None, redoc_url=None, openapi_url=None)

_state: dict[str, Any] = {"initialized": False, "login": "", "server": ""}


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _json(status: int, payload: dict) -> JSONResponse:
    return JSONResponse(status_code=status, content=payload)


def _verify(request: Request, body: bytes) -> str:
    if not BRIDGE_TOKEN or not BRIDGE_SECRET:
        return "Bridge token/secret are not configured"
    token = request.headers.get("X-Bridge-Token", "")
    if not hmac.compare_digest(token, BRIDGE_TOKEN):
        return "Invalid bridge token"
    stamp = request.headers.get("X-Bridge-Timestamp", "")
    try:
        skew = abs(time.time() - int(stamp))
    except ValueError:
        return "Invalid bridge timestamp"
    if skew > ALLOWED_SKEW_SECONDS:
        return "Bridge request timestamp is outside the allowed window"
    query = request.url.query
    path = request.url.path + (("?" + query) if query else "")
    expected = hmac.new(
        BRIDGE_SECRET.encode(),
        f"{stamp}\n{request.method.upper()}\n{path}\n{body.decode()}".encode(),
        hashlib.sha256,
    ).hexdigest()
    supplied = request.headers.get("X-Bridge-Signature", "")
    if not hmac.compare_digest(expected, supplied):
        return "Invalid bridge signature"
    return ""


def _terminal_ready() -> bool:
    return mt5 is not None and _state["initialized"]


def _account_payload(info) -> dict:
    return {
        "ok": True,
        "connected": True,
        "login": str(info.login),
        "server": str(info.server),
        "balance": float(info.balance),
        "equity": float(info.equity),
        "margin_free": float(info.margin_free),
        "margin_used": float(info.margin),
        "margin_level": float(info.margin_level) if info.margin_level else 0.0,
        "currency": str(info.currency),
        "leverage": int(info.leverage),
        "is_demo": int(info.trade_mode) == 0,
        "synced_at": _now_iso(),
    }


def _filling_mode(symbol_info) -> int:
    flags = symbol_info.filling_mode
    if flags & 1:
        return mt5.ORDER_FILLING_FOK
    if flags & 2:
        return mt5.ORDER_FILLING_IOC
    return mt5.ORDER_FILLING_RETURN


def _position_payload(p) -> dict:
    return {
        "ticket": str(p.ticket),
        "symbol": p.symbol,
        "side": "BUY" if p.type == mt5.POSITION_TYPE_BUY else "SELL",
        "lot": float(p.volume),
        "entry_price": float(p.price_open),
        "current_price": float(p.price_current),
        "stop_loss": float(p.sl),
        "take_profit": float(p.tp),
        "pnl": float(p.profit),
        "opened_at": datetime.fromtimestamp(p.time, tz=timezone.utc).isoformat(),
    }


@app.middleware("http")
async def auth_middleware(request: Request, call_next):
    body = await request.body()
    error = _verify(request, body)
    if error:
        return _json(401, {"ok": False, "detail": error})
    response = await call_next(request)
    response.headers["Cache-Control"] = "no-store"
    return response


@app.get("/ping")
def ping() -> dict:
    return {"ok": True, "service": "rozlf-mt5-bridge", "terminal": _terminal_ready()}


@app.post("/connect")
async def connect(request: Request) -> JSONResponse:
    if mt5 is None:
        return _json(503, {"ok": False, "detail": "MetaTrader5 package is not installed"})
    payload = await request.json()
    login = str(payload.get("login", "")).strip()
    password = str(payload.get("password", ""))
    server = str(payload.get("server", "")).strip()
    account_type = str(payload.get("account_type", "demo")).lower()
    if account_type != "demo":
        return _json(403, {"ok": False, "detail": "Only demo accounts are enabled"})
    if not login or not password:
        return _json(422, {"ok": False, "detail": "login and password are required"})
    kwargs = {"login": int(login), "password": password, "timeout": 20000}
    if server:
        kwargs["server"] = server
    if _state["initialized"]:
        mt5.shutdown()
        _state["initialized"] = False
    if not mt5.initialize(**kwargs):
        return _json(502, {
            "ok": False,
            "connected": False,
            "detail": f"MT5 initialize failed: {mt5.last_error()}",
        })
    info = mt5.account_info()
    if info is None:
        mt5.shutdown()
        return _json(502, {"ok": False, "connected": False, "detail": "MT5 did not return account info"})
    if int(info.trade_mode) != 0:
        mt5.shutdown()
        return _json(403, {"ok": False, "connected": False, "detail": "The MT5 account is not a demo account"})
    _state.update({"initialized": True, "login": login, "server": str(info.server)})
    return _json(200, _account_payload(info))


@app.post("/disconnect")
def disconnect() -> dict:
    if mt5 is not None and _state["initialized"]:
        mt5.shutdown()
    _state.update({"initialized": False, "login": "", "server": ""})
    return {"ok": True, "connected": False}


@app.get("/account")
def account() -> JSONResponse:
    if not _terminal_ready():
        return _json(200, {"ok": True, "connected": False, "detail": "MT5 terminal is not connected"})
    info = mt5.account_info()
    if info is None:
        return _json(200, {"ok": True, "connected": False, "detail": "MT5 account info is unavailable"})
    return _json(200, _account_payload(info))


@app.get("/positions")
def positions() -> JSONResponse:
    if not _terminal_ready():
        return _json(503, {"ok": False, "detail": "MT5 terminal is not connected"})
    rows = mt5.positions_get()
    return _json(200, {"ok": True, "positions": [_position_payload(p) for p in (rows or [])]})


@app.get("/history")
def history(ticket: str) -> JSONResponse:
    if not _terminal_ready():
        return _json(503, {"ok": False, "detail": "MT5 terminal is not connected"})
    deals = mt5.history_deals_get(position=int(ticket))
    if not deals:
        return _json(200, {"ok": True, "found": False})
    closing = [d for d in deals if d.entry == mt5.DEAL_ENTRY_OUT]
    if not closing:
        return _json(200, {"ok": True, "found": False})
    last = closing[-1]
    first = deals[0]
    side = "BUY" if first.type == mt5.DEAL_TYPE_BUY else "SELL"
    return _json(200, {
        "ok": True,
        "found": True,
        "ticket": str(ticket),
        "symbol": last.symbol,
        "side": side,
        "lot": float(first.volume),
        "entry_price": float(first.price),
        "close_price": float(last.price),
        "pnl": float(sum(float(d.profit) + float(d.swap) + float(d.commission) for d in deals)),
        "closed_at": datetime.fromtimestamp(last.time, tz=timezone.utc).isoformat(),
    })


@app.get("/price")
def price(symbol: str) -> JSONResponse:
    if not _terminal_ready():
        return _json(503, {"ok": False, "detail": "MT5 terminal is not connected"})
    tick = mt5.symbol_info_tick(symbol)
    if tick is None:
        return _json(404, {"ok": False, "detail": f"No tick for {symbol}"})
    return _json(200, {"ok": True, "symbol": symbol, "bid": float(tick.bid), "ask": float(tick.ask)})


@app.post("/order")
async def order(request: Request) -> JSONResponse:
    if not _terminal_ready():
        return _json(503, {"ok": False, "detail": "MT5 terminal is not connected"})
    payload = await request.json()
    symbol = str(payload.get("symbol", "")).upper()
    side = str(payload.get("side", "")).upper()
    lot = float(payload.get("lot", 0) or 0)
    stop_loss = float(payload.get("stop_loss", 0) or 0)
    take_profit = float(payload.get("take_profit", 0) or 0)
    if side not in ("BUY", "SELL") or lot <= 0:
        return _json(422, {"ok": True, "accepted": False, "message": "Invalid side or lot"})
    info = mt5.account_info()
    if info is None or int(info.trade_mode) != 0:
        return _json(403, {"ok": True, "accepted": False, "message": "Only demo accounts are allowed"})
    if not mt5.symbol_select(symbol, True):
        return _json(404, {"ok": True, "accepted": False, "message": f"Unknown symbol {symbol}"})
    tick = mt5.symbol_info_tick(symbol)
    symbol_info = mt5.symbol_info(symbol)
    if tick is None or symbol_info is None:
        return _json(502, {"ok": True, "accepted": False, "message": f"No market data for {symbol}"})
    order_type = mt5.ORDER_TYPE_BUY if side == "BUY" else mt5.ORDER_TYPE_SELL
    fill_price = float(tick.ask if side == "BUY" else tick.bid)
    request_payload = {
        "action": mt5.TRADE_ACTION_DEAL,
        "symbol": symbol,
        "volume": lot,
        "type": order_type,
        "price": fill_price,
        "sl": stop_loss,
        "tp": take_profit,
        "deviation": DEVIATION,
        "magic": MAGIC,
        "comment": "ROZLF",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": _filling_mode(symbol_info),
    }
    result = mt5.order_send(request_payload)
    if result is None:
        return _json(502, {"ok": True, "accepted": False, "message": f"order_send failed: {mt5.last_error()}"})
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return _json(200, {
            "ok": True, "accepted": False,
            "retcode": int(result.retcode),
            "message": f"MT5 retcode {result.retcode}: {result.comment}",
        })
    ticket = str(result.order)
    opened = mt5.positions_get(ticket=result.order) or []
    if not opened:
        return _json(200, {
            "ok": True, "accepted": False,
            "retcode": int(result.retcode),
            "message": f"MT5 reported retcode DONE but position {ticket} is not open",
        })
    position = opened[0]
    after = mt5.account_info()
    return _json(200, {
        "ok": True,
        "accepted": True,
        "ticket": str(position.ticket),
        "order_id": ticket,
        "fill_price": float(position.price_open),
        "retcode": int(result.retcode),
        "account": _account_payload(after) if after is not None else None,
        "message": "MT5 order accepted and position confirmed",
    })


@app.post("/close")
async def close(request: Request) -> JSONResponse:
    if not _terminal_ready():
        return _json(503, {"ok": False, "detail": "MT5 terminal is not connected"})
    payload = await request.json()
    ticket = int(payload.get("order_id", 0) or 0)
    rows = mt5.positions_get(ticket=ticket) or []
    if not rows:
        return _json(404, {"ok": True, "accepted": False, "message": f"No open MT5 position {ticket}"})
    position = rows[0]
    tick = mt5.symbol_info_tick(position.symbol)
    symbol_info = mt5.symbol_info(position.symbol)
    if tick is None or symbol_info is None:
        return _json(502, {"ok": True, "accepted": False, "message": "No market data for close"})
    closing_buy = position.type == mt5.POSITION_TYPE_BUY
    request_payload = {
        "action": mt5.TRADE_ACTION_DEAL,
        "position": position.ticket,
        "symbol": position.symbol,
        "volume": float(position.volume),
        "type": mt5.ORDER_TYPE_SELL if closing_buy else mt5.ORDER_TYPE_BUY,
        "price": float(tick.bid if closing_buy else tick.ask),
        "deviation": DEVIATION,
        "magic": MAGIC,
        "comment": "ROZLF close",
        "type_time": mt5.ORDER_TIME_GTC,
        "type_filling": _filling_mode(symbol_info),
    }
    result = mt5.order_send(request_payload)
    if result is None:
        return _json(502, {"ok": True, "accepted": False, "message": f"close failed: {mt5.last_error()}"})
    if result.retcode != mt5.TRADE_RETCODE_DONE:
        return _json(200, {
            "ok": True, "accepted": False,
            "retcode": int(result.retcode),
            "message": f"MT5 retcode {result.retcode}: {result.comment}",
        })
    if mt5.positions_get(ticket=ticket):
        return _json(200, {
            "ok": True, "accepted": False,
            "retcode": int(result.retcode),
            "message": f"MT5 reported retcode DONE but position {ticket} is still open",
        })
    after = mt5.account_info()
    return _json(200, {
        "ok": True, "accepted": True, "ticket": str(ticket),
        "fill_price": float(result.price) if result.price else request_payload["price"],
        "retcode": int(result.retcode),
        "account": _account_payload(after) if after is not None else None,
        "message": "MT5 close accepted and position removed",
    })
