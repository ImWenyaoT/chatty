import os
from pathlib import Path

from chatty.app import create_app
from chatty.eval import EvalModel, MessageScript

database_path = Path(os.environ.get("CHATTY_E2E_DATABASE", ".cache/browser-e2e.sqlite"))
for sqlite_path in (
    database_path,
    Path(f"{database_path}-wal"),
    Path(f"{database_path}-shm"),
):
    sqlite_path.unlink(missing_ok=True)

app = create_app(
    database_path=database_path,
    model=EvalModel(
        [
            MessageScript(
                type="message",
                message_id="browser-smoke-message",
                text="浏览器链路已完成。",
            )
        ]
    ),
    model_id="browser-smoke-model",
    customer_identity=lambda: "browser-smoke-customer",
    request_identity=lambda: "browser-smoke-request",
)
