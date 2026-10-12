import { Database, MessageSquareText } from "lucide-react";
import { cn } from "@/lib/utils";

export type AppView = "chat" | "data";

type AppShellProps = {
  view: AppView;
  onViewChange: (view: AppView) => void;
  summary: string;
  sidebarExtra?: React.ReactNode;
  children: React.ReactNode;
};

const navItems: { id: AppView; label: string; hint: string; icon: typeof MessageSquareText }[] = [
  { id: "chat", label: "对话", hint: "推荐与问答", icon: MessageSquareText },
  { id: "data", label: "数据", hint: "SQLite 只读", icon: Database },
];

export function AppShell({
  view,
  onViewChange,
  summary,
  sidebarExtra,
  children,
}: AppShellProps) {
  return (
    <div className="mx-auto flex h-dvh max-w-7xl flex-col md:flex-row md:gap-0 md:p-4 lg:p-6">
      <aside className="border-b border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-sidebar)_88%,transparent)] backdrop-blur-sm md:flex md:w-64 md:shrink-0 md:flex-col md:rounded-2xl md:border md:border-[var(--color-border)] lg:w-72">
        <div className="flex items-center justify-between gap-3 px-4 py-4 md:block md:px-5 md:py-6">
          <div>
            <p className="font-[family-name:var(--font-display)] text-2xl font-semibold tracking-tight text-[var(--color-primary)]">
              Chatty
            </p>
            <p className="mt-1 max-w-[16rem] text-xs leading-relaxed text-[var(--color-muted-foreground)]">
              {summary}
            </p>
          </div>
          <nav
            aria-label="主要功能"
            className="flex gap-1 md:mt-6 md:flex-col md:gap-1"
          >
            {navItems.map((item) => {
              const Icon = item.icon;
              const active = view === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onViewChange(item.id)}
                  className={cn(
                    "inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm transition-colors",
                    active
                      ? "bg-[var(--color-primary)] text-[var(--color-primary-foreground)]"
                      : "text-[var(--color-sidebar-foreground)] hover:bg-[var(--color-accent)]",
                  )}
                >
                  <Icon className="size-4 shrink-0" />
                  <span className="font-medium">{item.label}</span>
                  <span
                    className={cn(
                      "ml-auto hidden text-xs md:inline",
                      active
                        ? "text-[color-mix(in_srgb,var(--color-primary-foreground)_75%,transparent)]"
                        : "text-[var(--color-muted-foreground)]",
                    )}
                  >
                    {item.hint}
                  </span>
                </button>
              );
            })}
          </nav>
        </div>
        {sidebarExtra ? (
          <div className="hidden border-t border-[var(--color-border)] px-5 py-4 md:block">
            {sidebarExtra}
          </div>
        ) : null}
      </aside>

      <div className="min-h-0 min-w-0 flex-1 md:pl-4 lg:pl-6">
        <div className="flex h-full min-h-0 flex-col overflow-hidden border-[var(--color-border)] bg-[color-mix(in_srgb,var(--color-card)_92%,transparent)] shadow-sm backdrop-blur-sm md:rounded-2xl md:border">
          {children}
        </div>
      </div>
    </div>
  );
}
