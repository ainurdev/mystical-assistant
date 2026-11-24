import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { rail, reread } from "../../lib/queries";
import { createPortal } from "react-dom";
import {
  ArrowDownToLine, ArrowRight, ArrowUpFromLine, ArrowUpRight, ChevronLeft, ChevronRight, Clapperboard, Clock, Copy, Download, Eye, Flame, Gauge, GitBranch, History,
  Image, Layers, MapPin, Maximize2, Palette, PanelLeft, Pause, Play, RefreshCw, Search, Send, Sparkles, Trees,
  Users, X, type LucideIcon,
} from "lucide-react";
import { api, type LiveInfo, type Notice, type UpdateInfo } from "../../api";
import { notify } from "./Notifications";
import { DONE, LiveReader } from "./LiveReader";
import { UpdateReader, type Feed } from "./UpdateButton";
import { watchRestart } from "../../lib/restart";
import { popFor } from "../../lib/golive";
import { popPlace } from "../../lib/prchip";
import { ago, askChange, changeMarkdown, changesOf, findChanges, iconFor, mediaUrl, PLACES, safeUrl, sameArea, shortWhen, whenOf,
  type Change, type FeatIcon } from "../../lib/notices";
import { ImageLightbox } from "../ImageLightbox";

// The right rail's one release button: the changelog, with GO LIVE, UPDATE and SHIP pinned
// at the top of its list when there's something to do (docs/superpowers/specs/release-hub.md).
// Picking one of those reads it like any change, with its steps drawn on the stage and its
// buttons (LiveReader, UpdateReader); the rail icon's badge is the most urgent of them.
// The changelog itself: what changed in Mystical, one change at a time
// (docs/superpowers/specs/changelog-v4.md). Each update bridge/whatsnew.py writes at a boot
// is a headline and a few bullets; here each bullet is its own change, flat and newest first,
// with no update batches and no days: the list on the left, the picked change on the right.
// A change that only shows in a state brings its picture or clip (a change note's, whatsnew
// CHANGES_DIR) and says SHOWS WHEN; one you can open gets a sketch of the app with its place
// lit and Open ›; the rest, its icon. The stage keeps its size for every change, so stepping
// never moves the box. ↑ ↓ step, ⌕ finds, ▶ NEW walks the new ones, the same-area stepper
// walks one area's changes, Ask Claude starts a session in this checkout on one change.
// An update waiting upstream (whatsnew preview) leads the changes as COMING, and Update now picks the UPDATE row.
// When one lands, the bell's poll hands it here (hud:changelog-pop) and it pops out of this
// icon with its first picture; its click, or an OS banner's (hud:changelog), opens it. A waiting
// update pops the same way (hud:update-pop; hud:update opens its row), and so does a commit
// that isn't live yet. A dot while any change is unread; closing marks what it showed read.
// Self-contained (polls, owns its popover), so the rail stays a dumb list.
const POLL_MS = 60_000; // rows land at a boot; a fresh one comes by event, not by this
const LIVE_MS = 30_000;  // git only, no network: a merge lights GO LIVE within the half minute
const QUEUED_MS = 4_000; // while a wait is on, so its restart is met by the boot screen
const SEEN = "golive-seen"; // the newest not-live commit time it has popped for or seen
type Sys = "live" | "update" | "ship";
const SYS: Sys[] = ["live", "update", "ship"];
const isSys = (k: string | null): k is Sys => SYS.includes(k as Sys);
const STEP_MS = 5_000;  // ▶ NEW: how long a change without a clip stays

const ICON: Record<FeatIcon, LucideIcon> = { send: Send, panel: PanelLeft, gauge: Gauge, layers: Layers, flame: Flame,
  trees: Trees, users: Users, image: Image, palette: Palette, down: Download, spark: Sparkles };
const iconOf = (c: Change) => ICON[iconFor(c.area)];
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const RAIL = ["files", "git", "learn", "rivendell", "usage"];   // App's right-rail tabs, top down
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
  const rail = where === "rail", k = rail ? RAIL.indexOf(tab === "team" ? "rivendell" : tab) : SETTINGS.indexOf(place);
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

export function ChangelogButton({ onFeed }: { onFeed: Feed }) {
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
  const [live, setLive] = useState<LiveInfo | null>(null);                   // GO LIVE: what's on disk but not running
  const upd: UpdateInfo | null = useQuery(rail.update()).data ?? null;     // UPDATE / SHIP: this checkout vs its upstream (polled, lib/queries)
  const [busy, setBusy] = useState(false);                                   // a reader's job is mid-flight: no closing, no switching
  const [livePop, setLivePop] = useState<{ subject: string; fresh: number; restart: boolean; total: number } | null>(null);
  const [updFresh, setUpdFresh] = useState<Notice | null>(null);             // a waiting update, popped out of the icon
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stepRef = useRef<(d: number) => void>(() => {});
  const nextRef = useRef<() => void>(() => {});
  const holdRef = useRef(STEP_MS);

  // A bridge older than this page has no /local/changelog: no rows, so no button.
  const load = () => api.changelog().then((r) => { setRows(r.notices); setProject(r.project ?? ""); }, () => { /* next poll */ });
  const queuedRef = useRef(false);
  async function loadLive() {
    try {
      setLive(await api.live());
    } catch {
      // A wait's restart is underway: meet it with the boot screen, which reloads into the new build.
      if (queuedRef.current) { queuedRef.current = false; void watchRestart("GO LIVE"); }
    }
  }
  const loadUpd = () => reread(rail.update().queryKey);
  // An id is a row's (an OS banner's, the popup's): open on that row's first change; a Sys key, on that row.
  const openOn = (id: number | Sys | null) => {
    setFresh(null); setLivePop(null); setUpdFresh(null);
    setPick(id === null ? null : String(id)); setQ(null); setPlaying(false);
    setOpen(true); void load(); void loadLive(); void loadUpd();
  };
  useEffect(() => {
    void load();
    const id = setInterval(load, POLL_MS);
    const show = (e: Event) => { const id = (e as CustomEvent<unknown>).detail; openOn(typeof id === "number" ? id : null); };
    const landed = (e: Event) => { setFresh((e as CustomEvent<Notice>).detail); setPicGone(false); void load(); };
    const updShow = () => openOn("update");
    const updLanded = (e: Event) => { setUpdFresh((e as CustomEvent<Notice>).detail); void loadUpd(); };
    window.addEventListener("hud:changelog", show);
    window.addEventListener("hud:changelog-pop", landed);
    window.addEventListener("hud:update", updShow);
    window.addEventListener("hud:update-pop", updLanded);
    // What a rebuild-only reload went live with: said once the new page is up.
    const done = sessionStorage.getItem(DONE);
    if (done) { sessionStorage.removeItem(DONE); notify("info", done); }
    return () => {
      clearInterval(id);
      window.removeEventListener("hud:changelog", show);
      window.removeEventListener("hud:changelog-pop", landed);
      window.removeEventListener("hud:update", updShow);
      window.removeEventListener("hud:update-pop", updLanded);
    };
  }, []);

  const queued = !!live?.queued;
  useEffect(() => { queuedRef.current = queued; }, [queued]);
  useEffect(() => {
    void loadLive();
    const id = setInterval(loadLive, queued ? QUEUED_MS : LIVE_MS);
    const focus = () => void loadLive();
    window.addEventListener("focus", focus);
    return () => { clearInterval(id); window.removeEventListener("focus", focus); };
  }, [queued]);

  // A commit that isn't live and is newer than any it has seen pops out of the icon, once.
  // The first look only takes note: what was behind already isn't news.
  useEffect(() => {
    if (!live?.parts.length) return;
    const newest = Math.max(...live.parts.flatMap((p) => p.commits.map((c) => c.at)), 0);
    if (!newest) return;
    const seen = Number(localStorage.getItem(SEEN) || 0);
    if (newest > seen) localStorage.setItem(SEEN, String(newest));
    if (!seen || open) return;
    const p = popFor(live.parts, seen);
    if (p) setLivePop({ subject: p.newest.subject, fresh: p.fresh, total: live.commits,
                        restart: live.parts.some((x) => x.act === "restart") });
  }, [live]);

  const close = () => {
    // fresh too: one that landed while this was open was read here, it doesn't pop on the way out
    setOpen(false); setPick(null); setQ(null); setFresh(null); setLivePop(null); setUpdFresh(null); setCopied("");
    setZoom(null); setPlaying(false);
    const ids = (rows ?? []).filter((r) => !r.read).map((r) => r.id);
    if (ids.length) void api.noticesRead(ids).then(load, () => { /* next poll */ });
  };
  // Closes the way UPDATE's popover does: a press outside it, or Escape (which shuts find first);
  // a picture open full size has both to itself. The press is heard in the capture phase: the
  // clip viewer shuts on pointerdown, and by bubbling time this effect has re-run with zoom gone.
  // ↑ ↓ step. Any key stops ▶ NEW, but its own Enter/Space
  // (that click toggles it, and must see it playing).
  // A job mid-flight (a build, a pull, a push) holds it open, the way UPDATE's popover did.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!zoom && !busy && !btnRef.current?.contains(t) && !popRef.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (zoom || busy) return;
      if (!((e.key === "Enter" || e.key === " ") && (e.target as Element | null)?.closest?.(".clg-new"))) setPlaying(false);
      if (e.key === "Escape") { e.stopPropagation(); if (q !== null) setQ(null); else { close(); btnRef.current?.focus(); } return; }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); stepRef.current(e.key === "ArrowDown" ? 1 : -1); }
    };
    document.addEventListener("pointerdown", onDown, true);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("pointerdown", onDown, true); document.removeEventListener("keydown", onKey); };
  }, [open, rows, q, zoom, busy]);
  // Opening moves focus into the dialog (not onto a button: Enter mustn't restart anything by accident).
  useEffect(() => { if (open) requestAnimationFrame(() => popRef.current?.focus({ preventScroll: true })); }, [open]);
  // the picked row stays in view as ↑ ↓ (or ▶ NEW) move it
  useEffect(() => { listRef.current?.querySelector('[data-on="1"]')?.scrollIntoView({ block: "nearest" }); }, [pick, q]);
  // ▶ NEW: a change holds STEP_MS, a clip until it ends (its Stage calls next), at most 15 s
  useEffect(() => {
    if (!playing) return;
    const t = setTimeout(() => nextRef.current(), holdRef.current);
    return () => clearTimeout(t);
  }, [playing, pick]);

  if (!rows && !live?.repo && !upd?.repo) return null;
  const rws = rows ?? [];
  const unread = rws.filter((r) => !r.read).length;
  const now = new Date();
  const next = rws.find((r) => r.kind === "coming");
  const all = changesOf(next ? [next, ...rws.filter((r) => r !== next)] : rws);
  const list = findChanges(all, q ?? "");
  const byRow = pick !== null && !pick.includes(".") ? list.find((c) => String(c.row.id) === pick) : undefined;
  const cur = byRow ?? list.find((c) => c.id === pick) ?? list[0];
  const isNew = (c: Change) => !c.row.read && c.row.kind !== "coming";
  const unseen = all.filter(isNew);
  // GO LIVE / UPDATE / SHIP: pinned over the changes while there's something to do (or it's being read).
  const liveOn = !!live?.repo && (live.parts.length > 0 || !!live.queued || !!live.error);
  const incoming = upd?.repo ? upd.behind ?? 0 : 0;
  const local = upd?.repo ? (upd.dirty ?? 0) + (upd.ahead ?? 0) : 0;
  const pinned = SYS.filter((k) => (k === "live" ? !!live?.repo : !!upd?.repo)
    && (pick === k || (k === "live" ? liveOn : k === "update" ? incoming > 0 : local > 0)));
  // Opened plainly, it reads the most urgent job; a change only once you pick one (or find).
  const sys: Sys | null = isSys(pick) ? (pinned.includes(pick) ? pick : null) : pick === null && !q ? pinned[0] ?? null : null;
  const keys = [...pinned, ...list.map((c) => c.id)];
  holdRef.current = cur?.media?.clip ? STEP_MS * 3 : STEP_MS;
  stepRef.current = (d) => {
    if (busy) return;
    const nx = keys[Math.max(0, Math.min(keys.length - 1, keys.indexOf(sys ?? cur?.id ?? "") + d))];
    if (nx) setPick(nx);
  };
  // the next new change after this one; none, and ▶ NEW stops
  nextRef.current = () => {
    const nx = unseen.find((c) => all.indexOf(c) > all.indexOf(cur));
    if (nx) { setQ(null); setPick(nx.id); } else setPlaying(false);
  };
  const play = () => {
    if (playing) { setPlaying(false); return; }
    setQ(null);
    if (sys || !cur || !isNew(cur)) setPick(unseen[0].id);
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
  const out = (fresh || updFresh || livePop) && !open && rect && { right: window.innerWidth - rect.left + 10, bottom: Math.max(8, window.innerHeight - rect.bottom - 4) };
  const pics = fresh ? changesOf([fresh]).filter((c) => c.media?.still) : [];
  const theme = document.querySelector("[data-theme]") ?? document.body;
  const qq = q ?? "";

  const item = (c: Change) => {
    const Ic = iconOf(c);
    return (
      <button key={c.id} data-on={!sys && c === cur ? 1 : undefined} aria-current={!sys && c === cur ? "true" : undefined} onClick={() => { if (busy) return; setPlaying(false); setPick(c.id); }}
        className={`clg-row${!sys && c === cur ? " on" : ""}${isNew(c) ? " new" : ""}${c.row.kind === "coming" ? " next" : ""}`}>
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
            <button className="ok" onClick={() => { setPlaying(false); setPick("update"); }}>
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

  const SYS_ROW: Record<Sys, { icon: LucideIcon; tone: string; name: string; text: string; tm: string }> = {
    live: { icon: RefreshCw, tone: live?.error ? "var(--err)" : "var(--acc)", name: "Go live",
            text: live?.error ? `${live.error.name} didn't build` : live?.queued ? "waits on the running turns"
              : live?.commits ? `${live.commits} commit${live.commits === 1 ? "" : "s"} on disk, not running` : "edits on disk, not running",
            tm: live?.error ? "!" : live?.queued ? "wait" : live?.commits ? String(live.commits) : "" },
    update: { icon: ArrowDownToLine, tone: "var(--ok)", name: "Update",
              text: upd?.coming?.title ?? `${incoming} new commit${incoming === 1 ? "" : "s"} upstream`, tm: `↓${incoming}` },
    ship: { icon: ArrowUpFromLine, tone: "var(--warn)", name: "Ship yours",
            text: [upd?.dirty ? `${upd.dirty} file${upd.dirty === 1 ? "" : "s"}` : "", upd?.ahead ? `${upd.ahead} commit${upd.ahead === 1 ? "" : "s"} unpushed` : ""].filter(Boolean).join(", "),
            tm: `↑${local}` },
  };
  const sysItem = (k: Sys) => {
    const r = SYS_ROW[k];
    return (
      <button key={k} data-on={sys === k ? 1 : undefined} aria-current={sys === k ? "true" : undefined} onClick={() => { if (busy) return; setPlaying(false); setPick(k); }}
        className={`clg-row sys${sys === k ? " on" : ""}`} style={{ ["--t" as string]: r.tone }}>
        <span className="ic"><r.icon size={13} strokeWidth={1.8} aria-hidden /></span>
        <span className="w"><b><span className="a">{r.name}</span></b><span className="x">{r.text}</span></span>
        <span className="tm">{r.tm}</span>
      </button>
    );
  };
  const sysReader = (k: Sys) => k === "live"
    ? <LiveReader info={live!} reload={loadLive} onFeed={onFeed} onBusy={setBusy} onClose={close} />
    : <UpdateReader key={k} info={upd!} side={k === "update" ? "pull" : "ship"} reload={loadUpd} onFeed={onFeed} onBusy={setBusy} onClose={close}
        onShip={() => setPick("ship")} />;

  // The icon's one badge is the most urgent thing; pips under it say which kinds wait, once two do.
  const going = busy || (!!live?.queued && (!!live.queued.restarting || !live.queued.turns.length));
  const badge = going ? null
    : live?.error ? <span className="gl-pill bad">!</span>
    : live?.queued ? <span className="gl-pill q"><Clock size={10} strokeWidth={2.2} /></span>
    : liveOn ? (live!.commits ? <span className="gl-pill">{live!.commits > 99 ? "99+" : live!.commits}</span> : <span className="gl-dot" />)
    : incoming ? <span className="gl-pill ok">{incoming > 99 ? "99+" : incoming}</span>
    : local ? <span className="gl-dot warn" />
    : unread ? <span className="gl-dot" /> : null;
  const pips = [liveOn && "var(--acc)", incoming > 0 && "var(--ok)", local > 0 && "var(--warn)"].filter(Boolean) as string[];
  const waiting = liveOn || incoming > 0 || local > 0;
  const btnTitle = [
    live?.error ? `Go live — ${live.error.name} didn't build` : live?.queued ? "Goes live when the running turns end"
      : liveOn ? `Go live — ${live!.commits || "changes"} on disk not running` : "",
    incoming ? `Update — ${incoming} new upstream` : "",
    local ? `Ship — ${local} of yours` : "",
    unread ? `Changelog — ${unread} new` : "",
  ].filter(Boolean).join(" · ") || "Changelog — what changed in Mystical";
  // A pop-out's way in is a real button (Later beside it); the card's own click is a mouse shortcut.
  // These wait for an answer; only the news pop-out below (a change landed) times out, with its bar.
  const coFoot = (foot: string, go: string, onGo: () => void, onX: () => void) => (
    <div className="clg-co-f">
      <button className="go" onClick={(e) => { e.stopPropagation(); onGo(); }}>{go}</button>
      <button onClick={(e) => { e.stopPropagation(); onX(); }}>Later</button>
      <span style={{ flex: 1 }} /><span>{foot}</span>
    </div>
  );
  const coX = (onX: () => void) => (
    <button className="x" title="Dismiss" aria-label="Dismiss" onClick={(e) => { e.stopPropagation(); onX(); }}><X size={15} strokeWidth={1.8} /></button>
  );
  const callout = (icon: ReactNode, verb: string, when: string, title: string, body: string, foot: string, go: string, onGo: () => void, onX: () => void, cls = "") => (
    <div className={`clg-co ${cls}`} style={out || undefined} onClick={onGo}>
      <div className="in">
        <div className="clg-co-h">{icon}<span className="v">{verb}</span><span className="w">{when}</span></div>
        <div className="clg-co-t" role="status">{title}</div>
        <div className="clg-co-b">{body}</div>
        {coFoot(foot, go, onGo, onX)}
      </div>
      {coX(onX)}
    </div>
  );

  return (
    <>
      <button
        ref={btnRef}
        onClick={() => (open ? close() : openOn(null))}
        title={btnTitle}
        aria-label="Changelog, go live and update"
        aria-expanded={open}
        onMouseEnter={() => setHov(true)} onMouseLeave={() => setHov(false)}
        className={`relative flex h-[38px] items-center justify-center border-l-2 border-transparent hover:bg-accent${out ? " clg-lit" : ""}`}
        style={{ appearance: "none", cursor: "pointer", color: live?.error ? "var(--err)" : open || hov || out || waiting ? "var(--acc)" : "var(--muted-2)" }}
      >
        {going ? <RefreshCw size={18} strokeWidth={1.8} aria-hidden className="gl-ic gl-spin" /> : (
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" className="gl-ic" aria-hidden>
            <path d="M12 3 21 12 12 21 3 12Z" /><path d="M12 9 15 12 12 15 9 12Z" fill="currentColor" stroke="none" />
          </svg>)}
        {badge}
        {pips.length > 1 && <span className="rl-pips">{pips.map((c) => <i key={c} style={{ background: c }} />)}</span>}
      </button>

      {!fresh && updFresh && out && createPortal(callout(
        <ArrowDownToLine size={13} strokeWidth={1.8} className="clg-ic" />, updFresh.verb, ago(updFresh.at, now.getTime() / 1000),
        updFresh.title, updFresh.body.split("\n").filter(Boolean).map((l) => l.split(" — ")[0]).join(" · "),
        `${Number(updFresh.meta.commits) || 0} commit${updFresh.meta.commits === 1 ? "" : "s"}`, "See what's coming",
        () => openOn("update"), () => setUpdFresh(null)), theme)}
      {!fresh && !updFresh && livePop && out && createPortal(callout(
        <RefreshCw size={13} strokeWidth={1.8} className="clg-ic" />, "NOT LIVE YET", "just now",
        `A change on disk needs a ${livePop.restart ? "restart" : "rebuild"}`, livePop.subject,
        `${livePop.fresh} new · ${livePop.total} not live`, "Go live", () => openOn("live"), () => setLivePop(null), "gl-co"), theme)}

      {/* What just landed, out of the icon: 8 s like the bell's news (the bar's
          animation is the clock, so a hover that pauses it holds the popup). */}
      {fresh && out && createPortal(
        <div key={fresh.id} className="clg-co" style={out} onClick={() => openOn(fresh.id)}>
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
            <div className="clg-co-t" role="status">{fresh.title}</div>
            <div className="clg-co-b">{fresh.body.split("\n").filter(Boolean).map((l) => l.split(" — ")[0]).join(" · ")}</div>
            {coFoot(`${fresh.meta.commits ?? 0} commit${fresh.meta.commits === 1 ? "" : "s"}`, "See what changed", () => openOn(fresh.id), () => setFresh(null))}
            <span className="bar" onAnimationEnd={(e) => { if (e.animationName === "clg-bar") setFresh(null); }} />
          </div>
          {coX(() => setFresh(null))}
        </div>,
        theme,
      )}

      {/* Portalled into the themed container, like UPDATE's, so position:fixed
          escapes the rail's animated ancestors; the bell's frame (.ntf-pop). */}
      {pop && createPortal(
        // hidden, not shut, under a picture open full size: the lightbox shares its z-index
        <div ref={popRef} className="ntf-pop clg-pop" role="dialog" aria-label={pinned.length ? "Updates and changelog" : "Changelog"} tabIndex={-1} style={{ position: "fixed", zIndex: 96, width: W, ...pop, visibility: zoom ? "hidden" : undefined }}>
          <div className="ntf-head">
            <span className="t">{pinned.length ? "UPDATES" : "CHANGELOG"}</span>
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
          {!rws.length && !pinned.length ? (
            <div className="ntf-list">
              <div className="ntf-empty">
                <div className="o">no updates yet — i am as you first summoned me.</div>
                <div className="s">the next PULL &amp; RESTART lists what changed here</div>
              </div>
            </div>
          ) : (
            <div className="clg-split" onPointerEnter={() => setPlaying(false)}>
              <div className="clg-list mscroll" ref={listRef}>
                {pinned.length > 0 && <div className="rl-sec">WAITING ON YOU</div>}
                {pinned.map(sysItem)}
                {pinned.length > 0 && list.length > 0 && <div className="rl-sec rule">WHAT CHANGED</div>}
                {list.map(item)}
                {!list.length && <div className="clg-none">Nothing about “{qq.trim()}” in the last {all.length} changes.</div>}
              </div>
              {sys ? sysReader(sys) : cur ? reader(cur) : <div className="clg-read" />}
            </div>
          )}
          {keys.length > 1 && (sys || cur) && (
            <div className="ntf-foot">
              <span className="clg-pos">↑ ↓
                <button title="Newer" aria-label="Newer" disabled={busy || keys.indexOf(sys ?? cur?.id ?? "") <= 0} onClick={() => stepRef.current(-1)}><ChevronLeft size={13} strokeWidth={2} /></button>
                <span><b>{keys.indexOf(sys ?? cur?.id ?? "") + 1}</b> of {keys.length}</span>
                <button title="Older" aria-label="Older" disabled={busy || keys.indexOf(sys ?? cur?.id ?? "") >= keys.length - 1} onClick={() => stepRef.current(1)}><ChevronRight size={13} strokeWidth={2} /></button>
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
