from app.risk import RiskManager
from app.strategy import Signal


def make_signal(side="BUY", confidence=0.8):
    return Signal(
        symbol="EURUSD", timeframe="M15", side=side, confidence=confidence,
        entry=1.1000, stop_loss=1.0970, take_profit=1.1060, atr=0.0010,
        reason_en="test", reason_ar="اختبار",
    )


def evaluate(manager, **over):
    kwargs = dict(
        signal=make_signal(), balance=10000, equity=10000, open_trades=[], today_trades=[],
        today_pnl=0.0, spread_pips=1.0, data_fresh=True, connected=True,
        emergency_stop=False, running=True,
    )
    kwargs.update(over)
    return manager.evaluate(**kwargs)


def test_valid_trade_is_allowed_and_sized():
    d = evaluate(RiskManager({"risk_percent": 0.5}))
    assert d.allowed, d.reason
    assert d.lot >= 0.01
    assert d.risk_amount <= 10000 * 0.005 + 1e-6
    assert d.rr >= 1.4


def test_daily_loss_limit_blocks():
    d = evaluate(RiskManager({"daily_loss_limit_percent": 3.0}), today_pnl=-400)
    assert not d.allowed
    assert "loss limit" in d.reason


def test_duplicate_symbol_blocks():
    d = evaluate(RiskManager(), open_trades=[{"symbol": "EURUSD"}])
    assert not d.allowed
    assert "duplicate" in d.reason


def test_low_confidence_blocks():
    d = evaluate(RiskManager({"min_confidence": 0.7}), signal=make_signal(confidence=0.4))
    assert not d.allowed
    assert "confidence" in d.reason


def test_wide_spread_blocks():
    d = evaluate(RiskManager({"max_spread_pips": 2.0}), spread_pips=4.0)
    assert not d.allowed
    assert "spread" in d.reason


def test_disconnected_or_stale_blocks():
    assert not evaluate(RiskManager(), connected=False).allowed
    assert not evaluate(RiskManager(), data_fresh=False).allowed


def test_emergency_and_stopped_block():
    assert not evaluate(RiskManager(), emergency_stop=True).allowed
    assert not evaluate(RiskManager(), running=False).allowed


def test_no_trade_signal_blocks():
    d = evaluate(RiskManager(), signal=make_signal(side="NO TRADE"))
    assert not d.allowed


def test_max_daily_trades_blocks():
    d = evaluate(RiskManager({"max_daily_trades": 2}), today_trades=[{}, {}])
    assert not d.allowed
    assert "daily trades" in d.reason
