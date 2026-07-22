"""Chatty FastAPI entry point."""

from __future__ import annotations

import os

import uvicorn

if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    host = "0.0.0.0" if "PORT" in os.environ else "127.0.0.1"  # noqa: S104
    uvicorn.run("chatty.app:app", host=host, port=port)
