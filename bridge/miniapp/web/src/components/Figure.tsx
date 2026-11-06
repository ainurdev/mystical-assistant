import { useEffect, useState } from "react";
import { Eye } from "lucide-react";
import { api } from "../lib/api";
import type { Figure as FigureData } from "../lib/figures";
import { ImageLightbox, MediaThumb, isVideo, type Clip, type Shown } from "./ImageLightbox";

/* The two kinds of picture in a turn (lib/figures): what you're being shown, large with
   the answer, and what the agent looked at, small in the steps fold. */

/** A served path as an object URL: an <img src> can't carry the init-data header (see
 *  api.attachmentUrl). */
function useAttachment(path: string): { src: string | null; gone: boolean } {
  const [src, setSrc] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    let url: string | null = null;
    let dead = false;
    api.attachmentUrl(path).then((u) => {
      url = u;
      if (dead) URL.revokeObjectURL(u);
      else setSrc(u);
    }).catch(() => { if (!dead) setGone(true); });
    return () => {
      dead = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [path]);
  return { src, gone };
}

export type FigureItem = FigureData<Clip>;

/** One image or clip across the column. Holds a box while it loads, so the turn doesn't
 *  jump when it lands; uploads are pruned by age, so an old one says it's gone. */
function FigureMedia({ path, alt, onSrc, onOpen }: {
  path: string;
  alt: string;
  onSrc: (src: string) => void;
  onOpen: (src: string) => void;
}) {
  const { src, gone } = useAttachment(path);
  useEffect(() => { if (src) onSrc(src); }, [src]);
  if (gone) return <div className="fg-gone">No longer saved here</div>;
  if (!src) return <div className="fg-wait" aria-busy="true" />;
  return (
    <button type="button" className="fg-media" onClick={() => onOpen(src)} aria-label={`Open: ${alt}`}>
      <MediaThumb src={src} alt={alt} video={isVideo(path)} className="fg-img" />
    </button>
  );
}

/** What the agent is showing you. `compare` stacks: a phone has no room for two
 *  screenshots side by side at a size you could read. */
export function Figures({ items }: { items: FigureItem[] }) {
  const [srcs, setSrcs] = useState<Record<string, string>>({});
  const [zoom, setZoom] = useState<{ src: string; clip?: Clip } | null>(null);
  const labelOf = (f: FigureItem, k: number) => (f.kind === "compare" ? (k === 0 ? "Before" : k === 1 ? "After" : "") : "");
  const all: Shown[] = items.flatMap((f) => f.images.flatMap((p, k) => {
    if (!srcs[p]) return [];
    const label = labelOf(f, k);
    return [{ src: srcs[p], video: isVideo(p), caption: label ? `${label}: ${f.caption}` : f.caption }];
  }));
  return (
    <div className="space-y-3">
      {zoom && (
        <ImageLightbox src={zoom.src} all={all} clip={zoom.clip} alt="Shown to you" onClose={() => setZoom(null)} />
      )}
      {items.map((f) => (
        <figure key={f.at} className="fg m-0">
          {f.images.map((p, k) => {
            const label = labelOf(f, k);
            return (
              <div key={p} className="fg-one">
                {label && <div className="fg-label" data-side={label.toLowerCase()}>{label.toUpperCase()}</div>}
                <FigureMedia
                  path={p}
                  alt={label ? `${label}: ${f.caption}` : f.caption || "Shown to you"}
                  onSrc={(src) => setSrcs((m) => (m[p] === src ? m : { ...m, [p]: src }))}
                  onOpen={(src) => setZoom({ src, clip: f.clip })}
                />
              </div>
            );
          })}
          {f.caption && <figcaption className="fg-cap">{f.caption}</figcaption>}
        </figure>
      ))}
    </div>
  );
}

function LookedThumb({ path, onSrc, onOpen }: {
  path: string;
  onSrc: (src: string) => void;
  onOpen: (src: string) => void;
}) {
  const { src, gone } = useAttachment(path);
  useEffect(() => { if (src) onSrc(src); }, [src]);
  if (gone) return <div className="lk-thumb lk-gone" aria-label="No longer saved here">{"—"}</div>;
  if (!src) return <div className="lk-thumb" aria-busy="true" />;
  return (
    <button type="button" className="lk-thumb" onClick={() => onOpen(src)} aria-label="Open the picture">
      <MediaThumb src={src} video={isVideo(path)} className="h-full w-full object-cover" />
    </button>
  );
}

/** Pictures the agent read to check its work, with what it said about them next. One
 *  fits beside the note; several take a strip with the note under it, because 390 px
 *  has no room for both across. */
export function LookedAt({ paths, note }: { paths: string[]; note: string }) {
  const [srcs, setSrcs] = useState<Record<string, string>>({});
  const [zoom, setZoom] = useState<string | null>(null);
  const all: Shown[] = paths.flatMap((p) => (srcs[p] ? [{ src: srcs[p], video: isVideo(p) }] : []));
  return (
    <div className="lk" data-one={paths.length === 1 ? "" : undefined}>
      {zoom && <ImageLightbox src={zoom} all={all} alt="What the agent looked at" onClose={() => setZoom(null)} />}
      <div className="lk-lab">
        <Eye size={11} aria-hidden />
        Looked at {paths.length} picture{paths.length === 1 ? "" : "s"}
      </div>
      <div className="lk-body">
        <div className="lk-strip">
          {paths.map((p) => (
            <LookedThumb
              key={p}
              path={p}
              onSrc={(src) => setSrcs((m) => (m[p] === src ? m : { ...m, [p]: src }))}
              onOpen={setZoom}
            />
          ))}
        </div>
        {note && <p className="lk-note">{note}</p>}
      </div>
    </div>
  );
}
