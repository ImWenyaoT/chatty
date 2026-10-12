import { ProductCard } from "@/components/catalog/ProductCard";
import { ProductTable } from "@/components/catalog/ProductTable";
import { RunTrace } from "@/components/chat/RunTrace";
import type { ChatEntry } from "@/components/chat/types";
import { explain } from "@/lib/api-client";

export function ChatEntryView({ entry }: { entry: ChatEntry }) {
  switch (entry.kind) {
    case "user":
      return (
        <div className="flex justify-end">
          <p className="max-w-[min(36rem,85%)] rounded-2xl rounded-br-md bg-[var(--color-primary)] px-3.5 py-2.5 text-sm text-[var(--color-primary-foreground)] shadow-sm">
            {entry.text}
          </p>
        </div>
      );
    case "understood":
      return (
        <p className="text-xs tracking-wide text-[var(--color-muted-foreground)]">
          理解为 · {entry.text}
        </p>
      );
    case "question":
    case "answer":
      return (
        <div className="flex justify-start">
          <p className="max-w-[min(40rem,90%)] rounded-2xl rounded-bl-md border border-[var(--color-border)] bg-[var(--color-card)] px-3.5 py-2.5 text-sm shadow-sm">
            {entry.text}
          </p>
        </div>
      );
    case "error":
      return (
        <p className="rounded-lg border border-[var(--color-destructive)]/40 bg-[color-mix(in_srgb,var(--color-destructive)_8%,transparent)] px-3 py-2 text-sm text-[var(--color-destructive)]">
          {explain(entry.code)}
          <span className="ml-2 font-mono text-xs opacity-70">{entry.code}</span>
        </p>
      );
    case "run":
      return (
        <RunTrace
          trace={entry.trace}
          latencyMs={entry.latencyMs}
          usage={entry.usage}
        />
      );
    case "products":
      return (
        <section className="space-y-3">
          {entry.products.length > 1 ? (
            <ProductTable products={entry.products} />
          ) : (
            entry.products.map((product) => (
              <ProductCard key={product.product_id} {...product} />
            ))
          )}
          <p className="text-xs text-[var(--color-muted-foreground)]">
            ID、名称、价格与库存来自 SQLite 重查，并经 Evidence 校验；模型只写理由与文案。
          </p>
        </section>
      );
    default: {
      const _exhaustive: never = entry;
      return _exhaustive;
    }
  }
}
