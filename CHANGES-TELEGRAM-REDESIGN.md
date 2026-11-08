# ROZLF Telegram pairing + light redesign

## What changed
- Reworked the existing light UI into a cleaner, Rasad AI-inspired trading workspace: off-white background, blue primary actions, teal/red signal states, refined cards, mobile-first layout, and a persistent bottom navigation.
- Removed the dashboard-token prompt from the main UI and removed `DASHBOARD_TOKEN` from the Render blueprint.
- Added owner access through a signed, HttpOnly, SameSite=Strict cookie issued only after a one-time Telegram pairing flow.
- Added `/connect` and `/start connect` to the authorized Telegram bot. It creates a random 256-bit one-time code, stores only its SHA-256 hash, expires it after five minutes, invalidates any previous link for the same owner chat, and sends a secure link.
- The one-time code is placed in the URL fragment, so it is not sent in the HTTP request URL or normal server access logs.
- Added `telegram-connect.html`; the user enters the ExpertOption Session Token there over HTTPS. The token is never sent as a Telegram chat message.
- The backend encrypts the token with `APP_SECRET_KEY`, verifies it through the ExpertOption bridge, and only then issues the browser session cookie.
- Hid the MT5 entry from the Telegram main menu and kept ExpertOption in read-only / analysis-only mode.
- Added `PUBLIC_APP_URL` and optional `TELEGRAM_BOT_USERNAME` configuration.

## Required Render settings
- Keep the existing `APP_SECRET_KEY` unchanged; it encrypts saved ExpertOption sessions and signs the owner cookie.
- Keep `DATABASE_URL` configured so one-time pairing codes and encrypted sessions survive restarts.
- Ensure `TELEGRAM_BOT_TOKEN` and `TELEGRAM_CHAT_ID` are correct; the bot only accepts the configured owner chat.
- Set `PUBLIC_APP_URL` to the exact public ROZLF Render URL.
- `ALLOW_INSECURE_DASHBOARD=false` must remain false in production.
- `DASHBOARD_TOKEN` is no longer used by the Node dashboard API; remove it from Render if present.

## Validation performed
- Node syntax checks passed for the modified server, security, Telegram bot, and browser JavaScript files.
- Focused Node tests passed: 21 tests covering signed owner cookies, session token normalization, Telegram `/connect` link issuance, bot polling, callbacks, and read-only ExpertOption behavior.
- Python suite: 44 passed (6 existing deprecation/runtime warnings).
- Full `npm test` could not be completed in this environment because npm dependency installation did not finish; Express and better-sqlite3 were unavailable here.
- No live Telegram account, valid ExpertOption token, or Render deployment was available for end-to-end verification. Live connection still needs to be tested after deployment.
