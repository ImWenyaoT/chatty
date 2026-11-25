"use client";

import {
  ChatMessage,
  ChatMessageBubble,
} from "@astryxdesign/core/Chat";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/Stack";

import { ProductCard } from "@/components/catalog/ProductCard";
import { ProductTable } from "@/components/catalog/ProductTable";
import { RunTrace } from "@/components/chat/RunTrace";
import type { ChatEntry } from "@/components/chat/types";
import { explain } from "@/lib/api-client";

export function ChatEntryView({ entry }: { entry: ChatEntry }) {
  switch (entry.kind) {
    case "user":
      return (
        <ChatMessage sender="user">
          <ChatMessageBubble>{entry.text}</ChatMessageBubble>
        </ChatMessage>
      );
    case "understood":
      return (
        <Text type="supporting" color="secondary">
          理解为 · {entry.text}
        </Text>
      );
    case "question":
    case "answer":
      return (
        <ChatMessage sender="assistant" name="Chatty">
          <ChatMessageBubble>{entry.text}</ChatMessageBubble>
        </ChatMessage>
      );
    case "error":
      return (
        <ChatMessage sender="system">
          <Text type="body" color="accent">
            {explain(entry.code)}{" "}
            <Text type="supporting" color="secondary" as="span">
              {entry.code}
            </Text>
          </Text>
        </ChatMessage>
      );
    case "run":
      return (
        <RunTrace
          trace={entry.trace}
          latencyMs={entry.latencyMs}
          usage={entry.usage}
        />
      );
    case "products":
      return (
        <VStack gap={3}>
          {entry.products.length > 1 ? (
            <ProductTable products={entry.products} />
          ) : (
            entry.products.map((product) => (
              <ProductCard key={product.product_id} {...product} />
            ))
          )}
          <Text type="supporting" color="secondary">
            ID、名称、价格与库存来自 SQLite 重查，并经 Evidence 校验；模型只写理由与文案。
          </Text>
        </VStack>
      );
    default: {
      const _exhaustive: never = entry;
      return _exhaustive;
    }
  }
}
