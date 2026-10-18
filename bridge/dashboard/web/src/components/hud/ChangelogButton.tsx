import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUpRight, ChevronRight, MessageSquareText, Pencil, ScrollText } from "lucide-react";
import { api, type Notice } from "../../api";
import { popPlace } from "../../lib/prchip";
import { ago, safeUrl, stamp } from "../../lib/notices";
import { NoteComposer } from "./NoteComposer";

// The right rail's changelog, over UPDATE: what each update changed (a headline and
// a few bullets bridge/whatsnew.py writes at a boot that found new commits) and the
// notes maintainers wrote for every install, with the form that writes one. It was
// the bell's Updates tab; the bell is your sessions, this is Mystical itself.
// The newest entry and anything unread are open cards; older ones are a dated list
// that unfolds in place, so a changelog you've read still shows what the last update
// did without a click. When one lands, the bell's poll hands it here
// (hud:changelog-pop) and it pops out of this icon, next to where UPDATE was pressed,
// not under the bell; its click, or an OS banner's (hud:changelog), opens the
// changelog on it. A dot while any is unread; closing marks what it showed read.
// Self-contained (polls, owns its popover) like UpdateButton.
const POLL_MS = 60_000; // rows land at a boot or a SEND NOTE; a fresh one comes by event, not by this

/** An update's bullets: the lead bold, split at the first " — ". */
function Bullets({ body }: { body: string }) {
  return (
    <ul className="ntf-ul">
      {body.split("\n").filter(Boolean).map((line, i) => {
        const at = line.indexOf(" — ");
        return <li key={i}>{at > 0 ? <><b>{line.slice(0, at)}</b>{line.slice(at)}</> : line}</li>;
      })}
    </ul>
  );
}

/** "+80 smaller fixes · 106 commits ↗" — the commits are the compare link. */
function Meta({ r }: { r: Notice }) {
  const c = typeof r.meta.commits === "number" ? r.meta.commits : 0;
  const rest = typeof r.meta.rest === "number" ? r.meta.rest : 0;
  const url = safeUrl(r.meta.url);
  const commits = `${c} commit${c === 1 ? "" : "s"}`;
  return (
    <span className="clg-meta">
      {rest > 0 && <span>+{rest} smaller fix{rest === 1 ? "" : "es"} ·</span>}
      {url ? <button className="clg-link" onClick={(e) => { e.stopPropagation(); window.open(url, "_blank", "noopener"); }}>
        {commits}<ArrowUpRight size={10} strokeWidth={2} /></button> : commits}
    </span>
  );
}

/** What an entry says: an update's bullets, or a note's text and who wrote it. */
function Said({ r }: { r: Notice }) {
  if (r.kind !== "note") return <Bullets body={r.body} />;
  const by = typeof r.meta.author === "string" ? r.meta.author : "";
  return <>{r.body && <div className="clg-note">{r.body}</div>}{by && <div className="clg-by">by {by}</div>}</>;
}

export function ChangelogButton() {
  const [rows, setRows] = useState<Notice[] | null>(null);
  const [open, setOpen] = useState(false);
  const [unfolded, setUnfolded] = useState<Set<number>>(() => new Set());   // history rows clicked open
  const [flash, setFlash] = useState<number | null>(null);                   // the entry a popup or banner opened on
  const [fresh, setFresh] = useState<Notice | null>(null);                   // the popup out of the icon
  const [composing, setComposing] = useState(false);
  const [bar, setBar] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [hov, setHov] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // A bridge older than this page has no /local/changelog: no rows, so no button.
  const load = () => api.changelog().then((r) => setRows(r.notices), () => { /* next poll */ });
  const openOn = (id: number | null) => {
    setFresh(null); setFlash(id); setUnfolded(new Set(id === null ? [] : [id]));
    setOpen(true); void load();
  };
  useEffect(() => {
    void load();
    const id = setInterval(load, POLL_MS);
    const show = (e: Event) => { const id = (e as CustomEvent<unknown>).detail; openOn(typeof id === "number" ? id : null); };
    const landed = (e: Event) => { setFresh((e as CustomEvent<Notice>).detail); void load(); };
    window.addEventListener("hud:changelog", show);
    window.addEventListener("hud:changelog-pop", landed);
    return () => {
      clearInterval(id);
      window.removeEventListener("hud:changelog", show);
      window.removeEventListener("hud:changelog-pop", landed);
    };
  }, []);

  const close = () => {
    // fresh too: one that landed while this was open was read here, it doesn't pop on the way out
    setOpen(false); setComposing(false); setBar(null); setUnfolded(new Set()); setFlash(null); setFresh(null);
    const ids = (rows ?? []).filter((r) => !r.read).map((r) => r.id);
    if (ids.length) void api.noticesRead(ids).then(load, () => { /* next poll */ });
  };
  // Closes the way UPDATE's popover does: a press outside it, or Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!btnRef.current?.contains(t) && !popRef.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); close(); } };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open, rows]);

  if (!rows) return null;
  const unread = rows.filter((r) => !r.read).length;
  const now = Date.now() / 1000;
  const today = new Date();
  const toggle = (id: number) => setUnfolded((p) => { const s = new Set(p); if (!s.delete(id)) s.add(id); return s; });
  const cards = rows.filter((r, i) => i === 0 || !r.read);
  const older = rows.filter((r) => !cards.includes(r));
  // Above the button (the rail's foot is low), right edges flush, capped like the bell.
  const rect = btnRef.current?.getBoundingClientRect();
  const place = open && rect && popPlace(rect, window.innerHeight);
  const pop = rect && place && { top: "auto", ...place, maxHeight: Math.min(640, place.maxHeight),
                                 right: Math.max(8, Math.min(window.innerWidth - rect.right, window.innerWidth - 472)) };
  // The popup sits left of the rail, its notch (index.css) on the icon's middle.
  const out = fresh && !open && rect && { right: window.innerWidth - rect.left + 10, bottom: Math.max(8, window.innerHeight - rect.bottom - 4) };
  const theme = document.querySelector("[data-theme]") ?? document.body;

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => (open ? close() : openOn(null))}
        title={unread ? `Changelog — ${unread} new` : "Changelog — what changed in Mystical"}
        aria-label="Changelog"
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        className={`relative flex h-[38px] items-center justify-center border-l-2 border-transparent hover:bg-accent${out ? " clg-lit" : ""}`}
        style={{ appearance: "none", cursor: "pointer", color: open || hov || out ? "var(--acc)" : "var(--muted-2)" }}
      >
        <ScrollText size={18} strokeWidth={1.8} aria-hidden />
        {unread > 0 && <span className="absolute right-[5px] top-[4px] h-[8px] w-[8px] rounded-full" style={{ background: "var(--acc)" }} />}
      </button>

      {/* What just landed, out of the icon: 8 s like the bell's news (the bar's
          animation is the clock, so a hover that pauses it holds the popup). */}
      {fresh && out && createPortal(
        <div key={fresh.id} className={`clg-co${fresh.kind === "note" ? " note" : ""}`} style={out} role="status" onClick={() => openOn(fresh.id)}>
          <div className="in">
            <div className="clg-co-h">
              {fresh.kind === "note" ? <MessageSquareText size={13} strokeWidth={1.8} className="clg-ic" /> : (
                <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" className="clg-ic">
                  <path d="M12 3 21 12 12 21 3 12Z" /><path d="M12 9 15 12 12 15 9 12Z" fill="currentColor" stroke="none" />
                </svg>)}
              <span className="v">{fresh.verb}</span>
              <span className="w">{ago(fresh.at, now)}{fresh.kind === "note" && typeof fresh.meta.author === "string" ? ` · by ${fresh.meta.author}` : ""}</span>
            </div>
            <div className="clg-co-t">{fresh.title}</div>
            <div className="clg-co-b">{fresh.kind === "note" ? fresh.body
              : fresh.body.split("\n").filter(Boolean).map((l) => l.split(" — ")[0]).join(" · ")}</div>
            <div className="clg-co-f">
              {fresh.kind !== "note" && <span>{`${fresh.meta.commits ?? 0} commit${fresh.meta.commits === 1 ? "" : "s"}`}</span>}
              <span style={{ flex: 1 }} />
              <span className="go">{fresh.kind === "note" ? "Read the note ›" : "See what changed ›"}</span>
            </div>
            <span className="bar" onAnimationEnd={(e) => { if (e.animationName === "clg-bar") setFresh(null); }} />
          </div>
          <button className="x" title="dismiss" aria-label="dismiss" onClick={(e) => { e.stopPropagation(); setFresh(null); }}>×</button>
        </div>,
        theme,
      )}

      {/* Portalled into the themed container, like UPDATE's, so position:fixed
          escapes the rail's animated ancestors; the bell's frame (.ntf-pop). */}
      {pop && createPortal(
        <div ref={popRef} className="ntf-pop" style={{ position: "fixed", zIndex: 96, ...pop }}>
          <div className="ntf-head">
            <span className="t">CHANGELOG</span>
            {unread > 0 && <span className="n">{unread} new</span>}
          </div>
          <div className="ntf-list mscroll">
            {cards.map((r) => {
              const s = stamp(r.at, today);
              return (
                <div key={r.id} className={`clg-card${r.read ? "" : " new"}${flash === r.id ? " clg-flash" : ""}`}>
                  <div className="clg-hm">
                    {!r.read && <span className="clg-tag">NEW</span>}
                    {r.kind === "note" && <span className="clg-verb">NOTE</span>}
                    <span>{s.day} · {s.time}</span>
                    <span style={{ flex: 1 }} />
                    {r.kind !== "note" && <Meta r={r} />}
                  </div>
                  <div className="clg-ht">{r.title}</div>
                  <Said r={r} />
                </div>
              );
            })}
            {older.length > 0 && <div className="ntf-sec">EARLIER<span className="ln" /></div>}
            {older.map((r) => {
              const s = stamp(r.at, today);
              const on = unfolded.has(r.id);
              return (
                <div key={r.id} className={`clg-row${flash === r.id ? " clg-flash" : ""}`}>
                  <button className="clg-hist" aria-expanded={on} onClick={() => toggle(r.id)}>
                    <span className="d">{s.day === "TODAY" ? s.time : s.day}</span>
                    <span className="s">{r.kind === "note" && <i>NOTE</i>}{r.title}</span>
                    <ChevronRight size={13} strokeWidth={1.8} aria-hidden />
                  </button>
                  {on && <div className="clg-fold"><Said r={r} />{r.kind !== "note" && <div className="clg-line"><Meta r={r} /></div>}</div>}
                </div>
              );
            })}
            {!rows.length && (
              <div className="ntf-empty">
                <div className="o">no updates yet — i am as you first summoned me.</div>
                <div className="s">the next PULL &amp; RESTART lists what changed here</div>
              </div>
            )}
          </div>
          {composing ? (
            <>
              {bar?.kind === "err" && <div className="clg-err">{bar.text}</div>}
              <NoteComposer
                onSent={() => { setComposing(false); setBar({ kind: "ok", text: "Sent · every install sees it after its next update" }); void load(); }}
                onCancel={() => { setComposing(false); setBar(null); }}
                onError={(m) => setBar({ kind: "err", text: m })} />
            </>
          ) : (
            <div className="ntf-foot">
              {bar?.kind === "ok" ? <span className="clg-sent">✓ {bar.text}</span>
                : <button className="clg-write" onClick={() => setComposing(true)}><Pencil size={12} strokeWidth={1.8} />Write a note for every install</button>}
            </div>
          )}
        </div>,
        theme,
      )}
    </>
  );
}
