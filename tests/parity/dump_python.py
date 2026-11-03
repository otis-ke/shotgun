"""Dump Python engine outputs on fixed synthetic data so the browser (JS) engine can be checked
against it: python -m tests.parity.dump_python <out.json>"""
import json
import math
import sys

import numpy as np

from backend import indicators as ind
from backend.ai_engine.calibration import Calibrator
from backend.analysis import analyze, regime_series
from backend.backtesting.engine import BTConfig, run, walk_forward
from backend.strategies.library import STRATEGIES
from tests.conftest import make_ohlc


def clean(v):
    if isinstance(v, dict):
        return {k: clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [clean(x) for x in v]
    if isinstance(v, (np.bool_, bool)):
        return bool(v)
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (float, np.floating)):
        return None if math.isnan(v) or math.isinf(v) else float(v)
    return v


def series(s):
    return [None if (isinstance(x, float) and (math.isnan(x) or math.isinf(x))) else (bool(x) if isinstance(x, (bool, np.bool_)) else float(x))
            for x in s.tolist()]


def main(out_path: str) -> None:
    out = {"datasets": []}
    for seed, n in ((1, 3000), (5, 2000)):
        df = make_ohlc(n=n, seed=seed)
        f = ind.compute_all(df)
        d = {"seed": seed, "candles": [{"epoch": int(i), "open": r.open, "high": r.high, "low": r.low, "close": r.close}
                                       for i, r in df.iterrows()]}
        d["indicators"] = {c: series(f[c]) for c in f.columns if c not in ("open", "high", "low", "close", "vwap")}
        d["regime_series"] = regime_series(f).tolist()
        d["strategies"] = {}
        for sid, s in STRATEGIES.items():
            g = s.generate(df, f, s.params())
            r = run(df, s, None, BTConfig(duration_bars=3), f=f)
            d["strategies"][sid] = {"dir": g["dir"].astype(int).tolist(), "score": series(g["score"]),
                                    "comps": {c: g[c].astype(bool).tolist() for c in g.columns if c.startswith("c_")},
                                    "bt_stats": clean(r.stats)}
        d["analyze"] = clean(analyze("R_100", 60, df, f=f).to_dict())
        wf = walk_forward(df, STRATEGIES["trend"], BTConfig(duration_bars=3), folds=3, max_combos=8)
        d["walk_forward_noopt"] = clean({k: v for k, v in walk_forward(df, STRATEGIES["breakout"], BTConfig(duration_bars=3),
                                                                        folds=3, optimise_params=False).items()
                                         if k in ("oos_stats", "passed_validation", "positive_folds")})
        d["walk_forward_trend_windows"] = len(wf["windows"])
        out["datasets"].append(d)
    rng = np.random.default_rng(3)
    pairs = [(float(s), bool(rng.random() < 0.3 + s / 250)) for s in rng.integers(30, 100, 200)]
    cal = Calibrator().fit(pairs)
    out["calibration"] = {"pairs": pairs, "p_win": {str(s): cal.p_win(s) for s in (30, 45, 52.5, 60, 75, 99)},
                          "describe": clean(cal.describe())}
    with open(out_path, "w") as fh:
        json.dump(out, fh)


if __name__ == "__main__":
    main(sys.argv[1])
