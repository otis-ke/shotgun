import numpy as np
import pandas as pd
import pytest

from backend import indicators as ind
from backend.analysis import analyze, candle_patterns, market_structure, regime_series
from backend.strategies.library import STRATEGIES
from tests.conftest import make_ohlc


def test_ema_matches_pandas(ohlc):
    e = ind.ema(ohlc["close"], 21)
    ref = ohlc["close"].ewm(span=21, adjust=False).mean()
    assert np.allclose(e.dropna(), ref[e.notna()])


def test_rsi_bounds(ohlc):
    r = ind.rsi(ohlc["close"]).dropna()
    assert r.between(0, 100).all() and len(r) > 2900


def test_rsi_all_gains_is_100():
    s = pd.Series(np.arange(1, 60, dtype=float))
    assert ind.rsi(s).dropna().iloc[-1] == 100


def test_atr_adx_bb_shapes(ohlc):
    f = ind.compute_all(ohlc)
    assert (f["atr"].dropna() > 0).all()
    assert f["adx"].dropna().between(0, 100).all()
    assert (f["bb_upper"].dropna() >= f["bb_lower"].dropna()).all()
    assert f["stoch_k"].dropna().between(0, 100).all()
    assert set(f["psar_trend"].unique()) <= {-1, 0, 1}


def test_donchian_uses_previous_bars(ohlc):
    d = ind.donchian(ohlc, 20)
    assert d["upper"].iloc[100] == ohlc["high"].iloc[80:100].max()


def test_vwap_requires_volume(ohlc):
    assert ind.vwap(ohlc) is None
    v = ohlc.assign(volume=1.0)
    assert ind.vwap(v) is not None


@pytest.mark.parametrize("sid", list(STRATEGIES))
def test_strategy_is_causal(sid):
    """Signals up to bar t must be identical whether or not future bars exist."""
    df = make_ohlc(2500, seed=11)
    s = STRATEGIES[sid]
    full = s.generate(df, ind.compute_all(df), s.params())
    cut = 1800
    part = s.generate(df.iloc[:cut], ind.compute_all(df.iloc[:cut]), s.params())
    assert (full["dir"].iloc[:cut].values == part["dir"].values).all()
    assert np.allclose(full["score"].iloc[:cut].values, part["score"].values)


@pytest.mark.parametrize("sid", list(STRATEGIES))
def test_strategy_scores_in_range(sid, ohlc):
    s = STRATEGIES[sid]
    g = s.generate(ohlc, ind.compute_all(ohlc), s.params())
    assert g["score"].between(0, 100).all()
    assert set(g["dir"].unique()) <= {-1, 0, 1}
    assert (g.loc[g.dir == 0, "score"] == 0).all()


def test_analysis_snapshot(ohlc):
    snap = analyze("R_100", 60, ohlc).to_dict()
    assert snap["regime"]["name"] in {"trending_up", "trending_down", "ranging", "volatile", "quiet"}
    assert snap["structure"]["structure"] in {"bullish", "bearish", "ranging", "undefined"}
    assert isinstance(snap["levels"], list)


def test_regime_series_causal(ohlc):
    f = ind.compute_all(ohlc)
    a = regime_series(f).iloc[:2000]
    b = regime_series(ind.compute_all(ohlc.iloc[:2000]))
    assert (a.values == b.values).all()


def test_engulfing_detection():
    df = pd.DataFrame({"open": [10, 10.5, 9.8], "high": [10.6, 10.6, 11], "low": [9.9, 9.9, 9.7],
                       "close": [10.5, 10.0, 10.8]})
    assert candle_patterns(df)["bullish_engulfing"]


def test_market_structure_bullish():
    segs = [(0, 5, 10), (5, 3, 8), (3, 8, 10), (8, 6, 8), (6, 10, 10), (10, 9, 6)]
    x = np.concatenate([np.linspace(a, b, n)[(1 if i else 0):] for i, (a, b, n) in enumerate(segs)])
    df = pd.DataFrame({"open": x, "high": x + 0.1, "low": x - 0.1, "close": x})
    assert market_structure(df, k=2)["structure"] == "bullish"
