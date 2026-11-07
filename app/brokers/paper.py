import itertools
import random
import threading

from .. import config
from ..market_data import MarketDataService, pip_size
from .base import AccountInfo, BaseBroker, BrokerError, ExecutionResult


class PaperBroker(BaseBroker):
    """Simulated demo broker. Fills are simulated but prices come from live market data."""

    name = "paper"
    supports_execution = True

    def __init__(self, balance: float | None = None, market: MarketDataService | None = None):
        self.market = market or MarketDataService()
        self._balance = float(balance if balance is not None else config.DEMO_START_BALANCE)
        self._initial_balance = self._balance
        self._lock = threading.RLock()
        self._order_ids = itertools.count(100001)
        self._open_orders: dict[str, dict] = {}
        self._connected = False
        self._login = ""

    def connect(self, login: str, password: str, server: str) -> AccountInfo:
        if not login or not password:
            raise BrokerError("login and password are required")
        # Verify live market access before accepting the session.
        self.market.get("EURUSD", "M5", max_age=5)
        self._connected = True
        self._login = login
        return self.account_info()

    def disconnect(self) -> None:
        self._connected = False

    def account_info(self) -> AccountInfo:
        return AccountInfo(login=self._login, server="ROZLF-DEMO", balance=round(self._balance, 2),
                           equity=round(self._balance, 2), broker="ROZLF Paper (Demo)", is_demo=True)

    def set_balance(self, balance: float):
        with self._lock:
            self._balance = float(balance)
            self._initial_balance = float(balance)

    def price(self, symbol: str) -> float:
        return self.market.latest_price(symbol)

    def open_order(self, symbol: str, side: str, lot: float, entry: float,
                   stop_loss: float, take_profit: float, reason: str = "") -> ExecutionResult:
        if side not in ("BUY", "SELL"):
            raise BrokerError("invalid side")
        price = self.price(symbol)
        pip = pip_size(symbol)
        slippage = abs(random.gauss(0.15, 0.35)) * pip
        fill = price + slippage if side == "BUY" else price - slippage
        if abs(fill - entry) / pip > config.MAX_SLIPPAGE_PIPS:
            return ExecutionResult(False, message="rejected: slippage above tolerance")
        with self._lock:
            order_id = f"DM{next(self._order_ids)}"
            self._open_orders[order_id] = {
                "symbol": symbol, "side": side, "lot": lot, "entry": fill,
                "stop_loss": stop_loss, "take_profit": take_profit,
            }
        return ExecutionResult(True, order_id=order_id, fill_price=round(fill, 6), message="filled")

    def close_order(self, order_id: str, price: float) -> ExecutionResult:
        with self._lock:
            order = self._open_orders.pop(order_id, None)
        if not order:
            return ExecutionResult(False, message="order not found")
        return ExecutionResult(True, order_id=order_id, fill_price=round(price, 6), message="closed")

    def realized_pnl(self, symbol: str, side: str, lot: float, entry: float, exit_price: float) -> float:
        diff = (exit_price - entry) if side == "BUY" else (entry - exit_price)
        pips = diff / pip_size(symbol)
        return round(pips * lot * 10.0, 2)

    def apply_pnl(self, pnl: float):
        with self._lock:
            self._balance += pnl
