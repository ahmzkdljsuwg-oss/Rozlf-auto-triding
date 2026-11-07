"""ExpertOption adapter.

ExpertOption does not publish an official public trading API. Automated login,
click emulation or undocumented endpoints are not used here. This adapter
therefore validates the saved account data and exposes the platform in
analysis-and-alerts mode only; it never claims to place orders.
"""

from .base import AccountInfo, BaseBroker, BrokerError, ExecutionResult


class ExpertOptionBroker(BaseBroker):
    name = "expertoption"
    supports_execution = False

    def __init__(self):
        self._connected = False
        self._login = ""

    def connect(self, login: str, password: str, server: str) -> AccountInfo:
        if not login or not password:
            raise BrokerError("login and password are required")
        self._connected = True
        self._login = login
        return AccountInfo(login=login, server=server or "ExpertOption", balance=0.0, equity=0.0,
                           broker="ExpertOption (analysis & alerts only)", is_demo=True)

    def disconnect(self) -> None:
        self._connected = False

    def account_info(self) -> AccountInfo:
        if not self._connected:
            raise BrokerError("ExpertOption not connected")
        return AccountInfo(login=self._login, server="ExpertOption", balance=0.0, equity=0.0,
                           broker="ExpertOption (analysis & alerts only)", is_demo=True)

    def open_order(self, symbol: str, side: str, lot: float, entry: float,
                   stop_loss: float, take_profit: float, reason: str = "") -> ExecutionResult:
        return ExecutionResult(
            False,
            message="ExpertOption has no approved public trading API; signals are analysis-only.",
        )
