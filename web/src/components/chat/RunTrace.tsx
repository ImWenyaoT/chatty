import type { RunUsage } from "@/lib/api-client";

const TRACE_LABELS: Record<string, string> = {
  request_parsing: "理解需求",
  get_user_profile: "读取用户画像",
  search_products: "搜索商品",
  check_inventory: "确认库存",
  retrieve_knowledge: "检索知识",
  get_marketing_strategy: "读取营销策略",
  response_generation: "生成回答",
  evidence_validation: "校验 Evidence",
};

const tokenNumber = new Intl.NumberFormat("zh-CN");

export function RunTrace({
  trace,
  latencyMs,
  usage,
}: {
  trace: string[];
  latencyMs: number;
  usage: RunUsage;
}) {
  return (
    <details className="rounded-lg border border-[var(--color-border)] bg-[var(--color-muted)]/40 px-3 py-2 text-sm open:bg-[var(--color-card)]">
      <summary className="cursor-pointer text-[var(--color-muted-foreground)]">
        完成 · {(latencyMs / 1000).toFixed(1)}s · {usage.model_requests} 次
        Model · {tokenNumber.format(usage.total_tokens)} tokens
      </summary>
      <ol className="mt-3 space-y-1.5 border-t border-[var(--color-border)] pt-3">
        {trace.map((step, index) => (
          <li key={step} className="flex gap-2 text-[var(--color-foreground)]">
            <span className="w-5 shrink-0 text-xs text-[var(--color-muted-foreground)]">
              {index + 1}.
            </span>
            <span>{TRACE_LABELS[step] ?? step}</span>
          </li>
        ))}
      </ol>
      <p className="mt-2 text-xs text-[var(--color-muted-foreground)]">
        Input {tokenNumber.format(usage.input_tokens)} · Output{" "}
        {tokenNumber.format(usage.output_tokens)} tokens
      </p>
    </details>
  );
}
