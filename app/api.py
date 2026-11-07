import time

from fastapi import APIRouter, Header, HTTPException, Query
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from . import config, security
from .brokers.mt5 import mt5_available
from .engine import TradingEngine

router = APIRouter(prefix="/api")
engine = TradingEngine()


def _auth(token: str | None):
    if not security.dashboard_token_ok(token):
        raise HTTPException(status_code=401, detail="invalid dashboard token")


class ConnectRequest(BaseModel):
    platform: str
    account_type: str
    login: str = Field(min_length=2, max_length=64)
    password: str = Field(min_length=1, max_length=256)
    server: str = Field(default="", max_length=128)


class RiskRequest(BaseModel):
    risk_percent: float = Field(ge=0.1, le=2.0)
    daily_loss_limit_percent: float = Field(ge=0.5, le=10.0)
    max_open_trades: int = Field(ge=1, le=10)
    max_daily_trades: int = Field(ge=1, le=50)
    min_confidence: float = Field(ge=0.5, le=0.95)
    max_spread_pips: float = Field(ge=0.5, le=10.0)


@router.get("/health")
def health():
    return {"ok": True, "app": config.APP_NAME, "version": config.APP_VERSION,
            "time": int(time.time())}


@router.get("/config")
def get_config(x_dashboard_token: str | None = Header(default=None)):
    _auth(x_dashboard_token)
    return {
        "app": config.APP_NAME,
        "version": config.APP_VERSION,
        "platforms": [
            {"id": "expertoption", "name": "ExpertOption", "execution": False,
             "note": "No approved public trading API. Analysis and alerts only."},
            {"id": "mt5", "name": "MT5", "execution": True,
             "note": "Demo uses the simulated engine here; live MT5 requires a Windows VPS."},
        ],
        "account_types": [
            {"id": "demo", "name": "Demo", "enabled": True},
            {"id": "real", "name": "Real", "enabled": config.REAL_TRADING_APPROVED},
        ],
        "symbols": config.SYMBOLS,
        "timeframes": config.TIMEFRAMES,
        "real_trading_approved": config.REAL_TRADING_APPROVED,
        "mt5_available": mt5_available(),
        "mt5_enabled": config.MT5_ENABLED,
        "telegram_enabled": bool(config.TELEGRAM_BOT_TOKEN and config.TELEGRAM_CHAT_ID),
        "ai_enabled": bool(config.GEMINI_API_KEY),
        "disclaimer": config.DISCLAIMER,
    }


@router.get("/session")
def session(x_dashboard_token: str | None = Header(default=None)):
    _auth(x_dashboard_token)
    acc = engine.db.latest_account()
    if not acc:
        return {"connected": False}
    return {"connected": acc["status"] == "connected" and engine.account is not None,
            "platform": acc["platform"], "account_type": acc["account_type"],
            "login": security.mask_account(acc["login"]), "server": acc["server"]}


@router.post("/connect")
def connect(payload: ConnectRequest, x_dashboard_token: str | None = Header(default=None)):
    _auth(x_dashboard_token)
    platform = payload.platform.lower()
    account_type = payload.account_type.lower()
    if platform not in ("expertoption", "mt5"):
        raise HTTPException(400, "unsupported platform")
    if account_type not in ("demo", "real"):
        raise HTTPException(400, "unsupported account type")
    if account_type == "real" and not config.REAL_TRADING_APPROVED:
        raise HTTPException(403, "Real trading is locked until demo testing is approved.")

    password_enc = security.encrypt_secret(payload.password)
    existing = engine.db.latest_account(platform=platform, account_type=account_type)
    start_balance = existing["balance"] if existing and platform == "mt5" and account_type == "demo" else (
        config.DEMO_START_BALANCE if account_type == "demo" else 0)
    acc = engine.db.upsert_account(platform, account_type, payload.login, payload.server,
                            password_enc, start_balance)
    try:
        engine.attach_account(acc, payload.password)
    except Exception as exc:
        engine.db.set_account_status(acc["id"], "error")
        engine.db.add_log("error", "account", f"connect failed: {exc}")
        raise HTTPException(400, str(exc))

    engine.db.add_log("info", "account", f"{platform} {account_type} connected")
    return {"connected": True, "platform": platform, "account_type": account_type,
            "login": security.mask_account(payload.login), "execution_mode": engine.execution_mode,
            "status": engine.status()}


@router.post("/disconnect")
def disconnect(x_dashboard_token: str | None = Header(default=None)):
    _auth(x_dashboard_token)
    engine.stop()
    if engine.account:
        engine.db.set_account_status(engine.account["id"], "disconnected")
    if engine.broker:
        try:
            engine.broker.disconnect()
        except Exception:
            pass
    engine.account = None
    engine.broker = None
    engine.broker_connected = False
    return {"connected": False}


@router.get("/status")
def status(x_dashboard_token: str | None = Header(default=None)):
    _auth(x_dashboard_token)
    return engine.status()


@router.get("/trades")
def trades(limit: int = Query(default=50, ge=1, le=200), x_dashboard_token: str | None = Header(default=None)):
    _auth(x_dashboard_token)
    return {"trades": engine.db.recent_trades(limit=limit)}


@router.get("/logs")
def logs(limit: int = Query(default=80, ge=1, le=300), x_dashboard_token: str | None = Header(default=None)):
    _auth(x_dashboard_token)
    return {"logs": engine.db.recent_logs(limit)}


@router.post("/bot/start")
def bot_start(x_dashboard_token: str | None = Header(default=None)):
    _auth(x_dashboard_token)
    if not engine.account:
        raise HTTPException(400, "connect an account first")
    if engine.emergency:
        raise HTTPException(400, "emergency stop is active; reconnect or reset to continue")
    engine.start()
    return {"running": True, "status": engine.status()}


@router.post("/bot/stop")
def bot_stop(x_dashboard_token: str | None = Header(default=None)):
    _auth(x_dashboard_token)
    engine.stop()
    return {"running": False, "status": engine.status()}


@router.post("/bot/emergency")
def bot_emergency(x_dashboard_token: str | None = Header(default=None)):
    _auth(x_dashboard_token)
    result = engine.emergency_stop(close_positions=True)
    return {**result, "status": engine.status()}


@router.post("/bot/reset-emergency")
def reset_emergency(x_dashboard_token: str | None = Header(default=None)):
    _auth(x_dashboard_token)
    engine.emergency = False
    engine.db.add_log("info", "risk", "Emergency stop cleared by operator")
    return {"emergency": False, "status": engine.status()}


@router.get("/risk")
def get_risk(x_dashboard_token: str | None = Header(default=None)):
    _auth(x_dashboard_token)
    return engine._risk_settings()


@router.post("/risk")
def set_risk(payload: RiskRequest, x_dashboard_token: str | None = Header(default=None)):
    _auth(x_dashboard_token)
    engine.db.set_setting("risk", payload.model_dump())
    engine.db.add_log("info", "risk", "Risk settings updated", payload.model_dump())
    return payload.model_dump()


@router.post("/market/test")
def market_test(x_dashboard_token: str | None = Header(default=None)):
    _auth(x_dashboard_token)
    results = []
    for symbol in config.SYMBOLS:
        try:
            snap = engine.market.get(symbol, "M5", max_age=5)
            results.append({"symbol": symbol, "ok": True, "price": snap.price,
                            "candles": len(snap.candles), "stale": snap.is_stale})
        except Exception as exc:
            results.append({"symbol": symbol, "ok": False, "error": str(exc)[:120]})
    engine.market_connected = any(r["ok"] for r in results)
    return {"connected": engine.market_connected, "results": results}


@router.post("/telegram/test")
def telegram_test(x_dashboard_token: str | None = Header(default=None)):
    _auth(x_dashboard_token)
    if not engine.telegram.enabled:
        raise HTTPException(400, "Telegram is not configured")
    res = engine.telegram.send_message(
        "<b>ROZLF AUTO TRADER</b>\n✅ Telegram connection test successful.")
    if not res.get("ok"):
        raise HTTPException(400, f"Telegram error: {res.get('description')}")
    return {"ok": True}


@router.get("/charts/{filename}")
def chart_file(filename: str, x_dashboard_token: str | None = Header(default=None)):
    _auth(x_dashboard_token)
    if "/" in filename or ".." in filename:
        raise HTTPException(400, "invalid file")
    path = config.CHART_DIR / filename
    if not path.exists():
        raise HTTPException(404, "chart not found")
    return FileResponse(path, media_type="image/png")
