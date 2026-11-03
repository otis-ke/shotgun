"""The six specialist strategies (bots 1-6). Bot 7 (Smart AI) lives in ai_engine."""
from __future__ import annotations

import numpy as np
import pandas as pd

from .. import indicators as ind
from .base import Strategy, candle_flags, combine, confirmed_swings, htf_trend, output


def _pick(d: pd.Series, up: pd.Series, dn: pd.Series) -> pd.Series:
    """Component true in the direction of the signal."""
    return ((d > 0) & up) | ((d < 0) & dn)


class TrendFollowing(Strategy):
    id, name = "trend", "Trend Following"
    description = "EMA 9/21 cross in the direction of EMA 50/200, confirmed by ADX, MACD and HTF trend."
    default_params = {"fast": 9, "slow": 21, "adx_min": 22, "cross_lookback": 3, "htf_factor": 4,
                      "require_htf": True, "require_macd": True}
    param_space = {"adx_min": [18, 22, 26, 30], "cross_lookback": [1, 3, 5], "htf_factor": [3, 4, 6],
                   "require_macd": [True, False]}

    def generate(self, df, f, p):
        c = df["close"]
        ef, es = ind.ema(c, p["fast"]), ind.ema(c, p["slow"])
        up_x = (ef > es) & (ef.shift() <= es.shift())
        dn_x = (ef < es) & (ef.shift() >= es.shift())
        lb = p["cross_lookback"]
        recent_up = up_x.rolling(lb, min_periods=1).max().astype(bool) & (ef > es)
        recent_dn = dn_x.rolling(lb, min_periods=1).max().astype(bool) & (ef < es)
        long_up, long_dn = f["ema50"] > f["ema200"], f["ema50"] < f["ema200"]
        strong = f["adx"] >= p["adx_min"]
        di_up, di_dn = f["plus_di"] > f["minus_di"], f["minus_di"] > f["plus_di"]
        macd_up = (f["macd_hist"] > 0) & (f["macd_macd"] > f["macd_signal"])
        macd_dn = (f["macd_hist"] < 0) & (f["macd_macd"] < f["macd_signal"])
        h = htf_trend(df, p["htf_factor"])
        up = recent_up & long_up & strong & di_up
        dn = recent_dn & long_dn & strong & di_dn
        if p["require_macd"]:
            up &= macd_up
            dn &= macd_dn
        if p["require_htf"]:
            up &= h > 0
            dn &= h < 0
        d = pd.Series(np.where(up, 1, np.where(dn, -1, 0)), index=df.index)
        comps = {"ema_9_21_cross": _pick(d, recent_up, recent_dn), "ema_50_200_aligned": _pick(d, long_up, long_dn),
                 "adx_strong": strong & (d != 0), "adx_very_strong": (f["adx"] >= p["adx_min"] + 10) & (d != 0),
                 "macd_confirms": _pick(d, macd_up, macd_dn), "htf_aligned": _pick(d, h > 0, h < 0),
                 "price_above_ema200": _pick(d, c > f["ema200"], c < f["ema200"])}
        score = combine(comps, {"ema_9_21_cross": 10, "ema_50_200_aligned": 10, "adx_strong": 8,
                                "adx_very_strong": 10, "macd_confirms": 10, "htf_aligned": 12,
                                "price_above_ema200": 5})
        return output(df.index, d, score, comps)


class PriceAction(Strategy):
    id, name = "price_action", "Price Action"
    description = "Market structure (HH/HL, LH/LL), S/R bounces and breakout-retests with candle confirmation."
    default_params = {"swing_k": 3, "touch_atr": 0.4, "retest_bars": 8}
    param_space = {"swing_k": [2, 3, 5], "touch_atr": [0.25, 0.4, 0.6], "retest_bars": [5, 8, 12]}

    def generate(self, df, f, p):
        s = confirmed_swings(df, p["swing_k"])
        cf = candle_flags(df)
        a = f["atr"]
        bull_struct = (s["last_sh"] > s["prev_sh"]) & (s["last_sl"] > s["prev_sl"])
        bear_struct = (s["last_sh"] < s["prev_sh"]) & (s["last_sl"] < s["prev_sl"])
        near_sup = (df["low"] - s["last_sl"]).abs() <= p["touch_atr"] * a
        near_res = (df["high"] - s["last_sh"]).abs() <= p["touch_atr"] * a
        bounce_up = near_sup & (df["close"] > s["last_sl"]) & cf["bull_reject"]
        bounce_dn = near_res & (df["close"] < s["last_sh"]) & cf["bear_reject"]
        # breakout & retest: closed above the prior swing high within N bars, now retesting it
        lvl_h, lvl_l = s["last_sh"].shift(1), s["last_sl"].shift(1)
        broke_up = (df["close"] > lvl_h).rolling(p["retest_bars"], min_periods=1).max().astype(bool)
        broke_dn = (df["close"] < lvl_l).rolling(p["retest_bars"], min_periods=1).max().astype(bool)
        retest_up = broke_up & (df["low"] <= lvl_h + p["touch_atr"] * a) & (df["close"] > lvl_h) & (cf["bull_reject"] | cf["bull_engulf"])
        retest_dn = broke_dn & (df["high"] >= lvl_l - p["touch_atr"] * a) & (df["close"] < lvl_l) & (cf["bear_reject"] | cf["bear_engulf"])
        up = bull_struct & (bounce_up | retest_up)
        dn = bear_struct & (bounce_dn | retest_dn)
        d = pd.Series(np.where(up, 1, np.where(dn, -1, 0)), index=df.index)
        comps = {"bullish_or_bearish_structure": d != 0, "sr_bounce": _pick(d, bounce_up, bounce_dn),
                 "breakout_retest": _pick(d, retest_up, retest_dn),
                 "engulfing": _pick(d, cf["bull_engulf"], cf["bear_engulf"]),
                 "rejection_candle": _pick(d, cf["bull_reject"], cf["bear_reject"]),
                 "ema_trend_agrees": _pick(d, f["ema21"] > f["ema50"], f["ema21"] < f["ema50"])}
        score = combine(comps, {"bullish_or_bearish_structure": 12, "sr_bounce": 10, "breakout_retest": 14,
                                "engulfing": 8, "rejection_candle": 6, "ema_trend_agrees": 10})
        return output(df.index, d, score, comps)


class Scalping(Strategy):
    id, name = "scalping", "Scalping"
    description = "Fast EMA momentum with RSI confirmation and a volatility window filter (short durations)."
    default_params = {"fast": 5, "slow": 13, "mom_bars": 3, "mom_atr": 0.6, "rsi_lo": 50, "rsi_hi": 70,
                      "vol_min_pct": 0.2, "vol_max_pct": 0.9}
    param_space = {"mom_atr": [0.4, 0.6, 0.9], "mom_bars": [2, 3, 5], "vol_max_pct": [0.8, 0.9, 0.95]}
    min_bars = 220

    def generate(self, df, f, p):
        c = df["close"]
        ef, es = ind.ema(c, p["fast"]), ind.ema(c, p["slow"])
        mom = (c - c.shift(p["mom_bars"])) / f["atr"]
        vol_rank = (f["atr"] / c).rolling(200, min_periods=50).rank(pct=True)
        vol_ok = (vol_rank >= p["vol_min_pct"]) & (vol_rank <= p["vol_max_pct"])
        micro_up = (ef > es) & (ef > ef.shift(2))
        micro_dn = (ef < es) & (ef < ef.shift(2))
        rsi_up = f["rsi"].between(p["rsi_lo"], p["rsi_hi"])
        rsi_dn = f["rsi"].between(100 - p["rsi_hi"], 100 - p["rsi_lo"])
        up = micro_up & (mom >= p["mom_atr"]) & rsi_up & vol_ok
        dn = micro_dn & (mom <= -p["mom_atr"]) & rsi_dn & vol_ok
        d = pd.Series(np.where(up, 1, np.where(dn, -1, 0)), index=df.index)
        comps = {"micro_trend": d != 0, "strong_momentum": (mom.abs() >= 1.5 * p["mom_atr"]) & (d != 0),
                 "rsi_confirms": d != 0, "volatility_ok": vol_ok & (d != 0),
                 "stoch_agrees": _pick(d, f["stoch_k"] > f["stoch_d"], f["stoch_k"] < f["stoch_d"])}
        score = combine(comps, {"micro_trend": 12, "strong_momentum": 14, "rsi_confirms": 8,
                                "volatility_ok": 8, "stoch_agrees": 8})
        return output(df.index, d, score, comps)


class Reversal(Strategy):
    id, name = "reversal", "Reversal"
    description = "RSI/MACD divergence at exhausted extremes with rejection candles near S/R."
    default_params = {"swing_k": 3, "rsi_os": 30, "rsi_ob": 70, "extreme_lookback": 5, "near_atr": 0.6}
    param_space = {"rsi_os": [25, 30, 35], "extreme_lookback": [3, 5, 8], "near_atr": [0.4, 0.6, 1.0]}

    def generate(self, df, f, p):
        k = p["swing_k"]
        s = confirmed_swings(df, k)
        cf = candle_flags(df)
        rsi, mh = f["rsi"], f["macd_hist"]
        # oscillator value at each confirmed pivot (pivot bar = t-k)
        rsi_at = rsi.shift(k)
        mh_at = mh.shift(k)
        rsi_sl = rsi_at.where(s["new_sl"]).ffill()
        rsi_sl_prev = rsi_at.where(s["new_sl"]).dropna().shift(1).reindex(df.index).ffill()
        rsi_sh = rsi_at.where(s["new_sh"]).ffill()
        rsi_sh_prev = rsi_at.where(s["new_sh"]).dropna().shift(1).reindex(df.index).ffill()
        mh_sl = mh_at.where(s["new_sl"]).ffill()
        mh_sl_prev = mh_at.where(s["new_sl"]).dropna().shift(1).reindex(df.index).ffill()
        mh_sh = mh_at.where(s["new_sh"]).ffill()
        mh_sh_prev = mh_at.where(s["new_sh"]).dropna().shift(1).reindex(df.index).ffill()
        fresh_low = s["new_sl"].rolling(k + 3, min_periods=1).max().astype(bool)
        fresh_high = s["new_sh"].rolling(k + 3, min_periods=1).max().astype(bool)
        bull_rsi_div = fresh_low & (s["last_sl"] < s["prev_sl"]) & (rsi_sl > rsi_sl_prev)
        bear_rsi_div = fresh_high & (s["last_sh"] > s["prev_sh"]) & (rsi_sh < rsi_sh_prev)
        bull_macd_div = fresh_low & (s["last_sl"] < s["prev_sl"]) & (mh_sl > mh_sl_prev)
        bear_macd_div = fresh_high & (s["last_sh"] > s["prev_sh"]) & (mh_sh < mh_sh_prev)
        lb = p["extreme_lookback"]
        oversold = (rsi < p["rsi_os"]).rolling(lb, min_periods=1).max().astype(bool)
        overbought = (rsi > p["rsi_ob"]).rolling(lb, min_periods=1).max().astype(bool)
        stoch_up = (f["stoch_k"] > f["stoch_d"]) & (f["stoch_k"].shift() <= f["stoch_d"].shift()) & (f["stoch_k"] < 40)
        stoch_dn = (f["stoch_k"] < f["stoch_d"]) & (f["stoch_k"].shift() >= f["stoch_d"].shift()) & (f["stoch_k"] > 60)
        near_sup = (df["low"] - s["last_sl"]).abs() <= p["near_atr"] * f["atr"]
        near_res = (df["high"] - s["last_sh"]).abs() <= p["near_atr"] * f["atr"]
        exhaustion_up = (f["macd_hist"] > f["macd_hist"].shift()) & (f["macd_hist"] < 0)
        exhaustion_dn = (f["macd_hist"] < f["macd_hist"].shift()) & (f["macd_hist"] > 0)
        up = oversold & (bull_rsi_div | bull_macd_div) & (cf["bull_reject"] | cf["bull_engulf"] | stoch_up)
        dn = overbought & (bear_rsi_div | bear_macd_div) & (cf["bear_reject"] | cf["bear_engulf"] | stoch_dn)
        d = pd.Series(np.where(up, 1, np.where(dn, -1, 0)), index=df.index)
        comps = {"rsi_divergence": _pick(d, bull_rsi_div, bear_rsi_div),
                 "macd_divergence": _pick(d, bull_macd_div, bear_macd_div),
                 "extreme_rsi": d != 0, "reversal_candle": _pick(d, cf["bull_reject"] | cf["bull_engulf"],
                                                                cf["bear_reject"] | cf["bear_engulf"]),
                 "sr_rejection": _pick(d, near_sup, near_res), "momentum_exhaustion": _pick(d, exhaustion_up, exhaustion_dn),
                 "stochastic_cross": _pick(d, stoch_up, stoch_dn)}
        score = combine(comps, {"rsi_divergence": 10, "macd_divergence": 10, "extreme_rsi": 5,
                                "reversal_candle": 8, "sr_rejection": 10, "momentum_exhaustion": 7,
                                "stochastic_cross": 6}, base=30)
        return output(df.index, d, score, comps)


class Breakout(Strategy):
    id, name = "breakout", "Breakout"
    description = "Donchian range breakout after a tight consolidation, with false-breakout filters."
    default_params = {"range_n": 20, "max_width_atr": 4.0, "min_close_beyond_atr": 0.15, "min_body": 0.55,
                      "fail_lookback": 30}
    param_space = {"range_n": [15, 20, 30], "max_width_atr": [3.0, 4.0, 5.0], "min_close_beyond_atr": [0.1, 0.15, 0.3]}

    def generate(self, df, f, p):
        dc = ind.donchian(df, p["range_n"])
        a = f["atr"]
        width = (dc["upper"] - dc["lower"]) / a
        tight = width <= p["max_width_atr"]
        rng = (df["high"] - df["low"]).replace(0, np.nan)
        body_ratio = (df["close"] - df["open"]).abs() / rng
        up_brk = (df["close"] > dc["upper"] + p["min_close_beyond_atr"] * a) & (body_ratio >= p["min_body"]) & (df["close"] > df["open"])
        dn_brk = (df["close"] < dc["lower"] - p["min_close_beyond_atr"] * a) & (body_ratio >= p["min_body"]) & (df["close"] < df["open"])
        # false-breakout memory: previous breakouts that closed back inside within 3 bars
        raw_up = df["close"] > dc["upper"]
        raw_dn = df["close"] < dc["lower"]
        failed_up = raw_up.shift(3).fillna(False).astype(bool) & (df["close"] < dc["upper"].shift(3))
        failed_dn = raw_dn.shift(3).fillna(False).astype(bool) & (df["close"] > dc["lower"].shift(3))
        fails = (failed_up | failed_dn).rolling(p["fail_lookback"], min_periods=1).sum()
        clean = fails < 2
        expanding_vol = f["atr"] > f["atr"].shift(3)
        up = tight.shift(1).fillna(False).astype(bool) & up_brk & clean
        dn = tight.shift(1).fillna(False).astype(bool) & dn_brk & clean
        d = pd.Series(np.where(up, 1, np.where(dn, -1, 0)), index=df.index)
        comps = {"consolidation": d != 0, "decisive_close": d != 0,
                 "very_tight_range": (width.shift(1) <= p["max_width_atr"] * 0.7) & (d != 0),
                 "no_recent_false_breaks": (fails == 0) & (d != 0), "volatility_expanding": expanding_vol & (d != 0),
                 "macd_agrees": _pick(d, f["macd_hist"] > 0, f["macd_hist"] < 0),
                 "htf_aligned": _pick(d, htf_trend(df, 4) > 0, htf_trend(df, 4) < 0)}
        score = combine(comps, {"consolidation": 6, "decisive_close": 8, "very_tight_range": 10,
                                "no_recent_false_breaks": 8, "volatility_expanding": 6, "macd_agrees": 8,
                                "htf_aligned": 10})
        return output(df.index, d, score, comps)


class Volatility(Strategy):
    id, name = "volatility", "Volatility"
    description = "Bollinger squeeze (contraction) followed by ATR-confirmed expansion in the momentum direction."
    default_params = {"squeeze_pct": 0.2, "squeeze_lookback": 10, "atr_rise_bars": 3}
    param_space = {"squeeze_pct": [0.1, 0.2, 0.3], "squeeze_lookback": [5, 10, 20]}

    def generate(self, df, f, p):
        bbw_rank = f["bb_width"].rolling(200, min_periods=50).rank(pct=True)
        squeezed = (bbw_rank <= p["squeeze_pct"]).rolling(p["squeeze_lookback"], min_periods=1).max().astype(bool)
        expanding = (f["bb_width"] > f["bb_width"].shift()) & (f["atr"] > f["atr"].shift(p["atr_rise_bars"]))
        up_out = df["close"] > f["bb_upper"]
        dn_out = df["close"] < f["bb_lower"]
        mom_up = (f["macd_hist"] > 0) & (f["macd_hist"] > f["macd_hist"].shift())
        mom_dn = (f["macd_hist"] < 0) & (f["macd_hist"] < f["macd_hist"].shift())
        up = squeezed.shift(1).fillna(False).astype(bool) & expanding & up_out & mom_up
        dn = squeezed.shift(1).fillna(False).astype(bool) & expanding & dn_out & mom_dn
        d = pd.Series(np.where(up, 1, np.where(dn, -1, 0)), index=df.index)
        comps = {"squeeze": d != 0, "expansion": d != 0, "momentum_confirms": d != 0,
                 "psar_agrees": _pick(d, f["psar_trend"] > 0, f["psar_trend"] < 0),
                 "ichimoku_agrees": _pick(d, df["close"] > np.fmax(f["ichi_span_a"], f["ichi_span_b"]),
                                          df["close"] < np.fmin(f["ichi_span_a"], f["ichi_span_b"])),
                 "cci_strong": _pick(d, f["cci"] > 100, f["cci"] < -100)}
        score = combine(comps, {"squeeze": 6, "expansion": 6, "momentum_confirms": 6, "psar_agrees": 10,
                                "ichimoku_agrees": 12, "cci_strong": 8})
        return output(df.index, d, score, comps)


STRATEGIES: dict[str, Strategy] = {s.id: s for s in
                                   (TrendFollowing(), PriceAction(), Scalping(), Reversal(), Breakout(), Volatility())}
