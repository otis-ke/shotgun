"""Turns raw strategy scores into calibrated win probabilities from OUT-OF-SAMPLE outcomes.

The raw 0-100 setup score says how many confirmations lined up. It is *not* a probability.
The calibrator maps score -> empirical win rate using isotonic regression on walk-forward OOS
backtest trades plus live/demo results, shrunk toward the global win rate with a Beta prior so
small samples cannot produce over-confident numbers.
"""
from __future__ import annotations

import numpy as np
from sklearn.isotonic import IsotonicRegression


class Calibrator:
    def __init__(self, prior_strength: float = 20.0, min_samples: int = 30):
        self.prior_strength = prior_strength
        self.min_samples = min_samples
        self.n = 0
        self.base_rate: float | None = None
        self._iso: IsotonicRegression | None = None
        self._bins: list[tuple[float, float, int]] = []

    def fit(self, pairs: list[tuple[float, bool]]) -> "Calibrator":
        self.n = len(pairs)
        if not pairs:
            return self
        x = np.array([p[0] for p in pairs], float)
        y = np.array([1.0 if p[1] else 0.0 for p in pairs])
        self.base_rate = float(y.mean())
        if self.n >= self.min_samples and len(np.unique(x)) > 1:
            self._iso = IsotonicRegression(y_min=0, y_max=1, out_of_bounds="clip").fit(x, y)
        edges = np.quantile(x, np.linspace(0, 1, 6)) if self.n >= 10 else np.array([x.min(), x.max()])
        self._bins = []
        for lo, hi in zip(edges[:-1], edges[1:]):
            m = (x >= lo) & (x <= hi)
            if m.any():
                self._bins.append((float(lo), float(y[m].mean()), int(m.sum())))
        return self

    @property
    def ready(self) -> bool:
        return self.n >= self.min_samples

    def p_win(self, score: float) -> float | None:
        if self.base_rate is None:
            return None
        raw = float(self._iso.predict([score])[0]) if self._iso is not None else self.base_rate
        # local sample size ~ n / 5 per region; shrink toward base rate
        local_n = max(1.0, self.n / 5)
        w = local_n / (local_n + self.prior_strength)
        return round(w * raw + (1 - w) * self.base_rate, 4)

    def describe(self) -> dict:
        return {"samples": self.n, "ready": self.ready, "base_win_rate": self.base_rate,
                "bins": [{"score_from": b[0], "win_rate": round(b[1], 4), "n": b[2]} for b in self._bins]}


def expected_value(p_win: float | None, payout_ratio: float) -> float | None:
    """EV per unit stake of an option contract: p*payout - (1-p)."""
    if p_win is None:
        return None
    return round(p_win * payout_ratio - (1 - p_win), 4)
