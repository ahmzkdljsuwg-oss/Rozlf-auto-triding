import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def _env(name: str, default: str) -> str:
    value = os.getenv(name)
    return value if value else default


DATA_DIR = Path(_env("DATA_DIR", str(BASE_DIR / "data")))
DATA_DIR.mkdir(parents=True, exist_ok=True)
CHART_DIR = DATA_DIR / "charts"
CHART_DIR.mkdir(parents=True, exist_ok=True)

APP_NAME = "ROZLF AUTO TRADER"
APP_VERSION = "1.0.0"

SECRET_KEY = os.getenv("APP_SECRET_KEY", "")
DATABASE_PATH = Path(_env("DATABASE_PATH", str(DATA_DIR / "rozzlf.db")))

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.0-flash")
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")

DASHBOARD_TOKEN = os.getenv("DASHBOARD_TOKEN", "")

# Real-money execution stays off until the operator explicitly enables it.
REAL_TRADING_APPROVED = os.getenv("REAL_TRADING_APPROVED", "false").lower() == "true"
MT5_ENABLED = os.getenv("MT5_ENABLED", "false").lower() == "true"
MT5_TERMINAL_PATH = os.getenv("MT5_TERMINAL_PATH", "")

SCAN_INTERVAL_SECONDS = int(os.getenv("SCAN_INTERVAL_SECONDS", "60"))
MARKET_DATA_PROVIDER = os.getenv("MARKET_DATA_PROVIDER", "yahoo")

SYMBOLS = [s.strip() for s in os.getenv(
    "SYMBOLS",
    "EURUSD,GBPUSD,USDJPY,AUDUSD,USDCAD,NZDUSD,XAUUSD",
).split(",") if s.strip()]
TIMEFRAMES = [t.strip() for t in os.getenv("TIMEFRAMES", "M5,M15,H1,H4,D1").split(",") if t.strip()]

DEFAULT_RISK_PERCENT = float(os.getenv("DEFAULT_RISK_PERCENT", "0.5"))
DEFAULT_DAILY_LOSS_LIMIT_PERCENT = float(os.getenv("DEFAULT_DAILY_LOSS_LIMIT_PERCENT", "3.0"))
DEFAULT_MAX_OPEN_TRADES = int(os.getenv("DEFAULT_MAX_OPEN_TRADES", "3"))
DEFAULT_MAX_DAILY_TRADES = int(os.getenv("DEFAULT_MAX_DAILY_TRADES", "10"))
DEFAULT_MIN_CONFIDENCE = float(os.getenv("DEFAULT_MIN_CONFIDENCE", "0.62"))
MAX_SPREAD_PIPS = float(os.getenv("MAX_SPREAD_PIPS", "3.0"))
MAX_SLIPPAGE_PIPS = float(os.getenv("MAX_SLIPPAGE_PIPS", "2.0"))
DEMO_START_BALANCE = float(os.getenv("DEMO_START_BALANCE", "10000"))

DISCLAIMER = (
    "Trading involves substantial risk. ROZLF AUTO TRADER does not guarantee profits. "
    "Demo trading is simulated. Real-money execution is disabled until explicitly approved."
)
