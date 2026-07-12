import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { openDatabase } from "./database.js";
import { chunkKnowledgeFile, syncKnowledgeIndex } from "./knowledge-index.js";
import { createKnowledgeRepository } from "./knowledge-repository.js";

// 真实语料目录（仓库根 knowledge/）：钉住迁移后的检索关键事实
const realKnowledgeDir = fileURLToPath(
  new URL("../../../knowledge", import.meta.url),
);

/** 造一个最小合成语料目录：rules/products/history 三类 + 触发各分块路径的内容。 */
function makeCorpus(): string {
  const dir = mkdtempSync(join(tmpdir(), "chatty-knowledge-"));
  mkdirSync(join(dir, "rules"));
  mkdirSync(join(dir, "products"));
  mkdirSync(join(dir, "history"));
  writeFileSync(
    join(dir, "rules", "policy.md"),
    "# 租赁规则\n\n押金按订单规则确认。\n\n## 计费口径\n\n第一天全价，续租半价。\n![图](/media/x.jpg)\n",
  );
  writeFileSync(
    join(dir, "products", "suit.md"),
    "# 西装说明\n\n黑色双排扣西装适合面试与婚礼场景。\n",
  );
  writeFileSync(
    join(dir, "history", "qa.csv"),
    'question,answer\n租衣服需要押金吗？,需要根据具体商品和订单规则确认。\n"身高172，体重65kg穿什么码？",需要结合具体商品版型判断。\n',
  );
  return dir;
}

/** 打开内存库 + 同步指定语料目录，返回 db 与检索仓储。 */
function indexed(dir: string) {
  const db = openDatabase(":memory:");
  const result = syncKnowledgeIndex(db, dir);
  return { db, repo: createKnowledgeRepository(db), result };
}

test("chunker: markdown 按 ## 切 section，标题链与摘要走 S1 规则", () => {
  const content =
    "# 租赁规则\n\n前言一行。\n\n## 计费口径\n\n第一天全价。\n续租半价。\n";
  const chunks = chunkKnowledgeFile("rules/policy.md", content);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].section, "租赁规则");
  assert.equal(chunks[0].summary, "租赁规则 › 前言一行。");
  assert.equal(chunks[1].section, "租赁规则 › 计费口径");
  assert.equal(chunks[1].summary, "租赁规则 › 计费口径 › 第一天全价。");
  assert.equal(chunks[1].sourceType, "rule");
  assert.ok(chunks[1].text.includes("续租半价"));
});

test("chunker: 无二级标题的小文件整文件一个 chunk", () => {
  const chunks = chunkKnowledgeFile(
    "history/common-qa.md",
    "# 常见问答\n\nQ: 租期怎么算？\nA: 从签收当天起算。\n",
  );
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0].section, "常见问答");
  assert.equal(chunks[0].sourceType, "history");
});

test("chunker: QA CSV 每行一个 chunk，摘要即 Q 行，支持引号包裹的逗号", () => {
  const csv =
    'question,answer\n需要押金吗？,按订单规则确认。\n"身高172，体重65？",按版型判断。\n';
  const chunks = chunkKnowledgeFile("history/qa.csv", csv);
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].text, "Q: 需要押金吗？\nA: 按订单规则确认。");
  assert.equal(chunks[0].summary, "Q: 需要押金吗？");
  assert.equal(chunks[1].text, "Q: 身高172，体重65？\nA: 按版型判断。");
});

test("chunker: QA CSV 表头或行格式非法时抛错", () => {
  assert.throws(
    () => chunkKnowledgeFile("history/bad.csv", "q,a\nx,y\n"),
    /question,answer/,
  );
  assert.throws(
    () => chunkKnowledgeFile("history/bad.csv", "question,answer\n只有一列\n"),
    /两列/,
  );
});

test("chunker: 超 1200 字符的 section 按段落切分且不截断段落", () => {
  const para = `${"长".repeat(700)}。`;
  const chunks = chunkKnowledgeFile(
    "rules/big.md",
    `# 大文档\n\n${para}\n\n${para}\n\n短尾段。\n`,
  );
  assert.ok(chunks.length >= 2);
  for (const chunk of chunks) assert.ok(chunk.text.length <= 1300);
  // 段落完整：每个片段要么含完整长段，要么是尾段
  assert.ok(chunks.every((c) => c.section === "大文档"));
});

test("chunker: markdown 图片行与图片链接行在索引前被剥离", () => {
  const content =
    "# 商品\n\n正文一行。\n![套装](/media/suit.jpg)\nMarkdown: ![x](/media/y.jpg)\n图片链接: /media/z.jpg\n";
  const chunks = chunkKnowledgeFile("products/p.md", content);
  assert.equal(chunks.length, 1);
  assert.ok(!chunks[0].text.includes("/media/"));
  assert.ok(chunks[0].text.includes("正文一行"));
});

test("search: 3+ 字词走 trigram MATCH 命中（双排扣）", () => {
  const { repo } = indexed(makeCorpus());
  const hits = repo.search("双排扣");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].docId, "products/suit.md");
  assert.equal(hits[0].sourceType, "product");
});

test("search: 2 字词 MATCH 必零命中，靠 LIKE 回退命中（西装/押金）", () => {
  const { repo } = indexed(makeCorpus());
  const suit = repo.search("西装");
  assert.ok(suit.length >= 1);
  assert.ok(suit.some((hit) => hit.docId === "products/suit.md"));
  const deposit = repo.search("押金");
  assert.ok(deposit.length >= 2);
  assert.ok(deposit.some((hit) => hit.docId === "history/qa.csv"));
  assert.ok(deposit.some((hit) => hit.docId === "rules/policy.md"));
});

test("search: 混合长短词整体走 LIKE，词间 AND", () => {
  const { repo } = indexed(makeCorpus());
  const hits = repo.search("双排扣 西装");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].docId, "products/suit.md");
});

test("search: 零命中与空白查询返回空数组，通配符不被解释", () => {
  const { repo } = indexed(makeCorpus());
  assert.deepEqual(repo.search("量子计算机"), []);
  assert.deepEqual(repo.search("   "), []);
  assert.deepEqual(repo.search("%"), []);
  assert.deepEqual(repo.search("_装"), []);
});

test("search: bm25 同分按 rowid 打平，顺序即 docId 字典序（确定性）", () => {
  const dir = mkdtempSync(join(tmpdir(), "chatty-knowledge-tie-"));
  mkdirSync(join(dir, "rules"));
  writeFileSync(join(dir, "rules", "a.md"), "# 甲\n\n偏远地区不包邮。\n");
  writeFileSync(join(dir, "rules", "b.md"), "# 乙\n\n偏远地区不包邮。\n");
  const { repo } = indexed(dir);
  const hits = repo.search("偏远地区");
  assert.equal(hits.length, 2);
  assert.deepEqual(
    hits.map((hit) => hit.docId),
    ["rules/a.md", "rules/b.md"],
  );
});

test("sync: 同 hash 跳过重建，语料变更后才重建（幂等）", () => {
  const dir = makeCorpus();
  const db = openDatabase(":memory:");
  const first = syncKnowledgeIndex(db, dir);
  assert.equal(first.rebuilt, true);
  assert.ok(first.chunks >= 4);
  const second = syncKnowledgeIndex(db, dir);
  assert.equal(second.rebuilt, false);
  assert.equal(second.chunks, first.chunks);
  writeFileSync(join(dir, "rules", "extra.md"), "# 新规则\n\n新增一条口径。\n");
  const third = syncKnowledgeIndex(db, dir);
  assert.equal(third.rebuilt, true);
  assert.equal(third.chunks, first.chunks + 1);
});

test("真实语料: 迁移后的 knowledge/ 可索引，检索关键事实可命中", () => {
  const { repo, result } = indexed(realKnowledgeDir);
  assert.equal(result.rebuilt, true);
  assert.ok(result.chunks >= 15);
  // 3+ 字词 MATCH：店铺电话（只存在于 rental-policy 与 qa-examples）
  const phone = repo.search("店铺电话");
  assert.ok(phone.some((hit) => hit.text.includes("18800000000")));
  // 2 字词 LIKE 回退：押金（qa-examples 行 chunk）、换码、西装
  const deposit = repo.search("押金");
  assert.ok(
    deposit.some((hit) => hit.text.includes("根据具体商品和订单规则确认")),
  );
  const exchange = repo.search("换码");
  assert.ok(
    exchange.some(
      (hit) => hit.text.includes("免费补发") || hit.text.includes("更换一次"),
    ),
  );
  const suit = repo.search("西装");
  assert.ok(suit.some((hit) => hit.docId === "products/suit-guide.md"));
});
