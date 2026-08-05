/**
 * 知识检索离线评测：固定 10 条 case，衡量 hit@5 与 MRR@5。
 * 只依赖 SQLite FTS5，不调用模型，可以在 CI 中稳定跑。
 */

import { Catalog } from "../data/catalog.ts";
import { round } from "../data/round.ts";

export type RetrievalCase = {
  query: string;
  categories: string[];
  productIds: string[];
  relevantDocumentIds: Set<string>;
};

function retrievalCase(
  query: string,
  categories: string[],
  productIds: string[],
  relevantDocumentIds: string[],
): RetrievalCase {
  return {
    query,
    categories,
    productIds,
    relevantDocumentIds: new Set(relevantDocumentIds),
  };
}

export const CASES: RetrievalCase[] = [
  retrievalCase(
    "降噪 耳机 通勤",
    ["耳机"],
    ["P003", "P004"],
    ["K001", "K002", "K003"],
  ),
  retrievalCase("咖啡机 胶囊", ["家电"], ["P018"], ["K030", "K009"]),
  retrievalCase(
    "平板 学习 办公",
    ["平板"],
    ["P005", "P006"],
    ["K005", "K020", "K021"],
  ),
  retrievalCase("笔记本 轻薄 办公", ["电脑"], ["P030"], ["K013", "K022"]),
  retrievalCase("跑鞋 竞速 训练", ["运动"], ["P040", "P016"], ["K027", "K007"]),
  retrievalCase(
    "安静 静音 耳机",
    ["耳机"],
    ["P003", "P004"],
    ["K001", "K002", "K003"],
  ),
  retrievalCase("保护视力 不伤眼", ["家电"], ["P019"], ["K031"]),
  retrievalCase(
    "电池耐用 一天一充",
    ["穿戴"],
    ["P031", "P032"],
    ["K015", "K024"],
  ),
  retrievalCase("快充 充电器", ["配件"], ["P007"], ["K006", "K036"]),
  retrievalCase("价格敏感 沟通 原则", ["营销"], [], ["K010"]),
];

/** 评测只需要检索能力，用最窄的依赖便于注入替身。 */
export type KnowledgeSource = Pick<Catalog, "retrieveKnowledge">;

export type RetrievalMetrics = {
  cases: number;
  hit_rate_at_5: number;
  mrr_at_5: number;
};

export function evaluateRetrieval(catalog: KnowledgeSource): RetrievalMetrics {
  let hits = 0;
  let reciprocalRankTotal = 0;

  for (const testCase of CASES) {
    const documentIds = catalog
      .retrieveKnowledge({
        query: testCase.query,
        categories: testCase.categories,
        productIds: testCase.productIds,
        limit: 5,
      })
      .map((hit) => hit.doc_id);

    const rank = documentIds.findIndex((docId) =>
      testCase.relevantDocumentIds.has(docId),
    );
    if (rank >= 0) {
      hits += 1;
      reciprocalRankTotal += 1 / (rank + 1);
    }
  }

  return {
    cases: CASES.length,
    hit_rate_at_5: hits / CASES.length,
    mrr_at_5: round(reciprocalRankTotal / CASES.length, 4),
  };
}

/** 打印指标并返回退出码，命中率回退到 1 以下即视为失败。 */
export function runRetrievalEval(catalog: KnowledgeSource): number {
  const metrics = evaluateRetrieval(catalog);
  console.log(JSON.stringify(metrics, null, 2));
  return metrics.hit_rate_at_5 < 1 ? 1 : 0;
}

if (import.meta.main) {
  const catalog = new Catalog();
  try {
    process.exitCode = runRetrievalEval(catalog);
  } finally {
    catalog.close();
  }
}
