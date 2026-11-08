import { useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronUp, Search, X } from "lucide-react";
import { api } from "../api";
import type { Turn } from "../chat";
import { hitWord, MIN_QUERY, orderHits, snippetParts, stepHit, type ChatHit } from "../lib/chatsearch";
import { hhmm, useClock12 } from "../lib/surfaces";

/* Search in this chat, from the island (components/hud/Terminal). No shortcut of its own:
   Ctrl/Cmd+F is already spoken for, Transcript mounts the whole list so the browser's
   find can see it, and taking it away from people would be the worse trade. The search
   reads the store, so it finds what isn't loaded; a jump pages older turns in on the way
   (App jumpTo). */

const DEBOUNCE_MS = 220;

export function ChatSearch({ sessionId, turns, onJump }: {
  sessionId: string;
  turns: Turn[];
  /** Go to a turn and, with an event's seq, to that event inside it. */
  onJump: (turnId: string, seq?: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [raw, setRaw] = useState<ChatHit[] | null>(null);
  const [err, setErr] = useState(false);
  const [busy, setBusy] = useState(false);
  const [at, setAt] = useState(-1);
  const input = useRef<HTMLInputElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const h12 = useClock12();

  // Another chat, another search.
  useEffect(() => { setOpen(false); setQ(""); setRaw(null); setErr(false); setAt(-1); }, [sessionId]);
  useEffect(() => { if (open) input.current?.focus(); }, [open]);

  const needle = q.trim();
  useEffect(() => {
    setAt(-1);
    setErr(false);
    if (!open || needle.length < MIN_QUERY) { setRaw(null); setBusy(false); return; }
    let live = true;
    setBusy(true);
    const t = window.setTimeout(() => {
      api.chatSearch(sessionId, needle).then(
        (r) => { if (live) { setRaw(r.hits); setBusy(false); } },
        () => { if (live) { setErr(true); setRaw(null); setBusy(false); } },
      );
    }, DEBOUNCE_MS);
    return () => { live = false; clearTimeout(t); };
  }, [sessionId, needle, open]);

  const ids = useMemo(() => turns.map((t) => t.id).join("\n"), [turns]);
  const hits = useMemo(() => orderHits(raw ?? [], ids ? ids.split("\n") : []), [raw, ids]);
  const startOf = useMemo(() => new Map(turns.map((t) => [t.id, t.started])), [ids]); // eslint-disable-line react-hooks/exhaustive-deps

  const go = (i: number) => {
    const h = hits[i];
    if (!h) return;
    setAt(i);
    onJump(h.turn, h.seq ?? undefined);
  };
  const step = (d: 1 | -1) => go(stepHit(at, hits.length, d));

  useEffect(() => {
    box.current?.querySelector("[aria-current]")?.scrollIntoView({ block: "nearest" });
  }, [at]);

  if (!open) {
    return (
      <button type="button" className="ma-cs-btn" title="Search this chat" aria-label="Search this chat" onClick={() => setOpen(true)}>
        <Search size={13} strokeWidth={2} aria-hidden />
      </button>
    );
  }
  const close = () => setOpen(false);
  return (
    <div className="ma-cs">
      <button type="button" className="ma-cs-btn" data-on="" title="Close search" aria-label="Close search" onClick={close}>
        <Search size={13} strokeWidth={2} aria-hidden />
      </button>
      <div className="ma-cs-pop" role="search" ref={box}
        onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); close(); } }}>
        <div className="ma-cs-bar">
          <input
            ref={input}
            className="ma-cs-in"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); step(e.shiftKey ? -1 : 1); } }}
            placeholder="Search this chat"
            aria-label="Search this chat"
            autoComplete="off"
            spellCheck={false}
          />
          <span className="ma-cs-n" aria-live="polite">
            {busy ? "…" : hits.length ? `${at >= 0 ? `${at + 1} / ` : ""}${hits.length}` : ""}
          </span>
          <button type="button" className="ma-cs-step" disabled={!hits.length} title="Previous (Shift+Enter)" aria-label="Previous hit" onClick={() => step(-1)}><ChevronUp size={14} aria-hidden /></button>
          <button type="button" className="ma-cs-step" disabled={!hits.length} title="Next (Enter)" aria-label="Next hit" onClick={() => step(1)}><ChevronDown size={14} aria-hidden /></button>
          <button type="button" className="ma-cs-step" title="Close (Esc)" aria-label="Close search" onClick={close}><X size={14} aria-hidden /></button>
        </div>
        {err ? <p className="ma-cs-say" data-err="">The search didn't reach the bridge. Change a letter to try again.</p>
          : needle.length < MIN_QUERY ? <p className="ma-cs-say">Your prompts and the agent's words, in this chat. Tool output isn't searched.</p>
          : !busy && raw && !hits.length ? <p className="ma-cs-say">Nothing in this chat says “{needle}”.</p>
          : hits.length ? (
            <ul className="ma-cs-list">
              {hits.map((h, i) => {
                const when = h.at ?? startOf.get(h.turn);
                return (
                  <li key={`${h.turn}:${h.kind}:${h.seq ?? i}`}>
                    <button type="button" className="ma-cs-hit" aria-current={i === at || undefined} onClick={() => go(i)}>
                      <span className="ma-cs-kind" data-k={h.kind}>{hitWord(h.kind)}{when ? ` · ${hhmm(when, h12)}` : ""}</span>
                      <span className="ma-cs-snip">
                        {snippetParts(h.snippet, needle).map((p, k) => (p.hit ? <mark key={k}>{p.t}</mark> : <span key={k}>{p.t}</span>))}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : null}
      </div>
    </div>
  );
}
