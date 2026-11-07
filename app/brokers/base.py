from dataclasses import dataclass


class BrokerError(Exception):
    pass


@dataclass
class AccountInfo:
    login: str
    server: str
    balance: float
    equity: float
    currency: str = "USD"
    leverage: int = 100
    broker: str = ""
    is_demo: bool = True


@dataclass
class ExecutionResult:
    accepted: bool
    order_id: str = ""
    fill_price: float = 0.0
    message: str = ""


class BaseBroker:
    name = "base"
    supports_execution = False

    def connect(self, login: str, password: str, server: str) -> AccountInfo:
        raise NotImplementedError

    def disconnect(self) -> None:
        raise NotImplementedError

    def account_info(self) -> AccountInfo:
        raise NotImplementedError

    def price(self, symbol: str) -> float:
        raise NotImplementedError

    def open_order(self, symbol: str, side: str, lot: float, entry: float,
                   stop_loss: float, take_profit: float, reason: str = "") -> ExecutionResult:
        raise NotImplementedError

    def close_order(self, order_id: str, price: float) -> ExecutionResult:
        raise NotImplementedError
