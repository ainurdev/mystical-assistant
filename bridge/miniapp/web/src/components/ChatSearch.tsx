import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { Search, X } from "lucide-react";
import { api } from "../lib/api";
import { useChat } from "../lib/chat";
import { dedupeHits, hitWho, markParts, type SearchHit } from "../lib/chatsearch";
import { useExperimental } from "../lib/multi";
import { Spinner } from "./ui";

/* Search in this chat, from its header. The bridge reads the whole chat, so it finds
   turns the tail hasn't loaded yet; jumpToTurn pages them in. It's a sheet from the top
   rather than the bottom, where the keyboard would cover it. */

const DEBOUNCE_MS = 250;
const MIN_CHARS = 2;

/** Portaled to <body>: the header's tuck mode hides `.chead-fold`, and frost puts a
 *  backdrop-filter on the bar, which would become a fixed sheet's containing block. */
function SearchSheet({ onClose }: { onClose: () => void }) {
  const { sessionId, jumpToTurn, turns } = useChat();
  const [text, setText] = useState("");
  const [q, setQ] = useState("");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    const t = setTimeout(() => setQ(text.trim()), DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [text]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const on = q.length >= MIN_CHARS && sessionId !== null;
  const { data, isFetching, isError, refetch } = useQuery({
    queryKey: ["chat-search", sessionId, q],
    queryFn: () => api.chatSearch(sessionId as string, q),
    enabled: on,
    retry: false,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  });
  const hits = on && data ? dedupeHits(data.hits) : [];
  const numberOf = new Map(turns.map((t, i) => [t.id, i + 1]));

  function jump(h: SearchHit) {
    onClose();
    void jumpToTurn(h.turn);
  }

  return createPortal(
    <div className="cs-back" onClick={onClose}>
      <div className="cs-sheet" role="dialog" aria-modal="true" aria-label="Search in this chat"
           onClick={(e) => e.stopPropagation()}>
        <div className="cs-bar">
          <Search size={15} className="flex-none text-[var(--brand-soft)]" aria-hidden />
          <input
            ref={input}
            type="search"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Search this chat"
            aria-label="Search this chat"
            enterKeyHint="search"
            className="cs-input"
          />
          {isFetching && on && <Spinner className="h-3 w-3 flex-none border" />}
          <button type="button" className="rp-close" aria-label="Close" onClick={onClose}><X size={18} aria-hidden /></button>
        </div>
        <div className="cs-list" aria-live="polite">
          {!on && (
            <p className="cs-empty">
              {text.trim().length === 1 ? "One more letter." : "Your prompts and the agent's words. Not tool output."}
            </p>
          )}
          {on && isError && (
            <div className="cs-empty">
              <p>The search didn't go through.</p>
              <button type="button" className="ms-said-more" onClick={() => void refetch()}>TRY AGAIN</button>
            </div>
          )}
          {on && !isError && data && !hits.length && !isFetching && <p className="cs-empty">Nothing in this chat says "{q}".</p>}
          {hits.map((h) => {
            const n = numberOf.get(h.turn);
            return (
              <button key={`${h.turn}-${h.seq ?? "p"}`} type="button" className="cs-hit" onClick={() => jump(h)}>
                <span className="cs-who">
                  <span>{hitWho[h.kind] ?? h.kind.toUpperCase()}</span>
                  {n != null && <span className="opacity-70">TURN {n}</span>}
                </span>
                <span className="cs-snip">
                  {markParts(h.snippet, q).map((p, k) => (p.hit ? <mark key={k}>{p.text}</mark> : <span key={k}>{p.text}</span>))}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** Nothing with the experimental switch off, so the header is as it was. */
export function ChatSearchButton() {
  const on = useExperimental();
  const [open, setOpen] = useState(false);
  if (!on) return null;
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label="Search in this chat"
        className="flex shrink-0 items-center border border-border-bright/60 px-2 py-1.5 text-[var(--tg-hint)] active:opacity-70"
      >
        <Search size={13} aria-hidden />
      </button>
      {open && <SearchSheet onClose={() => setOpen(false)} />}
    </>
  );
}
