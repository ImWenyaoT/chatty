import type { Product } from "@/lib/api-client";
import { yuan } from "@/lib/format";
import { ProductCard } from "@/components/catalog/ProductCard";

export function ProductTable({ products }: { products: Product[] }) {
  return (
    <>
      <div className="grid gap-3 md:hidden">
        {products.map((product) => (
          <ProductCard key={product.product_id} {...product} />
        ))}
      </div>
      <div className="hidden overflow-x-auto rounded-xl border border-[var(--color-border)] md:block">
        <table className="w-full min-w-[40rem] text-left text-sm">
          <thead className="bg-[var(--color-muted)] text-[var(--color-muted-foreground)]">
            <tr>
              <th className="px-3 py-2.5 font-medium">商品</th>
              <th className="px-3 py-2.5 font-medium">价格</th>
              <th className="px-3 py-2.5 font-medium">库存</th>
              <th className="px-3 py-2.5 font-medium">理由 / 文案</th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => (
              <tr
                key={product.product_id}
                className="border-t border-[var(--color-border)] align-top"
              >
                <td className="px-3 py-3">
                  <div className="font-medium">{product.name}</div>
                  <div className="font-mono text-xs text-[var(--color-muted-foreground)]">
                    {product.product_id} · {product.brand}
                  </div>
                </td>
                <td className="px-3 py-3 whitespace-nowrap tabular-nums">
                  ¥{yuan(product.price_cents)}
                </td>
                <td className="px-3 py-3 whitespace-nowrap">
                  {product.low_stock ? "紧张" : "有货"}
                </td>
                <td className="px-3 py-3">
                  <p>{product.reason}</p>
                  <p className="mt-1 text-[var(--color-muted-foreground)]">
                    {product.marketing_copy}
                  </p>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
