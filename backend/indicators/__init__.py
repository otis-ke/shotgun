"""Technical indicators. All functions are causal: value at bar t uses only bars <= t."""
from __future__ import annotations

import numpy as np
import pandas as pd


def _wilder(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(alpha=1 / n, adjust=False, min_periods=n).mean()


def sma(s: pd.Series, n: int) -> pd.Series:
    return s.rolling(n, min_periods=n).mean()


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False, min_periods=n).mean()


def rsi(s: pd.Series, n: int = 14) -> pd.Series:
    d = s.diff()
    up, dn = _wilder(d.clip(lower=0), n), _wilder(-d.clip(upper=0), n)
    rs = up / dn.replace(0, np.nan)
    out = 100 - 100 / (1 + rs)
    return out.where(dn != 0, 100.0).where(up.notna())


def macd(s: pd.Series, fast: int = 12, slow: int = 26, signal: int = 9) -> pd.DataFrame:
    line = ema(s, fast) - ema(s, slow)
    sig = line.ewm(span=signal, adjust=False, min_periods=signal).mean()
    return pd.DataFrame({"macd": line, "signal": sig, "hist": line - sig})


def true_range(df: pd.DataFrame) -> pd.Series:
    pc = df["close"].shift()
    return pd.concat([df["high"] - df["low"], (df["high"] - pc).abs(), (df["low"] - pc).abs()], axis=1).max(axis=1)


def atr(df: pd.DataFrame, n: int = 14) -> pd.Series:
    return _wilder(true_range(df), n)


def adx(df: pd.DataFrame, n: int = 14) -> pd.DataFrame:
    up = df["high"].diff()
    dn = -df["low"].diff()
    plus_dm = pd.Series(np.where((up > dn) & (up > 0), up, 0.0), index=df.index)
    minus_dm = pd.Series(np.where((dn > up) & (dn > 0), dn, 0.0), index=df.index)
    tr = _wilder(true_range(df), n)
    pdi = 100 * _wilder(plus_dm, n) / tr
    mdi = 100 * _wilder(minus_dm, n) / tr
    dx = 100 * (pdi - mdi).abs() / (pdi + mdi).replace(0, np.nan)
    return pd.DataFrame({"adx": _wilder(dx, n), "plus_di": pdi, "minus_di": mdi})


def bollinger(s: pd.Series, n: int = 20, k: float = 2.0) -> pd.DataFrame:
    mid = sma(s, n)
    sd = s.rolling(n, min_periods=n).std(ddof=0)
    up, lo = mid + k * sd, mid - k * sd
    return pd.DataFrame({"mid": mid, "upper": up, "lower": lo,
                         "width": (up - lo) / mid.replace(0, np.nan),
                         "pct_b": (s - lo) / (up - lo).replace(0, np.nan)})


def stochastic(df: pd.DataFrame, k: int = 14, d: int = 3, smooth: int = 3) -> pd.DataFrame:
    ll = df["low"].rolling(k, min_periods=k).min()
    hh = df["high"].rolling(k, min_periods=k).max()
    raw = 100 * (df["close"] - ll) / (hh - ll).replace(0, np.nan)
    kline = raw.rolling(smooth, min_periods=smooth).mean()
    return pd.DataFrame({"k": kline, "d": kline.rolling(d, min_periods=d).mean()})


def cci(df: pd.DataFrame, n: int = 20) -> pd.Series:
    tp = (df["high"] + df["low"] + df["close"]) / 3
    m = tp.rolling(n, min_periods=n).mean()
    md = tp.rolling(n, min_periods=n).apply(lambda x: np.abs(x - x.mean()).mean(), raw=True)
    return (tp - m) / (0.015 * md.replace(0, np.nan))


def parabolic_sar(df: pd.DataFrame, step: float = 0.02, max_step: float = 0.2) -> pd.DataFrame:
    h, l = df["high"].to_numpy(), df["low"].to_numpy()
    n = len(df)
    sar = np.full(n, np.nan)
    trend = np.zeros(n, dtype=int)
    if n < 3:
        return pd.DataFrame({"sar": sar, "trend": trend}, index=df.index)
    up = h[1] > h[0]
    af, ep = step, (h[1] if up else l[1])
    s = l[0] if up else h[0]
    for i in range(1, n):
        s = s + af * (ep - s)
        if up:
            s = min(s, l[i - 1], l[i - 2] if i > 1 else l[i - 1])
            if l[i] < s:
                up, s, ep, af = False, ep, l[i], step
            elif h[i] > ep:
                ep, af = h[i], min(af + step, max_step)
        else:
            s = max(s, h[i - 1], h[i - 2] if i > 1 else h[i - 1])
            if h[i] > s:
                up, s, ep, af = True, ep, h[i], step
            elif l[i] < ep:
                ep, af = l[i], min(af + step, max_step)
        sar[i], trend[i] = s, 1 if up else -1
    return pd.DataFrame({"sar": sar, "trend": trend}, index=df.index)


def ichimoku(df: pd.DataFrame, t: int = 9, k: int = 26, s: int = 52) -> pd.DataFrame:
    """Causal Ichimoku: spans are the values *plotted* at the current bar (computed 26 bars ago),
    and the lagging span is not used (it would require future data at the plotted bar)."""
    mid = lambda n: (df["high"].rolling(n, min_periods=n).max() + df["low"].rolling(n, min_periods=n).min()) / 2  # noqa: E731
    tenkan, kijun = mid(t), mid(k)
    span_a = ((tenkan + kijun) / 2).shift(k)
    span_b = mid(s).shift(k)
    return pd.DataFrame({"tenkan": tenkan, "kijun": kijun, "span_a": span_a, "span_b": span_b})


def donchian(df: pd.DataFrame, n: int = 20) -> pd.DataFrame:
    """Channel of the *previous* n bars, so a close above `upper` is a genuine breakout."""
    up = df["high"].rolling(n, min_periods=n).max().shift(1)
    lo = df["low"].rolling(n, min_periods=n).min().shift(1)
    return pd.DataFrame({"upper": up, "lower": lo, "mid": (up + lo) / 2})


def vwap(df: pd.DataFrame, session: int | None = None) -> pd.Series | None:
    """VWAP needs real volume. Deriv synthetic/forex candles carry no volume -> returns None."""
    if "volume" not in df or df["volume"].fillna(0).sum() <= 0:
        return None
    tp = (df["high"] + df["low"] + df["close"]) / 3
    pv, v = tp * df["volume"], df["volume"]
    if session:
        return pv.rolling(session).sum() / v.rolling(session).sum()
    return pv.cumsum() / v.cumsum()


def compute_all(df: pd.DataFrame) -> pd.DataFrame:
    """Wide frame of the standard indicator set used by strategies and the dashboard."""
    c = df["close"]
    out = df.copy()
    for n in (9, 21, 50, 200):
        out[f"ema{n}"] = ema(c, n)
    out["sma20"] = sma(c, 20)
    out["rsi"] = rsi(c)
    out = out.join(macd(c).add_prefix("macd_"))
    out = out.join(adx(df))
    out["atr"] = atr(df)
    out = out.join(bollinger(c).add_prefix("bb_"))
    out = out.join(stochastic(df).add_prefix("stoch_"))
    out["cci"] = cci(df)
    out = out.join(parabolic_sar(df).add_prefix("psar_"))
    out = out.join(ichimoku(df).add_prefix("ichi_"))
    out = out.join(donchian(df).add_prefix("don_"))
    v = vwap(df)
    out["vwap"] = v if v is not None else np.nan
    return out
