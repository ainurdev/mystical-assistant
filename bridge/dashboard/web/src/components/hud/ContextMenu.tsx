import { useState } from "react";

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
  onClick?: () => void;
}

const TYPE_LABEL: Record<string, string> = {
  session: "SESSION", project: "PROJECT", issue: "ISSUE",
  branch: "BRANCH", terminal: "TERMINAL", surface: "DASHBOARD",
  file: "FILE", folder: "FOLDER",
};

// A short hint ("TOP", "⌘K") rides on the title's row; a prose one would eat
// the whole 216px and leave no room for the title, so it drops to its own line.
const stacked = (it: CtxItem) => !!it.hint && it.hint.length > 8;

/* CONTEXT MENU — matches the HUD design mock (hud.dc.html lines 1544–1567):
   header (diamond + type + label) and item rows with icon/label/hint. */
export function ContextMenu({ ctx, items, closing, onClose }: {
  ctx: CtxState;
  items: CtxItem[];
  closing?: boolean;
  onClose: () => void;
}) {
  const [hov, setHov] = useState(-1);
  const W = 216;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // Clamped to the viewport — the list scrolls when it doesn't fit.
  // ~26 hint chars fit per wrapped line at this width; each line adds ~12px.
  const H = Math.min(44 + items.reduce((h, it) =>
    h + (it.divider ? 9 : stacked(it) ? 30 + 12 * Math.ceil(it.hint!.length / 26) : 30), 0), vh - 12);
  const x = Math.max(6, Math.min(ctx.x, vw - W - 8));
  const y = Math.max(6, Math.min(ctx.y, vh - H - 8));
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 96 }} />
      <div data-ctxmenu="1"
        style={{ position: "fixed", left: x, top: y, zIndex: 97, width: W, border: "1px solid color-mix(in srgb, var(--acc) 40%, transparent)", background: "color-mix(in srgb, var(--panel2) 98%, transparent)", boxShadow: "0 12px 44px var(--shadow-pop),0 0 26px color-mix(in srgb, var(--acc) 8%, transparent)", transformOrigin: "top", animation: closing ? "ctxOut .165s ease both" : "ctxIn .28s cubic-bezier(.16,.84,.3,1) both" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "8px 11px", borderBottom: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)" }}>
          <span style={{ width: 6, height: 6, background: "var(--acc)", transform: "rotate(45deg)", flex: "none" }} />
          <span style={{ fontSize: 8, letterSpacing: 1.5, color: "var(--txl)", flex: "none" }}>{TYPE_LABEL[ctx.type] || "DASHBOARD"}</span>
          <span style={{ fontSize: 10, color: "var(--tx)", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ctx.label || "all surfaces"}</span>
        </div>
        <div className="mscroll" style={{ padding: "4px 0", maxHeight: vh - 56, overflowY: "auto" }}>
          {items.map((it, i) =>
            it.divider ? (
              <div key={i} style={{ height: 1, background: "color-mix(in srgb, var(--acc) 12%, transparent)", margin: "4px 0" }} />
            ) : (
              <button key={i} onClick={() => { it.onClick?.(); onClose(); }}
                onMouseEnter={() => setHov(i)} onMouseLeave={() => setHov(-1)}
                style={{ width: "100%", appearance: "none", cursor: "pointer", border: 0, background: hov === i ? (it.danger ? "color-mix(in srgb, var(--err) 10%, transparent)" : "color-mix(in srgb, var(--acc) 8%, transparent)") : "transparent", color: it.danger ? "#cf9387" : "var(--txh)", fontFamily: "inherit", fontSize: 11, letterSpacing: ".3px", textAlign: "left", display: "flex", alignItems: "center", gap: 10, padding: "7px 12px" }}>
                <span style={{ width: 13, textAlign: "center", color: it.danger ? "var(--err)" : "var(--acc)", flex: "none", fontSize: 11 }}>{it.icon}</span>
                <span style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: stacked(it) ? "column" : "row", alignItems: stacked(it) ? "stretch" : "center", gap: stacked(it) ? 2 : 10 }}>
                  <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.label}</span>
                  {it.hint && <span style={{ fontSize: 8.5, letterSpacing: 1, lineHeight: 1.35, color: "var(--txl)", flex: "none", whiteSpace: stacked(it) ? "normal" : "nowrap" }}>{it.hint}</span>}
                </span>
              </button>
            ),
          )}
        </div>
      </div>
    </>
  );
}
