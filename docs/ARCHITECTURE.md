# Architecture

```
backend/
  config.py            env settings            security.py   encryption, sessions
  database/            SQLAlchemy Core schema (kv, bot_configs, signals, orders, trades, audit_log, equity, candles_cache)
  deriv/               client.py (WS API) · feed.py (candle buffers) · contracts.py (proposal builders)
  indicators/          13 causal indicators
  analysis/            structure, S/R, zones, patterns, divergence, regime
  strategies/          base.py (framework) · library.py (bots 1-6)
  ai_engine/           calibration.py · memory.py (performance memory) · smart_bot.py (bot 7) · optimizer.py (versions, validation)
  risk_management/     global risk manager
  execution/           order ledger, buy, tracking, settlement, reconciliation
  backtesting/         engine.py (backtest, walk-forward) · jobs.py (process pool)
  bots/                manager.py (bot center, coordination, modes, approvals, e-stop)
  monitoring/          event bus -> dashboard, error capture
  api/                 REST + WebSocket routes
  auth.py              Deriv OAuth verification, users, account tokens, sign-out
  runtime.py           Platform: public market feed + one isolated UserRuntime per user; monitor/backups
  main.py              FastAPI app
frontend/src/
  dashboard/ bots/ charts/ analytics/ settings/ history/   pages
  App.jsx components.jsx api.js                          shell, shared UI, API client
tests/ unit/ integration/ backtesting/ mock_deriv.py
```

## Signal → trade
```
Deriv ohlc stream ─► MarketFeed (closed candle) ─► BotManager
   ├─ shared analysis per (symbol, tf, candle): indicators + Snapshot (regime, structure, S/R…)
   ├─ each running bot on that market, once per candle:
   │     specialist: strategy.latest()  → score, reasons
   │     smart_ai:   all specialists → smart_bot.decide() (calibration, regime record, conflicts)
   ├─ gates: min_confidence · calibrated EV > 0 (or demo exploration) · conflict/duplicate check
   ├─ signals table (pending/rejected)
   └─ mode: demo/full → execute · semi → execute if bot.auto_execute · manual → wait for approval
ExecutionEngine (one at a time)
   permission (e-stop, account type, real authorization) → no unresolved orders → RiskManager.check
   → contracts_for → proposal → stake/payout checks → orders row (PENDING) → buy (once)
   → trades row → proposal_open_contract subscription → settlement → memory refresh → events
```

## Multi-user isolation
Every table row carries `user_id`; every query, key/value setting (`u:<id>:<key>`), event-bus
message and risk/ledger check is scoped to it. Each user has a separate Deriv connection
authorized with their own token, so a bug in one user's bot cannot place orders for another.

## Concurrency
One asyncio loop owns the Deriv socket. The reader only routes messages; each subscription has
its own worker task so callbacks (which place orders) can await API calls without deadlocking,
while message order per subscription is preserved. CPU-heavy backtests and validations run in a
separate process pool so they cannot starve heartbeats.
