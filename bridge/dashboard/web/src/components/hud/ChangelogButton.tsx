import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDownToLine, ArrowRight, ArrowUpRight, ChevronLeft, ChevronRight, Clapperboard, Copy, Download, Eye, Flame, Gauge, GitBranch, History,
  Image, Layers, MapPin, Maximize2, Palette, PanelLeft, Pause, Play, ScrollText, Search, Send, Sparkles, Trees,
  Users, X, type LucideIcon,
} from "lucide-react";
import { api, type Notice } from "../../api";
import { popPlace } from "../../lib/prchip";
import { ago, askChange, changeMarkdown, changesOf, findChanges, iconFor, mediaUrl, PLACES, safeUrl, sameArea, shortWhen, whenOf,
  type Change, type FeatIcon } from "../../lib/notices";
import { ImageLightbox } from "../ImageLightbox";

// The right rail's changelog, over UPDATE: what changed in Mystical, one change at a time
// (docs/superpowers/specs/changelog-v4.md). Each update bridge/whatsnew.py writes at a boot
// is a headline and a few bullets; here each bullet is its own change, flat and newest first,
// with no update batches and no days: the list on the left, the picked change on the right.
// A change that only shows in a state brings its picture or clip (a change note's, whatsnew
// CHANGES_DIR) and says SHOWS WHEN; one you can open gets a sketch of the app with its place
// lit and Open ›; the rest, its icon. The stage keeps its size for every change, so stepping
// never moves the box. ↑ ↓ step, ⌕ finds, ▶ NEW walks the new ones, the same-area stepper
// walks one area's changes, Ask Claude starts a session in this checkout on one change.
// An update waiting upstream (whatsnew preview) leads the list as COMING, and Update now hands it to UPDATE (hud:update).
// When one lands, the bell's poll hands it here (hud:changelog-pop) and it pops out of this
// icon with its first picture; its click, or an OS banner's (hud:changelog), opens it.
// A dot while any is unread; closing marks what it showed read. Self-contained (polls, owns
// its popover) like UpdateButton.
const POLL_MS = 60_000; // rows land at a boot; a fresh one comes by event, not by this
const STEP_MS = 5_000;  // ▶ NEW: how long a change without a clip stays

const ICON: Record<FeatIcon, LucideIcon> = { send: Send, panel: PanelLeft, gauge: Gauge, layers: Layers, flame: Flame,
  trees: Trees, users: Users, image: Image, palette: Palette, down: Download, spark: Sparkles };
const iconOf = (c: Change) => ICON[iconFor(c.area)];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const RAIL = ["files", "git", "learn", "rivendell", "team", "usage"];   // App's right-rail tabs, top down
const SETTINGS = Object.keys(PLACES).filter((k) => k.startsWith("settings:"));
const placeName = (p: string) => (p.startsWith("rail:") ? `the right rail ▸ ${p.slice(5).toUpperCase()}` : PLACES[p]);
const placeShort = (p: string) => (p.startsWith("rail:") ? p.slice(5).toUpperCase() : PLACES[p].replace("Settings ▸ ", ""));
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

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

/** A change you can open needs no picture: the app, sketched, with its place lit. */
function PlaceMap({ place }: { place: string }) {
  const [where, tab] = place.split(":");
  const L = "color-mix(in oklab, var(--txl) 15%, transparent)", L2 = "color-mix(in oklab, var(--txl) 7%, transparent)";
  const A2 = "color-mix(in oklab, var(--acc) 15%, transparent)", A3 = "color-mix(in oklab, var(--acc) 50%, transparent)";
  const rail = where === "rail", k = rail ? RAIL.indexOf(tab) : SETTINGS.indexOf(place);
  const label = (rail ? tab : PLACES[place].replace("Settings ▸ ", "")).toUpperCase();
  return (
    <svg className="clg-map" viewBox="0 0 504 315" aria-hidden>
      <rect x={18} y={58} width={468} height={16} rx={5} style={{ fill: L2 }} />
      <rect x={18} y={82} width={104} height={217} rx={8} style={{ fill: L2 }} />
      {[0, 1, 2, 3, 4, 5, 6].map((i) => <rect key={i} x={30} y={96 + i * 28} width={58 + (i * 17) % 26} height={7} rx={3} style={{ fill: L }} />)}
      <rect x={130} y={82} width={224} height={217} rx={8} style={{ fill: L2 }} />
      <rect x={196} y={96} width={146} height={22} rx={7} style={{ fill: L }} />
      <rect x={142} y={128} width={190} height={50} rx={7} style={{ fill: L2, stroke: L }} />
      <rect x={142} y={258} width={200} height={30} rx={9} style={{ fill: L2, stroke: L }} />
      <rect x={362} y={82} width={98} height={217} rx={8} style={rail ? { fill: A2, stroke: A3, strokeWidth: 1.2 } : { fill: L2 }} />
      {RAIL.map((t, i) => (rail && i === k
        ? <g key={t}><rect x={465} y={84 + i * 24} width={18} height={18} rx={5} style={{ fill: "var(--acc)" }} />
            <rect x={461} y={80 + i * 24} width={26} height={26} rx={8} style={{ fill: "none", stroke: A3, strokeWidth: 1.5 }} /></g>
        : <rect key={t} x={468} y={87 + i * 24} width={12} height={12} rx={4} style={{ fill: L }} />))}
      {rail ? <>
        <text x={374} y={102} className="clg-map-l">{label}</text>
        {[56, 30, 66, 18, 42].map((w, i) => <g key={i}><rect x={374} y={116 + i * 20} width={74} height={6} rx={3} style={{ fill: L }} />
          <rect x={374} y={116 + i * 20} width={w} height={6} rx={3} style={{ fill: A3 }} /></g>)}
      </> : <>
        <rect x={0} y={0} width={504} height={315} style={{ fill: "rgb(0 0 0 / .32)" }} />
        <rect x={96} y={70} width={312} height={222} rx={10} style={{ fill: "var(--panel)", stroke: A3, strokeWidth: 1.2 }} />
        {SETTINGS.map((s, i) => <rect key={s} x={110} y={86 + i * 24} width={i === k ? 70 : 58} height={i === k ? 14 : 8} rx={4}
          style={{ fill: i === k ? "var(--acc)" : L }} transform={i === k ? "translate(-2 -3)" : undefined} />)}
        <text x={198} y={96} className="clg-map-l">{label}</text>
        {[180, 140, 196, 120, 160, 90].map((w, i) => <rect key={i} x={198} y={110 + i * 22} width={w} height={7} rx={3} style={{ fill: L }} />)}
      </>}
    </svg>
  );
}

/** The change's picture, clip, place sketch or icon, in a box of one size for every change. A
 *  picture that won't load (gone, or a bridge too old to serve it) falls back to what it'd be without. */
function Stage({ c, playing, onEnded, onZoom }: { c: Change; playing: boolean; onEnded: () => void; onZoom: (src: string) => void }) {
  const [broken, setBroken] = useState(false);
  const [paused, setPaused] = useState(true);
  const [t, setT] = useState<[number, number]>([0, 0]);
  const vid = useRef<HTMLVideoElement>(null);
  const still = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches && !playing;
  const m = broken ? null : c.media;
  const Ic = iconOf(c);
  return (
    <div className="clg-stage">
      {m?.clip ? <>
        <video ref={vid} className="pic" src={mediaUrl(m.clip)} poster={m.still ? mediaUrl(m.still) : undefined} muted playsInline
          autoPlay={!still} loop={!playing} onPlay={() => setPaused(false)} onPause={() => setPaused(true)} onEnded={onEnded}
          onTimeUpdate={(e) => setT([e.currentTarget.currentTime, e.currentTarget.duration || 0])} onError={() => setBroken(true)} />
        <div className="clg-clipbar">
          <button title={paused ? "Play" : "Pause"} aria-label={paused ? "Play" : "Pause"}
            onClick={() => { const v = vid.current; if (v) void (v.paused ? v.play() : v.pause()); }}>
            {paused ? <Play size={11} strokeWidth={2} /> : <Pause size={11} strokeWidth={2} />}</button>
          <span className="tag">CLIP</span>
          <span className="bar"><i style={{ width: `${t[1] ? (100 * t[0]) / t[1] : 0}%` }} /></span>
          <span>{mmss(t[0])} / {mmss(t[1])}</span>
        </div>
      </> : m?.still ? <img className="pic" src={mediaUrl(m.still)} alt="" onError={() => setBroken(true)} />
        : c.place ? <PlaceMap place={c.place} />
        : <div className="clg-tc"><span className="big"><Ic size={28} strokeWidth={1.8} /></span><span className="nm">{c.area}</span>
            <span className="sub">no picture for this one</span></div>}
      {c.when ? <span className="clg-chip"><Eye size={13} strokeWidth={1.8} /><b>SHOWS WHEN</b><span className="w">{c.when}</span></span>
        : !m && c.place ? <span className="clg-chip"><MapPin size={13} strokeWidth={1.8} /><b>LIVES IN</b><span className="w">{placeName(c.place)}</span></span> : null}
      {m && <button className="clg-zoom" title="Full size" aria-label="Full size" onClick={() => onZoom(mediaUrl(m.clip ?? m.still ?? ""))}>
        <Maximize2 size={12} strokeWidth={2} /></button>}
    </div>
  );
}

export function ChangelogButton({ onFeed }: { onFeed: (texts: string[], project?: string, fresh?: boolean) => void }) {
  const [rows, setRows] = useState<Notice[] | null>(null);
  const [project, setProject] = useState("");                                 // where Ask Claude starts ("" = it can't)
  const [open, setOpen] = useState(false);
  const [pick, setPick] = useState<string | null>(null);                     // the reader's change; null = the first
  const [q, setQ] = useState<string | null>(null);                           // find: null = the field shut
  const [fresh, setFresh] = useState<Notice | null>(null);                   // the popup out of the icon
  const [picGone, setPicGone] = useState(false);                             // its picture didn't load
  const [copied, setCopied] = useState<"" | "ok" | "no">("");
  const [hov, setHov] = useState(false);
  const [zoom, setZoom] = useState<string | null>(null);                     // a picture full size (ImageLightbox)
  const [playing, setPlaying] = useState(false);                             // ▶ NEW walking the new changes
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stepRef = useRef<(d: number) => void>(() => {});
  const nextRef = useRef<() => void>(() => {});
  const holdRef = useRef(STEP_MS);

  // A bridge older than this page has no /local/changelog: no rows, so no button.
  const load = () => api.changelog().then((r) => { setRows(r.notices); setProject(r.project ?? ""); }, () => { /* next poll */ });
  // An id is a row's (an OS banner's, the popup's): open on that row's first change.
  const openOn = (id: number | null) => {
    setFresh(null); setPick(id === null ? null : String(id)); setQ(null); setPlaying(false);
    setOpen(true); void load();
  };
  useEffect(() => {
    void load();
    const id = setInterval(load, POLL_MS);
    const show = (e: Event) => { const id = (e as CustomEvent<unknown>).detail; openOn(typeof id === "number" ? id : null); };
    const landed = (e: Event) => { setFresh((e as CustomEvent<Notice>).detail); setPicGone(false); void load(); };
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
    setOpen(false); setPick(null); setQ(null); setFresh(null); setCopied("");
    setZoom(null); setPlaying(false);
    const ids = (rows ?? []).filter((r) => !r.read).map((r) => r.id);
    if (ids.length) void api.noticesRead(ids).then(load, () => { /* next poll */ });
  };
  // Closes the way UPDATE's popover does: a press outside it, or Escape (which shuts find first);
  // a picture open full size has both to itself. The press is heard in the capture phase: the
  // clip viewer shuts on pointerdown, and by bubbling time this effect has re-run with zoom gone.
  // ↑ ↓ step. Any key stops ▶ NEW, but its own Enter/Space
  // (that click toggles it, and must see it playing).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!zoom && !btnRef.current?.contains(t) && !popRef.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (zoom) return;
      if (!((e.key === "Enter" || e.key === " ") && (e.target as Element | null)?.closest?.(".clg-new"))) setPlaying(false);
      if (e.key === "Escape") { e.stopPropagation(); if (q !== null) setQ(null); else close(); return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); stepRef.current(e.key === "ArrowDown" ? 1 : -1); }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown, true); document.removeEventListener("keydown", onKey); };
  }, [open, rows, q, zoom]);
  // the picked row stays in view as ↑ ↓ (or ▶ NEW) move it
  useEffect(() => { listRef.current?.querySelector('[data-on="1"]')?.scrollIntoView({ block: "nearest" }); }, [pick, q]);
  // ▶ NEW: a change holds STEP_MS, a clip until it ends (its Stage calls next), at most 15 s
  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => nextRef.current(), holdRef.current);
    return () => clearTimeout(t);
  }, [playing, pick]);

  if (!rows) return null;
  const unread = rows.filter((r) => !r.read).length;
  const now = new Date();
  const next = rows.find((r) => r.kind === "coming");
  const all = changesOf(next ? [next, ...rows.filter((r) => r !== next)] : rows);
  const list = findChanges(all, q ?? "");
  const byRow = pick !== null && !pick.includes(".") ? list.find((c) => String(c.row.id) === pick) : undefined;
  const cur = byRow ?? list.find((c) => c.id === pick) ?? list[0];
  const isNew = (c: Change) => !c.row.read && c.row.kind !== "coming";
  const unseen = all.filter(isNew);
  holdRef.current = cur?.media?.clip ? STEP_MS * 3 : STEP_MS;
  stepRef.current = (d) => {
    const nx = list[Math.max(0, Math.min(list.length - 1, list.indexOf(cur) + d))];
    if (nx) setPick(nx.id);
  };
  // the next new change after this one; none, and ▶ NEW stops
  nextRef.current = () => {
    const nx = unseen.find((c) => all.indexOf(c) > all.indexOf(cur));
    if (nx) { setQ(null); setPick(nx.id); } else setPlaying(false);
  };
  const play = () => {
    if (playing) { setPlaying(false); return; }
    setQ(null);
    if (!cur || !isNew(cur)) setPick(unseen[0].id);
    setPlaying(true);
  };
  const copy = async (c: Change) => {
    try { await navigator.clipboard.writeText(changeMarkdown(c)); setCopied("ok"); } catch { setCopied("no"); }
    setTimeout(() => setCopied(""), 1600);
  };
  // Above the button (the rail's foot is low), right edges flush, capped like the bell.
  const W = 560;
  const rect = btnRef.current?.getBoundingClientRect();
  const place = open && rect && popPlace(rect, window.innerHeight);
  const pop = rect && place && { top: "auto", ...place, height: Math.min(488, place.maxHeight), maxHeight: undefined,
                                 right: Math.max(8, Math.min(window.innerWidth - rect.right, window.innerWidth - W - 8)) };
  // The popup sits left of the rail, its notch (index.css) on the icon's middle.
  const out = fresh && !open && rect && { right: window.innerWidth - rect.left + 10, bottom: Math.max(8, window.innerHeight - rect.bottom - 4) };
  const pics = fresh ? changesOf([fresh]).filter((c) => c.media?.still) : [];
  const theme = document.querySelector("[data-theme]") ?? document.body;
  const qq = q ?? "";

  const item = (c: Change) => {
    const Ic = iconOf(c);
    return (
      <button key={c.id} data-on={c === cur ? 1 : undefined} onClick={() => { setPlaying(false); setPick(c.id); }}
        className={`clg-row${c === cur ? " on" : ""}${isNew(c) ? " new" : ""}${c.row.kind === "coming" ? " next" : ""}`}>
        <span className="ic"><Ic size={13} strokeWidth={1.8} aria-hidden /></span>
        <span className="w">
          <b><span className="a">{marked(c.area, qq)}</span>{c.media && (c.media.clip ? <Clapperboard size={11} strokeWidth={1.8} aria-label="a clip" />
            : <Image size={11} strokeWidth={1.8} aria-label="a picture" />)}</b>
          <span className="x">{marked(cap(c.text.split("\n")[0]), qq)}</span>
        </span>
        <span className="tm">{c.row.kind === "coming" ? "coming" : shortWhen(c.row.at, now)}</span>
      </button>
    );
  };

  const reader = (c: Change) => {
    const r = c.row;
    const branch = typeof r.meta.branch === "string" ? r.meta.branch : "";
    const same = sameArea(all, c), k = same.indexOf(c);
    const go = (x: Change) => { setPlaying(false); setQ(null); setPick(x.id); };
    return (
      <div className="clg-read mscroll">
        <Stage key={c.id} c={c} playing={playing} onEnded={() => nextRef.current()} onZoom={setZoom} />
        <div key={`t${c.id}`} className="clg-t">
          <div className="h">
            <b>{marked(c.area, qq)}</b>
            {isNew(c) && <span className="clg-tag">NEW</span>}
            {r.kind === "coming" && <span className="clg-tag ok">COMING</span>}
            <span className="tm">{r.kind === "coming" ? "not installed yet" : whenOf(r.at, now)}</span>
          </div>
          {c.text && <div className="x">{marked(cap(c.text), qq)}</div>}
        </div>
        <div className="clg-acts">
          {r.kind === "coming" ? (
            <button className="ok" onClick={() => { close(); window.dispatchEvent(new CustomEvent("hud:update")); }}>
              <ArrowDownToLine size={12} strokeWidth={1.8} />Update now</button>
          ) : <>
            {c.place && <button className="pri" title={`Open ${PLACES[c.place]}`} onClick={() => { close(); goTo(c.place!); }}>
              Open {placeShort(c.place)}<ArrowRight size={12} strokeWidth={1.8} /></button>}
            {project && r.kind === "updated" && (
              <button onClick={() => { close(); onFeed([askChange(c)], project, true); }}><Sparkles size={12} strokeWidth={1.8} />Ask Claude</button>
            )}
            <button onClick={() => void copy(c)}><Copy size={12} strokeWidth={1.8} />
              {copied === "ok" ? "Copied" : copied === "no" ? "Couldn't copy" : "Copy"}</button>
          </>}
          {same.length > 1 && (
            <span className="clg-same" title={`Only the ${c.area.split(/\s+/)[0]} changes`}>
              <History size={12} strokeWidth={1.8} /><b>{cap(c.area.split(/\s+/)[0])}</b> {k + 1} of {same.length}
              <button disabled={k <= 0} title="Newer" aria-label="Newer" onClick={() => go(same[k - 1])}><ChevronLeft size={12} strokeWidth={2} /></button>
              <button disabled={k >= same.length - 1} title="Older" aria-label="Older" onClick={() => go(same[k + 1])}><ChevronRight size={12} strokeWidth={2} /></button>
            </span>
          )}
        </div>
        <div className="clg-mline">
          <span>{r.kind === "coming" ? "in the waiting update ·" : `from the ${shortWhen(r.at, now)} update ·`}</span>
          <Meta r={r} />
          <span style={{ flex: 1 }} />
          {branch && <span className="br"><GitBranch size={11} strokeWidth={1.8} aria-hidden />{r.kind === "coming" ? `waiting on ${branch}` : branch}</span>}
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
        <div key={fresh.id} className="clg-co" style={out} role="status" onClick={() => openOn(fresh.id)}>
          <div className="in">
            {pics.length > 0 && !picGone && (
              <div className="clg-co-pic"><img src={mediaUrl(pics[0].media!.still!)} alt="" onError={() => setPicGone(true)} />
                {pics.length > 1 && <span className="n">{pics.length} PICTURES</span>}</div>
            )}
            <div className="clg-co-h">
              <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" className="clg-ic">
                <path d="M12 3 21 12 12 21 3 12Z" /><path d="M12 9 15 12 12 15 9 12Z" fill="currentColor" stroke="none" />
              </svg>
              <span className="v">{fresh.verb}</span>
              <span className="w">{ago(fresh.at, now.getTime() / 1000)}</span>
            </div>
            <div className="clg-co-t">{fresh.title}</div>
            <div className="clg-co-b">{fresh.body.split("\n").filter(Boolean).map((l) => l.split(" — ")[0]).join(" · ")}</div>
            <div className="clg-co-f">
              <span>{`${fresh.meta.commits ?? 0} commit${fresh.meta.commits === 1 ? "" : "s"}`}</span>
              <span style={{ flex: 1 }} />
              <span className="go">See what changed ›</span>
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
        // hidden, not shut, under a picture open full size: the lightbox shares its z-index
        <div ref={popRef} className="ntf-pop clg-pop" style={{ position: "fixed", zIndex: 96, width: W, ...pop, visibility: zoom ? "hidden" : undefined }}>
          <div className="ntf-head">
            <span className="t">CHANGELOG</span>
            {unseen.length > 0 && (
              <button className={`clg-new${playing ? " on" : ""}`} onClick={play}
                title={playing ? "Stop" : `Walk through the ${unseen.length} new change${unseen.length === 1 ? "" : "s"}`}>
                {playing ? <Pause size={9} strokeWidth={2.4} /> : <Play size={9} strokeWidth={2.4} />}
                {playing ? `${unseen.indexOf(cur) + 1} / ${unseen.length}` : `${unseen.length} NEW`}
              </button>
            )}
            {q === null ? (
              <button className="clg-ib" title="Find a change" aria-label="Find a change" onClick={() => { setPlaying(false); setQ(""); }}><Search size={15} strokeWidth={1.8} /></button>
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
            <div className="clg-split" onPointerEnter={() => setPlaying(false)}>
              <div className="clg-list mscroll" ref={listRef}>
                {list.map(item)}
                {!list.length && <div className="clg-none">Nothing about “{qq.trim()}” in the last {all.length} changes.</div>}
              </div>
              {cur ? reader(cur) : <div className="clg-read" />}
            </div>
          )}
          {list.length > 1 && cur && (
            <div className="ntf-foot">
              <span className="clg-pos">↑ ↓
                <button title="Newer" aria-label="Newer" disabled={list.indexOf(cur) <= 0} onClick={() => stepRef.current(-1)}><ChevronLeft size={13} strokeWidth={2} /></button>
                <span><b>{list.indexOf(cur) + 1}</b> of {list.length}</span>
                <button title="Older" aria-label="Older" disabled={list.indexOf(cur) >= list.length - 1} onClick={() => stepRef.current(1)}><ChevronRight size={13} strokeWidth={2} /></button>
              </span>
            </div>
          )}
        </div>,
        theme,
      )}
      {zoom && <ImageLightbox src={zoom} onClose={() => setZoom(null)} />}
    </>
  );
}
