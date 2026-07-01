import { useEffect, useRef, useState } from "react";

export interface Rect { x: number; y: number; w: number; h: number; }

const MIN = { w: 366, h: 420 };

function clamp(r: Rect): Rect {
  const w = Math.max(MIN.w, Math.min(r.w, window.innerWidth - 16));
  const h = Math.max(MIN.h, Math.min(r.h, window.innerHeight - 16));
  return {
    w, h,
    x: Math.min(Math.max(8, r.x), Math.max(8, window.innerWidth - 140)),
    y: Math.min(Math.max(8, r.y), Math.max(8, window.innerHeight - 80)),
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

/** Drag-move + resize a floating window, persisted to localStorage. Unlike the
 * generic FloatingWindow, this EXPOSES `rect` so the progress sidebar can dock
 * against the window's live position/size. */
export function usePreviewWindow(storageKey: string, fallback: Rect) {
  const [rect, setRect] = useState<Rect>(() => load(storageKey, fallback));
  const drag = useRef<{ mode: "move" | "resize"; sx: number; sy: number; r: Rect } | null>(null);

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(rect)); } catch { /* ignore */ }
  }, [storageKey, rect]);

  useEffect(() => {
    const mv = (e: PointerEvent) => {
      const d = drag.current; if (!d) return;
      const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
      setRect(clamp(d.mode === "move"
        ? { ...d.r, x: d.r.x + dx, y: d.r.y + dy }
        : { ...d.r, w: d.r.w + dx, h: d.r.h + dy }));
    };
    const up = () => { drag.current = null; document.body.style.userSelect = ""; };
    window.addEventListener("pointermove", mv);
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointermove", mv);
      window.removeEventListener("pointerup", up);
    };
  }, []);

  const startMove = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button,input,select,textarea,a,[data-no-drag]")) return;
    drag.current = { mode: "move", sx: e.clientX, sy: e.clientY, r: rect };
    document.body.style.userSelect = "none";
  };
  const startResize = (e: React.PointerEvent) => {
    e.stopPropagation();
    drag.current = { mode: "resize", sx: e.clientX, sy: e.clientY, r: rect };
    document.body.style.userSelect = "none";
  };
  return { rect, startMove, startResize };
}
