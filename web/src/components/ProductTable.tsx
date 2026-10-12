import type { Product } from "@/lib/api-client";
import { yuan } from "@/lib/format";

export function ProductTable({ products }: { products: Product[] }) {
  return (
    <div className="overflow-x-auto rounded-lg border border-[var(--color-border)]">
      <table className="w-full min-w-[36rem] text-left text-sm">
        <thead className="bg-[var(--color-muted)] text-[var(--color-muted-foreground)]">
          <tr>
            <th className="px-3 py-2 font-medium">商品</th>
            <th className="px-3 py-2 font-medium">价格</th>
            <th className="px-3 py-2 font-medium">库存</th>
            <th className="px-3 py-2 font-medium">理由</th>
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
                <div className="text-xs text-[var(--color-muted-foreground)]">
                  {product.product_id} · {product.brand}
                </div>
              </td>
              <td className="px-3 py-3 whitespace-nowrap">
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
  );
}
