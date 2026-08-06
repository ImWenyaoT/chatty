/**
 * Agent 端到端评测：每个 case 跑一整轮真实对话，校验动作类型、商品字段与知识要点。
 * 需要真实凭据，因此不进 CI 单测，只作为手动/定时评测入口。
 */

import {
  Chatty,
  createChattyContext,
  ChattyError,
} from "../agent/lib/chatty.ts";
import { Catalog } from "../data/catalog.ts";
import type { Product, Reply } from "../data/models.ts";
import { ResponsesModelProvider } from "../agent/lib/model-provider.ts";
import { loadSettings } from "../server/settings.ts";
import { round } from "../data/round.ts";
import type { EvalDefinition, EvalResult } from "./lib/runner.ts";

export type AgentCase = {
  name: string;
  userId: string;
  userText: string;
  expectedAction: Reply["kind"];
  expectedCategory?: string;
  maxPriceCents?: number;
  forbiddenProductIds?: string[];
  expectedAnswerTerms?: string[];
};

export const CASES: AgentCase[] = [
  {
    name: "200 元耳机没有可售候选",
    userId: "user_budget",
    userText: "请推荐 200 元以内的耳机",
    expectedAction: "clarify",
    maxPriceCents: 20_000,
  },
  {
    name: "300 元耳机可以推荐",
    userId: "user_budget",
    userText: "请推荐 300 元以内的耳机",
    expectedAction: "recommend",
    expectedCategory: "耳机",
    maxPriceCents: 30_000,
  },
  {
    name: "本轮手机需求覆盖历史画像",
    userId: "user_active",
    userText: "请推荐 1500 元以内的手机",
    expectedAction: "recommend",
    expectedCategory: "手机",
    maxPriceCents: 150_000,
  },
  {
    name: "有可售替代时不会推荐售罄商品",
    userId: "user_vip",
    userText: "请推荐 3000 元以内的数码产品",
    expectedAction: "recommend",
    expectedCategory: "数码",
    maxPriceCents: 300_000,
    forbiddenProductIds: ["P015"],
  },
  {
    name: "价格敏感用户可以买配件",
    userId: "user_budget",
    userText: "请推荐 150 元以内的配件",
    expectedAction: "recommend",
    expectedCategory: "配件",
    maxPriceCents: 15_000,
  },
  {
    name: "配送政策问答",
    userId: "user_budget",
    userText: "你们使用哪家快递公司？",
    expectedAction: "answer",
    expectedAnswerTerms: ["合作快递", "订单"],
  },
  {
    name: "商品推荐与退货政策混合请求",
    userId: "user_budget",
    userText: "推荐 300 元以内的耳机，并告诉我七天无理由退货条件",
    expectedAction: "recommend",
    expectedCategory: "耳机",
    maxPriceCents: 30_000,
    expectedAnswerTerms: ["七天", "完好"],
  },
];

export function answerContains(
  reply: Reply,
  expectedTerms: string[] = [],
): boolean {
  const answer = reply.answer ?? "";
  return expectedTerms.every((term) => answer.includes(term));
}

/** 推荐里的商品字段必须与 SQLite 完全一致，模型不得自行编造或改写。 */
function productsValid(
  testCase: AgentCase,
  reply: Reply,
  productsById: Map<string, Product>,
) {
  if (reply.kind !== "recommend") return true;
  if (reply.products.length === 0) return false;

  for (const product of reply.products) {
    const stored = productsById.get(product.product_id);
    if (stored === undefined) return false;

    // 逐字段比对，模型不能改写任何一个来自 SQLite 的事实。
    if (product.name !== stored.name) return false;
    if (product.category !== stored.category) return false;
    if (product.price_cents !== stored.price_cents) return false;
    if (product.brand !== stored.brand) return false;
    if (product.stock !== stored.stock) return false;
    if (product.tags.join() !== stored.tags.join()) return false;

    if (product.stock <= 0) return false;
    if (testCase.maxPriceCents !== undefined) {
      if (product.price_cents > testCase.maxPriceCents) return false;
    }
    if (testCase.expectedCategory !== undefined) {
      if (product.category !== testCase.expectedCategory) return false;
    }
    if (testCase.forbiddenProductIds?.includes(product.product_id))
      return false;
  }
  return true;
}

export function caseSucceeds(
  testCase: AgentCase,
  reply: Reply,
  productsById: Map<string, Product>,
): boolean {
  return (
    reply.kind === testCase.expectedAction &&
    productsValid(testCase, reply, productsById) &&
    answerContains(reply, testCase.expectedAnswerTerms)
  );
}

export default {
  description: "7 条端到端 Case：推荐、澄清、政策问答与混合请求",
  requiresModel: true,
  run: main,
} satisfies EvalDefinition;

async function main(): Promise<EvalResult> {
  const provider = new ResponsesModelProvider(loadSettings());
  let passed = 0;
  for (const testCase of CASES) {
    const catalog = new Catalog();
    try {
      const turn = await new Chatty(catalog, provider).run(
        testCase.userId,
        testCase.userText,
        createChattyContext(),
      );
      const productsById = new Map(
        catalog.products.map((product) => [product.product_id, product]),
      );
      const success = caseSucceeds(testCase, turn.reply, productsById);
      if (success) passed += 1;
      console.log(
        JSON.stringify({
          case: testCase.name,
          success,
          expected_action: testCase.expectedAction,
          actual_action: turn.reply.kind,
          latency_ms: round(turn.latencyMs, 1),
          model_requests: turn.usage.requests,
          input_tokens: turn.usage.inputTokens,
          output_tokens: turn.usage.outputTokens,
          total_tokens: turn.usage.totalTokens,
        }),
      );
    } catch (error) {
      if (!(error instanceof ChattyError)) throw error;
      console.log(
        JSON.stringify({
          case: testCase.name,
          success: false,
          error: error.code,
          diagnostics: error.diagnostics,
        }),
      );
    } finally {
      catalog.close();
    }
  }

  console.log(
    JSON.stringify({
      cases: CASES.length,
      passed,
      pass_rate: passed / CASES.length,
    }),
  );
  return { passed, total: CASES.length };
}
