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

/** A data URL for something the browser cannot paint or play — an attached
 *  file. Deliberately narrow: only a data URL declares its type outright, so a
 *  served path or a blob: URL keeps taking the <img> path it always did. */
export const isFileUrl = (s: string) =>
  /^data:/i.test(s) && !/^data:(image|video)\//i.test(s);

/** Ride the original filename along in the data URL's media-type parameter
 *  (RFC 2397 allows them). Nothing between the composer and the upload dir has
 *  to learn a new shape, and a .csv keeps its extension on disk. */
export const withName = (durl: string, name: string) =>
  durl.replace(/^data:([^;,]*)/, (_m, mime) => `data:${mime};name=${encodeURIComponent(name)}`);

/** The name to show for an attachment: the `name=` parameter if it has one,
 *  else the last path segment of wherever it is being served from. */
export function attachName(src: string): string {
  const m = /^data:[^,]*;name=([^;,]*)/.exec(src);
  const raw = m ? m[1] : src;
  return decodeURIComponent(raw).split(/[?#]/).pop()?.split("/").pop() || "file";
}

/** What a file attachment looks like where a thumbnail would go: its extension,
 *  boxed to the same size. Enough to say "this went through, and it is a CSV".
 *  ponytail: no preview and no download — add one when a file gets attached
 *  often enough that reopening it from the tray matters. */
function FileThumb(
  { name, className, style }:
  { name: string; className?: string; style?: React.CSSProperties },
) {
  const ext = (name.split(".").pop() || name).slice(0, 4).toUpperCase();
  return (
    <span
      className={className} title={name} aria-label={name}
      style={{ ...style, display: "grid", placeItems: "center", overflow: "hidden",
               border: "1px solid color-mix(in srgb, currentColor 24%, transparent)",
               fontSize: 10, letterSpacing: "0.5px", lineHeight: 1, opacity: 0.85 }}
    >
      {ext}
    </span>
  );
}

/** An <img>, unless the src is a video — then a muted inline preview with a ▶
 *  badge. Same props either way, so the eight call sites that used to hardcode
 *  <img> don't each grow a branch. */
export function MediaThumb(
  { src, className, style, alt, onError }:
  { src: string; className?: string; style?: React.CSSProperties; alt?: string; onError?: () => void },
) {
  if (isFileUrl(src)) return <FileThumb name={attachName(src)} className={className} style={style} />;
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

/** Full-size view of one attachment. Video gets its own component rather than
 *  a branch inside the still viewer: pinch-to-zoom fights the scrubber, and the
 *  still's tap-to-close would fire on the play button.
 *  `all` makes it a gallery: ‹ › and ←/→ step through it, and the rest of the
 *  set stays visible as a strip along the bottom. */
export function ImageLightbox({ src, all, clip, onClose }: { src: string; all?: string[]; clip?: Clip; onClose: () => void }) {
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
      {/* Only the video carries the panel — stepping the gallery to a still
          must not leave a clip's chapters sitting beside a screenshot. */}
      {isVideo(cur) ? <VideoLightbox key={cur} src={cur} strip={many} clip={clip} onClose={onClose} />
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
 *  reaching for the scrubber can't dismiss the thing you're scrubbing.
 *
 *  With a `clip` it grows a rail: what the recording claims, the plan it answers
 *  to, and its chapters. Without one it is exactly the player it always was —
 *  every branch here collapses when nothing was authored. */
function VideoLightbox({ src, strip, clip, onClose }: { src: string; strip?: boolean; clip?: Clip; onClose: () => void }) {
  const vid = useRef<HTMLVideoElement>(null);
  const [at, setAt] = useState(0);
  const [dur, setDur] = useState(0);
  const panel = hasPanel(clip);
  // The rail needs ~360px beside a video worth watching; under that it goes
  // below instead. Read once per resize rather than per frame.
  const [wide, setWide] = useState(() => window.innerWidth >= 900);
  useEffect(() => {
    const m = window.matchMedia("(min-width: 900px)");
    const on = () => setWide(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const seek = (t: number) => {
    const v = vid.current;
    if (!v) return;
    v.currentTime = t;
    setAt(t);           // don't wait for timeupdate; the click should feel instant
    void v.play().catch(() => {});
  };

  const row = panel && wide;
  const cap = panel && !wide ? "44vh" : strip ? "76vh" : "92vh";
  return createPortal(
    <div
      onPointerDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      role="dialog"
      aria-modal="true"
      aria-label="Attachment"
      style={{ position: "fixed", inset: 0, zIndex: 95, display: "flex", alignItems: "center", justifyContent: "center", gap: panel ? 13 : 0, flexDirection: row ? "row" : "column", padding: 24, paddingBottom: strip ? 108 : 24, background: "color-mix(in srgb, var(--panel3) 82%, transparent)", animation: "backdropIn .18s ease both" }}
    >
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0, maxWidth: row ? "calc(92vw - 373px)" : "92vw" }}>
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
          style={{ maxWidth: "100%", maxHeight: cap, border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)", background: "#000" }}
        />
        {!!clip?.chapters?.length && (
          <ChapterBar chapters={clip.chapters} at={at} dur={dur} onSeek={seek} />
        )}
      </div>

      {panel
        ? <ClipRail clip={clip!} at={at} wide={wide} tall={strip ? "76vh" : "92vh"} onSeek={seek} onClose={onClose} />
        : (
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{ position: "absolute", top: 12, right: 12, appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: "color-mix(in srgb, var(--panel3) 70%, transparent)", color: "var(--txm)", fontFamily: "inherit", fontSize: "var(--t95)", letterSpacing: 1.5, padding: "6px 12px" }}
          >ESC ✕</button>
        )}
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
 *  Rebuilding the whole transport to decorate the timeline would cost the free
 *  volume, fullscreen and PiP that come with `controls`; this buys the same
 *  affordance for a flex row.
 *
 *  Segment widths are the real gaps between marks, so the strip is the shape of
 *  the recording. Until metadata lands `dur` is 0 and they fall back to equal —
 *  a strip that reflows once beats one that lies for a second. */
function ChapterBar(
  { chapters, at, dur, onSeek }:
  { chapters: { t: number; text: string }[]; at: number; dur: number; onSeek: (t: number) => void },
) {
  const active = activeChapter(chapters, at);
  return (
    <div style={{ display: "flex", gap: 2, height: 22, flex: "none", background: "color-mix(in srgb, var(--acc) 3%, transparent)", borderLeft: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", borderRight: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", borderBottom: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)" }}>
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
            title={`${mmss(c.t)} · ${c.text}`}
            aria-label={`Chapter ${i + 1}: ${c.text}`}
            aria-current={on ? "true" : undefined}
            onClick={() => onSeek(c.t)}
            style={{ position: "relative", flex: `${span} 1 0`, minWidth: 0, appearance: "none", border: 0, borderTop: `1px solid ${on ? "var(--acc)" : "transparent"}`, padding: 0, cursor: "pointer", overflow: "hidden", background: on ? "color-mix(in srgb, var(--acc) 22%, transparent)" : "color-mix(in srgb, var(--acc) 8%, transparent)" }}
          >
            {played > 0 && (
              <span aria-hidden="true" style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${played * 100}%`, background: "color-mix(in srgb, var(--acc) 22%, transparent)" }} />
            )}
            {/* The timestamp, not the text: a real mark is a sentence, and a
                sentence in a segment a few percent wide is an ellipsis. The
                rail beside this already carries the words. */}
            <span style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "var(--mono)", fontSize: "var(--t8)", letterSpacing: 0.5, whiteSpace: "nowrap", overflow: "hidden", color: on ? "var(--txb)" : "var(--txd)" }}>
              {mmss(c.t)}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** Everything the clip claims, beside it. Sections disappear rather than
 *  showing empty: a heading over nothing reads as a bug. */
function ClipRail(
  { clip, at, wide, tall, onSeek, onClose }:
  { clip: Clip; at: number; wide: boolean; tall: string; onSeek: (t: number) => void; onClose: () => void },
) {
  const chapters = clip.chapters ?? [];
  const todos = clip.todos ?? [];
  const resolves = new Set(clip.resolves ?? []);
  const active = activeChapter(chapters, at);
  const rowRef = useRef<HTMLButtonElement>(null);
  // Follow the playhead, but only within the list — `nearest` on a scrollable
  // ancestor, so a long chapter list doesn't drag the whole overlay around.
  // Not on the first chapter: at 0:00 that would scroll Resolves off the top
  // before the clip has told you anything.
  useEffect(() => {
    if (active > 0) rowRef.current?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const label: React.CSSProperties = { display: "flex", alignItems: "center", gap: 7, padding: "11px 12px 6px", fontSize: "var(--t8)", letterSpacing: 2.5, textTransform: "uppercase", color: "var(--txl)" };
  const rule = <span aria-hidden="true" style={{ flex: 1, height: 1, background: "color-mix(in srgb, var(--acc) 8%, transparent)" }} />;

  return (
    <aside
      className="panel"
      style={{ width: wide ? 360 : "92vw", flex: wide ? "none" : "1 1 auto", minHeight: 0, maxHeight: tall, display: "flex", flexDirection: "column", border: "1px solid color-mix(in srgb, var(--acc) 22%, transparent)", background: "var(--panel2)" }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, padding: "8px 12px", flex: "none" }}>
        <span style={{ fontSize: "var(--t8)", letterSpacing: 2.5, textTransform: "uppercase", color: "var(--txl)" }}>Clip</span>
        <span style={{ fontSize: "var(--t10)", letterSpacing: 1.5, textTransform: "uppercase", color: "var(--acc)" }}>What changed</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{ marginLeft: "auto", alignSelf: "center", appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 22%, transparent)", background: "transparent", color: "var(--txm)", fontFamily: "inherit", fontSize: "var(--t95)", letterSpacing: 1.5, padding: "3px 9px" }}
        >ESC ✕</button>
      </div>
      <div aria-hidden="true" style={{ height: 1, flex: "none", background: "linear-gradient(90deg, var(--acc), color-mix(in srgb, var(--acc) 5%, transparent))" }} />

      {clip.notes && (
        <p style={{ margin: 0, padding: "9px 12px 12px", flex: "none", fontFamily: "var(--mono)", fontSize: "var(--t13)", lineHeight: 1.55, color: "var(--tx)" }}>
          {clip.notes}
        </p>
      )}

      <div className="mscroll" style={{ flex: 1, minHeight: 0 }}>
        {!!todos.length && (
          <>
            <div style={label}>Resolves{rule}</div>
            {todos.map((t, i) => {
              const done = t.status === "completed";
              const lit = resolves.has(i);
              return (
                <div
                  key={i}
                  style={{ display: "grid", gridTemplateColumns: "14px 1fr", gap: 8, alignItems: "start", padding: "5px 12px", fontSize: "var(--t11)", lineHeight: 1.45, color: lit ? "var(--txb)" : "var(--txd)", background: lit ? "color-mix(in srgb, var(--acc) 6%, transparent)" : undefined, boxShadow: lit ? "inset 2px 0 0 var(--acc)" : undefined }}
                >
                  <span aria-hidden="true" style={{ fontFamily: "var(--mono)", fontSize: "var(--t10)", paddingTop: 1, color: done ? "var(--ok)" : "var(--txl)" }}>
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
            <div style={label}>Timeline{rule}</div>
            {chapters.map((c, i) => {
              const on = i === active;
              return (
                <button
                  key={i}
                  ref={on ? rowRef : undefined}
                  type="button"
                  aria-current={on ? "true" : undefined}
                  onClick={() => onSeek(c.t)}
                  style={{ display: "grid", gridTemplateColumns: "40px 1fr", gap: 9, alignItems: "start", width: "100%", textAlign: "left", appearance: "none", cursor: "pointer", background: on ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent", border: 0, borderLeft: `2px solid ${on ? "var(--acc)" : "transparent"}`, padding: "6px 12px 6px 10px", fontFamily: "inherit", fontSize: "var(--t11)", lineHeight: 1.45, color: on ? "var(--txb)" : "var(--txd)" }}
                >
                  <span style={{ fontFamily: "var(--mono)", fontSize: "var(--t10)", paddingTop: 1, color: on ? "var(--acc)" : "var(--txl)" }}>{mmss(c.t)}</span>
                  <span>{c.text}</span>
                </button>
              );
            })}
          </>
        )}
      </div>
    </aside>
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
