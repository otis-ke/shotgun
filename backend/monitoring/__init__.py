"""Event bus (backend -> dashboard), error capture and health monitoring."""
from __future__ import annotations

import asyncio
import collections
import json
import logging
import time
from typing import Any


class EventBus:
    """Fan-out of live events to dashboard sockets. Events with a user_id only reach that user;
    events without one (public market ticks) reach everybody."""
    def __init__(self, history: int = 1000):
        self._subs: dict[asyncio.Queue, str | None] = {}
        self.recent: collections.deque = collections.deque(maxlen=history)

    def subscribe(self, user_id: str | None = None) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue(maxsize=1000)
        self._subs[q] = user_id
        return q

    def unsubscribe(self, q: asyncio.Queue) -> None:
        self._subs.pop(q, None)

    def recent_for(self, user_id: str | None, n: int = 50) -> list:
        return [m for m in self.recent if m.get("user_id") in (None, user_id)][-n:]

    def publish(self, kind: str, data: Any, user_id: str | None = None) -> None:
        msg = {"type": kind, "ts": time.time(), "data": data, "user_id": user_id}
        if kind not in ("tick",):
            self.recent.append(msg)
        payload = json.loads(json.dumps(msg, default=str))
        for q, uid in list(self._subs.items()):
            if user_id is not None and uid != user_id:
                continue
            try:
                q.put_nowait(payload)
            except asyncio.QueueFull:  # slow client - drop oldest
                try:
                    q.get_nowait()
                    q.put_nowait(payload)
                except Exception:
                    pass


bus = EventBus()


class ErrorCapture(logging.Handler):
    """Mirrors WARNING+ log records to the dashboard error monitor."""
    def __init__(self, maxlen: int = 500):
        super().__init__(level=logging.WARNING)
        self.items: collections.deque = collections.deque(maxlen=maxlen)

    def emit(self, record: logging.LogRecord) -> None:
        item = {"ts": record.created, "level": record.levelname, "logger": record.name,
                "message": record.getMessage()}
        if record.exc_info:
            item["exception"] = logging.Formatter().formatException(record.exc_info)[-2000:]
        self.items.append(item)
        try:
            bus.publish("error", item, user_id="__admin__")
        except Exception:
            pass


errors = ErrorCapture()


def setup_logging(level: str = "INFO") -> None:
    root = logging.getLogger()
    if any(isinstance(h, ErrorCapture) for h in root.handlers):
        return
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    root.addHandler(errors)
