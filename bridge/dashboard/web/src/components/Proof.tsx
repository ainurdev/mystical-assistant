import { useState } from "react";
import { api } from "../api";
import { ImageLightbox, MediaThumb, ZoomButton, type Shown } from "./ImageLightbox";
import type { ProofItem } from "../lib/pictures";

/* What the agent is showing you (lib/pictures): drawn large with the answer, outside
   the WORK zone, each with its caption. A running turn draws one in place as it lands;
   a finished turn gathers them under its answer, in order. */

/** One picture, or the quiet note a pruned upload leaves. */
function Picture({ path, alt, onOpen, onGone, gone }: {
  path: string; alt: string; onOpen: (src: string) => void; onGone: (p: string) => void; gone: boolean;
}) {
  if (gone) return <div className="ma-gone">picture gone</div>;
  const src = api.attachmentUrl(path);
  return (
    <ZoomButton onOpen={() => onOpen(src)}>
      <MediaThumb src={src} alt={alt} className="ma-proof-img" onError={() => onGone(path)} />
    </ZoomButton>
  );
}

/** `turn` is said in the lightbox, with the caption and the tool it came from. */
export function ProofBlock({ items, all, turn }: {
  /** Drawn here. */
  items: ProofItem[];
  /** What the lightbox pages through: the turn's. Defaults to `items`. */
  all?: ProofItem[];
  turn?: string;
}) {
  const [zoom, setZoom] = useState<string | null>(null);
  const [gone, setGone] = useState<Set<string>>(new Set());
  const markGone = (p: string) => setGone((g) => new Set(g).add(p));
  const gallery: Shown[] = (all ?? items).flatMap((it) => it.images.filter((p) => !gone.has(p)).map((p, k) => ({
    src: api.attachmentUrl(p),
    name: it.kind === "compare" ? (k === 0 ? "Before" : "After") : undefined,
    clip: it.clip,
    caption: it.caption,
    tool: it.tool,
    turn,
  })));
  if (!items.length) return null;
  return (
    <section className="ma-proof" aria-label="Proof">
      <div className="ma-proof-lab">PROOF</div>
      {zoom && <ImageLightbox src={zoom} all={gallery} onClose={() => setZoom(null)} />}
      {items.map((it) => (
        <figure key={it.key} className="ma-fig" data-kind={it.kind}>
          {it.kind === "compare" ? (
            <div className="ma-compare">
              {it.images.map((p, k) => (
                <div key={p} className="ma-compare-side">
                  <div className="ma-compare-lab">{k === 0 ? "BEFORE" : "AFTER"}</div>
                  <Picture path={p} alt={`${k === 0 ? "Before" : "After"}: ${it.caption}`} onOpen={setZoom} onGone={markGone} gone={gone.has(p)} />
                </div>
              ))}
            </div>
          ) : (
            <div className="ma-fig-set">
              {it.images.map((p) => <Picture key={p} path={p} alt={it.caption || it.tool} onOpen={setZoom} onGone={markGone} gone={gone.has(p)} />)}
            </div>
          )}
          {it.caption && <figcaption>{it.caption}</figcaption>}
        </figure>
      ))}
    </section>
  );
}
