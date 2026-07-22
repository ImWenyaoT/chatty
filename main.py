import os
from pathlib import Path

import uvicorn

from chatty.app import create_app
from chatty.env import load_root_env

# http-contract §11：CHATTY_DATABASE_PATH，默认 data/chatty.sqlite；
# 相对路径按仓库根解析（绝对路径经 `/` 运算自然生效）。
_REPO_ROOT = Path(__file__).resolve().parent

# dev:api 启动即读仓库根 .env（setdefault：已导出的真实环境变量优先）。
load_root_env()

app = create_app(
    database_path=_REPO_ROOT / os.environ.get("CHATTY_DATABASE_PATH", "data/chatty.sqlite")
)


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
