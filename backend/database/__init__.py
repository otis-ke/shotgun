"""Persistence layer (SQLAlchemy Core). SQLite by default; set DATABASE_URL for PostgreSQL."""
from __future__ import annotations

import json
import shutil
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from sqlalchemy import (JSON, Boolean, Column, Float, Integer, MetaData, String, Table, Text,
                        create_engine, event, func, insert, select, update)
from sqlalchemy.engine import Engine

from ..config import settings

metadata = MetaData()

users = Table("users", metadata,
              Column("id", String(40), primary_key=True),          # Deriv user_id
              Column("email", String(200)),
              Column("fullname", String(200)),
              Column("accounts", JSON, nullable=False),           # [{loginid, currency, is_virtual, token_enc}]
              Column("active_loginid", String(24)),
              Column("is_admin", Boolean, default=False),
              Column("disabled", Boolean, default=False),
              Column("created_at", Float, nullable=False),
              Column("last_login", Float))

kv = Table("kv", metadata,
           Column("key", String(160), primary_key=True),
           Column("value", JSON, nullable=False),
           Column("updated_at", Float, nullable=False))

bot_configs = Table("bot_configs", metadata,
                    Column("id", Integer, primary_key=True, autoincrement=True),
                    Column("user_id", String(40), index=True),
                    Column("bot_id", String(32), index=True, nullable=False),
                    Column("version", Integer, nullable=False),
                    Column("params", JSON, nullable=False),
                    Column("status", String(16), nullable=False),  # active|proposed|archived|rejected
                    Column("note", Text, default=""),
                    Column("validation", JSON),
                    Column("created_at", Float, nullable=False))

signals = Table("signals", metadata,
                Column("id", Integer, primary_key=True, autoincrement=True),
                    Column("user_id", String(40), index=True),
                Column("ts", Float, index=True, nullable=False),
                Column("bot_id", String(32), index=True),
                Column("symbol", String(32)),
                Column("direction", String(8)),
                Column("contract_type", String(24)),
                Column("confidence", Float),
                Column("calibrated_p", Float),
                Column("regime", String(16)),
                Column("reasons", JSON),
                Column("features", JSON),
                Column("status", String(16), index=True),  # pending|approved|rejected|executed|expired
                Column("decision", Text))

orders = Table("orders", metadata,
               Column("coid", String(40), primary_key=True),  # client order id (idempotency key)
                    Column("user_id", String(40), index=True),
               Column("ts", Float, nullable=False),
               Column("signal_id", Integer),
               Column("bot_id", String(32), index=True),
               Column("symbol", String(32)),
               Column("contract_type", String(24)),
               Column("request", JSON),
               Column("stake", Float),
               Column("payout", Float),
               Column("status", String(16), index=True),  # PENDING|SENT|BOUGHT|UNKNOWN|REJECTED|FAILED
               Column("contract_id", String(32)),
               Column("error", Text),
               Column("updated_at", Float))

trades = Table("trades", metadata,
               Column("contract_id", String(32), primary_key=True),
                    Column("user_id", String(40), index=True),
               Column("coid", String(40), index=True),
               Column("bot_id", String(32), index=True),
               Column("symbol", String(32)),
               Column("contract_type", String(24)),
               Column("direction", String(8)),
               Column("stake", Float),
               Column("payout", Float),
               Column("buy_time", Float, index=True),
               Column("sell_time", Float),
               Column("entry_spot", Float),
               Column("exit_spot", Float),
               Column("profit", Float),
               Column("status", String(12), index=True),  # open|won|lost|sold
               Column("is_virtual", Boolean),
               Column("confidence", Float),
               Column("regime", String(16)),
               Column("features", JSON))

audit_log = Table("audit_log", metadata,
                  Column("id", Integer, primary_key=True, autoincrement=True),
                    Column("user_id", String(40), index=True),
                  Column("ts", Float, index=True, nullable=False),
                  Column("level", String(8)),
                  Column("category", String(24), index=True),
                  Column("message", Text),
                  Column("data", JSON))

equity = Table("equity", metadata,
               Column("id", Integer, primary_key=True, autoincrement=True),
               Column("user_id", String(40), index=True),
               Column("ts", Float, index=True),
               Column("balance", Float),
               Column("currency", String(8)),
               Column("loginid", String(24)))

candles_cache = Table("candles_cache", metadata,
                      Column("symbol", String(32), primary_key=True),
                      Column("granularity", Integer, primary_key=True),
                      Column("epoch", Integer, primary_key=True),
                      Column("open", Float), Column("high", Float),
                      Column("low", Float), Column("close", Float))

_engine: Engine | None = None


def get_engine() -> Engine:
    global _engine
    if _engine is None:
        url = settings.database_url
        kw: dict[str, Any] = {"future": True}
        if url.startswith("sqlite"):
            path = url.replace("sqlite:///", "")
            if path and path != ":memory:":
                Path(path).parent.mkdir(parents=True, exist_ok=True)
            kw["connect_args"] = {"check_same_thread": False}
        _engine = create_engine(url, **kw)
        if url.startswith("sqlite"):
            @event.listens_for(_engine, "connect")
            def _pragma(conn, _):  # WAL = crash-safe concurrent reads
                cur = conn.cursor()
                cur.execute("PRAGMA journal_mode=WAL")
                cur.execute("PRAGMA synchronous=NORMAL")
                cur.close()
        metadata.create_all(_engine)
    return _engine


def reset_engine(url: str | None = None) -> None:
    """Used by tests."""
    global _engine
    if url:
        settings.database_url = url
    _engine = None


# ---------- helpers ----------
def now() -> float:
    return time.time()


def kv_get(key: str, default: Any = None) -> Any:
    with get_engine().connect() as c:
        row = c.execute(select(kv.c.value).where(kv.c.key == key)).first()
        return row[0] if row else default


def kv_set(key: str, value: Any) -> None:
    eng = get_engine()
    with eng.begin() as c:
        exists = c.execute(select(kv.c.key).where(kv.c.key == key)).first()
        if exists:
            c.execute(update(kv).where(kv.c.key == key).values(value=value, updated_at=now()))
        else:
            c.execute(insert(kv).values(key=key, value=value, updated_at=now()))


def ukey(user_id: str | None, key: str) -> str:
    """Per-user namespacing for key/value settings."""
    return f"u:{user_id}:{key}" if user_id else key


def audit(category: str, message: str, level: str = "INFO", user_id: str | None = None, **data: Any) -> None:
    with get_engine().begin() as c:
        c.execute(insert(audit_log).values(ts=now(), level=level, category=category, user_id=user_id,
                                           message=message, data=json.loads(json.dumps(data, default=str))))


def rows(stmt) -> list[dict]:
    with get_engine().connect() as c:
        return [dict(r._mapping) for r in c.execute(stmt)]


def execute(stmt):
    with get_engine().begin() as c:
        return c.execute(stmt)


def backup_database() -> str | None:
    """Copy the SQLite file (online-safe via sqlite backup API). Postgres: use pg_dump."""
    url = settings.database_url
    if not url.startswith("sqlite"):
        return None
    import sqlite3
    src = url.replace("sqlite:///", "")
    out_dir = Path(settings.backup_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    dst = out_dir / f"terminal-{datetime.now(timezone.utc):%Y%m%d-%H%M%S}.db"
    with sqlite3.connect(src) as s, sqlite3.connect(dst) as d:
        s.backup(d)
    backups = sorted(out_dir.glob("terminal-*.db"))
    for old in backups[:-20]:  # keep last 20
        old.unlink(missing_ok=True)
    return str(dst)


__all__ = ["users", "ukey", "kv", "bot_configs", "signals", "orders", "trades", "audit_log", "equity",
           "candles_cache", "get_engine", "reset_engine", "kv_get", "kv_set", "audit", "rows",
           "execute", "now", "backup_database", "select", "insert", "update", "func", "shutil"]
