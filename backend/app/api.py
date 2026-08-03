from __future__ import annotations

import asyncio
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

from app.agent import RecommendationError, Recommender
from app.catalog import Catalog
from app.conversation import Conversation
from app.model_provider import MissingCredentialsError, ResponsesModelProvider
from app.models import ClarifyReply, UserContext
from app.need_parser import NeedParseError, describe, parse_need
from app.settings import FRONTEND_DIST

LOGGER = logging.getLogger("chatty")
MAX_TURNS = 3
DEMO_USERS = [
    {"id": "user_active", "label": "活跃用户"},
    {"id": "user_budget", "label": "价格敏感用户"},
    {"id": "user_vip", "label": "高价值用户"},
    {"id": "user_new", "label": "新用户"},
    {"id": "user_churn", "label": "流失风险用户"},
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
    said: list[str] = field(default_factory=list)
    history: list[dict[str, Any]] = field(default_factory=list)
    turns: int = 0
    lock: asyncio.Lock = field(default_factory=asyncio.Lock)


def create_app(
    catalog: Catalog | None = None,
    provider: ResponsesModelProvider | None = None,
) -> FastAPI:
    owns_catalog = catalog is None
    owns_provider = provider is None
    app_catalog = catalog or Catalog()
    app_provider = provider or ResponsesModelProvider()
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
        # 同一 session 串行处理，避免两个请求同时覆盖 history 和 turns。
        async with session.lock:
            if session.turns >= MAX_TURNS:
                raise HTTPException(status_code=409, detail="conversation_exhausted")

            said = [*session.said, body.text]
            understood = UserContext()

            async def resolve_context(values: list[str]) -> UserContext:
                nonlocal understood
                try:
                    understood = await parse_need(
                        app_provider.complete,
                        " ".join(values),
                        app_catalog.categories,
                    )
                except MissingCredentialsError as error:
                    raise RecommendationError("llm_not_configured") from error
                return understood

            try:
                conversation = Conversation(
                    Recommender(app_catalog, app_provider),
                    session.user_id,
                    resolve_context,
                )
                reply, history = await conversation.send(said, session.history)
            except RecommendationError as error:
                LOGGER.error("%s %s", error.code, error.diagnostics)
                raise HTTPException(status_code=422, detail=error.code) from error
            except NeedParseError as error:
                LOGGER.error("need_parse_failed: %s", error)
                raise HTTPException(
                    status_code=422, detail="need_parse_failed"
                ) from error

            session.said = said
            session.history = history
            session.turns += 1
            turns_left = MAX_TURNS - session.turns

            # recommend / clarify / exhausted 共用这些观察字段，前端不再自行推导。
            common = {
                "understood_as": describe(understood),
                "latency_ms": reply.total_latency_ms,
                "turns_left": turns_left,
            }
            if isinstance(reply, ClarifyReply):
                reply_kind = "clarify"
                if turns_left == 0:
                    reply_kind = "exhausted"
                return {
                    **common,
                    "kind": reply_kind,
                    "question": reply.question,
                    "products": [],
                }
            return {
                **common,
                "kind": "recommend",
                "question": None,
                "products": [product.model_dump() for product in reply.products],
            }

    # 必须最后挂载，避免静态页面遮住 /api 和 /health。
    if FRONTEND_DIST.exists():
        app.mount("/", StaticFiles(directory=FRONTEND_DIST, html=True), name="web")
    else:
        LOGGER.warning("frontend_dist_missing: %s", FRONTEND_DIST)
    return app
