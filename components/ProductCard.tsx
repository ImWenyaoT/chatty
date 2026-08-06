/** 单个商品卡。价格与库存来自 SQLite，本组件只负责显示。 */
import type { RecommendedProduct } from "../data/models.ts";
import { yuan } from "../lib/format.ts";

export default function ProductCard(product: RecommendedProduct) {
  let stockClassName = "";
  let stockLabel = "有货";
  if (product.low_stock) {
    stockClassName = "low";
    stockLabel = "库存紧张";
  }

  return (
    <article className="card">
      <div className="card-head">
        <span className="name">{product.name}</span>
        <span className="price">¥{yuan(product.price_cents)}</span>
      </div>
      <p className="meta">
        <span className="id">{product.product_id}</span>
        <span>{product.brand}</span>
        <span className={stockClassName}>{stockLabel}</span>
        {product.tags.map((tag) => (
          <span key={tag} className="tag">
            {tag}
          </span>
        ))}
      </p>
      <p className="reason">{product.reason}</p>
      <p className="copy">{product.marketing_copy}</p>
    </article>
  );
}
