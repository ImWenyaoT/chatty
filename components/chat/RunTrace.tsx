"use client";

import { Card } from "@astryxdesign/core/Card";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/Stack";
import type { RunUsage } from "@/lib/api-client";

const TRACE_LABELS: Record<string, string> = {
  request_parsing: "理解需求",
  get_user_profile: "读取用户画像",
  search_products: "搜索商品",
  check_inventory: "确认库存",
  retrieve_knowledge: "检索知识",
  get_marketing_strategy: "读取营销策略",
  response_generation: "生成回答",
  evidence_validation: "校验 Evidence",
};

const tokenNumber = new Intl.NumberFormat("zh-CN");

export function RunTrace({
  trace,
  latencyMs,
  usage,
}: {
  trace: string[];
  latencyMs: number;
  usage: RunUsage;
}) {
  return (
    <details>
      <summary>
        <Text type="supporting" color="secondary" as="span">
          完成 · {(latencyMs / 1000).toFixed(1)}s · {usage.model_requests} 次
          Model · {tokenNumber.format(usage.total_tokens)} tokens
        </Text>
      </summary>
      <VStack gap={2} paddingBlockStart={2}>
        <Card variant="muted" padding={3}>
          <VStack gap={2}>
            <ol style={{ margin: 0, paddingInlineStart: "1.25rem" }}>
              {trace.map((step, index) => (
                <li key={`${index}-${step}`}>
                  <Text type="body">{TRACE_LABELS[step] ?? step}</Text>
                </li>
              ))}
            </ol>
            <Text type="supporting" color="secondary">
              Input {tokenNumber.format(usage.input_tokens)} · Output{" "}
              {tokenNumber.format(usage.output_tokens)} tokens
            </Text>
          </VStack>
        </Card>
      </VStack>
    </details>
  );
}
