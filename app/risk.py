import math
from dataclasses import dataclass

from . import config
from .market_data import pip_size, pip_value_per_lot
from .strategy import Signal


@dataclass
class RiskDecision:
    allowed: bool
    reason: str = ""
    lot: float = 0.0
    risk_amount: float = 0.0
    risk_percent: float = 0.0
    stop_pips: float = 0.0
    rr: float = 0.0


class RiskManager:
    def __init__(self, settings: dict | None = None):
        s = settings or {}
        self.risk_percent = float(s.get("risk_percent", config.DEFAULT_RISK_PERCENT))
        self.daily_loss_limit_percent = float(
            s.get("daily_loss_limit_percent", config.DEFAULT_DAILY_LOSS_LIMIT_PERCENT))
        self.max_open_trades = int(s.get("max_open_trades", config.DEFAULT_MAX_OPEN_TRADES))
        self.max_daily_trades = int(s.get("max_daily_trades", config.DEFAULT_MAX_DAILY_TRADES))
        self.min_confidence = float(s.get("min_confidence", config.DEFAULT_MIN_CONFIDENCE))
        self.max_spread_pips = float(s.get("max_spread_pips", config.MAX_SPREAD_PIPS))

    def position_size(self, balance: float, stop_pips: float, symbol: str) -> tuple[float, float]:
        if balance <= 0 or stop_pips <= 0:
            return 0.0, 0.0
        risk_amount = balance * (self.risk_percent / 100.0)
        per_lot = stop_pips * pip_value_per_lot(symbol)
        lot = risk_amount / per_lot if per_lot > 0 else 0.0
        lot = max(0.01, math.floor(lot * 100) / 100)
        lot = min(lot, 5.0)
        actual_risk = lot * per_lot
        return lot, actual_risk

    def evaluate(
        self,
        signal: Signal,
        balance: float,
        equity: float,
        open_trades: list[dict],
        today_trades: list[dict],
        today_pnl: float,
        spread_pips: float,
        data_fresh: bool,
        connected: bool,
        emergency_stop: bool,
        running: bool,
    ) -> RiskDecision:
        if signal.side not in ("BUY", "SELL"):
            return RiskDecision(False, "no trade signal")
        if emergency_stop:
            return RiskDecision(False, "emergency stop active")
        if not running:
            return RiskDecision(False, "trading engine is stopped")
        if not connected or not data_fresh:
            return RiskDecision(False, "market data stale or disconnected")
        if balance <= 0:
            return RiskDecision(False, "account balance unavailable")
        if signal.confidence < self.min_confidence:
            return RiskDecision(False, f"confidence {signal.confidence:.2f} below {self.min_confidence:.2f}")
        if spread_pips > self.max_spread_pips:
            return RiskDecision(False, f"spread {spread_pips:.2f} pips exceeds limit")

        if len(open_trades) >= self.max_open_trades:
            return RiskDecision(False, "max open trades reached")
        if any(t["symbol"] == signal.symbol for t in open_trades):
            return RiskDecision(False, "duplicate position on symbol")
        if len(today_trades) >= self.max_daily_trades:
            return RiskDecision(False, "max daily trades reached")

        loss_limit = balance * (self.daily_loss_limit_percent / 100.0)
        if today_pnl <= -loss_limit:
            return RiskDecision(False, f"daily loss limit reached ({today_pnl:.2f})")

        remaining_risk_budget = loss_limit + min(today_pnl, 0)
        if remaining_risk_budget <= 0:
            return RiskDecision(False, "daily risk budget exhausted")

        stop_pips = abs(signal.entry - signal.stop_loss) / pip_size(signal.symbol)
        if stop_pips < 2:
            return RiskDecision(False, "stop loss too tight")
        lot, risk_amount = self.position_size(balance, stop_pips, signal.symbol)
        if lot <= 0:
            return RiskDecision(False, "position size invalid")
        if risk_amount > remaining_risk_budget:
            scale = remaining_risk_budget / risk_amount
            lot = max(0.01, math.floor(lot * scale * 100) / 100)
            risk_amount = lot * stop_pips * pip_value_per_lot(signal.symbol)
        if risk_amount > remaining_risk_budget:
            return RiskDecision(False, "risk exceeds remaining daily budget")

        rr = abs(signal.take_profit - signal.entry) / abs(signal.entry - signal.stop_loss)
        if rr < 1.4:
            return RiskDecision(False, f"risk/reward {rr:.2f} below 1.4")

        return RiskDecision(
            True, "ok", lot=lot, risk_amount=round(risk_amount, 2),
            risk_percent=round(risk_amount / balance * 100, 2),
            stop_pips=round(stop_pips, 2), rr=round(rr, 2),
        )
