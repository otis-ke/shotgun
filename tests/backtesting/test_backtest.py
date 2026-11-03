import numpy as np
import pandas as pd

from backend.ai_engine import optimizer
from backend.ai_engine.calibration import Calibrator, expected_value
from backend.ai_engine.memory import PerformanceMemory
from backend.ai_engine.smart_bot import decide
from backend.backtesting.engine import BTConfig, run, stats, walk_forward
from backend.strategies.base import Signal, Strategy, output
from backend.strategies.library import STRATEGIES
from tests.conftest import make_ohlc


class EveryN(Strategy):
    id, name, min_bars = "every_n", "test", 5
    default_params = {"n": 10}

    def generate(self, df, f, p):
        d = pd.Series(np.where(np.arange(len(df)) % p["n"] == 0, 1, 0), index=df.index)
        return output(df.index, d, pd.Series(80.0, index=df.index), {})


def _df(closes, opens=None):
    c = np.array(closes, float)
    o = np.array(opens if opens is not None else np.r_[c[0], c[:-1]], float)
    return pd.DataFrame({"open": o, "high": np.maximum(o, c) + 0.01, "low": np.minimum(o, c) - 0.01, "close": c},
                        index=np.arange(len(c)) * 60)


def test_entry_is_next_bar_open_and_ties_lose():
    closes = [100.0] * 40
    df = _df(closes)
    r = run(df, EveryN(), {"n": 10}, BTConfig(duration_bars=2, payout_ratio=0.9, fixed_stake=1))
    assert r.trades and all(not t.won for t in r.trades)          # flat market -> equal -> loss
    t = r.trades[0]
    assert t.entry == df["open"].iloc[t.i + 1]


def test_rising_market_wins_with_payout():
    df = _df(list(np.linspace(100, 140, 60)))
    r = run(df, EveryN(), {"n": 10}, BTConfig(duration_bars=3, payout_ratio=0.9, fixed_stake=2))
    assert all(t.won for t in r.trades)
    assert abs(r.trades[0].profit - 1.8) < 1e-9


def test_no_overlapping_positions():
    df = _df(list(np.linspace(100, 140, 100)))
    r = run(df, EveryN(), {"n": 1}, BTConfig(duration_bars=5, fixed_stake=1))
    idx = [t.i for t in r.trades]
    assert all(b - a >= 5 for a, b in zip(idx, idx[1:]))


def test_stats():
    trades = [{"profit": 0.9, "stake": 1}, {"profit": -1, "stake": 1}, {"profit": -1, "stake": 1},
              {"profit": 0.9, "stake": 1}]
    s = stats(trades, 100)
    assert s["win_rate"] == 0.5 and s["max_consecutive_losses"] == 2
    assert s["profit_factor"] == 0.9 and s["net_profit"] == -0.2


def test_multiplier_stop_loss_first():
    df = _df([100.0] * 40)
    df.loc[df.index[21], "low"] = 90     # first trade signalled at bar 20 (ATR warm-up), entered at 21
    df.loc[df.index[21], "high"] = 110
    r = run(df, EveryN(), {"n": 10}, BTConfig(family="multiplier", multiplier=10, sl_pct=50, tp_pct=50,
                                               duration_bars=3, fixed_stake=10))
    assert r.trades[0].profit == -5.0


def test_walk_forward_only_oos(tmp_path):
    df = make_ohlc(4000, seed=5)
    wf = walk_forward(df, STRATEGIES["scalping"], BTConfig(duration_bars=3), folds=3, max_combos=4)
    assert len(wf["windows"]) == 3
    first_test = wf["windows"][0]["test_from"]
    assert all(df.index[i] >= first_test for i, _ in wf["oos_index"])
    assert wf["oos_stats"]["trades"] == len(wf["calibration_pairs"])


def test_random_walk_not_profitable_after_payout():
    """Sanity: on a pure random walk the OOS expectancy should not be meaningfully positive."""
    df = make_ohlc(5000, seed=21, drift_blocks=False)
    wf = walk_forward(df, STRATEGIES["scalping"], BTConfig(duration_bars=3, payout_ratio=0.9), folds=3, max_combos=6)
    assert (wf["oos_stats"]["expectancy_per_stake"] or 0) < 0.1


def test_calibrator_shrinks_small_samples():
    c = Calibrator().fit([(90, True)] * 5 + [(50, False)] * 5)
    assert not c.ready
    c2 = Calibrator().fit([(s, s > 60) for s in range(30, 100)] * 2)
    assert c2.ready and c2.p_win(95) > c2.p_win(35)
    assert expected_value(0.55, 0.9) == round(0.55 * 0.9 - 0.45, 4)


def test_smart_ai_stands_aside_on_conflict_and_uncalibrated():
    sig = {"trend": Signal("trend", "UP", 80, []), "reversal": Signal("reversal", "DOWN", 80, [])}
    d = decide(sig, "ranging", None, PerformanceMemory(), 0.9, allow_uncalibrated=False)
    assert not d.trade
    d2 = decide({"trend": Signal("trend", "UP", 80, [])}, "trending_up", 1, PerformanceMemory(), 0.9)
    assert not d2.trade and "validation" in " ".join(d2.reasons)


def test_config_versioning_and_deploy_rules(ohlc):
    optimizer.seed_defaults(None)
    v1 = optimizer.active(None, "scalping")["_version"]
    optimizer.update_operational(None, "scalping", {"min_confidence": 75})
    assert optimizer.active(None, "scalping")["min_confidence"] == 75
    import pytest
    with pytest.raises(ValueError):
        optimizer.update_operational(None, "scalping", {"params": {"fast": 3}})   # needs validation
    res = optimizer.validate(None, "scalping", make_ohlc(3000, seed=9), folds=2)
    assert res["status"] in ("proposed", "rejected")
    if res["status"] == "rejected":
        with pytest.raises(PermissionError):
            optimizer.deploy(None, "scalping", res["version"])
    optimizer.deploy(None, "scalping", v1)   # restore a previously active version
    assert optimizer.active(None, "scalping")["_version"] == v1
