import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, it } from "node:test";

import { loadSettings } from "../src/server/settings.ts";

function tempRoot(): URL {
  return pathToFileURL(`${mkdtempSync(join(tmpdir(), "chatty-settings-"))}/`);
}

describe("配置加载", () => {
  it(".env.local 覆盖 .env，.env 覆盖系统环境变量", (t) => {
    t.mock.property(process, "env", {
      ...process.env,
      DEEPSEEK_MODEL: "system-model",
    });
    const root = tempRoot();
    writeFileSync(
      fileURLToPath(new URL(".env", root)),
      "DEEPSEEK_MODEL=env-model\n",
    );
    writeFileSync(
      fileURLToPath(new URL(".env.local", root)),
      "DEEPSEEK_MODEL=local-model\n",
    );

    assert.equal(loadSettings(root).model, "local-model");
  });

  it("缺少 env 文件时回落到系统环境变量", (t) => {
    t.mock.property(process, "env", {
      ...process.env,
      DEEPSEEK_MODEL: "system-model",
    });

    assert.equal(loadSettings(tempRoot()).model, "system-model");
  });

  it("env 文件不可读时抛出，而不是静默忽略配置", () => {
    const root = tempRoot();
    // 用目录冒充 .env，readFileSync 会抛 EISDIR：任何非 ENOENT 错误都必须暴露。
    mkdirSync(fileURLToPath(new URL(".env", root)));

    assert.throws(() => loadSettings(root), { code: "EISDIR" });
  });
});
