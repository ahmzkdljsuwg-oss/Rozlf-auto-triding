"""The eight checks every instrument must pass before ROZLF shows it as live.

Checks run against a real DataSource: listing, identity, quote, candles, candle
integrity, freshness (live update), connection state, and per-timeframe support.
A failure is reported as a failure — an instrument is never marked connected
because it merely appears in a list.
"""
from __future__ import annotations

import time
from typing import Any, Dict, Iterable, List, Optional

from .base import AssetRecord, Candle, DataSource, SourceError
from .model import timeframe_label

DEFAULT_PROBE_TIMEFRAMES = (60, 300, 900)
FRESH_GRACE_SECONDS = 30


def _detail(exc: Exception) -> str:
    code = getattr(exc, "code", "")
    return f"{code}: {exc}" if code else f"{type(exc).__name__}: {str(exc)[:160]}"


def _check(check_id: str, title: str, ok: bool, detail: str = "", **extra: Any) -> Dict[str, Any]:
    item = {"id": check_id, "title": title, "ok": bool(ok), "detail": detail}
    item.update(extra)
    return item


def candle_problems(candles: List[Candle], period: int, now_ms: Optional[int] = None) -> List[str]:
    """Structural problems in a candle series, in plain words."""
    problems: List[str] = []
    if not candles:
        return ["no candles"]
    now = now_ms if now_ms is not None else int(time.time() * 1000)
    times = [c.time for c in candles]
    if any(t <= 0 for t in times):
        problems.append("candle without a timestamp")
    if any(b <= a for a, b in zip(times, times[1:])):
        problems.append("timestamps are not strictly increasing")
    if len(set(times)) != len(times):
        problems.append("duplicate timestamps")
    if times and times[-1] > now + 60_000:
        problems.append("a candle is in the future")
    for c in candles:
        if min(c.open, c.high, c.low, c.close) <= 0:
            problems.append("non-positive price")
            break
        if c.high < max(c.open, c.close) or c.low > min(c.open, c.close) or c.high < c.low:
            problems.append("OHLC bounds are inconsistent")
            break
    if period > 0 and len(times) > 2:
        step = period * 1000
        gaps = [b - a for a, b in zip(times, times[1:]) if b - a > step * 3]
        if gaps:
            problems.append(f"{len(gaps)} gap(s) larger than 3 periods")
    return problems


def _select_asset(assets: List[AssetRecord], asset: Optional[Dict[str, Any]],
                  asset_id: Optional[Any], symbol: Optional[str]) -> Optional[AssetRecord]:
    if asset is not None:
        return AssetRecord(
            id=asset.get("id"), symbol=str(asset.get("symbol") or ""), name=str(asset.get("name") or ""),
            market=str(asset.get("market") or "other"), active=bool(asset.get("active")),
            active_known=bool(asset.get("active_known", True)), otc=bool(asset.get("otc")),
            payout=asset.get("payout"), timeframes=list(asset.get("timeframes") or []),
            raw_type=asset.get("raw_type"),
        )
    if asset_id is not None:
        for candidate in assets:
            if str(candidate.id) == str(asset_id):
                return candidate
    if symbol:
        key = str(symbol).strip().upper()
        for candidate in assets:
            if candidate.symbol.strip().upper() == key or candidate.name.strip().upper() == key:
                return candidate
    return None


async def verify_instrument(
    source: DataSource,
    *,
    asset: Optional[Dict[str, Any]] = None,
    asset_id: Optional[Any] = None,
    symbol: Optional[str] = None,
    timeframes: Iterable[int] = DEFAULT_PROBE_TIMEFRAMES,
    now_ms: Optional[int] = None,
) -> Dict[str, Any]:
    checks: List[Dict[str, Any]] = []
    status = source.status()

    listed_error = ""
    try:
        assets = await source.assets()
    except Exception as exc:  # noqa: BLE001 - a broken source must not 500 the report
        assets = []
        listed_error = _detail(exc)

    target = _select_asset(assets, asset, asset_id, symbol)
    checks.append(_check(
        "listed", "الأصل يظهر في القائمة", target is not None,
        listed_error or (f"{len(assets)} أصل في قائمة الحساب" if assets else "قائمة الأصول فارغة"),
    ))
    if target is None:
        for check_id, title in (
            ("identity", "الاسم والمعرّف صحيحان"),
            ("quote", "جلب السعر"),
            ("candles", "جلب الشموع"),
            ("integrity", "سلامة بيانات الشموع"),
            ("fresh", "التحديث المباشر"),
            ("timeframes", "الفريمات المطلوبة"),
        ):
            checks.append(_check(check_id, title, False, "الأصل غير موجود في قائمة المصدر"))
        return {
            "requested": {"id": asset_id, "symbol": symbol},
            "asset": None,
            "checks": checks,
            "passed": False,
            "ok": True,
            "verdict": "not_listed",
            "checked_at": int(time.time()),
        }

    identity_ok = bool(target.symbol) and target.id is not None
    checks.append(_check(
        "identity", "الاسم والمعرّف صحيحان", identity_ok,
        f"id={target.id} symbol={target.symbol} name={target.name}",
        asset={"id": target.id, "symbol": target.symbol, "name": target.name,
               "market": target.market, "active": target.active, "payout": target.payout},
    ))

    probe_period = int(next(iter(timeframes), 60))
    supported = []
    try:
        supported = [int(p) for p in await source.timeframes()]
    except Exception as exc:  # noqa: BLE001
        checks.append(_check("timeframes", "الفريمات المطلوبة", False, _detail(exc)))

    quote_ok = False
    try:
        quote = await source.quote(target.id, probe_period)
        quote_ok = quote.price > 0
        checks.append(_check("quote", "جلب السعر", quote_ok,
                             f"{quote.price} @ {quote.time}", price=quote.price, age_ms=quote.age_ms))
    except Exception as exc:  # noqa: BLE001
        checks.append(_check("quote", "جلب السعر", False, _detail(exc)))

    candles: List[Candle] = []
    try:
        candles = await source.candles(target.id, probe_period, 120)
        checks.append(_check("candles", "جلب الشموع", bool(candles), f"{len(candles)} شمعة @ {probe_period}s"))
    except Exception as exc:  # noqa: BLE001
        checks.append(_check("candles", "جلب الشموع", False, _detail(exc)))

    problems = candle_problems(candles, probe_period, now_ms) if candles else ["no candles"]
    checks.append(_check("integrity", "سلامة بيانات الشموع", not problems,
                         "ok" if not problems else "; ".join(problems[:3])))

    fresh_ok = False
    if candles:
        now = now_ms if now_ms is not None else int(time.time() * 1000)
        age_s = (now - candles[-1].time) / 1000.0
        limit = probe_period * 2 + FRESH_GRACE_SECONDS
        fresh_ok = age_s <= limit
        checks.append(_check("fresh", "التحديث المباشر", fresh_ok,
                             f"آخر شمعة قبل {int(age_s)}s (الحد {int(limit)}s)", last_candle_age_s=int(age_s)))
    else:
        checks.append(_check("fresh", "التحديث المباشر", False, "لا توجد شمعة لقياس حداثتها"))

    per_timeframe = []
    for period in [int(p) for p in timeframes]:
        entry = {"period_seconds": period, "label": timeframe_label(period), "ok": False, "detail": ""}
        if supported and period not in supported:
            entry["detail"] = "غير مدعوم من الجلسة"
        else:
            try:
                rows = await source.candles(target.id, period, 30)
                entry["ok"] = bool(rows)
                entry["count"] = len(rows)
                entry["detail"] = "ok" if rows else "لا شموع"
            except Exception as exc:  # noqa: BLE001
                entry["detail"] = _detail(exc)
        per_timeframe.append(entry)
    tf_ok = bool(per_timeframe) and any(e["ok"] for e in per_timeframe)
    checks.append(_check(
        "timeframes", "الفريمات المطلوبة", tf_ok,
        ", ".join(f"{e['label']}:{'ok' if e['ok'] else 'x'}" for e in per_timeframe),
        timeframes=per_timeframe,
    ))

    connected = bool(status.get("connected"))
    checks.append(_check("connection", "حالة الاتصال", connected,
                         "متصل" if connected else "غير متصل — لا يُعرض الأصل كمتصل"))

    critical = ("listed", "identity", "quote", "candles", "integrity", "fresh", "connection")
    by_id = {c["id"]: c for c in checks}
    ok = all(by_id.get(cid, {}).get("ok") for cid in critical) and tf_ok
    return {
        "requested": {"id": asset_id, "symbol": symbol},
        "asset": target.as_dict(),
        "checks": checks,
        "passed": ok,
        "ok": True,
        "verdict": "verified" if ok else "failed",
        "checked_at": int(time.time()),
    }


async def verify_many(source: DataSource, targets: Iterable[Dict[str, Any]],
                      timeframes: Iterable[int] = DEFAULT_PROBE_TIMEFRAMES) -> Dict[str, Any]:
    results = []
    for target in targets:
        results.append(await verify_instrument(
            source,
            asset=target.get("asset"),
            asset_id=target.get("id"),
            symbol=target.get("symbol"),
            timeframes=timeframes,
        ))
    passed = [r for r in results if r.get("passed")]
    return {
        "source": source.name,
        "total": len(results),
        "passed": len(passed),
        "failed": len(results) - len(passed),
        "results": results,
        "updated_at": int(time.time()),
    }
