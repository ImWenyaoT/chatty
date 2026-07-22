"""唯一 uvicorn 入口工厂（decisions §7.3）：单进程 FastAPI 伺服前端 dist + `/api/chatty/*`。

`main.py`（`pnpm dev:api`）、CI 冒烟与生产共用这一个工厂；路径与默认值全部来自
`chatty.config`，本模块只决定「装配哪套身份 / 模型」（这里是默认那套）。

启动命令：
    CHATTY_DATABASE_PATH="$RUNNER_TEMP/chatty.sqlite" CHATTY_STATIC_DIR=web/dist \
        uv run uvicorn --factory chatty.smoke:create_smoke_app --port 3101
"""

from __future__ import annotations

import uvicorn
from fastapi import FastAPI

from chatty import config
from chatty.app import create_app
from chatty.env import load_root_env

HOST = "127.0.0.1"
PORT = 8000


def create_smoke_app() -> FastAPI:
    """应用工厂（uvicorn --factory 入口）：先读仓库根 .env，再按 config 解析路径。"""
    load_root_env()  # setdefault + 容忍缺失文件：CI 无 .env 时是 no-op。
    return create_app(database_path=config.database_path(), static_dir=config.static_dir())


def serve() -> None:
    """`python main.py`（`pnpm dev:api`）：同一个应用跑在 127.0.0.1:8000。"""
    uvicorn.run(create_smoke_app(), host=HOST, port=PORT)
