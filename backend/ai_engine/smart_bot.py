"""Bot 7 - Smart AI meta-strategy.

Reads the signals of the six specialists on the same closed candle and decides whether a
trade is worth taking at all. It never sizes trades or touches risk limits - its output goes
through exactly the same risk manager as every other bot.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from ..strategies.base import Signal
from .calibration import expected_value
from .memory import PerformanceMemory

# prior belief on where each specialist works; overridden by evidence as samples accumulate
REGIME_AFFINITY = {
    "trend": {"trending_up": 1.0, "trending_down": 1.0, "ranging": 0.2, "quiet": 0.3, "volatile": 0.5},
    "price_action": {"trending_up": 0.8, "trending_down": 0.8, "ranging": 0.8, "quiet": 0.6, "volatile": 0.5},
    "scalping": {"trending_up": 0.8, "trending_down": 0.8, "ranging": 0.4, "quiet": 0.2, "volatile": 0.7},
    "reversal": {"trending_up": 0.3, "trending_down": 0.3, "ranging": 1.0, "quiet": 0.5, "volatile": 0.6},
    "breakout": {"trending_up": 0.6, "trending_down": 0.6, "ranging": 0.7, "quiet": 1.0, "volatile": 0.4},
    "volatility": {"trending_up": 0.6, "trending_down": 0.6, "ranging": 0.6, "quiet": 1.0, "volatile": 0.7},
}


@dataclass
class Decision:
    trade: bool
    direction: str | None = None
    strategy: str | None = None
    confidence: float = 0.0
    p_win: float | None = None
    ev: float | None = None
    reasons: list[str] = field(default_factory=list)
    votes: dict = field(default_factory=dict)


def decide(signals: dict[str, Signal | None], regime: str, htf_trend: int | None, memory: PerformanceMemory,
           payout_ratio: float, min_agree: int = 2, min_ev: float = 0.02, allow_uncalibrated: bool = False) -> Decision:
    be = 1 / (1 + payout_ratio)
    live = {k: s for k, s in signals.items() if s is not None}
    reasons: list[str] = [f"regime={regime}", f"breakeven win rate={be:.1%}"]
    if not live:
        return Decision(False, reasons=reasons + ["no specialist has a setup"])

    scored = []
    for sid, s in live.items():
        cal = memory.calibrator(sid)
        p_cal = cal.p_win(s.score) if cal.ready else None
        p_reg, n_reg = memory.regime_posterior(sid, regime, prior_p=be)
        aff = REGIME_AFFINITY.get(sid, {}).get(regime, 0.5)
        if p_cal is not None:
            # evidence-weighted blend of score calibration and regime track record
            w_reg = n_reg / (n_reg + 30)
            p = (1 - w_reg) * p_cal + w_reg * p_reg
        else:
            p = None
        edge = (p - be) if p is not None else None
        weight = (max(edge, 0) * math.sqrt(min(cal.n, 400)) * (0.5 + aff)) if edge is not None else 0.0
        scored.append({"strategy": sid, "dir": s.direction, "score": s.score, "p": p, "edge": edge,
                       "weight": weight, "affinity": aff, "samples": cal.n})

    up = [x for x in scored if x["dir"] == "UP"]
    dn = [x for x in scored if x["dir"] == "DOWN"]
    w_up, w_dn = sum(x["weight"] for x in up), sum(x["weight"] for x in dn)
    votes = {"up": [x["strategy"] for x in up], "down": [x["strategy"] for x in dn],
             "weight_up": round(w_up, 4), "weight_down": round(w_dn, 4), "detail": scored}

    if up and dn:
        strong_up = any((x["edge"] or 0) > 0 for x in up)
        strong_dn = any((x["edge"] or 0) > 0 for x in dn)
        if (strong_up and strong_dn) or (not strong_up and not strong_dn):
            return Decision(False, reasons=reasons + ["conflicting specialist signals - standing aside"], votes=votes)
    side = up if (w_up > w_dn or (w_up == w_dn and len(up) > len(dn))) else dn
    direction = side[0]["dir"]
    if htf_trend is not None and htf_trend != 0 and ((htf_trend > 0) != (direction == "UP")):
        if len(side) < 3:
            return Decision(False, reasons=reasons + ["signal against higher-timeframe trend"], votes=votes)
        reasons.append("against HTF trend but 3+ specialists agree")

    best = max(side, key=lambda x: (x["p"] if x["p"] is not None else -1, x["score"]))
    calibrated = best["p"] is not None
    if not calibrated and not allow_uncalibrated:
        return Decision(False, reasons=reasons + ["no out-of-sample validation yet for "
                                                  f"{best['strategy']} - run a walk-forward first"], votes=votes)
    agree = len(side)
    ev = expected_value(best["p"], payout_ratio) if calibrated else None
    if agree < min_agree and (ev is None or ev < min_ev * 2):
        return Decision(False, reasons=reasons + [f"only {agree} specialist(s) agree and edge is not exceptional"],
                        votes=votes)
    if ev is not None and ev < min_ev:
        return Decision(False, reasons=reasons + [f"calibrated EV {ev:+.3f} below minimum {min_ev:+.3f}"], votes=votes)
    if best["affinity"] < 0.3 and agree < 3:
        return Decision(False, reasons=reasons + [f"{best['strategy']} historically weak in {regime}"], votes=votes)

    conf = 0.55 * best["score"] + 8 * (agree - 1) + (250 * ev if ev else 0)
    conf = max(0.0, min(100.0, conf))
    reasons += [f"{agree} specialist(s) agree on {direction}: {', '.join(x['strategy'] for x in side)}",
                f"lead strategy {best['strategy']} (score {best['score']:.0f}, "
                f"p_win {best['p']:.1%})" if calibrated else f"lead strategy {best['strategy']} (uncalibrated)"]
    if ev is not None:
        reasons.append(f"expected value {ev:+.3f} per unit stake")
    return Decision(True, direction, best["strategy"], round(conf, 1), best["p"], ev, reasons, votes)
