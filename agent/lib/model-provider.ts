import {
  type Model,
  OpenAIResponsesModel,
  setTracingDisabled,
} from "@openai/agents";
import OpenAI from "openai";

/**
 * Agent 层需要的凭据形状。
 *
 * 这里刻意不 import 应用层的 `lib/settings.ts`：那份 `Settings` 还带着与 Agent 无关的字段，
 * 而 `agent/` 不该依赖应用层。调用方传进来的对象只要结构上满足这三个字段即可。
 */
export type ModelCredentials = {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly model: string;
};

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

  constructor(credentials: ModelCredentials) {
    this.modelId = credentials.model;
    this.configured = Boolean(credentials.apiKey);
    const client = new OpenAI({
      apiKey: credentials.apiKey || "not-configured",
      baseURL: credentials.baseUrl,
    });
    this.agentModel = new OpenAIResponsesModel(client, this.modelId);
    // DeepSeek 不接收 OpenAI trace，因此关闭 SDK 默认 tracing。
    setTracingDisabled(true);
  }
}
