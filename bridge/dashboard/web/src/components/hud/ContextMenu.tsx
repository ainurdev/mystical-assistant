import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface CtxState {
  x: number;
  y: number;
  type: string; // session | project | branch | terminal | surface
  id: string;
  label: string;
}

export interface CtxItem {
  divider?: boolean;
  icon?: string;
  label?: string;
  hint?: string;
  danger?: boolean;
  children?: CtxItem[]; // a section — its own menu opens beside this row
  onClick?: () => void;
  keep?: boolean; // the menu stays open after the click (a switch, a checklist)
  disabled?: boolean; // drawn dim and refuses the click, so rows never come and go under the pointer
  on?: boolean; // draws a switch at the row's end, lit when true
  section?: string; // a small heading row that never acts; `hint` rides on its right
  checks?: CtxCheck[]; // a two-column checklist; every click keeps the menu open
}

export interface CtxCheck {
  label: string;
  on: boolean;
  locked?: boolean; // shown, but the click is refused (the last tab on the rail)
  onClick: () => void;
}

const TYPE_LABEL: Record<string, string> = {
  session: "SESSION", project: "PROJECT", issue: "ISSUE",
  branch: "BRANCH", terminal: "TERMINAL", surface: "DASHBOARD",
  file: "FILE", folder: "FOLDER", turn: "MESSAGE", editor: "EDITOR", task: "TASK", railtab: "RAIL TAB",
};

// A short hint ("TOP", "⌘K") rides on the title's row; a prose one would eat
// the whole 216px and leave no room for the title, so it drops to its own line.
const stacked = (it: CtxItem) => !!it.hint && it.hint.length > 8;

const W0 = 216;
// ~26 hint chars fit per wrapped line at this width; each line adds ~12px.
export const menuH = (items: CtxItem[], chrome: number) => chrome + items.reduce((h, it) =>
  h + (it.divider ? 9 : it.section ? 22 : it.checks ? 8 + 24 * Math.ceil(it.checks.length / 2)
    : stacked(it) ? 30 + 12 * Math.ceil(it.hint!.length / 26) : 30), 0);

const LIT = "color-mix(in srgb, var(--acc) 40%, transparent)";
function Switch({ on }: { on: boolean }) {
  return (
    <span aria-hidden style={{ flex: "none", position: "relative", width: 22, height: 12, border: `1px solid ${LIT}`,
      background: on ? "color-mix(in srgb, var(--acc) 14%, transparent)" : "transparent" }}>
      <span style={{ position: "absolute", top: 2, left: on ? 12 : 2, width: 6, height: 6, background: on ? "var(--acc)" : "var(--txl)",
        transition: "left .15s ease" }} />
    </span>
  );
}

function Checks({ checks }: { checks: CtxCheck[] }) {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0 6px", padding: "2px 12px 6px" }}>
      {checks.map((c) => (
        <button key={c.label} role="menuitemcheckbox" aria-checked={c.on} aria-disabled={c.locked || undefined}
          title={c.locked ? "the last tab on the rail stays" : undefined}
          onClick={() => { if (!c.locked) c.onClick(); }}
          style={{ appearance: "none", border: 0, background: "transparent", fontFamily: "inherit", fontSize: "var(--t10)", letterSpacing: 0, height: 24,
            display: "flex", alignItems: "center", gap: 7, padding: "0 2px", textAlign: "left", minWidth: 0,
            cursor: c.locked ? "default" : "pointer", color: c.on ? "var(--txh)" : "var(--txl)" }}>
          <span aria-hidden style={{ flex: "none", width: 11, height: 11, border: `1px solid ${LIT}`, display: "grid", placeItems: "center",
            fontSize: 9, fontWeight: 800, lineHeight: 1, color: "var(--acc-on)", background: c.on ? "var(--acc)" : "transparent", opacity: c.locked ? 0.5 : 1 }}>
            {c.on ? "✓" : ""}
          </span>
          <span style={{ minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{c.label}</span>
        </button>
      ))}
    </div>
  );
}

const PANEL: React.CSSProperties = {
  position: "fixed",
  border: "1px solid color-mix(in srgb, var(--acc) 40%, transparent)",
  background: "color-mix(in srgb, var(--panel2) 98%, transparent)",
  boxShadow: "0 12px 44px var(--shadow-pop),0 0 26px color-mix(in srgb, var(--acc) 8%, transparent)",
  transformOrigin: "top",
};

function Rows({ items, active, onClose, onRow }: {
  items: CtxItem[];
  active?: number;
  onClose: () => void;
  onRow?: (i: number, it: CtxItem, el: HTMLElement) => void;
}) {
  const [hov, setHov] = useState(-1);
  return (
    <>
      {items.map((it, i) =>
        it.divider ? (
          <div key={i} style={{ height: 1, background: "color-mix(in srgb, var(--acc) 12%, transparent)", margin: "4px 0" }} />
        ) : it.section ? (
          <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "7px 12px 2px", fontSize: "var(--t8)", letterSpacing: 1.5, color: "var(--txl)" }}>
            <span style={{ flex: 1 }}>{it.section}</span>
            {it.hint && <span style={{ fontStyle: "italic", letterSpacing: 0 }}>{it.hint}</span>}
          </div>
        ) : it.checks ? (
          <Checks key={i} checks={it.checks} />
        ) : (
          <button key={i}
            // A section row never acts — clicking it opens its menu, same as hovering,
            // which is the only way in on a touchscreen.
            onClick={(e) => {
              if (it.children) { onRow?.(i, it, e.currentTarget); return; }
              if (it.disabled) return;
              it.onClick?.(); if (!it.keep) onClose();
            }}
            role={it.on !== undefined ? "menuitemcheckbox" : "menuitem"} aria-checked={it.on} aria-disabled={it.disabled || undefined}
            onMouseEnter={(e) => { setHov(i); onRow?.(i, it, e.currentTarget); }}
            onMouseLeave={() => setHov(-1)}
            style={{ width: "100%", appearance: "none", border: 0, background: hov === i || active === i ? (it.danger ? "color-mix(in srgb, var(--err) 10%, transparent)" : "color-mix(in srgb, var(--acc) 8%, transparent)") : "transparent", color: it.danger ? "#cf9387" : "var(--txh)", opacity: it.disabled ? 0.4 : 1, cursor: it.disabled ? "default" : "pointer", fontFamily: "inherit", fontSize: "var(--t11)", letterSpacing: ".3px", textAlign: "left", display: "flex", alignItems: "center", gap: 10, padding: "7px 12px" }}>
            <span style={{ width: 13, textAlign: "center", color: it.danger ? "var(--err)" : "var(--acc)", flex: "none", fontSize: "var(--t11)" }}>{it.icon}</span>
            <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: stacked(it) ? "column" : "row", alignItems: stacked(it) ? "stretch" : "center", gap: stacked(it) ? 2 : 10 }}>
              <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.label}</span>
              {it.hint && <span style={{ fontSize: "var(--t85)", letterSpacing: 1, lineHeight: 1.35, color: "var(--txl)", flex: "none", whiteSpace: stacked(it) ? "normal" : "nowrap" }}>{it.hint}</span>}
            </span>
            {it.on !== undefined && <Switch on={it.on} />}
            {it.children && <span style={{ flex: "none", color: "var(--acc)", fontSize: "var(--t10)" }}>▸</span>}
          </button>
        ),
      )}
    </>
  );
}

/* CONTEXT MENU — matches the HUD design mock (hud.dc.html lines 1544–1567):
   header (diamond + type + label) and item rows with icon/label/hint. Items
   carrying `children` are sections: their menu opens beside the row.

   Portalled to <body> because the whole thing is positioned `fixed` against the
   viewport: any ancestor with a transform (the rail's slide-in animations, for
   one) becomes the containing block instead, and the menu lands hundreds of
   pixels off-screen. Mounting outside the tree is the only way `fixed` means
   what it says wherever a panel decides to open one.

   A right click while a menu is open closes it and leaves the event to the
   browser, so its own menu (copy, inspect, spellcheck) is one more click away.
   Handled here because every menu is this component, and in the capture phase
   on window because the row handlers that open menus stop propagation and call
   preventDefault: they must not see this click, or it opens a menu of ours.
   isTrusted: Strip, Terminal and BranchesPanel dispatch synthetic contextmenus
   to open menus from a left click, and those aren't the user's second click.
   The press goes through the scrim as well, or the browser's menu would be for
   the scrim, with no copy or open-link for what's under the pointer. It
   hit-tests when contextmenu fires, which is after pointerdown everywhere.
   ponytail: ctrl+click on a Mac has no button 2, so that native menu opens on
   the scrim, and is the page's rather than the element's. */
export function ContextMenu({ ctx, items, closing, onClose, width: W = W0 }: {
  ctx: CtxState;
  items: CtxItem[];
  closing?: boolean;
  onClose: () => void;
  width?: number; // a menu with a checklist wants more than the usual 216px
}) {
  const [sub, setSub] = useState<{ i: number; top: number } | null>(null);
  const shut = useRef(0);
  useEffect(() => () => clearTimeout(shut.current), []);

  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (closing) return;
    const press = (e: PointerEvent) => {
      if (e.button !== 2 || !e.isTrusted || !root.current) return;
      root.current.style.pointerEvents = "none";
    };
    // A release with no contextmenu after it (let go outside the window on a
    // system that fires on release) mustn't leave a menu that clicks pass under.
    const release = (e: PointerEvent) => {
      if (e.button !== 2) return;
      window.setTimeout(() => { if (root.current) root.current.style.pointerEvents = ""; }, 300);
    };
    const secondClick = (e: MouseEvent) => {
      if (!e.isTrusted) return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("pointerdown", press, true);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("contextmenu", secondClick, true);
    return () => {
      window.removeEventListener("pointerdown", press, true);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("contextmenu", secondClick, true);
    };
  }, [closing, onClose]);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Clamped to the viewport — the list scrolls when it doesn't fit.
  const H = Math.min(menuH(items, 44), vh - 12);
  const x = Math.max(6, Math.min(ctx.x, vw - W - 8));
  const y = Math.max(6, Math.min(ctx.y, vh - H - 8));

  // Leaving a section only schedules the close: the trip to the submenu is
  // diagonal, so it crosses rows that would otherwise slam the door.
  const onRow = (i: number, it: CtxItem, el: HTMLElement) => {
    clearTimeout(shut.current);
    if (it.children) setSub({ i, top: el.getBoundingClientRect().top - 5 });
    else shut.current = window.setTimeout(() => setSub(null), 180);
  };

  const open = sub && items[sub.i]?.children ? { ...sub, items: items[sub.i].children! } : null;
  const subH = open ? Math.min(menuH(open.items, 8), vh - 12) : 0;
  const subX = x + W + W0 - 1 > vw - 8 ? x - W0 + 1 : x + W - 1;
  const subY = Math.max(6, Math.min(open?.top ?? 0, vh - subH - 8));

  return createPortal(
    <div ref={root} style={{ display: "contents" }}>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 96 }} />
      <div data-ctxmenu="1"
        style={{ ...PANEL, width: W, ...(W !== W0 && { "--ctx-w": `${W}px` }), left: x, top: y, zIndex: 97, animation: closing ? "ctxOut .165s ease both" : "ctxIn .28s cubic-bezier(.16,.84,.3,1) both" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "8px 11px", borderBottom: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)" }}>
          <span style={{ width: 6, height: 6, background: "var(--acc)", transform: "rotate(45deg)", flex: "none" }} />
          <span style={{ fontSize: "var(--t8)", letterSpacing: 1.5, color: "var(--txl)", flex: "none" }}>{TYPE_LABEL[ctx.type] || ctx.type.toUpperCase()}</span>
          <span style={{ fontSize: "var(--t10)", color: "var(--tx)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ctx.label || "all surfaces"}</span>
        </div>
        <div role="menu" className="mscroll" style={{ padding: "4px 0", maxHeight: vh - 56, overflowY: "auto" }}>
          <Rows items={items} active={sub?.i} onClose={onClose} onRow={onRow} />
        </div>
      </div>
      {open && !closing && (
        <div data-ctxmenu="1" onMouseEnter={() => clearTimeout(shut.current)}
          style={{ ...PANEL, width: W0, left: subX, top: subY, zIndex: 98, animation: "ctxIn .18s cubic-bezier(.16,.84,.3,1) both" }}>
          {/* Clamped to what's left below the submenu's own top, not the whole
              viewport — menuH only estimates wrapped hints, so a long section
              (More, with a relocate row per worktree) otherwise runs off the
              bottom edge instead of scrolling. */}
          <div role="menu" className="mscroll" style={{ padding: "4px 0", maxHeight: vh - subY - 16, overflowY: "auto" }}>
            <Rows items={open.items} onClose={onClose} />
          </div>
        </div>
      )}
    </div>,
    document.body,
  );
}
