# Testing

```bash
pip install -r requirements-dev.txt
python -m pytest            # 61 tests, ~40 s
```

| Suite | Covers |
|---|---|
| `tests/unit/test_indicators_strategies.py` | indicator correctness/bounds, **causality of every strategy** (signals identical with or without future bars), regime series, patterns, structure |
| `tests/unit/test_risk_security_contracts.py` | sizing, no-martingale, daily loss, drawdown, consecutive losses, exposure, config validation, encryption, sessions, proposal builders |
| `tests/backtesting/test_backtest.py` | next-bar-open entry, tie = loss, no overlapping positions, stats maths, multiplier SL-first rule, walk-forward uses only OOS trades, random walk shows no edge, calibration, Smart AI conflict handling, version deploy rules |
| `tests/integration/test_deriv_execution.py` | against the mock Deriv server: auth, errors, reconnect + resubscribe, buy & settle, duplicate signal, **disconnect during buy → UNKNOWN → reconciled, never re-bought**, Deriv rejection, real-account gate, emergency stop, payout check, bots placing orders from live candles, callback deadlock regression, manual approval |
| `tests/integration/test_api.py` | Deriv OAuth sign-in, bad tokens, first user = admin, **two users fully isolated** (bots, risk, mode, signals, trades, e-stop), account switching, real-money authorization, sign-out everywhere, market data, backtest, dashboard, WebSocket |

## Mock Deriv server
`tests/mock_deriv.py` reproduces the message shapes of the calls the terminal uses, with
accelerated candles and failure injection (`drop_on_buy`, `reject_buy`). It is test-only.

Run the whole app against it for UI work:
```bash
python -m tests.mock_deriv                  # ws://127.0.0.1:8765, 1 candle / 2 s
DERIV_WS_URL=ws://127.0.0.1:8765 uvicorn backend.main:app --port 8000
```
Mock tokens look like `demo-<name>` / `real-<name>`. Simulate Deriv's redirect by opening
`http://127.0.0.1:8000/?token1=demo-otis&token2=real-otis` (omit acct ids, or use the ones the mock returns).

## Before real money
1. All tests green.
2. Walk-forward validation passed on ≥ 60 days for each bot you enable.
3. ≥ 100 demo trades per bot with results consistent with validation (Analytics → health).
4. Test the emergency stop and pull your network cable during a demo trade — confirm the order
   ends BOUGHT or FAILED in History → Execution orders and nothing was bought twice.
