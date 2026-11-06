import { createContext, useContext, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { useChatImageScope } from "../lib/chatimages";
import { classifyAddress, decodeSrc, embedMarkdown, fitBox, imageName, imageSrc } from "../lib/embeds";
import { knownImage, noteImage } from "../lib/imageprobe";
import { ImageLightbox, ZoomButton, type Shown } from "./ImageLightbox";

/* An image written into a message, drawn where it was written. What may load is the
   point of this file: a local address always (through the file route, which serves
   images and nothing else); an http(s) one only on your own plate, as you typed it. In
   anything an agent wrote it's a plain link, so an answer can't call a tracking pixel
   from this browser. A file that isn't there says so in a quiet line: never a broken icon.

   Every state carries data-md, the markdown it came from, so a selection dragged across
   it copies back as that (lib/selmd).

   The virtualizer needs nothing from here: each row is under its ResizeObserver
   (Transcript measureElement), so a load reports itself. A size already seen goes on
   the <img> up front, so a remounted row is its full height from the first frame. */

/** The caller says these words are a person's own (PromptBubble). */
export const MdTyped = createContext(false);
/** Inside a link: the link is what a click means, and a link can't hold another. */
export const MdLinked = createContext(false);

/** Tall enough to read a screenshot, short enough that a message stays a message. */
const CAP = 280;

type Props = ComponentProps<"img"> & { node?: unknown; "data-addr"?: string };

export function MdImage({ src, alt = "", title, "data-addr": raw }: Props) {
  const scope = useChatImageScope();
  const typed = useContext(MdTyped);
  const linked = useContext(MdLinked);
  const box = useRef<HTMLSpanElement>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [shown, setShown] = useState<Shown[] | null>(null);

  const address = raw ?? decodeSrc(typeof src === "string" ? src : "");
  const md = embedMarkdown(alt, address, title);
  const kind = classifyAddress(address);

  if (kind === "remote" && !(typed && scope.remote)) {
    const label = alt.trim() || address;
    return linked ? <span data-md={md}>{label}</span>
      : <span data-md={md}><a href={address} target="_blank" rel="noreferrer">{label}</a></span>;
  }
  const url = imageSrc(address, scope);
  if (!url || failed === url) {
    return <span className="md-img-missing" data-md={md}>image not found: {address}</span>;
  }

  const known = knownImage(url);
  const size = known?.state === "ok" ? fitBox(known.width, known.height, CAP) : null;
  const img: ReactNode = (
    <img
      src={url} alt={alt} title={title} loading="lazy"
      data-md-img="" data-name={imageName(alt, address)}
      width={size?.width} height={size?.height}
      referrerPolicy="no-referrer"
      onLoad={(e) => noteImage(url, e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)}
      onError={() => setFailed(url)}
    />
  );
  if (linked) return <span className="md-img" data-md={md}>{img}</span>;

  // The turn's images, as the page holds them right now: what's missing has no <img>,
  // and a shut fold's aren't drawn, so the viewer pages only through what can be seen.
  const open = () => {
    const root = box.current?.closest(".dturn") ?? box.current?.closest(".md");
    const all = Array.from(root?.querySelectorAll<HTMLImageElement>("img[data-md-img]") ?? []);
    setShown(all.map((i) => ({ src: i.getAttribute("src") ?? "", name: i.dataset.name })));
  };
  return (
    // The stop: this sits inside clickable cards, and the viewer portals, so its clicks
    // bubble here through React too.
    <span ref={box} className="md-img" data-md={md} onClick={(e) => e.stopPropagation()}>
      <ZoomButton onOpen={open}>{img}</ZoomButton>
      {shown && <ImageLightbox src={url} all={shown} onClose={() => setShown(null)} />}
    </span>
  );
}
