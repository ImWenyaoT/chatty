"""CI 冒烟 ASGI 工厂（decisions §7.3）：单进程 FastAPI 伺服前端 dist + `/api/chatty/*`。

启动命令：
    CHATTY_DATABASE_PATH="$RUNNER_TEMP/chatty.sqlite" CHATTY_STATIC_DIR=apps/web/dist \
        uv run uvicorn --factory chatty.smoke:create_smoke_app --port 3101
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI

from chatty.app import create_app
from chatty.env import load_root_env

REPO_ROOT = Path(__file__).resolve().parents[2]
DEFAULT_DATABASE_PATH = "data/chatty.sqlite"
DEFAULT_STATIC_DIR = "apps/web/dist"


def _resolve(raw: str) -> Path:
    """相对路径按仓库根解析（与 main.py / browser_smoke 的约定一致）。"""
    path = Path(raw)
    return path if path.is_absolute() else REPO_ROOT / path


def create_smoke_app() -> FastAPI:
    """冒烟应用工厂（uvicorn --factory 入口）：环境变量缺省回退仓库默认路径。"""
    load_root_env()  # setdefault + 容忍缺失文件：CI 无 .env 时是 no-op。
    database_path = _resolve(os.environ.get("CHATTY_DATABASE_PATH") or DEFAULT_DATABASE_PATH)
    static_dir = _resolve(os.environ.get("CHATTY_STATIC_DIR") or DEFAULT_STATIC_DIR)
    return create_app(database_path=database_path, static_dir=static_dir)
