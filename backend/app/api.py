from __future__ import annotations

import logging
import uuid
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Any

from fastapi import FastAPI, HTTPException, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field, field_validator

from app.agent import Chatty, ChattyAgent, ChattyContext, ChattyError
from app.data.catalog import Catalog
from app.data.models import ClarifyReply, KnowledgeReply
from app.model_provider import ResponsesModelProvider
from app.settings import FRONTEND_DIST

LOGGER = logging.getLogger("chatty")
DEMO_USERS = [
    {
        "id": "user_active",
        "label": "用户 A · 活跃型",
        "display_name": "用户 A",
        "profile_label": "活跃型",
    },
    {
        "id": "user_budget",
        "label": "用户 B · 价格敏感型",
        "display_name": "用户 B",
        "profile_label": "价格敏感型",
    },
    {
        "id": "user_vip",
        "label": "用户 C · 高价值型",
        "display_name": "用户 C",
        "profile_label": "高价值型",
    },
    {
        "id": "user_new",
        "label": "用户 D · 新客型",
        "display_name": "用户 D",
        "profile_label": "新客型",
    },
    {
        "id": "user_churn",
        "label": "用户 E · 流失风险型",
        "display_name": "用户 E",
        "profile_label": "流失风险型",
    },
]
DEMO_USER_IDS = {user["id"] for user in DEMO_USERS}


class CreateSessionBody(BaseModel):
    user_id: str = "user_active"


class TurnBody(BaseModel):
    text: str = Field(min_length=1, max_length=500)

    @field_validator("text")
    @classmethod
    def text_must_not_be_blank(cls, value: str) -> str:
        text = value.strip()
        if not text:
            raise ValueError("blank_text")
        return text


@dataclass
class SessionState:
    user_id: str
    context: ChattyContext = field(default_factory=ChattyContext)


def create_app(
    catalog: Catalog | None = None,
    provider: ResponsesModelProvider | None = None,
    chatty: ChattyAgent | None = None,
) -> FastAPI:
    owns_catalog = catalog is None
    owns_provider = provider is None
    app_catalog = catalog or Catalog()
    app_provider = provider or ResponsesModelProvider()
    app_chatty = chatty or Chatty(app_catalog, app_provider)
    sessions: dict[str, SessionState] = {}

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        if owns_catalog:
            app_catalog.close()
        if owns_provider:
            await app_provider.close()

    app = FastAPI(title="Chatty API", lifespan=lifespan)

    @app.exception_handler(RequestValidationError)
    async def invalid_request(_: Request, __: RequestValidationError) -> JSONResponse:
        return JSONResponse(status_code=422, content={"detail": "invalid_request"})

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/api/catalog")
    async def catalog_info() -> dict[str, Any]:
        return {
            "categories": app_catalog.categories,
            "users": DEMO_USERS,
            "product_count": len(app_catalog.products),
            "model_id": app_provider.model_id,
        }

    @app.get("/api/catalog/data")
    async def catalog_data() -> dict[str, Any]:
        """为 Demo 提供只读的 SQLite 商品与画像快照。"""

        return {
            "products": [product.model_dump() for product in app_catalog.products],
            "profiles": [
                {
                    **app_catalog.profiles[user["id"]].model_dump(),
                    "display_name": user["display_name"],
                    "profile_label": user["profile_label"],
                }
                for user in DEMO_USERS
            ],
        }

    @app.post("/api/sessions")
    async def create_session(body: CreateSessionBody) -> dict[str, str]:
        if body.user_id not in DEMO_USER_IDS:
            raise HTTPException(status_code=422, detail="unknown_user")
        session_id = f"session_{uuid.uuid4().hex}"
        sessions[session_id] = SessionState(user_id=body.user_id)
        return {"session_id": session_id}

    @app.post("/api/sessions/{session_id}/turns")
    async def take_turn(session_id: str, body: TurnBody) -> dict[str, Any]:
        session = sessions.get(session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="session_not_found")
        # Demo 前端在请求期间会禁用输入，因此每个 session 一次只发一轮。
        try:
            turn = await app_chatty.run(
                session.user_id,
                body.text,
                session.context,
            )
        except ChattyError as error:
            LOGGER.error("%s %s", error.code, error.diagnostics)
            status = 409 if error.code == "conversation_exhausted" else 422
            raise HTTPException(status_code=status, detail=error.code) from error

        session.context = turn.context

        # recommend / clarify / exhausted 共用这些观察字段，前端不再自行推导。
        common = {
            "understood_as": turn.understood_as,
            "answer": turn.reply.answer,
            "latency_ms": turn.latency_ms,
            "turns_left": turn.turns_left,
            "trace": turn.trace,
            "usage": {
                "model_requests": turn.usage.requests,
                "input_tokens": turn.usage.input_tokens,
                "output_tokens": turn.usage.output_tokens,
                "total_tokens": turn.usage.total_tokens,
            },
        }
        if isinstance(turn.reply, KnowledgeReply):
            return {
                **common,
                "kind": "answer",
                "question": None,
                "products": [],
            }
        if isinstance(turn.reply, ClarifyReply):
            reply_kind = "clarify"
            if turn.turns_left == 0:
                reply_kind = "exhausted"
            return {
                **common,
                "kind": reply_kind,
                "question": turn.reply.question,
                "products": [],
            }
        return {
            **common,
            "kind": "recommend",
            "question": None,
            "products": [product.model_dump() for product in turn.reply.products],
        }

    # 必须最后挂载，避免静态页面遮住 /api 和 /health。
    if FRONTEND_DIST.exists():
        app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="web")
    else:
        LOGGER.warning("frontend_dist_missing: %s", FRONTEND_DIST)
    return app
