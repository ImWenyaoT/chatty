from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from chatty.commerce import CommerceStore
from chatty.knowledge import KnowledgeStore
from chatty.store import MemoryStore, SupportRequestStore, TraceStore
from chatty.tracing import RuntimeTracingRouter, SQLiteTracingProcessor, install_runtime_tracing


@dataclass(frozen=True)
class ChattyRuntime:
    database_path: Path
    memory_store: MemoryStore
    support_store: SupportRequestStore
    trace_store: TraceStore
    knowledge_store: KnowledgeStore
    commerce: CommerceStore
    trace_processor: SQLiteTracingProcessor
    tracing_router: RuntimeTracingRouter

    @classmethod
    def open(
        cls,
        database_path: str | Path,
        *,
        knowledge_path: str | Path | None = None,
    ) -> ChattyRuntime:
        path = Path(database_path)
        trace_store = TraceStore(path)
        trace_processor = SQLiteTracingProcessor(trace_store)
        runtime = cls(
            database_path=path,
            memory_store=MemoryStore(path),
            support_store=SupportRequestStore(path),
            trace_store=trace_store,
            knowledge_store=KnowledgeStore(path),
            commerce=CommerceStore(path),
            trace_processor=trace_processor,
            tracing_router=install_runtime_tracing(),
        )
        runtime.knowledge_store.import_jsonl(
            Path(knowledge_path)
            if knowledge_path is not None
            else Path(__file__).parents[2] / "knowledge" / "records.jsonl"
        )
        return runtime

    def begin_trace(self, trace_id: str) -> None:
        self.tracing_router.register(trace_id, self.trace_processor)

    def end_trace(self, trace_id: str) -> None:
        self.tracing_router.discard(trace_id)
