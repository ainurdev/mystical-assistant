import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDownToLine, ArrowRight, ArrowUpRight, Copy, Download, Flame, Gauge, GitBranch, Image, Layers, MessageSquareText,
  Palette, PanelLeft, Pencil, ScrollText, Search, Send, Sparkles, Trees, Users, X, type LucideIcon,
} from "lucide-react";
import { api, type Notice } from "../../api";
import { popPlace } from "../../lib/prchip";
import { ago, askPrompt, byDay, findIn, iconFor, leadOf, nodeSize, notesMarkdown, notesOf, PLACES, placesOf, safeUrl, stamp,
  weekBars, type FeatIcon } from "../../lib/notices";
import { NoteComposer } from "./NoteComposer";

// The right rail's changelog, over UPDATE: what each update changed (a headline and a
// few bullets bridge/whatsnew.py writes at a boot that found new commits) and the notes
// maintainers wrote for every install, with the form that writes one. It was the bell's
// Updates tab; the bell is your sessions, this is Mystical itself.
// A list and a reader (docs/superpowers/specs/changelog-v3.md): the
// list is a spine of updates under their days, a node per update sized by its commits
// and filled while unread; the reader is the picked one, each feature with its icon and,
// where the model named a place for it (whatsnew PLACES), Open › to go there. ↑ ↓ step,
// the header's bars are the week's commits and jump to a day, ⌕ finds a change across
// the 50 kept. Ask Claude about it starts a session in this checkout on the update.
// When one lands, the bell's poll hands it here (hud:changelog-pop) and it pops out of
// this icon; its click, or an OS banner's (hud:changelog), opens the reader on it. A dot
// while any is unread; closing marks what it showed read. An update waiting upstream
// (bridge/whatsnew.py preview) sits on top as COMING, and Update now hands it to UPDATE
// (hud:update), where pulling and its errors live. Self-contained (polls, owns its
// popover) like UpdateButton.
const POLL_MS = 60_000; // rows land at a boot or a SEND NOTE; a fresh one comes by event, not by this

const ICON: Record<FeatIcon, LucideIcon> = { send: Send, panel: PanelLeft, gauge: Gauge, layers: Layers, flame: Flame,
  trees: Trees, users: Users, image: Image, palette: Palette, down: Download, spark: Sparkles };

/** An update's bullets: the lead bold, split at the first " — ". UPDATE's preview draws these. */
export function Bullets({ body }: { body: string }) {
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
export function Meta({ r }: { r: Notice }) {
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

/** Every match of q in s, marked. */
function marked(s: string, q: string): ReactNode {
  const k = q.trim();
  if (!k) return s;
  return s.split(new RegExp(`(${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`, "ig"))
    .map((part, i) => (i % 2 ? <mark key={i} className="clg-m">{part}</mark> : part));
}

/** Open ›: a Settings tab, or a right-rail tab (App's hud:rail). */
function goTo(place: string) {
  const [where, tab] = place.split(":");
  window.dispatchEvent(new CustomEvent(where === "rail" ? "hud:rail" : "hud:settings", { detail: tab }));
}

export function ChangelogButton({ onFeed }: { onFeed: (texts: string[], project?: string, fresh?: boolean) => void }) {
  const [rows, setRows] = useState<Notice[] | null>(null);
  const [project, setProject] = useState("");                                 // where Ask Claude starts ("" = it can't)
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<number | null>(null);                     // the reader's row; null = the first
  const [q, setQ] = useState<string | null>(null);                           // find: null = the field shut
  const [fresh, setFresh] = useState<Notice | null>(null);                   // the popup out of the icon
  const [composing, setComposing] = useState(false);
  const [bar, setBar] = useState<{ kind: "ok" | "err"; text: string } | null>(null);
  const [copied, setCopied] = useState<"" | "ok" | "no">("");
  const [hov, setHov] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stepRef = useRef<(d: number) => void>(() => {});

  // A bridge older than this page has no /local/changelog: no rows, so no button.
  const load = () => api.changelog().then((r) => { setRows(r.notices); setProject(r.project ?? ""); }, () => { /* next poll */ });
  const openOn = (id: number | null) => {
    setFresh(null); setPick(id); setQ(null);
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
    setOpen(false); setComposing(false); setBar(null); setPick(null); setQ(null); setFresh(null); setCopied("");
    const ids = (rows ?? []).filter((r) => !r.read).map((r) => r.id);
    if (ids.length) void api.noticesRead(ids).then(load, () => { /* next poll */ });
  };
  // Closes the way UPDATE's popover does: a press outside it, or Escape (which shuts find first).
  // ↑ ↓ step through the list, unless a note is being written.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!btnRef.current?.contains(t) && !popRef.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.stopPropagation(); if (q !== null) setQ(null); else close(); return; }
      if ((e.key === "ArrowDown" || e.key === "ArrowUp") && !composing) { e.preventDefault(); stepRef.current(e.key === "ArrowDown" ? 1 : -1); }
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open, rows, q, composing]);
  // the picked row stays in view as ↑ ↓ move it
  useEffect(() => { listRef.current?.querySelector('[data-on="1"]')?.scrollIntoView({ block: "nearest" }); }, [pick, q]);

  if (!rows) return null;
  const unread = rows.filter((r) => !r.read).length;
  const now = new Date();
  const next = rows.find((r) => r.kind === "coming");
  const taken = rows.filter((r) => r !== next);
  const list = findIn(next ? [next, ...taken] : taken, q ?? "");
  const cur = list.find((r) => r.id === pick) ?? list[0];
  stepRef.current = (d) => {
    const nx = list[Math.max(0, Math.min(list.length - 1, list.indexOf(cur) + d))];
    if (nx) setPick(nx.id);
  };
  const week = weekBars(taken, now);
  const most = Math.max(...week, 1);
  const total = week.reduce((a, b) => a + b, 0);
  // a bar: that day's newest update
  const jump = (i: number) => {
    const from = new Date(now).setHours(0, 0, 0, 0) / 1000 - (6 - i) * 86400;
    const hit = taken.find((r) => r.at >= from && r.at < from + 86400);
    if (hit) { setQ(null); setPick(hit.id); }
  };
  const copy = async (r: Notice) => {
    const text = r.kind === "note" ? `**${r.title}**\n\n${r.body}` : notesMarkdown(r, now);
    try { await navigator.clipboard.writeText(text); setCopied("ok"); } catch { setCopied("no"); }
    setTimeout(() => setCopied(""), 1600);
  };
  // Above the button (the rail's foot is low), right edges flush, capped like the bell.
  const W = 540;
  const rect = btnRef.current?.getBoundingClientRect();
  const place = open && rect && popPlace(rect, window.innerHeight);
  const pop = rect && place && { top: "auto", ...place, height: Math.min(440, place.maxHeight), maxHeight: undefined,
                                 right: Math.max(8, Math.min(window.innerWidth - rect.right, window.innerWidth - W - 8)) };
  // The popup sits left of the rail, its notch (index.css) on the icon's middle.
  const out = fresh && !open && rect && { right: window.innerWidth - rect.left + 10, bottom: Math.max(8, window.innerHeight - rect.bottom - 4) };
  const theme = document.querySelector("[data-theme]") ?? document.body;
  const qq = q ?? "";

  const item = (r: Notice) => (
    <button key={r.id} data-on={r === cur ? 1 : undefined} onClick={() => setPick(r.id)}
      className={`clg-it${r === cur ? " on" : ""}${r.read ? "" : " new"}${r.kind === "coming" ? " next" : ""}`}>
      <i className={`n s${r.kind === "note" ? 1 : nodeSize(r)}`} aria-hidden />
      <span className="t">{r.kind === "coming" ? "not installed yet" : stamp(r.at, now).time}{r.kind === "note" && " · note"}</span>
      <span className="s">{marked(r.title, qq)}</span>
    </button>
  );

  const reader = (r: Notice) => {
    const d = new Date(r.at * 1000);
    const places = r.kind === "updated" ? placesOf(r) : [];
    const branch = typeof r.meta.branch === "string" ? r.meta.branch : "";
    const by = typeof r.meta.author === "string" ? r.meta.author : "";
    return (
      <div key={r.id} className="clg-read mscroll">
        <div className="clg-when">
          {r.kind === "coming" ? <span className="clg-tag ok">COMING</span>
            : <span>{d.toLocaleDateString("en", { weekday: "short", month: "short", day: "numeric" })} · {stamp(r.at, now).time}</span>}
          {r.kind === "note" && by && <span>· note from {by}</span>}
        </div>
        <div className="clg-h">{marked(r.title, qq)}</div>
        {r.kind === "note" ? <div className="clg-note">{marked(r.body, qq)}</div> : (
          <div className="clg-feats">
            {r.body.split("\n").filter(Boolean).map((line, i) => {
              const [lead, text] = leadOf(line);
              const Ic = ICON[iconFor(lead || text)];
              const to = places[i];
              return (
                <div key={i} className="clg-f">
                  <span className="ic"><Ic size={13} strokeWidth={1.8} aria-hidden /></span>
                  <span className="x">{lead && <><b>{marked(lead, qq)}</b> — </>}{marked(text, qq)}</span>
                  {to ? <button className="go" title={`Open ${PLACES[to]}`} onClick={() => { close(); goTo(to); }}>
                    Open<ArrowRight size={11} strokeWidth={2} aria-hidden /></button> : <span />}
                </div>
              );
            })}
          </div>
        )}
        {r.kind === "coming" && notesOf(r).map((n) => (
          <div key={n.heading} className="clg-cnote"><MessageSquareText size={12} strokeWidth={1.8} />
            <span><b>{n.title}</b>{n.author && <i> — note from {n.author}</i>}</span></div>
        ))}
        <div className="clg-rfoot">
          {r.kind !== "note" && (
            <div className="clg-mline">
              <Meta r={r} />
              <span style={{ flex: 1 }} />
              {branch && <span className="br"><GitBranch size={11} strokeWidth={1.8} aria-hidden />{r.kind === "coming" ? `waiting on ${branch}` : branch}</span>}
            </div>
          )}
          <div className="clg-acts">
            {r.kind === "coming" ? (
              <button className="ok" onClick={() => { close(); window.dispatchEvent(new CustomEvent("hud:update")); }}>
                <ArrowDownToLine size={12} strokeWidth={1.8} />Update now</button>
            ) : (
              <>
                {project && r.kind === "updated" && (
                  <button className="pri" onClick={() => { close(); onFeed([askPrompt(r)], project, true); }}>
                    <Sparkles size={12} strokeWidth={1.8} />Ask Claude about it</button>
                )}
                <button onClick={() => void copy(r)}><Copy size={12} strokeWidth={1.8} />
                  {copied === "ok" ? "Copied" : copied === "no" ? "Couldn't copy" : r.kind === "note" ? "Copy note" : "Copy notes"}</button>
              </>
            )}
          </div>
        </div>
      </div>
    );
  };

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
              <span className="w">{ago(fresh.at, now.getTime() / 1000)}{fresh.kind === "note" && typeof fresh.meta.author === "string" ? ` · by ${fresh.meta.author}` : ""}</span>
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
        <div ref={popRef} className="ntf-pop clg-pop" style={{ position: "fixed", zIndex: 96, width: W, ...pop }}>
          <div className="ntf-head">
            <span className="t">CHANGELOG</span>
            {total > 0 && (
              <span className="clg-week" aria-label={`${total} commits this week`}>
                {week.map((c, i) => (
                  <button key={i} className={i === 6 ? "today" : ""} disabled={!c} onClick={() => jump(i)}
                    title={`${new Date(now.getTime() - (6 - i) * 864e5).toLocaleDateString("en", { weekday: "short" })} · ${c} commit${c === 1 ? "" : "s"}`}
                    style={{ height: c ? Math.max(3, Math.round(18 * c / most)) : 2 }} />
                ))}
              </span>
            )}
            {total > 0 && <span className="clg-wcap">{total} commits this week</span>}
            {q === null ? (
              <button className="clg-ib" title="Find a change" aria-label="Find a change" onClick={() => setQ("")}><Search size={15} strokeWidth={1.8} /></button>
            ) : (
              <label className="clg-find">
                <Search size={13} strokeWidth={1.8} aria-hidden />
                <input autoFocus value={q} onChange={(e) => { setQ(e.target.value); setPick(null); }} placeholder="Find a change" aria-label="Find a change" />
                <button title="Clear" aria-label="Clear" onClick={() => setQ(null)}><X size={12} strokeWidth={2} /></button>
              </label>
            )}
          </div>
          {!rows.length ? (
            <div className="ntf-list">
              <div className="ntf-empty">
                <div className="o">no updates yet — i am as you first summoned me.</div>
                <div className="s">the next PULL &amp; RESTART lists what changed here</div>
              </div>
            </div>
          ) : (
            <div className="clg-split">
              <div className="clg-list mscroll" ref={listRef}>
                {next && list.includes(next) && <><div className="clg-day">COMING</div>{item(next)}</>}
                {byDay(list.filter((r) => r !== next), now).map((g) => (
                  <Fragment key={g.day}><div className="clg-day">{g.day}</div>{g.rows.map(item)}</Fragment>
                ))}
                {!list.length && <div className="clg-none">Nothing about “{qq.trim()}” in the last {taken.length} updates.</div>}
              </div>
              {cur ? reader(cur) : <div className="clg-read" />}
            </div>
          )}
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
              {list.length > 1 && cur && <span className="clg-k">↑ ↓ · {list.indexOf(cur) + 1} of {list.length}</span>}
            </div>
          )}
        </div>,
        theme,
      )}
    </>
  );
}
