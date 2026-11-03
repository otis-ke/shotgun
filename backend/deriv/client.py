"""Async client for the official Deriv WebSocket API (v3).

Guarantees:
* every request gets a unique req_id; responses are routed to the awaiting future
* subscriptions are re-established automatically after reconnect
* requests are NEVER retried automatically - in particular `buy`. If the socket drops while
  a buy is in flight the caller receives `ConnectionLost` and must reconcile (see execution).
"""
from __future__ import annotations

import asyncio
import contextlib
import itertools
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from websockets.asyncio.client import connect
from websockets.exceptions import ConnectionClosed

log = logging.getLogger("deriv")

Callback = Callable[[dict], Awaitable[None] | None]


class DerivError(Exception):
    def __init__(self, code: str, message: str, details: Any = None):
        super().__init__(f"{code}: {message}")
        self.code, self.message, self.details = code, message, details


class ConnectionLost(Exception):
    """Socket closed before a response arrived - outcome of the request is unknown."""


class NotConnected(Exception):
    pass


@dataclass
class _Sub:
    """A persistent subscription. Streamed messages are queued and handled by a dedicated worker
    task, so callbacks may freely await other API requests without blocking the socket reader
    (and messages of one subscription are still processed strictly in order)."""
    request: dict
    callback: Callback
    sub_id: str | None = None
    key: str = ""
    queue: asyncio.Queue | None = None
    worker: asyncio.Task | None = None

    def push(self, msg: dict) -> None:
        if self.queue is None:
            self.queue = asyncio.Queue()
        if self.worker is None or self.worker.done():
            self.worker = asyncio.create_task(self._run(), name=f"sub:{self.key}")
        self.queue.put_nowait(msg)

    async def _run(self) -> None:
        while True:
            msg = await self.queue.get()
            try:
                r = self.callback(msg)
                if asyncio.iscoroutine(r):
                    await r
            except Exception:
                log.exception("subscription callback failed (%s)", self.key)

    def close(self) -> None:
        if self.worker and not self.worker.done():
            self.worker.cancel()


@dataclass
class Health:
    connected: bool = False
    authorized: bool = False
    loginid: str | None = None
    is_virtual: bool | None = None
    currency: str | None = None
    last_message: float = 0.0
    latency_ms: float | None = None
    reconnects: int = 0
    last_error: str | None = None
    connected_since: float | None = None
    extra: dict = field(default_factory=dict)


class DerivClient:
    def __init__(self, url: str, app_id: str, token: str | None = None,
                 request_timeout: float = 20.0, ping_interval: float = 25.0):
        self.url = f"{url}?app_id={app_id}&l=EN"
        self.token = token
        self.timeout = request_timeout
        self.ping_interval = ping_interval
        self.health = Health()
        self.account: dict = {}
        self._ws = None
        self._ids = itertools.count(1)
        self._pending: dict[int, asyncio.Future] = {}
        self._subs: dict[str, _Sub] = {}
        self._runner: asyncio.Task | None = None
        self._stop = asyncio.Event()
        self._ready = asyncio.Event()
        self._listeners: list[Callable[[str, dict], Any]] = []

    # ---------- lifecycle ----------
    def on_event(self, fn: Callable[[str, dict], Any]) -> None:
        """Connection lifecycle events: connected, disconnected, authorized, error."""
        self._listeners.append(fn)

    def _emit(self, kind: str, data: dict | None = None) -> None:
        for fn in self._listeners:
            try:
                r = fn(kind, data or {})
                if asyncio.iscoroutine(r):
                    asyncio.create_task(r)
            except Exception:  # pragma: no cover
                log.exception("listener failed")

    async def start(self) -> None:
        if self._runner and not self._runner.done():
            return
        self._stop.clear()
        self._runner = asyncio.create_task(self._run(), name="deriv-client")

    async def wait_ready(self, timeout: float = 15.0) -> bool:
        try:
            await asyncio.wait_for(self._ready.wait(), timeout)
            return True
        except asyncio.TimeoutError:
            return False

    async def stop(self) -> None:
        self._stop.set()
        if self._ws is not None:
            with contextlib.suppress(Exception):
                await self._ws.close()
        if self._runner:
            self._runner.cancel()
            with contextlib.suppress(asyncio.CancelledError, Exception):
                await self._runner
        self._fail_pending(ConnectionLost("client stopped"))
        for sub in self._subs.values():
            sub.close()

    async def _run(self) -> None:
        backoff = 1.0
        while not self._stop.is_set():
            try:
                async with connect(self.url, ping_interval=None, max_size=2 ** 23,
                                   open_timeout=15, close_timeout=3) as ws:
                    self._ws = ws
                    self.health.connected = True
                    self.health.connected_since = time.time()
                    self.health.last_error = None
                    backoff = 1.0
                    reader = asyncio.create_task(self._reader(ws))
                    pinger = asyncio.create_task(self._pinger())
                    try:
                        await self._on_connected()
                        self._ready.set()
                        self._emit("connected", {})
                        await reader
                    finally:
                        pinger.cancel()
                        reader.cancel()
            except asyncio.CancelledError:
                raise
            except Exception as e:  # network errors, auth failure etc.
                self.health.last_error = str(e)
                log.warning("Deriv connection error: %s", e)
            finally:
                self._ws = None
                self._ready.clear()
                was = self.health.connected
                self.health.connected = False
                self.health.authorized = False
                self._fail_pending(ConnectionLost("connection dropped"))
                for s in self._subs.values():
                    s.sub_id = None
                if was:
                    self._emit("disconnected", {"error": self.health.last_error})
            if self._stop.is_set():
                break
            self.health.reconnects += 1
            await asyncio.sleep(backoff)
            backoff = min(backoff * 2, 60)

    async def _on_connected(self) -> None:
        if self.token:
            auth = await self.request({"authorize": self.token})
            a = auth["authorize"]
            self.account = a
            self.health.authorized = True
            self.health.loginid = a.get("loginid")
            self.health.is_virtual = bool(a.get("is_virtual"))
            self.health.currency = a.get("currency")
            self._emit("authorized", {"loginid": a.get("loginid"), "is_virtual": a.get("is_virtual")})
        for s in list(self._subs.values()):
            with contextlib.suppress(Exception):
                await self._activate(s)

    async def _pinger(self) -> None:
        misses = 0
        while True:
            await asyncio.sleep(self.ping_interval)
            t0 = time.perf_counter()
            try:
                await self.request({"ping": 1}, timeout=15)
                self.health.latency_ms = round((time.perf_counter() - t0) * 1000, 1)
                misses = 0
            except Exception:
                misses += 1
                if misses >= 2 and self._ws is not None:  # dead link -> force reconnect
                    log.warning("heartbeat lost - reconnecting")
                    with contextlib.suppress(Exception):
                        await self._ws.close()
                    return

    async def _reader(self, ws) -> None:
        try:
            async for raw in ws:
                self.health.last_message = time.time()
                try:
                    msg = json.loads(raw)
                except ValueError:
                    continue
                await self._dispatch(msg)
        except ConnectionClosed as e:
            self.health.last_error = f"closed: {e.code} {e.reason}"

    async def _dispatch(self, msg: dict) -> None:
        req_id = msg.get("req_id")
        fut = self._pending.pop(req_id, None) if req_id is not None else None
        if fut is not None:  # first response of a request/subscription
            if not fut.done():
                fut.set_result(msg)
            return
        sub_id = (msg.get("subscription") or {}).get("id")
        if not sub_id:
            return
        for s in self._subs.values():
            if s.sub_id == sub_id or (s.sub_id is None and s.request.get("req_id") == req_id):
                s.sub_id = sub_id
                s.push(msg)   # never await callbacks in the reader -> no deadlock
                return

    def _fail_pending(self, exc: Exception) -> None:
        for fut in self._pending.values():
            if not fut.done():
                fut.set_exception(exc)
        self._pending.clear()

    # ---------- requests ----------
    async def request(self, payload: dict, timeout: float | None = None) -> dict:
        if self._ws is None:
            raise NotConnected("not connected to Deriv")
        req = dict(payload)
        req["req_id"] = next(self._ids)
        fut: asyncio.Future = asyncio.get_running_loop().create_future()
        self._pending[req["req_id"]] = fut
        try:
            await self._ws.send(json.dumps(req))
        except Exception as e:
            self._pending.pop(req["req_id"], None)
            raise ConnectionLost(str(e)) from e
        try:
            msg = await asyncio.wait_for(fut, timeout or self.timeout)
        except asyncio.TimeoutError:
            self._pending.pop(req["req_id"], None)
            raise
        if "error" in msg:
            err = msg["error"]
            raise DerivError(err.get("code", "Error"), err.get("message", ""), err.get("details"))
        return msg

    async def subscribe(self, key: str, payload: dict, callback: Callback) -> dict | None:
        """Persistent subscription keyed by `key`; restored after reconnects."""
        await self.unsubscribe(key)
        sub = _Sub(request={**payload, "subscribe": 1}, callback=callback, key=key)
        self._subs[key] = sub
        if self._ws is not None:
            return await self._activate(sub)
        return None

    async def _activate(self, sub: _Sub) -> dict:
        req = dict(sub.request)
        req["req_id"] = next(self._ids)
        sub.request["req_id"] = req["req_id"]
        fut = asyncio.get_running_loop().create_future()
        self._pending[req["req_id"]] = fut
        await self._ws.send(json.dumps(req))
        msg = await asyncio.wait_for(fut, self.timeout)
        if "error" in msg:
            raise DerivError(msg["error"].get("code"), msg["error"].get("message"))
        sid = (msg.get("subscription") or {}).get("id")
        if sid:
            sub.sub_id = sid
        sub.push(msg)
        return msg

    async def unsubscribe(self, key: str) -> None:
        sub = self._subs.pop(key, None)
        if sub:
            sub.close()
        if sub and sub.sub_id and self._ws is not None:
            with contextlib.suppress(Exception):
                await self.request({"forget": sub.sub_id}, timeout=5)

    # ---------- typed helpers ----------
    async def active_symbols(self) -> list[dict]:
        return (await self.request({"active_symbols": "brief", "product_type": "basic"}))["active_symbols"]

    async def contracts_for(self, symbol: str) -> dict:
        return (await self.request({"contracts_for": symbol}))["contracts_for"]

    async def candles(self, symbol: str, granularity: int, count: int = 500,
                      end: int | str = "latest", start: int | None = None) -> list[dict]:
        req = {"ticks_history": symbol, "style": "candles", "granularity": granularity,
               "end": end, "adjust_start_time": 1}
        if start:
            req["start"] = start
        else:
            req["count"] = min(count, 5000)
        return (await self.request(req, timeout=40)).get("candles", [])

    async def history_range(self, symbol: str, granularity: int, start: int, end: int) -> list[dict]:
        """Paginate ticks_history to cover long periods (max 5000 candles / call)."""
        out: list[dict] = []
        cursor_end = end
        while cursor_end > start:
            batch = await self.candles(symbol, granularity, count=5000, end=cursor_end)
            batch = [c for c in batch if c["epoch"] >= start]
            if not batch:
                break
            out = batch + out
            first = batch[0]["epoch"]
            if first <= start or len(batch) < 2:
                break
            cursor_end = first - 1
            await asyncio.sleep(0.3)  # be polite with rate limits
        dedup = {c["epoch"]: c for c in out}
        return [dedup[k] for k in sorted(dedup)]

    async def proposal(self, **params) -> dict:
        return (await self.request({"proposal": 1, **params}))["proposal"]

    async def buy(self, proposal_id: str, max_price: float, passthrough: dict | None = None) -> dict:
        req = {"buy": proposal_id, "price": round(max_price, 2)}
        if passthrough:
            req["passthrough"] = passthrough
        return (await self.request(req, timeout=30))["buy"]

    async def sell(self, contract_id: int, price: float = 0) -> dict:
        return (await self.request({"sell": int(contract_id), "price": price}))["sell"]

    async def contract_status(self, contract_id: int | str) -> dict:
        return (await self.request({"proposal_open_contract": 1,
                                    "contract_id": int(contract_id)}))["proposal_open_contract"]

    async def portfolio(self) -> list[dict]:
        return (await self.request({"portfolio": 1}))["portfolio"]["contracts"]

    async def profit_table(self, limit: int = 50, date_from: int | None = None) -> list[dict]:
        req: dict = {"profit_table": 1, "description": 1, "limit": limit, "sort": "DESC"}
        if date_from:
            req["date_from"] = date_from
        return (await self.request(req))["profit_table"]["transactions"]

    async def statement(self, limit: int = 50) -> list[dict]:
        return (await self.request({"statement": 1, "description": 1, "limit": limit}))["statement"]["transactions"]

    async def balance(self) -> dict:
        return (await self.request({"balance": 1}))["balance"]
