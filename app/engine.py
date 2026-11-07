import threading
import time
from datetime import datetime, timezone

from . import ai, charts, config
from .brokers import BrokerError, ExpertOptionBroker, MT5Broker, PaperBroker
from .db import Database, db as default_db
from .market_data import MarketDataError, MarketDataService, pip_size
from .risk import RiskManager
from .strategy import build_signal
from .telegram import TelegramNotifier, human_duration


def _utc() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


class TradingEngine:
    def __init__(self, database: Database | None = None, market: MarketDataService | None = None):
        self.db = database or default_db
        self.market = market or MarketDataService()
        self.telegram = TelegramNotifier()
        self.analyzer = ai.GeminiAnalyzer()
        self._lock = threading.RLock()
        self._thread: threading.Thread | None = None
        self._stop_event = threading.Event()

        self.account: dict | None = None
        self.broker = None
        self.execution_mode = "simulated"  # simulated | mt5 | analysis_only
        self.platform = ""
        self.account_type = "demo"
        self.running = False
        self.emergency = False
        self.last_scan_at: str | None = None
        self.last_error: str | None = None
        self.market_connected = False
        self.broker_connected = False
        self.opportunities: list[dict] = []
        self._cooldowns: dict[tuple[str, str, str], float] = {}
        self._scan_count = 0

    # ---------- setup ----------
    def attach_account(self, account: dict, password: str):
        platform = account["platform"]
        account_type = account["account_type"]
        mode = "simulated"

        if platform == "expertoption":
            broker = ExpertOptionBroker()
            mode = "analysis_only"
            info = broker.connect(account["login"], password, account.get("server") or "ExpertOption")
        elif platform == "mt5":
            if account_type == "real":
                if not config.REAL_TRADING_APPROVED:
                    raise BrokerError("Real trading is locked. Complete demo testing and approve it first.")
                broker = MT5Broker()
                mode = "mt5"
                info = broker.connect(account["login"], password, account.get("server") or "")
            else:
                from .brokers.mt5 import mt5_available
                if config.MT5_ENABLED and mt5_available():
                    broker = MT5Broker()
                    mode = "mt5"
                    info = broker.connect(account["login"], password, account.get("server") or "")
                else:
                    broker = PaperBroker(balance=account.get("balance") or config.DEMO_START_BALANCE,
                                         market=self.market)
                    info = broker.connect(account["login"], password, account.get("server") or "")
                    broker.set_balance(account.get("balance") or config.DEMO_START_BALANCE)
                    info = broker.account_info()
        else:
            raise BrokerError("unsupported platform")

        # Commit the session only after the broker accepted it.
        self.platform = platform
        self.account_type = account_type
        self.account = account
        self.broker = broker
        self.execution_mode = mode
        self.emergency = False
        self.broker_connected = True
        self.db.set_account_status(account["id"], "connected", info.balance if platform == "mt5" else 0)
        self.account["balance"] = info.balance
        self.db.add_log("info", "account", f"Connected {self.platform} {self.account_type} ({self.execution_mode})")
        self._load_running_state()

    def _load_running_state(self):
        if not self.account:
            return
        saved = self.db.get_setting(f"running:{self.account['id']}", False)
        # Never auto-resume after a restart without a human action.
        self.running = False
        if saved:
            self.db.set_setting(f"running:{self.account['id']}", False)

    # ---------- lifecycle ----------
    def start(self):
        with self._lock:
            if not self.broker or not self.account:
                raise RuntimeError("connect an account first")
            if self.running:
                return
            self.running = True
            self.emergency = False
            self._stop_event.clear()
            self.db.set_setting(f"running:{self.account['id']}", True)
            self.db.add_log("info", "engine", "Trading engine started")
            self._thread = threading.Thread(target=self._loop, name="rozzlf-engine", daemon=True)
            self._thread.start()

    def stop(self):
        with self._lock:
            self.running = False
            self._stop_event.set()
        if self.account:
            self.db.set_setting(f"running:{self.account['id']}", False)
        self.db.add_log("info", "engine", "Trading engine stopped")

    def emergency_stop(self, close_positions: bool = True) -> dict:
        self.emergency = True
        self.stop()
        closed = []
        if close_positions:
            closed = self.close_all("emergency stop")
        self.db.add_log("warning", "risk", "EMERGENCY STOP activated", {"closed": len(closed)})
        if self.telegram.enabled:
            self.telegram.notify_error("Emergency stop activated",
                                       f"Trading halted. Closed positions: {len(closed)}")
        return {"stopped": True, "closed": closed}

    def close_all(self, reason: str) -> list[dict]:
        closed = []
        for trade in self.db.open_trades(account_id=self.account["id"]):
            try:
                price = self.market.latest_price(trade["symbol"])
            except MarketDataError:
                continue
            closed.append(self._close_trade(trade, price, reason))
        return closed

    # ---------- main loop ----------
    def _loop(self):
        while not self._stop_event.is_set():
            try:
                self._cycle()
            except Exception as exc:
                self.last_error = str(exc)[:300]
                self.db.add_log("error", "engine", f"cycle failed: {exc}")
            self._stop_event.wait(config.SCAN_INTERVAL_SECONDS)

    def _cycle(self):
        if not self.running or self.emergency or not self.account:
            return
        self._process_open_trades()
        self._scan_and_trade()
        self._sync_account()

    # ---------- open position management ----------
    def _process_open_trades(self):
        for trade in self.db.open_trades(account_id=self.account["id"]):
            try:
                price = self.market.latest_price(trade["symbol"])
            except MarketDataError as exc:
                self.last_error = str(exc)[:200]
                continue
            pip = pip_size(trade["symbol"])
            sl, tp = trade["stop_loss"], trade["take_profit"]
            hit = None
            if trade["side"] == "BUY":
                if price <= sl:
                    hit = sl - 0.3 * pip
                elif price >= tp:
                    hit = tp - 0.2 * pip
            else:
                if price >= sl:
                    hit = sl + 0.3 * pip
                elif price <= tp:
                    hit = tp + 0.2 * pip
            if hit is not None:
                self._close_trade(trade, hit, "stop loss" if abs(hit - sl) < abs(hit - tp) else "take profit")

    def _close_trade(self, trade: dict, price: float, reason: str) -> dict:
        if self.execution_mode == "analysis_only":
            return trade
        pnl = self.broker.realized_pnl(trade["symbol"], trade["side"], trade["lot"], trade["entry_price"], price)
        if hasattr(self.broker, "apply_pnl"):
            self.broker.apply_pnl(pnl)
        closed = self.db.close_trade(trade["id"], round(price, 6), pnl, "WIN" if pnl >= 0 else "LOSS")
        self.db.add_log("info", "trade",
                        f"Closed {trade['symbol']} {trade['side']} {pnl:+.2f} USD ({reason})",
                        {"trade_id": trade["id"]})
        chart_path = None
        try:
            snaps = self._load_snaps_for_chart(trade)
            if snaps:
                chart_path = charts.render_result_chart(
                    trade["symbol"], trade["timeframe"], snaps, trade["side"],
                    trade["entry_price"], price, pnl, trade["id"])
        except Exception as exc:
            self.db.add_log("warning", "chart", f"result chart failed: {exc}")
        if self.telegram.enabled:
            self.telegram.notify_trade_closed(closed, human_duration(trade["opened_at"], closed["closed_at"]),
                                              chart_path)
        return closed

    def _load_snaps_for_chart(self, trade: dict):
        try:
            snap = self.market.get(trade["symbol"], trade["timeframe"], max_age=30)
            return snap.candles
        except Exception:
            return None

    def _sync_account(self):
        try:
            info = self.broker.account_info()
            self.db.set_account_status(self.account["id"], "connected", info.balance)
            self.account["balance"] = info.balance
            self.broker_connected = True
        except Exception as exc:
            self.broker_connected = False
            self.last_error = str(exc)[:200]

    # ---------- scanning ----------
    def _load_snaps(self, symbol: str) -> dict:
        snaps = {}
        for tf in ("D1", "H1", "M15", "M5"):
            snaps[tf] = self.market.get(symbol, tf, max_age=45)
            if snaps[tf].is_stale:
                raise MarketDataError(f"stale data for {symbol} {tf}")
        return snaps

    def _scan_and_trade(self):
        signals = []
        fetched = 0
        errors = []
        for symbol in config.SYMBOLS:
            if not self.running or self.emergency:
                return
            try:
                snaps = self._load_snaps(symbol)
                fetched += 1
            except Exception as exc:
                errors.append(f"{symbol}: {exc}")
                self.db.add_log("warning", "data", f"{symbol}: {exc}")
                continue
            try:
                sig = build_signal(symbol, "M15", snaps)
            except Exception as exc:
                self.db.add_log("error", "strategy", f"{symbol}: {exc}")
                continue
            signals.append(sig)
            self._publish_opportunity(sig)
            time.sleep(0.05)

        self.market_connected = fetched > 0
        self.last_error = errors[-1][:200] if (not fetched and errors) else None
        self.last_scan_at = _utc()
        self._scan_count += 1

        candidates = [s for s in signals if s.side in ("BUY", "SELL")]
        candidates.sort(key=lambda s: s.confidence, reverse=True)
        if not candidates:
            return

        # One entry per scan cycle keeps execution deliberate.
        for sig in candidates[:1]:
            self._maybe_execute(sig)

    def _publish_opportunity(self, sig):
        with self._lock:
            self.opportunities = [o for o in self.opportunities if o["symbol"] != sig.symbol]
            self.opportunities.insert(0, {
                "symbol": sig.symbol, "timeframe": sig.timeframe, "side": sig.side,
                "confidence": sig.confidence, "entry": sig.entry, "stop_loss": sig.stop_loss,
                "take_profit": sig.take_profit, "reason": sig.reason_en,
                "reason_ar": sig.reason_ar, "checks": sig.checks, "at": _utc(),
            })
            self.opportunities = self.opportunities[:7]

    def _maybe_execute(self, sig):
        if self.execution_mode == "analysis_only":
            self._send_analysis_alert(sig)
            return

        account = self.db.get_account(self.account["id"]) or self.account
        balance = float(account.get("balance") or 0)
        open_trades = self.db.open_trades(account_id=self.account["id"])
        today = self.db.trades_today(self.account["id"])
        closed_today = self.db.closed_today(self.account["id"])
        today_pnl = sum(float(t.get("pnl") or 0) for t in closed_today)

        snap = self.market.get(sig.symbol, "M5", max_age=30)
        spread = self.market.spread_pips(sig.symbol, sig.atr)
        risk = RiskManager(self._risk_settings())
        decision = risk.evaluate(
            sig, balance, balance, open_trades, today, today_pnl, spread,
            data_fresh=not snap.is_stale, connected=self.market_connected and self.broker_connected,
            emergency_stop=self.emergency, running=self.running,
        )
        if not decision.allowed:
            if "duplicate" not in decision.reason and "max open" not in decision.reason:
                self.db.add_log("info", "risk", f"{sig.symbol} skipped: {decision.reason}")
            return

        if self._on_cooldown(sig):
            self.db.add_log("info", "risk", f"{sig.symbol} skipped: cooldown")
            return

        ai_result = self._ai_review(sig)
        if ai_result.get("verdict") == "NO_TRADE" and ai_result.get("confidence", 0) >= 0.6:
            self.db.add_log("info", "ai", f"{sig.symbol} vetoed by Gemini: {ai_result.get('rationale')}")
            return
        if ai_result.get("verdict") in ("BUY", "SELL") and ai_result["verdict"] != sig.side \
                and ai_result.get("confidence", 0) >= 0.65:
            self.db.add_log("info", "ai", f"{sig.symbol} skipped: Gemini disagrees")
            return

        try:
            result = self.broker.open_order(
                sig.symbol, sig.side, decision.lot, sig.entry, sig.stop_loss, sig.take_profit,
                sig.reason_en,
            )
        except Exception as exc:
            self.db.add_log("error", "broker", f"order failed {sig.symbol}: {exc}")
            return
        if not result.accepted:
            self.db.add_log("warning", "broker", f"broker rejected {sig.symbol}: {result.message}")
            return

        shift = result.fill_price - sig.entry
        trade = self.db.create_trade(
            account_id=self.account["id"], platform=self.platform, symbol=sig.symbol,
            timeframe=sig.timeframe, side=sig.side, entry_price=result.fill_price,
            stop_loss=round(sig.stop_loss + shift, 6), take_profit=round(sig.take_profit + shift, 6),
            lot=decision.lot, risk_amount=decision.risk_amount, confidence=sig.confidence,
            reason=sig.reason_en, broker_order_id=result.order_id,
        )
        self._cooldowns[(sig.symbol, sig.timeframe, sig.side)] = time.time()

        chart_path = ""
        try:
            chart_path = charts.render_trade_chart(
                sig.symbol, sig.timeframe, snap.candles, sig.side, result.fill_price,
                trade["stop_loss"], trade["take_profit"], trade["id"])
            self.db.update_trade_chart(trade["id"], chart_path)
        except Exception as exc:
            self.db.add_log("warning", "chart", f"chart failed: {exc}")

        ai_note = ai_result.get("rationale", "") if ai_result.get("enabled") else ""
        if self.telegram.enabled:
            self.telegram.notify_trade_open(trade, chart_path, ai_note)
        self.db.add_log("info", "trade",
                        f"Opened {sig.symbol} {sig.side} {decision.lot} lot @ {result.fill_price:.5f}",
                        {"confidence": sig.confidence, "ai": ai_result.get("verdict")})

    def _send_analysis_alert(self, sig):
        key = (sig.symbol, sig.timeframe, sig.side)
        if time.time() - self._cooldowns.get(key, 0) < 900:
            return
        self._cooldowns[key] = time.time()
        self.db.add_log("info", "signal", f"Analysis alert {sig.symbol} {sig.side} {sig.confidence:.2f}")
        if not self.telegram.enabled:
            return
        try:
            snap = self.market.get(sig.symbol, sig.timeframe, max_age=30)
            path = charts.render_trade_chart(
                sig.symbol, sig.timeframe, snap.candles, sig.side, sig.entry,
                sig.stop_loss, sig.take_profit, f"alert{sig.symbol}")
            self.telegram.send_message(
                f"<b>📊 ExpertOption analysis only — {sig.side}</b>\n"
                f"{sig.symbol} {sig.timeframe} | confidence {sig.confidence * 100:.0f}%\n"
                f"Entry <code>{sig.entry:.5f}</code> SL <code>{sig.stop_loss:.5f}</code> "
                f"TP <code>{sig.take_profit:.5f}</code>\n"
                f"No order was placed (no approved API).")
            self.telegram._send_photo(path, f"{sig.symbol} {sig.timeframe} {sig.side} setup")
        except Exception as exc:
            self.db.add_log("warning", "telegram", f"alert failed: {exc}")

    def _ai_review(self, sig) -> dict:
        context = {
            "checks": sig.checks,
            "indicators": sig.analysis.get("indicators", {}),
            "structure": {k: v.get("structure", {}) for k, v in sig.analysis.get("structure", {}).items()},
        }
        result = self.analyzer.review(sig, context)
        if result.get("enabled"):
            self.db.add_log("info", "ai", f"{sig.symbol} Gemini {result['verdict']} ({result['confidence']:.2f})")
        return result

    def _on_cooldown(self, sig) -> bool:
        key = (sig.symbol, sig.timeframe, sig.side)
        return (time.time() - self._cooldowns.get(key, 0)) < 900

    def _risk_settings(self) -> dict:
        return self.db.get_setting("risk", {
            "risk_percent": config.DEFAULT_RISK_PERCENT,
            "daily_loss_limit_percent": config.DEFAULT_DAILY_LOSS_LIMIT_PERCENT,
            "max_open_trades": config.DEFAULT_MAX_OPEN_TRADES,
            "max_daily_trades": config.DEFAULT_MAX_DAILY_TRADES,
            "min_confidence": config.DEFAULT_MIN_CONFIDENCE,
            "max_spread_pips": config.MAX_SPREAD_PIPS,
        })

    # ---------- status ----------
    def status(self) -> dict:
        with self._lock:
            account = self.db.get_account(self.account["id"]) if self.account else None
            open_trades = self.db.open_trades(account_id=self.account["id"]) if self.account else []
            today = self.db.trades_today(self.account["id"]) if self.account else []
            closed_today = self.db.closed_today(self.account["id"]) if self.account else []
            today_pnl = sum(float(t.get("pnl") or 0) for t in closed_today)
            risk = self._risk_settings() if self.account else {}
            return {
                "platform": self.platform,
                "account_type": self.account_type,
                "execution_mode": self.execution_mode,
                "account_login": account["login"] if account else "",
                "balance": float(account["balance"]) if account else 0,
                "currency": account["currency"] if account else "USD",
                "broker_connected": self.broker_connected,
                "market_connected": self.market_connected,
                "running": self.running,
                "emergency": self.emergency,
                "scanning": self.running and not self.emergency,
                "last_scan_at": self.last_scan_at,
                "scan_count": self._scan_count,
                "last_error": self.last_error,
                "open_trades": open_trades,
                "today_trades": len(today),
                "today_pnl": round(today_pnl, 2),
                "opportunities": self.opportunities,
                "risk": risk,
                "daily_loss_limit": round(float(account["balance"]) * risk.get("daily_loss_limit_percent", 3) / 100, 2)
                if account else 0,
                "telegram_enabled": self.telegram.enabled,
                "ai_enabled": self.analyzer.enabled,
                "real_trading_approved": config.REAL_TRADING_APPROVED,
            }
