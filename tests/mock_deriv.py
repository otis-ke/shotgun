"""Mock of the Deriv WebSocket API for automated tests (NEVER used by the production app).

Implements the subset the terminal uses with Deriv's message shapes. Time is accelerated:
each `candle_seconds` of wall time closes one candle. Failure injection:
  * drop_on_buy=True  -> closes the socket after recording a purchase but BEFORE replying
"""
from __future__ import annotations

import asyncio
import itertools
import json
import random
import time
import zlib

import numpy as np
from websockets.asyncio.server import serve


class MockDeriv:
    def __init__(self, seed: int = 3, candle_seconds: float = 0.25, settle_seconds: float = 0.6,
                 balance: float = 10000.0, virtual: bool = True):
        self.rng = np.random.default_rng(seed)
        self.candle_seconds = candle_seconds
        self.settle_seconds = settle_seconds
        self.balance = balance
        self.virtual = virtual
        self.drop_on_buy = False
        self.reject_buy = False
        self.buys: list[dict] = []
        self.contracts: dict[int, dict] = {}
        self._cid = itertools.count(100000)
        self._sub = itertools.count(1)
        self.series: dict[tuple[str, int], list[dict]] = {}
        self.server = None
        self.port = None
        self.connections = 0

    # ---------- data ----------
    def _series(self, symbol: str, gran: int) -> list[dict]:
        key = (symbol, gran)
        if key not in self.series:
            n = 1200
            ret = self.rng.normal(0, 0.0015, n)
            c = 1000 * np.exp(np.cumsum(ret))
            o = np.r_[c[0], c[:-1]]
            h = np.maximum(o, c) * (1 + np.abs(self.rng.normal(0, 0.0006, n)))
            l = np.minimum(o, c) * (1 - np.abs(self.rng.normal(0, 0.0006, n)))
            t0 = int(time.time()) // gran * gran - n * gran
            self.series[key] = [{"epoch": t0 + i * gran, "open": round(o[i], 4), "high": round(h[i], 4),
                                 "low": round(l[i], 4), "close": round(c[i], 4)} for i in range(n)]
        return self.series[key]

    def _advance(self, symbol: str, gran: int) -> dict:
        s = self._series(symbol, gran)
        last = s[-1]
        o = last["close"]
        c = round(o * float(np.exp(self.rng.normal(0, 0.0015))), 4)
        bar = {"epoch": last["epoch"] + gran, "open": o, "high": round(max(o, c) * 1.0004, 4),
               "low": round(min(o, c) * 0.9996, 4), "close": c}
        s.append(bar)
        return bar

    def spot(self, symbol: str) -> float:
        for (sym, _), s in self.series.items():
            if sym == symbol:
                return s[-1]["close"]
        return 1000.0

    # ---------- server ----------
    async def start(self, port: int = 0):
        self.server = await serve(self._handler, "127.0.0.1", port)
        self.port = self.server.sockets[0].getsockname()[1]
        return f"ws://127.0.0.1:{self.port}"

    async def stop(self):
        self.server.close()
        await self.server.wait_closed()

    async def _handler(self, ws):
        self.connections += 1
        tasks: dict[str, asyncio.Task] = {}
        authed = False
        login = None
        try:
            async for raw in ws:
                req = json.loads(raw)
                rid = req.get("req_id")
                send = lambda m: ws.send(json.dumps({**m, "req_id": rid, "echo_req": req}))  # noqa: E731
                if "ping" in req:
                    await send({"msg_type": "ping", "ping": "pong"})
                elif "authorize" in req:
                    tok = str(req["authorize"])
                    if tok == "bad" or "-" not in tok:
                        await send({"error": {"code": "InvalidToken", "message": "The token is invalid."}})
                        continue
                    # token format "<demo|real>-<user>" (any other "x-y" = demo of user y)
                    kind, user = tok.split("-", 1)
                    virtual = kind != "real" and self.virtual
                    login = ("VRTC" if virtual else "CR") + str(zlib.crc32(user.encode()) % 100000)
                    if user in ("token", "token-123", "token-abc") or tok.startswith("demo-token"):
                        login = "VRTC123" if virtual else "CR999"
                    authed = True
                    await send({"msg_type": "authorize", "authorize": {
                        "loginid": login, "is_virtual": int(virtual), "currency": "USD", "balance": self.balance,
                        "email": f"{user}@example.com", "fullname": user.title(), "user_id": zlib.crc32(user.encode()) % 10**8,
                        "account_list": []}})
                elif "balance" in req:
                    sid = f"bal{next(self._sub)}"
                    await send({"msg_type": "balance", "balance": {"balance": self.balance, "currency": "USD", "id": sid},
                                **({"subscription": {"id": sid}} if req.get("subscribe") else {})})
                elif "forget" in req:
                    for k, t in list(tasks.items()):
                        if k == req["forget"]:
                            t.cancel()
                            tasks.pop(k)
                    await send({"msg_type": "forget", "forget": 1})
                elif "active_symbols" in req:
                    await send({"msg_type": "active_symbols", "active_symbols": [
                        {"symbol": s, "display_name": s, "market_display_name": "Derived",
                         "submarket_display_name": "Continuous Indices", "exchange_is_open": 1}
                        for s in ("R_100", "R_75", "R_50", "R_25", "1HZ100V", "1HZ75V")]})
                elif "contracts_for" in req:
                    await send({"msg_type": "contracts_for", "contracts_for": {"available": [
                        {"contract_type": ct, "min_contract_duration": "1t" if ct.startswith("DIGIT") else "15s",
                         "max_contract_duration": "10t" if ct.startswith("DIGIT") else "365d"}
                        for ct in ("CALL", "PUT", "ONETOUCH", "NOTOUCH", "DIGITOVER", "DIGITUNDER", "MULTUP", "MULTDOWN")]}})
                elif "ticks_history" in req:
                    sym, gran = req["ticks_history"], int(req.get("granularity", 60))
                    s = self._series(sym, gran)[-int(req.get("count", 500)):]
                    if "start" in req:
                        s = [c for c in self._series(sym, gran) if req["start"] <= c["epoch"] <= (req["end"] if req["end"] != "latest" else 1e12)]
                    elif req.get("end") not in (None, "latest"):
                        s = [c for c in self._series(sym, gran) if c["epoch"] <= int(req["end"])][-int(req.get("count", 500)):]
                    msg = {"msg_type": "candles", "candles": s}
                    if req.get("subscribe"):
                        sid = f"c{next(self._sub)}"
                        msg["subscription"] = {"id": sid}
                        tasks[sid] = asyncio.create_task(self._stream(ws, sid, sym, gran, rid))
                    await send(msg)
                elif "proposal" in req and "proposal_open_contract" not in req:
                    amt = float(req["amount"])
                    ratio = 0.95 if req["contract_type"] in ("CALL", "PUT") else 1.5
                    await send({"msg_type": "proposal", "proposal": {
                        "id": f"p{random.randint(1, 10**9)}", "ask_price": amt, "payout": round(amt * (1 + ratio), 2),
                        "spot": self.spot(req["symbol"]), "longcode": "mock"}})
                elif "buy" in req:
                    if not authed:
                        await send({"error": {"code": "AuthorizationRequired", "message": "Please log in."}})
                        continue
                    if self.reject_buy:
                        await send({"error": {"code": "InvalidContractProposal", "message": "Proposal expired"}})
                        continue
                    cid = next(self._cid)
                    price = float(req["price"])
                    self.balance -= price
                    c = {"contract_id": cid, "buy_price": price, "payout": round(price * 1.95, 2),
                         "purchase_time": int(time.time()), "symbol": "R_100", "contract_type": "CALL", "owner": login,
                         "passthrough": req.get("passthrough"), "settle_at": time.time() + self.settle_seconds}
                    self.contracts[cid] = c
                    self.buys.append(c)
                    if self.drop_on_buy:
                        await ws.close()
                        return
                    await send({"msg_type": "buy", "buy": {"contract_id": cid, "buy_price": price,
                                                           "payout": c["payout"], "purchase_time": c["purchase_time"],
                                                           "transaction_id": cid + 1}})
                elif "proposal_open_contract" in req:
                    cid = int(req["contract_id"])
                    poc = self._poc(cid)
                    msg = {"msg_type": "proposal_open_contract", "proposal_open_contract": poc}
                    if req.get("subscribe") and not poc.get("is_sold"):
                        sid = f"poc{next(self._sub)}"
                        msg["subscription"] = {"id": sid}
                        tasks[sid] = asyncio.create_task(self._poc_stream(ws, sid, cid, rid))
                    await send(msg)
                elif "portfolio" in req:
                    await send({"msg_type": "portfolio", "portfolio": {"contracts": [
                        {"contract_id": c["contract_id"], "symbol": c["symbol"], "contract_type": c["contract_type"],
                         "buy_price": c["buy_price"], "purchase_time": c["purchase_time"], "payout": c["payout"]}
                        for c in self.contracts.values()
                        if c.get("owner") == login and not self._poc(c["contract_id"])["is_sold"]]}})
                elif "profit_table" in req:
                    await send({"msg_type": "profit_table", "profit_table": {"transactions": [
                        {"contract_id": c["contract_id"], "buy_price": c["buy_price"], "purchase_time": c["purchase_time"],
                         "payout": c["payout"], "shortcode": f"{c['contract_type']}_{c['symbol']}_x",
                         "contract_type": c["contract_type"], "underlying_symbol": c["symbol"]}
                        for c in self.contracts.values()
                        if c.get("owner") == login and self._poc(c["contract_id"])["is_sold"]]}})
                elif "statement" in req:
                    await send({"msg_type": "statement", "statement": {"transactions": []}})
                elif "sell" in req:
                    await send({"msg_type": "sell", "sell": {"sold_for": 1.0, "contract_id": req["sell"]}})
                else:
                    await send({"error": {"code": "UnrecognisedRequest", "message": "Unrecognised request"}})
        finally:
            for t in tasks.values():
                t.cancel()

    def _poc(self, cid: int) -> dict:
        c = self.contracts[cid]
        sold = time.time() >= c["settle_at"]
        won = cid % 2 == 0  # deterministic
        return {"contract_id": cid, "is_sold": int(sold), "status": ("won" if won else "lost") if sold else "open",
                "profit": round(c["buy_price"] * 0.95, 2) if (sold and won) else (-c["buy_price"] if sold else 0.1),
                "buy_price": c["buy_price"], "entry_spot": 1000, "exit_tick": 1001, "sell_time": int(time.time()),
                "current_spot": 1000.5}

    async def _poc_stream(self, ws, sid, cid, rid):
        while True:
            await asyncio.sleep(0.15)
            p = self._poc(cid)
            await ws.send(json.dumps({"msg_type": "proposal_open_contract", "proposal_open_contract": p,
                                      "subscription": {"id": sid}, "req_id": rid}))
            if p["is_sold"]:
                if p["status"] == "won":
                    self.balance += self.contracts[cid]["payout"]
                return

    async def _stream(self, ws, sid, sym, gran, rid):
        while True:
            await asyncio.sleep(self.candle_seconds)
            bar = self._advance(sym, gran)
            await ws.send(json.dumps({"msg_type": "ohlc", "subscription": {"id": sid}, "req_id": rid, "ohlc": {
                "open_time": bar["epoch"], "epoch": bar["epoch"] + 1, "open": str(bar["open"]),
                "high": str(bar["high"]), "low": str(bar["low"]), "close": str(bar["close"]),
                "symbol": sym, "granularity": gran}}))


if __name__ == "__main__":  # manual dev server: python -m tests.mock_deriv [--port 8765] [--candle-seconds 2]
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--candle-seconds", type=float, default=2)

    async def main(a):
        m = MockDeriv(candle_seconds=a.candle_seconds)
        print("mock Deriv on", await m.start(a.port), flush=True)
        await asyncio.Future()
    asyncio.run(main(ap.parse_args()))
