import { X } from "lucide-react";
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

/** Full-size view of one attachment. Video gets its own component rather than
 *  a branch inside the still viewer: pinch-to-zoom fights the scrubber, and the
 *  still's tap-to-close would fire on the play button. */
export function ImageLightbox({ src, alt, video, clip, onClose }: { src: string; alt?: string; video?: boolean; clip?: Clip; onClose: () => void }) {
  return (video ?? isVideo(src)) ? <VideoLightbox src={src} alt={alt} clip={clip} onClose={onClose} />
                                 : <StillLightbox src={src} alt={alt} onClose={onClose} />;
}

/** What a clip is evidence for, stamped onto the tool_done event by the runner.
 *  Every field is optional because the three channels are authored separately —
 *  a recording with marks but no notes is normal, and so is the reverse. */
export type Clip = {
  notes?: string;
  todos?: { content: string; status: string }[];
  resolves?: number[];
  chapters?: { t: number; text: string }[];
};

const hasPanel = (c?: Clip) =>
  !!(c && (c.notes || c.chapters?.length || c.todos?.length));

/** Closes on Esc, the ✕ and the backdrop — but not on the player itself, so
 *  reaching for the scrubber can't dismiss the thing you're scrubbing.
 *
 *  With a `clip` the rest of the sheet below the video says what the recording
 *  claims, which plan items it answers, and its chapters. On a phone there is no
 *  room beside the clip, so the panel is simply the rest of the page. */
function VideoLightbox({ src, alt, clip, onClose }: { src: string; alt?: string; clip?: Clip; onClose: () => void }) {
  const vid = useRef<HTMLVideoElement>(null);
  const [at, setAt] = useState(0);
  const [dur, setDur] = useState(0);
  const panel = hasPanel(clip);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const seek = (t: number) => {
    const v = vid.current;
    if (!v) return;
    v.currentTime = t;
    setAt(t);           // don't wait for timeupdate; the tap should feel instant
    void v.play().catch(() => {});
  };

  return createPortal(
    <div
      onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label={alt || "Attachment"}
      // touch-none so a drag on the backdrop isn't read as Telegram's
      // swipe-down-to-close, the same reason the still viewer sets it.
      className={`fixed inset-0 z-50 flex touch-none justify-center bg-black/85 ${panel ? "flex-col p-0" : "items-center p-4"}`}
    >
      {/* autoPlay + loop, muted so a browser will actually honour it: these are
          short screen recordings, and a clip that needs a tap to start reads as
          broken next to a screenshot that is simply there. */}
      <video
        ref={vid}
        src={src}
        controls
        autoPlay
        loop
        muted
        playsInline
        onTimeUpdate={panel ? (e) => setAt(e.currentTarget.currentTime) : undefined}
        onLoadedMetadata={panel ? (e) => setDur(e.currentTarget.duration || 0) : undefined}
        className={panel ? "max-h-[46vh] w-full shrink-0 bg-black" : "max-h-full max-w-full rounded-lg bg-black"}
      />
      {panel && (
        <>
          {!!clip?.chapters?.length && (
            <ChapterBar chapters={clip.chapters} at={at} dur={dur} onSeek={seek} />
          )}
          <ClipSheet clip={clip!} at={at} onSeek={seek} />
        </>
      )}
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

const mmss = (s: number) =>
  `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** Which chapter the playhead is inside: the last one that has started. */
const activeChapter = (chapters: { t: number }[], at: number) => {
  let i = -1;
  for (let k = 0; k < chapters.length; k++) if (chapters[k].t <= at + 0.01) i = k;
  return i;
};

/** The ticks a native <video> scrubber will not take, as a strip under it.
 *  Rebuilding the transport to decorate the timeline would cost the free
 *  fullscreen and volume that come with `controls`.
 *
 *  Segment widths are the real gaps between marks, so the strip is the shape of
 *  the recording. Until metadata lands `dur` is 0 and they fall back to equal.
 *  26px tall rather than the dashboard's 22: this one is hit with a thumb. */
function ChapterBar(
  { chapters, at, dur, onSeek }:
  { chapters: { t: number; text: string }[]; at: number; dur: number; onSeek: (t: number) => void },
) {
  const active = activeChapter(chapters, at);
  return (
    <div className="flex h-[26px] shrink-0 gap-[2px] border-y border-[color-mix(in_srgb,var(--acc)_16%,transparent)]">
      {chapters.map((c, i) => {
        const end = chapters[i + 1]?.t ?? (dur || 0);
        const span = dur && end > c.t ? end - c.t : 1;
        const on = i === active;
        const played = on && dur && end > c.t
          ? Math.min(1, Math.max(0, (at - c.t) / (end - c.t))) : 0;
        return (
          <button
            key={i}
            type="button"
            aria-label={`Chapter ${i + 1}: ${c.text}`}
            aria-current={on ? "true" : undefined}
            onClick={() => onSeek(c.t)}
            style={{ flex: `${span} 1 0` }}
            className={`relative min-w-0 overflow-hidden border-t ${on
              ? "border-[var(--acc)] bg-[color-mix(in_srgb,var(--acc)_22%,transparent)]"
              : "border-transparent bg-[color-mix(in_srgb,var(--acc)_8%,transparent)]"}`}
          >
            {played > 0 && (
              <span aria-hidden="true" style={{ width: `${played * 100}%` }}
                className="absolute inset-y-0 left-0 bg-[color-mix(in_srgb,var(--acc)_22%,transparent)]" />
            )}
            {/* The timestamp, not the text: a real mark is a sentence, and a
                sentence in a segment a few percent wide is an ellipsis. The
                sheet below this already carries the words. */}
            <span className={`absolute inset-0 flex items-center justify-center overflow-hidden whitespace-nowrap font-[var(--mono)] text-[9px] ${on ? "text-[var(--txb)]" : "text-[var(--txd)]"}`}>
              {mmss(c.t)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Everything the clip claims, under it. Sections disappear rather than showing
 *  empty: a heading over nothing reads as a bug. Rows carry 44px of tap height
 *  while the type stays 11px — a phone needs the target, not the size. */
function ClipSheet(
  { clip, at, onSeek }: { clip: Clip; at: number; onSeek: (t: number) => void },
) {
  const chapters = clip.chapters ?? [];
  const todos = clip.todos ?? [];
  const resolves = new Set(clip.resolves ?? []);
  const active = activeChapter(chapters, at);
  const rowRef = useRef<HTMLButtonElement>(null);
  // Follow the playhead, but only within the sheet — `nearest` on the scroller,
  // so a long chapter list doesn't drag the whole overlay around. Not on the
  // first chapter: at 0:00 that would scroll Resolves off the top before the
  // clip has told you anything.
  useEffect(() => {
    if (active > 0) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const label = "flex items-center gap-[7px] px-3 pb-1.5 pt-3 text-[8px] uppercase tracking-[2.5px] text-[var(--txl)]";
  const rule = <span aria-hidden="true" className="h-px flex-1 bg-[color-mix(in_srgb,var(--acc)_8%,transparent)]" />;

  return (
    <div className="min-h-0 flex-1 touch-pan-y overflow-y-auto bg-[var(--panel2)]">
      {clip.notes && (
        <p className="m-0 px-3 pb-3 pt-2.5 font-[var(--mono)] text-[13px] leading-[1.55] text-[var(--tx)]">
          {clip.notes}
        </p>
      )}

      {!!todos.length && (
        <>
          <div className={label}>Resolves{rule}</div>
          {todos.map((t, i) => {
            const done = t.status === "completed";
            const lit = resolves.has(i);
            return (
              <div
                key={i}
                className={`grid grid-cols-[14px_1fr] items-start gap-2 px-3 py-2.5 text-[11px] leading-[1.45] ${lit
                  ? "bg-[color-mix(in_srgb,var(--acc)_6%,transparent)] text-[var(--txb)] shadow-[inset_2px_0_0_var(--acc)]"
                  : "text-[var(--txd)]"}`}
              >
                <span aria-hidden="true" className={`pt-px font-[var(--mono)] text-[10px] ${done ? "text-[var(--ok)]" : "text-[var(--txl)]"}`}>
                  {done ? "✓" : "·"}
                </span>
                <span>
                  {t.content}
                  {/* The lit row is otherwise only a colour, which is not a
                      state a screen reader can hear. */}
                  {lit && <span className="sr-only"> — shown in this clip</span>}
                </span>
              </div>
            );
          })}
        </>
      )}

      {!!chapters.length && (
        <>
          <div className={label}>Timeline{rule}</div>
          {chapters.map((c, i) => {
            const on = i === active;
            return (
              <button
                key={i}
                ref={on ? rowRef : undefined}
                type="button"
                aria-current={on ? "true" : undefined}
                onClick={() => onSeek(c.t)}
                className={`grid w-full grid-cols-[40px_1fr] items-start gap-[9px] border-l-2 py-2.5 pl-2.5 pr-3 text-left text-[11px] leading-[1.45] ${on
                  ? "border-[var(--acc)] bg-[color-mix(in_srgb,var(--acc)_8%,transparent)] text-[var(--txb)]"
                  : "border-transparent text-[var(--txd)]"}`}
              >
                <span className={`pt-px font-[var(--mono)] text-[10px] ${on ? "text-[var(--acc)]" : "text-[var(--txl)]"}`}>{mmss(c.t)}</span>
                <span>{c.text}</span>
              </button>
            );
          })}
        </>
      )}
    </div>
  );
}

/** Full-size view of one still, and a zoom: pinch (or wheel) to scale,
 *  drag to pan, tap the image to toggle fit ↔ 2.5x. The backdrop, the ✕ and Esc
 *  close it — the image itself never dismisses.
 *  Portaled to <body>: rendered inline it can sit under a transformed ancestor
 *  (virtualized rows are translateY'd), which would make position:fixed resolve
 *  against that ancestor instead of the viewport. */
function StillLightbox({ src, alt, onClose }: { src: string; alt?: string; onClose: () => void }) {
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
