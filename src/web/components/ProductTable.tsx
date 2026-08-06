/** 多商品并排对比。字段与 ProductCard 同源，只是换一种排布。 */
import type { RecommendedProduct } from "../../data/models.ts";

import { yuan } from "../format.ts";

export default function ProductTable({
  products,
}: {
  products: RecommendedProduct[];
}) {
  return (
    <table className="compare">
      <thead>
        <tr>
          <th>商品</th>
          <th>价格</th>
          <th>库存</th>
          <th>推荐理由</th>
        </tr>
      </thead>
      <tbody>
        {products.map((product) => (
          <tr key={product.product_id}>
            <td>
              <strong>{product.name}</strong>
              <span className="id">{product.product_id}</span>
            </td>
            <td>¥{yuan(product.price_cents)}</td>
            <td className={product.low_stock ? "low" : ""}>
              {product.low_stock ? "库存紧张" : "有货"}
            </td>
            <td>{product.reason}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
