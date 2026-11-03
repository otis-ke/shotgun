"""Integration: Deriv client, execution engine, reconciliation, bots - against the mock server."""
import asyncio
import time

import pytest

from backend import database as db
from backend.ai_engine import optimizer
from backend.bots.manager import BotManager
from backend.deriv.client import DerivClient, DerivError
from backend.deriv.feed import MarketFeed
from backend.execution import ExecutionEngine, OrderRequest


async def _client(mock, token="demo-token"):
    url, app = mock.url, "1"
    c = DerivClient(url, app, token, request_timeout=5, ping_interval=1)
    c.url = url  # mock ignores query string
    await c.start()
    assert await c.wait_ready(5)
    return c


def _req(**kw):
    base = dict(bot_id="trend", symbol="R_100", direction="UP",
                contract={"family": "rise_fall", "duration": 5, "duration_unit": "m"}, confidence=80,
                payout_assumption=0.9)
    base.update(kw)
    return OrderRequest(**base)


async def test_authorize_and_request(mock_deriv):
    c = await _client(mock_deriv)
    assert c.health.authorized and c.health.is_virtual and c.health.loginid == "VRTC123"
    assert (await c.balance())["balance"] == 10000
    with pytest.raises(DerivError):
        await c.request({"unknown_call": 1})
    await c.stop()


async def test_subscription_survives_reconnect(mock_deriv):
    c = await _client(mock_deriv)
    feed = MarketFeed(c)
    closed = []
    feed.on_candle_closed(lambda s, g, df: closed.append(len(df)))
    await feed.ensure("R_100", 60)
    await asyncio.sleep(0.8)
    n1 = len(closed)
    assert n1 >= 2
    await c._ws.close()                      # simulate network drop
    await asyncio.sleep(2.5)
    assert c.health.reconnects >= 1 and c.health.connected
    assert len(closed) > n1                  # stream resumed automatically
    await c.stop()


async def test_buy_and_settle(mock_deriv):
    c = await _client(mock_deriv)
    exe = ExecutionEngine(c)
    res = await exe.execute(_req())
    assert res.ok and res.status == "BOUGHT", res.message
    assert len(mock_deriv.buys) == 1 and mock_deriv.buys[0]["passthrough"]["coid"] == res.coid
    for _ in range(30):
        await asyncio.sleep(0.1)
        t = db.rows(db.select(db.trades).where(db.trades.c.contract_id == res.contract_id))[0]
        if t["status"] != "open":
            break
    assert t["status"] in ("won", "lost") and t["profit"] is not None
    await c.stop()


async def test_duplicate_signal_is_not_executed_twice(mock_deriv):
    c = await _client(mock_deriv)
    exe = ExecutionEngine(c)
    sid = db.execute(db.insert(db.signals).values(ts=time.time(), bot_id="trend", symbol="R_100",
                                                  direction="UP", status="pending")).inserted_primary_key[0]
    r1 = await exe.execute(_req(signal_id=sid))
    r2 = await exe.execute(_req(signal_id=sid))
    assert r1.ok and r2.status == "DUPLICATE" and len(mock_deriv.buys) == 1
    await c.stop()


async def test_disconnect_during_buy_never_rebuys(mock_deriv):
    c = await _client(mock_deriv)
    exe = ExecutionEngine(c)
    mock_deriv.drop_on_buy = True
    res = await exe.execute(_req())
    assert res.status == "UNKNOWN"
    assert len(mock_deriv.buys) == 1
    mock_deriv.drop_on_buy = False
    # while unresolved, every new order is blocked
    assert await c.wait_ready(5)
    blocked = await exe.execute(_req(symbol="R_50"))
    assert blocked.status == "BLOCKED" and "unresolved" in blocked.message
    out = await exe.reconcile()
    assert out["resolved"] and out["resolved"][0]["contract_id"] == str(mock_deriv.buys[0]["contract_id"])
    o = db.rows(db.select(db.orders).where(db.orders.c.coid == res.coid))[0]
    assert o["status"] == "BOUGHT"
    assert len(mock_deriv.buys) == 1          # reconciliation never re-sends a buy
    assert len(db.rows(db.select(db.trades))) == 1
    await c.stop()


async def test_rejected_buy_is_definitive(mock_deriv):
    c = await _client(mock_deriv)
    exe = ExecutionEngine(c)
    mock_deriv.reject_buy = True
    res = await exe.execute(_req())
    assert res.status == "REJECTED" and not exe.unresolved_orders()
    await c.stop()


async def test_real_account_requires_authorization(mock_deriv):
    mock_deriv.virtual = False
    c = await _client(mock_deriv)
    exe = ExecutionEngine(c)
    res = await exe.execute(_req())
    assert res.status == "BLOCKED" and "not authorized" in res.message
    db.kv_set("real_trading_authorization", {"authorized": True, "loginid": "CR999"})
    res2 = await exe.execute(_req())
    assert res2.ok
    await c.stop()


async def test_emergency_stop_blocks(mock_deriv):
    c = await _client(mock_deriv)
    exe = ExecutionEngine(c)
    db.kv_set("global_stop", {"reason": "test"})
    assert (await exe.execute(_req())).status == "BLOCKED"
    await c.stop()


async def test_payout_lower_than_assumed_is_rejected(mock_deriv):
    c = await _client(mock_deriv)
    exe = ExecutionEngine(c)
    res = await exe.execute(_req(payout_assumption=1.2))   # mock pays 0.95
    assert res.status == "PAYOUT_TOO_LOW"
    await c.stop()


async def test_bots_run_end_to_end_in_demo(mock_deriv):
    optimizer.seed_defaults(None)
    c = await _client(mock_deriv)
    feed = MarketFeed(c)
    exe = ExecutionEngine(c)
    mgr = BotManager(c, feed, exe)
    db.kv_set("mode", "demo")
    # very permissive config so the random mock data yields signals quickly
    optimizer.update_operational(None, "scalping", {"symbols": ["R_100"], "min_confidence": 0})
    await mgr.start_bot("scalping")
    await mgr.start_bot("smart_ai")
    await asyncio.sleep(4)
    assert mgr.rt["scalping"].last_eval is not None
    assert mgr.snapshots, "analysis snapshot published"
    await mgr.emergency_stop("test")
    assert not any(rt.running for rt in mgr.rt.values())
    with pytest.raises(PermissionError):
        await mgr.start_bot("trend")
    sigs = db.rows(db.select(db.signals))
    for s in sigs:   # every signal got a decision
        assert s["status"] in ("executed", "rejected", "expired", "pending")
    await c.stop()


async def test_manual_mode_requires_approval(mock_deriv):
    optimizer.seed_defaults(None)
    c = await _client(mock_deriv)
    mgr = BotManager(c, MarketFeed(c), ExecutionEngine(c))
    db.kv_set("mode", "manual")
    sid = db.execute(db.insert(db.signals).values(
        ts=time.time(), bot_id="trend", symbol="R_100", direction="UP", confidence=80, status="pending",
        contract_type="rise_fall", regime="ranging", reasons=[], features={"strategy": "trend", "raw_score": 80}
    )).inserted_primary_key[0]
    assert not mock_deriv.buys
    r = await mgr.approve(sid)
    assert r["ok"] and len(mock_deriv.buys) == 1
    assert db.rows(db.select(db.signals).where(db.signals.c.id == sid))[0]["status"] == "executed"
    await c.stop()


async def test_order_from_candle_callback_does_not_deadlock(mock_deriv):
    """Regression: callbacks run off the socket reader, so a callback can await API requests."""
    c = await _client(mock_deriv)
    feed, exe = MarketFeed(c), ExecutionEngine(c)
    results = []

    async def on_close(sym, gran, df):
        if not results:
            results.append("started")
            results.append(await asyncio.wait_for(exe.execute(_req()), 4))
    feed.on_candle_closed(on_close)
    await feed.ensure("R_100", 60)
    t0 = time.time()
    while len(results) < 2 and time.time() - t0 < 6:
        await asyncio.sleep(0.05)
    assert len(results) == 2 and results[1].ok, results
    await c.stop()


async def test_bots_place_orders_from_live_candles(mock_deriv):
    optimizer.seed_defaults(None)
    c = await _client(mock_deriv)
    mgr = BotManager(c, MarketFeed(c), ExecutionEngine(c))
    db.kv_set("mode", "full")
    optimizer.update_operational(None, "scalping", {"symbols": ["R_100"], "min_confidence": 0})
    await mgr.start_bot("scalping")
    t0 = time.time()
    while not mock_deriv.buys and time.time() - t0 < 12:
        await asyncio.sleep(0.1)
    assert mock_deriv.buys, "a live signal should have been executed"
    sig = db.rows(db.select(db.signals).where(db.signals.c.status == "executed"))
    assert sig and len(mock_deriv.buys) == len(db.rows(db.select(db.orders).where(db.orders.c.status == "BOUGHT")))
    await mgr.stop_bot("scalping")
    await c.stop()
