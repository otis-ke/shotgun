"""Deriv contract-type catalogue and proposal builders.

Each contract family has its own validation rules and maximum-loss semantics. For every
option-style contract (Rise/Fall, Higher/Lower, Touch, Digits) the max loss is the stake.
Multipliers can lose at most the stake (stop-out), with optional stop_loss/take_profit.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Literal

Direction = Literal["UP", "DOWN"]

FAMILIES = {
    "rise_fall": {"UP": "CALL", "DOWN": "PUT", "barrier": False},
    "higher_lower": {"UP": "CALL", "DOWN": "PUT", "barrier": True},
    "touch": {"UP": "ONETOUCH", "DOWN": "ONETOUCH", "barrier": True},
    "no_touch": {"UP": "NOTOUCH", "DOWN": "NOTOUCH", "barrier": True},
    "digits_over_under": {"UP": "DIGITOVER", "DOWN": "DIGITUNDER", "digit": True},
    "digits_even_odd": {"UP": "DIGITEVEN", "DOWN": "DIGITODD", "digit": False},
    "multiplier": {"UP": "MULTUP", "DOWN": "MULTDOWN"},
}


@dataclass
class ContractSpec:
    family: str = "rise_fall"
    duration: int = 5
    duration_unit: str = "m"          # t, s, m, h, d
    barrier_atr_mult: float = 0.0     # higher/lower & touch: barrier offset = mult * ATR
    digit: int | None = None          # digits over/under prediction
    multiplier: int | None = None     # e.g. 10, 20, 50, 100
    sl_pct_of_stake: float | None = None   # multipliers: stop loss as % of stake
    tp_pct_of_stake: float | None = None   # multipliers: take profit as % of stake

    @classmethod
    def from_dict(cls, d: dict | None) -> "ContractSpec":
        d = d or {}
        return cls(**{k: v for k, v in d.items() if k in cls.__dataclass_fields__})


class ContractValidationError(ValueError):
    pass


def validate(spec: ContractSpec) -> None:
    if spec.family not in FAMILIES:
        raise ContractValidationError(f"unknown contract family {spec.family}")
    if spec.family == "multiplier":
        if not spec.multiplier:
            raise ContractValidationError("multiplier contracts need a multiplier value")
        return
    if spec.duration <= 0:
        raise ContractValidationError("duration must be positive")
    if spec.family.startswith("digits") and spec.duration_unit != "t":
        raise ContractValidationError("digit contracts use tick durations")
    if spec.family in ("touch", "no_touch", "higher_lower") and spec.barrier_atr_mult <= 0:
        raise ContractValidationError(f"{spec.family} needs barrier_atr_mult > 0")
    if spec.family == "digits_over_under" and (spec.digit is None or not 0 <= spec.digit <= 9):
        raise ContractValidationError("digits_over_under needs digit 0-9")


def build_proposal(spec: ContractSpec, direction: Direction, symbol: str, stake: float,
                   currency: str, atr: float | None = None, pip: int = 2) -> dict:
    validate(spec)
    fam = FAMILIES[spec.family]
    p: dict = {"amount": round(stake, 2), "basis": "stake", "currency": currency,
               "symbol": symbol, "contract_type": fam[direction]}
    if spec.family == "multiplier":
        p["multiplier"] = spec.multiplier
        lo = {}
        if spec.sl_pct_of_stake:
            lo["stop_loss"] = round(stake * spec.sl_pct_of_stake / 100, 2)
        if spec.tp_pct_of_stake:
            lo["take_profit"] = round(stake * spec.tp_pct_of_stake / 100, 2)
        if lo:
            p["limit_order"] = lo
        return p
    p["duration"] = spec.duration
    p["duration_unit"] = spec.duration_unit
    if fam.get("barrier"):
        if not atr:
            raise ContractValidationError("ATR required to place barrier")
        off = round(spec.barrier_atr_mult * atr, pip)
        sign = "+" if direction == "UP" else "-"
        if spec.family == "higher_lower":  # UP => Higher than a barrier below spot (more likely), configurable via sign
            sign = "-" if direction == "UP" else "+"
        p["barrier"] = f"{sign}{off}"
    if spec.family == "digits_over_under":
        p["barrier"] = str(spec.digit)
    return p


def max_loss(spec: ContractSpec, stake: float) -> float:
    """Worst-case loss of a single contract. Always the stake on Deriv option/multiplier products."""
    return stake
