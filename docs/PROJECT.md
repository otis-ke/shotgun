# Multi-Strategy Trading Platform for Deriv accounts

A self-hosted, multi-user trading website. People sign in with **"Log in with Deriv"** (Deriv's
official OAuth), and each user gets their own seven independent bots, real-time analysis,
walk-forward validation, calibrated confidence scores, risk manager and dashboard — all running
on your server and trading through the **official Deriv WebSocket API**. The site carries your
own brand (`BRAND_NAME`); it is an independent app and must not present itself as Deriv. Core intelligence runs locally
(indicators, statistics, price-action algorithms, scikit-learn calibration); no external AI API.

> **Read this first.** No strategy here is known to be profitable. Deriv's synthetic indices are
> generated to be random, and option-style contracts pay less than 1:1, so a strategy must win
> more than `1 / (1 + payout)` of the time (≈ 52.6 % at a 0.90 payout) just to break even. The
> system is built to *find out honestly* whether an edge exists and to stop you trading when it
> doesn't: strategies stay "unvalidated" until they pass out-of-sample walk-forward tests, real
> money needs explicit authorization, and risk limits halt trading automatically.

## What's inside

| Area | Implementation |
|---|---|
| Deriv connection | `backend/deriv/` — async WS client: auth, req_id routing, auto-reconnect + resubscribe, heartbeat, candle feed, proposals, buy/sell, contract tracking, portfolio, profit table, statement |
| Indicators | `backend/indicators/` — EMA, SMA, RSI, MACD, ADX/DI, ATR, Bollinger, Stochastic, CCI, Parabolic SAR, Ichimoku, Donchian, VWAP (only when volume exists — Deriv candles have none) |
| Analysis | `backend/analysis/` — swing structure (HH/HL/LH/LL, BOS), S/R clustering, supply/demand zones, candlestick patterns, RSI/MACD divergence, consolidation, regime classifier |
| Bots 1–6 | `backend/strategies/library.py` — Trend, Price Action, Scalping, Reversal, Breakout, Volatility. Vectorised and **causal**; the same code runs live and in backtests |
| Bot 7 Smart AI | `backend/ai_engine/smart_bot.py` — weighs specialists by calibrated out-of-sample performance and regime record, detects conflicts, refuses low-edge or unvalidated setups |
| Confidence | Raw setup score 0–100 + **calibrated win probability** (isotonic regression on OOS outcomes, Bayesian shrinkage) + EV per unit stake |
| Risk | `backend/risk_management/` — % sizing (no martingale possible), daily loss, drawdown, consecutive-loss cooldown, max open/per-symbol/per-hour, exposure, profit target, balance floor, suspension |
| Execution | `backend/execution/` — proposal → payout check → ledger write → buy → track → settle. Never re-sends a buy; UNKNOWN orders reconciled against Deriv records |
| Coordination | `backend/bots/manager.py` — shared feed & analysis, per-bot configs, conflict/duplicate detection, manual approvals, emergency stop, auto-disable on statistically significant degradation |
| Backtesting | `backend/backtesting/` — next-bar-open entry, Deriv tie rule, touch/higher-lower/multiplier settlement, anchored walk-forward, parameter optimisation, process pool |
| Learning | `backend/ai_engine/optimizer.py` — versioned configs, validation gate, deploy/restore, audit trail |
| Users & login | `backend/auth.py` — Deriv OAuth sign-in (tokens verified with Deriv), demo account by default, account switcher, sign-out everywhere, revoke access, admin role |
| Isolation | `backend/runtime.py` — one isolated runtime per user (own Deriv connection, bots, risk, ledger, calibration); bots keep running 24/7 after the user closes the browser; shared public market-data feed |
| Dashboard | `frontend/` — React + Lightweight Charts: dashboard, bot center, approvals, charts & analysis, backtesting, analytics, history, activity log, settings, admin |
| Tests | `tests/` — 61 tests: unit, causality, backtest correctness, mock-Deriv integration (reconnect, disconnect-during-buy, reconciliation, approvals), multi-user OAuth & isolation |

## Setting up your site

### 1. Register your app with Deriv
At **https://api.deriv.com → Dashboard → Register application**:
- **Redirect URL**: your site's address, e.g. `https://trade.yourdomain.com/` (must be HTTPS in production)
- **Scopes**: Read, Trade, Trading information (not Payments, not Admin)
- Copy the **App ID** into `DERIV_APP_ID`. (Optional: set a markup to earn a commission on users' trades — see Deriv's app terms.)

### 2. Run it (Windows / PowerShell, for development)
Requirements: Python 3.11+ and Node 20+.
```powershell
cd deriv-ai-terminal
python -m venv .venv; .\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
copy .env.example .env
python -m backend.cli genkey          # paste into MASTER_KEY=, then set DERIV_APP_ID, BRAND_NAME, ADMIN_EMAILS
cd frontend; npm install; npm run build; cd ..
uvicorn backend.main:app --host 127.0.0.1 --port 8000
```
Deriv only redirects to the URL you registered, so the real login works on your public domain.
For local UI work without Deriv, run against the mock server (see `docs/TESTING.md`).

### 3. Go live (VPS + Docker + HTTPS)
```bash
cp .env.example .env    # MASTER_KEY, DERIV_APP_ID, BRAND_NAME, ADMIN_EMAILS
docker compose up -d --build
```
Put Caddy/Nginx with TLS in front (`docs/DEPLOYMENT.md`). **Sign in yourself first** — with no
`ADMIN_EMAILS` set, the first user becomes the site admin.

### What users see
1. Your landing page → **Log in with Deriv** → Deriv's own login page → back to your site, signed in.
2. They start on their **demo** account; the top bar switches between their demo/real accounts.
3. Real-money automation needs a typed per-account authorization in Settings.
4. **Settings → Disconnect Deriv & sign out** stops their bots and revokes your site's tokens.

> **Before opening it to the public:** running automated trading for other people can be a
> regulated activity (in Kenya, the Capital Markets Authority licenses investment advisers and
> fund managers). Get local legal advice, publish terms of use and a risk disclosure, and follow
> Deriv's API/app terms. This is not legal advice.

## Recommended workflow

1. **Demo mode** on the demo account (both are the defaults).
2. **Backtesting** page: compare strategies on your markets with the payout your Deriv proposals
   actually show.
3. **Bot Center → Configure & validate → validate**: run a walk-forward on 30–90 days. Passing
   versions become *proposed*; deploy them from **Versions**. Failing versions can't be deployed.
4. Run validated bots on demo for weeks. Watch **Analytics** — the degradation monitor compares
   live results with the validated expectation and auto-disables bots that fall significantly short.
5. Only then: switch to the real account, authorize real trading (typed confirmation, per account),
   and pick Manual or Semi-auto before Full auto.

## Operating modes

| Mode | Behaviour |
|---|---|
| Demo | Full automation, refuses to trade if the connected account is real |
| Manual | Bots generate signals; every trade needs your approval (expires after one candle) |
| Semi-automatic | Bots with *auto-execute* trade within limits; others wait for approval |
| Full auto | All enabled bots trade; risk limits suspend trading when breached |

Uncalibrated (never validated) strategies may trade **only on demo accounts**, so they can collect
data. On real accounts a signal needs calibrated, positive expected value.

## Safety design

- Users never type their Deriv password on your site; OAuth tokens are verified with Deriv, encrypted
  at rest (Fernet, key from `MASTER_KEY`), removed from the address bar and never sent back to the browser.
- Every query is scoped to the signed-in user; another user's signals, trades and bots return 404.
- Signed sessions with "sign out everywhere"; admins can disable users (their bots stop immediately).
- Order ledger is written before every buy; buys are never retried; unresolved orders block all new
  orders until reconciled from Deriv's portfolio/profit table; `contract_id` is a primary key.
- Each bot evaluates each candle once; one signal → at most one order.
- Contracts opened outside the app are adopted as `external` so they count toward exposure.
- Emergency stop (top bar) halts all bots and expires pending approvals.
- Single uvicorn worker by design — one process owns the connection and the ledger.

## Documentation
- `docs/DERIV_API_GUIDE.md` — app registration, OAuth, scopes, symbols, contract types
- `docs/CONFIGURATION.md` — environment, risk settings, bot settings, contracts
- `docs/TESTING.md` — test suite and the mock Deriv server
- `docs/DEPLOYMENT.md` — VPS/Docker, TLS, backups, PostgreSQL, recovery
- `docs/ARCHITECTURE.md` — module map and data flow
