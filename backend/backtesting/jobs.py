"""CPU-heavy work (backtests, walk-forward validation) runs in a separate process pool so it can
never starve the asyncio loop that keeps the Deriv connection, heartbeats and live bots alive."""
from __future__ import annotations

import asyncio
import multiprocessing as mp
from concurrent.futures import ProcessPoolExecutor

import pandas as pd

_pool: ProcessPoolExecutor | None = None


def pool() -> ProcessPoolExecutor:
    global _pool
    if _pool is None:
        _pool = ProcessPoolExecutor(max_workers=2, mp_context=mp.get_context("spawn"))
    return _pool


def shutdown() -> None:
    global _pool
    if _pool is not None:
        _pool.shutdown(wait=False, cancel_futures=True)
        _pool = None


async def submit(fn, *args):
    return await asyncio.get_running_loop().run_in_executor(pool(), fn, *args)


def _frame(records: dict) -> pd.DataFrame:
    df = pd.DataFrame(records["data"], index=records["index"], columns=["open", "high", "low", "close"])
    df.index.name = "epoch"
    return df


def pack(df: pd.DataFrame) -> dict:
    return {"index": [int(i) for i in df.index], "data": df[["open", "high", "low", "close"]].to_numpy().tolist()}


def backtest_job(records: dict, strategies: list[str], params: dict, cfg: dict, walk: bool, folds: int) -> dict:
    from .. import indicators as ind
    from ..strategies.library import STRATEGIES
    from .engine import BTConfig, run, walk_forward
    df = _frame(records)
    c = BTConfig.from_dict(cfg)
    f = ind.compute_all(df)
    out = {}
    for sid in strategies:
        s = STRATEGIES[sid]
        if walk:
            wf = walk_forward(df, s, c, params.get(sid), folds=folds)
            wf.pop("calibration_pairs", None)
            wf.pop("oos_index", None)
            out[sid] = wf
        else:
            out[sid] = run(df, s, params.get(sid), c, f=f).to_dict()
    return out


def validate_job(db_url: str, uid: str | None, bot_id: str, records: dict, overrides: dict, folds: int,
                 optimise: bool) -> dict:
    from .. import database as db
    from ..ai_engine import optimizer
    db.reset_engine(db_url)
    return optimizer.validate(uid, bot_id, _frame(records), overrides, folds, optimise)
