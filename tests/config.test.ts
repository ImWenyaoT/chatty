import { describe, expect, it } from "vitest";
import { modelConfig } from "../src/config.js";

describe("modelConfig", () => {
  it("优先使用 DeepSeek 系统变量", () => {
    expect(
      modelConfig({
        DEEPSEEK_API_KEY: "ds",
        OPENAI_API_KEY: "oa",
        DEEPSEEK_MODEL: "m",
      }),
    ).toMatchObject({ apiKey: "ds", model: "m" });
  });
  it("兼容 OpenAI 变量名", () => {
    expect(
      modelConfig({
        OPENAI_API_KEY: "oa",
        OPENAI_BASE_URL: "https://example.test",
      }),
    ).toMatchObject({ apiKey: "oa", baseURL: "https://example.test" });
  });
});
