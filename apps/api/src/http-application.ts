import { type RunResponse, type Trace } from "@chatty/contracts";
import { RunFailure } from "./agent-runtime.js";
import { ArtifactNotFoundError, ArtifactStateError } from "./artifacts.js";
import { CommerceError } from "./commerce.js";
import {
  documentationHtml,
  openApiDocument,
  parseRunRequest,
} from "./http-contract.js";
import type { NativeRuntimePort } from "./runtime.js";
import type { TraceSummary } from "./stores.js";

export type HttpApplicationOptions = {
  nativeRuntimeFactory?: () => NativeRuntimePort;
  nativeRunFactory?: () => {
    run(input: {
      message: string;
      session_id?: string | null;
      customer_id: string;
      request_id: string;
    }): Promise<RunResponse>;
    sessionMessages(
      sessionId: string,
      customerId: string,
    ): Promise<Record<string, unknown>[]>;
    close(): Promise<void>;
  };
  customerIdentity?: () => string;
  reviewerIdentity?: () => string;
  requestIdentity?: () => string;
};

type SearchQuery = { query?: string; limit?: string };

const ALLOWED_ORIGINS = new Set([
  "http://localhost:3000",
  "http://127.0.0.1:3000",
]);

const EXACT_PATHS = new Set([
  "/health",
  "/runs",
  "/artifacts",
  "/orders",
  "/memories",
  "/support-requests",
  "/traces",
  "/openapi.json",
  "/docs",
  "/redoc",
]);

function parsedLimit(value: string | undefined, fallback: number) {
  if (value === undefined) return fallback;
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : null;
}

function traceResponse(
  trace: TraceSummary,
  runtime: NativeRuntimePort,
  includeSpans = false,
): Trace {
  return {
    ...trace,
    span_types: runtime.traces.spanTypes(trace.trace_id),
    spans: includeSpans ? runtime.traces.spans(trace.trace_id) : [],
  };
}

function knownPath(path: string): boolean {
  return (
    EXACT_PATHS.has(path) ||
    /^\/orders\/[^/]+$/.test(path) ||
    /^\/artifacts\/[^/]+\/approve$/.test(path) ||
    /^\/support-requests\/[^/]+$/.test(path) ||
    /^\/traces\/[^/]+(?:\/spans)?$/.test(path) ||
    /^\/sessions\/[^/]+\/messages$/.test(path)
  );
}

function corsHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("origin");
  if (origin === null || !ALLOWED_ORIGINS.has(origin)) return {};
  return {
    "access-control-allow-origin": origin,
    vary: "Origin",
  };
}

function json(
  request: Request,
  body: unknown,
  status = 200,
  headers?: HeadersInit,
) {
  return Response.json(body, {
    status,
    headers: { ...corsHeaders(request), ...headers },
  });
}

async function runBody(
  request: Request,
): Promise<
  { success: true; body: unknown } | { success: false; response: Response }
> {
  const text = await request.text();
  if (text.trim() === "") return { success: true, body: undefined };
  try {
    return { success: true, body: JSON.parse(text) as unknown };
  } catch {
    return {
      success: false,
      response: json(
        request,
        {
          detail: [
            {
              type: "json_invalid",
              loc: ["body", 0],
              msg: "JSON decode error",
              input: {},
              ctx: { error: "Invalid JSON" },
            },
          ],
        },
        422,
      ),
    };
  }
}

export function createHttpApplication(options: HttpApplicationOptions) {
  let nativeRuntime: NativeRuntimePort | undefined;
  let nativeRun:
    | ReturnType<NonNullable<HttpApplicationOptions["nativeRunFactory"]>>
    | undefined;
  const runtime = () =>
    (nativeRuntime ??= options.nativeRuntimeFactory?.() as NativeRuntimePort);
  const runs = () =>
    (nativeRun ??= options.nativeRunFactory?.() as NonNullable<
      typeof nativeRun
    >);
  const customerIdentity = options.customerIdentity ?? (() => "demo-customer");

  async function handle(
    request: Request,
    pathname = new URL(request.url).pathname,
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = pathname;

    if (request.method === "OPTIONS" && knownPath(path)) {
      return new Response(null, {
        status: 204,
        headers: {
          ...corsHeaders(request),
          "access-control-allow-methods": "GET, POST",
          "access-control-allow-headers": "content-type",
        },
      });
    }

    if (request.method === "GET" && path === "/health") {
      return json(request, { status: "ok" });
    }
    if (request.method === "GET" && path === "/openapi.json") {
      return json(request, openApiDocument);
    }
    if (request.method === "GET" && (path === "/docs" || path === "/redoc")) {
      return new Response(
        documentationHtml(path === "/docs" ? "swagger" : "redoc"),
        {
          headers: {
            ...corsHeaders(request),
            "content-type": "text/html; charset=utf-8",
          },
        },
      );
    }

    if (request.method === "POST" && path === "/runs") {
      const decoded = await runBody(request);
      if (!decoded.success) return decoded.response;
      const parsed = parseRunRequest(decoded.body);
      if (!parsed.success) return json(request, { detail: parsed.detail }, 422);
      try {
        return json(
          request,
          await runs().run({
            ...parsed.data,
            customer_id: customerIdentity(),
            request_id:
              options.requestIdentity?.() ??
              `request_${crypto.randomUUID().replaceAll("-", "")}`,
          }),
        );
      } catch (error) {
        if (!(error instanceof RunFailure)) throw error;
        const status = {
          session_not_found: 409,
          session_customer_mismatch: 409,
          llm_not_configured: 503,
          handoff_idempotency_conflict: 409,
          handoff_persistence_failed: 500,
          llm_provider_failed: 502,
        }[error.code];
        if (status === undefined) throw error;
        return json(
          request,
          { detail: error.code },
          status,
          error.traceId === null ? undefined : { "x-trace-id": error.traceId },
        );
      }
    }

    const sessionMatch = path.match(/^\/sessions\/([^/]+)\/messages$/);
    if (request.method === "GET" && sessionMatch !== null) {
      const sessionId = decodeURIComponent(sessionMatch[1]);
      try {
        return json(request, {
          session_id: sessionId,
          messages: await runs().sessionMessages(sessionId, customerIdentity()),
        });
      } catch (error) {
        if (!(error instanceof RunFailure)) throw error;
        const status =
          error.code === "session_not_found"
            ? 404
            : error.code === "session_customer_mismatch"
              ? 409
              : null;
        if (status === null) throw error;
        return json(request, { detail: error.code }, status);
      }
    }

    if (request.method === "GET" && path === "/orders") {
      return json(request, runtime().commerce.listOrders());
    }

    if (request.method === "GET" && path === "/artifacts") {
      const sessionId = url.searchParams.get("session_id") ?? undefined;
      return json(
        request,
        runtime().artifacts.list(customerIdentity(), sessionId),
      );
    }
    const approvalMatch = path.match(/^\/artifacts\/([^/]+)\/approve$/);
    if (request.method === "POST" && approvalMatch !== null) {
      try {
        return json(
          request,
          runtime().artifacts.approve(
            decodeURIComponent(approvalMatch[1]),
            options.reviewerIdentity?.() ?? "demo-reviewer",
            customerIdentity(),
          ),
        );
      } catch (error) {
        if (error instanceof ArtifactNotFoundError) {
          return json(request, { detail: "artifact_not_found" }, 404);
        }
        if (error instanceof ArtifactStateError) {
          return json(request, { detail: error.code }, 409);
        }
        throw error;
      }
    }
    const orderMatch = path.match(/^\/orders\/([^/]+)$/);
    if (request.method === "GET" && orderMatch !== null) {
      try {
        return json(
          request,
          runtime().commerce.getOrder(decodeURIComponent(orderMatch[1])),
        );
      } catch (error) {
        if (
          error instanceof CommerceError &&
          error.code === "order_not_found"
        ) {
          return json(request, { detail: "order_not_found" }, 404);
        }
        throw error;
      }
    }

    if (request.method === "GET" && path === "/memories") {
      const query: SearchQuery = {
        query: url.searchParams.get("query") ?? undefined,
        limit: url.searchParams.get("limit") ?? undefined,
      };
      const limit = parsedLimit(query.limit, 10);
      if (limit === null || limit < 1 || limit > 10) {
        return json(request, { detail: "invalid_memory_limit" }, 422);
      }
      const customerId = customerIdentity();
      return json(request, {
        customer_id: customerId,
        query: query.query ?? "",
        memories: runtime().memory.search(customerId, query.query ?? "", limit),
      });
    }

    if (request.method === "GET" && path === "/support-requests") {
      return json(request, runtime().support.listAll());
    }
    const supportMatch = path.match(/^\/support-requests\/([^/]+)$/);
    if (request.method === "GET" && supportMatch !== null) {
      const supportRequest = runtime().support.get(
        decodeURIComponent(supportMatch[1]),
      );
      return supportRequest === null
        ? json(request, { detail: "support_request_not_found" }, 404)
        : json(request, supportRequest);
    }

    if (request.method === "GET" && path === "/traces") {
      const limit = parsedLimit(url.searchParams.get("limit") ?? undefined, 50);
      if (limit === null || limit < 1 || limit > 100) {
        return json(request, { detail: "invalid_trace_limit" }, 422);
      }
      const activeRuntime = runtime();
      return json(request, {
        traces: activeRuntime.traces
          .listRecent(limit)
          .map((trace) => traceResponse(trace, activeRuntime)),
        order_status_counts: activeRuntime.commerce.statusCounts(),
      });
    }

    const spansMatch = path.match(/^\/traces\/([^/]+)\/spans$/);
    if (request.method === "GET" && spansMatch !== null) {
      const activeRuntime = runtime();
      const traceId = decodeURIComponent(spansMatch[1]);
      if (activeRuntime.traces.get(traceId) === null) {
        return json(request, { detail: "trace_not_found" }, 404);
      }
      return json(request, activeRuntime.traces.spans(traceId));
    }
    const traceMatch = path.match(/^\/traces\/([^/]+)$/);
    if (request.method === "GET" && traceMatch !== null) {
      const activeRuntime = runtime();
      const trace = activeRuntime.traces.get(decodeURIComponent(traceMatch[1]));
      return trace === null
        ? json(request, { detail: "trace_not_found" }, 404)
        : json(request, traceResponse(trace, activeRuntime, true));
    }

    return knownPath(path)
      ? json(request, { detail: "Method Not Allowed" }, 405)
      : json(request, { detail: "Not Found" }, 404);
  }

  return {
    handle,
    async close() {
      await nativeRun?.close();
      nativeRuntime?.close();
    },
  };
}
