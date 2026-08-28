import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FIT, clampPan, zoomAt, type View } from "../lib/imgzoom";

const DOUBLE_TAP_MS = 300;
/** How far a press may wander and still count as a tap rather than a pan. */
const TAP_SLOP = 8;

/** Full-size view of one attachment, and a zoom: pinch (or wheel) to scale,
 *  drag to pan, double-tap to toggle fit ↔ 2.5x. Tap the backdrop or press Esc
 *  to close — a single tap on the image itself is inert, or it would dismiss
 *  before the second tap of a double-tap could land.
 *  Portaled to <body>: rendered inline it can sit under a transformed ancestor
 *  (virtualized rows are translateY'd), which would make position:fixed resolve
 *  against that ancestor instead of the viewport. */
export function ImageLightbox({ src, alt, onClose }: { src: string; alt?: string; onClose: () => void }) {
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
    // A mouse (the app opens in a desktop Telegram too) keeps the plain
    // click-anywhere-to-dismiss, since the wheel is its zoom.
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
      aria-label={alt || "Attachment"}
      // touch-action:none so the pinch scales the image instead of the page —
      // and so a drag isn't read as Telegram's swipe-down-to-close.
      className="fixed inset-0 z-50 flex touch-none items-center justify-center overflow-hidden bg-black/85 p-4"
    >
      <img
        ref={img}
        src={src}
        alt={alt ?? ""}
        draggable={false}
        style={{ transform: `translate(${v.x}px, ${v.y}px) scale(${v.s})`, willChange: "transform" }}
        className="max-h-full max-w-full select-none rounded-lg object-contain"
      />
    </div>,
    document.body,
  );
}
