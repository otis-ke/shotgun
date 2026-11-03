"""Platform runtime.

* One PUBLIC Deriv connection (no token) for charts, analysis pages and backtest history.
* One isolated UserRuntime per signed-in user: their own authorized Deriv connection, market
  feed, bots, risk manager, execution engine and performance memory. Users never share state.
* Runtimes keep running after the user closes the browser, so bots trade 24/7 server-side.
"""
from __future__ import annotations

import asyncio
import contextlib
import logging
import time

import pandas as pd

from . import auth
from . import database as db
from .ai_engine import optimizer
from .ai_engine.memory import PerformanceMemory
from .bots.manager import BotManager
from .config import settings
from .deriv.client import DerivClient
from .deriv.feed import MarketFeed
from .execution import ExecutionEngine
from .monitoring import bus
from .risk_management import RiskManager

log = logging.getLogger("runtime")


class UserRuntime:
    def __init__(self, uid: str, loginid: str, token: str):
        self.uid, self.loginid = uid, loginid
        self.client = DerivClient(settings.deriv_ws_url, settings.deriv_app_id, token)
        self.feed = MarketFeed(self.client)
        self.risk = RiskManager(uid)
        self.memory = PerformanceMemory(uid)
        self.exe = ExecutionEngine(self.client, uid, self.risk, self.memory)
        self.bots = BotManager(self.client, self.feed, self.exe, uid)
        self.started_at = time.time()
        self._startup_task: asyncio.Task | None = None

    async def start(self) -> None:
        optimizer.seed_defaults(self.uid)
        self.memory.refresh()
        self.client.on_event(self._on_conn_event)
        self.feed.on_tick(lambda s, t: bus.publish("tick", t, user_id=self.uid))
        await self.client.start()
        self._startup_task = asyncio.create_task(self._startup())

    async def _startup(self) -> None:
        if await self.client.wait_ready(30):
            await self.bots.restore_enabled()

    async def stop(self) -> None:
        if self._startup_task:
            self._startup_task.cancel()
        for b, rt in self.bots.rt.items():
            if rt.running:
                with contextlib.suppress(Exception):
                    await self.bots.stop_bot(b, persist=False)
        await self.client.stop()

    async def _on_conn_event(self, kind: str, data: dict) -> None:
        bus.publish("connection", {"event": kind, **data, "health": self.client.health.__dict__}, user_id=self.uid)
        if kind == "disconnected":
            db.audit("connection", "Deriv connection lost", level="WARN", user_id=self.uid, error=data.get("error"))
        elif kind == "authorized":
            db.audit("connection", f"authorized {data.get('loginid')} (virtual={data.get('is_virtual')})",
                     user_id=self.uid)
            with contextlib.suppress(Exception):
                await self.client.subscribe("balance", {"balance": 1}, self._on_balance)
            asyncio.create_task(self.exe.reconcile())

    async def _on_balance(self, msg: dict) -> None:
        b = msg.get("balance") or {}
        if "balance" in b:
            self.client.account["balance"] = float(b["balance"])
            self.risk.record_balance(float(b["balance"]), self.client.health.loginid, b.get("currency"))
            bus.publish("balance", {"balance": b["balance"], "currency": b.get("currency")}, user_id=self.uid)

    async def tick(self, n: int) -> None:
        """Called every 30 s by the platform monitor."""
        if self.client.health.authorized:
            if self.exe.unresolved_orders():
                await self.exe.reconcile()
            await self.exe.poll_open()
        if n % 120 == 0:
            await self.bots.check_degradation()
        if n % 2 == 0 and self.client.health.authorized and self.client.account.get("balance") is not None:
            db.execute(db.insert(db.equity).values(user_id=self.uid, ts=time.time(),
                                                   balance=self.client.account["balance"],
                                                   currency=self.client.health.currency,
                                                   loginid=self.client.health.loginid))

    def busy(self) -> bool:
        """Should this runtime stay alive without the user being online?"""
        if any(rt.running for rt in self.bots.rt.values()):
            return True
        return bool(db.rows(db.select(db.trades.c.contract_id).where(
            (db.trades.c.user_id == self.uid) & (db.trades.c.status == "open")).limit(1)))


class Platform:
    def __init__(self):
        self.public: DerivClient | None = None
        self.public_feed: MarketFeed | None = None
        self.users: dict[str, UserRuntime] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._tasks: list[asyncio.Task] = []
        self.last_seen: dict[str, float] = {}
        self.started_at = time.time()

    async def start(self) -> None:
        db.get_engine()
        self.public = DerivClient(settings.deriv_ws_url, settings.deriv_app_id, None)
        self.public_feed = MarketFeed(self.public)
        self.public_feed.on_tick(lambda s, t: bus.publish("tick", t))
        await self.public.start()
        self._tasks = [asyncio.create_task(c) for c in (self._monitor_loop(), self._backup_loop(), self._resume())]

    async def _resume(self) -> None:
        """After a restart, bring back every user who had bots enabled or open positions."""
        rows = db.rows(db.select(db.bot_configs.c.user_id).where(db.bot_configs.c.status == "active").distinct())
        for r in rows:
            uid = r["user_id"]
            if not uid:
                continue
            enabled = any((c["params"] or {}).get("enabled") for c in db.rows(db.select(db.bot_configs.c.params).where(
                (db.bot_configs.c.user_id == uid) & (db.bot_configs.c.status == "active"))))
            open_t = db.rows(db.select(db.trades.c.contract_id).where(
                (db.trades.c.user_id == uid) & (db.trades.c.status == "open")).limit(1))
            if enabled or open_t:
                with contextlib.suppress(Exception):
                    await self.get(uid)

    async def stop(self) -> None:
        for t in self._tasks:
            t.cancel()
        for t in self._tasks:
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await t
        for rt in list(self.users.values()):
            with contextlib.suppress(Exception):
                await rt.stop()
        self.users.clear()
        if self.public:
            await self.public.stop()
        db.audit("system", "safe shutdown complete")

    def shutdown_workers(self) -> None:
        from .backtesting import jobs
        jobs.shutdown()

    # ---------- users ----------
    async def get(self, uid: str) -> UserRuntime:
        self.last_seen[uid] = time.time()
        rt = self.users.get(uid)
        if rt:
            return rt
        lock = self._locks.setdefault(uid, asyncio.Lock())
        async with lock:
            if uid in self.users:
                return self.users[uid]
            u = auth.get_user(uid)
            if not u or u["disabled"]:
                raise auth.AuthError("user not found or disabled")
            token, acct = auth.account_token(u)
            rt = UserRuntime(uid, acct["loginid"], token)
            await rt.start()
            self.users[uid] = rt
            await rt.client.wait_ready(10)   # first request after sign-in gets live account data
            return rt

    async def drop(self, uid: str) -> None:
        rt = self.users.pop(uid, None)
        if rt:
            await rt.stop()

    async def switch_account(self, uid: str, loginid: str) -> UserRuntime:
        u = auth.get_user(uid)
        auth.account_token(u, loginid)  # validates the account is linked
        old = self.users.get(uid)
        if old and any(rt.running for rt in old.bots.rt.values()):
            raise PermissionError("stop all bots before switching account")
        db.execute(db.update(db.users).where(db.users.c.id == uid).values(active_loginid=loginid))
        db.audit("security", f"active account switched to {loginid}", user_id=uid)
        await self.drop(uid)
        return await self.get(uid)

    # ---------- loops ----------
    async def _monitor_loop(self) -> None:
        n = 0
        while True:
            await asyncio.sleep(30)
            n += 1
            for uid, rt in list(self.users.items()):
                try:
                    await rt.tick(n)
                    # idle runtimes (no bots, no positions, user away 30 min) release their connection
                    if not rt.busy() and time.time() - self.last_seen.get(uid, 0) > 1800:
                        await self.drop(uid)
                except Exception:
                    log.exception("monitor %s", uid)

    async def _backup_loop(self) -> None:
        while True:
            await asyncio.sleep(settings.backup_interval_hours * 3600)
            with contextlib.suppress(Exception):
                p = await asyncio.to_thread(db.backup_database)
                if p:
                    db.audit("system", "database backup created", path=p)

    # ---------- historical data (public connection, shared cache) ----------
    async def history(self, symbol: str, granularity: int, start: int, end: int) -> pd.DataFrame:
        cached = db.rows(db.select(db.candles_cache).where(
            (db.candles_cache.c.symbol == symbol) & (db.candles_cache.c.granularity == granularity) &
            (db.candles_cache.c.epoch >= start) & (db.candles_cache.c.epoch <= end)).order_by(db.candles_cache.c.epoch))
        expected = (end - start) // granularity
        if len(cached) < expected * 0.97:
            if not self.public.health.connected:
                raise RuntimeError("market data connection is down - try again shortly")
            data = await self.public.history_range(symbol, granularity, start, end)
            if data:
                have = {r["epoch"] for r in cached}
                new = [{"symbol": symbol, "granularity": granularity, "epoch": int(c["epoch"]),
                        "open": float(c["open"]), "high": float(c["high"]), "low": float(c["low"]),
                        "close": float(c["close"])} for c in data if int(c["epoch"]) not in have]
                if new:
                    with contextlib.suppress(Exception), db.get_engine().begin() as conn:
                        conn.execute(db.insert(db.candles_cache), new)
            cached = [{"epoch": int(c["epoch"]), "open": float(c["open"]), "high": float(c["high"]),
                       "low": float(c["low"]), "close": float(c["close"])} for c in data]
        df = pd.DataFrame(cached)
        if df.empty:
            raise RuntimeError("no historical data returned")
        return df.drop_duplicates("epoch").set_index("epoch")[["open", "high", "low", "close"]].sort_index()


platform = Platform()
