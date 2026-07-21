import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { KnowledgeStore } from "../src/knowledge.js";

const records = [
  {
    id: "policy-exchange-1",
    title: "尺码不合适可以换吗",
    summary: "符合条件时可免费换码一次。",
    body: "商家发错尺码可免费补发；按推荐尺码仍不合身，可协助更换一次。",
    source: "seller-policy://exchange",
    tags: ["售后", "换码"],
  },
  {
    id: "policy-rental-period-1",
    title: "租期计算",
    summary: "租期从签收当天开始。",
    body: "租期从签收当天开始计算，到约定归还日期寄回即可。",
    source: "seller-policy://rental-period",
    tags: [],
  },
  {
    id: "product-suit-001-1",
    title: "面试西装",
    summary: "黑色西装适合面试。",
    body: "SUIT-001 黑色双排扣西装适合面试和婚礼。",
    source: "seller-catalog://SUIT-001",
    tags: ["商品"],
  },
];

function withStore(
  run: (
    store: KnowledgeStore,
    sourcePath: string,
    database: DatabaseSync,
  ) => void,
): void {
  const directory = mkdtempSync(join(tmpdir(), "chatty-knowledge-"));
  const sourcePath = join(directory, "knowledge.jsonl");
  writeFileSync(
    sourcePath,
    records.map((record) => JSON.stringify(record)).join("\n") + "\n",
    "utf8",
  );
  const database = new DatabaseSync(join(directory, "chatty.sqlite"));
  try {
    run(new KnowledgeStore(database), sourcePath, database);
  } finally {
    database.close();
    rmSync(directory, { recursive: true, force: true });
  }
}

test("knowledge imports JSONL and preserves trigram and short-term ranking", () => {
  withStore((store, sourcePath) => {
    assert.equal(store.importJsonl(sourcePath), 3);
    assert.deepEqual(
      store.search("租期", 3).results.map((record) => record.id),
      ["policy-rental-period-1"],
    );
    assert.equal(
      store.search("面试 西装", 1).results[0]?.id,
      "product-suit-001-1",
    );
    assert.deepEqual(store.search("量子计算机", 3).results, []);
  });
});

test("knowledge preserves the Chinese typo fallback", () => {
  withStore((store, sourcePath) => {
    store.importJsonl(sourcePath);
    assert.equal(
      store.search("租其", 1).results[0]?.id,
      "policy-rental-period-1",
    );
  });
});

test("invalid JSONL does not replace the current index", () => {
  withStore((store, sourcePath) => {
    store.importJsonl(sourcePath);
    writeFileSync(sourcePath, '{"id":"missing-fields"}\n', "utf8");
    assert.throws(
      () => store.importJsonl(sourcePath),
      /invalid knowledge record on line 1/,
    );
    assert.equal(
      store.search("租期", 3).results[0]?.id,
      "policy-rental-period-1",
    );
  });
});

test("knowledge bounds queries and reports SQLite failures as data", () => {
  withStore((store, sourcePath, database) => {
    store.importJsonl(sourcePath);
    assert.equal(
      store.search("长".repeat(501), 3).error,
      "invalid_knowledge_query",
    );
    database.exec("DROP TABLE knowledge_fts");
    assert.deepEqual(store.search("租期", 3), {
      status: "error",
      query: "租期",
      results: [],
      error: "knowledge_search_unavailable",
    });
  });
});
