from __future__ import annotations

import uvicorn

from app.settings import load_settings


def main() -> None:
    settings = load_settings()
    uvicorn.run(
        "app.api:create_app",
        host="127.0.0.1",
        port=settings.port,
        factory=True,
    )


if __name__ == "__main__":
    main()
