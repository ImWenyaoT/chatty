from collections.abc import Callable
from pathlib import Path
from typing import Annotated
from uuid import uuid4

from agents import Model
from agents.tracing import gen_trace_id, set_trace_processors
from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from chatty.agent import HandoffPersistenceError, MissingApiKeyError, model_from_env, run_agent
from chatty.knowledge import KnowledgeRecord, KnowledgeStore
from chatty.commerce import CommerceError, CommerceStore, Order
from chatty.store import (
    MemoryStore,
    SessionCustomerMismatchError,
    SupportRequestStore,
    TraceStore,
)
from chatty.tracing import SQLiteTracingProcessor


class RunRequest(BaseModel):
    message: str = Field(min_length=1, max_length=20_000)
    session_id: str | None = Field(default=None, min_length=1, max_length=200)


class MemoryResponse(BaseModel):
    memory_id: str
    customer_id: str
    fact: str
    source_id: str
    created_at: str


class MemoryEventResponse(BaseModel):
    tool: str
    memories: list[MemoryResponse]


class RunResponse(BaseModel):
    reply: str
    customer_id: str
    session_id: str
    trace_id: str
    status: str
    request_id: str
    business_outcome: str
    completion_evidence: str | None
    knowledge_search_results: list[KnowledgeRecord]
    memory_events: list[MemoryEventResponse]
    needs_human: bool
    support_request_id: str | None = None


class MemorySearchResponse(BaseModel):
    customer_id: str
    query: str
    memories: list[MemoryResponse]


class SupportRequestResponse(BaseModel):
    id: str
    customer_id: str
    session_id: str
    reason: str
    context: str
    model_context: str
    prior_actions: tuple[str, ...]
    status: str
    created_at: str
    updated_at: str


class TraceResponse(BaseModel):
    trace_id: str
    session_id: str
    status: str
    summary: str
    model_id: str
    span_types: list[str]


class TraceSpanResponse(BaseModel):
    span_type: str
    status: str
    summary: str


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
    trace_store = TraceStore(database_path)
    memory_store = MemoryStore(database_path)
    support_store = SupportRequestStore(database_path)
    knowledge_store = KnowledgeStore(database_path)
    active_knowledge_path = (
        Path(knowledge_path)
        if knowledge_path is not None
        else Path(__file__).parents[2] / "knowledge" / "records.jsonl"
    )
    knowledge_store.import_jsonl(active_knowledge_path)
    commerce = CommerceStore(database_path)
    set_trace_processors([SQLiteTracingProcessor(trace_store)])
    configured_model = (model, model_id or "injected-model") if model is not None else None

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/runs", response_model=RunResponse)
    async def create_run(
        request: RunRequest,
        customer_id: Annotated[str, Depends(customer_identity)],
        request_id: Annotated[str, Depends(request_identity)],
    ) -> RunResponse:
        nonlocal configured_model
        session_id = request.session_id or f"session_{uuid4().hex}"
        trace_id = gen_trace_id()
        try:
            if configured_model is None:
                configured_model = model_from_env()
            active_model, active_model_id = configured_model
        except MissingApiKeyError as error:
            raise HTTPException(status_code=503, detail="llm_not_configured") from error

        try:
            result = await run_agent(
                message=request.message,
                session_id=session_id,
                database_path=database_path,
                model=active_model,
                model_id=active_model_id,
                trace_id=trace_id,
                request_id=request_id,
                knowledge_store=knowledge_store,
                customer_id=customer_id,
                commerce=commerce,
                support_store=support_store,
                trace_store=trace_store,
            )
        except SessionCustomerMismatchError as error:
            raise HTTPException(status_code=409, detail="session_customer_mismatch") from error
        except HandoffPersistenceError as error:
            trace_store.fail(trace_id)
            raise HTTPException(
                status_code=500,
                detail="handoff_persistence_failed",
                headers={"X-Trace-ID": trace_id},
            ) from error
        except Exception as error:
            trace_store.fail(trace_id)
            raise HTTPException(
                status_code=502,
                detail="llm_provider_failed",
                headers={"X-Trace-ID": trace_id},
            ) from error
        return RunResponse(
            reply=result.reply,
            customer_id=customer_id,
            session_id=session_id,
            trace_id=trace_id,
            request_id=request_id,
            status=(
                "needs_human"
                if result.support_request_id is not None
                else {
                    "verified": "completed",
                    "not_completed": "not_completed",
                    "not_applicable": "responded",
                }[result.business_outcome]
            ),
            business_outcome=result.business_outcome,
            completion_evidence=result.completion_evidence,
            knowledge_search_results=result.knowledge_search_results,
            memory_events=[
                MemoryEventResponse(
                    tool=event.tool,
                    memories=[MemoryResponse(**memory.__dict__) for memory in event.memories],
                )
                for event in result.memory_events
            ],
            needs_human=result.support_request_id is not None,
            support_request_id=result.support_request_id,
        )

    @app.get("/support-requests", response_model=list[SupportRequestResponse])
    async def list_support_requests() -> list[SupportRequestResponse]:
        return [SupportRequestResponse(**item.__dict__) for item in support_store.list_all()]

    @app.get("/support-requests/{support_request_id}", response_model=SupportRequestResponse)
    async def get_support_request(support_request_id: str) -> SupportRequestResponse:
        request = support_store.get(support_request_id)
        if request is None:
            raise HTTPException(status_code=404, detail="support_request_not_found")
        return SupportRequestResponse(**request.__dict__)

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
            memories=[MemoryResponse(**memory.__dict__) for memory in memories],
        )

    @app.get("/traces/{trace_id}", response_model=TraceResponse)
    async def get_trace(trace_id: str) -> TraceResponse:
        trace = trace_store.get(trace_id)
        if trace is None:
            raise HTTPException(status_code=404, detail="trace_not_found")
        return TraceResponse(**trace.__dict__, span_types=trace_store.span_types(trace_id))

    @app.get("/traces/{trace_id}/spans", response_model=list[TraceSpanResponse])
    async def get_trace_spans(trace_id: str) -> list[TraceSpanResponse]:
        if trace_store.get(trace_id) is None:
            raise HTTPException(status_code=404, detail="trace_not_found")
        return [TraceSpanResponse(**span.__dict__) for span in trace_store.spans(trace_id)]

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
