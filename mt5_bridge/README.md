# ROZLF MT5 Bridge (Windows)

The official MetaTrader 5 Python package only works on Windows with the MT5
terminal installed. This bridge runs beside that terminal and exposes a small
authenticated HTTP API to the Render backend.

## Requirements

- Windows 10/11 or a Windows VPS that stays online
- MetaTrader 5 terminal, logged into a **demo** account
- Python 3.10+
- A public HTTPS endpoint in front of the bridge (Cloudflare Tunnel, Caddy,
  nginx or an HTTPS reverse proxy). Do not expose plain HTTP to the internet.

## Install

```bat
cd mt5_bridge
py -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
```

## Configure

Create the environment variables in the same shell (never commit them):

```bat
set MT5_BRIDGE_TOKEN=<long-random-token>
set MT5_BRIDGE_SECRET=<different-long-random-secret>
set MT5_BRIDGE_MAX_SKEW_SECONDS=300
```

Use the same `MT5_BRIDGE_TOKEN` and `MT5_BRIDGE_SECRET` on Render.
`MT5_BRIDGE_URL` on Render must be the public HTTPS address of this bridge.

## Run

```bat
.venv\Scripts\python -m uvicorn bridge:app --host 127.0.0.1 --port 8787
```

Put the HTTPS reverse proxy in front of `127.0.0.1:8787`. The proxy must pass
the original path and query string unchanged because the HMAC signature covers
them.

## Security model

- Every request needs `X-Bridge-Token`, `X-Bridge-Timestamp` and
  `X-Bridge-Signature`.
- Signature = HMAC-SHA256(secret, `${timestamp}\n${METHOD}\n${path?query}\n${body}`).
- Requests older than five minutes are rejected.
- Only demo accounts are accepted. A real account is refused at connect time
  and before every order.
- The MT5 password is used once to initialize the terminal and is never logged
  or returned.
- The backend records a trade only when this bridge returns `accepted: true`
  with a real ticket and fill price.

## Endpoints

`GET /ping`, `POST /connect`, `POST /disconnect`, `GET /account`,
`GET /positions`, `GET /history?ticket=`, `GET /price?symbol=`,
`POST /order`, `POST /close`.

## Known limits

- The bridge needs a live MT5 terminal session. If the VPS sleeps, reboots or
  loses its broker connection, the backend stops opening trades and shows the
  account as disconnected.
- Opening and closing trades requires the symbol to be visible in Market Watch
  and the account to allow the requested lot size.
