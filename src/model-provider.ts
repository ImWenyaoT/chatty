import {
  OpenAIProvider,
  type ModelProvider as AgentModelProvider,
} from "@openai/agents";
import OpenAI from "openai";

import { modelConfig } from "./config.js";

export interface ModelProvider {
  readonly modelId: string;
  readonly configured: boolean;
  readonly agentModelProvider: AgentModelProvider;
  complete(prompt: string, system?: string): Promise<string>;
  close(): Promise<void>;
}

export class MissingCredentials extends Error {
  constructor() {
    super("llm_not_configured");
  }
}

export class ResponsesModelProvider implements ModelProvider {
  readonly modelId: string;
  readonly configured: boolean;
  readonly agentModelProvider: OpenAIProvider;
  readonly #client: OpenAI;

  constructor() {
    const config = modelConfig();
    this.configured = Boolean(config.apiKey);
    this.modelId = config.model;
    this.#client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseURL,
    });
    this.agentModelProvider = new OpenAIProvider({
      apiKey: config.apiKey || "not-configured",
      baseURL: config.baseURL,
      useResponses: true,
    });
  }

  async complete(prompt: string, system?: string): Promise<string> {
    if (!this.configured) throw new MissingCredentials();
    const response = await this.#client.responses.create({
      model: this.modelId,
      instructions: system ?? null,
      input: prompt,
      reasoning: { effort: "none" },
    });
    return response.output_text;
  }

  async close(): Promise<void> {
    await this.agentModelProvider.close();
  }
}
