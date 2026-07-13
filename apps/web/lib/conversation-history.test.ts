import assert from "node:assert/strict";
import test from "node:test";
import {
  createSessionRepository,
  createTraceRepository,
  openDatabase,
} from "@rental/db";
import { readConversationHistory } from "./conversation-history";

function createHistoryRepos() {
  const db = openDatabase(":memory:");
  return {
    sessions: createSessionRepository(db),
    traces: createTraceRepository(db),
  };
}

test("conversation history returns an explicit empty transcript for a new conversation", () => {
  const history = readConversationHistory(
    createHistoryRepos(),
    "new-conversation",
  );
  assert.deepEqual(history, {
    conversationId: "new-conversation",
    hasEarlierMessages: false,
    messages: [],
  });
});

test("conversation history keeps whichever user or assistant side was durably recorded", () => {
  const repos = createHistoryRepos();
  repos.sessions.create({
    id: "session-partial-history",
    customerId: "customer-partial-history",
    conversationId: "partial-history",
  });
  repos.traces.append({
    id: "trace-user-only",
    sessionId: "session-partial-history",
    eventType: "evaluation_failed",
    input: { question: "有人吗？" },
    output: null,
  });
  repos.traces.append({
    id: "trace-assistant-only",
    sessionId: "session-partial-history",
    eventType: "human_agent_replied",
    input: [],
    output: { reply: "人工客服已接入。" },
  });

  const history = readConversationHistory(repos, "partial-history");
  assert.deepEqual(
    history.messages.map(({ id, role, content }) => ({ id, role, content })),
    [
      {
        id: "trace-user-only:user",
        role: "user",
        content: "有人吗？",
      },
      {
        id: "trace-assistant-only:assistant",
        role: "assistant",
        content: "人工客服已接入。",
      },
    ],
  );
});

test("conversation history preserves image-only and text-with-image customer messages", () => {
  const repos = createHistoryRepos();
  repos.sessions.create({
    id: "session-image-history",
    customerId: "customer-image-history",
    conversationId: "image-history",
  });
  repos.traces.append({
    id: "trace-image-only",
    sessionId: "session-image-history",
    eventType: "agent_reply_sent",
    input: { question: "", imageUrl: "https://example.com/one.jpg" },
  });
  repos.traces.append({
    id: "trace-text-image",
    sessionId: "session-image-history",
    eventType: "agent_reply_sent",
    input: {
      question: "这件合适吗？",
      imageUrl: "https://example.com/two.jpg",
    },
  });

  assert.deepEqual(
    readConversationHistory(repos, "image-history").messages.map(
      ({ content }) => content,
    ),
    [
      "发送了一张图片\n图片：https://example.com/one.jpg",
      "这件合适吗？\n图片：https://example.com/two.jpg",
    ],
  );
});

test("conversation history does not silently truncate sessions beyond 100 traces", () => {
  const repos = createHistoryRepos();
  repos.sessions.create({
    id: "session-long-history",
    customerId: "customer-long-history",
    conversationId: "long-history",
  });
  for (let index = 0; index < 101; index += 1) {
    repos.traces.append({
      id: `trace-long-${index}`,
      sessionId: "session-long-history",
      eventType: "agent_reply_sent",
      input: { question: `问题 ${index}` },
      output: { reply: `回答 ${index}` },
    });
  }

  const history = readConversationHistory(repos, "long-history");
  const messages = history.messages;
  assert.equal(history.hasEarlierMessages, true);
  assert.equal(messages.length, 200);
  assert.equal(messages[0]?.content, "问题 1");
  assert.equal(messages.at(-1)?.content, "回答 100");
});
