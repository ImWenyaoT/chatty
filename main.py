"""uvicorn 启动入口（`pnpm dev:api`）：装配逻辑全在 `chatty.smoke`（受 ty 与 pytest 覆盖）。"""

from chatty.smoke import serve

if __name__ == "__main__":
    serve()
