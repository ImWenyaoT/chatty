"use client";

import { ClickableCard } from "@astryxdesign/core/ClickableCard";
import { Grid } from "@astryxdesign/core/Grid";
import { Icon } from "@astryxdesign/core/Icon";
import { Heading, Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import {
  ToggleButton,
  ToggleButtonGroup,
} from "@astryxdesign/core/ToggleButton";
import {
  ChatBubbleBottomCenterTextIcon,
  ShoppingBagIcon,
} from "@heroicons/react/24/outline";
import { useState } from "react";

import type { CatalogInfo } from "@/lib/api-client";

type CategoryId = "recommend" | "policy";

const SUGGESTIONS: Record<
  CategoryId,
  Array<{ heading: string; body: string; prompt: string }>
> = {
  recommend: [
    {
      heading: "降噪耳机",
      body: "预算与场景说清楚，再查有货商品",
      prompt: "想买个降噪耳机，2000 以内",
    },
    {
      heading: "通勤键盘",
      body: "按偏好类目与库存筛选候选",
      prompt: "有没有适合通勤的键盘？",
    },
    {
      heading: "轻薄本",
      body: "说清预算与用途，再给可核验推荐",
      prompt: "推荐一台 6000 左右的轻薄本，主要办公",
    },
  ],
  policy: [
    {
      heading: "七天无理由",
      body: "先检索政策知识，再回答退换规则",
      prompt: "七天无理由怎么退？",
    },
    {
      heading: "配送时效",
      body: "知识问答不覆盖价格库存事实",
      prompt: "一般多久能送到？偏远地区呢？",
    },
    {
      heading: "发票与售后",
      body: "政策回答必须经过知识检索",
      prompt: "怎么开发票？售后保修多久？",
    },
  ],
};

export function ChatEmptyState({
  info,
  onExample,
}: {
  info: CatalogInfo;
  onExample: (text: string) => void;
}) {
  const [category, setCategory] = useState<CategoryId>("recommend");
  const cards = SUGGESTIONS[category];

  return (
    <VStack gap={6} paddingBlock={8} paddingInline={2}>
      <VStack gap={2}>
        <Heading level={2}>用大白话说需求</Heading>
        <Text type="body" color="secondary">
          Chatty 会先理解约束，再查库存与知识，最后给出可核验的推荐或政策回答。
        </Text>
      </VStack>

      <HStack gap={2} wrap="wrap">
        <Token label="商品推荐" />
        <Token label="政策问答" />
      </HStack>

      <ToggleButtonGroup
        type="single"
        label="示例类别"
        value={category}
        onChange={(next) => {
          if (next === "recommend" || next === "policy") setCategory(next);
        }}
      >
        <ToggleButton
          value="recommend"
          label="商品推荐"
          icon={<Icon icon={ShoppingBagIcon} size="sm" />}
        />
        <ToggleButton
          value="policy"
          label="政策问答"
          icon={<Icon icon={ChatBubbleBottomCenterTextIcon} size="sm" />}
        />
      </ToggleButtonGroup>

      <Grid columns={{ minWidth: 220, max: 3 }} gap={3}>
        {cards.map((card) => (
          <ClickableCard
            key={card.prompt}
            label={card.heading}
            onClick={() => onExample(card.prompt)}
            padding={4}
          >
            <VStack gap={2}>
              <Text type="body" weight="bold">
                {card.heading}
              </Text>
              <Text type="supporting" color="secondary">
                {card.body}
              </Text>
            </VStack>
          </ClickableCard>
        ))}
      </Grid>

      <Text type="supporting" color="secondary">
        类目：{info.categories.join("、")}。换演示用户再问同样的话，能看出画像影响。
      </Text>
    </VStack>
  );
}
