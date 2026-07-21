import assert from "node:assert/strict";
import test from "node:test";
import { RunFailure } from "../src/agent-runtime.js";
import { CommerceError } from "../src/commerce.js";
import { createHttpApplication } from "../src/http-application.js";
import type { NativeRuntimePort } from "../src/runtime.js";

function nativeRuntime(
  overrides: Partial<NativeRuntimePort> = {},
): NativeRuntimePort {
  return {
    artifacts: {
      list: () => [],
      approve: () => {
        throw new Error("artifact approval not configured");
      },
    },
    commerce: {
      listOrders: () => [],
      getOrder: () => {
        throw new CommerceError("order_not_found");
      },
      statusCounts: () => ({ pending: 0, confirmed: 0, cancelled: 0 }),
    },
    knowledge: {
      importJsonl: () => 0,
      search: () => ({ status: "ok", query: "", results: [], error: null }),
    },
    memory: { search: () => [] },
    support: { listAll: () => [], get: () => null },
    traces: {
      listRecent: () => [],
      get: () => null,
      spans: () => [],
      spanTypes: () => [],
    },
    close: () => undefined,
    ...overrides,
  };
}

function request(
  method: string,
  path: string,
  input: { body?: unknown; rawBody?: string; headers?: HeadersInit } = {},
) {
  const body =
    input.rawBody ??
    (input.body === undefined ? undefined : JSON.stringify(input.body));
  return new Request(`http://chatty.local${path}`, {
    method,
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...input.headers,
    },
    body,
  });
}

async function body(response: Response) {
  return (await response.json()) as unknown;
}

test("framework-neutral health does not initialize the runtime", async () => {
  let initialized = false;
  const app = createHttpApplication({
    nativeRuntimeFactory: () => {
      initialized = true;
      return nativeRuntime();
    },
  });

  const response = await app.handle(request("GET", "/health"));

  assert.equal(response.status, 200);
  assert.deepEqual(await body(response), { status: "ok" });
  assert.equal(initialized, false);
  await app.close();
});

test("framework-neutral reads preserve store, query and not-found contracts", async () => {
  let searched: unknown[] = [];
  const app = createHttpApplication({
    customerIdentity: () => "trusted-customer",
    nativeRuntimeFactory: () =>
      nativeRuntime({
        memory: {
          search: (customerId, query, limit) => {
            searched = [customerId, query, limit];
            return [];
          },
        },
      }),
  });

  const cases = [
    ["/orders", 200, []],
    ["/orders/missing", 404, { detail: "order_not_found" }],
    ["/support-requests", 200, []],
    ["/support-requests/missing", 404, { detail: "support_request_not_found" }],
    [
      "/traces?limit=10",
      200,
      {
        traces: [],
        order_status_counts: { pending: 0, confirmed: 0, cancelled: 0 },
      },
    ],
    ["/traces/missing", 404, { detail: "trace_not_found" }],
    ["/traces/missing/spans", 404, { detail: "trace_not_found" }],
    ["/memories?limit=11", 422, { detail: "invalid_memory_limit" }],
    ["/traces?limit=0", 422, { detail: "invalid_trace_limit" }],
  ] as const;
  for (const [path, status, expected] of cases) {
    const response = await app.handle(request("GET", path));
    assert.equal(response.status, status, path);
    assert.deepEqual(await body(response), expected, path);
  }

  const memories = await app.handle(
    request("GET", "/memories?query=%E5%B0%BA%E7%A0%81&limit=5"),
  );
  assert.deepEqual(await body(memories), {
    customer_id: "trusted-customer",
    query: "尺码",
    memories: [],
  });
  assert.deepEqual(searched, ["trusted-customer", "尺码", 5]);
  await app.close();
});

test("framework-neutral runs preserve validation, identity and failure mapping", async () => {
  let observedIdentity: unknown[] = [];
  let closed = false;
  const app = createHttpApplication({
    customerIdentity: () => "trusted-customer",
    requestIdentity: () => "trusted-request",
    nativeRunFactory: () => ({
      run: async (input) => {
        observedIdentity = [input.customer_id, input.request_id];
        return {
          reply: "已收到。",
          customer_id: input.customer_id,
          session_id: "session-1",
          trace_id: "trace-1",
          request_id: input.request_id,
          status: "responded",
          business_outcome: "not_applicable",
          completion_evidence: null,
          knowledge_search_results: [],
          memory_events: [],
          needs_human: false,
          support_request_id: null,
        };
      },
      sessionMessages: async () => [{ role: "user", content: "你好" }],
      close: async () => {
        closed = true;
      },
    }),
  });

  const run = await app.handle(
    request("POST", "/runs", {
      body: {
        message: "你好",
        customer_id: "spoofed-customer",
        request_id: "spoofed-request",
      },
    }),
  );
  assert.equal(run.status, 200);
  assert.deepEqual(observedIdentity, ["trusted-customer", "trusted-request"]);
  const messages = await app.handle(
    request("GET", "/sessions/session-1/messages"),
  );
  assert.deepEqual(await body(messages), {
    session_id: "session-1",
    messages: [{ role: "user", content: "你好" }],
  });
  await app.close();
  assert.equal(closed, true);

  const validation = createHttpApplication({
    nativeRunFactory: () => ({
      run: async () => {
        throw new Error("invalid request must not run");
      },
      sessionMessages: async () => [],
      close: async () => undefined,
    }),
  });
  const missing = await validation.handle(
    request("POST", "/runs", { body: {} }),
  );
  assert.equal(missing.status, 422);
  assert.deepEqual(await body(missing), {
    detail: [
      {
        type: "missing",
        loc: ["body", "message"],
        msg: "Field required",
        input: {},
      },
    ],
  });
  const invalidJson = await validation.handle(
    request("POST", "/runs", { rawBody: "{" }),
  );
  assert.equal(invalidJson.status, 422);
  assert.deepEqual(await body(invalidJson), {
    detail: [
      {
        type: "json_invalid",
        loc: ["body", 0],
        msg: "JSON decode error",
        input: {},
        ctx: { error: "Invalid JSON" },
      },
    ],
  });
  await validation.close();

  for (const [code, status] of [
    ["session_not_found", 409],
    ["session_customer_mismatch", 409],
    ["llm_not_configured", 503],
    ["handoff_idempotency_conflict", 409],
    ["handoff_persistence_failed", 500],
    ["llm_provider_failed", 502],
  ] as const) {
    const failureApp = createHttpApplication({
      nativeRunFactory: () => ({
        run: async () => {
          throw new RunFailure(code, "trace-failure");
        },
        sessionMessages: async () => [],
        close: async () => undefined,
      }),
    });
    const response = await failureApp.handle(
      request("POST", "/runs", { body: { message: "你好" } }),
    );
    assert.equal(response.status, status, code);
    assert.equal(response.headers.get("x-trace-id"), "trace-failure", code);
    assert.deepEqual(await body(response), { detail: code }, code);
    await failureApp.close();
  }
});

test("framework-neutral metadata, method and CORS contracts stay explicit", async () => {
  const app = createHttpApplication({});

  const openapi = await app.handle(request("GET", "/openapi.json"));
  const document = (await body(openapi)) as {
    info: { title: string };
    paths: Record<string, unknown>;
    servers: Array<{ url: string }>;
  };
  assert.equal(document.info.title, "Chatty Agent");
  assert.deepEqual(document.servers, [{ url: "/api/chatty" }]);
  assert.deepEqual(Object.keys(document.paths).sort(), [
    "/artifacts",
    "/artifacts/{artifact_id}/approve",
    "/health",
    "/memories",
    "/orders",
    "/orders/{order_id}",
    "/runs",
    "/sessions/{session_id}/messages",
    "/support-requests",
    "/support-requests/{support_request_id}",
    "/traces",
    "/traces/{trace_id}",
    "/traces/{trace_id}/spans",
  ]);

  const docs = await app.handle(request("GET", "/docs"));
  assert.match(docs.headers.get("content-type") ?? "", /^text\/html/);
  assert.match(await docs.text(), /href="\/api\/chatty\/openapi\.json"/);
  const unknown = await app.handle(request("GET", "/unknown"));
  assert.equal(unknown.status, 404);
  assert.deepEqual(await body(unknown), { detail: "Not Found" });
  const wrongMethod = await app.handle(request("PUT", "/health"));
  assert.equal(wrongMethod.status, 405);
  assert.deepEqual(await body(wrongMethod), { detail: "Method Not Allowed" });
  const cors = await app.handle(
    request("OPTIONS", "/runs", {
      headers: {
        origin: "http://localhost:3000",
        "access-control-request-method": "POST",
      },
    }),
  );
  assert.equal(cors.status, 204);
  assert.equal(
    cors.headers.get("access-control-allow-origin"),
    "http://localhost:3000",
  );
  await app.close();
});

test("artifact HTTP contract scopes reads and approval to trusted identities", async () => {
  const observed: unknown[] = [];
  const runtime = nativeRuntime() as NativeRuntimePort & {
    artifacts: {
      list(ownerId: string, sessionId?: string): unknown[];
      approve(artifactId: string, actorId: string, ownerId: string): unknown;
    };
  };
  runtime.artifacts = {
    list: (ownerId, sessionId) => {
      observed.push(["list", ownerId, sessionId]);
      return [
        {
          id: "artifact-1",
          kind: "research",
          owner_id: ownerId,
          session_id: sessionId ?? "session-1",
          title: "产业研究简报",
          summary: "演示摘要",
          claims: [],
          nodes: [],
          relations: [],
          unknowns: [],
          status: "review_pending",
          created_at: "2026-07-21T00:00:00.000Z",
          updated_at: "2026-07-21T00:00:00.000Z",
        },
      ];
    },
    approve: (artifactId, actorId, ownerId) => {
      observed.push(["approve", artifactId, actorId, ownerId]);
      return {
        id: "approval-1",
        artifact_id: artifactId,
        actor_id: actorId,
        decision: "approved",
        created_at: "2026-07-21T00:00:01.000Z",
      };
    },
  };
  const app = createHttpApplication({
    customerIdentity: () => "trusted-owner",
    reviewerIdentity: () => "trusted-reviewer",
    nativeRuntimeFactory: () => runtime,
  });

  const listed = await app.handle(
    request("GET", "/artifacts?session_id=session-1"),
  );
  assert.equal(listed.status, 200);
  assert.deepEqual(await body(listed), [
    {
      id: "artifact-1",
      kind: "research",
      owner_id: "trusted-owner",
      session_id: "session-1",
      title: "产业研究简报",
      summary: "演示摘要",
      claims: [],
      nodes: [],
      relations: [],
      unknowns: [],
      status: "review_pending",
      created_at: "2026-07-21T00:00:00.000Z",
      updated_at: "2026-07-21T00:00:00.000Z",
    },
  ]);

  const approved = await app.handle(
    request("POST", "/artifacts/artifact-1/approve"),
  );
  assert.equal(approved.status, 200);
  assert.deepEqual(await body(approved), {
    id: "approval-1",
    artifact_id: "artifact-1",
    actor_id: "trusted-reviewer",
    decision: "approved",
    created_at: "2026-07-21T00:00:01.000Z",
  });
  assert.deepEqual(observed, [
    ["list", "trusted-owner", "session-1"],
    ["approve", "artifact-1", "trusted-reviewer", "trusted-owner"],
  ]);
  await app.close();
});
