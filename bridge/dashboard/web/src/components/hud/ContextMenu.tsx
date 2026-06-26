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
};

export function ContextMenu({ ctx, items, onClose }: {
  ctx: CtxState;
  items: CtxItem[];
  onClose: () => void;
}) {
  const W = 216;
  const H = 44 + items.length * 30;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const x = Math.max(6, Math.min(ctx.x, vw - W - 8));
  const y = Math.max(6, Math.min(ctx.y, vh - H - 8));
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 96 }} />
      <div data-ctxmenu="1"
        style={{ position: "fixed", left: x, top: y, zIndex: 97, width: W, border: "1px solid rgba(127,233,216,.4)", background: "rgba(7,13,13,.98)", boxShadow: "0 12px 44px rgba(0,0,0,.7),0 0 26px rgba(127,233,216,.08)", transformOrigin: "top", animation: "ctxIn .28s cubic-bezier(.16,.84,.3,1) both" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "8px 11px", borderBottom: "1px solid rgba(127,233,216,.16)" }}>
          <span style={{ width: 6, height: 6, background: "#7fe9d8", transform: "rotate(45deg)", flex: "none" }} />
          <span style={{ fontSize: 8, letterSpacing: 1.5, color: "#3c544f", flex: "none" }}>{TYPE_LABEL[ctx.type] || "DASHBOARD"}</span>
          <span style={{ fontSize: 10, color: "#bfe6de", flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{ctx.label || "all surfaces"}</span>
        </div>
        <div style={{ padding: "4px 0" }}>
          {items.map((it, i) =>
            it.divider ? (
              <div key={i} style={{ height: 1, background: "rgba(127,233,216,.12)", margin: "4px 0" }} />
            ) : (
              <button key={i} onClick={() => { it.onClick?.(); onClose(); }}
                style={{ width: "100%", appearance: "none", cursor: "pointer", border: 0, background: "transparent", color: it.danger ? "#cf9387" : "#cfe9e3", fontFamily: "inherit", fontSize: 11, letterSpacing: ".3px", textAlign: "left", display: "flex", alignItems: "center", gap: 10, padding: "7px 12px" }}
                onMouseEnter={(e) => (e.currentTarget.style.background = it.danger ? "rgba(224,137,122,.1)" : "rgba(127,233,216,.08)")}
                onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}>
                <span style={{ width: 13, textAlign: "center", color: it.danger ? "#e0897a" : "#7fe9d8", flex: "none", fontSize: 11 }}>{it.icon}</span>
                <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{it.label}</span>
                {it.hint && <span style={{ fontSize: 8.5, letterSpacing: 1, color: "#3c544f", flex: "none" }}>{it.hint}</span>}
              </button>
            ),
          )}
        </div>
      </div>
    </>
  );
}
