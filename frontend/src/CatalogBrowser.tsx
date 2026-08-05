import { useEffect, useState } from "react";
import {
  ApiError,
  explain,
  fetchCatalogData,
  type CatalogData,
  type CatalogProduct,
  type CatalogProfile,
} from "./api";

const yuan = (cents: number) => (cents / 100).toFixed(2);

export default function CatalogBrowser() {
  const [data, setData] = useState<CatalogData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<"products" | "profiles">("products");
  const [query, setQuery] = useState("");

  useEffect(() => {
    const load = async () => {
      try {
        setData(await fetchCatalogData());
      } catch (caught: unknown) {
        if (caught instanceof ApiError) {
          setError(explain(caught.code));
        } else {
          console.error("unexpected catalog data error", caught);
          setError(explain("invalid_response"));
        }
      }
    };

    void load();
  }, []);

  if (error) return <p className="bubble error">{error}</p>;
  if (!data) return <p className="thinking">正在读取 SQLite…</p>;

  const normalizedQuery = query.trim().toLowerCase();
  const visibleProducts = data.products.filter((product) => {
    if (!normalizedQuery) return true;
    const searchable = [
      product.product_id,
      product.name,
      product.category,
      product.brand,
      ...product.tags,
    ];
    return searchable.some((value) =>
      value.toLowerCase().includes(normalizedQuery),
    );
  });

  return (
    <section className="catalog-browser" aria-label="SQLite 数据浏览">
      <div className="catalog-heading">
        <div>
          <h2>SQLite 数据</h2>
          <p className="hint">
            只读展示运行时实际查询的数据，不直接读取 JSONL。
          </p>
        </div>
        <div className="section-tabs" aria-label="数据类型">
          <button
            type="button"
            className={section === "products" ? "tab active" : "tab"}
            onClick={() => setSection("products")}
          >
            商品 {data.products.length}
          </button>
          <button
            type="button"
            className={section === "profiles" ? "tab active" : "tab"}
            onClick={() => setSection("profiles")}
          >
            用户画像 {data.profiles.length}
          </button>
        </div>
      </div>

      {section === "products" ? (
        <ProductTable
          products={visibleProducts}
          query={query}
          onQueryChange={setQuery}
        />
      ) : (
        <ProfileTable profiles={data.profiles} />
      )}
    </section>
  );
}

function ProductTable({
  products,
  query,
  onQueryChange,
}: {
  products: CatalogProduct[];
  query: string;
  onQueryChange: (value: string) => void;
}) {
  return (
    <>
      <label className="catalog-search">
        <span>筛选商品</span>
        <input
          type="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="名称、类目、品牌或标签"
        />
      </label>
      <p className="hint">当前显示 {products.length} 条</p>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>ID</th>
              <th>商品</th>
              <th>类目</th>
              <th className="numeric">价格</th>
              <th className="numeric">库存</th>
              <th>标签</th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => (
              <tr key={product.product_id}>
                <td className="id">{product.product_id}</td>
                <td>
                  <strong>{product.name}</strong>
                  <span className="cell-detail">{product.brand}</span>
                </td>
                <td>{product.category}</td>
                <td className="numeric">¥{yuan(product.price_cents)}</td>
                <td
                  className={
                    product.stock === 0 ? "out-of-stock numeric" : "numeric"
                  }
                >
                  {product.stock}
                </td>
                <td>{product.tags.join(" · ")}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {products.length === 0 ? <p className="empty">没有匹配的商品。</p> : null}
    </>
  );
}

function ProfileTable({ profiles }: { profiles: CatalogProfile[] }) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>演示用户</th>
            <th>画像类型</th>
            <th>偏好类目</th>
            <th>价格范围</th>
            <th>最近浏览</th>
          </tr>
        </thead>
        <tbody>
          {profiles.map((profile) => (
            <tr key={profile.user_id}>
              <td>
                <strong>{profile.display_name}</strong>
                <span className="cell-detail id">{profile.user_id}</span>
              </td>
              <td>{profile.profile_label}</td>
              <td>{profile.preferred_categories.join(" · ") || "—"}</td>
              <td className="numeric">
                ¥{yuan(profile.min_price_cents)}–¥
                {yuan(profile.max_price_cents)}
              </td>
              <td>{profile.recent_views.join(" · ") || "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
