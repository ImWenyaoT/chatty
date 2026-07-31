"""Web 界面的 HTTP 层。

一轮一个请求，会话状态存在进程内存里（见 ADR 0001）：SQLite 的职责是演示业务数据和
知识检索，加一张会话表就是给它加第二种职责；演示场景重启丢会话可以接受。

这一层刻意很薄。它不拼澄清历史、不判断该不该反问、也不碰任何业务事实——
那些都在 `Conversation` 和 Harness 里。它只做三件事：把会话状态存起来、
把领域异常翻译成 HTTP 状态码、把响应模型交给 FastAPI 序列化。

跑起来：

    uv run uvicorn chatty.api:create_app --factory --reload
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Annotated
from uuid import uuid4

from agents.items import TResponseInputItem
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from chatty.agent import RecommendationError, Recommender
from chatty.catalog import Catalog
from chatty.conversation import Conversation
from chatty.model_provider import EnvModelProvider, ModelProvider
from chatty.models import (
    ClarifyReply,
    RecommendationResponse,
    RecommendedProduct,
    UserContext,
)
from chatty.need_parser import describe, parse_need

# demo 里列出来的那几个演示身份，前端要拿它做身份切换
DEMO_USERS = ("user_active", "user_budget", "user_vip", "user_new", "user_churn")
MAX_TURNS = 3


# ============================================================================
# 会话存储
# ============================================================================


@dataclass
class Session:
    """一次会话的全部状态。

    said 是用户说过的**全部**话；history 是喂给模型的对话历史，形状归
    Conversation 管，这里只负责原样存回去。
    """

    user_id: str
    said: list[str] = field(default_factory=list)
    history: list[TResponseInputItem] = field(default_factory=list)
    turns: int = 0


class SessionStore:
    """进程内存里的会话表。加锁是因为 uvicorn 可能并发处理请求。"""

    def __init__(self) -> None:
        self._sessions: dict[str, Session] = {}
        self._lock = asyncio.Lock()

    async def create(self, user_id: str) -> tuple[str, Session]:
        session_id = f"session_{uuid4().hex}"
        session = Session(user_id=user_id)
        async with self._lock:
            self._sessions[session_id] = session
        return session_id, session

    async def get(self, session_id: str) -> Session:
        async with self._lock:
            session = self._sessions.get(session_id)
        if session is None:
            raise HTTPException(status_code=404, detail="session_not_found")
        return session


# ============================================================================
# 请求与响应模型
# ============================================================================


class CreateSessionRequest(BaseModel):
    user_id: str = "user_active"


class CreateSessionResponse(BaseModel):
    session_id: str
    user_id: str


class TurnRequest(BaseModel):
    text: Annotated[str, Field(min_length=1, max_length=500)]


class TurnResponse(BaseModel):
    """一轮的结果。三种互斥情况，前端按 kind 分支。"""

    kind: str  # "recommend" | "clarify" | "exhausted"
    # 这一句被理解成了什么，让人看得见输入适配做了什么
    understood_as: str
    question: str | None = None
    products: list[RecommendedProduct] = []
    latency_ms: float = 0.0
    turns_left: int = 0


class CatalogResponse(BaseModel):
    categories: list[str]
    users: list[str]
    product_count: int
    model_id: str


# ============================================================================
# 应用装配
# ============================================================================


@dataclass
class Deps:
    """一个进程一份：Catalog 和模型提供方都只建一次。"""

    catalog: Catalog
    provider: ModelProvider
    sessions: SessionStore


def create_app(
    *,
    catalog: Catalog | None = None,
    provider: ModelProvider | None = None,
) -> FastAPI:
    """建一个应用。

    catalog 与 provider 可以注入——这是测试能离线跑完整 HTTP 路径的原因，
    也是这一层唯一需要的 seam。都不传就按环境变量连真实的。
    """
    owns = catalog is None and provider is None
    deps = Deps(
        catalog=catalog if catalog is not None else Catalog(),
        provider=provider if provider is not None else EnvModelProvider(),
        sessions=SessionStore(),
    )

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        yield
        # 只关自己建的：注入进来的归调用方管，这条规矩全仓库一致
        if owns:
            await deps.provider.close()
            deps.catalog.close()

    app = FastAPI(title="Chatty", lifespan=lifespan)
    # 开发时前端跑在 5173，和后端不同源
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:5173", "http://127.0.0.1:5173"],
        allow_methods=["*"],
        allow_headers=["*"],
    )
    app.state.deps = deps

    # 路由直接闭包捕获 deps：一个 app 一份，闭包就是注入，不需要 Depends 再绕一圈。

    @app.get("/api/catalog", response_model=CatalogResponse)
    async def read_catalog() -> CatalogResponse:
        """前端启动时拿一次：有哪些类目、能用哪些身份、跑的是哪个模型。"""
        return CatalogResponse(
            categories=deps.catalog.categories,
            users=list(DEMO_USERS),
            product_count=len(deps.catalog.products),
            model_id=deps.provider.model_id,
        )

    @app.post("/api/sessions", response_model=CreateSessionResponse)
    async def create_session(body: CreateSessionRequest) -> CreateSessionResponse:
        if body.user_id not in DEMO_USERS:
            raise HTTPException(status_code=422, detail="unknown_user")
        session_id, session = await deps.sessions.create(body.user_id)
        return CreateSessionResponse(session_id=session_id, user_id=session.user_id)

    @app.post("/api/sessions/{session_id}/turns", response_model=TurnResponse)
    async def take_turn(session_id: str, body: TurnRequest) -> TurnResponse:
        session = await deps.sessions.get(session_id)
        if session.turns >= MAX_TURNS:
            raise HTTPException(status_code=409, detail="conversation_exhausted")

        understood = UserContext()

        async def resolve(said: list[str]) -> UserContext:
            nonlocal understood
            understood = await parse_need(deps.provider, " ".join(said), deps.catalog.categories)
            return understood

        recommender = Recommender(deps.catalog, provider=deps.provider)
        conversation = Conversation(
            recommender,
            user_id=session.user_id,
            resolve=resolve,
            max_turns=MAX_TURNS,
        )
        said = [*session.said, body.text]
        try:
            reply, history = await conversation.send(said, session.history)
        except RecommendationError as error:
            # 领域失败有稳定错误码，原样交给前端——它比 500 有用得多，
            # 前端能按码给不同的解释（条件太紧 vs 模型这轮没按约定走）。
            raise HTTPException(status_code=422, detail=error.code) from error
        finally:
            # provider 和 catalog 都是注入的，Recommender 一样都不该关
            await recommender.close()

        # 这一轮跑通了才记进会话：失败的那句话不该污染后续解析
        session.said = said
        session.history = history
        session.turns += 1
        turns_left = MAX_TURNS - session.turns

        if isinstance(reply, RecommendationResponse):
            return TurnResponse(
                kind="recommend",
                understood_as=describe(understood),
                products=reply.products,
                latency_ms=reply.total_latency_ms,
                turns_left=turns_left,
            )
        assert isinstance(reply, ClarifyReply)
        return TurnResponse(
            # 轮次用完了它还在反问，前端该提示重开一轮而不是继续答
            kind="clarify" if turns_left > 0 else "exhausted",
            understood_as=describe(understood),
            question=reply.question,
            latency_ms=reply.total_latency_ms,
            turns_left=turns_left,
        )

    return app
