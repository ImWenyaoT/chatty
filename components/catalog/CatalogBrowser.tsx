"use client";

import { useEffect, useMemo, useState } from "react";
import { Badge } from "@astryxdesign/core/Badge";
import { Card } from "@astryxdesign/core/Card";
import { Center } from "@astryxdesign/core/Center";
import { Divider } from "@astryxdesign/core/Divider";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading, Text } from "@astryxdesign/core/Text";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import {
  Layout,
  LayoutContent,
  LayoutHeader,
} from "@astryxdesign/core/Layout";
import { Section } from "@astryxdesign/core/Section";
import { TextInput } from "@astryxdesign/core/TextInput";
import {
  ToggleButton,
  ToggleButtonGroup,
} from "@astryxdesign/core/ToggleButton";
import { MagnifyingGlassIcon } from "@heroicons/react/24/outline";

import {
  ApiError,
  explain,
  fetchCatalogData,
  type CatalogData,
} from "@/lib/api-client";
import { yuan } from "@/lib/format";

type Tab = "products" | "profiles";

export function CatalogBrowser() {
  const [data, setData] = useState<CatalogData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState<Tab>("products");

  useEffect(() => {
    void (async () => {
      try {
        setData(await fetchCatalogData());
      } catch (caught: unknown) {
        if (caught instanceof ApiError) setError(explain(caught.code));
        else setError(explain("invalid_response"));
      }
    })();
  }, []);

  const visibleProducts = useMemo(() => {
    if (!data) return [];
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return data.products;
    return data.products.filter((product) =>
      [
        product.product_id,
        product.name,
        product.category,
        product.brand,
        ...product.tags,
      ].some((value) => value.toLowerCase().includes(normalizedQuery)),
    );
  }, [data, query]);

  if (error) {
    return (
      <Center padding={6}>
        <Text type="body" color="accent">
          {error}
        </Text>
      </Center>
    );
  }

  if (!data) {
    return (
      <Center padding={6}>
        <Text type="supporting" color="secondary">
          正在读取 SQLite…
        </Text>
      </Center>
    );
  }

  return (
    <Layout
      height="fill"
      header={
        <LayoutHeader>
          <VStack gap={1} paddingInline={4} paddingBlock={3}>
            <Heading level={3}>SQLite 数据</Heading>
            <Text type="supporting" color="secondary">
              运行时查询结果的只读快照，不是直接读 JSONL。
            </Text>
          </VStack>
        </LayoutHeader>
      }
      content={
        <LayoutContent isScrollable padding={4}>
          <VStack gap={4}>
            <ToggleButtonGroup
              type="single"
              label="目录视图"
              value={tab}
              onChange={(next) => {
                if (next === "products" || next === "profiles") setTab(next);
              }}
            >
              <ToggleButton
                value="products"
                label={`商品 ${data.products.length}`}
              />
              <ToggleButton
                value="profiles"
                label={`画像 ${data.profiles.length}`}
              />
            </ToggleButtonGroup>

            {tab === "products" ? (
              <Section>
                <VStack gap={3}>
                  <TextInput
                    label="搜索商品"
                    isLabelHidden
                    placeholder="搜索 ID、名称、类目、品牌…"
                    value={query}
                    onChange={setQuery}
                    startIcon={MagnifyingGlassIcon}
                  />
                  <Text type="supporting" color="secondary">
                    显示 {visibleProducts.length} / {data.products.length}
                  </Text>
                  <Divider />
                  <Grid columns={{ minWidth: 280, max: 2 }} gap={3}>
                    {visibleProducts.map((product) => (
                      <Card key={product.product_id} padding={4}>
                        <VStack gap={2}>
                          <HStack gap={2} hAlign="between" vAlign="start">
                            <VStack gap={0.5}>
                              <Text type="body" weight="bold">
                                {product.name}
                              </Text>
                              <Text type="supporting" color="secondary">
                                {product.product_id}
                              </Text>
                            </VStack>
                            <Text type="body" weight="bold">
                              ¥{yuan(product.price_cents)}
                            </Text>
                          </HStack>
                          <Text type="supporting" color="secondary">
                            {product.category} · 库存 {product.stock}
                          </Text>
                          <HStack gap={1} wrap="wrap">
                            {product.tags.map((tag) => (
                              <Badge
                                key={tag}
                                variant="neutral"
                                label={tag}
                              />
                            ))}
                          </HStack>
                        </VStack>
                      </Card>
                    ))}
                  </Grid>
                </VStack>
              </Section>
            ) : (
              <Grid columns={{ minWidth: 260, max: 3 }} gap={3}>
                {data.profiles.map((profile) => (
                  <Card key={profile.user_id} padding={4}>
                    <VStack gap={3}>
                      <VStack gap={1}>
                        <Text type="body" weight="bold">
                          {profile.display_name}{" "}
                          <Text type="supporting" color="secondary" as="span">
                            {profile.profile_label}
                          </Text>
                        </Text>
                        <Text type="supporting" color="secondary">
                          {profile.user_id} · {profile.segment}
                        </Text>
                      </VStack>
                      <VStack gap={1}>
                        <Text type="supporting" color="secondary">
                          偏好类目
                        </Text>
                        <Text type="body">
                          {profile.preferred_categories.join("、") || "无"}
                        </Text>
                      </VStack>
                      <VStack gap={1}>
                        <Text type="supporting" color="secondary">
                          预算
                        </Text>
                        <Text type="body">
                          ¥{yuan(profile.min_price_cents)} – ¥
                          {yuan(profile.max_price_cents)}
                        </Text>
                      </VStack>
                    </VStack>
                  </Card>
                ))}
              </Grid>
            )}
          </VStack>
        </LayoutContent>
      }
    />
  );
}
