import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FIT, clampPan, zoomAt, type View } from "../lib/imgzoom";

const DOUBLE_TAP_MS = 300;
/** How far a press may wander and still count as a tap rather than a pan. */
const TAP_SLOP = 8;

/** Full-size view of one attachment, and a zoom: wheel or pinch to scale, drag
 *  to pan, double-tap to toggle. Click the backdrop or press Esc to close.
 *  Portaled to <body>: rendered inline it can sit under a transformed ancestor
 *  (virtualized rows are translateY'd), which would make position:fixed resolve
 *  against that ancestor instead of the viewport. */
export function ImageLightbox({ src, onClose }: { src: string; onClose: () => void }) {
  const [v, setV] = useState<View>(FIT);
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const spread = useRef(0);   // the previous two-finger distance, 0 = not pinching
  const down = useRef({ x: 0, y: 0 });
  const dragged = useRef(false);
  const lastTap = useRef(0);

  // Every change goes through here, so no gesture can leave the image outside
  // its own overflow — a clamp needs the laid-out sizes, which only the DOM has.
  const move = (fn: (cur: View) => View) =>
    setV((cur) => {
      const b = box.current, i = img.current;
      const next = fn(cur);
      return b && i ? clampPan(next, b.clientWidth, b.clientHeight, i.clientWidth, i.clientHeight) : next;
    });

  /** Pointer position measured from the overlay's centre — the origin the
   *  transform in lib/imgzoom works in. */
  const rel = (e: { clientX: number; clientY: number }) => {
    const r = box.current!.getBoundingClientRect();
    return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 };
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Wheel is a hand-registered listener because React's own is passive, and a
  // passive handler can't stop the wheel from scrolling the page behind.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = rel(e);
      move((cur) => zoomAt(cur, p.x, p.y, Math.exp(-e.deltaY * 0.002)));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  const onDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (ptrs.current.size === 1) { down.current = { x: e.clientX, y: e.clientY }; dragged.current = false; }
    spread.current = 0;
  };

  const onMove = (e: React.PointerEvent) => {
    const prev = ptrs.current.get(e.pointerId);
    if (!prev) return;
    ptrs.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (Math.hypot(e.clientX - down.current.x, e.clientY - down.current.y) > TAP_SLOP) dragged.current = true;

    const pts = [...ptrs.current.values()];
    if (pts.length >= 2) {
      const [a, b] = pts;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const mid = rel({ clientX: (a.x + b.x) / 2, clientY: (a.y + b.y) / 2 });
      // The factor is read here, not inside the updater: React can run an
      // updater later, by which time `spread` is already this event's distance
      // and every pinch after the first would scale by exactly 1.
      const factor = spread.current ? d / spread.current : 0;
      spread.current = d;
      if (factor) move((cur) => zoomAt(cur, mid.x, mid.y, factor));
      dragged.current = true;
      return;
    }
    const dx = e.clientX - prev.x, dy = e.clientY - prev.y;
    move((cur) => (cur.s > 1 ? { ...cur, x: cur.x + dx, y: cur.y + dy } : cur));
  };

  const onUp = (e: React.PointerEvent) => {
    ptrs.current.delete(e.pointerId);
    spread.current = 0;
    if (ptrs.current.size || dragged.current) return;   // still pinching, or that was a pan

    const onImage = !!img.current?.contains(e.target as Node);
    // The backdrop always dismisses, and a mouse keeps the old behaviour of
    // closing on the image too — the wheel is its zoom. Touch has no wheel, so
    // there the image owns the gesture: a single tap is inert (it would close
    // before the second tap could land) and a double-tap toggles fit ↔ 2.5x.
    if (!onImage || (e.pointerType === "mouse" && v.s === 1)) { onClose(); return; }
    if (e.pointerType === "mouse") return;
    const dbl = e.timeStamp - lastTap.current < DOUBLE_TAP_MS;
    lastTap.current = dbl ? 0 : e.timeStamp;
    if (!dbl) return;
    const p = rel(e);
    move((cur) => (cur.s > 1 ? FIT : zoomAt(FIT, p.x, p.y, 2.5)));
  };

  return createPortal(
    <div
      ref={box}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={onUp}
      onPointerCancel={(e) => { ptrs.current.delete(e.pointerId); spread.current = 0; }}
      role="dialog"
      aria-modal="true"
      aria-label="Attachment"
      style={{ position: "fixed", inset: 0, zIndex: 95, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, overflow: "hidden", touchAction: "none", background: "color-mix(in srgb, var(--panel3) 82%, transparent)", cursor: "zoom-out", animation: "backdropIn .18s ease both" }}
    >
      <img
        ref={img}
        src={src}
        alt=""
        draggable={false}
        style={{ maxWidth: "92vw", maxHeight: "92vh", objectFit: "contain", border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)", transform: `translate(${v.x}px, ${v.y}px) scale(${v.s})`, willChange: "transform", cursor: v.s > 1 ? "grab" : "zoom-out", userSelect: "none" }}
      />
    </div>,
    document.body,
  );
}

/** Thumbnail that opens the lightbox — a button so it's keyboard-reachable. */
export function ZoomButton({ onOpen, children }: { onOpen: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Open image"
      style={{ display: "block", padding: 0, border: 0, background: "transparent", cursor: "zoom-in", lineHeight: 0 }}
    >
      {children}
    </button>
  );
}
