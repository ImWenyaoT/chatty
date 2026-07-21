import {
  setTraceProcessors,
  type Span,
  type SpanData,
  type Trace,
  type TracingProcessor,
} from "@openai/agents";
import { TraceStore } from "./stores.js";

class SQLiteTracingProcessor implements TracingProcessor {
  constructor(private readonly store: TraceStore) {}

  async onTraceStart(trace: Trace): Promise<void> {
    const modelId =
      typeof trace.metadata?.model_id === "string"
        ? trace.metadata.model_id
        : "unknown-model";
    this.store.start(
      trace.traceId,
      trace.groupId ?? "unknown-session",
      modelId,
    );
  }

  async onTraceEnd(trace: Trace): Promise<void> {
    this.store.complete(trace.traceId);
  }

  async onSpanStart(): Promise<void> {}

  async onSpanEnd(span: Span<SpanData>): Promise<void> {
    const data = span.spanData;
    const name =
      "name" in data && typeof data.name === "string" ? data.name : null;
    this.store.recordSpan({
      span_id: span.spanId,
      trace_id: span.traceId,
      parent_id: span.parentId,
      span_type: data.type,
      failed: span.error !== null,
      name,
      started_at: span.startedAt,
      ended_at: span.endedAt,
    });
  }

  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

class RuntimeTracingRouter implements TracingProcessor {
  private readonly processors = new Map<string, SQLiteTracingProcessor>();

  register(traceId: string, store: TraceStore): void {
    this.processors.set(traceId, new SQLiteTracingProcessor(store));
  }

  discard(traceId: string): void {
    this.processors.delete(traceId);
  }

  async onTraceStart(trace: Trace): Promise<void> {
    await this.processors.get(trace.traceId)?.onTraceStart(trace);
  }

  async onTraceEnd(trace: Trace): Promise<void> {
    await this.processors.get(trace.traceId)?.onTraceEnd(trace);
    this.discard(trace.traceId);
  }

  async onSpanStart(span: Span<SpanData>): Promise<void> {
    await this.processors.get(span.traceId)?.onSpanStart();
  }

  async onSpanEnd(span: Span<SpanData>): Promise<void> {
    await this.processors.get(span.traceId)?.onSpanEnd(span);
  }

  async shutdown(): Promise<void> {
    this.processors.clear();
  }

  async forceFlush(): Promise<void> {
    await Promise.all(
      [...new Set(this.processors.values())].map((processor) =>
        processor.forceFlush(),
      ),
    );
  }
}

const runtimeTracingRouter = new RuntimeTracingRouter();
let installed = false;

export function installRuntimeTracing(): RuntimeTracingRouter {
  if (!installed) {
    setTraceProcessors([runtimeTracingRouter]);
    installed = true;
  }
  return runtimeTracingRouter;
}
