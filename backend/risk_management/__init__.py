"""Global risk manager. Every order from every bot (including Smart AI) passes through `check`.

Sizing is a fixed fraction of current balance - it never depends on previous outcomes, so
martingale / loss-chasing / doubling is structurally impossible.
"""
from __future__ import annotations

import threading
import time
from dataclasses import asdict, dataclass
from datetime import datetime, timezone

from .. import database as db

DEFAULT_RISK = {
    "risk_pct_per_trade": 1.0,       # % of balance staked (= max loss for Deriv options)
    "fixed_stake": None,             # overrides % sizing if set
    "min_stake": 0.35,               # Deriv minimum for most contracts (USD)
    "max_stake": 50.0,               # absolute cap per trade
    "max_daily_loss_pct": 3.0,
    "max_drawdown_pct": 10.0,
    "max_consecutive_losses": 3,
    "cooldown_minutes": 60,          # pause after hitting max consecutive losses
    "max_open_trades": 3,
    "max_open_per_symbol": 1,
    "max_trades_per_hour": 10,
    "max_exposure_pct": 3.0,         # sum of open stakes as % of balance
    "daily_profit_target_pct": 5.0,  # stop for the day once reached (None = off)
    "min_balance": 10.0,             # account protection floor
}


@dataclass
class RiskDecision:
    approved: bool
    stake: float = 0.0
    reasons: list[str] | None = None
    state: dict | None = None

    def to_dict(self) -> dict:
        return asdict(self)


def _utc_day_start(ts: float | None = None) -> float:
    d = datetime.fromtimestamp(ts or time.time(), tz=timezone.utc)
    return datetime(d.year, d.month, d.day, tzinfo=timezone.utc).timestamp()


class RiskManager:
    def __init__(self, user_id: str | None = None):
        self.uid = user_id
        self._lock = threading.RLock()
        self.reserved: dict[str, dict] = {}  # coid -> in-flight orders not yet in trades table

    def _k(self, key: str) -> str:
        return db.ukey(self.uid, key)

    def _mine(self, table):
        return table.c.user_id == self.uid if self.uid else table.c.user_id.is_(None)

    # ---------- configuration ----------
    def config(self) -> dict:
        return {**DEFAULT_RISK, **(db.kv_get(self._k("risk_config"), {}) or {})}

    def update_config(self, changes: dict) -> dict:
        bad = set(changes) - set(DEFAULT_RISK)
        if bad:
            raise ValueError(f"unknown risk settings {sorted(bad)}")
        for k in ("risk_pct_per_trade", "max_daily_loss_pct", "max_drawdown_pct", "max_exposure_pct"):
            if k in changes and changes[k] is not None and not 0 < float(changes[k]) <= 100:
                raise ValueError(f"{k} must be between 0 and 100")
        if changes.get("risk_pct_per_trade") and float(changes["risk_pct_per_trade"]) > 5:
            raise ValueError("risk per trade above 5% is not allowed")
        cfg = {**self.config(), **changes}
        db.kv_set(self._k("risk_config"), cfg)
        db.audit("risk", "risk configuration updated", changes=changes, user_id=self.uid)
        return cfg

    # ---------- state ----------
    def record_balance(self, balance: float, loginid: str | None = None, currency: str | None = None) -> None:
        key = self._k(f"peak:{loginid or 'default'}")
        peak = db.kv_get(key)
        if peak is None or balance > peak:
            db.kv_set(key, balance)
        dkey = self._k(f"day_start:{loginid or 'default'}:{int(_utc_day_start())}")
        if db.kv_get(dkey) is None:
            db.kv_set(dkey, balance)

    def reset_peak(self, balance: float, loginid: str | None = None) -> None:
        db.kv_set(self._k(f"peak:{loginid or 'default'}"), balance)
        db.audit("risk", "drawdown peak reset by user", balance=balance, user_id=self.uid)

    def suspension(self) -> dict | None:
        s = db.kv_get(self._k("suspension"))
        if s and s.get("until") and s["until"] < time.time():
            db.kv_set(self._k("suspension"), None)
            db.audit("risk", "trading suspension expired", user_id=self.uid)
            return None
        return s

    def suspend(self, reason: str, minutes: float | None = None) -> None:
        until = time.time() + minutes * 60 if minutes else None
        cur = self.suspension()
        if cur and cur.get("reason") == reason:
            return
        db.kv_set(self._k("suspension"), {"reason": reason, "since": time.time(), "until": until})
        db.audit("risk", f"TRADING SUSPENDED: {reason}", level="WARN", until=until, user_id=self.uid)

    def resume(self) -> None:
        db.kv_set(self._k("suspension"), None)
        db.audit("risk", "trading suspension cleared by user", user_id=self.uid)

    def state(self, balance: float | None, loginid: str | None = None) -> dict:
        cfg = self.config()
        day0 = _utc_day_start()
        tr = db.trades
        closed_today = db.rows(db.select(tr.c.profit, tr.c.status).where(
            (tr.c.sell_time >= day0) & tr.c.status.in_(["won", "lost", "sold"]) & self._mine(tr)))
        day_pnl = round(sum(t["profit"] or 0 for t in closed_today), 2)
        last = db.rows(db.select(tr.c.status, tr.c.sell_time).where(tr.c.status.in_(["won", "lost", "sold"]) & self._mine(tr))
                       .order_by(tr.c.sell_time.desc()).limit(max(20, cfg["max_consecutive_losses"] + 1)))
        consec = 0
        for t in last:
            if t["status"] == "won":
                break
            consec += 1
        open_t = db.rows(db.select(tr.c.symbol, tr.c.stake, tr.c.bot_id).where((tr.c.status == "open") & self._mine(tr)))
        with self._lock:
            reserved = list(self.reserved.values())
        open_all = open_t + reserved
        exposure = round(sum(t["stake"] or 0 for t in open_all), 2)
        hour_orders = db.rows(db.select(db.func.count()).select_from(db.orders).where(
            (db.orders.c.ts >= time.time() - 3600) & db.orders.c.status.in_(["SENT", "BOUGHT", "UNKNOWN"])
            & self._mine(db.orders)))
        n_hour = int(list(hour_orders[0].values())[0])
        day_start_bal = db.kv_get(self._k(f"day_start:{loginid or 'default'}:{int(day0)}")) or balance
        peak = db.kv_get(self._k(f"peak:{loginid or 'default'}")) or balance
        dd = ((peak - balance) / peak * 100) if (peak and balance is not None) else 0.0
        return {"balance": balance, "day_start_balance": day_start_bal, "daily_pnl": day_pnl,
                "daily_pnl_pct": round(day_pnl / day_start_bal * 100, 3) if day_start_bal else 0.0,
                "peak_balance": peak, "drawdown_pct": round(dd, 3), "consecutive_losses": consec,
                "open_trades": len(open_all), "exposure": exposure,
                "exposure_pct": round(exposure / balance * 100, 3) if balance else None,
                "trades_last_hour": n_hour, "suspension": self.suspension(), "limits": cfg}

    # ---------- decision ----------
    def size(self, balance: float, bot_max_stake: float | None = None) -> float:
        cfg = self.config()
        stake = cfg["fixed_stake"] or balance * cfg["risk_pct_per_trade"] / 100
        stake = min(stake, cfg["max_stake"], bot_max_stake or float("inf"))
        return round(stake, 2)

    def check(self, *, balance: float | None, symbol: str, bot_id: str, loginid: str | None = None,
              bot_max_stake: float | None = None) -> RiskDecision:
        cfg = self.config()
        if balance is None:
            return RiskDecision(False, reasons=["account balance unknown"])
        st = self.state(balance, loginid)
        r: list[str] = []
        if st["suspension"]:
            r.append(f"trading suspended: {st['suspension']['reason']}")
        if balance < cfg["min_balance"]:
            r.append(f"balance {balance} below protection floor {cfg['min_balance']}")
        if st["daily_pnl_pct"] <= -cfg["max_daily_loss_pct"]:
            self.suspend(f"max daily loss {cfg['max_daily_loss_pct']}% reached",
                         minutes=(_utc_day_start() + 86400 - time.time()) / 60)
            r.append("max daily loss reached")
        if st["drawdown_pct"] >= cfg["max_drawdown_pct"]:
            self.suspend(f"max drawdown {cfg['max_drawdown_pct']}% reached - manual review required")
            r.append("max drawdown reached")
        if st["consecutive_losses"] >= cfg["max_consecutive_losses"]:
            self.suspend(f"{st['consecutive_losses']} consecutive losses - cooldown",
                         minutes=cfg["cooldown_minutes"])
            r.append("consecutive loss limit")
        tgt = cfg.get("daily_profit_target_pct")
        if tgt and st["daily_pnl_pct"] >= tgt:
            r.append(f"daily profit target {tgt}% reached - done for today")
        if st["open_trades"] >= cfg["max_open_trades"]:
            r.append("max simultaneous trades reached")
        open_sym = db.rows(db.select(db.func.count()).select_from(db.trades).where(
            (db.trades.c.status == "open") & (db.trades.c.symbol == symbol) & self._mine(db.trades)))
        n_sym = int(list(open_sym[0].values())[0]) + sum(1 for x in self.reserved.values() if x["symbol"] == symbol)
        if n_sym >= cfg["max_open_per_symbol"]:
            r.append(f"already have an open position on {symbol}")
        if st["trades_last_hour"] >= cfg["max_trades_per_hour"]:
            r.append("max trades per hour reached")
        stake = self.size(balance, bot_max_stake)
        if stake < cfg["min_stake"]:
            r.append(f"computed stake {stake} below Deriv minimum {cfg['min_stake']}")
        if balance and (st["exposure"] + stake) / balance * 100 > cfg["max_exposure_pct"]:
            r.append(f"exposure would exceed {cfg['max_exposure_pct']}% of balance")
        if stake > balance:
            r.append("stake exceeds balance")
        return RiskDecision(not r, stake if not r else 0.0, r or ["all risk checks passed"], st)

    def reserve(self, coid: str, symbol: str, stake: float, bot_id: str) -> None:
        with self._lock:
            self.reserved[coid] = {"symbol": symbol, "stake": stake, "bot_id": bot_id}

    def release(self, coid: str) -> None:
        with self._lock:
            self.reserved.pop(coid, None)

