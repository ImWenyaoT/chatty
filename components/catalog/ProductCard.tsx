"use client";

import { Badge } from "@astryxdesign/core/Badge";
import { Card } from "@astryxdesign/core/Card";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import type { Product } from "@/lib/api-client";
import { yuan } from "@/lib/format";

export function ProductCard(product: Product) {
  return (
    <Card padding={4}>
      <VStack gap={3}>
        <HStack gap={3} hAlign="between" vAlign="start">
          <VStack gap={1}>
            <Text type="body" weight="bold">
              {product.name}
            </Text>
            <Text type="supporting" color="secondary">
              {product.product_id} · {product.brand} · {product.category}
            </Text>
          </VStack>
          <Text type="large" weight="bold">
            ¥{yuan(product.price_cents)}
          </Text>
        </HStack>
        <HStack gap={2} wrap="wrap">
          <Badge
            variant={product.low_stock ? "warning" : "success"}
            label={product.low_stock ? "库存紧张" : "有货"}
          />
          {product.tags.map((tag) => (
            <Badge key={tag} variant="neutral" label={tag} />
          ))}
        </HStack>
        <VStack gap={1}>
          <Text type="body">
            <Text type="body" color="secondary" as="span">
              理由 ·{" "}
            </Text>
            {product.reason}
          </Text>
          <Text type="supporting" color="secondary">
            {product.marketing_copy}
          </Text>
        </VStack>
      </VStack>
    </Card>
  );
}
