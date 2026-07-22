"""Chatty HTTP 层（specs/http-contract.md、decisions §1）。

- 全部路由挂在 `/api/chatty` 前缀下（decisions §1.6），任何地方不做前缀剥离。
- 懒初始化（§1.2）：/health、/openapi.json、/docs、/redoc 不触发 SQLite 打开或
  Agent 运行时构建；NativeRuntime 与 run 模块在首次业务请求时构建并缓存。
  run 模块懒构造使 `llm_not_configured` 在 POST /runs 时映射 503（decisions §5.2）。
- /docs、/redoc 是占位 HTML（decisions §1.1）；/openapi.json 用 FastAPI 原生生成，
  对齐 title / servers / paths 键集合（decisions §1.2：paths 剥掉前缀）。
- 可选伺服前端 dist（SPA fallback 到 index.html，decisions §7.3 CI 冒烟）。

注意：本模块不使用 `from __future__ import annotations` —— 端点签名里的
Depends(customer_identity) 引用 create_app 闭包变量，注解必须立即求值。
"""

import threading
from collections.abc import Callable
from contextlib import asynccontextmanager
from dataclasses import asdict
from pathlib import Path
from typing import Annotated, Any
from uuid import uuid4

from agents import Model
from fastapi import APIRouter, Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.openapi.utils import get_openapi
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse
from starlette.routing import Match

from chatty.artifacts import ArtifactNotFoundError, ArtifactStateError
from chatty.commerce import CommerceError
from chatty.contracts import (
    ArtifactApproval,
    ArtifactList,
    CustomerMemory,
    MemorySearchResponse,
    Order,
    RunRequest,
    RunResponse,
    SessionMessagesResponse,
    SupportRequest,
    Trace,
    TraceDashboard,
    TraceSpan,
)
from chatty.harness import RunFailure, run_failure_http_status
from chatty.run import ChattyRunModule
from chatty.runtime import NativeRuntime
from chatty.traces import TraceStore, TraceSummary

BASE_PATH = "/api/chatty"

# TS 占位文档 HTML（http-contract §8.2，逐字；{kind} 为 swagger / redoc）。
_DOC_PLACEHOLDER_HTML = (
    "<!doctype html>\n"
    '<html lang="en"><meta charset="utf-8"><title>Chatty Agent API</title>\n'
    "<body><main><h1>Chatty Agent API</h1><p>{kind} documentation</p>\n"
    '<p><a href="/api/chatty/openapi.json">OpenAPI JSON</a></p></main></body></html>'
)


def demo_customer_identity() -> str:
    return "demo-customer"


def demo_reviewer_identity() -> str:
    return "demo-reviewer"


def new_request_identity() -> str:
    return f"request_{uuid4().hex}"


def parsed_limit(value: str | None, fallback: int) -> int | None:
    """§6：JS `Number()` 的可观测近似——整数字符串生效，其余 None（→ 业务 422）。"""
    if value is None:
        return fallback
    try:
        number = float(value)
    except ValueError:
        return None
    return int(number) if number.is_integer() else None


class AppServices:
    """懒初始化容器（§1.2）：runtime 与 run 模块首次业务请求时构建并缓存复用。

    run 模块构造失败（如 llm_not_configured）不缓存，下次请求重试。
    """

    def __init__(
        self,
        *,
        database_path: str | Path,
        knowledge_path: str | Path | None,
        model: Model | None,
        model_id: str | None,
    ) -> None:
        self._database_path = database_path
        self._knowledge_path = knowledge_path
        self._model = model
        self._model_id = model_id
        self._lock = threading.RLock()
        self._runtime: NativeRuntime | None = None
        self._run_module: ChattyRunModule | None = None

    def runtime(self) -> NativeRuntime:
        with self._lock:
            if self._runtime is None:
                self._runtime = NativeRuntime(self._database_path)
            return self._runtime

    def run_module(self) -> ChattyRunModule:
        with self._lock:
            if self._run_module is None:
                self._run_module = ChattyRunModule(
                    self.runtime(),
                    model=self._model,
                    model_id=self._model_id,
                    knowledge_path=self._knowledge_path,
                )
            return self._run_module

    async def aclose(self) -> None:
        """§1.2 关闭顺序：先 run 模块（LLM client），再 runtime（stores）。"""
        with self._lock:
            run_module, self._run_module = self._run_module, None
            runtime, self._runtime = self._runtime, None
        if run_module is not None:
            await run_module.close()
        if runtime is not None:
            runtime.close()


def _trace_model(summary: TraceSummary, traces: TraceStore, *, include_spans: bool) -> Trace:
    return Trace(
        **asdict(summary),
        span_types=traces.span_types(summary.trace_id),
        spans=(
            [TraceSpan(**asdict(span)) for span in traces.spans(summary.trace_id)]
            if include_spans
            else []
        ),
    )


def create_app(
    *,
    database_path: str | Path,
    knowledge_path: str | Path | None = None,
    model: Model | None = None,
    model_id: str | None = None,
    customer_identity: Callable[[], str] = demo_customer_identity,
    reviewer_identity: Callable[[], str] = demo_reviewer_identity,
    request_identity: Callable[[], str] = new_request_identity,
    static_dir: str | Path | None = None,
) -> FastAPI:
    """HTTP 应用工厂（§1.2）。身份注入点都是零参函数；请求体身份一律忽略。"""
    services = AppServices(
        database_path=database_path,
        knowledge_path=knowledge_path,
        model=model,
        model_id=model_id,
    )

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        yield
        await services.aclose()

    app = FastAPI(
        title="Chatty Agent",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    app.state.services = services
    # CORS（§7）：精确来源集合；预检行为接受 Starlette 语义（decisions §1.4）。
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
        allow_methods=["GET", "POST"],
        allow_headers=["content-type"],
    )

    router = APIRouter(prefix=BASE_PATH)

    @router.get("/health")
    def health() -> dict[str, str]:
        # §4.1：禁止触发 runtime 初始化。
        return {"status": "ok"}

    @router.post("/runs", response_model=RunResponse)
    async def create_run(
        request: RunRequest,
        customer_id: Annotated[str, Depends(customer_identity)],
        request_id: Annotated[str, Depends(request_identity)],
    ) -> RunResponse:
        try:
            module = services.run_module()
            return await module.run(
                message=request.message,
                customer_id=customer_id,
                session_id=request.session_id,
                request_id=request_id,
            )
        except RunFailure as error:
            raise HTTPException(
                status_code=run_failure_http_status(error.code),
                detail=error.code,
                headers={"X-Trace-ID": error.trace_id} if error.trace_id else None,
            ) from error

    @router.get("/sessions/{session_id}/messages", response_model=SessionMessagesResponse)
    async def get_session_messages(
        session_id: str,
        customer_id: Annotated[str, Depends(customer_identity)],
    ) -> SessionMessagesResponse:
        try:
            messages = await services.run_module().session_messages(
                session_id=session_id, customer_id=customer_id
            )
        except RunFailure as error:
            # §4.3：与 /runs 不同，session_not_found 在此映射 404。
            status_code = (
                404 if error.code == "session_not_found" else run_failure_http_status(error.code)
            )
            raise HTTPException(status_code=status_code, detail=error.code) from error
        return SessionMessagesResponse(session_id=session_id, messages=messages)

    @router.get("/orders", response_model=list[Order])
    def list_orders() -> list[Order]:
        return services.runtime().commerce.list_orders()

    @router.get("/orders/{order_id}", response_model=Order)
    def get_order(order_id: str) -> Order:
        try:
            return services.runtime().commerce.get_order(order_id)
        except CommerceError as error:
            if error.code == "order_not_found":
                raise HTTPException(status_code=404, detail="order_not_found") from error
            raise

    @router.get("/artifacts", response_model=ArtifactList)
    def list_artifacts(
        customer_id: Annotated[str, Depends(customer_identity)],
        session_id: str | None = None,
    ) -> ArtifactList:
        return services.runtime().artifacts.list(customer_id, session_id)

    @router.post("/artifacts/{artifact_id}/approve", response_model=ArtifactApproval)
    def approve_artifact(
        artifact_id: str,
        customer_id: Annotated[str, Depends(customer_identity)],
        reviewer_id: Annotated[str, Depends(reviewer_identity)],
    ) -> ArtifactApproval:
        try:
            return services.runtime().artifacts.approve(artifact_id, reviewer_id, customer_id)
        except ArtifactNotFoundError as error:
            # owner 不匹配同样落 404，不泄露存在性（§4.5）。
            raise HTTPException(status_code=404, detail="artifact_not_found") from error
        except ArtifactStateError as error:
            raise HTTPException(status_code=409, detail=error.code) from error

    @router.get("/memories", response_model=MemorySearchResponse)
    def search_memories(
        customer_id: Annotated[str, Depends(customer_identity)],
        query: str = "",
        limit: str | None = None,
    ) -> MemorySearchResponse:
        parsed = parsed_limit(limit, 10)
        if parsed is None or not 1 <= parsed <= 10:
            raise HTTPException(status_code=422, detail="invalid_memory_limit")
        memories = services.runtime().memory.search(
            customer_id=customer_id, query=query, limit=parsed
        )
        return MemorySearchResponse(
            customer_id=customer_id,
            query=query,
            memories=[CustomerMemory(**asdict(memory)) for memory in memories],
        )

    @router.get("/support-requests", response_model=list[SupportRequest])
    def list_support_requests() -> list[SupportRequest]:
        return [SupportRequest(**asdict(item)) for item in services.runtime().support.list_all()]

    @router.get("/support-requests/{support_request_id}", response_model=SupportRequest)
    def get_support_request(support_request_id: str) -> SupportRequest:
        record = services.runtime().support.get(support_request_id)
        if record is None:
            raise HTTPException(status_code=404, detail="support_request_not_found")
        return SupportRequest(**asdict(record))

    @router.get("/traces", response_model=TraceDashboard)
    def list_traces(limit: str | None = None) -> TraceDashboard:
        parsed = parsed_limit(limit, 50)
        if parsed is None or not 1 <= parsed <= 100:
            raise HTTPException(status_code=422, detail="invalid_trace_limit")
        runtime = services.runtime()
        traces = [
            _trace_model(summary, runtime.traces, include_spans=False)
            for summary in runtime.traces.list_recent(limit=parsed)
        ]
        return TraceDashboard(
            traces=traces,
            order_status_counts={
                str(status): count for status, count in runtime.commerce.status_counts().items()
            },
        )

    @router.get("/traces/{trace_id}", response_model=Trace)
    def get_trace(trace_id: str) -> Trace:
        runtime = services.runtime()
        summary = runtime.traces.get(trace_id)
        if summary is None:
            raise HTTPException(status_code=404, detail="trace_not_found")
        return _trace_model(summary, runtime.traces, include_spans=True)

    @router.get("/traces/{trace_id}/spans", response_model=list[TraceSpan])
    def get_trace_spans(trace_id: str) -> list[TraceSpan]:
        runtime = services.runtime()
        if runtime.traces.get(trace_id) is None:
            raise HTTPException(status_code=404, detail="trace_not_found")
        return [TraceSpan(**asdict(span)) for span in runtime.traces.spans(trace_id)]

    @router.get("/openapi.json", include_in_schema=False)
    def openapi_json() -> JSONResponse:
        return JSONResponse(app.openapi())

    @router.get("/docs", include_in_schema=False)
    def swagger_docs() -> HTMLResponse:
        return HTMLResponse(_DOC_PLACEHOLDER_HTML.format(kind="swagger"))

    @router.get("/redoc", include_in_schema=False)
    def redoc_docs() -> HTMLResponse:
        return HTMLResponse(_DOC_PLACEHOLDER_HTML.format(kind="redoc"))

    app.include_router(router)

    def custom_openapi() -> dict[str, Any]:
        """原生生成 + 对齐断言（decisions §1.2）：servers=/api/chatty，paths 剥前缀。"""
        if app.openapi_schema:
            return app.openapi_schema
        schema = get_openapi(
            title=app.title,
            version=app.version,
            servers=[{"url": BASE_PATH}],
            routes=app.routes,
        )
        schema["paths"] = {
            path.removeprefix(BASE_PATH): item for path, item in schema.get("paths", {}).items()
        }
        app.openapi_schema = schema
        return schema

    app.openapi = custom_openapi  # type: ignore[method-assign]  # ty: ignore[invalid-assignment]

    if static_dir is not None:
        static_root = Path(static_dir).resolve()
        index_file = static_root / "index.html"
        # GET catch-all 会让未知路径的非 GET 请求落 Starlette 的 405：下方 405
        # 处理器只在真实 API 路由（catch-all 之前注册的）路径模式命中时保留 405。
        api_routes = list(app.routes)

        @app.get("/{full_path:path}", include_in_schema=False)
        def serve_static(full_path: str) -> FileResponse:
            # API 前缀下的未知路径保持 JSON 404，不落 SPA fallback。
            if full_path == "api/chatty" or full_path.startswith("api/chatty/"):
                raise HTTPException(status_code=404, detail="Not Found")
            if full_path:
                candidate = (static_root / full_path).resolve()
                if candidate.is_file() and candidate.is_relative_to(static_root):
                    return FileResponse(candidate)
            # decisions §7.3：/ 与 /orders 等前端路由靠 SPA fallback 回 index.html。
            return FileResponse(index_file)

        async def method_not_allowed(request: Request, exc: Exception) -> JSONResponse:
            if any(route.matches(request.scope)[0] is not Match.NONE for route in api_routes):
                return JSONResponse(
                    {"detail": "Method Not Allowed"},
                    status_code=405,
                    headers=getattr(exc, "headers", None),
                )
            return JSONResponse({"detail": "Not Found"}, status_code=404)

        app.add_exception_handler(405, method_not_allowed)

    return app
