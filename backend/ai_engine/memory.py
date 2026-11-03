"""Performance memory: what has each strategy actually achieved, overall and per market regime.

Sources: (1) out-of-sample walk-forward pairs saved at validation time and (2) recorded
demo/live trades. Results are cached and refreshed after every settled trade.
"""
from __future__ import annotations

import math
import threading
import time
from collections import defaultdict

from .. import database as db
from .calibration import Calibrator


class PerformanceMemory:
    """Per-user: each user validates their own configurations and owns their own trade record."""
    def __init__(self, user_id: str | None = None):
        self.uid = user_id
        self._cal: dict[str, Calibrator] = {}
        self._regime: dict[str, dict[str, list[int]]] = {}
        self._lock = threading.Lock()
        self._built = 0.0

    def refresh(self) -> None:
        trades = db.rows(db.select(db.trades.c.bot_id, db.trades.c.confidence, db.trades.c.regime,
                                   db.trades.c.status, db.trades.c.features)
                         .where(db.trades.c.status.in_(["won", "lost", "sold"]) &
                                ((db.trades.c.user_id == self.uid) if self.uid else db.trades.c.user_id.is_(None))))
        pairs: dict[str, list] = defaultdict(list)
        regime: dict[str, dict[str, list[int]]] = defaultdict(lambda: defaultdict(lambda: [0, 0]))
        for t in trades:
            strat = (t.get("features") or {}).get("strategy") or t["bot_id"]
            won = t["status"] == "won"
            raw = (t.get("features") or {}).get("raw_score", t.get("confidence"))
            if raw is not None:
                pairs[strat].append((float(raw), won))
            r = regime[strat][t.get("regime") or "unknown"]
            r[0] += int(won)
            r[1] += 1
        for strat, data in (db.kv_get(db.ukey(self.uid, "validation_pairs"), {}) or {}).items():
            pairs[strat].extend((float(s), bool(w)) for s, w in data)
            for reg, (w, n) in (db.kv_get(db.ukey(self.uid, f"validation_regimes:{strat}"), {}) or {}).items():
                regime[strat][reg][0] += w
                regime[strat][reg][1] += n
        with self._lock:
            self._cal = {s: Calibrator().fit(p) for s, p in pairs.items()}
            self._regime = {s: {k: list(v) for k, v in d.items()} for s, d in regime.items()}
            self._built = time.time()

    def calibrator(self, strategy: str) -> Calibrator:
        if not self._built:
            self.refresh()
        return self._cal.get(strategy) or Calibrator()

    def regime_posterior(self, strategy: str, regime_name: str, prior_p: float = 0.5,
                         prior_n: float = 10.0) -> tuple[float, int]:
        if not self._built:
            self.refresh()
        w, n = self._regime.get(strategy, {}).get(regime_name, [0, 0])
        return (w + prior_p * prior_n) / (n + prior_n), n

    def regime_table(self) -> dict:
        if not self._built:
            self.refresh()
        return {s: {r: {"wins": v[0], "n": v[1], "win_rate": round(v[0] / v[1], 3) if v[1] else None}
                    for r, v in d.items()} for s, d in self._regime.items()}

    def summary(self) -> dict:
        if not self._built:
            self.refresh()
        return {s: c.describe() for s, c in self._cal.items()}


def save_validation(user_id: str | None, strategy: str, pairs: list[tuple[float, bool]],
                    regime_counts: dict | None = None) -> None:
    key = db.ukey(user_id, "validation_pairs")
    allp = db.kv_get(key, {}) or {}
    allp[strategy] = [[float(s), bool(w)] for s, w in pairs][-3000:]
    db.kv_set(key, allp)
    if regime_counts is not None:
        db.kv_set(db.ukey(user_id, f"validation_regimes:{strategy}"), regime_counts)


def binomial_z(wins: int, n: int, p0: float) -> float | None:
    """z-score of observed win rate vs expected p0 (normal approximation)."""
    if n == 0 or p0 <= 0 or p0 >= 1:
        return None
    return (wins / n - p0) / math.sqrt(p0 * (1 - p0) / n)

