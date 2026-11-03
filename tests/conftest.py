import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import pytest
import pytest_asyncio

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
os.environ.setdefault("MASTER_KEY", "test-master-key-not-for-production-0123456789")
os.environ["AUTOSTART_FEED"] = "false"

from backend import database as db  # noqa: E402
from backend.config import settings  # noqa: E402

settings.master_key = os.environ["MASTER_KEY"]


@pytest.fixture(autouse=True)
def fresh_db(tmp_path):
    db.reset_engine(f"sqlite:///{tmp_path / 'test.db'}")
    settings.backup_dir = str(tmp_path / "backups")
    yield
    db.reset_engine()


def make_ohlc(n=3000, seed=1, drift_blocks=True) -> pd.DataFrame:
    rng = np.random.default_rng(seed)
    ret = rng.normal(0, 0.002, n)
    if drift_blocks:
        ret[n // 3: n // 2] += 0.0008
        ret[2 * n // 3: 3 * n // 4] -= 0.0008
    c = 1000 * np.exp(np.cumsum(ret))
    o = np.r_[c[0], c[:-1]]
    h = np.maximum(o, c) * (1 + np.abs(rng.normal(0, 0.001, n)))
    l = np.minimum(o, c) * (1 - np.abs(rng.normal(0, 0.001, n)))
    return pd.DataFrame({"open": o, "high": h, "low": l, "close": c}, index=np.arange(n) * 60 + 1_700_000_000)


@pytest.fixture
def ohlc():
    return make_ohlc()


@pytest_asyncio.fixture
async def mock_deriv():
    from tests.mock_deriv import MockDeriv
    m = MockDeriv()
    url = await m.start()
    m.url = url
    yield m
    await m.stop()
