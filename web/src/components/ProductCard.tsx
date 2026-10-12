import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { Product } from "@/lib/api-client";
import { yuan } from "@/lib/format";

export function ProductCard(product: Product) {
  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-3 space-y-0">
        <div className="min-w-0">
          <p className="font-medium leading-snug">{product.name}</p>
          <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">
            {product.product_id} · {product.brand}
          </p>
        </div>
        <p className="shrink-0 text-base font-semibold">
          ¥{yuan(product.price_cents)}
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex flex-wrap gap-1.5">
          <Badge variant={product.low_stock ? "danger" : "secondary"}>
            {product.low_stock ? "库存紧张" : "有货"}
          </Badge>
          {product.tags.map((tag) => (
            <Badge key={tag} variant="outline">
              {tag}
            </Badge>
          ))}
        </div>
        <p className="text-sm">{product.reason}</p>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          {product.marketing_copy}
        </p>
      </CardContent>
    </Card>
  );
}
