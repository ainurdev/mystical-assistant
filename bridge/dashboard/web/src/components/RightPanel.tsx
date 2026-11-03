import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { rightBodyW } from "../lib/shell";

const still = () => matchMedia("(prefers-reduced-motion: reduce)").matches;

/** True from the moment `open` flips until the column has finished moving —
 *  .hudgrid's 0.26s transition (index.css) plus slack: a late end costs
 *  nothing, an early one cuts the shut. App keeps the panel drawn and the
 *  column pinned for that long. Reduced motion snaps the column, so it skips. */
export function useSettling(open: boolean): boolean {
  const [was, setWas] = useState(open);
  const [moving, setMoving] = useState(false);
  // Set during render, not in an effect: an effect would commit one frame of
  // the shut panel unmounted, and its remount would refetch from empty.
  if (was !== open) { setWas(open); if (!still()) setMoving(true); }
  useEffect(() => {
    if (!moving) return;
    const t = window.setTimeout(() => setMoving(false), 300);
    return () => window.clearTimeout(t);
  }, [moving, open]);
  return moving;
}

export interface PanelTab {
  id: string;
  label: string;
  icon: ReactNode;
  badge?: string | null;
  // A red dot instead of a count: something this tab is about is broken (the
  // castle's, while a Rivendell link is down — App.tsx). Shows on every tab.
  alert?: boolean;
  // A dot in the theme's waits-on-you colour (--ask): a turn of the open
  // session is blocked on you (TURNS). Shows open or shut, like the others.
  ask?: boolean;
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

/** What a tab's body belongs to, as one string. Remount on a change and the
 *  previous session's rows go with it — which is the whole point of `scope`.
 *  Shared with the CANVAS pins, so a pinned panel and the sidebar's own copy
 *  agree on when they are looking at something else. */
export function scopeKey(tab: PanelTab, project?: string | null, branch?: string | null): string {
  const scope = tab.scope === "worktree" ? `${project ?? ""}@${branch ?? ""}`
    : tab.scope === "project" ? project ?? ""
    : "";
  return `${tab.id}:${scope}`;
}

/** Right sidebar: the panel body plus a VS Code-style activity bar of icons on
 *  the outer edge. The bar is always visible — clicking the active icon
 *  collapses the body, any other icon opens on that tab.
 *
 *  The panel is a column of the layout, so it moves like one (/design-first
 *  "right-rail-motion", A · DOCK): nothing in it slides, fades or flashes on
 *  open or shut. The body states its own width rather than filling the column
 *  — `rightBodyW`, the same constant App's grid track is built from — and the
 *  row clips (justify-end overflows at the start), so while the track animates
 *  the column's edge sweeps over a panel that stays pinned to the rail, and
 *  only the transcript reflows. `shown` outlives `open` by that sweep, so a
 *  shut covers the panel instead of dropping it into an empty band; App pins
 *  the cap above the same way. Collapsed, the track is the rail's 48px alone
 *  (App's grid track hardcodes the same number — change both). */
export function RightPanel({
  tabs,
  activeId,
  open,
  shown = open,
  onTab,
  project,
  branch,
  railFoot,
  railHead,
}: {
  tabs: PanelTab[];
  activeId: string;
  open: boolean;
  /** The body is drawn: open, or still being covered by the shutting column (useSettling). */
  shown?: boolean;
  onTab: (id: string) => void;
  /** The open session's project and branch — what a scoped tab's data belongs to. */
  project?: string | null;
  branch?: string | null;
  /** Pinned to the rail's foot, under the tabs — the changelog, the platform's UPDATE and ⌘K. */
  railFoot?: ReactNode;
  /** Over the tabs: the Linux window's own buttons (LinuxControls), ruled off from them. */
  railHead?: ReactNode;
}) {
  const current = tabs.find((t) => t.id === activeId) ?? tabs[0];
  // A key change inside a panel that is already out is one of two events, and
  // neither moves the frame (its divider, its corner, the rail stay put). A
  // TAB change swaps what's in it: `data-tabswap` fades the new tab's content
  // up (.paneswap). A SCOPE change is the same tab on another session's data:
  // `data-swap` hands the motion to the parts that changed (.swapin). A body
  // mounting because the panel opens gets neither — the sweep is its motion.
  // Decided once per key and held: a re-render must not re-pick this, or the
  // animation flips and replays on a panel that has sat still for seconds.
  const tabId = current?.id ?? "";
  const bodyKey = current ? scopeKey(current, project, branch) : "";
  const seen = useRef({ tab: "", key: "", shown: false, swap: "" as "" | "tab" | "scope" });
  if (seen.current.key !== bodyKey || seen.current.shown !== shown) {
    const was = seen.current;
    const moved = was.shown && shown && was.key !== "" && was.key !== bodyKey;
    seen.current = { tab: tabId, key: bodyKey, shown, swap: moved ? (was.tab === tabId ? "scope" : "tab") : "" };
  }
  // The open tab's tile glides from the tab it leaves, so the eye follows the
  // switch. Every theme draws that tile its own way (a wash and a 2px bar, a
  // rounded fill, a pill), so the glide borrows what this one drew: a span
  // wearing the new tab's computed fill rides from the old tab's place while
  // the button's own fill waits. Nothing is left behind at rest.
  const railRef = useRef<HTMLDivElement>(null);
  const lit = open ? tabId : "";
  const litWas = useRef(lit);
  useLayoutEffect(() => {
    const from = litWas.current;
    litWas.current = lit;
    const rail = railRef.current;
    if (!rail || !from || !lit || from === lit || still()) return;
    const a = rail.querySelector<HTMLElement>(`[data-tab="${from}"]`);
    const b = rail.querySelector<HTMLElement>(`[data-tab="${lit}"]`);
    if (!a || !b) return;
    // Transition off before reading: PEBBLE fades the fill in, and mid-fade
    // the computed fill is still transparent. Important throughout, to outrank
    // the themes' own !important fills.
    b.style.setProperty("transition", "none", "important");
    const cs = getComputedStyle(b);
    const tile = document.createElement("span");
    Object.assign(tile.style, {
      position: "absolute", zIndex: "-1", pointerEvents: "none", boxSizing: "border-box",
      left: `${b.offsetLeft}px`, top: `${b.offsetTop}px`, width: `${b.offsetWidth}px`, height: `${b.offsetHeight}px`,
      background: cs.backgroundColor, borderRadius: cs.borderRadius,
      borderLeft: `${cs.borderLeftWidth} ${cs.borderLeftStyle} ${cs.borderLeftColor}`,
    });
    rail.insertBefore(tile, b);
    b.style.setProperty("background", "transparent", "important");
    b.style.setProperty("border-left-color", "transparent", "important");
    const glide = tile.animate([{ transform: `translateY(${a.offsetTop - b.offsetTop}px)` }, { transform: "none" }],
      { duration: 180, easing: "cubic-bezier(.2,.8,.2,1)" });
    const done = () => {
      tile.remove();
      b.style.removeProperty("background");
      b.style.removeProperty("border-left-color");
      void b.offsetWidth; // the fill returns under transition:none, then the transition does
      b.style.removeProperty("transition");
    };
    glide.onfinish = done;
    return () => { glide.cancel(); done(); };
  }, [lit]);
  return (
    <div className="flex min-h-0 min-w-0 justify-end overflow-hidden">
      {shown && (
        // ponytail: the key remounts the body per tab and scope — that drops
        // the previous session's rows, so nothing stale survives the swap.
        <div
          key={bodyKey}
          data-swap={seen.current.swap === "scope" ? "" : undefined}
          data-tabswap={seen.current.swap === "tab" ? "" : undefined}
          className={`shellcol flex min-h-0 flex-none flex-col border-l border-border ${current?.ownScroll ? "" : "mscroll"}`}
          style={{ width: rightBodyW }}
        >
          {current?.render()}
        </div>
      )}
      <div
        ref={railRef}
        className="relative flex w-[48px] flex-none flex-col items-stretch gap-1 border-l border-border py-2.5"
        style={{ background: "var(--panel3)", isolation: "isolate", animation: "enterRight .55s cubic-bezier(.2,.8,.2,1) both .12s" }}
      >
        {railHead && <div className="mb-1 flex flex-col items-stretch border-b border-border pb-1">{railHead}</div>}
        {tabs.map((t) => {
          const on = open && t.id === current?.id;
          return (
            <button
              key={t.id}
              data-tab={t.id}
              onClick={() => onTab(t.id)}
              title={on ? `${t.label} — click to collapse` : t.label}
              aria-label={t.label}
              aria-current={on}
              className={`relative flex h-[38px] items-center justify-center border-l-2 text-[length:var(--t13)] hover:bg-accent ${
                on
                  ? "border-primary bg-[var(--ac-06)] text-foreground-bright"
                  : "border-transparent text-muted-2 hover:text-primary"
              }`}
            >
              {t.icon}
              {/* A filled pill, not bare text in the corner: at --t7 on the
                  scanlined rail an accent-on-panel digit was invisible, and
                  anchored at right-0/top-0 a two-digit count clipped on the
                  window edge. Callers cap the string (see railCount). */}
              {t.badge ? (
                <span
                  className="absolute right-[3px] top-[1px] h-[15px] min-w-[15px] rounded-full px-[3px] text-center text-[length:var(--t7)] leading-[15px]"
                  style={{ background: "var(--acc)", color: "var(--acc-on)" }}
                >{t.badge}</span>
              ) : null}
              {t.alert || t.ask ? (
                <span className="absolute right-[5px] top-[4px] h-[8px] w-[8px] rounded-full"
                  style={{ background: t.alert ? "var(--err)" : "var(--ask, var(--warn))", boxShadow: `0 0 6px ${t.alert ? "var(--err)" : "var(--ask, var(--warn))"}` }} />
              ) : null}
            </button>
          );
        })}
        {railFoot && <div className="mt-auto flex flex-col items-stretch">{railFoot}</div>}
      </div>
    </div>
  );
}
