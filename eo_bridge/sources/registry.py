"""Registry of data sources plus the honest status of the ones not wired in.

Only providers that really serve ExpertOption account data are registered as
usable. Anything else is listed as ``available: false`` with the concrete reason
so the UI can never show it as a live market feed.
"""
from __future__ import annotations

from typing import Any, Dict, List, Optional

from ..manager import Session, registry as session_registry
from .base import DataSource, SourceUnavailable
from .session_source import ExpertOptionSessionSource

# Providers examined in this iteration and why they are (not) used.
PROVIDER_NOTES: List[Dict[str, Any]] = [
    {
        "id": "expertoption-session",
        "repo": "https://github.com/A11ksa/Expert-Option-API",
        "license": "MIT",
        "available": True,
        "role": "primary data transport (vendored, patched for TLS + handshake)",
        "why": "Speaks the account's own WebSocket session and returns assets, "
               "quotes and candles; no public API exists for these.",
    },
    {
        "id": "api-expert-option-2",
        "repo": "https://github.com/A11ksa/API-Expert-Option",
        "license": "MIT",
        "available": False,
        "role": "evaluated, not adopted",
        "why": "Newer async rewrite with its own reconnection monitor, but it also ships "
               "order placement and a Playwright login flow; adopting it would duplicate the "
               "transport ROZLF already runs and add a trade path we must not have.",
    },
    {
        "id": "expertoptionapi-pro",
        "repo": "https://github.com/ChipaDevTeam/ExpertOptionAPI-pro",
        "license": "MIT",
        "available": False,
        "role": "evaluated, not adopted",
        "why": "Targets expertoption.finance endpoints, has no candle history API and no "
               "reconnect handling; last commit 2025-04.",
    },
    {
        "id": "binaryoptionstools-v2",
        "repo": "https://github.com/ChipaDevTeam/BinaryOptionsTools-v2",
        "license": "Custom (personal use only, commercial use restricted)",
        "available": False,
        "role": "evaluated, not adopted",
        "why": "Rust core with PyO3 bindings: needs Python 3.10-3.12 (this service runs 3.13) "
               "and a compiled wheel, and the custom licence forbids commercial use.",
    },
]


def _session_for(token: str, demo: bool) -> Session:
    if not token:
        raise SourceUnavailable(
            "No ExpertOption session for this request: send X-EO-Token",
            code="no_token",
        )
    return session_registry.get(token, demo)


def resolve(name: str, token: str = "", demo: bool = True) -> DataSource:
    key = (name or "expertoption-session").strip().lower()
    if key in {"expertoption-session", "expertoption", "eo", "session"}:
        return ExpertOptionSessionSource(_session_for(token, demo))
    raise SourceUnavailable(f"Unknown data source: {name}", code="unknown_source")


def describe(available_only: bool = False) -> List[Dict[str, Any]]:
    items = []
    for note in PROVIDER_NOTES:
        if available_only and not note["available"]:
            continue
        items.append(dict(note))
    return items


def names() -> List[str]:
    return [n["id"] for n in PROVIDER_NOTES if n["available"]]
