"""仓库根 `.env` 的共享加载器（dev 入口与 deepseek 契约测试共用）。

只解析简单 `KEY=VALUE` 行，跳过注释与空行；一律 setdefault——绝不覆盖既有
环境变量（生产直接导出的真实变量优先）；文件缺失时静默返回（CI 无 .env 安全）。
"""

from __future__ import annotations

import os
from pathlib import Path

from chatty.config import REPO_ROOT


def load_root_env(path: Path | None = None) -> None:
    """读 .env（默认仓库根）：KEY=VALUE 行 setdefault 进程环境，容忍缺失文件。"""
    env_file = REPO_ROOT / ".env" if path is None else path
    if not env_file.is_file():
        return
    for line in env_file.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, _, value = stripped.partition("=")
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))
