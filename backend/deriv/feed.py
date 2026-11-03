"""Live market-data feed: rolling candle buffers per (symbol, granularity) built from
Deriv `ticks_history` candle subscriptions (initial history + streamed `ohlc` updates)."""
from __future__ import annotations

import asyncio
import logging
from collections import defaultdict
from typing import Awaitable, Callable

import pandas as pd

from .client import DerivClient

log = logging.getLogger("feed")

CandleClosedCb = Callable[[str, int, pd.DataFrame], Awaitable[None] | None]


class CandleBuffer:
    def __init__(self, maxlen: int = 1500):
        self.maxlen = maxlen
        self.rows: dict[int, list[float]] = {}  # epoch -> [o,h,l,c]

    def load(self, candles: list[dict]) -> None:
        for c in candles:
            self.rows[int(c["epoch"])] = [float(c["open"]), float(c["high"]), float(c["low"]), float(c["close"])]
        self._trim()

    def update(self, epoch: int, o: float, h: float, l: float, c: float) -> bool:
        """Returns True if this update starts a new candle (previous one closed)."""
        new = epoch not in self.rows
        self.rows[epoch] = [o, h, l, c]
        self._trim()
        return new

    def _trim(self) -> None:
        if len(self.rows) > self.maxlen:
            for k in sorted(self.rows)[: len(self.rows) - self.maxlen]:
                del self.rows[k]

    def frame(self, closed_only: bool = True) -> pd.DataFrame:
        keys = sorted(self.rows)
        if closed_only and keys:
            keys = keys[:-1]  # last candle is still forming -> never used for signals (no look-ahead)
        df = pd.DataFrame([self.rows[k] for k in keys], index=keys, columns=["open", "high", "low", "close"])
        df.index.name = "epoch"
        return df


class MarketFeed:
    def __init__(self, client: DerivClient):
        self.client = client
        self.buffers: dict[tuple[str, int], CandleBuffer] = {}
        self.last_price: dict[str, dict] = {}
        self._closed_cbs: list[CandleClosedCb] = []
        self._tick_cbs: list[Callable[[str, dict], object]] = []
        self.refcount: dict[tuple[str, int], int] = defaultdict(int)

    def on_candle_closed(self, cb: CandleClosedCb) -> None:
        self._closed_cbs.append(cb)

    def on_tick(self, cb) -> None:
        self._tick_cbs.append(cb)

    async def ensure(self, symbol: str, granularity: int) -> None:
        key = (symbol, granularity)
        self.refcount[key] += 1
        if key in self.buffers:
            return
        self.buffers[key] = CandleBuffer()
        await self.client.subscribe(
            f"candles:{symbol}:{granularity}",
            {"ticks_history": symbol, "style": "candles", "granularity": granularity,
             "count": 1000, "end": "latest", "adjust_start_time": 1},
            lambda msg, k=key: self._on_msg(k, msg))

    async def release(self, symbol: str, granularity: int) -> None:
        key = (symbol, granularity)
        self.refcount[key] = max(0, self.refcount[key] - 1)
        if self.refcount[key] == 0 and key in self.buffers:
            await self.client.unsubscribe(f"candles:{symbol}:{granularity}")
            del self.buffers[key]

    async def _on_msg(self, key: tuple[str, int], msg: dict) -> None:
        buf = self.buffers.get(key)
        if buf is None:
            return
        symbol, gran = key
        if "candles" in msg:  # initial snapshot (also after reconnect -> fills gaps)
            buf.load(msg["candles"])
            return
        o = msg.get("ohlc")
        if not o:
            return
        epoch = int(o["open_time"])
        price = float(o["close"])
        self.last_price[symbol] = {"symbol": symbol, "price": price, "epoch": int(o["epoch"])}
        tick = {**self.last_price[symbol], "granularity": gran, "time": epoch, "open": float(o["open"]),
                "high": float(o["high"]), "low": float(o["low"]), "close": price}
        for cb in self._tick_cbs:
            try:
                r = cb(symbol, tick)
                if asyncio.iscoroutine(r):
                    await r
            except Exception:
                log.exception("tick callback")
        started_new = buf.update(epoch, float(o["open"]), float(o["high"]), float(o["low"]), price)
        if started_new:
            df = buf.frame(closed_only=True)
            for cb in self._closed_cbs:
                try:
                    r = cb(symbol, gran, df)
                    if asyncio.iscoroutine(r):
                        await r
                except Exception:
                    log.exception("candle-closed callback")

    def frame(self, symbol: str, granularity: int, closed_only: bool = True) -> pd.DataFrame | None:
        b = self.buffers.get((symbol, granularity))
        return b.frame(closed_only) if b else None
