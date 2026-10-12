import { SendHorizontal } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

export function ChatComposer({
  value,
  onChange,
  onSubmit,
  busy,
  exhausted,
  onReset,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  busy: boolean;
  exhausted: boolean;
  onReset: () => void;
}) {
  return (
    <div className="border-t border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-card)_85%,transparent)] px-3 py-3 sm:px-5 sm:py-4">
      {exhausted ? (
        <p className="mb-2 text-sm text-[var(--color-muted-foreground)]">
          这段对话问到头了。
          <Button
            type="button"
            variant="link"
            className="h-auto px-1"
            onClick={onReset}
          >
            开一段新的
          </Button>
        </p>
      ) : null}
      <form
        className="flex items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <Input
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={busy ? "正在跑…" : "想买点什么，或问一条政策？"}
          disabled={busy || exhausted}
          className="min-h-11 flex-1"
          aria-label="消息"
        />
        <Button
          type="submit"
          disabled={busy || !value.trim() || exhausted}
          className="h-11 shrink-0 px-4"
        >
          <SendHorizontal className="size-4" />
          <span className="hidden sm:inline">发送</span>
        </Button>
      </form>
    </div>
  );
}
