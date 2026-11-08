# ExpertOption bridge (read-only)

`eo_bridge/` is a small Python service that reads the **connected ExpertOption account's own**
asset list, quotes and candles and exposes them to the ROZLF backend over HTTP.
It is a data reader: every order function in the vendored client is replaced with a
stub that raises `TradingDisabledError`, and `ENABLE_REAL_TRADING` / `REAL_TRADING_APPROVED`
stay `false`. No order is ever placed.

## Runtime arrangement

ROZLF's backend is Node; the client library that talks to the ExpertOption WebSocket is Python.
The current deployment starts `eo_bridge/standalone.py` as a supervised local child process from
`src/local-bridge.js`, on `127.0.0.1:8011`. No second Render service is required. If an external
`EXPERTOPTION_BRIDGE_URL` is configured, the backend checks it and falls back to the local bridge
when it is unreachable.

## Upstream library and its licence

- Upstream: <https://github.com/A11ksa/Expert-Option-API> (package `ExpertOptionsToolsV2`, v2.0.0).
- Pinned commit: `fd1dfd5`. Not published on PyPI, so the source is vendored under
  `eo_bridge/vendor/ExpertOptionsToolsV2` (MIT licence, `eo_bridge/vendor/LICENSE`).
- Every change applied to the vendored copy is listed in `eo_bridge/vendor/PATCHES.md`.
  The most important ones: TLS certificate verification restored (the upstream client disabled it),
  pandas made optional, and `buy()` / `sell()` turned into stubs that raise.

### Terms-of-service caveat

ExpertOption's Terms & Conditions (clause 6.2) prohibit automated players (bots) and any
intervention in the client–server relationship. Using this bridge for automatic trading would
breach that clause. ROZLF therefore uses it **only** to read market data and to produce analysis
for the account owner, never to place orders. Availability and continuity of the connection are
not guaranteed by ExpertOption.

## The token

The ExpertOption session token is entered by the account owner (login form → `session_token`),
stored encrypted by `src/security.js`, and sent from the backend to the bridge only in the
`X-EO-Token` request header. It is never written to the frontend, to logs, or to Telegram.
The bridge keeps it in memory, keyed by a hash, and drops it when the session is removed or the
service restarts.

## API (all requests need `Authorization: Bearer <EO_BRIDGE_API_KEY>`)

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | liveness (no auth) |
| GET | `/session` | connect/verify the token and return the account record |
| GET | `/account` | balance / equity / margins from the live session |
| GET | `/instruments` | active asset list of the account (id, name, otc, active, payout, timeframes) |
| GET | `/candles?instrument_id=&timeframe=&limit=` | historical + current candles |
| GET | `/quote?instrument_id=&timeframe=&stream=1` | latest price (subscribes if asked) |
| GET | `/instrument/{id}/expiries?timeframe=` | durations the asset actually offers |
| DELETE | `/session` | forget the token |

The browser never talks to the bridge directly: the Node backend proxies
`GET /api/expertoption/quote` and `POST /api/expertoption/auto-analysis`.

## Asset and duration matching

The ids 240 / 276 / 278 / 285 / 286 / 179 / 180 / 181 / 182 are **hints only**. Each analysis
resolves the requested asset against the live instrument list returned by the account (by name,
then by id) and refuses with `asset_not_found` or `asset_inactive` otherwise. The candle
timeframe is picked from the timeframes the asset publishes, and the requested duration is
checked against `/instrument/{id}/expiries`; a duration the asset does not offer returns
`expiry_unsupported` instead of an invented signal.

## Deploying on Render

1. Deploy the single ROZLF Node service from the repository root.
2. Ensure the repository includes `eo_bridge/` and the runtime has Python 3 available.
3. Leave `EXPERTOPTION_BRIDGE_URL` empty to use the local bridge.
4. Set `APP_SECRET_KEY`, `DATABASE_URL`, `PUBLIC_APP_URL`, and `EXPERTOPTION_RESTORE_SESSION=true`.
5. Set `EXPERTOPTION_ALLOW_REAL_READ=true` only if read-only access to a real account is required.
6. In the authorized Telegram chat, send `/connect`, open the one-time HTTPS link, and enter the fresh ExpertOption Session Token there. The token is never sent as a Telegram message.

### Operational limits

- Render's free plan sleeps a service after ~15 minutes without traffic and does not guarantee
  24/7 uptime. The single backend service and its local bridge must be awake for live analysis.
- A free instance is single, small and restarts on every deploy: the bridge's in-memory session
  is lost and the token must be entered again (or provided through the env var).
- A dropped WebSocket is reconnected with backoff; while it is down, analysis returns
  `NO TRADE` with a clear reason and never a stale price.
- The ExpertOption WebSocket is region-gated (`EO_BRIDGE_REGION`, default `EUROPE`).

## Verified locally

Tested in this workspace: bridge unit tests (11 passing, stand-in client), backend unit tests
(47 passing), and a full backend↔bridge run against a stand-in bridge: session verify, account
sync, asset listing with live ids, per-expiry analysis for 30s/1m/2m/3m/5m, live quote endpoint,
`expiry_unsupported` blocking, and `asset_inactive` blocking.

Not tested here: a real ExpertOption account session (requires a valid account token and a
region that allows the connection), live Mistral review, live Telegram delivery, and the Render
deployment itself.
