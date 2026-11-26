// Zoom and pan for a drawing too big for its column (the flow diagram in components/DataView).
// The same file is in both apps.
//
// Why not CSS scroll plus a zoom factor: a scroll box can't zoom at the pointer, and on a phone
// it fights the page for the same finger. So the drawing sits in a fixed viewport and moves
// under a transform, and the gestures are the ones maps taught everyone: pinch or ctrl+wheel
// (a trackpad pinch arrives as one) zooms where the pointer is, a drag pans.
//
// In a chat the page still owns the plain wheel and a vertical finger: a diagram you scroll
// past mustn't swallow the scroll. Opened full, nothing else wants them, so the wheel pans.
//
// The arithmetic is pure and exported, so panzoom.check.ts can pin it.

import { useCallback, useEffect, useRef, useState } from "react";

export type View = { k: number; x: number; y: number };
export const MAX_K = 3;
/** How much of the drawing stays in view however far it's pushed. */
const KEEP = 60;

/** Zoom to `k` keeping the point under (px, py) where it is. */
export function zoomAt(v: View, k: number, px: number, py: number): View {
  const f = k / v.k;
  return { k, x: px - (px - v.x) * f, y: py - (py - v.y) * f };
}

/** The smallest zoom: the whole drawing fits, or a fifth of its size, whichever is smaller. */
export const minK = (w: number, h: number, vw: number, vh: number) => Math.min(0.2, vw / w, vh / h);

/** Keep the zoom in range and some of the drawing on screen. */
export function clampView(v: View, w: number, h: number, vw: number, vh: number): View {
  const k = Math.min(MAX_K, Math.max(minK(w, h, vw, vh), v.k));
  const keepX = Math.min(KEEP, (w * k) / 2), keepY = Math.min(KEEP, (h * k) / 2);
  return { k, x: Math.min(vw - keepX, Math.max(keepX - w * k, v.x)), y: Math.min(vh - keepY, Math.max(keepY - h * k, v.y)) };
}

/** The whole drawing, centred; never larger than its own size. */
export function fitView(w: number, h: number, vw: number, vh: number, most = 1): View {
  const k = Math.min(most, vw / w, vh / h);
  return { k, x: (vw - w * k) / 2, y: (vh - h * k) / 2 };
}

/** Where a drawing opens: as before zoom existed, at its size, shrunk to fit the width down to
 *  0.8 (past that, text gets too small to read), centred across when it fits and at the top. */
export function startView(w: number, h: number, vw: number, vh: number, full: boolean): View {
  if (full) return fitView(w, h, vw, vh);
  const k = w <= vw ? 1 : Math.max(0.8, vw / w);
  return { k, x: Math.max(0, (vw - w * k) / 2), y: Math.max(0, (vh - h * k) / 2) };
}

const wheelStep = (e: WheelEvent) => (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1);

/** The viewport element, its size, the view, and what the controls call. `w`×`h` is the
 *  drawing's own size; the view resets when it changes or when `full` does. */
export function usePanZoom(w: number, h: number, full: boolean, off: boolean, onMove?: () => void) {
  // A callback ref, not useRef: the frame mounts after its column is measured, later than this
  // hook's first effects, and they have to run again when it does.
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);
  ref.current = el;
  const [size, setSize] = useState<[number, number]>([0, 0]);
  const [view, setView] = useState<View | null>(null);
  const live = useRef({ view, size, w, h, full, onMove });
  live.current = { view, size, w, h, full, onMove };
  const moved = useRef(false);

  useEffect(() => {
    if (!el || off) return;
    const ob = new ResizeObserver(() => setSize([el.clientWidth, el.clientHeight]));
    ob.observe(el);
    setSize([el.clientWidth, el.clientHeight]);
    return () => ob.disconnect();
  }, [el, off]);

  const [vw, vh] = size;
  useEffect(() => {
    if (vw && vh) setView(startView(w, h, vw, vh, full));
  }, [w, h, full, vw > 0 && vh > 0]);     // eslint-disable-line react-hooks/exhaustive-deps

  const set = useCallback((f: (v: View) => View) => {
    const c = live.current;
    if (!c.view) return;
    c.onMove?.();
    setView(clampView(f(c.view), c.w, c.h, c.size[0], c.size[1]));
  }, []);

  useEffect(() => {
    if (!el || off) return;
    const wheel = (e: WheelEvent) => {
      const c = live.current, s = wheelStep(e);
      const r = el.getBoundingClientRect();
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        set((v) => zoomAt(v, v.k * Math.exp(-e.deltaY * s * 0.0025), e.clientX - r.left, e.clientY - r.top));
      } else if (c.full) {
        e.preventDefault();
        set((v) => ({ ...v, x: v.x - e.deltaX * s, y: v.y - e.deltaY * s }));
      } else if (Math.abs(e.deltaX) > Math.abs(e.deltaY) && c.view && c.w * c.view.k > c.size[0]) {
        e.preventDefault();      // a sideways swipe pans; up and down stays the page's
        set((v) => ({ ...v, x: v.x - e.deltaX * s }));
      }
    };
    el.addEventListener("wheel", wheel, { passive: false });
    return () => el.removeEventListener("wheel", wheel);
  }, [el, off, set]);

  // One pointer drags; two pinch. A drag only starts past a few pixels, so a tap on a step
  // still opens its comment, and the click that ends a drag is swallowed.
  const pts = useRef(new Map<number, { x: number; y: number; sx: number; sy: number }>());
  const pinch = useRef<{ d: number; mx: number; my: number } | null>(null);
  const local = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };
  const two = () => {
    const [a, b] = [...pts.current.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  };
  const handlers = off ? {} : {
    onPointerDown: (e: React.PointerEvent) => {
      if (e.pointerType === "mouse" && e.button !== 0) return;
      const p = local(e);
      pts.current.set(e.pointerId, { ...p, sx: p.x, sy: p.y });
      moved.current = false;
      if (pts.current.size === 2) pinch.current = two();
    },
    onPointerMove: (e: React.PointerEvent) => {
      const was = pts.current.get(e.pointerId);
      if (!was) return;
      const p = local(e);
      if (!moved.current && Math.hypot(p.x - was.sx, p.y - was.sy) < 4 && pts.current.size < 2) return;
      if (!moved.current) { moved.current = true; ref.current?.setPointerCapture(e.pointerId); }
      const dx = p.x - was.x, dy = p.y - was.y;
      pts.current.set(e.pointerId, { ...was, ...p });
      if (pts.current.size >= 2 && pinch.current) {
        const now = two(), before = pinch.current;
        pinch.current = now;
        set((v) => {
          const z = zoomAt(v, v.k * (now.d / before.d), before.mx, before.my);
          return { ...z, x: z.x + now.mx - before.mx, y: z.y + now.my - before.my };
        });
      } else {
        set((v) => ({ ...v, x: v.x + dx, y: v.y + dy }));
      }
    },
    onPointerUp: (e: React.PointerEvent) => { pts.current.delete(e.pointerId); if (pts.current.size < 2) pinch.current = null; },
    onPointerCancel: (e: React.PointerEvent) => { pts.current.delete(e.pointerId); if (pts.current.size < 2) pinch.current = null; },
    onClickCapture: (e: React.MouseEvent) => { if (moved.current) { e.stopPropagation(); moved.current = false; } },
    onKeyDown: (e: React.KeyboardEvent) => {
      const c = live.current;
      const step = 40, mid = [c.size[0] / 2, c.size[1] / 2] as const;
      const keys: Record<string, (v: View) => View> = {
        "+": (v) => zoomAt(v, v.k * 1.25, ...mid), "=": (v) => zoomAt(v, v.k * 1.25, ...mid), "-": (v) => zoomAt(v, v.k / 1.25, ...mid),
        ArrowLeft: (v) => ({ ...v, x: v.x + step }), ArrowRight: (v) => ({ ...v, x: v.x - step }),
        ArrowUp: (v) => ({ ...v, y: v.y + step }), ArrowDown: (v) => ({ ...v, y: v.y - step }),
        "0": () => startView(c.w, c.h, c.size[0], c.size[1], c.full),
      };
      const f = keys[e.key];
      if (!f || (!c.full && (e.key === "ArrowUp" || e.key === "ArrowDown"))) return;
      e.preventDefault();
      set(f);
    },
  };
  const zoomBy = (f: number) => set((v) => zoomAt(v, v.k * f, vw / 2, vh / 2));
  const fit = () => set(() => fitView(w, h, vw, vh));
  const reset = () => set(() => startView(w, h, vw, vh, full));
  return { ref: setEl, view, size, handlers, zoomBy, fit, reset };
}
