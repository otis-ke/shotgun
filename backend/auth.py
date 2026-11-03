"""Sign-in with Deriv (OAuth).

Flow: the browser goes to oauth.deriv.com with our app_id. Deriv shows ITS OWN login page and
then redirects back to our registered redirect URL with  ?acct1=..&token1=..&cur1=..&acct2=..
The frontend posts those to /api/auth/deriv. We never trust them blindly: every token is
checked with Deriv's `authorize` call, and all accounts must belong to the same Deriv user.
"""
from __future__ import annotations

import asyncio
import contextlib
import json
import time
from urllib.parse import urlencode

from websockets.asyncio.client import connect

from . import database as db
from .config import settings
from .security import decrypt, encrypt


class AuthError(Exception):
    pass


def oauth_url() -> str:
    return f"{settings.deriv_oauth_url}?{urlencode({'app_id': settings.deriv_app_id, 'l': 'EN'})}"


def signup_url() -> str:
    u = settings.deriv_signup_url
    return f"{u}?{urlencode({'t': settings.affiliate_token})}" if settings.affiliate_token else u


async def authorize_token(token: str, timeout: float = 15) -> dict:
    """One-shot authorize on a fresh socket; returns Deriv's authorize payload."""
    url = f"{settings.deriv_ws_url}?app_id={settings.deriv_app_id}&l=EN"
    async with connect(url, open_timeout=timeout, close_timeout=2) as ws:
        await ws.send(json.dumps({"authorize": token, "req_id": 1}))
        while True:
            msg = json.loads(await asyncio.wait_for(ws.recv(), timeout))
            if msg.get("req_id") == 1:
                break
    if "error" in msg:
        raise AuthError(msg["error"].get("message", "invalid token"))
    return msg["authorize"]


async def verify_accounts(accounts: list[dict]) -> dict:
    """accounts: [{"loginid", "token", "currency"}] from the OAuth redirect."""
    accounts = [a for a in accounts if a.get("token")][:20]
    if not accounts:
        raise AuthError("no accounts returned by Deriv")
    results = await asyncio.gather(*(authorize_token(a["token"]) for a in accounts), return_exceptions=True)
    verified, user_ids = [], set()
    for a, r in zip(accounts, results):
        if isinstance(r, Exception):
            continue  # disabled / self-excluded accounts may fail - skip them
        if a.get("loginid") and r.get("loginid") != a["loginid"]:
            raise AuthError("token/account mismatch")
        user_ids.add(str(r.get("user_id") or r.get("email") or r["loginid"]))
        verified.append({"loginid": r["loginid"], "currency": r.get("currency") or a.get("currency", "").upper(),
                         "is_virtual": bool(r.get("is_virtual")), "token_enc": encrypt(a["token"]),
                         "email": r.get("email"), "fullname": r.get("fullname")})
    if not verified:
        raise AuthError("Deriv rejected every account token")
    if len(user_ids) != 1:
        raise AuthError("accounts belong to different Deriv users")
    first = verified[0]
    return {"user_id": user_ids.pop(), "email": first.get("email"), "fullname": first.get("fullname"),
            "accounts": [{k: v for k, v in x.items() if k not in ("email", "fullname")} for x in verified]}


def upsert_user(info: dict) -> dict:
    uid = info["user_id"]
    existing = db.rows(db.select(db.users).where(db.users.c.id == uid))
    email = (info.get("email") or "").lower()
    if existing:
        u = existing[0]
        if u["disabled"]:
            raise AuthError("this account has been disabled by the site administrator")
        active = u["active_loginid"] if any(a["loginid"] == u["active_loginid"] for a in info["accounts"]) else None
        active = active or _default_login(info["accounts"])
        db.execute(db.update(db.users).where(db.users.c.id == uid).values(
            accounts=info["accounts"], email=email or u["email"], fullname=info.get("fullname") or u["fullname"],
            active_loginid=active, last_login=time.time(),
            is_admin=bool(u["is_admin"] or email in settings.admin_emails)))
        db.audit("security", "user signed in with Deriv", user_id=uid)
    else:
        n = list(db.rows(db.select(db.func.count()).select_from(db.users))[0].values())[0]
        if not settings.open_registration and not (email in settings.admin_emails):
            raise AuthError("registration is closed")
        if n >= settings.max_users:
            raise AuthError("this site has reached its user limit")
        # first user becomes admin when no admin emails are configured
        admin = email in settings.admin_emails or (n == 0 and not settings.admin_emails)
        db.execute(db.insert(db.users).values(
            id=uid, email=email, fullname=info.get("fullname"), accounts=info["accounts"],
            active_loginid=_default_login(info["accounts"]), is_admin=admin, disabled=False,
            created_at=time.time(), last_login=time.time()))
        db.audit("security", "new user registered via Deriv", user_id=uid)
    return get_user(uid)


def _default_login(accounts: list[dict]) -> str:
    """Demo first - real money is never the default."""
    demo = [a for a in accounts if a["is_virtual"]]
    return (demo or accounts)[0]["loginid"]


def get_user(uid: str) -> dict | None:
    r = db.rows(db.select(db.users).where(db.users.c.id == uid))
    return r[0] if r else None


def public_user(u: dict) -> dict:
    return {"id": u["id"], "email": u["email"], "fullname": u["fullname"], "is_admin": bool(u["is_admin"]),
            "active_loginid": u["active_loginid"],
            "accounts": [{"loginid": a["loginid"], "currency": a["currency"], "is_virtual": a["is_virtual"]}
                         for a in u["accounts"]]}


def account_token(u: dict, loginid: str | None = None) -> tuple[str, dict]:
    loginid = loginid or u["active_loginid"]
    for a in u["accounts"]:
        if a["loginid"] == loginid:
            return decrypt(a["token_enc"]), a
    raise AuthError(f"account {loginid} not linked")


def session_epoch(uid: str) -> int:
    return int(db.kv_get(db.ukey(uid, "session_epoch"), 0) or 0)


def logout_everywhere(uid: str) -> None:
    db.kv_set(db.ukey(uid, "session_epoch"), session_epoch(uid) + 1)


async def revoke_deriv_tokens(u: dict) -> None:
    """Best effort: ask Deriv to log out the OAuth tokens we hold."""
    for a in u["accounts"]:
        with contextlib.suppress(Exception):
            url = f"{settings.deriv_ws_url}?app_id={settings.deriv_app_id}"
            async with connect(url, open_timeout=8, close_timeout=2) as ws:
                await ws.send(json.dumps({"authorize": decrypt(a["token_enc"]), "req_id": 1}))
                await asyncio.wait_for(ws.recv(), 8)
                await ws.send(json.dumps({"logout": 1, "req_id": 2}))
                await asyncio.wait_for(ws.recv(), 8)
