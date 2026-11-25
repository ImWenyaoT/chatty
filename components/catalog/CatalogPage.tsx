"use client";

import { useEffect, useState } from "react";
import { Text } from "@astryxdesign/core/Text";

import { CatalogBrowser } from "@/components/catalog/CatalogBrowser";
import { ChattyShell } from "@/components/layout/ChattyShell";
import {
  ApiError,
  explain,
  fetchCatalog,
  type CatalogInfo,
} from "@/lib/api-client";

export function CatalogPage() {
  const [info, setInfo] = useState<CatalogInfo | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        setInfo(await fetchCatalog());
      } catch (error: unknown) {
        // 目录页仍可打开；摘要失败时降级文案。
        setInfo(null);
        console.error(
          explain(error instanceof ApiError ? error.code : "invalid_response"),
        );
      }
    })();
  }, []);

  const catalogSummary =
    info === null
      ? "SQLite 只读浏览"
      : `${info.product_count} 件商品 · ${info.categories.length} 类目`;

  return (
    <ChattyShell
      view="catalog"
      summary={catalogSummary}
      sidebarExtra={
        <Text type="supporting" color="secondary">
          数据页只读，不会修改 SQLite。
        </Text>
      }
    >
      <CatalogBrowser />
    </ChattyShell>
  );
}
