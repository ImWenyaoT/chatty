import { rmSync } from "node:fs";
import { ChattyRunModule } from "./agent-runtime.js";
import { EvalModel, type ScriptItem } from "./eval-runner.js";
import {
  createHttpApplication,
  type HttpApplicationOptions,
} from "./http-application.js";
import { NativeRuntime } from "./runtime.js";

const script: ScriptItem[] = [
  {
    type: "tool",
    call_id: "browser-smoke-search",
    name: "search_knowledge",
    arguments: {
      query: "高精地图 智能驾驶",
      limit: 1,
    },
  },
  {
    type: "tool",
    call_id: "browser-smoke-research",
    name: "save_research_artifact",
    arguments: {
      idempotency_key: "browser-smoke-research",
      title: "高精地图产业研究简报",
      summary: "基于本地演示资料整理。",
      claims: [
        {
          id: "claim-position",
          text: "高精地图连接定位、地图更新与智能驾驶应用。",
          source_ids: ["demo-industry-map"],
        },
      ],
      nodes: [],
      relations: [],
      unknowns: ["演示资料不包含实时市场规模"],
    },
  },
  {
    type: "tool",
    call_id: "browser-smoke-content",
    name: "save_content_artifact",
    arguments: {
      idempotency_key: "browser-smoke-content",
      research_artifact_id: "$last_artifact_id",
      title: "高精地图内容包",
      channels: [
        {
          channel: "xiaohongshu",
          title: "高精地图如何支持智能驾驶",
          body: "从定位与地图更新理解产业链。",
          claim_ids: ["claim-position"],
        },
      ],
    },
  },
  {
    type: "message",
    message_id: "browser-smoke-message",
    text: "研究简报和内容草稿已保存，等待人工批准。来源：demo://industry/high-definition-map",
  },
  {
    type: "tool",
    call_id: "browser-smoke-export",
    name: "export_artifact",
    arguments: {
      artifact_id: "$last_artifact_id",
      target: "sandbox",
    },
  },
  {
    type: "message",
    message_id: "browser-smoke-follow-up",
    text: "内容包已导出到 sandbox，并生成 delivery receipt。来源：demo://industry/high-definition-map",
  },
];

export function createBrowserSmokeDependencies(input: {
  databasePath: string;
  knowledgePath: string;
}): Required<
  Pick<
    HttpApplicationOptions,
    | "nativeRuntimeFactory"
    | "nativeRunFactory"
    | "customerIdentity"
    | "reviewerIdentity"
    | "requestIdentity"
  >
> {
  for (const path of [
    input.databasePath,
    `${input.databasePath}-wal`,
    `${input.databasePath}-shm`,
  ]) {
    rmSync(path, { force: true });
  }

  const runtime = new NativeRuntime(input.databasePath);
  const runModule = new ChattyRunModule(runtime, {
    model: new EvalModel(script),
    modelId: "browser-smoke-model",
    knowledgePath: input.knowledgePath,
  });
  return {
    nativeRuntimeFactory: () => runtime,
    nativeRunFactory: () => runModule,
    customerIdentity: () => "browser-smoke-customer",
    reviewerIdentity: () => "browser-smoke-reviewer",
    requestIdentity: () => "browser-smoke-request",
  };
}

export function createBrowserSmokeHttpApplication(input: {
  databasePath: string;
  knowledgePath: string;
}) {
  return createHttpApplication(createBrowserSmokeDependencies(input));
}
