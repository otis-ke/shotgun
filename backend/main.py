"""FastAPI application entry point:  uvicorn backend.main:app --host 0.0.0.0 --port 8000"""
from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from . import database as db
from .api.routes import router, ws_endpoint
from .config import BASE_DIR, settings
from .monitoring import setup_logging
from .runtime import platform

setup_logging(settings.log_level)


@asynccontextmanager
async def lifespan(app: FastAPI):
    db.get_engine()
    if not settings.master_key:
        raise RuntimeError("MASTER_KEY is not set - see .env.example")
    db.audit("system", "platform starting")
    if settings.autostart_feed:
        await platform.start()
    yield
    if settings.autostart_feed:
        await platform.stop()
    platform.shutdown_workers()


app = FastAPI(title=settings.brand_name, version="1.0.0", lifespan=lifespan)
app.add_middleware(CORSMiddleware, allow_origins=settings.cors_origins, allow_credentials=True,
                   allow_methods=["*"], allow_headers=["*"])
app.include_router(router)
app.add_api_websocket_route("/ws", ws_endpoint)


@app.get("/healthz")
def healthz():
    h = platform.public.health if platform.public else None
    return {"ok": True, "deriv_connected": bool(h and h.connected), "users_online": len(platform.users)}


# serve the built dashboard (frontend/dist) from the same origin in production
DIST = Path(os.getenv("FRONTEND_DIST", BASE_DIR / "frontend" / "dist"))
if DIST.exists():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    def spa(path: str):
        f = DIST / path
        return FileResponse(f if f.is_file() else DIST / "index.html")
