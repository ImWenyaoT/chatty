from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast
from uuid import uuid4

from agents import Model, SQLiteSession
from agents.tracing import gen_trace_id, set_trace_processors

from chatty.agent import (
    AgentRunResult,
    HandoffIdempotencyConflictError,
    HandoffPersistenceError,
    MissingApiKeyError,
    model_from_env,
    run_agent,
)
from chatty.commerce import CommerceStore
from chatty.knowledge import KnowledgeStore
from chatty.store import (
    MemoryStore,
    SessionCustomerMismatchError,
    SessionNotFoundError,
    SupportRequestStore,
    TraceStore,
)
from chatty.tracing import SQLiteTracingProcessor


@dataclass(frozen=True)
class RunInput:
    message: str
    customer_id: str
    request_id: str
    session_id: str | None = None


@dataclass(frozen=True)
class CompletedRun(AgentRunResult):
    customer_id: str
    session_id: str
    trace_id: str
    status: str
    request_id: str
    needs_human: bool
    support_request_id: str | None = field(default=None, kw_only=True)


class RunFailure(RuntimeError):
    def __init__(self, code: str, *, trace_id: str | None = None) -> None:
        super().__init__(code)
        self.code = code
        self.trace_id = trace_id


class ChattyRunModule:
    def __init__(
        self,
        *,
        database_path: str | Path,
        model: Model | None = None,
        model_id: str | None = None,
        knowledge_path: str | Path | None = None,
    ) -> None:
        self._database_path = Path(database_path)
        self._model = (model, model_id or "injected-model") if model is not None else None
        self._memory_store = MemoryStore(database_path)
        self._support_store = SupportRequestStore(database_path)
        self._trace_store = TraceStore(database_path)
        self._knowledge_store = KnowledgeStore(database_path)
        self._commerce = CommerceStore(database_path)
        self._knowledge_store.import_jsonl(
            Path(knowledge_path)
            if knowledge_path is not None
            else Path(__file__).parents[2] / "knowledge" / "records.jsonl"
        )
        set_trace_processors([SQLiteTracingProcessor(self._trace_store)])

    async def run(self, run_input: RunInput) -> CompletedRun:
        session_id = run_input.session_id or f"session_{uuid4().hex}"
        if run_input.session_id is not None:
            self._require_session(session_id=session_id, customer_id=run_input.customer_id)
        trace_id = gen_trace_id()
        try:
            if self._model is None:
                self._model = model_from_env()
            model, model_id = self._model
        except MissingApiKeyError as error:
            raise RunFailure("llm_not_configured") from error

        try:
            result = await run_agent(
                message=run_input.message,
                session_id=session_id,
                database_path=self._database_path,
                model=model,
                model_id=model_id,
                trace_id=trace_id,
                request_id=run_input.request_id,
                knowledge_store=self._knowledge_store,
                customer_id=run_input.customer_id,
                commerce=self._commerce,
                support_store=self._support_store,
                trace_store=self._trace_store,
            )
        except SessionCustomerMismatchError as error:
            raise RunFailure("session_customer_mismatch") from error
        except HandoffIdempotencyConflictError as error:
            self._fail(trace_id, "handoff_idempotency_conflict")
            raise RunFailure("handoff_idempotency_conflict", trace_id=trace_id) from error
        except HandoffPersistenceError as error:
            self._fail(trace_id, "handoff_persistence_failed")
            raise RunFailure("handoff_persistence_failed", trace_id=trace_id) from error
        except Exception as error:
            self._fail(trace_id, "llm_provider_failed")
            raise RunFailure("llm_provider_failed", trace_id=trace_id) from error

        self._trace_store.record_outcome(
            trace_id,
            business_outcome=result.business_outcome,
            completion_evidence=result.completion_evidence,
            knowledge_sources=[item.source for item in result.knowledge_search_results],
            memory_sources=[
                memory.source_id for event in result.memory_events for memory in event.memories
            ],
            support_request_id=result.support_request_id,
        )
        needs_human = result.support_request_id is not None
        status = (
            "needs_human"
            if needs_human
            else {
                "verified": "completed",
                "not_completed": "not_completed",
                "not_applicable": "responded",
            }[result.business_outcome]
        )
        return CompletedRun(
            **result.__dict__,
            customer_id=run_input.customer_id,
            session_id=session_id,
            trace_id=trace_id,
            status=status,
            request_id=run_input.request_id,
            needs_human=needs_human,
        )

    async def session_messages(self, *, session_id: str, customer_id: str) -> list[dict[str, Any]]:
        self._require_session(session_id=session_id, customer_id=customer_id)
        session = SQLiteSession(
            session_id,
            db_path=self._database_path,
            sessions_table="chatty_sessions",
            messages_table="chatty_messages",
        )
        try:
            return cast(list[dict[str, Any]], await session.get_items())
        finally:
            session.close()

    def _require_session(self, *, session_id: str, customer_id: str) -> None:
        try:
            self._memory_store.require_session(session_id=session_id, customer_id=customer_id)
        except SessionNotFoundError as error:
            raise RunFailure("session_not_found") from error
        except SessionCustomerMismatchError as error:
            raise RunFailure("session_customer_mismatch") from error

    def _fail(self, trace_id: str, code: str) -> None:
        self._trace_store.record_error(trace_id, code=code)
        self._trace_store.fail(trace_id)
