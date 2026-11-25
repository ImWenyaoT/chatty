"use client";

import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/Stack";
import type { Product } from "@/lib/api-client";
import { yuan } from "@/lib/format";
import { ProductCard } from "@/components/catalog/ProductCard";

export function ProductTable({ products }: { products: Product[] }) {
  return (
    <>
      <div className="chatty-product-cards">
        <VStack gap={3}>
          {products.map((product) => (
            <ProductCard key={product.product_id} {...product} />
          ))}
        </VStack>
      </div>
      <div className="chatty-product-table">
        <table style={{ width: "100%", borderCollapse: "collapse", textAlign: "left" }}>
          <thead>
            <tr>
              <th>
                <Text type="supporting" color="secondary">
                  商品
                </Text>
              </th>
              <th>
                <Text type="supporting" color="secondary">
                  价格
                </Text>
              </th>
              <th>
                <Text type="supporting" color="secondary">
                  库存
                </Text>
              </th>
              <th>
                <Text type="supporting" color="secondary">
                  理由 / 文案
                </Text>
              </th>
            </tr>
          </thead>
          <tbody>
            {products.map((product) => (
              <tr key={product.product_id}>
                <td style={{ paddingBlock: "0.75rem", verticalAlign: "top" }}>
                  <VStack gap={0.5}>
                    <Text type="body" weight="bold">
                      {product.name}
                    </Text>
                    <Text type="supporting" color="secondary">
                      {product.product_id} · {product.brand}
                    </Text>
                  </VStack>
                </td>
                <td style={{ paddingBlock: "0.75rem", whiteSpace: "nowrap", verticalAlign: "top" }}>
                  <Text type="body">¥{yuan(product.price_cents)}</Text>
                </td>
                <td style={{ paddingBlock: "0.75rem", whiteSpace: "nowrap", verticalAlign: "top" }}>
                  <Text type="body">
                    {product.low_stock ? "紧张" : "有货"}
                  </Text>
                </td>
                <td style={{ paddingBlock: "0.75rem", verticalAlign: "top" }}>
                  <VStack gap={1}>
                    <Text type="body">{product.reason}</Text>
                    <Text type="supporting" color="secondary">
                      {product.marketing_copy}
                    </Text>
                  </VStack>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <style>{`
        .chatty-product-table { display: none; }
        @media (min-width: 768px) {
          .chatty-product-cards { display: none; }
          .chatty-product-table { display: block; overflow-x: auto; }
        }
      `}</style>
    </>
  );
}
