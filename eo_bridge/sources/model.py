"""Asset normalisation, market classification and the catalog search.

Everything here works from the provider's own asset payload. No symbol, id or
price is ever invented: unknown names stay in the ``other`` market instead of
being guessed into a bucket.
"""
from __future__ import annotations

import re
from typing import Any, Dict, Iterable, List, Optional

from .base import AssetRecord

TIMEFRAME_LABELS = {
    5: "S5", 10: "S10", 15: "S15", 30: "S30",
    60: "M1", 120: "M2", 180: "M3", 300: "M5", 600: "M10",
    900: "M15", 1800: "M30",
    3600: "H1", 14400: "H4", 86400: "D1",
}

MARKETS = ("forex", "otc", "smarty", "index", "crypto", "commodity", "stock", "other")

MARKET_LABELS = {
    "forex": {"ar": "فوركس", "en": "Forex"},
    "otc": {"ar": "OTC", "en": "OTC"},
    "smarty": {"ar": "Smart", "en": "Smarty"},
    "index": {"ar": "مؤشرات", "en": "Indices"},
    "crypto": {"ar": "عملات رقمية", "en": "Crypto"},
    "commodity": {"ar": "سلع", "en": "Commodities"},
    "stock": {"ar": "أسهم", "en": "Stocks"},
    "other": {"ar": "أخرى", "en": "Other"},
}

# The instruments the product promises to cover. Matching is done against the
# provider's real list; anything unmatched is reported as not proven available.
WANTED = [
    ("forex", "EUR/USD"), ("forex", "GBP/USD"), ("forex", "USD/JPY"),
    ("forex", "USD/CHF"), ("forex", "AUD/USD"), ("forex", "USD/CAD"),
    ("forex", "NZD/USD"), ("forex", "EUR/JPY"), ("forex", "GBP/JPY"),
    ("forex", "EUR/GBP"),
    ("otc", "EUR/USD OTC"), ("otc", "GBP/USD OTC"), ("otc", "USD/JPY OTC"),
    ("otc", "USD/CHF OTC"),
    ("smarty", "Smarty"),
    ("index", "Cricket Index"), ("index", "Football Index"),
    ("index", "AI Index"), ("index", "Luxury Index"),
]


def truthy(value: Any, default: bool = True) -> bool:
    if value is None:
        return default
    if isinstance(value, str):
        return value.strip().lower() not in {"", "0", "false", "no", "off"}
    if isinstance(value, (int, float)):
        return value != 0
    return bool(value)


def timeframe_label(seconds: Any) -> Optional[str]:
    try:
        value = int(seconds)
    except (TypeError, ValueError):
        return None
    return TIMEFRAME_LABELS.get(value)


def market_of(symbol: str, name: str = "", raw_type: Any = None) -> str:
    """Best-effort market from the provider's own symbol/name text."""
    text = f"{symbol} {name}".upper()
    if "SMRTY" in text or "SMARTY" in text:
        return "smarty"
    if re.search(r"CRICKET|FOOTBALL|AI[ _-]?INDEX|LUXURY|INDEX", text):
        return "index"
    if "OTC" in text:
        return "otc"
    if re.search(r"BTC|ETH|LTC|XRP|DOGE|SOL|ADA|BNB|CRYPTO", text):
        return "crypto"
    if re.search(r"OIL|GOLD|SILVER|XAU|XAG|BRENT|WTI|GAS", text):
        return "commodity"
    if re.search(r"^(AAPL|TSLA|AMZN|MSFT|META|NFLX|GOOGL|NVDA)", text):
        return "stock"
    symbol_key = symbol.upper().replace(" ", "")
    if re.fullmatch(r"[A-Z]{3}[/_]?[A-Z]{3}", symbol_key):
        return "forex"
    if re.search(r"\b[A-Z]{3}/[A-Z]{3}\b", text):
        return "forex"
    return "other"


def normalize_asset(asset: Dict[str, Any], fallback_timeframes: Optional[Iterable[int]] = None) -> AssetRecord:
    symbol = str(asset.get("symbol") or asset.get("asset") or asset.get("name") or "").strip()
    name = str(asset.get("name") or asset.get("title") or symbol).strip()
    asset_id = asset.get("id", asset.get("asset_id", asset.get("instrument_id")))
    raw_active = asset.get("is_active", asset.get("active", asset.get("enabled")))
    timeframes = asset.get("timeframes")
    if not isinstance(timeframes, list) or not timeframes:
        timeframes = list(fallback_timeframes or [])
    payout = asset.get("profit", asset.get("payout"))
    try:
        payout = float(payout) if payout is not None else None
    except (TypeError, ValueError):
        payout = None
    return AssetRecord(
        id=asset_id,
        symbol=symbol,
        name=name,
        market=market_of(symbol, name, asset.get("type") or asset.get("category")),
        active=truthy(raw_active),
        active_known=raw_active is not None,
        otc="OTC" in f"{symbol} {name}".upper(),
        payout=payout,
        timeframes=[int(t) for t in timeframes if str(t).isdigit()],
        raw_type=asset.get("type") or asset.get("category"),
    )


def normalize_assets(assets: Iterable[Dict[str, Any]], fallback_timeframes: Optional[Iterable[int]] = None) -> List[AssetRecord]:
    out: List[AssetRecord] = []
    seen = set()
    for asset in assets or []:
        if not isinstance(asset, dict):
            continue
        record = normalize_asset(asset, fallback_timeframes)
        if not record.symbol or record.id is None:
            continue
        if record.key() in seen:
            continue
        seen.add(record.key())
        out.append(record)
    return out


def canonical(text: str) -> str:
    """Comparison key: letters/digits only, OTC and index suffixes kept apart."""
    return re.sub(r"[^A-Z0-9]", "", str(text).upper())


def _aliases(wanted: str) -> List[str]:
    base = canonical(wanted)
    variants = {base}
    if base.endswith("OTC"):
        variants.add(base[:-3])
    if base.endswith("INDEX"):
        variants.add(base[:-5])
    if "/" in wanted:
        variants.add(canonical(wanted.replace("/", "")))
    # ExpertOption spells pairs with an underscore and a suffix, e.g. EUR_USD_OTC.
    variants.add(base.replace("USD", "USD", 1))
    return [v for v in variants if v]


def match_wanted(assets: List[AssetRecord]) -> List[Dict[str, Any]]:
    """Map every promised instrument onto the provider's real list."""
    results: List[Dict[str, Any]] = []
    for market, wanted in WANTED:
        want_otc = wanted.endswith("OTC")
        hits: List[AssetRecord] = []
        for asset in assets:
            haystack = canonical(f"{asset.symbol} {asset.name}")
            if not any(alias and alias in haystack for alias in _aliases(wanted)):
                continue
            if want_otc and not (asset.otc or "OTC" in haystack):
                continue
            if not want_otc and wanted.upper().startswith(("EUR/USD", "GBP/USD", "USD/", "AUD/", "NZD/", "EUR/JPY", "GBP/JPY", "EUR/GBP")):
                if asset.otc or "OTC" in haystack:
                    continue
            hits.append(asset)
        hits.sort(key=lambda a: (not a.active, a.symbol))
        results.append({
            "requested": wanted,
            "market": market,
            "found": bool(hits),
            "asset": hits[0].as_dict() if hits else None,
            "candidates": [h.as_dict() for h in hits[:5]],
        })
    return results


def search(assets: List[AssetRecord], query: str = "", market: Optional[str] = None,
           only_active: bool = False) -> List[AssetRecord]:
    needle = canonical(query or "")
    chosen = [
        a for a in assets
        if (not market or market == "all" or a.market == market)
        and (not only_active or a.active)
        and (not needle or needle in canonical(f"{a.symbol} {a.name}"))
    ]
    chosen.sort(key=lambda a: (MARKETS.index(a.market) if a.market in MARKETS else 99, a.symbol))
    return chosen


def market_summary(assets: List[AssetRecord]) -> Dict[str, int]:
    counts = {market: 0 for market in MARKETS}
    for asset in assets:
        counts[asset.market if asset.market in counts else "other"] += 1
    return {k: v for k, v in counts.items() if v}
