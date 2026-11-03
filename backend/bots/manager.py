"""Bot Management Center + coordination.

Each bot has its own versioned configuration (strategy params, symbols, timeframe, contract,
stake cap, min confidence, enable flag) and its own statistics. Bots share one market feed and
one analysis per closed candle, but never touch each other's settings or positions.
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass, field

import pandas as pd

from .. import database as db
from .. import indicators as ind
from ..ai_engine import optimizer
from ..ai_engine.calibration import expected_value
from ..ai_engine.smart_bot import decide
from ..analysis import analyze
from ..deriv.client import DerivClient
from ..deriv.feed import MarketFeed
from ..execution import ExecutionEngine, OrderRequest
from ..monitoring import bus
from ..strategies.library import STRATEGIES

log = logging.getLogger("bots")

MODES = ("demo", "manual", "semi", "full")


@dataclass
class BotRuntime:
    bot_id: str
    running: bool = False
    last_signal: dict | None = None
    last_eval: float | None = None
    errors: int = 0
    subscriptions: set = field(default_factory=set)


class BotManager:
    def __init__(self, client: DerivClient, feed: MarketFeed, execution: ExecutionEngine, user_id: str | None = None):
        self.client, self.feed, self.exe = client, feed, execution
        self.uid = user_id
        self.memory = execution.memory
        self.rt: dict[str, BotRuntime] = {b: BotRuntime(b) for b in optimizer.DEFAULT_BOTS}
        self.snapshots: dict[str, dict] = {}
        self._analysis_cache: dict[tuple, tuple[pd.DataFrame, object]] = {}
        self._epoch_seen: set[tuple] = set()
        feed.on_candle_closed(self.on_candle_closed)

    # ---------- mode ----------
    def _k(self, key: str) -> str:
        return db.ukey(self.uid, key)

    def _mine(self, table):
        return table.c.user_id == self.uid if self.uid else table.c.user_id.is_(None)

    def mode(self) -> str:
        return db.kv_get(self._k("mode"), "demo")

    def set_mode(self, mode: str) -> str:
        if mode not in MODES:
            raise ValueError(f"mode must be one of {MODES}")
        if mode != "demo" and self.client.health.authorized and not self.client.health.is_virtual:
            auth = db.kv_get(self._k("real_trading_authorization")) or {}
            if not (auth.get("authorized") and auth.get("loginid") == self.client.health.loginid):
                raise PermissionError("connected to a REAL account - authorize real trading first")
        db.kv_set(self._k("mode"), mode)
        db.audit("mode", f"operating mode set to {mode}", user_id=self.uid)
        bus.publish("mode", {"mode": mode}, user_id=self.uid)
        return mode

    # ---------- lifecycle ----------
    async def start_bot(self, bot_id: str) -> None:
        cfg = optimizer.active(self.uid, bot_id)
        rt = self.rt[bot_id]
        if rt.running:
            return
        if db.kv_get(self._k("global_stop")):
            raise PermissionError("emergency stop active - clear it first")
        for sym in cfg["symbols"]:
            await self.feed.ensure(sym, cfg["granularity"])
            rt.subscriptions.add((sym, cfg["granularity"]))
        rt.running = True
        if not cfg.get("enabled"):
            optimizer.update_operational(self.uid, bot_id, {"enabled": True})
        db.audit("bots", f"{bot_id} started", symbols=cfg["symbols"], granularity=cfg["granularity"], user_id=self.uid)
        bus.publish("bot", self.bot_status(bot_id), user_id=self.uid)

    async def stop_bot(self, bot_id: str, persist: bool = True) -> None:
        rt = self.rt[bot_id]
        for sym, g in list(rt.subscriptions):
            await self.feed.release(sym, g)
        rt.subscriptions.clear()
        rt.running = False
        if persist and optimizer.active(self.uid, bot_id).get("enabled"):
            optimizer.update_operational(self.uid, bot_id, {"enabled": False})
        db.audit("bots", f"{bot_id} stopped", user_id=self.uid)
        bus.publish("bot", self.bot_status(bot_id), user_id=self.uid)

    async def restart_bot(self, bot_id: str) -> None:
        if self.rt[bot_id].running:
            await self.stop_bot(bot_id, persist=False)
            await self.start_bot(bot_id)

    async def restore_enabled(self) -> None:
        if db.kv_get(self._k("global_stop")):
            return
        for b in self.rt:
            try:
                if optimizer.active(self.uid, b).get("enabled"):
                    await self.start_bot(b)
            except Exception as e:
                log.warning("could not start %s: %s", b, e)

    async def emergency_stop(self, reason: str = "user") -> dict:
        db.kv_set(self._k("global_stop"), {"reason": reason, "since": time.time()})
        for b, rt in self.rt.items():
            if rt.running:
                await self.stop_bot(b, persist=False)
        for s in db.rows(db.select(db.signals.c.id).where((db.signals.c.status == "pending") & self._mine(db.signals))):
            db.execute(db.update(db.signals).where(db.signals.c.id == s["id"]).values(status="expired",
                                                                                       decision="emergency stop"))
        db.audit("bots", f"EMERGENCY STOP: {reason}", level="WARN", user_id=self.uid)
        bus.publish("emergency_stop", {"active": True, "reason": reason}, user_id=self.uid)
        return {"stopped": True}

    def clear_emergency_stop(self) -> None:
        db.kv_set(self._k("global_stop"), None)
        db.audit("bots", "emergency stop cleared", user_id=self.uid)
        bus.publish("emergency_stop", {"active": False}, user_id=self.uid)

    # ---------- analysis ----------
    def _analysis(self, symbol: str, gran: int, df: pd.DataFrame):
        key = (symbol, gran, int(df.index[-1]))
        hit = self._analysis_cache.get(key)
        if hit:
            return hit
        f = ind.compute_all(df)
        snap = analyze(symbol, gran, df, f=f)
        self._analysis_cache = {k: v for k, v in self._analysis_cache.items() if k[:2] != (symbol, gran)}
        self._analysis_cache[key] = (f, snap)
        self.snapshots[f"{symbol}:{gran}"] = snap.to_dict()
        bus.publish("analysis", snap.to_dict(), user_id=self.uid)
        return f, snap

    async def on_candle_closed(self, symbol: str, gran: int, df: pd.DataFrame) -> None:
        if len(df) < 60:
            return
        f, snap = self._analysis(symbol, gran, df)
        epoch = int(df.index[-1])
        for bot_id, rt in self.rt.items():
            if not rt.running or (symbol, gran) not in rt.subscriptions:
                continue
            k = (bot_id, symbol, epoch)
            if k in self._epoch_seen:      # each bot evaluates each candle once (reconnect-safe)
                continue
            self._epoch_seen.add(k)
            try:
                await self._evaluate(bot_id, symbol, gran, df, f, snap)
                rt.last_eval = time.time()
            except Exception:
                rt.errors += 1
                log.exception("bot %s evaluation failed", bot_id)
        if len(self._epoch_seen) > 20000:
            self._epoch_seen = set(list(self._epoch_seen)[-5000:])

    def _specialist(self, sid: str, df, f, params: dict | None = None):
        strat = STRATEGIES[sid]
        return strat.latest(df, f, params)

    async def _evaluate(self, bot_id: str, symbol: str, gran: int, df, f, snap) -> None:
        cfg = optimizer.active(self.uid, bot_id)
        payout = cfg.get("payout_assumption", 0.9)
        be = 1 / (1 + payout)
        demo_acct = bool(self.client.health.is_virtual)
        regime = snap.regime["name"]
        reasons: list[str] = []
        if cfg["strategy"] == "smart_ai":
            sigs = {}
            for sid in STRATEGIES:
                try:
                    params = optimizer.active(self.uid, sid)["params"] if sid in self.rt else None
                except KeyError:
                    params = None
                sigs[sid] = self._specialist(sid, df, f, params)
            d = decide(sigs, regime, snap.htf_trend, self.memory, payout, cfg.get("min_agree", 2), cfg.get("min_ev", 0.02),
                       allow_uncalibrated=demo_acct and cfg.get("allow_uncalibrated_demo", True))
            if not d.trade:
                self.rt[bot_id].last_signal = {"ts": time.time(), "symbol": symbol, "action": "no_trade",
                                               "reasons": d.reasons}
                bus.publish("ai_decision", {"bot_id": bot_id, "symbol": symbol, "trade": False, "reasons": d.reasons,
                                            "votes": d.votes}, user_id=self.uid)
                return
            direction, score, strat_id, p, ev = d.direction, d.confidence, d.strategy, d.p_win, d.ev
            reasons = d.reasons
            raw = sigs[strat_id].score
        else:
            s = self._specialist(cfg["strategy"], df, f, cfg.get("params"))
            if s is None:
                return
            direction, score, strat_id, raw = s.direction, s.score, s.strategy, s.score
            cal = self.memory.calibrator(strat_id)
            p = cal.p_win(raw) if cal.ready else None
            ev = expected_value(p, payout)
            reasons = s.reasons + [f"regime {regime}"]
            if p is not None:
                reasons.append(f"calibrated p_win {p:.1%} vs breakeven {be:.1%} (n={cal.n})")
        status, decision = "pending", ""
        if score < cfg.get("min_confidence", 70):
            status, decision = "rejected", f"confidence {score:.0f} < {cfg.get('min_confidence', 70)}"
        elif p is None and not (demo_acct and cfg.get("allow_uncalibrated_demo", True)):
            status, decision = "rejected", "strategy not yet validated out-of-sample (run walk-forward)"
        elif p is not None and (ev or 0) <= 0:
            status, decision = "rejected", f"calibrated EV {ev:+.3f} <= 0"
        conflict = self._conflict(symbol, direction)
        if status == "pending" and conflict:
            status, decision = "rejected", conflict
        sig_id = db.execute(db.insert(db.signals).values(
            user_id=self.uid, ts=time.time(), bot_id=bot_id, symbol=symbol, direction=direction,
            contract_type=cfg["contract"]["family"], confidence=round(score, 1), calibrated_p=p, regime=regime,
            reasons=reasons, features={"strategy": strat_id, "raw_score": raw, "ev": ev, "epoch": int(df.index[-1])},
            status=status, decision=decision)).inserted_primary_key[0]
        sig = {"id": sig_id, "bot_id": bot_id, "symbol": symbol, "direction": direction, "confidence": round(score, 1),
               "p_win": p, "ev": ev, "status": status, "decision": decision, "reasons": reasons, "regime": regime}
        self.rt[bot_id].last_signal = sig
        bus.publish("signal", sig, user_id=self.uid)
        if status != "pending":
            return
        mode = self.mode()
        auto = mode in ("demo", "full") or (mode == "semi" and cfg.get("auto_execute"))
        if mode == "demo" and not demo_acct:
            auto = False
            self._set_signal(sig_id, "rejected", "demo mode but connected account is REAL")
            return
        if not auto:
            bus.publish("approval_needed", sig, user_id=self.uid)
            return
        await self._execute_signal(sig_id, cfg, snap, strat_id, raw)

    def _conflict(self, symbol: str, direction: str) -> str | None:
        open_t = db.rows(db.select(db.trades.c.direction, db.trades.c.bot_id).where(
            (db.trades.c.status == "open") & (db.trades.c.symbol == symbol) & self._mine(db.trades)))
        for t in open_t:
            if t["direction"] and t["direction"] != direction:
                return f"conflicts with open {t['direction']} position from {t['bot_id']}"
        recent = db.rows(db.select(db.signals.c.bot_id).where(
            (db.signals.c.symbol == symbol) & (db.signals.c.direction == direction) & self._mine(db.signals) &
            (db.signals.c.status.in_(["executed", "pending", "approved"])) & (db.signals.c.ts >= time.time() - 30)))
        if recent:
            return f"duplicate of signal from {recent[0]['bot_id']}"
        return None

    def _set_signal(self, sid: int, status: str, decision: str) -> None:
        db.execute(db.update(db.signals).where(db.signals.c.id == sid).values(status=status, decision=decision))
        bus.publish("signal_update", {"id": sid, "status": status, "decision": decision}, user_id=self.uid)

    async def _execute_signal(self, sig_id: int, cfg: dict, snap, strat_id: str, raw: float) -> dict:
        s = db.rows(db.select(db.signals).where(db.signals.c.id == sig_id))[0]
        req = OrderRequest(bot_id=s["bot_id"], symbol=s["symbol"], direction=s["direction"], contract=cfg["contract"],
                           confidence=s["confidence"], signal_id=sig_id, atr=(snap.indicators or {}).get("atr"),
                           regime=s["regime"], payout_assumption=cfg.get("payout_assumption", 0.9),
                           max_stake=cfg.get("max_stake"),
                           features={"strategy": strat_id, "raw_score": raw, "p_win": s["calibrated_p"]})
        res = await self.exe.execute(req)
        self._set_signal(sig_id, "executed" if res.ok else "rejected",
                         res.message if not res.ok else f"contract {res.contract_id}")
        return res.__dict__

    async def approve(self, sig_id: int) -> dict:
        r = db.rows(db.select(db.signals).where((db.signals.c.id == sig_id) & self._mine(db.signals)))
        if not r:
            raise KeyError(sig_id)
        s = r[0]
        if s["status"] != "pending":
            raise ValueError(f"signal is {s['status']}")
        cfg = optimizer.active(self.uid, s["bot_id"])
        if time.time() - s["ts"] > cfg["granularity"]:
            self._set_signal(sig_id, "expired", "setup older than one candle")
            raise ValueError("signal expired")
        snap_d = self.snapshots.get(f"{s['symbol']}:{cfg['granularity']}") or {}

        class _S:  # minimal snapshot shim for ATR
            indicators = snap_d.get("indicators", {})
        db.audit("bots", f"signal {sig_id} approved by user", user_id=self.uid)
        return await self._execute_signal(sig_id, cfg, _S, s["features"].get("strategy"), s["features"].get("raw_score"))

    def reject(self, sig_id: int) -> None:
        if not db.rows(db.select(db.signals.c.id).where((db.signals.c.id == sig_id) & self._mine(db.signals))):
            raise KeyError(sig_id)
        self._set_signal(sig_id, "rejected", "rejected by user")

    # ---------- reporting ----------
    def bot_status(self, bot_id: str) -> dict:
        cfg = optimizer.active(self.uid, bot_id)
        rt = self.rt[bot_id]
        return {"id": bot_id, "name": cfg.get("name"), "strategy": cfg["strategy"], "running": rt.running,
                "enabled": cfg.get("enabled"), "symbols": cfg["symbols"], "granularity": cfg["granularity"],
                "contract": cfg["contract"], "params": cfg.get("params"), "min_confidence": cfg.get("min_confidence"),
                "auto_execute": cfg.get("auto_execute"), "max_stake": cfg.get("max_stake"),
                "payout_assumption": cfg.get("payout_assumption"), "version": cfg["_version"],
                "validated": bool((cfg.get("_validation") or {}).get("passed_validation")),
                "last_signal": rt.last_signal, "last_eval": rt.last_eval, "errors": rt.errors,
                "description": STRATEGIES[cfg["strategy"]].description if cfg["strategy"] in STRATEGIES
                else "Meta-strategy: weighs the specialists by validated performance and regime, stands aside on conflict.",
                "stats": bot_stats(self.uid, bot_id)}

    async def check_degradation(self) -> list[dict]:
        out = []
        auto = db.kv_get(self._k("auto_disable_degraded"), True)
        for b, rt in self.rt.items():
            try:
                d = optimizer.degradation(self.uid, b)
            except Exception:
                continue
            out.append(d)
            if d["degraded"] and rt.running and auto:
                await self.stop_bot(b)
                db.audit("bots", f"{b} auto-disabled: live win rate {d['win_rate']} significantly below "
                                 f"expected {d['expected']} (z={d['z']})", level="WARN", user_id=self.uid)
        return out


def bot_stats(uid: str | None, bot_id: str | None = None, since: float | None = None) -> dict:
    mine = db.trades.c.user_id == uid if uid else db.trades.c.user_id.is_(None)
    q = db.select(db.trades).where(db.trades.c.status.in_(["won", "lost", "sold"]) & mine)
    if bot_id:
        q = q.where(db.trades.c.bot_id == bot_id)
    if since:
        q = q.where(db.trades.c.sell_time >= since)
    t = db.rows(q.order_by(db.trades.c.sell_time))
    n = len(t)
    wins = sum(1 for x in t if (x["profit"] or 0) > 0)
    pnl = [x["profit"] or 0 for x in t]
    gp, gl = sum(p for p in pnl if p > 0), -sum(p for p in pnl if p <= 0)
    eq = peak = dd = 0.0
    for p in pnl:
        eq += p
        peak = max(peak, eq)
        dd = max(dd, peak - eq)
    oq = db.select(db.trades.c.contract_id).where((db.trades.c.status == "open") & mine)
    if bot_id:
        oq = oq.where(db.trades.c.bot_id == bot_id)
    open_n = len(db.rows(oq))
    return {"trades": n, "wins": wins, "losses": n - wins, "win_rate": round(wins / n, 4) if n else None,
            "net_profit": round(sum(pnl), 2), "profit_factor": round(gp / gl, 3) if gl else None,
            "max_drawdown": round(dd, 2), "open": open_n,
            "expectancy": round(sum(pnl) / n, 4) if n else None}
