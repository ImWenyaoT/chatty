import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { Catalog } from "../src/data/catalog.ts";
import { DATA_DIR } from "../src/data/seed.ts";

test("文件数据库重启后保留用户画像更新", async () => {
  const directory = mkdtempSync(join(tmpdir(), "chatty-database-"));
  const databasePath = join(directory, "chatty.db");

  try {
    const first = new Catalog(databasePath, DATA_DIR);
    first.updateUserProfileAfterSuccess("user_active", ["户外"]);
    first.close();

    const reopened = new Catalog(databasePath, DATA_DIR);
    assert.deepEqual(reopened.userProfile("user_active").preferred_categories, [
      "户外",
    ]);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
