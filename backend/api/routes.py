"""REST + WebSocket API. Every route except /auth/* and /site acts on the signed-in user only."""
from __future__ import annotations

import time
from dataclasses import asdict, dataclass
from datetime import datetime, timedelta, timezone
from typing import Any

from fastapi import APIRouter, Depends, Header, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel

from .. import auth
from .. import database as db
from ..ai_engine import optimizer
from ..backtesting import jobs
from ..backtesting.engine import BTConfig
from ..bots.manager import bot_stats
from ..config import settings
from ..monitoring import bus, errors
from ..runtime import UserRuntime, platform
from ..security import issue_session, verify_session
from ..strategies.library import STRATEGIES

router = APIRouter(prefix="/api")
REAL_CONFIRM = "I ACCEPT REAL MONEY RISK"


# ---------------- session ----------------
@dataclass
class Session:
    uid: str
    user: dict
    rt: UserRuntime


def _check_token(token: str) -> tuple[dict, dict]:
    p = verify_session(token) if token else None
    if not p:
        raise HTTPException(401, "not signed in")
    u = auth.get_user(p["sub"])
    if not u or u["disabled"] or p.get("ep", 0) != auth.session_epoch(p["sub"]):
        raise HTTPException(401, "session expired")
    return p, u


async def current(authorization: str = Header(default="")) -> Session:
    _, u = _check_token(authorization.removeprefix("Bearer ").strip())
    try:
        rt = await platform.get(u["id"])
    except auth.AuthError as e:
        raise HTTPException(401, str(e))
    return Session(u["id"], u, rt)


def admin_only(s: Session = Depends(current)) -> Session:
    if not s.user["is_admin"]:
        raise HTTPException(403, "admin only")
    return s


S = Depends(current)


# ---------------- public site info & auth ----------------
@router.get("/site")
def site():
    return {"brand": settings.brand_name, "tagline": settings.brand_tagline, "support_email": settings.support_email,
            "oauth_url": auth.oauth_url(), "signup_url": auth.signup_url(), "app_id": settings.deriv_app_id}


class OAuthAccount(BaseModel):
    loginid: str | None = None
    token: str
    currency: str | None = None


class OAuthBody(BaseModel):
    accounts: list[OAuthAccount]


_fails: dict[str, list[float]] = {}


@router.post("/auth/deriv")
async def deriv_login(body: OAuthBody):
    recent = [t for t in _fails.get("oauth", []) if t > time.time() - 60]
    if len(recent) > 30:
        raise HTTPException(429, "too many attempts")
    try:
        info = await auth.verify_accounts([a.model_dump() for a in body.accounts])
        u = auth.upsert_user(info)
    except auth.AuthError as e:
        _fails["oauth"] = recent + [time.time()]
        raise HTTPException(401, str(e))
    except Exception as e:
        raise HTTPException(503, f"could not reach Deriv: {e}")
    # new tokens -> restart this user's connection with them (unless bots are mid-trade)
    rt = platform.users.get(u["id"])
    if rt and not rt.busy():
        await platform.drop(u["id"])
    return {"token": issue_session(u["id"], bool(u["is_admin"]), auth.session_epoch(u["id"])),
            "user": auth.public_user(u)}


@router.get("/auth/me")
async def me(s: Session = S):
    return auth.public_user(s.user)


@router.post("/auth/logout")
async def logout(s: Session = S, everywhere: bool = False, revoke: bool = False):
    if everywhere:
        auth.logout_everywhere(s.uid)
    if revoke:   # also stop bots, invalidate Deriv tokens and disconnect
        for b, rt in s.rt.bots.rt.items():
            if rt.running:
                await s.rt.bots.stop_bot(b)
        await auth.revoke_deriv_tokens(s.user)
        await platform.drop(s.uid)
        auth.logout_everywhere(s.uid)
    db.audit("security", "signed out", user_id=s.uid, everywhere=everywhere, revoke=revoke)
    return {"ok": True}


class SwitchBody(BaseModel):
    loginid: str


@router.post("/account/switch")
async def switch(body: SwitchBody, s: Session = S):
    try:
        rt = await platform.switch_account(s.uid, body.loginid)
    except (auth.AuthError, PermissionError) as e:
        raise HTTPException(400, str(e))
    return {"loginid": rt.client.health.loginid, "is_virtual": rt.client.health.is_virtual}


# ---------------- status / account ----------------
@router.get("/status")
def status(s: Session = S):
    c = s.rt.client
    k = lambda key: db.kv_get(db.ukey(s.uid, key))  # noqa: E731
    return {"user": auth.public_user(s.user), "health": c.health.__dict__, "mode": s.rt.bots.mode(),
            "emergency_stop": k("global_stop"), "suspension": s.rt.risk.suspension(),
            "real_authorization": k("real_trading_authorization"),
            "trading_permission": s.rt.exe.trading_permission(), "balance": c.account.get("balance"),
            "currency": c.health.currency, "unresolved_orders": len(s.rt.exe.unresolved_orders()),
            "market_feed": platform.public.health.connected if platform.public else False}


class RealAuth(BaseModel):
    loginid: str
    confirmation: str


@router.post("/deriv/authorize-real")
def authorize_real(body: RealAuth, s: Session = S):
    h = s.rt.client.health
    if not h.authorized or h.is_virtual:
        raise HTTPException(400, "switch to your REAL account first")
    if body.loginid != h.loginid:
        raise HTTPException(400, f"account id mismatch (active: {h.loginid})")
    if body.confirmation != REAL_CONFIRM:
        raise HTTPException(400, f'type exactly: "{REAL_CONFIRM}"')
    db.kv_set(db.ukey(s.uid, "real_trading_authorization"), {"authorized": True, "loginid": h.loginid, "at": time.time()})
    db.audit("security", f"REAL-MONEY trading authorized for {h.loginid}", level="WARN", user_id=s.uid)
    return {"authorized": True}


@router.delete("/deriv/authorize-real")
def revoke_real(s: Session = S):
    db.kv_set(db.ukey(s.uid, "real_trading_authorization"), None)
    db.audit("security", "real-money authorization revoked", user_id=s.uid)
    return {"authorized": False}


@router.get("/account/transactions")
async def transactions(limit: int = 50, s: Session = S):
    try:
        return {"statement": await s.rt.client.statement(limit), "profit_table": await s.rt.client.profit_table(limit)}
    except Exception as e:
        raise HTTPException(503, str(e))


# ---------------- dashboard ----------------
def _mine(s: Session, table):
    return table.c.user_id == s.uid


def _pnl_since(s: Session, ts: float) -> float:
    r = db.rows(db.select(db.func.coalesce(db.func.sum(db.trades.c.profit), 0)).where(
        (db.trades.c.sell_time >= ts) & db.trades.c.status.in_(["won", "lost", "sold"]) & _mine(s, db.trades)))
    return round(float(list(r[0].values())[0]), 2)


@router.get("/dashboard")
def dashboard(s: Session = S):
    now = datetime.now(timezone.utc)
    day = datetime(now.year, now.month, now.day, tzinfo=timezone.utc)
    week = day - timedelta(days=day.weekday())
    month = datetime(now.year, now.month, 1, tzinfo=timezone.utc)
    bal = s.rt.client.account.get("balance")
    st = bot_stats(s.uid)
    risk = s.rt.risk.state(bal, s.rt.client.health.loginid)
    open_t = db.rows(db.select(db.trades).where((db.trades.c.status == "open") & _mine(s, db.trades))
                     .order_by(db.trades.c.buy_time.desc()))
    return {
        "balance": bal, "currency": s.rt.client.health.currency,
        "available_balance": round(bal - risk["exposure"], 2) if bal is not None else None,
        "pnl": {"total": st["net_profit"], "daily": _pnl_since(s, day.timestamp()),
                "weekly": _pnl_since(s, week.timestamp()), "monthly": _pnl_since(s, month.timestamp())},
        "stats": st, "risk": risk, "open_trades": open_t,
        "active_bots": [b for b, rt in s.rt.bots.rt.items() if rt.running],
        "recent_signals": db.rows(db.select(db.signals).where(_mine(s, db.signals))
                                  .order_by(db.signals.c.id.desc()).limit(25)),
        "market": list(s.rt.bots.snapshots.values()), "prices": {**platform.public_feed.last_price, **s.rt.feed.last_price},
        "mode": s.rt.bots.mode(), "health": s.rt.client.health.__dict__,
    }


# ---------------- markets (public connection) ----------------
@router.get("/markets/symbols")
async def symbols(s: Session = S):
    try:
        lst = await platform.public.active_symbols()
    except Exception as e:
        raise HTTPException(503, str(e))
    return [{"symbol": x["symbol"], "name": x["display_name"], "market": x.get("market_display_name"),
             "submarket": x.get("submarket_display_name"), "open": bool(x.get("exchange_is_open"))} for x in lst]


@router.get("/markets/candles")
async def candles(symbol: str, granularity: int = 60, count: int = 500, s: Session = S):
    df = platform.public_feed.frame(symbol, granularity, closed_only=False)
    if df is None or len(df) < 10:
        df = s.rt.feed.frame(symbol, granularity, closed_only=False)
    if df is None or len(df) < 10:
        try:
            raw = await platform.public.candles(symbol, granularity, count)
        except Exception as e:
            raise HTTPException(503, str(e))
        return [{"time": int(c["epoch"]), "open": float(c["open"]), "high": float(c["high"]),
                 "low": float(c["low"]), "close": float(c["close"])} for c in raw]
    df = df.iloc[-count:]
    return [{"time": int(i), "open": r.open, "high": r.high, "low": r.low, "close": r.close} for i, r in df.iterrows()]


class Watch(BaseModel):
    symbol: str
    granularity: int = 60


_watched: dict[tuple[str, int], float] = {}


@router.post("/markets/watch")
async def watch(body: Watch, s: Session = S):
    """Shared live chart streams on the public connection (LRU, max 20 markets for all users)."""
    key = (body.symbol, body.granularity)
    if key not in _watched:
        if len(_watched) >= 20:
            old = min(_watched, key=_watched.get)
            _watched.pop(old)
            await platform.public_feed.release(*old)
        await platform.public_feed.ensure(*key)
    _watched[key] = time.time()
    return {"ok": True}


@router.get("/markets/analysis")
async def analysis(symbol: str, granularity: int = 300, s: Session = S):
    import pandas as pd

    from .. import indicators as ind
    from ..analysis import analyze
    df = s.rt.feed.frame(symbol, granularity)
    if df is None or len(df) < 100:
        df = platform.public_feed.frame(symbol, granularity)
    if df is None or len(df) < 100:
        raw = await platform.public.candles(symbol, granularity, 1000)
        df = pd.DataFrame(raw).set_index("epoch")[["open", "high", "low", "close"]].astype(float).iloc[:-1]
    f = ind.compute_all(df)
    snap = analyze(symbol, granularity, df, f=f).to_dict()
    snap["signals"] = {}
    for sid, st in STRATEGIES.items():
        try:
            sig = st.latest(df, f, optimizer.active(s.uid, sid)["params"])
        except Exception:
            sig = None
        snap["signals"][sid] = sig.__dict__ if sig else None
    return snap


# ---------------- bots ----------------
def _bot(s: Session, bot_id: str):
    if bot_id not in s.rt.bots.rt:
        raise HTTPException(404, "unknown bot")


@router.get("/bots")
def list_bots(s: Session = S):
    return [s.rt.bots.bot_status(b) for b in s.rt.bots.rt]


@router.get("/bots/{bot_id}")
def get_bot(bot_id: str, s: Session = S):
    _bot(s, bot_id)
    return {**s.rt.bots.bot_status(bot_id), "versions": optimizer.versions(s.uid, bot_id)[:30],
            "degradation": optimizer.degradation(s.uid, bot_id)}


@router.post("/bots/{bot_id}/start")
async def start_bot(bot_id: str, s: Session = S):
    _bot(s, bot_id)
    try:
        await s.rt.bots.start_bot(bot_id)
    except PermissionError as e:
        raise HTTPException(409, str(e))
    return s.rt.bots.bot_status(bot_id)


@router.post("/bots/{bot_id}/stop")
async def stop_bot(bot_id: str, s: Session = S):
    _bot(s, bot_id)
    await s.rt.bots.stop_bot(bot_id)
    return s.rt.bots.bot_status(bot_id)


@router.patch("/bots/{bot_id}")
async def patch_bot(bot_id: str, changes: dict[str, Any], s: Session = S):
    _bot(s, bot_id)
    try:
        optimizer.update_operational(s.uid, bot_id, changes)
    except ValueError as e:
        raise HTTPException(400, str(e))
    if "symbols" in changes:
        await s.rt.bots.restart_bot(bot_id)
    return s.rt.bots.bot_status(bot_id)


class ValidateBody(BaseModel):
    days: float = 30
    symbol: str | None = None
    overrides: dict = {}
    folds: int = 4
    optimise: bool = True


_validating: set[str] = set()


@router.post("/bots/{bot_id}/validate")
async def validate_bot(bot_id: str, body: ValidateBody, s: Session = S):
    _bot(s, bot_id)
    cfg = optimizer.active(s.uid, bot_id)
    if cfg["strategy"] == "smart_ai":
        raise HTTPException(400, "Smart AI learns from its specialists - validate those bots")
    if s.uid in _validating:
        raise HTTPException(429, "you already have a validation running")
    if not 1 <= body.days <= 365 or not 2 <= body.folds <= 8:
        raise HTTPException(400, "days 1-365, folds 2-8")
    gran = body.overrides.get("granularity", cfg["granularity"])
    end = int(time.time())
    _validating.add(s.uid)
    try:
        try:
            df = await platform.history(body.symbol or cfg["symbols"][0], gran, end - int(body.days * 86400), end)
        except RuntimeError as e:
            raise HTTPException(503, str(e))
        if len(df) < 800:
            raise HTTPException(400, f"only {len(df)} candles - use a longer period")
        try:
            res = await jobs.submit(jobs.validate_job, settings.database_url, s.uid, bot_id, jobs.pack(df),
                                    body.overrides, body.folds, body.optimise)
        except ValueError as e:
            raise HTTPException(400, str(e))
    finally:
        _validating.discard(s.uid)
    s.rt.memory.refresh()
    return res


@router.post("/bots/{bot_id}/deploy/{version}")
async def deploy(bot_id: str, version: int, s: Session = S):
    _bot(s, bot_id)
    try:
        optimizer.deploy(s.uid, bot_id, version)
    except (PermissionError, KeyError) as e:
        raise HTTPException(400, str(e))
    await s.rt.bots.restart_bot(bot_id)
    return s.rt.bots.bot_status(bot_id)


# ---------------- signals & trades ----------------
@router.get("/signals")
def list_signals(status: str | None = None, bot_id: str | None = None, limit: int = Query(100, le=1000), s: Session = S):
    q = db.select(db.signals).where(_mine(s, db.signals))
    if status:
        q = q.where(db.signals.c.status == status)
    if bot_id:
        q = q.where(db.signals.c.bot_id == bot_id)
    return db.rows(q.order_by(db.signals.c.id.desc()).limit(limit))


@router.post("/signals/{sid}/approve")
async def approve(sid: int, s: Session = S):
    try:
        return await s.rt.bots.approve(sid)
    except (KeyError, ValueError) as e:
        raise HTTPException(400, str(e))


@router.post("/signals/{sid}/reject")
def reject(sid: int, s: Session = S):
    try:
        s.rt.bots.reject(sid)
    except KeyError:
        raise HTTPException(404, "signal not found")
    return {"ok": True}


@router.get("/trades")
def list_trades(status: str | None = None, bot_id: str | None = None, limit: int = Query(200, le=5000), s: Session = S):
    q = db.select(db.trades).where(_mine(s, db.trades))
    if status:
        q = q.where(db.trades.c.status == status)
    if bot_id:
        q = q.where(db.trades.c.bot_id == bot_id)
    return db.rows(q.order_by(db.trades.c.buy_time.desc()).limit(limit))


@router.post("/trades/{cid}/sell")
async def sell(cid: str, s: Session = S):
    if not db.rows(db.select(db.trades.c.contract_id).where((db.trades.c.contract_id == cid) & _mine(s, db.trades))):
        raise HTTPException(404, "trade not found")
    try:
        return await s.rt.exe.sell(cid)
    except Exception as e:
        raise HTTPException(400, str(e))


@router.get("/orders")
def list_orders(limit: int = 100, s: Session = S):
    return db.rows(db.select(db.orders).where(_mine(s, db.orders)).order_by(db.orders.c.ts.desc()).limit(limit))


# ---------------- risk / mode / emergency ----------------
@router.get("/risk")
def get_risk(s: Session = S):
    return s.rt.risk.state(s.rt.client.account.get("balance"), s.rt.client.health.loginid)


@router.put("/risk")
def put_risk(changes: dict[str, Any], s: Session = S):
    try:
        return s.rt.risk.update_config(changes)
    except ValueError as e:
        raise HTTPException(400, str(e))


@router.post("/risk/resume")
def resume(s: Session = S):
    s.rt.risk.resume()
    return {"ok": True}


@router.post("/risk/reset-peak")
def reset_peak(s: Session = S):
    bal = s.rt.client.account.get("balance")
    if bal is None:
        raise HTTPException(400, "balance unknown")
    s.rt.risk.reset_peak(bal, s.rt.client.health.loginid)
    return {"peak": bal}


class ModeBody(BaseModel):
    mode: str


@router.get("/mode")
def get_mode(s: Session = S):
    return {"mode": s.rt.bots.mode()}


@router.put("/mode")
def put_mode(body: ModeBody, s: Session = S):
    try:
        return {"mode": s.rt.bots.set_mode(body.mode)}
    except (ValueError, PermissionError) as e:
        raise HTTPException(400, str(e))


@router.post("/emergency-stop")
async def estop(s: Session = S):
    return await s.rt.bots.emergency_stop("dashboard")


@router.delete("/emergency-stop")
def clear_estop(s: Session = S):
    s.rt.bots.clear_emergency_stop()
    return {"ok": True}


# ---------------- backtesting ----------------
class BacktestBody(BaseModel):
    strategies: list[str]
    symbol: str = "R_100"
    granularity: int = 300
    days: float = 30
    contract: dict = {"family": "rise_fall", "duration_bars": 3, "payout_ratio": 0.9}
    params: dict = {}
    walk_forward: bool = False
    folds: int = 4
    min_score: float = 0


_backtesting: set[str] = set()


@router.post("/backtest")
async def backtest(body: BacktestBody, s: Session = S):
    bad = [x for x in body.strategies if x not in STRATEGIES]
    if bad:
        raise HTTPException(400, f"unknown strategies {bad}")
    if not 0 < body.days <= 365:
        raise HTTPException(400, "days must be 1-365")
    if s.uid in _backtesting:
        raise HTTPException(429, "you already have a backtest running")
    end = int(time.time())
    _backtesting.add(s.uid)
    try:
        try:
            df = await platform.history(body.symbol, body.granularity, end - int(body.days * 86400), end)
        except RuntimeError as e:
            raise HTTPException(503, str(e))
        cfg = BTConfig.from_dict({**body.contract, "min_score": body.min_score})
        params = {x: body.params.get(x) or optimizer.active(s.uid, x)["params"] for x in body.strategies}
        res = await jobs.submit(jobs.backtest_job, jobs.pack(df), body.strategies, params, asdict(cfg),
                                body.walk_forward, body.folds)
    finally:
        _backtesting.discard(s.uid)
    return {"symbol": body.symbol, "granularity": body.granularity, "bars": len(df),
            "from": int(df.index[0]), "to": int(df.index[-1]),
            "breakeven_win_rate": round(1 / (1 + cfg.payout_ratio), 4), "results": res}


@router.get("/strategies")
def strategies(s: Session = S):
    return [{"id": x.id, "name": x.name, "description": x.description, "default_params": x.default_params,
             "param_space": x.param_space} for x in STRATEGIES.values()]


# ---------------- analytics ----------------
@router.get("/analytics/performance")
def performance(s: Session = S):
    trades = db.rows(db.select(db.trades.c.sell_time, db.trades.c.profit, db.trades.c.bot_id)
                     .where(db.trades.c.status.in_(["won", "lost", "sold"]) & _mine(s, db.trades))
                     .order_by(db.trades.c.sell_time))
    eq, curve, daily = 0.0, [], {}
    for t in trades:
        eq += t["profit"] or 0
        curve.append({"time": int(t["sell_time"]), "value": round(eq, 2)})
        d = datetime.fromtimestamp(t["sell_time"], tz=timezone.utc).strftime("%Y-%m-%d")
        daily[d] = round(daily.get(d, 0) + (t["profit"] or 0), 2)
    return {"equity_curve": curve, "daily_pnl": [{"date": k, "pnl": v} for k, v in sorted(daily.items())],
            "by_bot": {b: bot_stats(s.uid, b) for b in s.rt.bots.rt},
            "balance_history": db.rows(db.select(db.equity).where(_mine(s, db.equity))
                                       .order_by(db.equity.c.ts.desc()).limit(2000))[::-1]}


@router.get("/analytics/calibration")
def calibration(s: Session = S):
    return {"calibration": s.rt.memory.summary(), "regimes": s.rt.memory.regime_table()}


@router.get("/analytics/degradation")
def degradation_all(s: Session = S):
    return [optimizer.degradation(s.uid, b) for b in s.rt.bots.rt]


# ---------------- logs ----------------
@router.get("/logs")
def logs(category: str | None = None, limit: int = Query(200, le=2000), s: Session = S):
    q = db.select(db.audit_log).where(_mine(s, db.audit_log))
    if category:
        q = q.where(db.audit_log.c.category == category)
    return db.rows(q.order_by(db.audit_log.c.id.desc()).limit(limit))


@router.post("/system/reconcile")
async def reconcile(s: Session = S):
    return await s.rt.exe.reconcile()


# ---------------- admin (site owner) ----------------
@router.get("/admin/overview")
def admin_overview(s: Session = Depends(admin_only)):
    users = db.rows(db.select(db.users).order_by(db.users.c.created_at.desc()))
    out = []
    for u in users:
        rt = platform.users.get(u["id"])
        out.append({"id": u["id"], "email": u["email"], "fullname": u["fullname"], "is_admin": u["is_admin"],
                    "disabled": u["disabled"], "active_loginid": u["active_loginid"], "created_at": u["created_at"],
                    "last_login": u["last_login"], "online": rt is not None,
                    "running_bots": [b for b, x in rt.bots.rt.items() if x.running] if rt else [],
                    "stats": bot_stats(u["id"])})
    return {"users": out, "connections": len(platform.users),
            "market_feed": platform.public.health.__dict__ if platform.public else None,
            "uptime": time.time() - platform.started_at}


@router.post("/admin/users/{uid}/disable")
async def admin_disable(uid: str, disabled: bool = True, s: Session = Depends(admin_only)):
    if uid == s.uid:
        raise HTTPException(400, "cannot disable yourself")
    rt = platform.users.get(uid)
    if disabled and rt:
        await rt.bots.emergency_stop("disabled by administrator")
        await platform.drop(uid)
    db.execute(db.update(db.users).where(db.users.c.id == uid).values(disabled=disabled))
    if disabled:
        auth.logout_everywhere(uid)
    db.audit("admin", f"user {uid} {'disabled' if disabled else 'enabled'}", user_id=s.uid)
    return {"ok": True}


@router.get("/admin/errors")
def get_errors(s: Session = Depends(admin_only)):
    return list(errors.items)[::-1]


@router.post("/admin/backup")
async def backup(s: Session = Depends(admin_only)):
    import asyncio
    p = await asyncio.to_thread(db.backup_database)
    db.audit("system", "manual backup", path=p, user_id=s.uid)
    return {"path": p}


# ---------------- websocket ----------------
async def ws_endpoint(ws: WebSocket):
    try:
        _, u = _check_token(ws.query_params.get("token", ""))
    except HTTPException:
        await ws.close(code=4401)
        return
    await ws.accept()
    q = bus.subscribe(u["id"])
    try:
        await ws.send_json({"type": "hello", "data": {"recent": bus.recent_for(u["id"])}})
        while True:
            msg = await q.get()
            await ws.send_json(msg)
    except (WebSocketDisconnect, RuntimeError):
        pass
    finally:
        bus.unsubscribe(q)
