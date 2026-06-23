import { useState, type ReactNode } from "react";

export interface PanelTab {
  id: string;
  label: string;
  badge?: string | null;
  render: () => ReactNode;
}

export function RightPanel({
  tabs,
  activeId,
  onActiveChange,
}: {
  tabs: PanelTab[];
  activeId?: string;
  onActiveChange?: (id: string) => void;
}) {
  const [internal, setInternal] = useState(tabs[0]?.id);
  const active = activeId ?? internal;
  const setActive = (id: string) => {
    setInternal(id);
    onActiveChange?.(id);
  };
  const current = tabs.find((t) => t.id === active) ?? tabs[0];
  return (
    <aside className="flex min-h-0 w-[372px] shrink-0 flex-col border-l border-panel-border bg-panel">
      <div className="flex shrink-0 gap-0.5 border-b border-border px-3 pt-2.5">
        {tabs.map((t) => {
          const on = t.id === current?.id;
          return (
            <button
              key={t.id}
              onClick={() => setActive(t.id)}
              className={`flex items-center gap-1.5 rounded-t-lg border-b-2 px-3 py-2 text-[12.5px] font-medium ${
                on
                  ? "border-brand-soft text-foreground"
                  : "border-transparent text-muted-foreground hover:text-foreground"
              }`}
            >
              {t.label}
              {t.badge ? (
                <span className="rounded-md bg-primary/15 px-1.5 font-mono text-[10px] text-brand-soft">
                  {t.badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{current?.render()}</div>
    </aside>
  );
}
