// search_knowledge 工具的行为测试（docs/archive/agentic-search-design.md B2 验收）：
// §3.2 三段式结果格式（含空结果、截断尾行）、两层截断、失败与空结果可区分、
// policy 门对 low 放行 / closed session 拒绝。仓储用内存 fake 注入。
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createSearchKnowledgeTool,
  SEARCH_KNOWLEDGE_TOP_K,
  type KnowledgeSearcher,
  type SearchKnowledgeResult,
} from "./search-knowledge.js";
import { createDefaultToolRegistry, PolicyDenyError } from "./registry.js";
import { createDefaultPolicy } from "../policies/policy.js";

/** 固定命中列表的内存检索 fake：只回放数据，不含任何检索逻辑。 */
function searcherOf(
  hits: Array<{ text: string; section: string }>,
): KnowledgeSearcher {
  return { search: () => hits };
}

/** 生成 n 条可辨识的命中，正文短且互不相同。 */
function makeHits(n: number): Array<{ text: string; section: string }> {
  return Array.from({ length: n }, (_, i) => ({
    text: `第 ${i + 1} 条正文内容`,
    section: `文档 › 小节${i + 1}`,
  }));
}

test("命中数超过 top-k：头行计数、编号条目含出处、尾行提示剩余数量", async () => {
  const tool = createSearchKnowledgeTool(searcherOf(makeHits(5)));
  const result = (await tool.execute({
    query: "押金",
  })) as SearchKnowledgeResult;
  assert.ok(
    result.output.startsWith("找到 5 条相关内容，显示最相关的前 3 条："),
  );
  assert.match(result.output, /\[1\] 来源：文档 › 小节1\n第 1 条正文内容/);
  assert.match(result.output, /\[3\] 来源：文档 › 小节3/);
  assert.ok(!result.output.includes("[4]"));
  assert.ok(
    result.output.endsWith(
      "（还有 2 条未显示。如需更精确的结果，换更具体的关键词再搜一次。）",
    ),
  );
  assert.equal(result.matches, 5);
  assert.equal(result.truncated, true);
});

test("命中数不超过 top-k：简化头行、无截断尾行", async () => {
  const tool = createSearchKnowledgeTool(searcherOf(makeHits(2)));
  const result = (await tool.execute({
    query: "换码",
  })) as SearchKnowledgeResult;
  assert.ok(result.output.startsWith("找到 2 条相关内容："));
  assert.ok(!result.output.includes("未显示"));
  assert.equal(result.matches, 2);
  assert.equal(result.truncated, false);
});

test("空结果：显式文案 + 可执行建议，绝不回空串，且与失败可区分", async () => {
  const tool = createSearchKnowledgeTool(searcherOf([]));
  const result = (await tool.execute({
    query: "押金 多少",
  })) as SearchKnowledgeResult;
  assert.equal(
    result.output,
    '未找到与"押金 多少"相关的内容。换更短或不同的关键词再试一次，例如把长短语拆成单个词。',
  );
  assert.equal(result.matches, 0);
  assert.equal(result.truncated, false);
});

test("DB 异常：返回降级指引而非抛错，文案与空结果不同", async () => {
  const broken: KnowledgeSearcher = {
    search: () => {
      throw new Error("db is locked");
    },
  };
  const result = (await createSearchKnowledgeTool(broken).execute({
    query: "押金",
  })) as SearchKnowledgeResult;
  assert.equal(
    result.output,
    "知识库搜索暂时不可用。请基于已知信息谨慎回答，不确定的内容如实告知用户无法确认。",
  );
  assert.equal(result.matches, 0);
  assert.equal(result.status, "degraded");
  assert.equal(result.errorCode, "knowledge_search_unavailable");
});

test("单条正文超 800 字符：截到上限并加已截断后缀", async () => {
  const long = "甲".repeat(900);
  const tool = createSearchKnowledgeTool(
    searcherOf([{ text: long, section: "文档 › 长文" }]),
  );
  const result = (await tool.execute({ query: "甲" })) as SearchKnowledgeResult;
  assert.ok(result.output.includes(`${"甲".repeat(800)}……[已截断]`));
  assert.ok(!result.output.includes("甲".repeat(801)));
  assert.equal(result.truncated, true);
});

test("结果总量到顶：停止追加条目（不截半条）并在尾行说明剩余", async () => {
  // 每条约 1900+ 字符，前两条合计未超 4000 上限，追加第三条会超，应只显示前两条
  const hits = makeHits(3).map((hit) => ({
    ...hit,
    section: "标".repeat(1900),
  }));
  const result = (await createSearchKnowledgeTool(searcherOf(hits)).execute({
    query: "押金",
  })) as SearchKnowledgeResult;
  assert.ok(result.output.includes("[2]"));
  assert.ok(!result.output.includes("[3]"));
  assert.ok(result.output.includes("（还有 1 条未显示。"));
  assert.equal(result.truncated, true);
});

test("工具元数据：risk=low、无需审批、参数 schema 要求 query", () => {
  const tool = createSearchKnowledgeTool(searcherOf([]));
  assert.equal(tool.name, "search_knowledge");
  assert.equal(tool.risk, "low");
  assert.equal(tool.approvalRequired, false);
  assert.deepEqual((tool.parameters as { required: string[] }).required, [
    "query",
  ]);
  assert.ok(
    tool.description.includes(`返回最相关的前 ${SEARCH_KNOWLEDGE_TOP_K} 条`),
  );
});

test("policy 门：active session 对 low 放行并真正执行检索", async () => {
  const registry = createDefaultToolRegistry(searcherOf(makeHits(1)));
  const out = (await registry.invokeWithPolicy(
    "search_knowledge",
    { query: "押金" },
    createDefaultPolicy(),
    { sessionStatus: "active" },
  )) as SearchKnowledgeResult;
  assert.ok(out.output.startsWith("找到 1 条相关内容："));
});

test("policy 门：closed session 拒绝执行", async () => {
  const registry = createDefaultToolRegistry(searcherOf(makeHits(1)));
  await assert.rejects(
    () =>
      registry.invokeWithPolicy(
        "search_knowledge",
        { query: "押金" },
        createDefaultPolicy(),
        {
          sessionStatus: "closed",
        },
      ),
    (err: unknown) => err instanceof PolicyDenyError,
  );
});

test("不注入知识仓储时默认 registry 不含 search_knowledge（旧调用方不变）", () => {
  assert.equal(createDefaultToolRegistry().get("search_knowledge"), undefined);
});
