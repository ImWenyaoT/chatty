import { performance } from "node:perf_hooks";

import type { AgentInputItem } from "@openai/agents";

import {
  createChattyAgentRuntime,
  type ChattyToolHandlers,
} from "./agent-sdk.js";
import { Catalog, CatalogError } from "./catalog.js";
import {
  MissingCredentials,
  ResponsesModelProvider,
  type ModelProvider,
} from "./model-provider.js";
import {
  createEvidence,
  guardRepeatedCall,
  EvidenceError,
  snapshotEvidence,
  validateRecommendationEvidence,
} from "./tools.js";
import type {
  AgentDraft,
  InputItem,
  RecommendationRequest,
  RecommendationResponse,
  Reply,
} from "./types.js";

export class RecommendationError extends Error {
  constructor(
    readonly code: string,
    readonly diagnostics: Record<string, unknown> = {},
  ) {
    super(code);
  }
}

const requestId = (): string =>
  `request_${crypto.randomUUID().replaceAll("-", "")}`;

export function parseDraft(raw: string): AgentDraft {
  const block = raw.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/iu)?.[1];
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  for (const candidate of [
    block,
    start >= 0 && end > start ? raw.slice(start, end + 1) : undefined,
    raw,
  ]) {
    if (!candidate) continue;
    try {
      const value = JSON.parse(candidate) as AgentDraft;
      if (value.action === "clarify" && typeof value.question === "string")
        return value;
      if (value.action === "recommend" && value.recommendations?.length)
        return value;
    } catch {
      /* 试下一个候选 */
    }
  }
  throw new Error("invalid_draft");
}

export class Recommender {
  readonly provider: ModelProvider;
  readonly #ownsProvider: boolean;

  constructor(
    readonly catalog: Catalog,
    provider?: ModelProvider,
  ) {
    this.provider = provider ?? new ResponsesModelProvider();
    this.#ownsProvider = provider === undefined;
  }

  get modelId(): string {
    return this.provider.modelId;
  }
  async close(): Promise<void> {
    if (this.#ownsProvider) await this.provider.close();
  }

  async recommend(
    request: RecommendationRequest,
  ): Promise<RecommendationResponse> {
    const reply = await this.#run(request, [], false);
    if ("question" in reply)
      throw new RecommendationError("clarification_needed");
    return reply;
  }

  async respond(
    request: RecommendationRequest,
    history: InputItem[] = [],
  ): Promise<Reply> {
    return this.#run(request, history, true);
  }

  async #run(
    request: RecommendationRequest,
    history: InputItem[],
    allowClarify: boolean,
  ): Promise<Reply> {
    const started = performance.now();
    if (!this.provider.configured)
      throw new RecommendationError("llm_not_configured");
    const evidence = createEvidence();
    const handlers: ChattyToolHandlers = {
      getUserProfile: async () => {
        const profile = this.catalog.userProfile(
          request.user_id,
          request.context,
        );
        return { model: profile, evidence: { profile } };
      },
      searchProducts: async (_sdkRequest, input) => {
        if (!evidence.profile) throw new Error("profile_not_loaded");
        guardRepeatedCall(evidence, "search_products", JSON.stringify(input));
        const products = this.catalog.search({
          profile: evidence.profile,
          categories: input.categories,
          min_price_cents: input.minPriceCents,
          max_price_cents: input.maxPriceCents,
          tags: input.tags,
          limit: input.limit,
        });
        return {
          model: products,
          evidence: { products },
        };
      },
      checkInventory: async (_sdkRequest, input) => {
        const products = this.catalog.inventory(input.productIds);
        return {
          model: products.map(({ product_id, stock }) => ({
            product_id,
            stock,
            low_stock: stock <= 100,
          })),
          evidence: { products },
        };
      },
      retrieveKnowledge: async (_sdkRequest, input) => {
        guardRepeatedCall(
          evidence,
          "retrieve_knowledge",
          JSON.stringify(input),
        );
        const hits = this.catalog.retrieveKnowledge({
          query: input.query,
          categories: input.categories,
          product_ids: input.productIds,
          limit: input.limit,
        });
        const groundedProducts = this.catalog.inventory(input.productIds);
        return {
          model: hits,
          evidence: { hits, groundedProducts },
        };
      },
      getMarketingStrategy: async (_sdkRequest, input) => {
        const strategy = this.catalog.marketingStrategy(input.segment);
        return { model: strategy, evidence: {} };
      },
    };
    const runtime = createChattyAgentRuntime({
      handlers,
      model: this.provider.modelId,
      modelProvider: this.provider.agentModelProvider,
      maxTurns: allowClarify ? 18 : 10,
    });
    try {
      const sdkRequest = {
        userId: request.user_id,
        numItems: request.num_items ?? 5,
        context: {
          preferredCategories: request.context?.preferred_categories ?? [],
          ...(request.context?.min_price_cents === undefined
            ? {}
            : { minPriceCents: request.context.min_price_cents }),
          ...(request.context?.max_price_cents === undefined
            ? {}
            : { maxPriceCents: request.context.max_price_cents }),
        },
      };
      const input = [
        ...history,
        { role: "user", content: JSON.stringify(request) },
      ] as AgentInputItem[];
      const result = await runtime.run(input, sdkRequest, evidence);
      const draft = parseDraft(result.output);
      if (draft.action === "clarify") {
        if (!allowClarify || evidence.inStockProductIds.size)
          throw new RecommendationError("invalid_recommendation");
        return {
          request_id: requestId(),
          user_id: request.user_id,
          question: draft.question,
          total_latency_ms: performance.now() - started,
        };
      }
      validateRecommendationEvidence(evidence, draft.recommendations);
      if (!evidence.profile)
        throw new RecommendationError("profile_not_loaded");
      return {
        request_id: requestId(),
        user_id: request.user_id,
        products: this.catalog.finalize(
          draft.recommendations,
          request,
          evidence.profile,
        ),
        total_latency_ms: performance.now() - started,
      };
    } catch (error) {
      const diagnostics = {
        evidence: snapshotEvidence(evidence),
        cause: error instanceof Error ? error.message : String(error),
      };
      if (error instanceof RecommendationError)
        throw new RecommendationError(error.code, {
          ...diagnostics,
          ...error.diagnostics,
        });
      if (error instanceof MissingCredentials)
        throw new RecommendationError("llm_not_configured", diagnostics);
      if (error instanceof EvidenceError)
        throw new RecommendationError(error.code, {
          ...diagnostics,
          missing: error.missing,
        });
      if (error instanceof CatalogError)
        throw new RecommendationError("invalid_recommendation", diagnostics);
      if (
        error instanceof Error &&
        "code" in error &&
        typeof error.code === "string"
      )
        throw new RecommendationError(error.code, diagnostics);
      throw new RecommendationError("recommendation_failed", diagnostics);
    } finally {
      await runtime.close();
    }
  }
}
