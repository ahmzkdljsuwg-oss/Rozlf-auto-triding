"""MetaTrader 5 adapter.

The official MetaTrader5 Python package only runs on Windows with a running MT5
terminal. This adapter is therefore inactive on Linux/Render and refuses to
execute unless MT5_ENABLED and REAL_TRADING_APPROVED are both explicitly set.
It is provided for a Windows VPS deployment and has not been executed here.
"""

from .. import config
from .base import AccountInfo, BaseBroker, BrokerError, ExecutionResult


def mt5_available() -> bool:
    try:
        import MetaTrader5  # noqa: F401
        return True
    except Exception:
        return False


class MT5Broker(BaseBroker):
    name = "mt5"
    supports_execution = True

    def __init__(self):
        self._mt5 = None
        self._connected = False
        self._is_demo = True

    def connect(self, login: str, password: str, server: str) -> AccountInfo:
        if not config.MT5_ENABLED:
            raise BrokerError(
                "MT5 integration is disabled. Set MT5_ENABLED=true on a Windows host with MetaTrader 5 installed."
            )
        try:
            import MetaTrader5 as mt5
        except Exception as exc:
            raise BrokerError(
                "The official MetaTrader5 package is unavailable. MT5 requires Windows with the MT5 terminal running."
            ) from exc
        self._mt5 = mt5
        kwargs = {}
        if config.MT5_TERMINAL_PATH:
            kwargs["path"] = config.MT5_TERMINAL_PATH
        if not mt5.initialize(**kwargs):
            raise BrokerError(f"MT5 initialize failed: {mt5.last_error()}")
        if not mt5.login(int(login), password=password, server=server):
            mt5.shutdown()
            raise BrokerError(f"MT5 login failed: {mt5.last_error()}")
        info = mt5.account_info()
        if info is None:
            mt5.shutdown()
            raise BrokerError("MT5 account_info failed")
        self._connected = True
        self._is_demo = info.trade_mode == mt5.ACCOUNT_TRADE_MODE_DEMO
        return AccountInfo(login=str(info.login), server=info.server, balance=info.balance,
                           equity=info.equity, currency=info.currency, leverage=info.leverage,
                           broker="MetaTrader 5", is_demo=self._is_demo)

    def disconnect(self) -> None:
        if self._mt5:
            self._mt5.shutdown()
        self._connected = False

    def account_info(self) -> AccountInfo:
        if not self._mt5 or not self._connected:
            raise BrokerError("MT5 not connected")
        info = self._mt5.account_info()
        if info is None:
            raise BrokerError("MT5 account_info failed")
        return AccountInfo(login=str(info.login), server=info.server, balance=info.balance,
                           equity=info.equity, currency=info.currency, leverage=info.leverage,
                           broker="MetaTrader 5", is_demo=self._is_demo)

    def price(self, symbol: str) -> float:
        if not self._mt5:
            raise BrokerError("MT5 not connected")
        tick = self._mt5.symbol_info_tick(symbol)
        if tick is None:
            raise BrokerError(f"no tick for {symbol}")
        return float(tick.bid)

    def open_order(self, symbol: str, side: str, lot: float, entry: float,
                   stop_loss: float, take_profit: float, reason: str = "") -> ExecutionResult:
        if not config.REAL_TRADING_APPROVED and not self._is_demo:
            return ExecutionResult(False, message="real trading not approved")
        mt5 = self._mt5
        if not mt5 or not self._connected:
            raise BrokerError("MT5 not connected")
        order_type = mt5.ORDER_TYPE_BUY if side == "BUY" else mt5.ORDER_TYPE_SELL
        tick = mt5.symbol_info_tick(symbol)
        price = tick.ask if side == "BUY" else tick.bid
        request = {
            "action": mt5.TRADE_ACTION_DEAL, "symbol": symbol, "volume": float(lot),
            "type": order_type, "price": price, "sl": float(stop_loss), "tp": float(take_profit),
            "deviation": 20, "magic": 20261107, "comment": "ROZLF AUTO TRADER",
            "type_time": mt5.ORDER_TIME_GTC, "type_filling": mt5.ORDER_FILLING_IOC,
        }
        result = mt5.order_send(request)
        if result is None or result.retcode != mt5.TRADE_RETCODE_DONE:
            return ExecutionResult(False, message=f"MT5 rejected: {getattr(result, 'retcode', 'none')}")
        return ExecutionResult(True, order_id=str(result.order), fill_price=float(result.price), message="filled")

    def close_order(self, order_id: str, price: float) -> ExecutionResult:
        return ExecutionResult(False, message="close by position is not implemented in this adapter")
