import { Fragment, useMemo, useState } from "react";
import { useChat } from "../lib/chat";
import { useChatImage } from "../lib/chatimg";
import { addressKind, formatEmbed, splitEmbeds } from "../lib/embeds";
import { ImageLightbox } from "./ImageLightbox";

/** One image written in a message, where it was written. The caller decides whether a
 *  remote address may be drawn at all: `remote` is only passed for words a person typed,
 *  so an answer can't call a tracking pixel from this browser.
 *
 *  Its own component with its own useChat, rather than a session threaded through
 *  Markdown: that one is memoized because re-parsing a long turn is the most expensive
 *  thing the transcript does, and a context read there would undo it on every poll. Here
 *  a re-render is a few cheap elements, and only in messages that have an image.
 *
 *  `.chat-img` is what routes/run.tsx listens for, to re-measure the row and stay at the
 *  bottom once the height is known. data-md is what lib/selmd copies instead of a blob. */
export function ChatImage({ address, alt = "", remote = false }: { address: string; alt?: string; remote?: boolean }) {
  const { sessionId, project } = useChat();
  const kind = addressKind(address);
  const drawable = kind === "local" ? !!address : kind === "remote" && remote;
  const look = useChatImage({ session: sessionId, project }, drawable ? address : null);
  const [broken, setBroken] = useState<string | null>(null);
  const [zoom, setZoom] = useState(false);
  const md = formatEmbed(alt, address);

  if (look.status === "checking") return <span className="chat-img-wait" data-md={md} aria-label="Loading image" />;
  if (look.status === "missing" || broken === look.url) {
    return <span className="chat-img-gone" data-md={md}>image not found: {address}</span>;
  }
  return (
    <>
      <button
        type="button"
        className="chat-img"
        data-md={md}
        aria-label={`Open ${alt || "image"}`}
        onClick={(e) => {
          // A link around the image, or a fold around the message, isn't what this tap meant.
          e.preventDefault();
          e.stopPropagation();
          setZoom(true);
        }}
      >
        <img src={look.url} alt={alt} referrerPolicy="no-referrer" onError={() => setBroken(look.url)} />
      </button>
      {zoom && <ImageLightbox src={look.url} alt={alt} onClose={() => setZoom(false)} />}
    </>
  );
}

/** A message as you wrote it, with its images drawn: everything else stays the same text
 *  nodes in the same pre-wrap bubble. An image is inline, so the line breaks around it
 *  are the ones you typed. */
export function PromptText({ text }: { text: string }) {
  const parts = useMemo(() => splitEmbeds(text), [text]);
  return (
    <>
      {parts.map((p, i) => (typeof p === "string"
        ? <Fragment key={i}>{p}</Fragment>
        : <ChatImage key={i} address={p.address} alt={p.alt} remote />))}
    </>
  );
}
