import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FIT, clampPan, zoomAt, type View } from "../lib/imgzoom";

/** How far a press may wander and still count as a tap rather than a pan. */
const TAP_SLOP = 8;

/** A path or data URL the browser should play rather than paint. */
export const isVideo = (s: string) =>
  // \b, not $: the dashboard's src is /local/attachment?path=…%2Fclip.webm, so
  // the extension can sit anywhere in a query string.
  /^data:video\//i.test(s) || /\.(webm|mp4|mov|m4v)\b/i.test(s);

/** An <img>, unless the src is a video — then a muted inline preview with a ▶
 *  badge. Same props either way, so the eight call sites that used to hardcode
 *  <img> don't each grow a branch. */
export function MediaThumb(
  { src, className, style, alt, onError }:
  { src: string; className?: string; style?: React.CSSProperties; alt?: string; onError?: () => void },
) {
  if (!isVideo(src)) return <img src={src} alt={alt ?? ""} className={className} style={style} onError={onError} />;
  // #t=0.1 makes the browser paint a real first frame instead of a black box;
  // a data: URL can't carry a fragment, so it goes without.
  const poster = src.startsWith("data:") ? src : `${src}#t=0.1`;
  return (
    <span style={{ position: "relative", display: "inline-block", lineHeight: 0 }}>
      <video src={poster} muted playsInline preload="metadata" aria-label={alt || "video"}
        className={className} style={style} onError={onError} />
      <span aria-hidden="true" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center",
        color: "var(--acc)", fontSize: 18, textShadow: "0 0 6px rgba(0,0,0,.8)", pointerEvents: "none" }}>▶</span>
    </span>
  );
}

/** Full-size view of one attachment. Video gets its own component rather than
 *  a branch inside the still viewer: pinch-to-zoom fights the scrubber, and the
 *  still's tap-to-close would fire on the play button.
 *  `all` makes it a gallery: ‹ › and ←/→ step through it, and the rest of the
 *  set stays visible as a strip along the bottom. */
export function ImageLightbox({ src, all, onClose }: { src: string; all?: string[]; onClose: () => void }) {
  const list = all?.length ? all : [src];
  const [i, setI] = useState(() => Math.max(0, list.indexOf(src)));
  const cur = list[i] ?? src;
  const many = list.length > 1;
  const go = (d: number) => setI((n) => (n + d + list.length) % list.length);

  useEffect(() => {
    if (!many) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight") go(1);
      else if (e.key === "ArrowLeft") go(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [many, list.length]);

  // key={cur}: each image opens at fit, rather than inheriting the pan and zoom
  // of the one before it.
  return (
    <>
      {isVideo(cur) ? <VideoLightbox key={cur} src={cur} strip={many} onClose={onClose} />
                    : <StillLightbox key={cur} src={cur} strip={many} onClose={onClose} />}
      {many && <Filmstrip list={list} at={i} onPick={setI} onStep={go} />}
    </>
  );
}

/** The rest of the set, under the open one. Its own portal, above the viewer's:
 *  a sibling rather than a child, so its clicks never reach the backdrop
 *  handler that would close the thing you are paging through. */
function Filmstrip(
  { list, at, onPick, onStep }:
  { list: string[]; at: number; onPick: (i: number) => void; onStep: (d: number) => void },
) {
  const arrow: React.CSSProperties = {
    position: "fixed", top: "50%", transform: "translateY(-50%)", zIndex: 96,
    appearance: "none", cursor: "pointer", padding: "18px 14px", lineHeight: 1,
    border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)",
    background: "color-mix(in srgb, var(--panel3) 70%, transparent)",
    color: "var(--txm)", fontFamily: "inherit", fontSize: "var(--t14)",
  };
  return createPortal(
    <>
      <button type="button" aria-label="Previous" onClick={() => onStep(-1)} style={{ ...arrow, left: 12 }}>‹</button>
      <button type="button" aria-label="Next" onClick={() => onStep(1)} style={{ ...arrow, right: 12 }}>›</button>
      <div
        style={{ position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 96, display: "flex", gap: 8,
          justifyContent: "center", overflowX: "auto", padding: "10px 12px",
          background: "color-mix(in srgb, var(--panel3) 88%, transparent)",
          borderTop: "1px solid color-mix(in srgb, var(--acc) 18%, transparent)" }}
      >
        {list.map((s, k) => (
          <button
            key={s}
            type="button"
            aria-label={`Image ${k + 1} of ${list.length}`}
            aria-current={k === at ? "true" : undefined}
            onClick={() => onPick(k)}
            style={{ appearance: "none", cursor: "pointer", padding: 0, flex: "none", lineHeight: 0,
              border: `1px solid ${k === at ? "var(--acc)" : "color-mix(in srgb, var(--acc) 18%, transparent)"}`,
              opacity: k === at ? 1 : 0.5, background: "transparent" }}
          >
            <MediaThumb src={s} style={{ height: 56, width: 84, objectFit: "cover", display: "block" }} />
          </button>
        ))}
      </div>
    </>,
    document.body,
  );
}

/** Closes on Esc, the ✕ and the backdrop — but not on the player itself, so
 *  reaching for the scrubber can't dismiss the thing you're scrubbing. */
function VideoLightbox({ src, strip, onClose }: { src: string; strip?: boolean; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label="Attachment"
      style={{ position: "fixed", inset: 0, zIndex: 95, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, paddingBottom: strip ? 108 : 24, background: "color-mix(in srgb, var(--panel3) 82%, transparent)", animation: "backdropIn .18s ease both" }}
    >
      {/* autoPlay + loop, muted so a browser will actually honour it: these are
          short screen recordings, and a clip that needs a tap to start reads as
          broken next to a screenshot that is simply there. */}
      <video
        src={src}
        controls
        autoPlay
        loop
        muted
        playsInline
        style={{ maxWidth: "92vw", maxHeight: strip ? "76vh" : "92vh", border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)", background: "#000" }}
      />
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        style={{ position: "absolute", top: 12, right: 12, appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: "color-mix(in srgb, var(--panel3) 70%, transparent)", color: "var(--txm)", fontFamily: "inherit", fontSize: "var(--t95)", letterSpacing: 1.5, padding: "6px 12px" }}
      >ESC ✕</button>
    </div>,
    document.body,
  );
}

/** Full-size view of one still, and a zoom: wheel or pinch to scale, drag
 *  to pan, click or tap the image to toggle fit ↔ 2.5x. The backdrop, the ✕ and
 *  Esc close it.
 *  Portaled to <body>: rendered inline it can sit under a transformed ancestor
 *  (virtualized rows are translateY'd), which would make position:fixed resolve
 *  against that ancestor instead of the viewport. */
function StillLightbox({ src, strip, onClose }: { src: string; strip?: boolean; onClose: () => void }) {
  const [v, setV] = useState<View>(FIT);
  const box = useRef<HTMLDivElement>(null);
  const img = useRef<HTMLImageElement>(null);
  const ptrs = useRef(new Map<number, { x: number; y: number }>());
  const spread = useRef(0);   // the previous two-finger distance, 0 = not pinching
  const down = useRef({ x: 0, y: 0 });
  const dragged = useRef(false);

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

    // The image never dismisses: a tap or click on it toggles fit ↔ 2.5x at
    // that point, the same as the old double-tap. Only the backdrop, the ✕ and
    // Esc close.
    if (!img.current?.contains(e.target as Node)) { onClose(); return; }
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
      style={{ position: "fixed", inset: 0, zIndex: 95, display: "flex", alignItems: "center", justifyContent: "center", padding: 24, paddingBottom: strip ? 108 : 24, overflow: "hidden", touchAction: "none", background: "color-mix(in srgb, var(--panel3) 82%, transparent)", cursor: "zoom-out", animation: "backdropIn .18s ease both" }}
    >
      <img
        ref={img}
        src={src}
        alt=""
        draggable={false}
        style={{ maxWidth: "92vw", maxHeight: strip ? "76vh" : "92vh", objectFit: "contain", border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)", transform: `translate(${v.x}px, ${v.y}px) scale(${v.s})`, willChange: "transform", cursor: v.s > 1 ? "grab" : "zoom-in", userSelect: "none" }}
      />
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        style={{ position: "absolute", top: 12, right: 12, appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: "color-mix(in srgb, var(--panel3) 70%, transparent)", color: "var(--txm)", fontFamily: "inherit", fontSize: "var(--t95)", letterSpacing: 1.5, padding: "6px 12px" }}
      >ESC ✕</button>
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
