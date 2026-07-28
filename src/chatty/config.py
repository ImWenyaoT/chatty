from __future__ import annotations

import os
from pathlib import Path

from dotenv import load_dotenv

ROOT = Path(__file__).resolve().parents[2]
DATA_DIR = ROOT / "data"
DATABASE_PATH = ROOT / ".local" / "chatty.db"
DEFAULT_BASE_URL = "https://api.deepseek.com"
DEFAULT_MODEL_ID = "deepseek-v4-pro"


def load_root_env() -> None:
    load_dotenv(ROOT / ".env", override=False)


def configured_model_id() -> str:
    load_root_env()
    return os.environ.get("MODEL_ID") or DEFAULT_MODEL_ID


def agent_debug_enabled() -> bool:
    load_root_env()
    return os.environ.get("CHATTY_AGENT_DEBUG", "").casefold() in {"1", "true", "yes", "on"}
