"""Execution engine: approved signal -> proposal -> buy -> track -> settle.

Duplicate-purchase protection
-----------------------------
1. One signal per (bot, symbol, candle) - enforced by the coordinator.
2. An order row with a unique client order id (coid) is committed *before* `buy` is sent.
3. `buy` is never retried. If the socket drops or times out mid-request the order becomes
   UNKNOWN and ALL new orders are blocked until it is reconciled against Deriv's own
   records (portfolio + profit_table). Reconciliation never re-sends anything.
4. trades.contract_id is a primary key, so the same contract can never be recorded twice.
"""
from __future__ import annotations

import asyncio
import logging
import time
import uuid
from dataclasses import dataclass, field

from .. import database as db
from ..ai_engine.memory import PerformanceMemory
from ..deriv.client import ConnectionLost, DerivClient, DerivError, NotConnected
from ..deriv.contracts import ContractSpec, ContractValidationError, build_proposal, max_loss
from ..monitoring import bus
from ..risk_management import RiskManager

log = logging.getLogger("execution")


@dataclass
class OrderRequest:
    bot_id: str
    symbol: str
    direction: str
    contract: dict
    confidence: float
    signal_id: int | None = None
    atr: float | None = None
    regime: str | None = None
    payout_assumption: float = 0.9
    max_stake: float | None = None
    features: dict = field(default_factory=dict)


@dataclass
class OrderResult:
    ok: bool
    status: str
    coid: str | None = None
    contract_id: str | None = None
    message: str = ""
    details: dict = field(default_factory=dict)


class ExecutionEngine:
    def __init__(self, client: DerivClient, user_id: str | None = None, risk: RiskManager | None = None,
                 memory: PerformanceMemory | None = None):
        self.client = client
        self.uid = user_id
        self.risk = risk or RiskManager(user_id)
        self.memory = memory or PerformanceMemory(user_id)
        self._lock = asyncio.Lock()          # one purchase at a time = no race on limits
        self._contracts_cache: dict[str, tuple[float, dict]] = {}
        self._watch: set[str] = set()

    def _mine(self, table):
        return table.c.user_id == self.uid if self.uid else table.c.user_id.is_(None)

    # ---------- permission gates ----------
    def trading_permission(self) -> tuple[bool, str]:
        if db.kv_get(db.ukey(self.uid, "global_stop")):
            return False, "EMERGENCY STOP is active"
        h = self.client.health
        if not h.connected or not h.authorized:
            return False, "not connected/authorized to Deriv"
        if h.is_virtual:
            return True, "demo account"
        auth = db.kv_get(db.ukey(self.uid, "real_trading_authorization")) or {}
        if auth.get("authorized") and auth.get("loginid") == h.loginid:
            return True, "real account - authorized"
        return False, f"REAL account {h.loginid} not authorized for automated trading"

    def unresolved_orders(self) -> list[dict]:
        return db.rows(db.select(db.orders).where(db.orders.c.status.in_(["PENDING", "SENT", "UNKNOWN"]) &
                                                  self._mine(db.orders)))

    # ---------- contract availability ----------
    async def contracts_for(self, symbol: str) -> dict:
        c = self._contracts_cache.get(symbol)
        if c and c[0] > time.time() - 3600:
            return c[1]
        data = await self.client.contracts_for(symbol)
        self._contracts_cache[symbol] = (time.time(), data)
        return data

    async def check_available(self, symbol: str, contract_type: str, spec: ContractSpec) -> str | None:
        data = await self.contracts_for(symbol)
        avail = [c for c in data.get("available", []) if c.get("contract_type") == contract_type]
        if not avail:
            return f"{contract_type} not offered on {symbol}"
        if spec.family == "multiplier":
            return None
        dur = f"{spec.duration}{spec.duration_unit}"
        mult = {"t": 1, "s": 1, "m": 60, "h": 3600, "d": 86400}

        def secs(x: str) -> float:
            return float(x[:-1]) * mult[x[-1]]
        for c in avail:
            mn, mx = c.get("min_contract_duration"), c.get("max_contract_duration")
            if not mn or not mx:
                continue
            if (mn[-1] == "t") != (spec.duration_unit == "t"):
                continue
            try:
                if secs(mn) <= secs(dur) <= secs(mx):
                    return None
            except (KeyError, ValueError):
                return None
        return f"duration {dur} not allowed for {contract_type} on {symbol}"

    # ---------- main flow ----------
    async def execute(self, req: OrderRequest) -> OrderResult:
        async with self._lock:
            return await self._execute(req)

    async def _execute(self, req: OrderRequest) -> OrderResult:
        ok, why = self.trading_permission()
        if not ok:
            return OrderResult(False, "BLOCKED", message=why)
        if self.unresolved_orders():
            return OrderResult(False, "BLOCKED", message="an earlier order is unresolved - reconciling first")
        if req.signal_id is not None and db.rows(db.select(db.orders.c.coid).where(db.orders.c.signal_id == req.signal_id)):
            return OrderResult(False, "DUPLICATE", message="signal already has an order")
        bal = self.client.account.get("balance")
        try:
            bal = (await self.client.balance())["balance"]
            self.client.account["balance"] = bal
        except Exception:
            pass
        rd = self.risk.check(balance=bal, symbol=req.symbol, bot_id=req.bot_id,
                                loginid=self.client.health.loginid, bot_max_stake=req.max_stake)
        if not rd.approved:
            return OrderResult(False, "RISK_REJECTED", message="; ".join(rd.reasons or []), details=rd.to_dict())
        spec = ContractSpec.from_dict(req.contract)
        currency = self.client.health.currency or "USD"
        try:
            payload = build_proposal(spec, req.direction, req.symbol, rd.stake, currency, atr=req.atr)
        except ContractValidationError as e:
            return OrderResult(False, "INVALID", message=str(e))
        try:
            na = await self.check_available(req.symbol, payload["contract_type"], spec)
            if na:
                return OrderResult(False, "UNAVAILABLE", message=na)
            prop = await self.client.proposal(**payload)
        except (DerivError, ConnectionLost, NotConnected, asyncio.TimeoutError) as e:
            return OrderResult(False, "PROPOSAL_FAILED", message=str(e))
        ask, payout = float(prop["ask_price"]), float(prop.get("payout") or 0)
        worst = max_loss(spec, ask)
        if ask > rd.stake + 0.01 or worst > rd.stake + 0.01:
            return OrderResult(False, "RISK_REJECTED", message=f"ask {ask} exceeds approved stake {rd.stake}")
        if spec.family != "multiplier":
            ratio = (payout - ask) / ask if ask else 0
            if ratio < req.payout_assumption * 0.95:
                return OrderResult(False, "PAYOUT_TOO_LOW",
                                   message=f"payout ratio {ratio:.3f} below assumed {req.payout_assumption:.3f}; "
                                           "edge estimate no longer valid")
        coid = uuid.uuid4().hex
        db.execute(db.insert(db.orders).values(user_id=self.uid, coid=coid, ts=time.time(), signal_id=req.signal_id, bot_id=req.bot_id,
                                               symbol=req.symbol, contract_type=payload["contract_type"],
                                               request={**payload, "proposal_id": prop["id"]}, stake=ask,
                                               payout=payout, status="PENDING", updated_at=time.time()))
        self.risk.reserve(coid, req.symbol, ask, req.bot_id)
        self._set_order(coid, "SENT")
        db.audit("execution", f"BUY sent {req.bot_id} {req.symbol} {payload['contract_type']} stake={ask}",
                 coid=coid, payout=payout, confidence=req.confidence, user_id=self.uid)
        try:
            buy = await self.client.buy(prop["id"], ask, passthrough={"coid": coid})
        except DerivError as e:  # definitive rejection from Deriv - nothing was bought
            self._set_order(coid, "REJECTED", error=str(e))
            self.risk.release(coid)
            db.audit("execution", f"BUY rejected by Deriv: {e}", level="WARN", coid=coid, user_id=self.uid)
            return OrderResult(False, "REJECTED", coid, message=str(e))
        except (ConnectionLost, NotConnected, asyncio.TimeoutError) as e:
            self._set_order(coid, "UNKNOWN", error=f"{type(e).__name__}: {e}")
            db.audit("execution", "BUY outcome UNKNOWN - will reconcile, no retry", level="WARN", coid=coid, user_id=self.uid)
            bus.publish("order", {"coid": coid, "status": "UNKNOWN"}, user_id=self.uid)
            asyncio.create_task(self.reconcile_soon())
            return OrderResult(False, "UNKNOWN", coid, message="connection lost during purchase; reconciling")
        cid = str(buy["contract_id"])
        self._record_trade(coid, cid, req, payload, ask, float(buy.get("payout") or payout),
                           float(buy.get("purchase_time") or time.time()))
        return OrderResult(True, "BOUGHT", coid, cid, f"bought contract {cid}",
                           {"buy_price": ask, "payout": buy.get("payout"), "risk": rd.state})

    def _set_order(self, coid: str, status: str, contract_id: str | None = None, error: str | None = None):
        vals = {"status": status, "updated_at": time.time()}
        if contract_id:
            vals["contract_id"] = contract_id
        if error:
            vals["error"] = error
        db.execute(db.update(db.orders).where(db.orders.c.coid == coid).values(**vals))
        bus.publish("order", {"coid": coid, "status": status, "contract_id": contract_id, "error": error}, user_id=self.uid)

    def _record_trade(self, coid, cid, req: OrderRequest, payload, stake, payout, buy_time):
        exists = db.rows(db.select(db.trades.c.contract_id).where(db.trades.c.contract_id == cid))
        if not exists:
            db.execute(db.insert(db.trades).values(
                user_id=self.uid, contract_id=cid, coid=coid, bot_id=req.bot_id, symbol=req.symbol,
                contract_type=payload["contract_type"], direction=req.direction, stake=stake, payout=payout,
                buy_time=buy_time, status="open", is_virtual=bool(self.client.health.is_virtual),
                confidence=req.confidence, regime=req.regime, features=req.features))
        self._set_order(coid, "BOUGHT", contract_id=cid)
        self.risk.release(coid)
        db.audit("execution", f"BOUGHT {cid} ({req.bot_id} {req.symbol} {req.direction})", coid=coid, user_id=self.uid)
        bus.publish("trade_opened", {"contract_id": cid, "bot_id": req.bot_id, "symbol": req.symbol,
                                     "direction": req.direction, "stake": stake, "payout": payout}, user_id=self.uid)
        asyncio.create_task(self.track(cid))

    # ---------- tracking & settlement ----------
    async def track(self, contract_id: str) -> None:
        if contract_id in self._watch:
            return
        self._watch.add(contract_id)
        try:
            await self.client.subscribe(f"poc:{contract_id}",
                                        {"proposal_open_contract": 1, "contract_id": int(contract_id)},
                                        self._on_poc)
        except Exception as e:
            log.warning("could not subscribe to contract %s: %s (poll fallback active)", contract_id, e)
            self._watch.discard(contract_id)

    async def _on_poc(self, msg: dict) -> None:
        poc = msg.get("proposal_open_contract") or {}
        if poc.get("contract_id"):
            await self._apply_poc(poc)

    async def _apply_poc(self, poc: dict) -> None:
        cid = str(poc["contract_id"])
        done = bool(poc.get("is_sold")) or poc.get("status") in ("won", "lost", "sold")
        if not done:
            bus.publish("contract_update", {"contract_id": cid, "profit": poc.get("profit"),
                                            "current_spot": poc.get("current_spot"), "status": "open"}, user_id=self.uid)
            return
        status = poc.get("status") or ("won" if float(poc.get("profit", 0)) > 0 else "lost")
        if status == "sold":
            status = "won" if float(poc.get("profit", 0)) > 0 else "lost"
        row = db.rows(db.select(db.trades.c.status, db.trades.c.bot_id).where(db.trades.c.contract_id == cid))
        if not row or row[0]["status"] != "open":
            return
        db.execute(db.update(db.trades).where(db.trades.c.contract_id == cid).values(
            status=status, profit=float(poc.get("profit", 0)), sell_time=float(poc.get("sell_time") or time.time()),
            entry_spot=_f(poc.get("entry_spot")), exit_spot=_f(poc.get("exit_tick") or poc.get("sell_spot"))))
        self._watch.discard(cid)
        asyncio.create_task(self.client.unsubscribe(f"poc:{cid}"))
        db.audit("execution", f"SETTLED {cid} {status} profit={poc.get('profit')}", bot_id=row[0]["bot_id"], user_id=self.uid)
        bus.publish("trade_closed", {"contract_id": cid, "status": status, "profit": poc.get("profit"),
                                     "bot_id": row[0]["bot_id"]}, user_id=self.uid)
        self.memory.refresh()
        try:
            b = await self.client.balance()
            self.client.account["balance"] = b["balance"]
            self.risk.record_balance(b["balance"], self.client.health.loginid)
        except Exception:
            pass

    async def poll_open(self) -> None:
        """Fallback settlement check for open trades (missed subscription updates)."""
        for t in db.rows(db.select(db.trades.c.contract_id, db.trades.c.coid).where((db.trades.c.status == "open") & self._mine(db.trades))):
            try:
                poc = await self.client.contract_status(t["contract_id"])
                await self._apply_poc(poc)
                if t["contract_id"] not in self._watch and not poc.get("is_sold"):
                    await self.track(t["contract_id"])
            except DerivError as e:
                log.warning("status check %s failed: %s", t["contract_id"], e)
            except Exception:
                return

    async def sell(self, contract_id: str) -> dict:
        r = await self.client.sell(int(contract_id))
        db.audit("execution", f"manual SELL {contract_id}", result=r, user_id=self.uid)
        return r

    # ---------- reconciliation / recovery ----------
    async def reconcile_soon(self, delay: float = 3.0) -> None:
        await asyncio.sleep(delay)
        if await self.client.wait_ready(60):
            await self.reconcile()

    async def reconcile(self) -> dict:
        """Resolve PENDING/SENT/UNKNOWN orders from Deriv's own records and adopt open contracts."""
        out = {"resolved": [], "adopted": []}
        pending = self.unresolved_orders()
        try:
            portfolio = await self.client.portfolio()
            history = await self.client.profit_table(limit=100, date_from=int(time.time() - 86400))
        except Exception as e:
            log.warning("reconcile failed: %s", e)
            return out
        known = {r["contract_id"] for r in db.rows(db.select(db.trades.c.contract_id))}
        cands = []
        for p in portfolio:
            cands.append({"contract_id": str(p["contract_id"]), "symbol": p.get("symbol") or p.get("underlying"),
                          "contract_type": p.get("contract_type"), "buy_price": float(p.get("buy_price", 0)),
                          "purchase_time": float(p.get("purchase_time", 0)), "payout": p.get("payout"), "open": True})
        for h in history:
            cands.append({"contract_id": str(h["contract_id"]), "symbol": h.get("underlying_symbol"),
                          "contract_type": h.get("contract_type"), "buy_price": float(h.get("buy_price", 0)),
                          "purchase_time": float(h.get("purchase_time", 0)), "payout": h.get("payout"),
                          "shortcode": h.get("shortcode", ""), "open": False})
        for o in pending:
            match = None
            for c in cands:
                if c["contract_id"] in known:
                    continue
                same_type = c.get("contract_type") == o["contract_type"] or o["contract_type"] in (c.get("shortcode") or "")
                same_sym = (c.get("symbol") == o["symbol"]) or (o["symbol"] in (c.get("shortcode") or ""))
                if same_type and same_sym and abs(c["buy_price"] - (o["stake"] or 0)) < 0.011 \
                        and o["ts"] - 5 <= c["purchase_time"] <= o["ts"] + 90:
                    match = c
                    break
            if match:
                req = OrderRequest(o["bot_id"], o["symbol"], "UP" if o["contract_type"] in ("CALL", "MULTUP", "DIGITOVER", "DIGITEVEN", "ONETOUCH") else "DOWN",
                                   {}, 0.0, o["signal_id"])
                known.add(match["contract_id"])
                self._record_trade(o["coid"], match["contract_id"], req, {"contract_type": o["contract_type"]},
                                   match["buy_price"], float(match["payout"] or 0), match["purchase_time"])
                out["resolved"].append({"coid": o["coid"], "contract_id": match["contract_id"]})
                db.audit("reconcile", f"order {o['coid']} matched contract {match['contract_id']}", user_id=self.uid)
            elif time.time() - o["ts"] > 120:
                self._set_order(o["coid"], "FAILED", error="no matching contract on account - not purchased")
                self.risk.release(o["coid"])
                out["resolved"].append({"coid": o["coid"], "contract_id": None})
                db.audit("reconcile", f"order {o['coid']} confirmed NOT purchased", user_id=self.uid)
        # contracts opened outside this app still count toward exposure
        for c in cands:
            if c["open"] and c["contract_id"] not in known:
                db.execute(db.insert(db.trades).values(
                    user_id=self.uid, contract_id=c["contract_id"], bot_id="external", symbol=c["symbol"],
                    contract_type=c["contract_type"], stake=c["buy_price"], payout=_f(c["payout"]),
                    buy_time=c["purchase_time"], status="open", is_virtual=bool(self.client.health.is_virtual)))
                known.add(c["contract_id"])
                out["adopted"].append(c["contract_id"])
                db.audit("reconcile", f"adopted external open contract {c['contract_id']}", user_id=self.uid)
        for t in db.rows(db.select(db.trades.c.contract_id).where((db.trades.c.status == "open") & self._mine(db.trades))):
            await self.track(t["contract_id"])
        await self.poll_open()
        if out["resolved"] or out["adopted"]:
            bus.publish("reconciled", out, user_id=self.uid)
        return out


def _f(v):
    try:
        return float(v) if v is not None else None
    except (TypeError, ValueError):
        return None
