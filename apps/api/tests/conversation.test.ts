import { describe, expect, it, vi } from "vitest";

import type { Recommender } from "../src/agent.js";
import { Conversation } from "../src/conversation.js";

describe("Conversation", () => {
  it("把澄清历史保存为 Agents SDK 的结构化 content", async () => {
    const recommender = {
      respond: vi.fn(async () => ({
        request_id: "request_test",
        user_id: "user_new",
        question: "是否需要放宽预算？",
        total_latency_ms: 1,
      })),
    } as unknown as Recommender;
    const conversation = new Conversation(
      recommender,
      "user_new",
      async () => ({
        preferred_categories: ["耳机"],
        max_price_cents: 20_000,
      }),
    );

    const [, history] = await conversation.send(["200 元耳机"], []);

    expect(history).toEqual([
      {
        role: "user",
        content: [
          {
            type: "input_text",
            text: JSON.stringify({
              user_id: "user_new",
              num_items: 3,
              context: {
                preferred_categories: ["耳机"],
                max_price_cents: 20_000,
              },
            }),
          },
        ],
      },
      {
        role: "assistant",
        status: "completed",
        content: [
          {
            type: "output_text",
            text: JSON.stringify({
              action: "clarify",
              question: "是否需要放宽预算？",
            }),
          },
        ],
      },
    ]);
  });
});
