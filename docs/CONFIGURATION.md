# Configuration

## Environment (`.env`)
See `.env.example`. Only `MASTER_KEY` is mandatory.

## Risk settings (Settings → Risk management, or `PUT /api/risk`)

| Key | Default | Meaning |
|---|---|---|
| `risk_pct_per_trade` | 1.0 | stake = balance × % (capped at 5 %). For Deriv options/multipliers the stake **is** the max loss |
| `fixed_stake` | off | fixed amount instead of % |
| `min_stake` / `max_stake` | 0.35 / 50 | Deriv minimum and absolute cap |
| `max_daily_loss_pct` | 3 | suspends until next UTC day |
| `max_drawdown_pct` | 10 | from peak balance; suspends until you clear it |
| `max_consecutive_losses` | 3 | then `cooldown_minutes` pause (60) |
| `max_open_trades` | 3 | simultaneous contracts (all bots) |
| `max_open_per_symbol` | 1 | |
| `max_trades_per_hour` | 10 | |
| `max_exposure_pct` | 3 | sum of open stakes vs balance |
| `daily_profit_target_pct` | 5 | stop for the day when reached; empty = off |
| `min_balance` | 10 | never trade below this |

Sizing never depends on previous results — martingale/doubling cannot happen.

## Bot settings (Bot Center → Configure)

Operational (applied immediately, versioned): `symbols`, `min_confidence`, `auto_execute`
(semi-auto), `max_stake`, `payout_assumption`, `cooldown_bars`, `allow_uncalibrated_demo`,
Smart AI `min_agree` / `min_ev`.

Strategy parameters, timeframe and contract change **only** through validation
(`POST /api/bots/{id}/validate` with `overrides`) followed by deploy. Every change is a new row in
`bot_configs`; any previously active version can be restored.

Default bots:

| Bot | Market | TF | Contract |
|---|---|---|---|
| trend | R_100 | 5m | Rise/Fall 3m |
| price_action | R_75 | 5m | Rise/Fall 15m |
| scalping | 1HZ100V | 1m | Rise/Fall 3m |
| reversal | R_50 | 5m | Rise/Fall 15m |
| breakout | R_25 | 5m | Rise/Fall 15m |
| volatility | 1HZ75V | 5m | Rise/Fall 10m |
| smart_ai | R_100 | 5m | Rise/Fall 15m |

Example contract override for a multiplier bot:
```json
{"contract": {"family": "multiplier", "multiplier": 50, "sl_pct_of_stake": 50, "tp_pct_of_stake": 80}}
```

## Confidence scores
- **Score (0–100)**: how many of the strategy's confirmations lined up. Not a probability.
- **p(win)**: isotonic calibration of score → observed out-of-sample win rate, shrunk toward the base
  rate when samples are few (≥ 30 needed).
- **EV / stake** = p × payout − (1 − p). Real-account signals need EV > 0. `min_confidence` (default 70)
  is an additional filter on the score.

## Validation pass criteria (walk-forward)
≥ 30 OOS trades, positive OOS expectancy, at least half the folds profitable, OOS max drawdown ≤ 25 %.
