"""Strategy framework.

Strategies are *vectorised and causal*: `generate(df, f, params)` returns one row per bar with
  dir   : +1 (UP), -1 (DOWN), 0 (no setup)
  score : raw setup quality 0-100 (NOT a win probability - see ai_engine.calibration)
  c_*   : boolean component columns used to explain the signal
The value at bar t only uses data up to and including the *closed* bar t, and trades are
entered at the next bar's open. The same code powers live trading and backtesting.
"""
from __future__ import annotations

from abc import ABC, abstractmethod
from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .. import indicators as ind


@dataclass
class Signal:
    strategy: str
    direction: str            # "UP" | "DOWN"
    score: float
    reasons: list[str]
    features: dict = field(default_factory=dict)


class Strategy(ABC):
    id: str = "base"
    name: str = "Base"
    description: str = ""
    default_params: dict = {}
    param_space: dict = {}   # name -> list of candidate values for the optimiser
    min_bars: int = 250

    def params(self, overrides: dict | None = None) -> dict:
        p = dict(self.default_params)
        if overrides:
            p.update({k: v for k, v in overrides.items() if k in p})
        return p

    @abstractmethod
    def generate(self, df: pd.DataFrame, f: pd.DataFrame, p: dict) -> pd.DataFrame: ...

    def latest(self, df: pd.DataFrame, f: pd.DataFrame, overrides: dict | None = None) -> Signal | None:
        if len(df) < self.min_bars:
            return None
        g = self.generate(df, f, self.params(overrides))
        row = g.iloc[-1]
        if not row["dir"]:
            return None
        reasons = [c[2:].replace("_", " ") for c in g.columns if c.startswith("c_") and bool(row[c])]
        last = f.iloc[-1]
        feats = {k: _num(last.get(k)) for k in ("rsi", "adx", "atr", "macd_hist", "bb_width", "cci", "stoch_k")}
        return Signal(self.id, "UP" if row["dir"] > 0 else "DOWN", float(row["score"]), reasons, feats)


def _num(v):
    try:
        return None if v is None or np.isnan(v) else float(v)
    except TypeError:
        return None


# ---------- shared causal building blocks ----------
def confirmed_swings(df: pd.DataFrame, k: int = 3) -> pd.DataFrame:
    """Causal swing levels: at bar t, the most recent and previous swing high/low that were
    confirmed by bar t (pivot at t-k needs k bars to its right)."""
    w = 2 * k + 1
    hmax = df["high"].rolling(w, center=False).max()
    lmin = df["low"].rolling(w, center=False).min()
    cand_h = df["high"].shift(k)
    cand_l = df["low"].shift(k)
    is_sh = cand_h.eq(hmax)
    is_sl = cand_l.eq(lmin)
    sh = cand_h.where(is_sh)
    sl = cand_l.where(is_sl)
    last_sh = sh.ffill()
    last_sl = sl.ffill()
    prev_sh = sh.dropna().shift(1).reindex(df.index).ffill()
    prev_sl = sl.dropna().shift(1).reindex(df.index).ffill()
    return pd.DataFrame({"last_sh": last_sh, "prev_sh": prev_sh, "last_sl": last_sl, "prev_sl": prev_sl,
                         "new_sh": is_sh.fillna(False), "new_sl": is_sl.fillna(False)})


def candle_flags(df: pd.DataFrame) -> pd.DataFrame:
    o, h, l, c = df["open"], df["high"], df["low"], df["close"]
    body = (c - o).abs()
    rng = (h - l).replace(0, np.nan)
    up_w = h - np.maximum(o, c)
    lo_w = np.minimum(o, c) - l
    po, pc = o.shift(), c.shift()
    pbody = body.shift()
    out = pd.DataFrame(index=df.index)
    out["bull_engulf"] = (pc < po) & (c > o) & (c >= po) & (o <= pc) & (body > pbody)
    out["bear_engulf"] = (pc > po) & (c < o) & (c <= po) & (o >= pc) & (body > pbody)
    out["hammer"] = (lo_w >= 2 * body) & (up_w <= 0.35 * rng) & (body / rng < 0.4)
    out["star"] = (up_w >= 2 * body) & (lo_w <= 0.35 * rng) & (body / rng < 0.4)
    out["bull_reject"] = out["hammer"] | ((lo_w > 0.5 * rng) & (c > o))
    out["bear_reject"] = out["star"] | ((up_w > 0.5 * rng) & (c < o))
    out["strong_bull"] = (c > o) & (body / rng > 0.6)
    out["strong_bear"] = (c < o) & (body / rng > 0.6)
    return out.fillna(False)


def htf_trend(df: pd.DataFrame, factor: int = 4, fast: int = 21, slow: int = 50) -> pd.Series:
    """Higher-timeframe trend (+1/-1/0) from `factor`x aggregated candles. Only *completed*
    higher-timeframe candles are used, then forward-filled onto the base timeframe."""
    if factor <= 1:
        return pd.Series(0, index=df.index)
    grp = np.arange(len(df)) // factor
    agg = df.groupby(grp).agg(open=("open", "first"), high=("high", "max"),
                              low=("low", "min"), close=("close", "last"))
    complete = pd.Series(np.bincount(grp), index=agg.index) == factor
    e1, e2 = ind.ema(agg["close"], fast), ind.ema(agg["close"], slow)
    t = pd.Series(np.where((agg["close"] > e1) & (e1 > e2), 1,
                           np.where((agg["close"] < e1) & (e1 < e2), -1, 0)), index=agg.index)
    t = t.where(complete)
    # a htf candle is known only once it is complete -> it applies to the NEXT group's bars
    t_known = t.shift(1).ffill().fillna(0)
    return pd.Series(t_known.to_numpy()[grp], index=df.index).astype(int)


def combine(cols: dict[str, pd.Series], weights: dict[str, float], base: float = 30) -> pd.Series:
    s = pd.Series(base, index=next(iter(cols.values())).index, dtype=float)
    for k, w in weights.items():
        s = s + w * cols[k].astype(float).fillna(0)
    return s.clip(0, 100)


def output(index, dir_series: pd.Series, score: pd.Series, comps: dict[str, pd.Series]) -> pd.DataFrame:
    out = pd.DataFrame({"dir": dir_series.fillna(0).astype(int), "score": score.where(dir_series != 0, 0)},
                       index=index)
    for k, v in comps.items():
        out[f"c_{k}"] = v.fillna(False).astype(bool)
    return out
