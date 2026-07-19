import type { ReactNode } from "react";

type WorkspaceHeaderProps = {
  eyebrow: string;
  title: string;
  actions?: ReactNode;
};

/** Keeps route-level headings and actions consistent across the seller workspace. */
export function WorkspaceHeader({
  eyebrow,
  title,
  actions,
}: WorkspaceHeaderProps) {
  return (
    <header className="workspace-header">
      <div>
        <p>{eyebrow}</p>
        <h1>{title}</h1>
      </div>
      {actions ? (
        <div className="workspace-header-actions">{actions}</div>
      ) : null}
    </header>
  );
}
