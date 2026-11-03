import time

import pytest

from backend import database as db
from backend.deriv.contracts import ContractSpec, ContractValidationError, build_proposal
from backend.risk_management import RiskManager
from backend.security import decrypt, encrypt, issue_session, verify_session


import pytest as _pt


@_pt.fixture(autouse=True)
def _rm():
    global risk_manager
    risk_manager = RiskManager()
    yield


def _trade(cid, status, profit, stake=10.0, t=None, symbol="R_100", direction="UP"):
    t = t or time.time()
    db.execute(db.insert(db.trades).values(contract_id=cid, bot_id="trend", symbol=symbol, stake=stake,
                                           buy_time=t - 60, sell_time=t if status != "open" else None,
                                           status=status, profit=profit, direction=direction))


def test_sizing_is_fraction_of_balance_and_capped():
    assert risk_manager.size(1000) == 10.0
    assert risk_manager.size(100000) == 50.0          # max_stake cap
    assert risk_manager.size(1000, bot_max_stake=4) == 4.0


def test_no_martingale_after_losses():
    s0 = risk_manager.size(1000)
    for i in range(2):
        _trade(f"L{i}", "lost", -10)
    assert risk_manager.size(1000) == s0   # never increases after a loss


def test_consecutive_losses_suspend():
    for i in range(3):
        _trade(f"L{i}", "lost", -1, t=time.time() - 10 + i)
    d = risk_manager.check(balance=1000, symbol="R_100", bot_id="trend")
    assert not d.approved and any("consecutive" in r for r in d.reasons)
    assert risk_manager.suspension() is not None
    risk_manager.resume()
    assert risk_manager.suspension() is None


def test_daily_loss_limit():
    risk_manager.record_balance(1000)
    _trade("A", "lost", -31)
    d = risk_manager.check(balance=969, symbol="R_100", bot_id="trend")
    assert not d.approved and "max daily loss reached" in d.reasons


def test_drawdown_limit():
    risk_manager.record_balance(1000)
    d = risk_manager.check(balance=890, symbol="R_100", bot_id="trend")
    assert not d.approved and "max drawdown reached" in d.reasons


def test_exposure_and_symbol_limits():
    _trade("O1", "open", None, stake=10)
    d = risk_manager.check(balance=1000, symbol="R_100", bot_id="trend")
    assert any("open position on R_100" in r for r in d.reasons)
    d2 = risk_manager.check(balance=1000, symbol="R_50", bot_id="trend")
    assert d2.approved and d2.stake == 10
    risk_manager.reserve("x", "R_75", 10, "trend")
    risk_manager.reserve("y", "R_25", 10, "trend")
    d3 = risk_manager.check(balance=1000, symbol="R_10", bot_id="trend")
    assert not d3.approved  # 3 open/reserved -> max_open_trades & exposure


def test_risk_config_validation():
    with pytest.raises(ValueError):
        risk_manager.update_config({"risk_pct_per_trade": 10})
    with pytest.raises(ValueError):
        risk_manager.update_config({"nonsense": 1})
    assert risk_manager.update_config({"risk_pct_per_trade": 0.5})["risk_pct_per_trade"] == 0.5


def test_encryption_roundtrip():
    enc = encrypt("a1-SecretToken")
    assert "SecretToken" not in enc and decrypt(enc) == "a1-SecretToken"


def test_session():
    tok = issue_session("u1", admin=True)
    assert verify_session(tok)["sub"] == "u1" and verify_session(tok)["adm"]
    assert verify_session(tok[:-2] + "00") is None


def test_contract_builders():
    p = build_proposal(ContractSpec("rise_fall", 5, "m"), "UP", "R_100", 1.234, "USD")
    assert p["contract_type"] == "CALL" and p["amount"] == 1.23 and p["duration_unit"] == "m"
    t = build_proposal(ContractSpec("touch", 5, "m", barrier_atr_mult=2), "DOWN", "R_100", 1, "USD", atr=0.5)
    assert t["contract_type"] == "ONETOUCH" and t["barrier"] == "-1.0"
    m = build_proposal(ContractSpec("multiplier", multiplier=50, sl_pct_of_stake=50, tp_pct_of_stake=100),
                       "DOWN", "R_100", 10, "USD")
    assert m["contract_type"] == "MULTDOWN" and m["limit_order"] == {"stop_loss": 5.0, "take_profit": 10.0}
    with pytest.raises(ContractValidationError):
        build_proposal(ContractSpec("digits_over_under", 5, "m", digit=3), "UP", "R_100", 1, "USD")
    with pytest.raises(ContractValidationError):
        build_proposal(ContractSpec("touch", 5, "m"), "UP", "R_100", 1, "USD", atr=1)
