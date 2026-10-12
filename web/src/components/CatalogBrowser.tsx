import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  ApiError,
  explain,
  fetchCatalogData,
  type CatalogData,
} from "@/lib/api-client";
import { yuan } from "@/lib/format";

export function CatalogBrowser() {
  const [data, setData] = useState<CatalogData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");

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

  if (error) {
    return (
      <p className="rounded-md border border-[var(--color-destructive)] px-3 py-2 text-[var(--color-destructive)]">
        {error}
      </p>
    );
  }
  if (!data) {
    return (
      <p className="text-sm text-[var(--color-muted-foreground)]">
        正在读取 SQLite…
      </p>
    );
  }

  const normalizedQuery = query.trim().toLowerCase();
  const visibleProducts = data.products.filter((product) => {
    if (!normalizedQuery) return true;
    return [
      product.product_id,
      product.name,
      product.category,
      product.brand,
      ...product.tags,
    ].some((value) => value.toLowerCase().includes(normalizedQuery));
  });

  return (
    <section aria-label="SQLite 数据浏览" className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold">SQLite 数据</h2>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          只读展示运行时实际查询的数据，不直接读取 JSONL。
        </p>
      </div>

      <Tabs defaultValue="products">
        <TabsList>
          <TabsTrigger value="products">商品 {data.products.length}</TabsTrigger>
          <TabsTrigger value="profiles">
            用户画像 {data.profiles.length}
          </TabsTrigger>
        </TabsList>

        <TabsContent value="products" className="space-y-3">
          <Input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索商品 ID、名称、类目、品牌…"
          />
          <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
            <table className="w-full min-w-[48rem] text-left text-sm">
              <thead className="bg-[var(--color-muted)] text-[var(--color-muted-foreground)]">
                <tr>
                  <th className="px-3 py-2">ID</th>
                  <th className="px-3 py-2">名称</th>
                  <th className="px-3 py-2">类目</th>
                  <th className="px-3 py-2">价格</th>
                  <th className="px-3 py-2">库存</th>
                  <th className="px-3 py-2">标签</th>
                </tr>
              </thead>
              <tbody>
                {visibleProducts.map((product) => (
                  <tr
                    key={product.product_id}
                    className="border-t border-[var(--color-border)]"
                  >
                    <td className="px-3 py-2 font-mono text-xs">
                      {product.product_id}
                    </td>
                    <td className="px-3 py-2">{product.name}</td>
                    <td className="px-3 py-2">{product.category}</td>
                    <td className="px-3 py-2">¥{yuan(product.price_cents)}</td>
                    <td className="px-3 py-2">{product.stock}</td>
                    <td className="px-3 py-2">
                      <div className="flex flex-wrap gap-1">
                        {product.tags.map((tag) => (
                          <Badge key={tag} variant="outline">
                            {tag}
                          </Badge>
                        ))}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </TabsContent>

        <TabsContent value="profiles">
          <div className="grid gap-3 md:grid-cols-2">
            {data.profiles.map((profile) => (
              <div
                key={profile.user_id}
                className="rounded-lg border border-[var(--color-border)] p-4"
              >
                <p className="font-medium">
                  {profile.display_name} · {profile.profile_label}
                </p>
                <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
                  {profile.user_id} · {profile.segment}
                </p>
                <p className="mt-3 text-sm">
                  偏好类目：{profile.preferred_categories.join("、") || "无"}
                </p>
                <p className="text-sm">
                  预算：¥{yuan(profile.min_price_cents)} – ¥
                  {yuan(profile.max_price_cents)}
                </p>
              </div>
            ))}
          </div>
        </TabsContent>
      </Tabs>
    </section>
  );
}
