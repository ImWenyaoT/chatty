from pathlib import Path

import uvicorn

from chatty.app import create_app

app = create_app(database_path=Path("data/chatty.sqlite"))


if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)
