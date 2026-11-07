# Vendored `ExpertOptionsToolsV2` (MIT, https://github.com/A11ksa/Expert-Option-API)

Source: commit `fd1dfd5` (package version 2.0.0). The package is not published on
the PyPI index used by this project, so it is vendored here with the MIT licence
(`LICENSE`) and the following minimal patches. Everything else is untouched.

| # | Patch | Reason |
|---|-------|--------|
| 1 | `ssl.create_default_context()` instead of `CERT_NONE` | ROZLF requires verified TLS; the upstream client disabled certificate checks. |
| 2 | `websockets` header keyword chosen from the installed version (`additional_headers` / `extra_headers`) | Upstream pinned `extra_headers`, removed in `websockets>=14`. |
| 3 | `self.url = url` before building `WebSocketClient` | Upstream read `self.url` before assigning it (AttributeError). |
| 4 | `pandas` import made optional; candle-cache merge rewritten in pure Python with epoch-second timestamps | `get_candles(as_dataframe=False)` then needs no pandas and stays JSON serialisable. |
| 5 | `buy()` / `sell()` replaced by `TradingDisabledError` | ROZLF is read-only by design: no order can be sent even by mistake. |

`Logger` is left at DEBUG level by the library, but the bridge sets the
`ExpertOption`/`websockets` loggers to WARNING, so raw frames (which contain the
session token) are never written to logs.
