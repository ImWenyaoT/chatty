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

test("executeSearchRequest normalizes exchange questions to the indexed policy term", async () => {
  const searcher = knowledgeSearcher([
    {
      text: "发错尺码或款式可免费补发；按推荐尺码不合身可协助更换一次。",
      section: "租赁规则 › 换码",
    },
  ]);
  const result = await executeSearchRequest({
    toolName: "search_knowledge",
    input: '{"query":"不合身换货"}',
    registry: createDefaultToolRegistry(searcher),
    question: "衣服收到不合身能换吗？",
    searchedQueries: [],
  });

  assert.equal(result.kind, "executed");
  if (result.kind !== "executed") return;
  assert.deepEqual(result.toolCall.arguments, { query: "换码" });
  assert.deepEqual(searcher.state.queries, ["换码"]);
  assert.match(result.output, /免费补发/);
});

test("executeSearchRequest normalizes rental how-to questions to the indexed phrase", async () => {
  const searcher = knowledgeSearcher([
    {
      text: "第一天全价，续租半价，在途不算租期，偏远地区除外。",
      section: "租赁规则 › 怎么租",
    },
  ]);
  const result = await executeSearchRequest({
    toolName: "search_knowledge",
    input: '{"query":"租赁流程"}',
    registry: createDefaultToolRegistry(searcher),
    question: "你们家衣服怎么租？",
    searchedQueries: [],
  });

  assert.equal(result.kind, "executed");
  if (result.kind !== "executed") return;
  assert.deepEqual(result.toolCall.arguments, { query: "怎么租" });
  assert.deepEqual(searcher.state.queries, ["怎么租"]);
  assert.match(result.output, /租期/);
  assert.match(result.output, /偏远地区/);
});

test("executeSearchRequest normalizes clothing-care questions to the indexed term", async () => {
  const searcher = knowledgeSearcher([
    {
      text: "衣服穿完无需自行清洗，直接寄回即可。",
      section: "租赁规则 › 清洗",
    },
  ]);
  const result = await executeSearchRequest({
    toolName: "search_knowledge",
    input: '{"query":"穿完怎么处理"}',
    registry: createDefaultToolRegistry(searcher),
    question: "衣服穿完还需要我自己洗吗？",
    searchedQueries: [],
  });

  assert.equal(result.kind, "executed");
  if (result.kind !== "executed") return;
  assert.deepEqual(result.toolCall.arguments, { query: "清洗" });
  assert.deepEqual(searcher.state.queries, ["清洗"]);
  assert.match(result.output, /无需自行清洗/);
});

test("executeSearchRequest preserves an explicit query for another fact in a compound question", async () => {
  const searcher = knowledgeSearcher([
    { text: "押金按具体商品和订单规则确认。", section: "租赁规则 › 押金" },
  ]);
  const result = await executeSearchRequest({
    toolName: "search_knowledge",
    input: '{"query":"押金"}',
    registry: createDefaultToolRegistry(searcher),
    question: "你们家怎么租，押金怎么算？",
    searchedQueries: [],
  });

  assert.equal(result.kind, "executed");
  if (result.kind !== "executed") return;
  assert.deepEqual(result.toolCall.arguments, { query: "押金" });
  assert.deepEqual(searcher.state.queries, ["押金"]);
});

test("executeSearchRequest preserves a specific fact query that contains a generic suffix", async () => {
  const searcher = knowledgeSearcher([
    { text: "押金按具体商品和订单规则确认。", section: "租赁规则 › 押金" },
  ]);
  const result = await executeSearchRequest({
    toolName: "search_knowledge",
    input: '{"query":"押金规则"}',
    registry: createDefaultToolRegistry(searcher),
    question: "你们家怎么租，押金怎么算？",
    searchedQueries: [],
  });

  assert.equal(result.kind, "executed");
  if (result.kind !== "executed") return;
  assert.deepEqual(result.toolCall.arguments, { query: "押金规则" });
  assert.deepEqual(searcher.state.queries, ["押金规则"]);
});
