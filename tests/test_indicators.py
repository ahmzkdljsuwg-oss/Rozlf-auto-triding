import numpy as np

from app.indicators import ema, rsi, sma, analyze_candles


def test_ema_converges_to_constant():
    values = np.full(60, 5.0)
    out = ema(values, 20)
    assert abs(out[-1] - 5.0) < 1e-9


def test_sma_matches_mean():
    values = np.arange(1, 31, dtype=float)
    out = sma(values, 5)
    assert abs(out[-1] - np.mean(values[-5:])) < 1e-9


def test_rsi_bounds_and_trend():
    up = np.linspace(1, 2, 120)
    down = np.linspace(2, 1, 120)
    assert rsi(up)[-1] > 70
    assert rsi(down)[-1] < 30
    assert 0 <= rsi(up)[-1] <= 100


def test_analyze_candles_shape(fake_market):
    candles = fake_market.get("EURUSD", "M15").candles
    out = analyze_candles(candles)
    for key in ("ema20", "ema50", "rsi", "macd", "atr", "adx", "bb_low", "bb_high"):
        assert key in out
        assert np.isfinite(out[key])
    assert out["bb_low"] <= out["bb_high"]
    assert 0 <= out["rsi"] <= 100
