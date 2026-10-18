import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Pencil, ScrollText } from "lucide-react";
import { api, type Notice } from "../../api";
import { popPlace } from "../../lib/prchip";
import { NoticeRow } from "./Notifications";
import { NoteComposer } from "./NoteComposer";

// The right rail's changelog, over UPDATE: what each update changed (a headline and
// a few bullets bridge/whatsnew.py writes at a boot that found new commits) and the
// notes maintainers wrote for every install, with the form that writes one. It was
// the bell's Updates tab; the bell is your sessions, this is Mystical itself. The
// rows still pop as toasts when they land (the bell's poll), and a toast's click
// opens this through the hud:changelog event. A dot while any is unread; closing
// marks what it showed read. Self-contained (polls, owns its popover) like UpdateButton.
const POLL_MS = 60_000; // rows land at a boot or a SEND NOTE, not mid-session

export function ChangelogButton() {
  const [rows, setRows] = useState<Notice[] | null>(null);
  const [open, setOpen] = useState(false);
  const [unfolded, setUnfolded] = useState<Set<number>>(() => new Set());   // read rows clicked open again
  const [composing, setComposing] = useState(false);
  const [bar, setBar] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [hov, setHov] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  // A bridge older than this page has no /local/changelog: no rows, so no button.
  const load = () => api.changelog().then((r) => setRows(r.notices), () => { /* next poll */ });
  useEffect(() => {
    void load();
    const id = setInterval(load, POLL_MS);
    const show = (e: Event) => {
      const id = (e as CustomEvent<unknown>).detail;
      setUnfolded(new Set(typeof id === "number" ? [id] : []));
      setOpen(true); void load();
    };
    window.addEventListener("hud:changelog", show);
    return () => { clearInterval(id); window.removeEventListener("hud:changelog", show); };
  }, []);

  const close = () => {
    setOpen(false); setComposing(false); setBar(null); setUnfolded(new Set());
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
  const toggle = (id: number) => setUnfolded((p) => { const s = new Set(p); if (!s.delete(id)) s.add(id); return s; });
  // Above the button (the rail's foot is low), right edges flush, capped like the bell.
  const rect = open ? btnRef.current?.getBoundingClientRect() : undefined;
  const place = rect && popPlace(rect, window.innerHeight);
  const pop = rect && place && { top: "auto", ...place, maxHeight: Math.min(640, place.maxHeight),
                                 right: Math.max(8, Math.min(window.innerWidth - rect.right, window.innerWidth - 472)) };

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => { if (open) close(); else { setOpen(true); void load(); } }}
        title={unread ? `Changelog — ${unread} new` : "Changelog — what changed in Mystical"}
        aria-label="Changelog"
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        className="relative flex h-[38px] items-center justify-center border-l-2 border-transparent hover:bg-accent"
        style={{ appearance: "none", cursor: "pointer", color: open || hov ? "var(--acc)" : "var(--muted-2)" }}
      >
        <ScrollText size={18} strokeWidth={1.8} aria-hidden />
        {unread > 0 && <span className="absolute right-[5px] top-[4px] h-[8px] w-[8px] rounded-full" style={{ background: "var(--acc)" }} />}
      </button>

      {/* Portalled into the themed container, like UPDATE's, so position:fixed
          escapes the rail's animated ancestors; the bell's own look (.ntf-pop). */}
      {open && pop && createPortal(
        <div ref={popRef} className="ntf-pop" style={{ position: "fixed", zIndex: 96, ...pop }}>
          <div className="ntf-head">
            <span className="t">CHANGELOG</span>
            {unread > 0 && <span className="n">{unread} new</span>}
          </div>
          {composing ? bar?.kind === "err" && <div className="ntf-write err">{bar.text}</div>
            : bar ? <div className={`ntf-write ${bar.kind}`}>{bar.text}</div>
            : <button className="ntf-write" onClick={() => setComposing(true)}><Pencil size={12} strokeWidth={1.8} />Write a note for every install<span style={{ flex: 1 }} /><span className="go">›</span></button>}
          {composing ? (
            <NoteComposer
              onSent={() => { setComposing(false); setBar({ kind: "ok", text: "Sent · every install sees it after its next update" }); void load(); }}
              onCancel={() => { setComposing(false); setBar(null); }}
              onError={(m) => setBar({ kind: "err", text: m })} />
          ) : (
            <div className="ntf-list mscroll">
              {rows.map((r) => (
                <NoticeRow key={r.id} n={{ ...r, earlier: 0 }} now={now} compact={r.read && !unfolded.has(r.id)} onOpen={() => toggle(r.id)} />
              ))}
              {!rows.length && (
                <div className="ntf-empty">
                  <div className="o">no updates yet — i am as you first summoned me.</div>
                  <div className="s">the next PULL &amp; RESTART lists what changed here</div>
                </div>
              )}
            </div>
          )}
        </div>,
        document.querySelector("[data-theme]") ?? document.body,
      )}
    </>
  );
}
