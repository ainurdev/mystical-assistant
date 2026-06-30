import { useCallback, useEffect, useRef, useState } from "react";

export interface Pos { x: number; y: number; }

function clamp(p: Pos): Pos {
  return {
    x: Math.min(Math.max(0, p.x), Math.max(0, window.innerWidth - 60)),
    y: Math.min(Math.max(0, p.y), Math.max(0, window.innerHeight - 40)),
  };
}

function load(key: string, fallback: Pos): Pos {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "");
    if (v && typeof v.x === "number" && typeof v.y === "number") return clamp(v);
  } catch { /* ignore */ }
  return clamp(fallback);
}

/** Drag a fixed-position element by a handle, persisting its position. Returns
 * the position and an onPointerDown to attach to the drag handle. Pointer-downs
 * on interactive children (button/input/etc. or [data-no-drag]) don't drag. */
export function useDraggable(storageKey: string, defaultPos: Pos) {
  const [pos, setPos] = useState<Pos>(() => load(storageKey, defaultPos));
  const drag = useRef<{ sx: number; sy: number; px: number; py: number } | null>(null);

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(pos)); } catch { /* ignore */ }
  }, [storageKey, pos]);

  const onMove = useCallback((e: PointerEvent) => {
    const d = drag.current; if (!d) return;
    setPos(clamp({ x: d.px + (e.clientX - d.sx), y: d.py + (e.clientY - d.sy) }));
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

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button,input,select,a,textarea,[data-no-drag]")) return;
    drag.current = { sx: e.clientX, sy: e.clientY, px: pos.x, py: pos.y };
  };

  return { pos, onPointerDown };
}
