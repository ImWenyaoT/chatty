import assert from "node:assert/strict";
import { test } from "node:test";
import type { JsonValue } from "@rental/shared";
import { createDefaultToolRegistry } from "./tools/registry.js";
import { executeSearchRequest } from "./search-execution.js";

/** Builds a countable knowledge searcher so tests can observe real executed queries. */
function knowledgeSearcher(hits: Array<{ text: string; section: string }>) {
  const state = { calls: 0, queries: [] as string[] };
  return {
    state,
    search(query: string) {
      state.calls += 1;
      state.queries.push(query);
      return hits;
    },
  };
}

test("executeSearchRequest executes a refined query and returns trace evidence", async () => {
  const searcher = knowledgeSearcher([
    {
      text: "SUIT-001 身高 175-181 体重 66-80 建议 L",
      section: "SUIT-001 尺码参考",
    },
  ]);
  const result = await executeSearchRequest({
    toolName: "search_knowledge",
    input: '{"query":"尺码推荐"}',
    registry: createDefaultToolRegistry(searcher),
    question: "我 178cm 72kg，这套建议什么码？",
    productId: "SUIT-001",
    searchedQueries: [],
  });

  assert.equal(result.kind, "executed");
  assert.deepEqual(searcher.state.queries, ["SUIT-001 尺码"]);
  if (result.kind !== "executed")
    throw new Error("expected executed search result");
  assert.equal(result.fragment.kind, "knowledge");
  assert.equal(result.fragment.label, "知识库检索：SUIT-001 尺码");
  assert.match(result.fragment.content, /建议 L/);
  assert.equal(result.toolCall.toolName, "search_knowledge");
  assert.deepEqual(result.toolCall.arguments, { query: "SUIT-001 尺码" });
  assert.equal(result.toolCall.risk, "low");
  assert.equal(result.toolCall.approvalRequired, false);
  assert.equal((result.toolResult as { matches: JsonValue }).matches, 1);
  assert.match(result.output, /建议 L/);
});

test("executeSearchRequest retries bad arguments without trace evidence", async () => {
  const searcher = knowledgeSearcher([
    { text: "押金按订单规则确认", section: "租赁规则 › 押金" },
  ]);
  const result = await executeSearchRequest({
    toolName: "search_knowledge",
    input: '{"keyword":"押金"}',
    registry: createDefaultToolRegistry(searcher),
    question: "租衣服要押金吗",
    searchedQueries: [],
  });

  assert.deepEqual(result, {
    kind: "retry",
    output: "query 参数缺失或不是字符串，请重试，只需提供 query 一个参数",
  });
  assert.equal(searcher.state.calls, 0);
});

test("executeSearchRequest deduplicates by refined query", async () => {
  const searcher = knowledgeSearcher([
    {
      text: "SUIT-001 身高 175-181 体重 66-80 建议 L",
      section: "SUIT-001 尺码参考",
    },
  ]);
  const result = await executeSearchRequest({
    toolName: "search_knowledge",
    input: '{"query":"尺码表"}',
    registry: createDefaultToolRegistry(searcher),
    question: "我 178cm 72kg，这套建议什么码？",
    productId: "SUIT-001",
    searchedQueries: ["SUIT-001 尺码"],
  });

  assert.deepEqual(result, {
    kind: "retry",
    output: "已搜索过 SUIT-001 尺码。请基于已有结果直接回答。",
  });
  assert.equal(searcher.state.calls, 0);
});
