"""Event-driven backtester for Deriv contract families.

Execution assumptions (deliberately conservative, no look-ahead):
* signal computed on CLOSED bar i, contract bought at bar i+1 OPEN (≈ first tick after purchase)
* Rise/Fall: exit spot = close of bar i+N. Equal exit counts as a LOSS (Deriv rule for CALL/PUT)
* Touch/No-touch: barrier hit tested on bars i+1..i+N highs/lows
* Multipliers: intrabar stop-loss is assumed to fill BEFORE take-profit when both are touched
* payout_ratio = net profit per unit stake on a win. Live trading uses the real proposal payout.
* One open position at a time per strategy run, optional cooldown after each trade.
"""
from __future__ import annotations

import itertools
import math
import random
from dataclasses import asdict, dataclass, field

import numpy as np
import pandas as pd

from .. import indicators as ind
from ..strategies.base import Strategy


@dataclass
class BTConfig:
    family: str = "rise_fall"          # rise_fall | touch | no_touch | higher_lower | multiplier
    duration_bars: int = 5
    payout_ratio: float = 0.90         # net profit / stake on win (options)
    barrier_atr_mult: float = 1.0      # touch / higher-lower barrier distance in ATRs
    multiplier: int = 50
    sl_pct: float = 50.0               # multiplier SL/TP as % of stake
    tp_pct: float = 50.0
    min_score: float = 0.0
    cooldown_bars: int = 0
    initial_balance: float = 1000.0
    risk_pct: float = 1.0              # stake = balance * risk_pct% (max loss of an option = stake)
    fixed_stake: float | None = None
    commission_pct: float = 0.0        # multipliers: Deriv commission as % of notional

    @classmethod
    def from_dict(cls, d: dict | None) -> "BTConfig":
        d = d or {}
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


@dataclass
class BTTrade:
    i: int
    epoch: int
    direction: int
    score: float
    entry: float
    exit: float
    stake: float
    profit: float
    won: bool
    balance: float


@dataclass
class BTResult:
    trades: list[BTTrade] = field(default_factory=list)
    stats: dict = field(default_factory=dict)
    equity: list[tuple[int, float]] = field(default_factory=list)

    def to_dict(self, max_trades: int = 500) -> dict:
        return {"stats": self.stats, "trades": [asdict(t) for t in self.trades[-max_trades:]],
                "equity": self.equity[-2000:]}


def _settle(cfg: BTConfig, d: int, o: np.ndarray, h: np.ndarray, l: np.ndarray, c: np.ndarray,
            j: int, end: int, atr_v: float, stake: float) -> tuple[float, float, bool]:
    entry = o[j]
    if cfg.family == "rise_fall":
        ex = c[end]
        won = (ex > entry) if d > 0 else (ex < entry)
        return ex, stake * cfg.payout_ratio if won else -stake, won
    if cfg.family == "higher_lower":
        bar = entry - d * cfg.barrier_atr_mult * atr_v  # UP: "Higher" than barrier below spot
        ex = c[end]
        won = (ex > bar) if d > 0 else (ex < bar)
        return ex, stake * cfg.payout_ratio if won else -stake, won
    if cfg.family in ("touch", "no_touch"):
        bar = entry + d * cfg.barrier_atr_mult * atr_v
        touched = bool((h[j:end + 1] >= bar).any()) if d > 0 else bool((l[j:end + 1] <= bar).any())
        won = touched if cfg.family == "touch" else not touched
        return c[end], stake * cfg.payout_ratio if won else -stake, won
    if cfg.family == "multiplier":
        notional = stake * cfg.multiplier
        sl, tp = -stake * cfg.sl_pct / 100, stake * cfg.tp_pct / 100
        fee = notional * cfg.commission_pct / 100
        for k in range(j, end + 1):
            worst = (l[k] if d > 0 else h[k])
            best = (h[k] if d > 0 else l[k])
            pnl_w = d * (worst / entry - 1) * notional - fee
            pnl_b = d * (best / entry - 1) * notional - fee
            if pnl_w <= max(sl, -stake):
                return worst, max(sl, -stake), False
            if pnl_b >= tp:
                return best, tp, True
        pnl = max(d * (c[end] / entry - 1) * notional - fee, -stake)
        return c[end], pnl, pnl > 0
    raise ValueError(cfg.family)


def run(df: pd.DataFrame, strategy: Strategy, params: dict | None = None, cfg: BTConfig | None = None,
        f: pd.DataFrame | None = None, start: int = 0, end: int | None = None,
        signals: pd.DataFrame | None = None) -> BTResult:
    cfg = cfg or BTConfig()
    f = f if f is not None else ind.compute_all(df)
    g = signals if signals is not None else strategy.generate(df, f, strategy.params(params))
    o, h, l, c = (df[x].to_numpy(float) for x in ("open", "high", "low", "close"))
    atr_v = f["atr"].to_numpy(float)
    dirs, scores = g["dir"].to_numpy(), g["score"].to_numpy(float)
    epochs = df.index.to_numpy()
    n = len(df) if end is None else min(end, len(df))
    bal = cfg.initial_balance
    res = BTResult(equity=[(int(epochs[max(start, 0)]), bal)])
    i = max(start, strategy.min_bars)
    free_at = i
    while i < n - cfg.duration_bars - 1:
        if i >= free_at and dirs[i] != 0 and scores[i] >= cfg.min_score and not math.isnan(atr_v[i]):
            j, e = i + 1, i + cfg.duration_bars
            stake = cfg.fixed_stake or max(0.35, round(bal * cfg.risk_pct / 100, 2))
            if stake > bal or bal <= 0:
                break
            ex, pnl, won = _settle(cfg, int(dirs[i]), o, h, l, c, j, e, atr_v[i], stake)
            bal += pnl
            res.trades.append(BTTrade(i, int(epochs[i]), int(dirs[i]), float(scores[i]), float(o[j]),
                                      float(ex), stake, round(pnl, 4), bool(won), round(bal, 4)))
            res.equity.append((int(epochs[e]), round(bal, 4)))
            free_at = e + 1 + cfg.cooldown_bars
            i = e
        i += 1
    res.stats = stats(res.trades, cfg.initial_balance)
    return res


def stats(trades: list[BTTrade] | list[dict], initial: float = 1000.0) -> dict:
    if not trades:
        return {"trades": 0, "win_rate": None, "profit_factor": None, "net_profit": 0.0, "max_drawdown_pct": 0.0,
                "expectancy": None, "avg_return_pct": None, "max_consecutive_losses": 0, "sharpe": None}
    get = (lambda t, k: t[k]) if isinstance(trades[0], dict) else (lambda t, k: getattr(t, k))
    pnl = np.array([get(t, "profit") for t in trades], float)
    stakes = np.array([get(t, "stake") for t in trades], float)
    wins = pnl > 0
    gp, gl = pnl[wins].sum(), -pnl[~wins].sum()
    eq = initial + np.cumsum(pnl)
    peak = np.maximum.accumulate(np.r_[initial, eq])[1:]
    dd = ((peak - eq) / peak).max() * 100
    streak = mx = 0
    for w in wins:
        streak = 0 if w else streak + 1
        mx = max(mx, streak)
    r = pnl / stakes
    return {"trades": int(len(pnl)), "wins": int(wins.sum()), "losses": int((~wins).sum()),
            "win_rate": round(float(wins.mean()), 4),
            "profit_factor": round(float(gp / gl), 3) if gl > 0 else None,
            "net_profit": round(float(pnl.sum()), 2), "return_pct": round(float(pnl.sum() / initial * 100), 2),
            "max_drawdown_pct": round(float(dd), 2), "expectancy": round(float(pnl.mean()), 4),
            "expectancy_per_stake": round(float(r.mean()), 4),
            "avg_return_pct": round(float(r.mean() * 100), 3),
            "max_consecutive_losses": int(mx),
            "sharpe": round(float(r.mean() / r.std() * math.sqrt(len(r))), 3) if r.std() > 0 else None}


def breakeven_win_rate(payout_ratio: float) -> float:
    return 1 / (1 + payout_ratio)


# ---------------- optimisation & walk-forward ----------------
def _grid(space: dict, max_combos: int, seed: int = 7) -> list[dict]:
    keys = list(space)
    combos = [dict(zip(keys, v)) for v in itertools.product(*(space[k] for k in keys))]
    if len(combos) > max_combos:
        random.Random(seed).shuffle(combos)
        combos = combos[:max_combos]
    return combos


def _objective(s: dict, min_trades: int) -> float:
    if s["trades"] < min_trades:
        return -1e9
    # expectancy per unit stake, penalised by drawdown -> prefers robust over lucky configs
    return s["expectancy_per_stake"] - 0.002 * s["max_drawdown_pct"]


def optimise(df, strategy: Strategy, cfg: BTConfig, base_params: dict | None = None, start=0, end=None,
             f=None, max_combos: int = 40, min_trades: int = 20) -> tuple[dict, dict]:
    f = f if f is not None else ind.compute_all(df)
    best_p, best_s, best_o = strategy.params(base_params), None, -1e18
    for combo in _grid(strategy.param_space, max_combos) or [{}]:
        p = {**strategy.params(base_params), **combo}
        r = run(df, strategy, p, cfg, f=f, start=start, end=end)
        o = _objective(r.stats, min_trades)
        if o > best_o:
            best_p, best_s, best_o = p, r.stats, o
    return best_p, best_s or {}


def walk_forward(df: pd.DataFrame, strategy: Strategy, cfg: BTConfig, base_params: dict | None = None,
                 folds: int = 4, train_frac: float = 0.6, optimise_params: bool = True,
                 max_combos: int = 30) -> dict:
    """Anchored walk-forward: optimise on [0, train_end), test on the next unseen window, roll on.
    Only out-of-sample trades are aggregated - these are what calibration and approval use."""
    f = ind.compute_all(df)
    n = len(df)
    first_train = int(n * train_frac)
    step = max(1, (n - first_train) // folds)
    oos_trades: list[BTTrade] = []
    windows = []
    params_used = []
    for k in range(folds):
        tr_end = first_train + k * step
        te_end = n if k == folds - 1 else tr_end + step
        if optimise_params and strategy.param_space:
            p, is_stats = optimise(df, strategy, cfg, base_params, 0, tr_end, f, max_combos)
        else:
            p = strategy.params(base_params)
            is_stats = run(df, strategy, p, cfg, f=f, end=tr_end).stats
        oos = run(df, strategy, p, cfg, f=f, start=tr_end, end=te_end)
        oos_trades += oos.trades
        params_used.append(p)
        windows.append({"fold": k + 1, "train_bars": tr_end, "test_from": int(df.index[tr_end]),
                        "test_to": int(df.index[te_end - 1]), "params": p, "in_sample": is_stats,
                        "out_of_sample": oos.stats})
    # rebuild OOS equity sequentially with the configured sizing
    oos_stats = stats(oos_trades, cfg.initial_balance)
    final_p = params_used[-1] if params_used else strategy.params(base_params)
    stable = sum(1 for w in windows if (w["out_of_sample"].get("expectancy") or -1) > 0)
    be = breakeven_win_rate(cfg.payout_ratio) if cfg.family != "multiplier" else None
    passed = bool(oos_stats["trades"] >= 30 and (oos_stats["expectancy"] or 0) > 0 and stable >= math.ceil(folds / 2)
                  and oos_stats["max_drawdown_pct"] <= 25)
    return {"strategy": strategy.id, "config": asdict(cfg), "windows": windows, "oos_stats": oos_stats,
            "recommended_params": final_p, "positive_folds": stable, "folds": folds,
            "breakeven_win_rate": be, "passed_validation": passed,
            "calibration_pairs": [(t.score, t.won) for t in oos_trades],
            "oos_index": [(t.i, t.won) for t in oos_trades]}
