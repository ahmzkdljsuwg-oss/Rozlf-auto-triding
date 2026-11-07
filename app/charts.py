import time
from datetime import datetime, timezone

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402
import numpy as np  # noqa: E402

from . import config  # noqa: E402
from .indicators import ema  # noqa: E402
from .market_data import Candle  # noqa: E402


def _style(ax):
    ax.set_facecolor("#0e1624")
    ax.grid(color="#22304a", linewidth=0.5, alpha=0.6)
    for spine in ax.spines.values():
        spine.set_color("#2a3a55")


def render_trade_chart(symbol: str, timeframe: str, candles: list[Candle], side: str,
                       entry: float, stop_loss: float, take_profit: float,
                       trade_id: str, timestamp: str | None = None) -> str:
    data = candles[-90:]
    if len(data) < 5:
        raise ValueError("not enough candles to render chart")
    fig, ax = plt.subplots(figsize=(10, 5.6), dpi=130)
    fig.patch.set_facecolor("#0b1220")
    _style(ax)

    for i, c in enumerate(data):
        color = "#22c55e" if c.close >= c.open else "#ef4444"
        ax.plot([i, i], [c.low, c.high], color=color, linewidth=0.9, alpha=0.9)
        body_low, body_high = sorted([c.open, c.close])
        ax.add_patch(plt.Rectangle((i - 0.33, body_low), 0.66, max(body_high - body_low, 1e-9),
                                   facecolor=color, edgecolor=color, alpha=0.85))

    closes = np.array([c.close for c in data])
    if len(closes) >= 20:
        ax.plot(range(len(closes)), ema(closes, 20), color="#38bdf8", linewidth=1.2, label="EMA 20")
        ax.plot(range(len(closes)), ema(closes, 50), color="#a78bfa", linewidth=1.2, label="EMA 50")

    x0, x1 = len(data) - 24, len(data) + 3
    ax.axhline(entry, color="#facc15", linewidth=1.3, linestyle="--", label=f"Entry {entry:.5f}")
    ax.axhline(stop_loss, color="#ef4444", linewidth=1.1, linestyle=":", label=f"SL {stop_loss:.5f}")
    ax.axhline(take_profit, color="#22c55e", linewidth=1.1, linestyle=":", label=f"TP {take_profit:.5f}")
    ax.axvspan(x0, x1, color="#38bdf8" if side == "BUY" else "#ef4444", alpha=0.06)

    ax.set_title(f"{symbol}  {timeframe}  |  {side}", color="#e2e8f0", fontsize=13, loc="left")
    ax.legend(facecolor="#0e1624", edgecolor="#2a3a55", labelcolor="#cbd5e1", fontsize=8, loc="upper left")
    ax.tick_params(colors="#94a3b8", labelsize=8)
    ax.set_xlim(-1, len(data) + 3)
    ts = timestamp or datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    fig.text(0.99, 0.01, f"ROZLF AUTO TRADER | {ts}", color="#64748b", fontsize=7,
             ha="right", va="bottom")
    fig.tight_layout()

    path = config.CHART_DIR / f"trade_{trade_id}_{int(time.time())}.png"
    fig.savefig(path, facecolor=fig.get_facecolor(), bbox_inches="tight")
    plt.close(fig)
    return str(path)


def render_result_chart(symbol: str, timeframe: str, candles: list[Candle], side: str,
                        entry: float, exit_price: float, pnl: float, trade_id: str) -> str:
    data = candles[-90:]
    fig, ax = plt.subplots(figsize=(10, 5.0), dpi=130)
    fig.patch.set_facecolor("#0b1220")
    _style(ax)
    for i, c in enumerate(data):
        color = "#22c55e" if c.close >= c.open else "#ef4444"
        ax.plot([i, i], [c.low, c.high], color=color, linewidth=0.9, alpha=0.85)
        body_low, body_high = sorted([c.open, c.close])
        ax.add_patch(plt.Rectangle((i - 0.33, body_low), 0.66, max(body_high - body_low, 1e-9),
                                   facecolor=color, edgecolor=color, alpha=0.8))
    ax.axhline(entry, color="#facc15", linewidth=1.2, linestyle="--", label=f"Entry {entry:.5f}")
    ax.axhline(exit_price, color="#22c55e" if pnl >= 0 else "#ef4444", linewidth=1.2,
               linestyle=":", label=f"Exit {exit_price:.5f}")
    ax.set_title(f"{symbol}  {timeframe}  |  {'WIN' if pnl >= 0 else 'LOSS'}  {pnl:+.2f} USD",
                 color="#e2e8f0", fontsize=12, loc="left")
    ax.legend(facecolor="#0e1624", edgecolor="#2a3a55", labelcolor="#cbd5e1", fontsize=8, loc="upper left")
    ax.tick_params(colors="#94a3b8", labelsize=8)
    fig.text(0.99, 0.01, "ROZLF AUTO TRADER", color="#64748b", fontsize=7, ha="right", va="bottom")
    fig.tight_layout()
    path = config.CHART_DIR / f"result_{trade_id}_{int(time.time())}.png"
    fig.savefig(path, facecolor=fig.get_facecolor(), bbox_inches="tight")
    plt.close(fig)
    return str(path)
