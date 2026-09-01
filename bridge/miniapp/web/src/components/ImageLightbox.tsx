import { ChevronLeft, ChevronRight, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { FIT, clampPan, zoomAt, type View } from "../lib/imgzoom";

/** How far a press may wander and still count as a tap rather than a pan. */
const TAP_SLOP = 8;

/** A path or data URL the browser should play rather than paint. */
export const isVideo = (s: string) =>
  /^data:video\//i.test(s) || /\.(webm|mp4|mov|m4v)\b/i.test(s);

/** An <img>, unless the src is a video — then a muted inline preview with a ▶
 *  badge. Same props either way, so the eight call sites that used to hardcode
 *  <img> don't each grow a branch. */
export function MediaThumb(
  { src, className, style, alt, video, onError }:
  { src: string; className?: string; style?: React.CSSProperties; alt?: string; video?: boolean; onError?: () => void },
) {
  // `video` overrides the sniff: an object URL (blob:…) has lost both the
  // extension and the mime type, so only the caller still knows.
  if (!(video ?? isVideo(src))) return <img src={src} alt={alt ?? ""} className={className} style={style} onError={onError} />;
  // #t=0.1 makes the browser paint a real first frame instead of a black box;
  // a data: URL can't carry a fragment, so it goes without.
  const poster = src.startsWith("data:") ? src : `${src}#t=0.1`;
  return (
    <span style={{ position: "relative", display: "inline-block", lineHeight: 0 }}>
      <video src={poster} muted playsInline preload="metadata" aria-label={alt || "video"}
        className={className} style={style} onError={onError} />
      <span aria-hidden="true" style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center",
        color: "#fff", fontSize: 18, textShadow: "0 0 6px rgba(0,0,0,.8)", pointerEvents: "none" }}>▶</span>
    </span>
  );
}

/** One member of a set the lightbox can page through. `src` is what the viewer
 *  loads — for the Mini App that is a blob URL, which is why `video` travels
 *  beside it: the extension is gone by then. */
export type Shown = { src: string; video?: boolean };

/** Full-size view of one attachment. Video gets its own component rather than
 *  a branch inside the still viewer: pinch-to-zoom fights the scrubber, and the
 *  still's tap-to-close would fire on the play button.
 *  `all` makes it a gallery: ‹ › and ←/→ step through it, and the rest of the
 *  set stays visible as a strip along the bottom. */
export function ImageLightbox(
  { src, alt, video, all, onClose }:
  { src: string; alt?: string; video?: boolean; all?: Shown[]; onClose: () => void },
) {
  const list = all?.length ? all : [{ src, video }];
  const [i, setI] = useState(() => Math.max(0, list.findIndex((m) => m.src === src)));
  const cur = list[i] ?? { src, video };
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

  // key={cur.src}: each image opens at fit, rather than inheriting the pan and
  // zoom of the one before it.
  return (
    <>
      {(cur.video ?? isVideo(cur.src))
        ? <VideoLightbox key={cur.src} src={cur.src} alt={alt} strip={many} onClose={onClose} />
        : <StillLightbox key={cur.src} src={cur.src} alt={alt} strip={many} onClose={onClose} />}
      {many && <Filmstrip list={list} at={i} onPick={setI} onStep={go} />}
    </>
  );
}

/** The rest of the set, under the open one. Its own portal, above the viewer's:
 *  a sibling rather than a child, so its taps never reach the backdrop handler
 *  that would close the thing you are paging through. */
function Filmstrip(
  { list, at, onPick, onStep }:
  { list: Shown[]; at: number; onPick: (i: number) => void; onStep: (d: number) => void },
) {
  const arrow = "fixed top-1/2 z-[60] -translate-y-1/2 rounded-full bg-black/60 p-2 text-white/90";
  return createPortal(
    <>
      <button type="button" aria-label="Previous" onClick={() => onStep(-1)} className={`${arrow} left-2`}>
        <ChevronLeft size={20} />
      </button>
      <button type="button" aria-label="Next" onClick={() => onStep(1)} className={`${arrow} right-2`}>
        <ChevronRight size={20} />
      </button>
      <div className="fixed inset-x-0 bottom-0 z-[60] flex touch-pan-x gap-2 overflow-x-auto bg-black/90 px-3 py-2">
        {list.map((m, k) => (
          <button
            key={m.src}
            type="button"
            aria-label={`Image ${k + 1} of ${list.length}`}
            aria-current={k === at ? "true" : undefined}
            onClick={() => onPick(k)}
            className={`h-14 w-20 flex-none overflow-hidden rounded-md border ${
              k === at ? "border-white opacity-100" : "border-white/25 opacity-60"}`}
          >
            <MediaThumb src={m.src} video={m.video} className="h-full w-full object-cover" />
          </button>
        ))}
      </div>
    </>,
    document.body,
  );
}

/** Closes on Esc, the ✕ and the backdrop — but not on the player itself, so
 *  reaching for the scrubber can't dismiss the thing you're scrubbing. */
function VideoLightbox({ src, alt, strip, onClose }: { src: string; alt?: string; strip?: boolean; onClose: () => void }) {
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
      aria-label={alt || "Attachment"}
      // touch-none so a drag on the backdrop isn't read as Telegram's
      // swipe-down-to-close, the same reason the still viewer sets it.
      className={`fixed inset-0 z-50 flex touch-none items-center justify-center bg-black/85 p-4 ${strip ? "pb-24" : ""}`}
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
        className="max-h-full max-w-full rounded-lg bg-black"
      />
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-3 top-3 rounded-full bg-black/60 p-2 text-white/90"
      >
        <X size={18} />
      </button>
    </div>,
    document.body,
  );
}

/** Full-size view of one still, and a zoom: pinch (or wheel) to scale,
 *  drag to pan, tap the image to toggle fit ↔ 2.5x. The backdrop, the ✕ and Esc
 *  close it — the image itself never dismisses.
 *  Portaled to <body>: rendered inline it can sit under a transformed ancestor
 *  (virtualized rows are translateY'd), which would make position:fixed resolve
 *  against that ancestor instead of the viewport. */
function StillLightbox({ src, alt, strip, onClose }: { src: string; alt?: string; strip?: boolean; onClose: () => void }) {
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
      aria-label={alt || "Attachment"}
      // touch-action:none so the pinch scales the image instead of the page —
      // and so a drag isn't read as Telegram's swipe-down-to-close.
      className={`fixed inset-0 z-50 flex touch-none items-center justify-center overflow-hidden bg-black/85 p-4 ${strip ? "pb-24" : ""}`}
    >
      <img
        ref={img}
        src={src}
        alt={alt ?? ""}
        draggable={false}
        style={{ transform: `translate(${v.x}px, ${v.y}px) scale(${v.s})`, willChange: "transform" }}
        className="max-h-full max-w-full select-none rounded-lg object-contain"
      />
      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute right-3 top-3 rounded-full bg-black/60 p-2 text-white/90"
      >
        <X size={18} />
      </button>
    </div>,
    document.body,
  );
}
