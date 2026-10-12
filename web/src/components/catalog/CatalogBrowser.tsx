import { useEffect, useMemo, useState } from "react";
import { Search } from "lucide-react";
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
      <div className="p-5">
        <p className="rounded-lg border border-[var(--color-destructive)]/40 px-3 py-2 text-[var(--color-destructive)]">
          {error}
        </p>
      </div>
    );
  }

  if (!data) {
    return (
      <p className="p-5 text-sm text-[var(--color-muted-foreground)]">
        正在读取 SQLite…
      </p>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="border-b border-[var(--color-border)] px-4 py-3 sm:px-5">
        <h2 className="text-sm font-semibold">SQLite 数据</h2>
        <p className="text-xs text-[var(--color-muted-foreground)]">
          运行时查询结果的只读快照，不是直接读 JSONL。
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4 sm:px-5">
        <Tabs defaultValue="products" className="space-y-4">
          <TabsList>
            <TabsTrigger value="products">
              商品 {data.products.length}
            </TabsTrigger>
            <TabsTrigger value="profiles">
              画像 {data.profiles.length}
            </TabsTrigger>
          </TabsList>

          <TabsContent value="products" className="space-y-3">
            <div className="relative">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-[var(--color-muted-foreground)]" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="搜索 ID、名称、类目、品牌…"
                className="pl-9"
              />
            </div>
            <p className="text-xs text-[var(--color-muted-foreground)]">
              显示 {visibleProducts.length} / {data.products.length}
            </p>

            <div className="grid gap-3 sm:hidden">
              {visibleProducts.map((product) => (
                <article
                  key={product.product_id}
                  className="rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-3"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div>
                      <p className="font-medium">{product.name}</p>
                      <p className="font-mono text-xs text-[var(--color-muted-foreground)]">
                        {product.product_id}
                      </p>
                    </div>
                    <p className="tabular-nums">¥{yuan(product.price_cents)}</p>
                  </div>
                  <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">
                    {product.category} · 库存 {product.stock}
                  </p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {product.tags.map((tag) => (
                      <Badge key={tag} variant="outline">
                        {tag}
                      </Badge>
                    ))}
                  </div>
                </article>
              ))}
            </div>

            <div className="hidden overflow-x-auto rounded-xl border border-[var(--color-border)] sm:block">
              <table className="w-full min-w-[52rem] text-left text-sm">
                <thead className="sticky top-0 bg-[var(--color-muted)] text-[var(--color-muted-foreground)]">
                  <tr>
                    <th className="px-3 py-2.5 font-medium">ID</th>
                    <th className="px-3 py-2.5 font-medium">名称</th>
                    <th className="px-3 py-2.5 font-medium">类目</th>
                    <th className="px-3 py-2.5 font-medium">价格</th>
                    <th className="px-3 py-2.5 font-medium">库存</th>
                    <th className="px-3 py-2.5 font-medium">标签</th>
                  </tr>
                </thead>
                <tbody>
                  {visibleProducts.map((product) => (
                    <tr
                      key={product.product_id}
                      className="border-t border-[var(--color-border)]"
                    >
                      <td className="px-3 py-2.5 font-mono text-xs">
                        {product.product_id}
                      </td>
                      <td className="px-3 py-2.5">{product.name}</td>
                      <td className="px-3 py-2.5">{product.category}</td>
                      <td className="px-3 py-2.5 tabular-nums">
                        ¥{yuan(product.price_cents)}
                      </td>
                      <td className="px-3 py-2.5">{product.stock}</td>
                      <td className="px-3 py-2.5">
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
            <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
              {data.profiles.map((profile) => (
                <article
                  key={profile.user_id}
                  className="rounded-xl border border-[var(--color-border)] bg-[var(--color-card)] p-4"
                >
                  <p className="font-medium">
                    {profile.display_name}
                    <span className="ml-2 text-sm font-normal text-[var(--color-muted-foreground)]">
                      {profile.profile_label}
                    </span>
                  </p>
                  <p className="mt-1 font-mono text-xs text-[var(--color-muted-foreground)]">
                    {profile.user_id} · {profile.segment}
                  </p>
                  <dl className="mt-3 space-y-1.5 text-sm">
                    <div>
                      <dt className="text-[var(--color-muted-foreground)]">
                        偏好类目
                      </dt>
                      <dd>{profile.preferred_categories.join("、") || "无"}</dd>
                    </div>
                    <div>
                      <dt className="text-[var(--color-muted-foreground)]">
                        预算
                      </dt>
                      <dd className="tabular-nums">
                        ¥{yuan(profile.min_price_cents)} – ¥
                        {yuan(profile.max_price_cents)}
                      </dd>
                    </div>
                  </dl>
                </article>
              ))}
            </div>
          </TabsContent>
        </Tabs>
      </div>
    </div>
  );
}
