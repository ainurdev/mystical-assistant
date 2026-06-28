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
    <div
      className="panel flex min-h-0 flex-1 flex-col border border-border bg-panel"
      style={{ animation: "boot .5s ease both .2s" }}
    >
      <div className="flex flex-none border-b border-border">
        {tabs.map((t) => {
          const on = t.id === current?.id;
          return (
            <button
              key={t.id}
              onClick={() => setActive(t.id)}
              className={`flex flex-1 items-center justify-center gap-1.5 border-b-2 px-1 py-[11px] text-[10.5px] tracking-[1.5px] hover:bg-accent ${
                on
                  ? "border-primary bg-[var(--ac-06)] text-foreground-bright"
                  : "border-transparent text-muted-2"
              }`}
            >
              {t.label.toUpperCase()}
              {t.badge ? (
                <span className="border border-[var(--border-bright)] px-[5px] text-[9px] text-primary">
                  {t.badge}
                </span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">{current?.render()}</div>
    </div>
  );
}
