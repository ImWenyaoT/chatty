import {
  ArtifactApprovalSchema,
  ArtifactSchema,
  CustomerMemorySchema,
  MemorySearchResponseSchema,
  OrderSchema,
  RunRequestSchema,
  RunResponseSchema,
  SessionMessagesResponseSchema,
  SupportRequestSchema,
  TraceDashboardSchema,
  TraceSchema,
  TraceSpanSchema,
  type RunRequest,
} from "@chatty/contracts";
import { z } from "zod";

type ValidationError = {
  type: string;
  loc: Array<string | number>;
  msg: string;
  input: unknown;
  ctx?: Record<string, number | string>;
};

function stringError(
  body: Record<string, unknown>,
  field: "message" | "session_id",
  minimum: number,
  maximum: number,
): ValidationError | null {
  if (!(field in body)) {
    return field === "message"
      ? {
          type: "missing",
          loc: ["body", field],
          msg: "Field required",
          input: body,
        }
      : null;
  }
  const value = body[field];
  if (field === "session_id" && value === null) return null;
  if (typeof value !== "string") {
    return {
      type: "string_type",
      loc: ["body", field],
      msg: "Input should be a valid string",
      input: value,
    };
  }
  if (value.length < minimum) {
    return {
      type: "string_too_short",
      loc: ["body", field],
      msg: `String should have at least ${minimum} character`,
      input: value,
      ctx: { min_length: minimum },
    };
  }
  if (value.length > maximum) {
    return {
      type: "string_too_long",
      loc: ["body", field],
      msg: `String should have at most ${maximum} characters`,
      input: value,
      ctx: { max_length: maximum },
    };
  }
  return null;
}

export function parseRunRequest(
  body: unknown,
):
  | { success: true; data: RunRequest }
  | { success: false; detail: ValidationError[] } {
  if (body === null || body === undefined) {
    return {
      success: false,
      detail: [
        { type: "missing", loc: ["body"], msg: "Field required", input: body },
      ],
    };
  }
  if (typeof body !== "object" || Array.isArray(body)) {
    return {
      success: false,
      detail: [
        {
          type: "model_attributes_type",
          loc: ["body"],
          msg: "Input should be a valid dictionary or object to extract fields from",
          input: body,
        },
      ],
    };
  }
  const object = body as Record<string, unknown>;
  const detail = [
    stringError(object, "message", 1, 20_000),
    stringError(object, "session_id", 1, 200),
  ].filter((error): error is ValidationError => error !== null);
  if (detail.length > 0) return { success: false, detail };
  return { success: true, data: RunRequestSchema.parse(object) };
}

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const value = z.toJSONSchema(schema, { target: "draft-7" }) as Record<
    string,
    unknown
  >;
  delete value.$schema;
  return value;
}

const completedRun = jsonSchema(RunResponseSchema);
if (Array.isArray(completedRun.required)) {
  completedRun.required = completedRun.required.filter(
    (field) => field !== "support_request_id",
  );
}

const response = (schema: string) => ({
  description: "Successful Response",
  content: {
    "application/json": { schema: { $ref: `#/components/schemas/${schema}` } },
  },
});

export const openApiDocument = {
  openapi: "3.1.0",
  info: { title: "Chatty Agent", version: "0.1.0" },
  servers: [{ url: "/api/chatty" }],
  paths: {
    "/health": { get: { responses: { "200": response("Health") } } },
    "/runs": {
      post: {
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RunRequest" },
            },
          },
        },
        responses: { "200": response("CompletedRun") },
      },
    },
    "/sessions/{session_id}/messages": {
      get: { responses: { "200": response("SessionMessagesResponse") } },
    },
    "/support-requests": {
      get: { responses: { "200": response("SupportRequestList") } },
    },
    "/support-requests/{support_request_id}": {
      get: { responses: { "200": response("SupportRequest") } },
    },
    "/memories": {
      get: { responses: { "200": response("MemorySearchResponse") } },
    },
    "/traces": {
      get: { responses: { "200": response("TraceDashboardResponse") } },
    },
    "/traces/{trace_id}": {
      get: { responses: { "200": response("TraceResponse") } },
    },
    "/traces/{trace_id}/spans": {
      get: { responses: { "200": response("TraceSpanList") } },
    },
    "/orders": { get: { responses: { "200": response("OrderList") } } },
    "/orders/{order_id}": {
      get: { responses: { "200": response("Order") } },
    },
    "/artifacts": {
      get: { responses: { "200": response("ArtifactList") } },
    },
    "/artifacts/{artifact_id}/approve": {
      post: { responses: { "200": response("ArtifactApproval") } },
    },
  },
  components: {
    schemas: {
      Health: {
        type: "object",
        properties: { status: { type: "string" } },
        required: ["status"],
      },
      RunRequest: jsonSchema(RunRequestSchema),
      CompletedRun: completedRun,
      SessionMessagesResponse: jsonSchema(SessionMessagesResponseSchema),
      CustomerMemory: jsonSchema(CustomerMemorySchema),
      MemorySearchResponse: jsonSchema(MemorySearchResponseSchema),
      SupportRequest: jsonSchema(SupportRequestSchema),
      SupportRequestList: {
        type: "array",
        items: { $ref: "#/components/schemas/SupportRequest" },
      },
      TraceSpanSummary: jsonSchema(TraceSpanSchema),
      TraceSpanList: {
        type: "array",
        items: { $ref: "#/components/schemas/TraceSpanSummary" },
      },
      TraceResponse: jsonSchema(TraceSchema),
      TraceDashboardResponse: jsonSchema(TraceDashboardSchema),
      Order: jsonSchema(OrderSchema),
      OrderList: {
        type: "array",
        items: { $ref: "#/components/schemas/Order" },
      },
      Artifact: jsonSchema(ArtifactSchema),
      ArtifactList: {
        type: "array",
        items: { $ref: "#/components/schemas/Artifact" },
      },
      ArtifactApproval: jsonSchema(ArtifactApprovalSchema),
    },
  },
};

export const documentationHtml = (kind: "swagger" | "redoc") => `<!doctype html>
<html lang="en"><meta charset="utf-8"><title>Chatty Agent API</title>
<body><main><h1>Chatty Agent API</h1><p>${kind} documentation</p>
<p><a href="/api/chatty/openapi.json">OpenAPI JSON</a></p></main></body></html>`;
