"""Secrets encryption and site sessions.

* Each user's Deriv OAuth tokens are encrypted at rest with Fernet (AES-128-CBC + HMAC) using a
  key derived from MASTER_KEY. They are only ever decrypted inside the backend process.
* Users sign in through Deriv OAuth; the site then issues its own HMAC-signed session token.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import secrets
import time

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC

from .config import settings

_SALT = b"deriv-ai-terminal.v1"


class SecurityError(Exception):
    pass


def _master_key() -> bytes:
    mk = settings.master_key
    if not mk:
        raise SecurityError("MASTER_KEY is not set. Generate one: python -m backend.cli genkey")
    kdf = PBKDF2HMAC(algorithm=hashes.SHA256(), length=32, salt=_SALT, iterations=390_000)
    return base64.urlsafe_b64encode(kdf.derive(mk.encode()))


_fernet_cache: dict[str, Fernet] = {}


def _fernet() -> Fernet:
    mk = settings.master_key
    if mk not in _fernet_cache:
        _fernet_cache.clear()
        _fernet_cache[mk] = Fernet(_master_key())
    return _fernet_cache[mk]


def encrypt(plain: str) -> str:
    return _fernet().encrypt(plain.encode()).decode()


def decrypt(token: str) -> str:
    try:
        return _fernet().decrypt(token.encode()).decode()
    except InvalidToken as e:
        raise SecurityError("Cannot decrypt secret - MASTER_KEY changed?") from e


def mask(secret: str) -> str:
    return secret[:3] + "*" * max(0, len(secret) - 6) + secret[-3:] if len(secret) > 6 else "***"


# ---- session tokens ----
def _sign_key() -> bytes:
    return hashlib.sha256(b"session:" + _master_key()).digest()


def issue_session(subject: str, admin: bool = False, epoch: int = 0) -> str:
    """`epoch` lets us revoke every session of a user (logout everywhere) by bumping a counter."""
    payload = {"sub": subject, "adm": bool(admin), "ep": epoch,
               "exp": int(time.time()) + settings.session_hours * 3600, "n": secrets.token_hex(8)}
    body = base64.urlsafe_b64encode(json.dumps(payload).encode()).decode().rstrip("=")
    sig = hmac.new(_sign_key(), body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{sig}"


def verify_session(token: str) -> dict | None:
    try:
        body, sig = token.split(".")
        good = hmac.new(_sign_key(), body.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, good):
            return None
        payload = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
        if payload["exp"] < time.time():
            return None
        return payload
    except Exception:
        return None
