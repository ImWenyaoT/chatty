"use client";

import { useEffect, useState } from "react";
import { Center } from "@astryxdesign/core/Center";
import { Heading, Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/Stack";

import { ChatPanel } from "@/components/chat/ChatPanel";
import { UserPicker } from "@/components/chat/UserPicker";
import { ChattyShell } from "@/components/layout/ChattyShell";
import {
  ApiError,
  explain,
  fetchCatalog,
  type CatalogInfo,
} from "@/lib/api-client";
import { useChattySession } from "@/lib/use-chatty-session";

export function ChatPage() {
  const [info, setInfo] = useState<CatalogInfo | null>(null);
  const [userId, setUserId] = useState("user_active");
  const [bootError, setBootError] = useState<string | null>(null);
  const session = useChattySession(userId);

  useEffect(() => {
    void (async () => {
      try {
        setInfo(await fetchCatalog());
      } catch (error: unknown) {
        setBootError(
          explain(error instanceof ApiError ? error.code : "invalid_response"),
        );
      }
    })();
  }, []);

  const reset = (nextUser = userId) => {
    if (nextUser === userId) {
      session.reset();
      return;
    }
    setUserId(nextUser);
  };

  const busy =
    session.status === "submitted" || session.status === "streaming";
  const exhausted =
    session.turnsLeft !== null && session.turnsLeft <= 0;
  const catalogSummary =
    info === null
      ? "载入中…"
      : `${info.model_id} · ${info.product_count} 件商品 · ${info.categories.length} 类目`;

  if (bootError) {
    return (
      <Center padding={6} style={{ minHeight: "100dvh" }}>
        <VStack gap={3}>
          <Heading level={1}>Chatty</Heading>
          <Text type="body">{bootError}</Text>
          <Text type="supporting" color="secondary">
            先起服务：<code>pnpm dev</code>
          </Text>
        </VStack>
      </Center>
    );
  }

  return (
    <ChattyShell
      view="chat"
      summary={catalogSummary}
      sidebarExtra={
        info ? (
          <UserPicker
            users={info.users}
            value={userId}
            onChange={(next) => reset(next)}
            disabled={busy}
          />
        ) : (
          <Text type="supporting" color="secondary">
            正在载入演示用户…
          </Text>
        )
      }
    >
      <ChatPanel
        info={info}
        entries={session.entries}
        text={session.text}
        onTextChange={session.setText}
        onSend={(raw) => void session.sendMessage(raw)}
        busy={busy}
        exhausted={exhausted}
        onReset={() => reset()}
        turnsLeft={session.turnsLeft}
      />
    </ChattyShell>
  );
}
