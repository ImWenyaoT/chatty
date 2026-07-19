from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import Annotated, Any
from uuid import uuid4

from agents import Model
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from chatty.commerce import CommerceError, CommerceStore, Order
from chatty.run import ChattyRunModule, CompletedRun, RunFailure, RunInput
from chatty.store import (
    CustomerMemory,
    MemoryStore,
    SupportRequest,
    SupportRequestStore,
    TraceSpanSummary,
    TraceStore,
    TraceSummary,
)


class RunRequest(BaseModel):
    message: str = Field(min_length=1, max_length=20_000)
    session_id: str | None = Field(default=None, min_length=1, max_length=200)


class SessionMessagesResponse(BaseModel):
    session_id: str
    messages: list[dict[str, Any]]


class MemorySearchResponse(BaseModel):
    customer_id: str
    query: str
    memories: list[CustomerMemory]


@dataclass(frozen=True)
class TraceResponse(TraceSummary):
    span_types: list[str]
    spans: list[TraceSpanSummary] = field(default_factory=list)


class TraceDashboardResponse(BaseModel):
    traces: list[TraceResponse]
    order_status_counts: dict[str, int]


def trace_response(
    trace: TraceSummary, trace_store: TraceStore, *, include_spans: bool = False
) -> TraceResponse:
    return TraceResponse(
        **trace.__dict__,
        span_types=trace_store.span_types(trace.trace_id),
        spans=trace_store.spans(trace.trace_id) if include_spans else [],
    )


def demo_customer_identity() -> str:
    return "demo-customer"


def new_request_identity() -> str:
    return f"request_{uuid4().hex}"


def create_app(
    *,
    database_path: str | Path,
    model: Model | None = None,
    model_id: str | None = None,
    knowledge_path: str | Path | None = None,
    customer_identity: Callable[[], str] = demo_customer_identity,
    request_identity: Callable[[], str] = new_request_identity,
) -> FastAPI:
    app = FastAPI(title="Chatty Agent", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
        allow_methods=["GET", "POST"],
        allow_headers=["content-type"],
    )
    runs = ChattyRunModule(
        database_path=database_path,
        model=model,
        model_id=model_id,
        knowledge_path=knowledge_path,
    )
    trace_store = TraceStore(database_path)
    memory_store = MemoryStore(database_path)
    support_store = SupportRequestStore(database_path)
    commerce = CommerceStore(database_path)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/runs", response_model=CompletedRun)
    async def create_run(
        request: RunRequest,
        customer_id: Annotated[str, Depends(customer_identity)],
        request_id: Annotated[str, Depends(request_identity)],
    ) -> CompletedRun:
        try:
            result = await runs.run(
                RunInput(
                    message=request.message,
                    customer_id=customer_id,
                    request_id=request_id,
                    session_id=request.session_id,
                )
            )
        except RunFailure as error:
            status_code = {
                "session_not_found": 409,
                "session_customer_mismatch": 409,
                "llm_not_configured": 503,
                "handoff_idempotency_conflict": 409,
                "handoff_persistence_failed": 500,
                "llm_provider_failed": 502,
            }[error.code]
            raise HTTPException(
                status_code=status_code,
                detail=error.code,
                headers={"X-Trace-ID": error.trace_id} if error.trace_id else None,
            ) from error
        return result

    @app.get(
        "/sessions/{session_id}/messages",
        response_model=SessionMessagesResponse,
    )
    async def get_session_messages(
        session_id: str,
        customer_id: Annotated[str, Depends(customer_identity)],
    ) -> SessionMessagesResponse:
        try:
            messages = await runs.session_messages(session_id=session_id, customer_id=customer_id)
        except RunFailure as error:
            status_code = {
                "session_not_found": 404,
                "session_customer_mismatch": 409,
            }[error.code]
            raise HTTPException(status_code=status_code, detail=error.code) from error
        return SessionMessagesResponse(session_id=session_id, messages=messages)

    @app.get("/support-requests", response_model=list[SupportRequest])
    async def list_support_requests() -> list[SupportRequest]:
        return support_store.list_all()

    @app.get("/support-requests/{support_request_id}", response_model=SupportRequest)
    async def get_support_request(support_request_id: str) -> SupportRequest:
        request = support_store.get(support_request_id)
        if request is None:
            raise HTTPException(status_code=404, detail="support_request_not_found")
        return request

    @app.get(
        "/memories",
        response_model=MemorySearchResponse,
    )
    async def search_customer_memories(
        customer_id: Annotated[str, Depends(customer_identity)],
        query: str = "",
        limit: int = 10,
    ) -> MemorySearchResponse:
        if not 1 <= limit <= 10:
            raise HTTPException(status_code=422, detail="invalid_memory_limit")
        memories = memory_store.search(customer_id=customer_id, query=query, limit=limit)
        return MemorySearchResponse(
            customer_id=customer_id,
            query=query,
            memories=memories,
        )

    @app.get("/traces", response_model=TraceDashboardResponse)
    async def list_traces(limit: int = 50) -> TraceDashboardResponse:
        if not 1 <= limit <= 100:
            raise HTTPException(status_code=422, detail="invalid_trace_limit")
        traces = [
            trace_response(trace, trace_store) for trace in trace_store.list_recent(limit=limit)
        ]
        return TraceDashboardResponse(
            traces=traces,
            order_status_counts={key: value for key, value in commerce.status_counts().items()},
        )

    @app.get("/traces/{trace_id}", response_model=TraceResponse)
    async def get_trace(trace_id: str) -> TraceResponse:
        trace = trace_store.get(trace_id)
        if trace is None:
            raise HTTPException(status_code=404, detail="trace_not_found")
        return trace_response(trace, trace_store, include_spans=True)

    @app.get("/traces/{trace_id}/spans", response_model=list[TraceSpanSummary])
    async def get_trace_spans(trace_id: str) -> list[TraceSpanSummary]:
        if trace_store.get(trace_id) is None:
            raise HTTPException(status_code=404, detail="trace_not_found")
        return trace_store.spans(trace_id)

    @app.get("/orders", response_model=list[Order])
    async def list_orders() -> list[Order]:
        return commerce.list_orders()

    @app.get("/orders/{order_id}", response_model=Order)
    async def get_order(order_id: str) -> Order:
        try:
            return commerce.get_order(order_id)
        except CommerceError as error:
            raise HTTPException(status_code=404, detail="order_not_found") from error

    return app
