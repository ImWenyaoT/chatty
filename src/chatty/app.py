from pathlib import Path
from uuid import uuid4

from agents import Model
from agents.tracing import gen_trace_id, set_trace_processors
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field

from chatty.agent import MissingApiKeyError, model_from_env, run_agent
from chatty.store import TraceStore
from chatty.tracing import SQLiteTracingProcessor


class RunRequest(BaseModel):
    message: str = Field(min_length=1, max_length=20_000)
    session_id: str | None = Field(default=None, min_length=1, max_length=200)


class RunResponse(BaseModel):
    reply: str
    session_id: str
    trace_id: str
    status: str


class TraceResponse(BaseModel):
    trace_id: str
    session_id: str
    status: str
    summary: str
    model_id: str
    span_types: list[str]


def create_app(
    *,
    database_path: str | Path,
    model: Model | None = None,
    model_id: str | None = None,
) -> FastAPI:
    app = FastAPI(title="Chatty Agent", version="0.1.0")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://localhost:3000", "http://127.0.0.1:3000"],
        allow_methods=["GET", "POST"],
        allow_headers=["content-type"],
    )
    trace_store = TraceStore(database_path)
    set_trace_processors([SQLiteTracingProcessor(trace_store)])
    configured_model = (model, model_id or "injected-model") if model is not None else None

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.post("/runs", response_model=RunResponse)
    async def create_run(request: RunRequest) -> RunResponse:
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
            reply = await run_agent(
                message=request.message,
                session_id=session_id,
                database_path=database_path,
                model=active_model,
                model_id=active_model_id,
                trace_id=trace_id,
            )
        except Exception as error:
            trace_store.fail(trace_id)
            raise HTTPException(status_code=502, detail="llm_provider_failed") from error
        return RunResponse(
            reply=reply,
            session_id=session_id,
            trace_id=trace_id,
            status="completed",
        )

    @app.get("/traces/{trace_id}", response_model=TraceResponse)
    async def get_trace(trace_id: str) -> TraceResponse:
        trace = trace_store.get(trace_id)
        if trace is None:
            raise HTTPException(status_code=404, detail="trace_not_found")
        return TraceResponse(**trace.__dict__, span_types=trace_store.span_types(trace_id))

    return app
