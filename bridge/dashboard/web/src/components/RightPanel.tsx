import type { ReactNode } from "react";

export interface PanelTab {
  id: string;
  label: string;
  icon: string;
  badge?: string | null;
  render: () => ReactNode;
}

/** Right sidebar: the panel body plus a VS Code-style activity bar of icons on
 *  the outer edge. The bar is always visible — clicking the active icon
 *  collapses the body, any other icon opens on that tab. */
export function RightPanel({
  tabs,
  activeId,
  open,
  onTab,
}: {
  tabs: PanelTab[];
  activeId: string;
  open: boolean;
  onTab: (id: string) => void;
}) {
  const current = tabs.find((t) => t.id === activeId) ?? tabs[0];
  return (
    <div className="flex min-h-0 min-w-0 gap-[13px]">
      {open && (
        <div className="mscroll flex min-h-0 min-w-0 flex-1 flex-col gap-[13px] pr-0.5">
          {current?.render()}
        </div>
      )}
      <div
        className="panel flex w-[30px] flex-none flex-col items-stretch gap-1 border border-border bg-panel py-1.5"
        style={{ animation: "enterRight .55s cubic-bezier(.2,.8,.2,1) both .12s" }}
      >
        {tabs.map((t) => {
          const on = open && t.id === current?.id;
          return (
            <button
              key={t.id}
              onClick={() => onTab(t.id)}
              title={on ? `${t.label} — click to collapse` : t.label}
              aria-label={t.label}
              aria-current={on}
              className={`relative flex h-[30px] items-center justify-center border-l-2 text-[13px] hover:bg-accent ${
                on
                  ? "border-primary bg-[var(--ac-06)] text-foreground-bright"
                  : "border-transparent text-muted-2 hover:text-primary"
              }`}
            >
              {t.icon}
              {t.badge ? (
                <span className="absolute right-0 top-0 text-[7px] leading-none text-primary">●</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
