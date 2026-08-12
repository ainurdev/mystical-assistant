import { useRef, type ReactNode } from "react";

export interface PanelTab {
  id: string;
  label: string;
  icon: ReactNode;
  badge?: string | null;
  // Panel owns its scroller — the wrapper must not add a second one.
  ownScroll?: boolean;
  // Panel's WHOLE body is one session's data — "project" for the repo-wide
  // ones, "worktree" for the ones whose data is per-branch (two worktrees of
  // the same repo are different trees). Switching outside that scope rebuilds
  // the panel, so nothing of the previous session survives the refetch. Leave
  // it unset for a panel that spans sessions or holds state worth keeping
  // (a reading position, a typed search) — a rebuild would throw that away.
  scope?: "project" | "worktree";
  render: () => ReactNode;
}

const TAB_ANIM = "enterRight .55s cubic-bezier(.2,.8,.2,1) both";

/** Right sidebar: the panel body plus a VS Code-style activity bar of icons on
 *  the outer edge. The bar is always visible — clicking the active icon
 *  collapses the body, any other icon opens on that tab. */
export function RightPanel({
  tabs,
  activeId,
  open,
  onTab,
  project,
  branch,
}: {
  tabs: PanelTab[];
  activeId: string;
  open: boolean;
  onTab: (id: string) => void;
  /** The open session's project and branch — what a scoped tab's data belongs to. */
  project?: string | null;
  branch?: string | null;
}) {
  const current = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const scope = current?.scope === "worktree" ? `${project ?? ""}@${branch ?? ""}`
    : current?.scope === "project" ? project ?? ""
    : "";
  // Two different events land on the same element and must not look alike. A
  // TAB change is the panel arriving from the rail, so the panel slides in. A
  // SCOPE change is the same panel already sitting there, now showing another
  // session's data — the frame has not gone anywhere, so it must not move:
  // `data-swap` hands the motion to the parts inside that actually changed
  // (.swapin in index.css) and leaves the frame alone.
  // Decided once per key and held: a re-render must not re-pick this, or the
  // inline animation-name flips and replays on a panel that has sat still for
  // seconds.
  const tabId = current?.id ?? "";
  const bodyKey = `${tabId}:${scope}`;
  const shown = useRef({ tab: "", key: "", swap: false });
  if (shown.current.key !== bodyKey) {
    shown.current = { tab: tabId, key: bodyKey, swap: shown.current.key !== "" && shown.current.tab === tabId };
  }
  return (
    <div className="flex min-h-0 min-w-0 gap-[13px]">
      {open && (
        // ponytail: the key is what replays the entry — remounting also drops
        // the previous session's rows, so nothing stale survives the swap.
        <div
          key={bodyKey}
          data-swap={shown.current.swap ? "" : undefined}
          className={`flex min-h-0 min-w-0 flex-1 flex-col gap-[13px] pr-0.5 ${current?.ownScroll ? "" : "mscroll"}`}
          style={{ animation: shown.current.swap ? undefined : TAB_ANIM }}
        >
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
              className={`relative flex h-[30px] items-center justify-center border-l-2 text-[length:var(--t13)] hover:bg-accent ${
                on
                  ? "border-primary bg-[var(--ac-06)] text-foreground-bright"
                  : "border-transparent text-muted-2 hover:text-primary"
              }`}
            >
              {t.icon}
              {/* The badge is drawn as given — a dot for "is there anything",
                  a number when the count is the point (unread lessons). */}
              {t.badge ? (
                <span className="absolute right-0 top-0 text-[length:var(--t7)] leading-none text-primary">{t.badge}</span>
              ) : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
