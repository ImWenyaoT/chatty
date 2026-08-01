import {
  RunContext,
  type FunctionTool,
  type ModelProvider,
} from "@openai/agents";
import { describe, expect, it, vi } from "vitest";

import {
  CHATTY_TOOL_NAMES,
  createChattyAgentRuntime,
  createDeepSeekProvider,
  type ChattyRunContext,
  type ChattyToolHandlers,
  type RecommendationRequest,
} from "../src/agent-sdk.js";

const request: RecommendationRequest = {
  userId: "U001",
  numItems: 2,
  context: { preferredCategories: ["耳机"], maxPriceCents: 20_000 },
};

const handlers = (): ChattyToolHandlers => ({
  getUserProfile: vi.fn(async () => ({
    model: { user_id: "U001", segment: "active" },
    evidence: { segment: "active" },
  })),
  searchProducts: vi.fn(async () => ({
    model: [{ product_id: "P001", name: "蓝牙耳机" }],
    evidence: { productIds: ["P001"] },
  })),
  checkInventory: vi.fn(async () => ({
    model: [{ product_id: "P001", stock: 8 }],
    evidence: { inStockProductIds: ["P001"] },
  })),
  retrieveKnowledge: vi.fn(async () => ({
    model: { documents: [{ content: "适合通勤" }] },
    evidence: { groundedProductIds: ["P001"] },
  })),
  getMarketingStrategy: vi.fn(async () => ({
    model: { tone: "简洁" },
    evidence: {},
  })),
});

const unusedProvider: ModelProvider = {
  async getModel() {
    throw new Error("model_should_not_be_called");
  },
};

const functionTool = (
  runtime: ReturnType<typeof createChattyAgentRuntime>,
  name: string,
): FunctionTool<ChattyRunContext> => {
  const found = runtime.agent.tools.find(
    (candidate) => candidate.name === name,
  );
  if (!found || found.type !== "function")
    throw new Error(`missing_tool:${name}`);
  return found as FunctionTool<ChattyRunContext>;
};

const runContext = (
  toolHandlers: ChattyToolHandlers,
): RunContext<ChattyRunContext> =>
  new RunContext({
    request,
    handlers: toolHandlers,
    evidence: {
      usedTools: [],
      recalledProductIds: new Set(),
      inStockProductIds: new Set(),
      groundedProductIds: new Set(),
    },
  });

describe("Chatty Agents SDK integration", () => {
  it("defines one agent with five tools and requires the first tool call", () => {
    const runtime = createChattyAgentRuntime({
      handlers: handlers(),
      modelProvider: unusedProvider,
    });

    expect(runtime.agent.tools.map(({ name }) => name)).toEqual(
      CHATTY_TOOL_NAMES,
    );
    expect(runtime.agent.handoffs).toEqual([]);
    expect(runtime.agent.modelSettings.toolChoice).toBe("required");
    expect(runtime.agent.resetToolChoice).toBe(true);
  });

  it("keeps Harness evidence out of the model-visible tool result", async () => {
    const toolHandlers = handlers();
    const runtime = createChattyAgentRuntime({
      handlers: toolHandlers,
      modelProvider: unusedProvider,
    });
    const context = runContext(toolHandlers);

    const output = await functionTool(runtime, "get_user_profile").invoke(
      context,
      "{}",
    );

    expect(JSON.parse(String(output))).toEqual({
      user_id: "U001",
      segment: "active",
    });
    expect(output).not.toContain("evidence");
    expect(context.context.evidence.profileSegment).toBe("active");
    expect(context.context.evidence.usedTools).toEqual(["get_user_profile"]);
  });

  it("enforces the profile -> search -> inventory dependency in Harness code", async () => {
    const toolHandlers = handlers();
    const runtime = createChattyAgentRuntime({
      handlers: toolHandlers,
      modelProvider: unusedProvider,
    });
    const context = runContext(toolHandlers);

    await expect(
      functionTool(runtime, "search_products").invoke(
        context,
        JSON.stringify({
          categories: ["耳机"],
          minPriceCents: 0,
          maxPriceCents: 20_000,
          tags: [],
          limit: 5,
        }),
      ),
    ).resolves.toContain("profile_not_loaded");

    await functionTool(runtime, "get_user_profile").invoke(context, "{}");
    await functionTool(runtime, "search_products").invoke(
      context,
      JSON.stringify({
        categories: ["耳机"],
        minPriceCents: 0,
        maxPriceCents: 20_000,
        tags: [],
        limit: 5,
      }),
    );
    await expect(
      functionTool(runtime, "check_inventory").invoke(
        context,
        JSON.stringify({ productIds: ["P999"] }),
      ),
    ).resolves.toContain("inventory_product_not_recalled");
  });

  it("creates an injectable Responses provider for DeepSeek", async () => {
    const provider = createDeepSeekProvider({
      apiKey: "test-only",
      baseURL: "https://example.test",
    });
    await expect(provider.getModel("deepseek-chat")).resolves.toBeDefined();
    await provider.close();
  });
});
