"""入口运行时配置：环境变量 + 仓库根 → 已解析路径（http-contract §11、decisions §7.3）。

四个入口（`main.py`、smoke、browser_smoke、eval）共用这一份解析规则，自己不再拼
路径。三条不变量属于本模块接口，调用方无需知道：

- **空字符串等同未设置**：`CHATTY_DATABASE_PATH=""` 回退默认值，绝不解析成仓库根目录；
- **相对路径按仓库根解析**（eval 的 fixture 仓库可传自己的 root）；
- **绝对路径原样生效**。
"""

from __future__ import annotations

import os
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]

DATABASE_PATH_ENV = "CHATTY_DATABASE_PATH"
STATIC_DIR_ENV = "CHATTY_STATIC_DIR"
E2E_DATABASE_ENV = "CHATTY_E2E_DATABASE"

DEFAULT_DATABASE_PATH = "data/chatty.sqlite"
DEFAULT_STATIC_DIR = "web/dist"
DEFAULT_E2E_DATABASE_PATH = ".cache/browser-e2e.sqlite"


def _env_path(name: str, default: str) -> Path:
    """读环境变量并解析：空值（未设置或空串）回退 default，相对路径按仓库根解析。"""
    # `or` 而非 `os.environ.get(name, default)`：后者会让空串解析成仓库根目录本身，
    # 把一个目录交给 sqlite3.connect。
    raw = Path(os.environ.get(name) or default)
    return raw if raw.is_absolute() else REPO_ROOT / raw


def database_path() -> Path:
    """运行库路径：`CHATTY_DATABASE_PATH`，默认 `data/chatty.sqlite`。"""
    return _env_path(DATABASE_PATH_ENV, DEFAULT_DATABASE_PATH)


def e2e_database_path() -> Path:
    """browser-smoke 库路径：`CHATTY_E2E_DATABASE`，默认 `.cache/browser-e2e.sqlite`。"""
    return _env_path(E2E_DATABASE_ENV, DEFAULT_E2E_DATABASE_PATH)


def static_dir() -> Path | None:
    """前端产物目录：`CHATTY_STATIC_DIR`，默认 `web/dist`。

    未构建（目录下没有 `index.html`）时返回 None —— 应用工厂据此完全不挂 SPA
    fallback，dev 下缺 dist 也不会把不存在的文件当响应。
    """
    candidate = _env_path(STATIC_DIR_ENV, DEFAULT_STATIC_DIR)
    return candidate if (candidate / "index.html").is_file() else None


def knowledge_path(root: Path = REPO_ROOT) -> Path:
    """Knowledge JSONL：`<root>/knowledge/records.jsonl`（eval 传 fixture 仓库根）。"""
    return (root / "knowledge" / "records.jsonl").resolve()


def reset_database(path: Path) -> None:
    """删除 SQLite 主库与 `-wal` / `-shm` 旁文件：e2e 与 eval 用例都从零开始。"""
    for target in (path, Path(f"{path}-wal"), Path(f"{path}-shm")):
        target.unlink(missing_ok=True)
