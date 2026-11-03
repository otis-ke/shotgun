"""Central configuration. Values come from environment variables (or a .env file)."""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent.parent


def _load_dotenv(path: Path) -> None:
    if not path.exists():
        return
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        k, v = line.split("=", 1)
        os.environ.setdefault(k.strip(), v.strip().strip('"').strip("'"))


_load_dotenv(BASE_DIR / ".env")


def _bool(name: str, default: bool) -> bool:
    return os.getenv(name, str(default)).lower() in ("1", "true", "yes", "on")


@dataclass
class Settings:
    # Deriv
    deriv_app_id: str = field(default_factory=lambda: os.getenv("DERIV_APP_ID", "1089"))
    deriv_ws_url: str = field(default_factory=lambda: os.getenv(
        "DERIV_WS_URL", "wss://ws.derivws.com/websockets/v3"))
    deriv_oauth_url: str = field(default_factory=lambda: os.getenv(
        "DERIV_OAUTH_URL", "https://oauth.deriv.com/oauth2/authorize"))
    deriv_signup_url: str = field(default_factory=lambda: os.getenv("DERIV_SIGNUP_URL", "https://deriv.com/signup/"))
    affiliate_token: str = field(default_factory=lambda: os.getenv("DERIV_AFFILIATE_TOKEN", ""))
    # Branding (your own - never Deriv's)
    brand_name: str = field(default_factory=lambda: os.getenv("BRAND_NAME", "Trading Terminal"))
    brand_tagline: str = field(default_factory=lambda: os.getenv("BRAND_TAGLINE", "Multi-strategy automated trading"))
    support_email: str = field(default_factory=lambda: os.getenv("SUPPORT_EMAIL", ""))
    # Security
    master_key: str = field(default_factory=lambda: os.getenv("MASTER_KEY", ""))
    admin_emails: list[str] = field(default_factory=lambda: [e.strip().lower() for e in
                                                             os.getenv("ADMIN_EMAILS", "").split(",") if e.strip()])
    session_hours: int = field(default_factory=lambda: int(os.getenv("SESSION_HOURS", "12")))
    max_users: int = field(default_factory=lambda: int(os.getenv("MAX_USERS", "200")))
    open_registration: bool = field(default_factory=lambda: _bool("OPEN_REGISTRATION", True))
    # Storage
    database_url: str = field(default_factory=lambda: os.getenv(
        "DATABASE_URL", f"sqlite:///{BASE_DIR / 'data' / 'terminal.db'}"))
    backup_dir: str = field(default_factory=lambda: os.getenv("BACKUP_DIR", str(BASE_DIR / "data" / "backups")))
    backup_interval_hours: int = field(default_factory=lambda: int(os.getenv("BACKUP_INTERVAL_HOURS", "6")))
    # Runtime
    cors_origins: list[str] = field(default_factory=lambda: os.getenv(
        "CORS_ORIGINS", "http://localhost:5173,http://127.0.0.1:5173").split(","))
    autostart_feed: bool = field(default_factory=lambda: _bool("AUTOSTART_FEED", True))
    log_level: str = field(default_factory=lambda: os.getenv("LOG_LEVEL", "INFO"))


settings = Settings()
