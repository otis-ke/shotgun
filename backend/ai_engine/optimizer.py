"""Adaptive learning: strategy validation, versioned configurations, deployment and rollback.

Rules enforced here:
* nothing changes while trading unless a user deploys a version
* a version can only be deployed if it passed walk-forward out-of-sample validation
  (or it is a previously-active version being restored)
* every change is a new row in `bot_configs` + an audit-log entry
"""
from __future__ import annotations

import copy
from collections import defaultdict

import pandas as pd

from .. import database as db
from .. import indicators as ind
from ..analysis import regime_series
from ..backtesting.engine import BTConfig, walk_forward
from ..strategies.library import STRATEGIES
from .memory import binomial_z, save_validation

DEFAULT_BOTS: dict[str, dict] = {
    "trend": {"name": "Trend Following Bot", "strategy": "trend", "symbols": ["R_100"], "granularity": 300,
              "contract": {"family": "rise_fall", "duration": 3, "duration_unit": "m"}},
    "price_action": {"name": "Price Action Bot", "strategy": "price_action", "symbols": ["R_75"], "granularity": 300,
                     "contract": {"family": "rise_fall", "duration": 15, "duration_unit": "m"}},
    "scalping": {"name": "Scalping Bot", "strategy": "scalping", "symbols": ["1HZ100V"], "granularity": 60,
                 "contract": {"family": "rise_fall", "duration": 3, "duration_unit": "m"}},
    "reversal": {"name": "Reversal Bot", "strategy": "reversal", "symbols": ["R_50"], "granularity": 300,
                 "contract": {"family": "rise_fall", "duration": 15, "duration_unit": "m"}},
    "breakout": {"name": "Breakout Bot", "strategy": "breakout", "symbols": ["R_25"], "granularity": 300,
                 "contract": {"family": "rise_fall", "duration": 15, "duration_unit": "m"}},
    "volatility": {"name": "Volatility Bot", "strategy": "volatility", "symbols": ["1HZ75V"], "granularity": 300,
                   "contract": {"family": "rise_fall", "duration": 10, "duration_unit": "m"}},
    "smart_ai": {"name": "Smart AI Bot", "strategy": "smart_ai", "symbols": ["R_100"], "granularity": 300,
                 "contract": {"family": "rise_fall", "duration": 15, "duration_unit": "m"},
                 "min_agree": 2, "min_ev": 0.02},
}
COMMON = {"enabled": False, "params": {}, "min_confidence": 70, "auto_execute": False, "max_stake": None,
          "payout_assumption": 0.90, "cooldown_bars": 1, "allow_uncalibrated_demo": True}


def _duration_bars(contract: dict, granularity: int) -> int:
    unit = {"s": 1, "m": 60, "h": 3600, "d": 86400, "t": 2}[contract.get("duration_unit", "m")]
    return max(1, round(contract.get("duration", 5) * unit / granularity))


def _bc(uid):
    t = db.bot_configs
    return t.c.user_id == uid if uid else t.c.user_id.is_(None)


def seed_defaults(uid: str | None) -> None:
    for bot_id, cfg in DEFAULT_BOTS.items():
        exists = db.rows(db.select(db.bot_configs.c.id).where((db.bot_configs.c.bot_id == bot_id) & _bc(uid)).limit(1))
        if not exists:
            full = {**copy.deepcopy(COMMON), **copy.deepcopy(cfg)}
            if cfg["strategy"] in STRATEGIES:
                full["params"] = STRATEGIES[cfg["strategy"]].params()
            db.execute(db.insert(db.bot_configs).values(
                user_id=uid, bot_id=bot_id, version=1, params=full, status="active", note="factory defaults",
                validation=None, created_at=db.now()))


def active(uid: str | None, bot_id: str) -> dict:
    r = db.rows(db.select(db.bot_configs).where((db.bot_configs.c.bot_id == bot_id) & _bc(uid) &
                                                 (db.bot_configs.c.status == "active"))
                .order_by(db.bot_configs.c.version.desc()).limit(1))
    if not r:
        raise KeyError(bot_id)
    return {**r[0]["params"], "_version": r[0]["version"], "_validation": r[0]["validation"]}


def versions(uid: str | None, bot_id: str) -> list[dict]:
    return db.rows(db.select(db.bot_configs).where((db.bot_configs.c.bot_id == bot_id) & _bc(uid))
                   .order_by(db.bot_configs.c.version.desc()))


def _next_version(uid: str | None, bot_id: str) -> int:
    v = db.rows(db.select(db.func.max(db.bot_configs.c.version)).where(
        (db.bot_configs.c.bot_id == bot_id) & _bc(uid)))
    return int((list(v[0].values())[0] or 0) + 1)


def _archive_active(c, uid, bot_id):
    c.execute(db.update(db.bot_configs).where((db.bot_configs.c.bot_id == bot_id) & _bc(uid) &
                                              (db.bot_configs.c.status == "active")).values(status="archived"))


def update_operational(uid: str | None, bot_id: str, changes: dict) -> dict:
    """Operational settings (enable, symbols, stake caps, mode flags) don't alter the trading
    logic, so they're versioned and applied immediately. Strategy params must go through propose/deploy."""
    allowed = {"enabled", "symbols", "min_confidence", "auto_execute", "max_stake", "payout_assumption",
               "cooldown_bars", "name", "allow_uncalibrated_demo", "min_agree", "min_ev"}
    bad = set(changes) - allowed
    if bad:
        raise ValueError(f"not an operational setting: {sorted(bad)} (strategy changes need validation)")
    cur = active(uid, bot_id)
    new = {k: v for k, v in cur.items() if not k.startswith("_")}
    new.update(changes)
    ver = _next_version(uid, bot_id)
    with db.get_engine().begin() as c:
        _archive_active(c, uid, bot_id)
        c.execute(db.insert(db.bot_configs).values(user_id=uid, bot_id=bot_id, version=ver, params=new,
                                                   status="active", note=f"operational change: {sorted(changes)}",
                                                   validation=cur.get("_validation"), created_at=db.now()))
    db.audit("config", f"{bot_id} operational settings changed", user_id=uid, changes=changes, version=ver)
    return active(uid, bot_id)


def validate(uid: str | None, bot_id: str, df: pd.DataFrame, overrides: dict | None = None, folds: int = 4,
             optimise: bool = True) -> dict:
    """Walk-forward validate a bot (optionally with modified params/contract). Saves OOS outcomes
    for calibration and stores a *proposed* version - it is NOT deployed."""
    cur = {k: v for k, v in active(uid, bot_id).items() if not k.startswith("_")}
    cand = copy.deepcopy(cur)
    for k, v in (overrides or {}).items():
        if k in ("params", "contract") and isinstance(v, dict):
            cand[k] = {**cand.get(k, {}), **v}
        else:
            cand[k] = v
    sid = cand["strategy"]
    if sid == "smart_ai":
        raise ValueError("Smart AI is validated through its specialists - validate those bots")
    strat = STRATEGIES[sid]
    c = cand["contract"]
    cfg = BTConfig(family=c.get("family", "rise_fall"), duration_bars=_duration_bars(c, cand["granularity"]),
                   payout_ratio=cand.get("payout_assumption", 0.9), barrier_atr_mult=c.get("barrier_atr_mult", 1.0),
                   multiplier=c.get("multiplier") or 50, sl_pct=c.get("sl_pct_of_stake") or 50,
                   tp_pct=c.get("tp_pct_of_stake") or 50, cooldown_bars=cand.get("cooldown_bars", 1))
    wf = walk_forward(df, strat, cfg, cand.get("params"), folds=folds, optimise_params=optimise)
    # regime-conditional OOS outcomes for the Smart AI
    reg = regime_series(ind.compute_all(df))
    counts: dict = defaultdict(lambda: [0, 0])
    for i, won in wf["oos_index"]:
        counts[reg.iloc[i]][0] += int(won)
        counts[reg.iloc[i]][1] += 1
    epochs = df.index.to_numpy()
    save_validation(uid, sid, wf["calibration_pairs"], {k: v for k, v in counts.items()})
    cand["params"] = wf["recommended_params"]
    validation = {k: v for k, v in wf.items() if k not in ("calibration_pairs", "oos_index")}
    validation["data"] = {"bars": len(df), "from": int(epochs[0]), "to": int(epochs[-1])}
    ver = _next_version(uid, bot_id)
    db.execute(db.insert(db.bot_configs).values(
        user_id=uid, bot_id=bot_id, version=ver, params=cand, validation=validation, created_at=db.now(),
        status="proposed" if wf["passed_validation"] else "rejected",
        note="walk-forward " + ("PASSED" if wf["passed_validation"] else "FAILED")))
    db.audit("optimizer", f"{bot_id} v{ver} walk-forward {'passed' if wf['passed_validation'] else 'failed'}",
             user_id=uid, oos=wf["oos_stats"])
    return {"version": ver, "status": "proposed" if wf["passed_validation"] else "rejected", **validation}


def deploy(uid: str | None, bot_id: str, version: int) -> dict:
    r = db.rows(db.select(db.bot_configs).where((db.bot_configs.c.bot_id == bot_id) & _bc(uid) &
                                                 (db.bot_configs.c.version == version)))
    if not r:
        raise KeyError(f"{bot_id} v{version}")
    row = r[0]
    was_active_before = row["status"] == "archived"
    if row["status"] == "rejected":
        raise PermissionError("this version failed validation and cannot be deployed")
    if row["status"] == "proposed" and not (row["validation"] or {}).get("passed_validation"):
        raise PermissionError("version has no passing validation")
    with db.get_engine().begin() as c:
        _archive_active(c, uid, bot_id)
        c.execute(db.update(db.bot_configs).where(db.bot_configs.c.id == row["id"]).values(status="active"))
    db.audit("config", f"{bot_id} {'restored' if was_active_before else 'deployed'} v{version}", user_id=uid)
    return active(uid, bot_id)


def degradation(uid: str | None, bot_id: str, min_trades: int = 30) -> dict:
    """Is the live record significantly worse than the validated OOS expectation?"""
    cfg = active(uid, bot_id)
    val = cfg.get("_validation") or {}
    expected = (val.get("oos_stats") or {}).get("win_rate")
    deployed_at = db.rows(db.select(db.bot_configs.c.created_at).where(
        (db.bot_configs.c.bot_id == bot_id) & _bc(uid) & (db.bot_configs.c.version == cfg["_version"])))[0]["created_at"]
    tr = db.trades
    mine = tr.c.user_id == uid if uid else tr.c.user_id.is_(None)
    t = db.rows(db.select(tr.c.status).where((tr.c.bot_id == bot_id) & mine & (tr.c.buy_time >= deployed_at) &
                                             tr.c.status.in_(["won", "lost", "sold"])))
    n, w = len(t), sum(1 for x in t if x["status"] == "won")
    be = 1 / (1 + cfg.get("payout_assumption", 0.9))
    ref = expected if expected is not None else be
    z = binomial_z(w, n, ref) if n else None
    degraded = bool(n >= min_trades and z is not None and z < -2.0)
    return {"bot_id": bot_id, "trades": n, "win_rate": round(w / n, 4) if n else None, "expected": ref,
            "breakeven": round(be, 4), "z": round(z, 2) if z is not None else None, "degraded": degraded}
