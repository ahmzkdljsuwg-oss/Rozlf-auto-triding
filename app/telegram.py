import html
from datetime import datetime, timezone
from pathlib import Path

import httpx

from . import config


class TelegramNotifier:
    def __init__(self):
        self.token = config.TELEGRAM_BOT_TOKEN
        self.chat_id = config.TELEGRAM_CHAT_ID
        self.enabled = bool(self.token and self.chat_id)
        self.last_error: str | None = None

    @property
    def _base(self):
        return f"https://api.telegram.org/bot{self.token}"

    def _post(self, method: str, **kwargs):
        if not self.enabled:
            return {"ok": False, "description": "telegram not configured"}
        try:
            resp = httpx.post(f"{self._base}/{method}", timeout=25.0, **kwargs)
            data = resp.json()
            if not data.get("ok"):
                self.last_error = data.get("description", "telegram error")
            return data
        except Exception as exc:
            self.last_error = str(exc)[:300]
            return {"ok": False, "description": self.last_error}

    def _send_photo(self, path: str, caption: str):
        p = Path(path)
        if not p.exists():
            return self.send_message(caption)
        with open(p, "rb") as fh:
            return self._post("sendPhoto", data={"chat_id": self.chat_id, "caption": caption[:1000],
                                                 "parse_mode": "HTML"},
                              files={"photo": (p.name, fh, "image/png")})

    def send_message(self, text: str):
        return self._post("sendMessage", data={"chat_id": self.chat_id, "text": text[:4000],
                                               "parse_mode": "HTML", "disable_web_page_preview": "true"})

    def notify_trade_open(self, trade: dict, chart_path: str, ai_note: str = ""):
        side_ar = "شراء" if trade["side"] == "BUY" else "بيع"
        caption = (
            f"<b>🟢 ROZLF AUTO TRADER — {trade['side']}</b>\n"
            f"<b>Pair:</b> {html.escape(trade['symbol'])} | <b>TF:</b> {trade['timeframe']}\n"
            f"<b>Entry:</b> <code>{trade['entry_price']:.5f}</code>\n"
            f"<b>Stop Loss:</b> <code>{trade['stop_loss']:.5f}</code>\n"
            f"<b>Take Profit:</b> <code>{trade['take_profit']:.5f}</code>\n"
            f"<b>Lot:</b> {trade['lot']} | <b>Risk:</b> ${trade['risk_amount']:.2f}\n"
            f"<b>Confidence:</b> {trade['confidence'] * 100:.0f}%\n"
            f"<b>Time:</b> {trade['opened_at']}\n\n"
            f"<b>Reason:</b> {html.escape((trade.get('reason') or 'multi-timeframe confluence')[:300])}\n"
            f"<b>السبب:</b> {side_ar} — تحليل متعدد الأطر مع اتجاه وبنية داعمة"
        )
        if ai_note:
            caption += f"\n<b>AI:</b> {html.escape(ai_note[:200])}"
        self._send_photo(chart_path, caption)

    def notify_trade_closed(self, trade: dict, duration: str, chart_path: str | None = None):
        pnl = float(trade.get("pnl") or 0)
        icon = "✅" if pnl >= 0 else "❌"
        result = "WIN" if pnl >= 0 else "LOSS"
        caption = (
            f"<b>{icon} ROZLF AUTO TRADER — {result}</b>\n"
            f"<b>Pair:</b> {html.escape(trade['symbol'])} | <b>TF:</b> {trade['timeframe']} | <b>Side:</b> {trade['side']}\n"
            f"<b>PnL:</b> <b>{pnl:+.2f} USD</b>\n"
            f"<b>Entry:</b> <code>{trade['entry_price']:.5f}</code> → "
            f"<b>Exit:</b> <code>{float(trade['close_price']):.5f}</code>\n"
            f"<b>Duration:</b> {duration}\n"
            f"<b>Closed:</b> {trade['closed_at']}\n\n"
            f"<b>النتيجة:</b> {'ربح' if pnl >= 0 else 'خسارة'} {abs(pnl):.2f} دولار"
        )
        if chart_path:
            self._send_photo(chart_path, caption)
        else:
            self.send_message(caption)

    def notify_error(self, title: str, detail: str):
        self.send_message(f"<b>⚠️ {html.escape(title)}</b>\n{html.escape(detail[:800])}")


def human_duration(start_iso: str, end_iso: str | None = None) -> str:
    try:
        start = datetime.fromisoformat(start_iso)
        end = datetime.fromisoformat(end_iso) if end_iso else datetime.now(timezone.utc)
        seconds = max(0, int((end - start).total_seconds()))
    except Exception:
        return "n/a"
    hours, rem = divmod(seconds, 3600)
    minutes, secs = divmod(rem, 60)
    if hours:
        return f"{hours}h {minutes}m"
    if minutes:
        return f"{minutes}m {secs}s"
    return f"{secs}s"
