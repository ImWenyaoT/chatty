import {
  type Model,
  OpenAIResponsesModel,
  setTracingDisabled,
} from "@openai/agents";
import OpenAI from "openai";

import { loadSettings, type Settings } from "./settings.ts";

export class MissingCredentialsError extends Error {}

/** Agent 层只需要“用哪个 Model”和“凭据是否齐全”，因此依赖这个接口而非具体实现。 */
export type ModelProvider = {
  readonly agentModel: Model;
  readonly configured: boolean;
  readonly modelId: string;
};

/** Task Framer 和主 Agent Loop 共用同一个 DeepSeek Responses 客户端。 */
export class ResponsesModelProvider implements ModelProvider {
  readonly modelId: string;
  readonly configured: boolean;
  readonly agentModel: Model;

  constructor(settings: Settings = loadSettings()) {
    this.modelId = settings.model;
    this.configured = Boolean(settings.apiKey);
    const client = new OpenAI({
      apiKey: settings.apiKey || "not-configured",
      baseURL: settings.baseUrl,
    });
    this.agentModel = new OpenAIResponsesModel(client, this.modelId);
    // DeepSeek 不接收 OpenAI trace，因此关闭 SDK 默认 tracing。
    setTracingDisabled(true);
  }
}
