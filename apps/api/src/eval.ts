import { readFileSync } from "node:fs";
import { z } from "zod";
import type { RunResponse } from "@chatty/contracts";
import { chattyToolNames } from "./tools.js";

const toolScriptSchema = z
  .object({
    type: z.literal("tool"),
    call_id: z.string(),
    name: z.enum(chattyToolNames),
    arguments: z.record(z.string(), z.json()),
  })
  .strict();
const messageScriptSchema = z
  .object({
    type: z.literal("message"),
    message_id: z.string(),
    text: z.string(),
  })
  .strict();
const evalExpectationSchema = z
  .object({
    status: z.string().nullable().optional(),
    business_outcome: z.string().nullable().optional(),
    completion_evidence: z.string().nullable().optional(),
    completion_evidence_prefix: z.string().nullable().optional(),
    reply_contains: z.string().nullable().optional(),
    knowledge_sources: z.array(z.string()).nullable().optional(),
    order_count: z.number().int().nullable().optional(),
    artifact_count: z.number().int().nullable().optional(),
    memory_event_tool: z.string().nullable().optional(),
    memory_source: z.boolean().default(false),
    support_receipt: z.boolean().default(false),
  })
  .strict();
const evalRunSchema = z
  .object({
    message: z.string(),
    script: z.array(
      z.discriminatedUnion("type", [toolScriptSchema, messageScriptSchema]),
    ),
    expect: evalExpectationSchema,
    reuse_session: z.boolean().default(false),
  })
  .strict();
export const EvalCaseSchema = z
  .object({
    id: z.string(),
    customer_id: z.string().default("eval-customer"),
    runs: z.array(evalRunSchema),
  })
  .strict();

export type EvalCase = z.infer<typeof EvalCaseSchema>;
export type EvalExpectation = z.infer<typeof evalExpectationSchema>;

export function readEvalCases(path: string): EvalCase[] {
  const cases: EvalCase[] = [];
  for (const [index, line] of readFileSync(path, "utf8")
    .split(/\r?\n/)
    .entries()) {
    if (!line.trim()) continue;
    try {
      cases.push(EvalCaseSchema.parse(JSON.parse(line) as unknown));
    } catch {
      throw new Error(`invalid eval JSONL on line ${index + 1}`);
    }
  }
  return cases;
}

export function matchEvalExpectation(
  body: RunResponse,
  expect: EvalExpectation,
  observed: { orderCount: number; artifactCount: number },
): string[] {
  const failures: string[] = [];
  for (const key of [
    "status",
    "business_outcome",
    "completion_evidence",
  ] as const) {
    const expected = expect[key];
    if (expected !== undefined && expected !== null && body[key] !== expected) {
      failures.push(
        `${key}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(body[key])}`,
      );
    }
  }
  if (
    expect.completion_evidence_prefix &&
    !(body.completion_evidence ?? "").startsWith(
      expect.completion_evidence_prefix,
    )
  ) {
    failures.push(
      `completion_evidence did not start with ${JSON.stringify(expect.completion_evidence_prefix)}`,
    );
  }
  if (expect.reply_contains && !body.reply.includes(expect.reply_contains)) {
    failures.push(
      `reply did not contain ${JSON.stringify(expect.reply_contains)}`,
    );
  }
  const sources = body.knowledge_search_results.map((record) => record.source);
  if (
    expect.knowledge_sources !== undefined &&
    expect.knowledge_sources !== null &&
    JSON.stringify(sources) !== JSON.stringify(expect.knowledge_sources)
  ) {
    failures.push(
      `knowledge_sources: expected ${JSON.stringify(expect.knowledge_sources)}, got ${JSON.stringify(sources)}`,
    );
  }
  if (
    expect.order_count !== undefined &&
    expect.order_count !== null &&
    observed.orderCount !== expect.order_count
  ) {
    failures.push(
      `order_count: expected ${expect.order_count}, got ${observed.orderCount}`,
    );
  }
  if (
    expect.artifact_count !== undefined &&
    expect.artifact_count !== null &&
    observed.artifactCount !== expect.artifact_count
  ) {
    failures.push(
      `artifact_count: expected ${expect.artifact_count}, got ${observed.artifactCount}`,
    );
  }
  if (
    expect.memory_event_tool &&
    !body.memory_events.some((event) => event.tool === expect.memory_event_tool)
  ) {
    failures.push(
      `memory event ${JSON.stringify(expect.memory_event_tool)} was not observed`,
    );
  }
  if (
    expect.memory_source &&
    !body.memory_events.some((event) =>
      event.memories.some((memory) => memory.source_id),
    )
  ) {
    failures.push("Memory provenance was not observed");
  }
  if (
    expect.support_receipt &&
    !body.support_request_id?.startsWith("support_")
  ) {
    failures.push("Handoff receipt was not observed");
  }
  return failures;
}
