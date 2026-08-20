import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface CtxState {
  x: number;
  y: number;
  type: string; // session | project | issue | branch | terminal | surface
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
}

const TYPE_LABEL: Record<string, string> = {
  session: "SESSION", project: "PROJECT", issue: "ISSUE",
  branch: "BRANCH", terminal: "TERMINAL", surface: "DASHBOARD",
  file: "FILE", folder: "FOLDER", turn: "MESSAGE",
};

// A short hint ("TOP", "⌘K") rides on the title's row; a prose one would eat
// the whole 216px and leave no room for the title, so it drops to its own line.
const stacked = (it: CtxItem) => !!it.hint && it.hint.length > 8;

const W = 216;
// ~26 hint chars fit per wrapped line at this width; each line adds ~12px.
const menuH = (items: CtxItem[], chrome: number) => chrome + items.reduce((h, it) =>
  h + (it.divider ? 9 : stacked(it) ? 30 + 12 * Math.ceil(it.hint!.length / 26) : 30), 0);

const PANEL: React.CSSProperties = {
  position: "fixed", width: W,
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
        ) : (
          <button key={i}
            // A section row never acts — clicking it opens its menu, same as hovering,
            // which is the only way in on a touchscreen.
            onClick={(e) => {
              if (it.children) { onRow?.(i, it, e.currentTarget); return; }
              it.onClick?.(); onClose();
            }}
            onMouseEnter={(e) => { setHov(i); onRow?.(i, it, e.currentTarget); }}
            onMouseLeave={() => setHov(-1)}
            style={{ width: "100%", appearance: "none", cursor: "pointer", border: 0, background: hov === i || active === i ? (it.danger ? "color-mix(in srgb, var(--err) 10%, transparent)" : "color-mix(in srgb, var(--acc) 8%, transparent)") : "transparent", color: it.danger ? "#cf9387" : "var(--txh)", fontFamily: "inherit", fontSize: "var(--t11)", letterSpacing: ".3px", textAlign: "left", display: "flex", alignItems: "center", gap: 10, padding: "7px 12px" }}>
            <span style={{ width: 13, textAlign: "center", color: it.danger ? "var(--err)" : "var(--acc)", flex: "none", fontSize: "var(--t11)" }}>{it.icon}</span>
            <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: stacked(it) ? "column" : "row", alignItems: stacked(it) ? "stretch" : "center", gap: stacked(it) ? 2 : 10 }}>
              <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.label}</span>
              {it.hint && <span style={{ fontSize: "var(--t85)", letterSpacing: 1, lineHeight: 1.35, color: "var(--txl)", flex: "none", whiteSpace: stacked(it) ? "normal" : "nowrap" }}>{it.hint}</span>}
            </span>
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
   what it says wherever a panel decides to open one. */
export function ContextMenu({ ctx, items, closing, onClose }: {
  ctx: CtxState;
  items: CtxItem[];
  closing?: boolean;
  onClose: () => void;
}) {
  const [sub, setSub] = useState<{ i: number; top: number } | null>(null);
  const shut = useRef(0);
  useEffect(() => () => clearTimeout(shut.current), []);
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
  const subX = x + 2 * W - 1 > vw - 8 ? x - W + 1 : x + W - 1;
  const subY = Math.max(6, Math.min(open?.top ?? 0, vh - subH - 8));

  return createPortal(
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 96 }} />
      <div data-ctxmenu="1"
        style={{ ...PANEL, left: x, top: y, zIndex: 97, animation: closing ? "ctxOut .165s ease both" : "ctxIn .28s cubic-bezier(.16,.84,.3,1) both" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "8px 11px", borderBottom: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)" }}>
          <span style={{ width: 6, height: 6, background: "var(--acc)", transform: "rotate(45deg)", flex: "none" }} />
          <span style={{ fontSize: "var(--t8)", letterSpacing: 1.5, color: "var(--txl)", flex: "none" }}>{TYPE_LABEL[ctx.type] || "DASHBOARD"}</span>
          <span style={{ fontSize: "var(--t10)", color: "var(--tx)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ctx.label || "all surfaces"}</span>
        </div>
        <div className="mscroll" style={{ padding: "4px 0", maxHeight: vh - 56, overflowY: "auto" }}>
          <Rows items={items} active={sub?.i} onClose={onClose} onRow={onRow} />
        </div>
      </div>
      {open && !closing && (
        <div data-ctxmenu="1" onMouseEnter={() => clearTimeout(shut.current)}
          style={{ ...PANEL, left: subX, top: subY, zIndex: 98, animation: "ctxIn .18s cubic-bezier(.16,.84,.3,1) both" }}>
          {/* Clamped to what's left below the submenu's own top, not the whole
              viewport — menuH only estimates wrapped hints, so a long section
              (More, with a relocate row per worktree) otherwise runs off the
              bottom edge instead of scrolling. */}
          <div className="mscroll" style={{ padding: "4px 0", maxHeight: vh - subY - 16, overflowY: "auto" }}>
            <Rows items={open.items} onClose={onClose} />
          </div>
        </div>
      )}
    </>,
    document.body,
  );
}
