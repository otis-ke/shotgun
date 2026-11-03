"""Market analysis engine: structure, S/R, candlesticks, regime, divergences, multi-timeframe.

Everything here is causal. Swing pivots need `k` bars on the right to confirm, so a pivot at
bar i only becomes *known* at bar i+k - the functions return the confirmation index too.
"""
from __future__ import annotations

from dataclasses import asdict, dataclass, field

import numpy as np
import pandas as pd

from .. import indicators as ind


# ---------------- swings & structure ----------------
def swings(df: pd.DataFrame, k: int = 3) -> tuple[list[tuple[int, float]], list[tuple[int, float]]]:
    """Confirmed swing highs/lows as (bar_index, price). Pivot i is confirmed at i+k."""
    h, l = df["high"].to_numpy(), df["low"].to_numpy()
    highs, lows = [], []
    for i in range(k, len(df) - k):
        win_h, win_l = h[i - k:i + k + 1], l[i - k:i + k + 1]
        if h[i] == win_h.max() and (win_h == h[i]).sum() == 1:
            highs.append((i, float(h[i])))
        if l[i] == win_l.min() and (win_l == l[i]).sum() == 1:
            lows.append((i, float(l[i])))
    return highs, lows


def market_structure(df: pd.DataFrame, k: int = 3) -> dict:
    highs, lows = swings(df, k)
    res = {"structure": "undefined", "last_high": None, "last_low": None, "hh": False, "hl": False,
           "lh": False, "ll": False, "bos": None}
    if len(highs) < 2 or len(lows) < 2:
        return res
    (_, h1), (_, h2) = highs[-2], highs[-1]
    (_, l1), (_, l2) = lows[-2], lows[-1]
    res.update(last_high=h2, last_low=l2, hh=h2 > h1, lh=h2 < h1, hl=l2 > l1, ll=l2 < l1)
    if res["hh"] and res["hl"]:
        res["structure"] = "bullish"
    elif res["lh"] and res["ll"]:
        res["structure"] = "bearish"
    else:
        res["structure"] = "ranging"
    close = float(df["close"].iloc[-1])
    if close > h2:
        res["bos"] = "up"      # break of structure above last swing high
    elif close < l2:
        res["bos"] = "down"
    return res


def support_resistance(df: pd.DataFrame, k: int = 3, lookback: int = 300, tol_atr: float = 0.5,
                       max_levels: int = 8) -> list[dict]:
    d = df.iloc[-lookback:]
    if len(d) < 30:
        return []
    a = float(ind.atr(d).iloc[-1] or 0) or float((d["high"] - d["low"]).mean())
    highs, lows = swings(d, k)
    pts = [(p, "R") for _, p in highs] + [(p, "S") for _, p in lows]
    pts.sort()
    clusters: list[list[float]] = []
    for p, _ in pts:
        if clusters and abs(p - np.mean(clusters[-1])) <= tol_atr * a:
            clusters[-1].append(p)
        else:
            clusters.append([p])
    close = float(d["close"].iloc[-1])
    levels = [{"price": float(np.mean(c)), "touches": len(c),
               "type": "resistance" if np.mean(c) > close else "support",
               "distance_atr": float((np.mean(c) - close) / a) if a else 0.0} for c in clusters]
    levels.sort(key=lambda x: (-x["touches"], abs(x["distance_atr"])))
    return levels[:max_levels]


def supply_demand_zones(df: pd.DataFrame, lookback: int = 300, impulse_atr: float = 2.0) -> list[dict]:
    """Base candle(s) followed by an impulsive move of >= impulse_atr * ATR."""
    d = df.iloc[-lookback:].reset_index(drop=True)
    a = ind.atr(d)
    zones = []
    for i in range(15, len(d) - 3):
        if np.isnan(a.iloc[i]):
            continue
        move = d["close"].iloc[i + 3] - d["close"].iloc[i]
        body = abs(d["close"].iloc[i] - d["open"].iloc[i])
        if body < 0.5 * a.iloc[i] and abs(move) >= impulse_atr * a.iloc[i]:
            zones.append({"type": "demand" if move > 0 else "supply",
                          "low": float(d["low"].iloc[i]), "high": float(d["high"].iloc[i]),
                          "age": len(d) - i})
    return zones[-6:]


# ---------------- candlesticks ----------------
def candle_patterns(df: pd.DataFrame) -> dict:
    if len(df) < 3:
        return {}
    o, h, l, c = (df[x].to_numpy()[-3:] for x in ("open", "high", "low", "close"))
    body = np.abs(c - o)
    rng = np.maximum(h - l, 1e-12)
    up_w, lo_w = h - np.maximum(o, c), np.minimum(o, c) - l
    i = -1
    p = {
        "bullish_engulfing": c[i - 1] < o[i - 1] and c[i] > o[i] and c[i] >= o[i - 1] and o[i] <= c[i - 1]
                             and body[i] > body[i - 1],
        "bearish_engulfing": c[i - 1] > o[i - 1] and c[i] < o[i] and c[i] <= o[i - 1] and o[i] >= c[i - 1]
                             and body[i] > body[i - 1],
        "hammer": lo_w[i] >= 2 * body[i] and up_w[i] <= 0.35 * rng[i] and body[i] / rng[i] < 0.4,
        "shooting_star": up_w[i] >= 2 * body[i] and lo_w[i] <= 0.35 * rng[i] and body[i] / rng[i] < 0.4,
        "doji": body[i] / rng[i] < 0.1,
        "inside_bar": h[i] < h[i - 1] and l[i] > l[i - 1],
        "strong_bull": c[i] > o[i] and body[i] / rng[i] > 0.7,
        "strong_bear": c[i] < o[i] and body[i] / rng[i] > 0.7,
    }
    p["bullish_rejection"] = p["hammer"] or (lo_w[i] > 0.5 * rng[i] and c[i] > o[i])
    p["bearish_rejection"] = p["shooting_star"] or (up_w[i] > 0.5 * rng[i] and c[i] < o[i])
    return {k: bool(v) for k, v in p.items()}


# ---------------- divergence ----------------
def divergence(df: pd.DataFrame, osc: pd.Series, k: int = 3, max_gap: int = 40) -> str | None:
    """Regular divergence between the last two confirmed price pivots and the oscillator."""
    highs, lows = swings(df, k)
    n = len(df)
    if len(lows) >= 2:
        (i1, p1), (i2, p2) = lows[-2], lows[-1]
        if n - 1 - i2 <= k + 2 and i2 - i1 <= max_gap and p2 < p1 and osc.iloc[i2] > osc.iloc[i1]:
            return "bullish"
    if len(highs) >= 2:
        (i1, p1), (i2, p2) = highs[-2], highs[-1]
        if n - 1 - i2 <= k + 2 and i2 - i1 <= max_gap and p2 > p1 and osc.iloc[i2] < osc.iloc[i1]:
            return "bearish"
    return None


# ---------------- regime ----------------
def consolidation(df: pd.DataFrame, n: int = 20, max_width_atr: float = 3.0) -> dict:
    d = df.iloc[-n:]
    a = float(ind.atr(df).iloc[-1] or 0)
    width = float(d["high"].max() - d["low"].min())
    return {"in_range": bool(a and width <= max_width_atr * a), "high": float(d["high"].max()),
            "low": float(d["low"].min()), "width_atr": width / a if a else None}


def regime(f: pd.DataFrame) -> dict:
    """f = indicators.compute_all output. Classifies trending/ranging/volatile/quiet."""
    last = f.iloc[-1]
    atr_rank = float((f["atr"] / f["close"]).rolling(200, min_periods=50).rank(pct=True).iloc[-1])
    bbw_rank = float(f["bb_width"].rolling(200, min_periods=50).rank(pct=True).iloc[-1])
    adx_v = float(last.get("adx", np.nan))
    slope = float((f["ema50"].iloc[-1] - f["ema50"].iloc[-6]) / (last["atr"] or 1)) if len(f) > 6 else 0
    if np.isnan(adx_v):
        name = "unknown"
    elif adx_v >= 25 and abs(slope) > 0.3:
        name = "trending_up" if slope > 0 else "trending_down"
    elif not np.isnan(atr_rank) and atr_rank > 0.85:
        name = "volatile"
    elif not np.isnan(bbw_rank) and bbw_rank < 0.15:
        name = "quiet"
    else:
        name = "ranging"
    return {"name": name, "adx": adx_v, "ema50_slope_atr": slope,
            "atr_percentile": None if np.isnan(atr_rank) else atr_rank,
            "bb_width_percentile": None if np.isnan(bbw_rank) else bbw_rank}


def regime_series(f: pd.DataFrame) -> pd.Series:
    """Vectorised, causal version of `regime()` - one label per bar (used for backtests)."""
    atr_rank = (f["atr"] / f["close"]).rolling(200, min_periods=50).rank(pct=True)
    bbw_rank = f["bb_width"].rolling(200, min_periods=50).rank(pct=True)
    slope = (f["ema50"] - f["ema50"].shift(5)) / f["atr"].replace(0, np.nan)
    lab = np.where(f["adx"].isna(), "unknown",
          np.where((f["adx"] >= 25) & (slope > 0.3), "trending_up",
          np.where((f["adx"] >= 25) & (slope < -0.3), "trending_down",
          np.where(atr_rank > 0.85, "volatile",
          np.where(bbw_rank < 0.15, "quiet", "ranging")))))
    return pd.Series(lab, index=f.index)


def trend_direction(f: pd.DataFrame) -> int:
    """+1 up, -1 down, 0 none - based on EMA stack."""
    l = f.iloc[-1]
    if any(np.isnan(l[x]) for x in ("ema21", "ema50")):
        return 0
    if l["close"] > l["ema21"] > l["ema50"]:
        return 1
    if l["close"] < l["ema21"] < l["ema50"]:
        return -1
    return 0


@dataclass
class Snapshot:
    symbol: str
    granularity: int
    epoch: int
    close: float
    regime: dict
    trend: int
    htf_trend: int | None
    structure: dict
    levels: list
    zones: list
    patterns: dict
    rsi_div: str | None
    macd_div: str | None
    consolidation: dict
    indicators: dict = field(default_factory=dict)

    def to_dict(self) -> dict:
        return asdict(self)


def _clean(v):
    try:
        return None if v is None or np.isnan(v) else round(float(v), 6)
    except TypeError:
        return v


def analyze(symbol: str, granularity: int, df: pd.DataFrame, htf: pd.DataFrame | None = None,
            f: pd.DataFrame | None = None) -> Snapshot:
    f = f if f is not None else ind.compute_all(df)
    htf_trend = None
    if htf is not None and len(htf) >= 60:
        htf_trend = trend_direction(ind.compute_all(htf))
    last = f.iloc[-1]
    keys = ["ema9", "ema21", "ema50", "ema200", "rsi", "macd_macd", "macd_signal", "macd_hist", "adx",
            "plus_di", "minus_di", "atr", "bb_upper", "bb_mid", "bb_lower", "bb_width", "stoch_k",
            "stoch_d", "cci", "psar_sar", "psar_trend", "ichi_tenkan", "ichi_kijun", "ichi_span_a",
            "ichi_span_b", "don_upper", "don_lower", "vwap"]
    return Snapshot(
        symbol=symbol, granularity=granularity, epoch=int(df.index[-1]), close=float(last["close"]),
        regime=regime(f), trend=trend_direction(f), htf_trend=htf_trend,
        structure=market_structure(df), levels=support_resistance(df), zones=supply_demand_zones(df),
        patterns=candle_patterns(df), rsi_div=divergence(df, f["rsi"]),
        macd_div=divergence(df, f["macd_hist"]), consolidation=consolidation(df),
        indicators={k: _clean(last.get(k)) for k in keys})
