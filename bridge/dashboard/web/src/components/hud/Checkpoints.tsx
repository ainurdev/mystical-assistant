import { useEffect, useRef, useState, type RefObject } from "react";
import type { Turn } from "../../chat";

/** The transcript's scrollbar (the native one is hidden under it): a draggable
 *  viewport thumb. Drag it or click the track to scroll. Checkpoint ticks used
 *  to live here too — a rect read per mark on every content resize, which is
 *  every frame while streaming or scrolling through unseen history. The right
 *  rail's TURNS tab (TurnsPanel) is the jump list now. */
export function ScrollRail({
  turns, scrollRef,
}: {
  turns: Turn[];
  scrollRef: RefObject<HTMLDivElement | null>;
}) {
  const [win, setWin] = useState({ top: 0, h: 1 });
  const railRef = useRef<HTMLDivElement | null>(null);
  // Offset from the thumb's top to where it was grabbed; null when not dragging.
  const grab = useRef<number | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const h = el.scrollHeight || 1;
      setWin({ top: el.scrollTop / h, h: Math.min(1, el.clientHeight / h) });
    };
    onScroll();
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [scrollRef, turns.length]);

  /** Where on the rail the pointer is (0..1). */
  const at = (e: React.PointerEvent) => {
    const r = railRef.current?.getBoundingClientRect();
    if (!r?.height) return 0;
    return Math.min(1, Math.max(0, (e.clientY - r.top) / r.height));
  };

  const scrollTo = (f: number) => {
    const el = scrollRef.current;
    if (el) el.scrollTop = (f - (grab.current ?? win.h / 2)) * el.scrollHeight;
  };

  const onDown = (e: React.PointerEvent) => {
    const f = at(e);
    const onThumb = f >= win.top && f <= win.top + win.h;
    grab.current = onThumb ? f - win.top : win.h / 2;
    e.currentTarget.setPointerCapture(e.pointerId);
    if (!onThumb) scrollTo(f);
    e.preventDefault();
  };

  const onMove = (e: React.PointerEvent) => {
    if (grab.current != null) scrollTo(at(e));
  };

  const end = () => { grab.current = null; };

  if (win.h >= 1) return null; // nothing to scroll

  return (
    <div
      aria-hidden
      ref={railRef}
      onPointerDown={onDown}
      onPointerMove={onMove}
      onPointerUp={end}
      onPointerCancel={end}
      style={{
        position: "absolute", right: 2, top: 8, bottom: 8, width: 12,
        // Above the sticky LAST peek (5) — it spans the full width and was
        // swallowing every click on the top of the rail.
        zIndex: 8,
        cursor: "pointer", touchAction: "none",
      }}
    >
      <div style={{ position: "absolute", inset: 0, borderLeft: "1px solid color-mix(in srgb, var(--acc) 10%, transparent)" }} />
      <div style={{ position: "absolute", left: 1, right: 0, top: `${win.top * 100}%`, height: `${win.h * 100}%`, minHeight: 18, background: "color-mix(in srgb, var(--acc) 11%, transparent)", border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)", transition: grab.current == null ? "top .1s linear" : "none" }} />
    </div>
  );
}
