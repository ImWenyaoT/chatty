"use client";

import { Button } from "@astryxdesign/core/Button";
import {
  ChatComposer,
  ChatComposerInput,
  ChatLayout,
  ChatMessageList,
} from "@astryxdesign/core/Chat";
import { Heading, Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Layout, LayoutContent, LayoutHeader } from "@astryxdesign/core/Layout";

import { ChatEmptyState } from "@/components/chat/ChatEmptyState";
import { ChatEntryView } from "@/components/chat/ChatEntryView";
import type { ChatEntry } from "@/components/chat/types";
import type { CatalogInfo } from "@/lib/api-client";

export function ChatPanel({
  info,
  entries,
  text,
  onTextChange,
  onSend,
  busy,
  exhausted,
  onReset,
  turnsLeft,
}: {
  info: CatalogInfo | null;
  entries: ChatEntry[];
  text: string;
  onTextChange: (value: string) => void;
  onSend: (raw: string) => void;
  busy: boolean;
  exhausted: boolean;
  onReset: () => void;
  turnsLeft: number | null;
}) {
  const statusLabel =
    turnsLeft === null
      ? "会话尚未开始"
      : exhausted
        ? "本轮已用尽"
        : `还可澄清 ${turnsLeft} 轮`;

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader>
          <HStack
            gap={3}
            hAlign="between"
            vAlign="center"
            paddingInline={4}
            paddingBlock={3}
          >
            <VStack gap={0.5}>
              <Heading level={3}>对话</Heading>
              <Text type="supporting" color="secondary">
                {statusLabel}
              </Text>
            </VStack>
            {entries.length > 0 ? (
              <Button
                label="新对话"
                variant="ghost"
                size="sm"
                onClick={onReset}
              />
            ) : null}
          </HStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent padding={0} isScrollable>
          <ChatLayout
            emptyState={
              info ? (
                <ChatEmptyState
                  info={info}
                  onExample={(example) => onSend(example)}
                />
              ) : null
            }
            composer={
              <VStack gap={2} padding={3}>
                {exhausted ? (
                  <HStack gap={2} vAlign="center" wrap="wrap">
                    <Text type="supporting" color="secondary">
                      这段对话问到头了。
                    </Text>
                    <Button
                      label="开一段新的"
                      variant="ghost"
                      size="sm"
                      onClick={onReset}
                    />
                  </HStack>
                ) : null}
                <ChatComposer
                  value={text}
                  onChange={onTextChange}
                  onSubmit={(value) => onSend(value)}
                  isDisabled={busy || exhausted}
                  placeholder={
                    busy ? "正在跑…" : "想买点什么，或问一条政策？"
                  }
                  input={<ChatComposerInput aria-label="消息" />}
                />
              </VStack>
            }
          >
            <ChatMessageList>
              <VStack gap={3} padding={4}>
                {entries.map((entry, index) => (
                  <ChatEntryView key={index} entry={entry} />
                ))}
                {busy ? (
                  <Text type="supporting" color="secondary">
                    正在理解需求并执行必要步骤…
                  </Text>
                ) : null}
              </VStack>
            </ChatMessageList>
          </ChatLayout>
        </LayoutContent>
      }
    />
  );
}
