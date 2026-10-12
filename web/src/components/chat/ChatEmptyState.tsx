import type { CatalogInfo } from "@/lib/api-client";
import { Button } from "@/components/ui/button";

const EXAMPLES = [
  "想买个降噪耳机，2000 以内",
  "七天无理由怎么退？",
  "有没有适合通勤的键盘？",
];

export function ChatEmptyState({
  info,
  onExample,
}: {
  info: CatalogInfo;
  onExample: (text: string) => void;
}) {
  return (
    <section className="mx-auto flex max-w-xl flex-col items-start gap-5 px-1 py-8 sm:py-12">
      <div className="space-y-2">
        <h2 className="font-[family-name:var(--font-display)] text-2xl font-semibold tracking-tight sm:text-3xl">
          用大白话说需求
        </h2>
        <p className="text-sm text-[var(--color-muted-foreground)] sm:text-base">
          Chatty 会先理解约束，再查库存与知识，最后给出可核验的推荐或政策回答。
        </p>
      </div>

      <div className="w-full space-y-2">
        <p className="text-xs font-medium tracking-wide text-[var(--color-muted-foreground)] uppercase">
          试试这些
        </p>
        <div className="flex flex-col gap-2">
          {EXAMPLES.map((example) => (
            <Button
              key={example}
              type="button"
              variant="outline"
              className="h-auto justify-start whitespace-normal px-3 py-2.5 text-left font-normal"
              onClick={() => onExample(example)}
            >
              {example}
            </Button>
          ))}
        </div>
      </div>

      <p className="text-xs leading-relaxed text-[var(--color-muted-foreground)]">
        类目：{info.categories.join("、")}。换演示用户再问同样的话，能看出画像影响。
      </p>
    </section>
  );
}
