import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  Usage,
  type AgentOutputItem,
  type Model,
  type ModelRequest,
  type ModelResponse,
  type StreamEvent,
} from "@openai/agents";
import type { RunResponse } from "@chatty/contracts";
import { ChattyRunModule } from "./agent-runtime.js";
import { matchEvalExpectation, readEvalCases, type EvalCase } from "./eval.js";
import { NativeRuntime } from "./runtime.js";

export type ScriptItem = EvalCase["runs"][number]["script"][number];

export class EvalModel implements Model {
  private index = 0;

  constructor(private readonly script: ScriptItem[]) {}

  async getResponse(request: ModelRequest): Promise<ModelResponse> {
    const item = this.script[this.index++];
    if (item === undefined) throw new Error("eval script exhausted");
    let output: AgentOutputItem;
    if (item.type === "tool") {
      const artifactId = latestArtifactId(request.input);
      output = {
        type: "function_call",
        callId: item.call_id,
        name: item.name,
        arguments: JSON.stringify(
          replacePlaceholder(item.arguments, artifactId),
        ),
        status: "completed",
      };
    } else {
      output = {
        type: "message",
        id: item.message_id,
        role: "assistant",
        status: "completed",
        content: [{ type: "output_text", text: item.text }],
      };
    }
    return { usage: new Usage(), output: [output] };
  }

  getStreamedResponse(): AsyncIterable<StreamEvent> {
    throw new Error("deterministic eval does not stream");
  }
}

type EvalCaseResult = {
  id: string;
  passed: boolean;
  failures: string[];
  observed: {
    status: string | null;
    business_outcome: string | null;
    completion_evidence: string | null;
    knowledge_sources: string[];
    memory_sources: string[];
    support_request_id: string | null;
    order_count: number;
    artifact_count: number;
  };
};

export async function runEval(input: {
  casesPath: string;
  outputPath: string;
  workdir: string;
  knowledgePath?: string;
}): Promise<{ passed: number; failed: number; total: number }> {
  mkdirSync(input.workdir, { recursive: true });
  const results: EvalCaseResult[] = [];
  for (const evalCase of readEvalCases(input.casesPath)) {
    const databasePath = join(input.workdir, `${evalCase.id}.sqlite`);
    resetDatabase(databasePath);
    const runtime = new NativeRuntime(databasePath);
    const module = new ChattyRunModule(runtime, {
      model: new EvalModel(evalCase.runs.flatMap((run) => run.script)),
      modelId: "deterministic-eval-model",
      knowledgePath:
        input.knowledgePath ??
        resolve(dirname(input.casesPath), "../knowledge/records.jsonl"),
    });
    const failures: string[] = [];
    const bodies: RunResponse[] = [];
    let previousSession: string | null = null;
    let orderCount = 0;
    let artifactCount = 0;
    try {
      for (const [index, run] of evalCase.runs.entries()) {
        try {
          const body = await module.run({
            message: run.message,
            session_id: run.reuse_session ? previousSession : null,
            customer_id: evalCase.customer_id,
            request_id: `eval-${evalCase.id}-${index + 1}`,
          });
          bodies.push(body);
          previousSession = body.session_id;
          orderCount = runtime.commerce.listOrders().length;
          artifactCount = runtime.artifacts.list(evalCase.customer_id).length;
          failures.push(
            ...matchEvalExpectation(body, run.expect, {
              orderCount,
              artifactCount,
            }),
          );
        } catch (error) {
          failures.push(
            `Run failed: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      const last = bodies.at(-1);
      results.push({
        id: evalCase.id,
        passed: failures.length === 0,
        failures,
        observed: {
          status: last?.status ?? null,
          business_outcome: last?.business_outcome ?? null,
          completion_evidence: last?.completion_evidence ?? null,
          knowledge_sources: bodies.flatMap((body) =>
            body.knowledge_search_results.map((record) => record.source),
          ),
          memory_sources: bodies.flatMap((body) =>
            body.memory_events.flatMap((event) =>
              event.memories.map((memory) => memory.source_id),
            ),
          ),
          support_request_id: last?.support_request_id ?? null,
          order_count: orderCount,
          artifact_count: artifactCount,
        },
      });
    } finally {
      await module.close();
      runtime.close();
    }
  }
  mkdirSync(dirname(input.outputPath), { recursive: true });
  writeFileSync(
    input.outputPath,
    results.map((result) => JSON.stringify(result)).join("\n") + "\n",
    "utf8",
  );
  const passed = results.filter((result) => result.passed).length;
  return { passed, failed: results.length - passed, total: results.length };
}

function latestArtifactId(value: unknown): string | null {
  let found: string | null = null;
  const visit = (candidate: unknown): void => {
    if (typeof candidate === "string") {
      if (candidate.startsWith("{")) {
        try {
          visit(JSON.parse(candidate) as unknown);
        } catch {
          return;
        }
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item);
      return;
    }
    if (candidate === null || typeof candidate !== "object") return;
    const record = candidate as Record<string, unknown>;
    const artifact = record.artifact;
    if (artifact !== null && typeof artifact === "object") {
      const id = (artifact as Record<string, unknown>).id;
      if (typeof id === "string") found = id;
    }
    for (const nested of Object.values(record)) visit(nested);
  };
  visit(value);
  return found;
}

function replacePlaceholder(
  value: unknown,
  artifactId: string | null,
): unknown {
  if (value === "$last_artifact_id") {
    if (artifactId === null)
      throw new Error("eval artifact placeholder missing");
    return artifactId;
  }
  if (Array.isArray(value)) {
    return value.map((item) => replacePlaceholder(item, artifactId));
  }
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, nested]) => [
      key,
      replacePlaceholder(nested, artifactId),
    ]),
  );
}

function resetDatabase(databasePath: string): void {
  for (const path of [
    databasePath,
    `${databasePath}-wal`,
    `${databasePath}-shm`,
  ]) {
    rmSync(path, { force: true });
  }
}
