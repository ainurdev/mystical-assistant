import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import type { ChatImageScope } from "../lib/api";
import { useChatImage } from "../lib/chatimg";
import { addressKind, normalizeAddress, parseEmbeds, removeEmbed, replaceEmbed, writableAddress, type Embed } from "../lib/embeds";

/** Long enough that typing an address isn't a fetch per letter. */
const SETTLE_MS = 300;

/** The images in the draft, drawn over it as a row.
 *
 *  A row, not the image in place as on the dashboard: this composer is a plain textarea,
 *  which can't hold anything but characters. The markdown stays visible in it for the
 *  same reason. Hiding it means an overlay or a second copy of the text, and either one
 *  costs the native caret, selection and autocorrect on a phone keyboard. */
export function ComposerImages({ draft, setDraft, scope }: {
  draft: string;
  setDraft: (v: string) => void;
  scope: ChatImageScope;
}) {
  const embeds = useMemo(() => parseEmbeds(draft), [draft]);
  const [open, setOpen] = useState<Embed | null>(null);
  const scopeKey = `${scope.session ?? ""}:${scope.project ?? ""}`;
  useEffect(() => setOpen(null), [scopeKey]);

  // By source and how many of it came before, not by offset: typing ahead of a
  // thumbnail must not remount it and ask again.
  const seen = new Map<string, number>();
  return (
    <>
      <div className="mb-2 flex touch-pan-x gap-2 overflow-x-auto empty:hidden">
        {embeds.map((e) => {
          const n = seen.get(e.raw) ?? 0;
          seen.set(e.raw, n + 1);
          return <Thumb key={`${e.raw}#${n}`} embed={e} scope={scope} onOpen={() => setOpen(e)} />;
        })}
      </div>
      {open && (
        <ImageSheet
          embed={open}
          scope={scope}
          onClose={() => setOpen(null)}
          onSave={(address) => {
            const next = replaceEmbed(draft, open, address);
            if (next !== null) setDraft(next);
            setOpen(null);
          }}
          onRemove={() => {
            const next = removeEmbed(draft, open);
            if (next !== null) setDraft(next);
            setOpen(null);
          }}
        />
      )}
    </>
  );
}

/** Nothing until it loads, and nothing if it doesn't: that markdown is just text. */
function Thumb({ embed, scope, onOpen }: { embed: Embed; scope: ChatImageScope; onOpen: () => void }) {
  const drawable = addressKind(embed.address) !== "other";
  const look = useChatImage(scope, drawable ? embed.address : null, SETTLE_MS);
  if (look.status !== "found") return null;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label={`Edit image ${embed.alt || embed.address}`}
      className="block flex-none active:opacity-70"
    >
      <img
        src={look.url}
        alt={embed.alt}
        referrerPolicy="no-referrer"
        className="h-12 w-12 rounded-lg border border-border object-cover"
      />
    </button>
  );
}

/** One image up close: where it points, whether anything is there, and the two things
 *  you can do about it. Portalled like SwitchSheet, for the same reason: the composer's
 *  fixed bar is a stacking context. Save needs a found image, because saving anything
 *  else would make the thumbnail vanish with no way back to this sheet. */
function ImageSheet({ embed, scope, onSave, onRemove, onClose }: {
  embed: Embed;
  scope: ChatImageScope;
  onSave: (address: string) => void;
  onRemove: () => void;
  onClose: () => void;
}) {
  const [value, setValue] = useState(embed.address);
  const address = normalizeAddress(value);
  const usable = writableAddress(address) && addressKind(address) !== "other";
  const look = useChatImage(scope, usable ? address : null, SETTLE_MS);
  const found = look.status === "found";

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const btn = "min-h-[46px] w-full text-[11.5px] tracking-[.12em] active:opacity-70 disabled:opacity-40";
  return createPortal(
    <div className="fixed inset-0 z-50 flex flex-col justify-end bg-black/50" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Image in this message"
        className="mx-auto max-h-[90dvh] w-full max-w-screen-sm overflow-y-auto border-t border-border-bright bg-[var(--tg-bg)] px-3.5 pb-[calc(env(safe-area-inset-bottom,0px)+0.75rem)] shadow-[0_-16px_44px_rgba(0,0,0,0.6)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 py-2">
          <span className="text-[9.5px] tracking-[2px] text-[var(--brand-soft)]">IMAGE</span>
          <button type="button" onClick={onClose} aria-label="Close" className="ml-auto flex h-10 w-10 flex-none items-center justify-center"><X size={16} aria-hidden /></button>
        </div>
        {/* A fixed frame, so the fields don't jump under your thumb as a typed address
            goes from found to gone and back. */}
        <div className="flex h-[32dvh] items-center justify-center border border-border">
          {found && (
            <img
              src={look.url}
              alt={embed.alt}
              referrerPolicy="no-referrer"
              className="max-h-full max-w-full object-contain"
            />
          )}
        </div>
        <label className="mt-3 block text-[9.5px] tracking-[2px] text-[var(--muted-2)]" htmlFor="chat-image-address">ADDRESS</label>
        {/* 16px: iOS zooms the whole page into a focused field smaller than that. */}
        <input
          id="chat-image-address"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && found) onSave(address); }}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          className="mt-1 w-full min-w-0 border border-input bg-transparent px-3 py-2 font-mono text-[16px] text-foreground outline-none focus-visible:border-ring/60 focus-visible:ring-2 focus-visible:ring-ring/40"
        />
        <div
          role="status"
          className="mt-1.5 min-h-[18px] text-[12px]"
          style={{ color: found ? "var(--ok)" : look.status === "missing" ? "var(--err)" : "var(--tg-hint)" }}
        >
          {found ? "Found" : look.status === "missing" ? "No image at that address" : "Looking…"}
        </div>
        <div className="mt-3 grid grid-cols-2 gap-1.5">
          <button
            type="button"
            onClick={onRemove}
            className={`${btn} border border-[var(--err)] text-[var(--err)]`}
          >
            REMOVE
          </button>
          <button
            type="button"
            disabled={!found}
            onClick={() => onSave(address)}
            className={`${btn} bg-primary text-primary-foreground`}
          >
            SAVE
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
