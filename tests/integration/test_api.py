"""API end-to-end with two users signing in through (mock) Deriv OAuth."""
import asyncio
import threading
import time

import pytest
from fastapi.testclient import TestClient

from backend import database as db
from backend.config import settings
from tests.mock_deriv import MockDeriv


@pytest.fixture
def api():
    mock = MockDeriv(candle_seconds=0.3)
    loop = asyncio.new_event_loop()
    ready = threading.Event()

    def run():
        asyncio.set_event_loop(loop)
        mock.url = loop.run_until_complete(mock.start())
        ready.set()
        loop.run_forever()
    threading.Thread(target=run, daemon=True).start()
    ready.wait(5)
    settings.deriv_ws_url = mock.url
    settings.autostart_feed = True
    settings.admin_emails = []
    from backend.main import app
    with TestClient(app) as client:
        yield client, mock
    settings.autostart_feed = False
    loop.call_soon_threadsafe(loop.stop)


def login(client, *accounts):
    """accounts like ('VRTC1', 'demo-alice') - mimics the ?acct1=&token1= OAuth redirect."""
    r = client.post("/api/auth/deriv", json={"accounts": [{"loginid": None, "token": t, "currency": "usd"}
                                                          for _, t in accounts]})
    assert r.status_code == 200, r.text
    return {"Authorization": f"Bearer {r.json()['token']}"}, r.json()["user"]


def test_site_info_is_public_and_branded(api):
    client, _ = api
    s = client.get("/api/site").json()
    assert s["brand"] == settings.brand_name
    assert s["oauth_url"].startswith("https://oauth.deriv.com/oauth2/authorize?app_id=")
    assert client.get("/api/status").status_code == 401


def test_bad_token_rejected(api):
    client, _ = api
    r = client.post("/api/auth/deriv", json={"accounts": [{"token": "bad"}]})
    assert r.status_code == 401


def test_two_users_are_isolated(api):
    client, mock = api
    ha, alice = login(client, ("", "demo-alice"), ("", "real-alice"))
    hb, bob = login(client, ("", "demo-bob"))
    assert alice["is_admin"] and not bob["is_admin"]                 # first user = site owner
    assert alice["id"] != bob["id"] and len(alice["accounts"]) == 2
    assert alice["active_loginid"].startswith("VRTC")                 # demo is always the default

    sa = client.get("/api/status", headers=ha).json()
    sb = client.get("/api/status", headers=hb).json()
    assert sa["health"]["loginid"] != sb["health"]["loginid"]
    assert "demo-alice" not in str(sa)                                # tokens never leave the server

    # each user has their own bots and settings
    assert client.patch("/api/bots/trend", json={"min_confidence": 55}, headers=ha).status_code == 200
    assert client.get("/api/bots/trend", headers=hb).json()["min_confidence"] == 70
    client.put("/api/risk", json={"risk_pct_per_trade": 0.5}, headers=ha)
    assert client.get("/api/risk", headers=hb).json()["limits"]["risk_pct_per_trade"] == 1.0
    client.put("/api/mode", json={"mode": "manual"}, headers=ha)
    assert client.get("/api/mode", headers=hb).json()["mode"] == "demo"

    # a signal of Alice's is invisible / untouchable for Bob
    sid = db.execute(db.insert(db.signals).values(
        user_id=alice["id"], ts=time.time(), bot_id="trend", symbol="R_100", direction="UP", confidence=80,
        status="pending", contract_type="rise_fall", regime="ranging", reasons=[],
        features={"strategy": "trend", "raw_score": 80})).inserted_primary_key[0]
    assert client.get("/api/signals?status=pending", headers=hb).json() == []
    assert client.post(f"/api/signals/{sid}/approve", headers=hb).status_code == 400
    assert client.post(f"/api/signals/{sid}/reject", headers=hb).status_code == 404
    r = client.post(f"/api/signals/{sid}/approve", headers=ha).json()
    assert r["ok"], r
    assert len(client.get("/api/trades", headers=ha).json()) == 1
    assert client.get("/api/trades", headers=hb).json() == []
    cid = client.get("/api/trades", headers=ha).json()[0]["contract_id"]
    assert client.post(f"/api/trades/{cid}/sell", headers=hb).status_code == 404

    # Bob's emergency stop does not touch Alice
    client.post("/api/emergency-stop", headers=hb)
    assert client.get("/api/status", headers=ha).json()["emergency_stop"] is None
    assert client.post("/api/bots/trend/start", headers=hb).status_code == 409
    assert client.post("/api/bots/scalping/start", headers=ha).json()["running"]

    # admin endpoints
    assert client.get("/api/admin/overview", headers=hb).status_code == 403
    ov = client.get("/api/admin/overview", headers=ha).json()
    assert len(ov["users"]) == 2 and ov["connections"] == 2


def test_account_switch_and_real_authorization(api):
    client, _ = api
    h, u = login(client, ("", "demo-carol"), ("", "real-carol"))
    real = next(a["loginid"] for a in u["accounts"] if not a["is_virtual"])
    r = client.post("/api/account/switch", json={"loginid": real}, headers=h).json()
    assert r["loginid"] == real and not r["is_virtual"]
    st = client.get("/api/status", headers=h).json()
    assert st["trading_permission"][0] is False                        # real requires authorization
    assert client.put("/api/mode", json={"mode": "full"}, headers=h).status_code == 400
    assert client.post("/api/deriv/authorize-real", headers=h,
                       json={"loginid": real, "confirmation": "yes"}).status_code == 400
    assert client.post("/api/deriv/authorize-real", headers=h,
                       json={"loginid": real, "confirmation": "I ACCEPT REAL MONEY RISK"}).status_code == 200
    assert client.get("/api/status", headers=h).json()["trading_permission"][0] is True
    assert client.post("/api/account/switch", json={"loginid": "CR000"}, headers=h).status_code == 400


def test_logout_everywhere_revokes_sessions(api):
    client, _ = api
    h, _ = login(client, ("", "demo-dave"))
    assert client.get("/api/auth/me", headers=h).status_code == 200
    client.post("/api/auth/logout?everywhere=true", headers=h)
    assert client.get("/api/auth/me", headers=h).status_code == 401


def test_market_backtest_and_ws(api):
    client, _ = api
    h, _ = login(client, ("", "demo-erin"))
    candles = client.get("/api/markets/candles?symbol=R_100&granularity=60&count=100", headers=h).json()
    assert len(candles) == 100
    an = client.get("/api/markets/analysis?symbol=R_100&granularity=60", headers=h).json()
    assert "regime" in an and "signals" in an
    bt = client.post("/api/backtest", headers=h, json={
        "strategies": ["trend", "scalping"], "symbol": "R_50", "granularity": 60, "days": 0.5,
        "contract": {"family": "rise_fall", "duration_bars": 3, "payout_ratio": 0.9}}).json()
    assert set(bt["results"]) == {"trend", "scalping"}
    tok = h["Authorization"].split()[1]
    with client.websocket_connect(f"/ws?token={tok}") as ws:
        assert ws.receive_json()["type"] == "hello"
    d = client.get("/api/dashboard", headers=h).json()
    assert d["balance"] == 10000 and d["mode"] == "demo"
