from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, cast
from uuid import uuid4

from agents import Model, SQLiteSession
from agents.tracing import gen_trace_id

from chatty.agent import (
    MissingApiKeyError,
    model_from_env,
    run_agent,
)
from chatty.harness import (
    AgentContext,
    AgentRunResult,
    HandoffIdempotencyConflictError,
    HandoffPersistenceError,
    persist_agent_failure,
)
from chatty.runtime import ChattyRuntime
from chatty.store import (
    SessionCustomerMismatchError,
    SessionNotFoundError,
)


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
        database_path: str | Path | None = None,
        model: Model | None = None,
        model_id: str | None = None,
        knowledge_path: str | Path | None = None,
        runtime: ChattyRuntime | None = None,
    ) -> None:
        if runtime is not None:
            if database_path is not None or knowledge_path is not None:
                raise ValueError("runtime owns database and knowledge paths")
            self.runtime = runtime
        else:
            if database_path is None:
                raise ValueError("database_path is required without runtime")
            self.runtime = ChattyRuntime.open(
                database_path,
                knowledge_path=knowledge_path,
            )
        self._database_path = self.runtime.database_path
        self._model = (model, model_id or "injected-model") if model is not None else None

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

        self.runtime.begin_trace(trace_id)
        try:
            context = AgentContext(
                customer_id=run_input.customer_id,
                session_id=session_id,
                commerce=self.runtime.commerce,
                message=run_input.message,
                trace_id=trace_id,
                request_id=run_input.request_id,
                memory_store=self.runtime.memory_store,
                support_store=self.runtime.support_store,
                trace_store=self.runtime.trace_store,
            )
            context.memory_store.bind_session(
                session_id=session_id,
                customer_id=run_input.customer_id,
            )
            result = await run_agent(
                model=model,
                model_id=model_id,
                context=context,
                knowledge_store=self.runtime.knowledge_store,
            )
        except SessionCustomerMismatchError as error:
            raise RunFailure("session_customer_mismatch") from error
        except HandoffIdempotencyConflictError as error:
            persist_agent_failure(
                self.runtime.trace_store,
                trace_id,
                "handoff_idempotency_conflict",
            )
            raise RunFailure("handoff_idempotency_conflict", trace_id=trace_id) from error
        except HandoffPersistenceError as error:
            persist_agent_failure(
                self.runtime.trace_store,
                trace_id,
                "handoff_persistence_failed",
            )
            raise RunFailure("handoff_persistence_failed", trace_id=trace_id) from error
        except Exception as error:
            persist_agent_failure(
                self.runtime.trace_store,
                trace_id,
                "llm_provider_failed",
            )
            raise RunFailure("llm_provider_failed", trace_id=trace_id) from error
        finally:
            self.runtime.end_trace(trace_id)

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
            self.runtime.memory_store.require_session(
                session_id=session_id,
                customer_id=customer_id,
            )
        except SessionNotFoundError as error:
            raise RunFailure("session_not_found") from error
        except SessionCustomerMismatchError as error:
            raise RunFailure("session_customer_mismatch") from error
