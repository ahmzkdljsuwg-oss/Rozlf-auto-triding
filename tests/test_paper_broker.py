from app.brokers.paper import PaperBroker


def test_connect_and_account_info(fake_market):
    broker = PaperBroker(balance=10000, market=fake_market)
    info = broker.connect("demo-user", "secret", "ROZLF-DEMO")
    assert info.is_demo is True
    assert info.balance == 10000


def test_order_lifecycle_applies_pnl(fake_market):
    broker = PaperBroker(balance=10000, market=fake_market)
    broker.connect("demo-user", "secret", "ROZLF-DEMO")
    price = broker.price("EURUSD")
    result = broker.open_order("EURUSD", "BUY", 0.10, price, price - 0.0030, price + 0.0060)
    assert result.accepted, result.message
    assert result.order_id.startswith("DM")

    closed = broker.close_order(result.order_id, price + 0.0010)
    assert closed.accepted
    pnl = broker.realized_pnl("EURUSD", "BUY", 0.10, result.fill_price, price + 0.0010)
    broker.apply_pnl(pnl)
    assert pnl > 0
    assert broker.account_info().balance > 10000


def test_order_ids_are_unique(fake_market):
    broker = PaperBroker(balance=10000, market=fake_market)
    broker.connect("demo-user", "secret", "ROZLF-DEMO")
    price = broker.price("EURUSD")
    a = broker.open_order("EURUSD", "BUY", 0.01, price, price - 0.003, price + 0.006)
    b = broker.open_order("GBPUSD", "SELL", 0.01, broker.price("GBPUSD"),
                          broker.price("GBPUSD") + 0.003, broker.price("GBPUSD") - 0.006)
    assert a.order_id != b.order_id
    assert not broker.close_order("DM000000", price).accepted


def test_zero_balance_rejected_by_risk_not_broker(fake_market):
    broker = PaperBroker(balance=0, market=fake_market)
    broker.connect("demo-user", "secret", "ROZLF-DEMO")
    assert broker.account_info().balance == 0
