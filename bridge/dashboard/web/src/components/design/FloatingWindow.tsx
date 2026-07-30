import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export interface Rect { x: number; y: number; w: number; h: number; }
const MIN = { w: 360, h: 300 };

function clamp(r: Rect): Rect {
  const w = Math.max(MIN.w, Math.min(r.w, window.innerWidth));
  const h = Math.max(MIN.h, Math.min(r.h, window.innerHeight));
  return {
    w, h,
    x: Math.min(Math.max(0, r.x), Math.max(0, window.innerWidth - 80)),
    y: Math.min(Math.max(0, r.y), Math.max(0, window.innerHeight - 40)),
  };
}

function load(key: string, fallback: Rect): Rect {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "");
    if (v && typeof v.x === "number" && typeof v.y === "number"
        && typeof v.w === "number" && typeof v.h === "number") return clamp(v);
  } catch { /* ignore */ }
  return clamp(fallback);
}

export function FloatingWindow({
  storageKey, defaultRect, header, onClose, children,
}: {
  storageKey: string;
  defaultRect: Rect;
  header: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const [rect, setRect] = useState<Rect>(() => load(storageKey, defaultRect));
  const drag = useRef<{ mode: "move" | "resize"; sx: number; sy: number; r: Rect } | null>(null);

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(rect)); } catch { /* ignore */ }
  }, [storageKey, rect]);

  const onMove = useCallback((e: PointerEvent) => {
    const d = drag.current; if (!d) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    setRect(clamp(d.mode === "move"
      ? { ...d.r, x: d.r.x + dx, y: d.r.y + dy }
      : { ...d.r, w: d.r.w + dx, h: d.r.h + dy }));
  }, []);
  const onUp = useCallback(() => { drag.current = null; }, []);

  useEffect(() => {
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [onMove, onUp]);

  const startMove = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button,input,select,a,textarea,[data-no-drag]")) return;
    drag.current = { mode: "move", sx: e.clientX, sy: e.clientY, r: rect };
  };
  const startResize = (e: React.PointerEvent) => {
    e.stopPropagation();
    drag.current = { mode: "resize", sx: e.clientX, sy: e.clientY, r: rect };
  };

  return (
    <div style={{ position: "fixed", left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: 60, display: "flex", flexDirection: "column", border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)", background: "color-mix(in srgb, var(--panel2) 94%, transparent)", boxShadow: "0 18px 60px var(--shadow-pop)" }}>
      <div onPointerDown={startMove}
        style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", cursor: "move", flex: "none", borderBottom: "1px solid color-mix(in srgb, var(--acc) 15%, transparent)", userSelect: "none" }}>
        {header}
        <button data-no-drag onClick={onClose} title="Close"
          style={{ marginLeft: "auto", appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--err) 40%, transparent)", background: "transparent", color: "var(--err)", fontFamily: "inherit", fontSize: 11, lineHeight: 1, padding: "3px 8px" }}>✕</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {children}
      </div>
      <div onPointerDown={startResize} title="Drag to resize"
        style={{ position: "absolute", right: 0, bottom: 0, width: 16, height: 16, cursor: "nwse-resize", background: "linear-gradient(135deg,transparent 45%,color-mix(in srgb, var(--acc) 55%, transparent) 45%)" }} />
    </div>
  );
}
