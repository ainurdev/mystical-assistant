import { Fragment, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as RPointerEvent, type ReactNode } from "react";
import { rightBodyW, rbody } from "../lib/shell";
import { clampRightW, moveTo } from "../lib/rail";

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

/** USAGE's icon: what's left of its login's window, as a ring the rail icons'
 *  size. Grey-green while there's room, the warn tone under a quarter. */
export function RailRing({ left }: { left: number }) {
  const r = 7.6, c = 2 * Math.PI * r, low = left < 25;
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden style={{ flex: "none" }}>
      <circle cx="9" cy="9" r={r} fill="none" stroke="color-mix(in srgb, var(--txl) 30%, transparent)" strokeWidth="2.2" />
      <circle cx="9" cy="9" r={r} fill="none" strokeWidth="2.2" strokeLinecap="round" transform="rotate(-90 9 9)"
        stroke={low ? "var(--warn)" : "color-mix(in srgb, var(--ok) 80%, var(--txm))"}
        strokeDasharray={`${(Math.max(0, Math.min(100, left)) / 100) * c} ${c}`} />
    </svg>
  );
}

export interface PanelTab {
  id: string;
  label: string; // the tab's name; what it says right now goes in `hint`
  icon: ReactNode;
  // The rail prints under a tile's icon only what wants you (/design-first
  // right-rail-shell: "too much number"). Every other number lives in the
  // tooltip's `hint`, so a calm rail is just its icons.
  // Something to act on, in the accent: ↑4 to publish, 2 new.
  badge?: string | null;
  // The badge in the warn tone instead: a meter running out (USAGE).
  low?: boolean;
  // Something this tab is about is broken (the castle's, while a Rivendell link
  // is down — App.tsx): the tile goes red and prints !. Wins over the rest.
  alert?: boolean;
  // A turn of the open session is blocked on you (TURNS): the tile glows in the
  // theme's waits-on-you colour (--ask) and prints ASK. Open or shut alike.
  ask?: boolean;
  // Something runs for this tab unasked (the GIT tab's auto-fetch): an orbit
  // around the icon, the user's own working-indicator shape.
  busy?: boolean;
  // "session" | "project" | "you": a short rule where the rail moves from one
  // to the next, so you can see which tabs follow the session you open.
  group?: string;
  // The tooltip's second line: what the tab would print if the rail printed numbers.
  hint?: string;
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
 *  (App's grid track hardcodes the same number — change both).
 *
 *  The rail is live but quiet (/design-first right-rail-shell): a tile prints
 *  under its icon only what wants you (ASK, ↑4, 2 new, !), in that thing's
 *  tone; every other number waits in the tooltip, with the tab's ⌥ key. Short
 *  rules split the tabs that follow the session from the project's and yours.
 *  Tiles drag to a new order and the panel's left seam drags to a new width;
 *  App keeps both (lib/rail). */
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
  onReorder,
  onResize,
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
  /** A tile was dragged to a new place: every tab id, in the rail's new order. */
  onReorder?: (ids: string[]) => void;
  /** The panel's left seam was dragged to this width; 0 = back to the layout's own (double-click). */
  onResize?: (px: number) => void;
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
  // Drag a tile to move it. A press only turns into a drag past 5px, so a click
  // still opens its tab; the click a drag ends on is swallowed. The rail
  // re-orders live under the pointer and hands the order up on release.
  const drag = useRef<{ id: string; y0: number; on: boolean } | null>(null);
  const dragged = useRef(false);
  const [order, setOrder] = useState<string[] | null>(null);
  const list = order ? order.map((id) => tabs.find((t) => t.id === id)).filter((t): t is PanelTab => !!t) : tabs;
  const dragMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d || !railRef.current || (!d.on && Math.abs(e.clientY - d.y0) < 5)) return;
    d.on = true;
    const ids = list.map((t) => t.id);
    const above = [...railRef.current.querySelectorAll<HTMLElement>("[data-tab]")]
      .filter((el) => el.dataset.tab !== d.id && el.getBoundingClientRect().top + el.offsetHeight / 2 < e.clientY).length;
    const next = moveTo(ids, ids.indexOf(d.id), above);
    if (next.join() !== ids.join()) setOrder(next);
  };
  const dragEnd = () => {
    const d = drag.current;
    drag.current = null;
    if (d?.on) { dragged.current = true; if (order) onReorder?.(order); }
    setOrder(null);
  };
  // The panel's left seam: drag it and the body follows the pointer through
  // `--rbody` on the grid itself (no re-render per move, the column transition
  // off while it lasts); the width settles into settings on release.
  const bodyRef = useRef<HTMLDivElement>(null);
  const startResize = (e: RPointerEvent<HTMLDivElement>) => {
    const grid = e.currentTarget.closest<HTMLElement>(".hudgrid");
    const body = bodyRef.current;
    if (e.button !== 0 || !grid || !body || !onResize) return;
    e.preventDefault();
    // Captured, so the release lands here wherever the pointer is; a press that
    // never moved saves nothing, so a click (or a double-click's first half)
    // doesn't pin the width the layout would otherwise scale.
    const grip = e.currentTarget;
    grip.setPointerCapture(e.pointerId);
    const x0 = e.clientX, w0 = body.getBoundingClientRect().width;
    let w: number | null = null;
    grid.dataset.resizing = "";
    const move = (ev: PointerEvent) => { w = clampRightW(w0 + x0 - ev.clientX); grid.style.setProperty("--rbody", rbody(w)); };
    const end = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("lostpointercapture", end);
      delete grid.dataset.resizing;
      if (w !== null) onResize(w);
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("lostpointercapture", end);
  };
  return (
    <div className="relative flex min-h-0 min-w-0 justify-end overflow-hidden">
      {open && shown && onResize && (
        <div className="rpane-grip" role="separator" aria-orientation="vertical" aria-label="Panel width"
          title="drag to resize · double-click to reset" onPointerDown={startResize} onDoubleClick={() => onResize(0)} />
      )}
      {shown && (
        // ponytail: the key remounts the body per tab and scope — that drops
        // the previous session's rows, so nothing stale survives the swap.
        <div
          ref={bodyRef}
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
        {list.map((t, i) => {
          const on = open && t.id === current?.id;
          const word = t.alert ? "!" : t.ask ? "ASK" : t.badge || null;
          const tone = t.alert ? "err" : t.ask ? "ask" : t.badge ? (t.low ? "warn" : "acc") : undefined;
          const key = i < 9 ? `  ⌥${i + 1}` : "";
          return (
            <Fragment key={t.id}>
              {i > 0 && t.group !== list[i - 1].group && <span className="rail-rule" aria-hidden />}
              <button
                data-tab={t.id}
                data-tone={tone}
                data-tip-side="left"
                data-drag={order && drag.current?.id === t.id ? "" : undefined}
                data-ctx-type="railtab"
                data-ctx-id={t.id}
                data-ctx-label={t.label}
                onClick={() => { if (dragged.current) { dragged.current = false; return; } onTab(t.id); }}
                onPointerDown={(e) => {
                  dragged.current = false;
                  if (e.button !== 0 || !onReorder) return;
                  drag.current = { id: t.id, y0: e.clientY, on: false };
                  e.currentTarget.setPointerCapture(e.pointerId);
                }}
                onPointerMove={dragMove}
                onPointerUp={dragEnd}
                onPointerCancel={dragEnd}
                title={[t.label + key, t.hint, on ? "click to collapse" : ""].filter(Boolean).join("\n")}
                aria-label={t.hint ? `${t.label}, ${t.hint}` : t.label}
                aria-current={on}
                className={`rtile relative flex h-[46px] flex-col items-center justify-start gap-[3px] border-l-2 pt-[11px] text-[length:var(--t13)] hover:bg-accent ${
                  on
                    ? "border-primary bg-[var(--ac-06)] text-foreground-bright"
                    : "border-transparent text-muted-2 hover:text-primary"
                }`}
              >
                <span className="rtile-ico">{t.icon}{t.busy && <span className="rail-orbit" aria-hidden />}</span>
                {word && <span className="rtile-v">{word}</span>}
              </button>
            </Fragment>
          );
        })}
        {railFoot && <div className="rail-well flex flex-col items-stretch">{railFoot}</div>}
      </div>
    </div>
  );
}
