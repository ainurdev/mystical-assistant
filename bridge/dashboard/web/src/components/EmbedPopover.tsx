import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EditorView } from "@codemirror/view";
import { addressChange, cleanAddress, imageSrc, type ImageScope } from "../lib/embeds";
import { embedAtPos, embedEdit, widgetAt } from "../lib/cmembeds";
import { knownImage, probeImage } from "../lib/imageprobe";

/* The address behind an image in the composer, opened by clicking it (or Alt+Enter
   beside it). A popover on the image, not a modal: the message stays in view and a click
   anywhere else just closes it. The document changes when an address is confirmed (Enter
   or leaving the box), never per keystroke, so one change is one undo step. Esc leaves
   everything as it was.

   Portalled to the page because the composer's scroller clips, and placed by hand above
   the image, since the composer sits at the foot of the window. */

const PROBE_MS = 250;

type Status = { s: "found" | "missing" | "checking" | "invalid"; text: string; url?: string };

function readStatus(value: string, scope: ImageScope): Status {
  const a = cleanAddress(value);
  if (a === null) return { s: "invalid", text: value.trim() ? "An address can't hold < or >" : "Type an address" };
  const url = imageSrc(a, scope);
  if (!url) return { s: "missing", text: "No image at that address" };
  const k = knownImage(url);
  if (k?.state === "bad") return { s: "missing", text: "No image at that address" };
  if (k?.state === "ok") return { s: "found", url, text: k.width ? `Found · ${k.width}×${k.height}` : "Found" };
  return { s: "checking", text: "Looking…", url };
}

export function EmbedPopover({ view, pos, scope, onClose }: {
  view: EditorView;
  /** Where the embed starts, kept current by MarkdownInput as the document changes. */
  pos: number;
  scope: ImageScope;
  onClose: () => void;
}) {
  const start = embedAtPos(view.state, pos);
  const [value, setValue] = useState(start?.address ?? "");
  const [, recheck] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [place, setPlace] = useState<{ left: number; top: number } | null>(null);
  const finished = useRef(false);
  // The handlers below outlive a render through document listeners.
  const latest = useRef({ value, pos });
  latest.current = { value, pos };

  const status = readStatus(value, scope);
  const url = status.url;

  useEffect(() => {
    if (!url || status.s !== "checking") return;
    let live = true;
    const t = window.setTimeout(() => {
      void probeImage(url).then(() => { if (live) recheck((n) => n + 1); });
    }, PROBE_MS);
    return () => { live = false; clearTimeout(t); };
  }, [url, status.s]);

  /** Confirm what's in the box, if it's an address and a change, and close. */
  const finish = (commit: boolean) => {
    if (finished.current) return;
    finished.current = true;
    if (commit) {
      const e = embedAtPos(view.state, latest.current.pos);
      const a = cleanAddress(latest.current.value);
      if (e && a !== null && a !== e.address) view.dispatch({ changes: addressChange(e, a), ...embedEdit });
    }
    onClose();
  };
  const finishRef = useRef(finish);
  finishRef.current = finish;

  const remove = () => {
    if (finished.current) return;
    finished.current = true;
    const e = embedAtPos(view.state, latest.current.pos);
    if (e) view.dispatch({ changes: { from: e.from, to: e.to }, selection: { anchor: e.from }, ...embedEdit });
    onClose();
    view.focus();
  };

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
    const away = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) finishRef.current(true);
    };
    document.addEventListener("pointerdown", away, true);
    return () => document.removeEventListener("pointerdown", away, true);
  }, []);

  // Above the image, or under it when there's no room; inside the window either way.
  useLayoutEffect(() => {
    const aim = () => {
      const root = rootRef.current;
      if (!root) return;
      const a = widgetAt(view, latest.current.pos)?.getBoundingClientRect();
      const c = a ?? view.coordsAtPos(latest.current.pos);
      if (!c) return;
      const r = root.getBoundingClientRect();
      const above = c.top - r.height - 8;
      const top = above >= 8 ? above : Math.min(c.bottom + 8, window.innerHeight - r.height - 8);
      const left = Math.max(8, Math.min(c.left, window.innerWidth - r.width - 8));
      setPlace((p) => (p && p.left === left && p.top === top ? p : { left, top }));
    };
    aim();
    const ro = new ResizeObserver(aim);
    if (rootRef.current) ro.observe(rootRef.current);
    window.addEventListener("resize", aim);
    window.addEventListener("scroll", aim, true);
    return () => {
      ro.disconnect();
      window.removeEventListener("resize", aim);
      window.removeEventListener("scroll", aim, true);
    };
  }, [view, pos]);

  return createPortal(
    <div
      ref={rootRef}
      className="embed-pop"
      role="dialog"
      aria-label="Image address"
      // So a press on the preview keeps focus in here instead of reading as leaving.
      tabIndex={-1}
      // Unplaced for one layout pass. Not visibility:hidden, which couldn't take the focus.
      style={place ? { left: place.left, top: place.top } : { left: 0, top: 0, opacity: 0 }}
      onBlur={(e) => {
        if (rootRef.current?.contains(e.relatedTarget as Node | null)) return;
        // The window losing focus isn't someone leaving the box.
        if (!document.hasFocus()) return;
        finish(true);
      }}
      // A portal's events still bubble through React, to a composer that has handlers.
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === "Escape") {
          e.preventDefault();
          finish(false);
          view.focus();
        }
      }}
    >
      {status.s === "found" && url && (
        <img className="embed-pop-img" src={url} alt="" draggable={false} referrerPolicy="no-referrer" />
      )}
      <label className="embed-pop-key">
        ADDRESS
        <input
          ref={inputRef}
          className="embed-pop-in"
          value={value}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== "Enter") return;
            e.preventDefault();
            e.stopPropagation();
            const at = latest.current.pos;
            finish(true);
            const now = embedAtPos(view.state, at);
            if (now) view.dispatch({ selection: { anchor: now.to } });
            view.focus();
          }}
        />
      </label>
      <div className="embed-pop-foot">
        <span className="embed-pop-st" role="status" data-s={status.s}>{status.text}</span>
        <button type="button" className="embed-pop-rm" onClick={remove}>REMOVE</button>
      </div>
    </div>,
    document.body,
  );
}
