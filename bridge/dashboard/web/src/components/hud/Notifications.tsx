import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { Castle, GitPullRequest, Moon, Truck, CalendarDays } from "lucide-react";
import { api, type Need, type Notice, type NoticePrefs, type PendingCard, type RivendellInstance } from "../../api";
import { chime, push, pushGranted, type ToneKey } from "../../lib/push";
import { bannerActions, bannerAnswer } from "../../lib/banner";
import { openSettings } from "../../lib/opensettings";
import {
  ago, badge, freshSince, groupBySubject, isQuiet, matches, needMatches, popFor, sectionOf,
  type Filter, type Row,
} from "../../lib/notices";
import { ProjectTile } from "../ui/ProjectTile";

/* The bell, its toasts and the pills (docs/superpowers/specs/notifications.md).
 *
 * Two channels that used to be one: `notify()` is feedback for what you just
 * did — a pill at the bottom, three seconds, kept nowhere — and the bell is the
 * bridge's feed of what happened while you looked away (bridge/notices.py), read
 * every 4 s. What waits on you is not a feed row but live state, handed in by
 * App from /local/running (`setNeeds`).
 *
 * ponytail: module-level stores (pills, needs, links, the env App installs) —
 * written from async handlers all over the app, read here, no provider needed. */

// ---- pills ------------------------------------------------------------------

export type NoticeKind = "error" | "info";
interface Pill { id: number; kind: NoticeKind; text: string; onClick?: () => void }

let pills: Pill[] = [];
let nextPill = 1;
const pillSubs = new Set<() => void>();
const emitPills = () => { for (const fn of pillSubs) fn(); };

// The pill is written from async handlers all over the app, so it can't read
// settings through a hook. App installs one callback here instead of every
// notify() site learning what a sound is.
let onNotice: ((kind: NoticeKind) => void) | null = null;
export function setNoticeSound(fn: ((kind: NoticeKind) => void) | null) { onNotice = fn; }

/** Feedback for something you just did: a pill, bottom centre, one at a time.
 *  Never stored — you already know it happened. `onClick` makes it a "Show". */
export function notify(kind: NoticeKind, text: string, onClick?: () => void): number {
  const id = nextPill++;
  pills = [...pills.slice(-4), { id, kind, text: text || "unknown error", onClick }];
  emitPills();
  onNotice?.(kind);
  return id;
}
const dropPill = (id: number) => { pills = pills.filter((p) => p.id !== id); emitPills(); };

export function PillHost() {
  const list = useSyncExternalStore((fn) => { pillSubs.add(fn); return () => { pillSubs.delete(fn); }; }, () => pills);
  const p = list[list.length - 1];
  useEffect(() => {
    if (!p) return;
    const t = window.setTimeout(() => dropPill(p.id), p.kind === "error" ? 6000 : 3000);
    return () => window.clearTimeout(t);
  }, [p]);
  if (!p) return null;
  return (
    <div className="ntf-pillhost" role="status" aria-live="polite">
      <div key={p.id} className={`ntf-pill${p.kind === "error" ? " err" : ""}`}>
        <span className="ntf-pill-k">{p.kind === "error" ? "✕" : "✓"}</span>
        <span className="ntf-pill-t">{p.text}</span>
        {p.onClick && <button className="ntf-pill-a" onClick={() => { dropPill(p.id); p.onClick?.(); }}>Show</button>}
        <button className="ntf-pill-x" title="dismiss" onClick={() => dropPill(p.id)}>×</button>
      </div>
    </div>
  );
}

// ---- what App hands in --------------------------------------------------------

interface Env {
  openSession: (sid: string) => void;
  openSessionId: string | null;
  branchOf: (sid: string) => string | undefined;
  push: boolean;       // OS banners on (this browser)
  pushSound: boolean;  // sounds on (this browser)
  pushVolume: number;
}
let env: Env = { openSession: () => {}, openSessionId: null, branchOf: () => undefined, push: false, pushSound: false, pushVolume: 0.6 };
export function setNoticeEnv(e: Env) { env = e; }

let needs: Need[] = [];
let links: RivendellInstance[] = [];
const subs = new Set<() => void>();
const emit = () => { for (const fn of subs) fn(); };
/** /local/running's NEEDS YOU list, every poll. Undefined (an older bridge) keeps none. */
export function setNeeds(n: Need[] | undefined) { needs = n ?? []; emit(); }
/** The Rivendell connections, for the RIVENDELL filter's link bar. */
export function setLinks(l: RivendellInstance[]) { links = l; emit(); }
const subscribe = (fn: () => void) => { subs.add(fn); return () => { subs.delete(fn); }; };

// ---- copy and colour ------------------------------------------------------------

const TONE: Record<string, "ok" | "err" | "ask" | "warn" | "acc" | "dim"> = {
  done: "ok", rv_done: "ok", move_done: "ok", resumed: "ok", rv_link_back: "dim",
  failed: "err", rv_failed: "err", rv_refused: "err", rv_link: "err", pr_failing: "err", move_failed: "err",
  approve: "ask", question: "ask", asking: "ask", login: "ask", limit_choice: "ask", rv_offer: "ask",
  parked: "warn", pr_changes: "warn", started: "acc", rv_started: "acc",
  rv_held: "dim", rv_dismissed: "dim", weekly: "dim",
};
const GLYPH: Record<string, ReactNode> = { ok: "✓", err: "✕", ask: "?", warn: <b className="ntf-pz" />, acc: "▸", dim: null };
const toneOf = (kind: string) => TONE[kind] ?? "dim";
const str = (v: unknown) => (typeof v === "string" ? v : "");
const projName = (p: string) => p.split("/").filter(Boolean).pop() ?? p;
const mins = (s: number) => (s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`);

function Source({ kind, source, project }: { kind: string; source: string; project?: string }) {
  const t = toneOf(kind);
  const icon = source === "rivendell" ? <Castle size={13} strokeWidth={1.8} />
    : source === "pr" ? <GitPullRequest size={13} strokeWidth={1.8} />
    : kind === "weekly" ? <CalendarDays size={13} strokeWidth={1.8} />
    : source === "bridge" ? <Truck size={13} strokeWidth={1.8} /> : null;
  return (
    <span className={`ntf-src s-${source}`}>
      {icon ?? <ProjectTile project={project ?? null} />}
      {GLYPH[t] && <i className={`ntf-k k-${t}`}>{GLYPH[t]}</i>}
    </span>
  );
}

// ---- acting on a row ---------------------------------------------------------------

function openRow(n: { kind: string; subject: string; source: string; meta: Record<string, unknown>; session_id?: string | null }) {
  const sid = n.session_id ?? str(n.meta.session_id) ?? "";
  if (n.source === "session" || sid) return env.openSession(sid || n.subject);
  if (n.source === "pr" && str(n.meta.url)) return void window.open(str(n.meta.url), "_blank", "noopener");
  if (n.source === "rivendell") return openSettings("plugins", str(n.meta.instance_id) || undefined);
  if (n.kind.startsWith("move_")) return openSettings("move");
}

const answerRivendell = (meta: Record<string, unknown>, accept: boolean) => {
  const iid = str(meta.instance_id), key = str(meta.key);
  void (accept ? api.acceptRivendell(iid, key) : api.rejectRivendell(iid, key))
    .then((r) => { if (!r.ok) notify("info", "Already decided — it's no longer waiting."); })
    .catch((e: Error) => notify("error", e.message));
};

/** A card's own buttons (Allow / Deny, or a one-question ask's options), read
 *  from the run the moment the row shows — the same answers a Mac banner sends. */
function useCard(jobId: string) {
  const [card, setCard] = useState<PendingCard | undefined>();
  useEffect(() => {
    if (!jobId) return;
    let live = true;
    api.job(jobId).then((s) => { if (live) setCard(s.pending?.[0]); }).catch(() => { /* Open still works */ });
    return () => { live = false; };
  }, [jobId]);
  return card;
}

function NeedActions({ n, done }: { n: Need; done: () => void }) {
  const jobId = str(n.meta.job_id);
  const card = useCard(n.kind === "approve" || n.kind === "question" ? jobId : "");
  const answer = (action: string) => {
    const b = bannerAnswer(card, action);
    if (b) void api.respond(jobId, b).then(done, (e: Error) => notify("error", e.message));
  };
  if (n.kind === "rv_offer") {
    return (
      <div className="ntf-acts">
        <button className="ntf-btn ask" onClick={() => { answerRivendell(n.meta, true); done(); }}>Accept</button>
        <button className="ntf-btn" onClick={() => { answerRivendell(n.meta, false); done(); }}>Dismiss</button>
        {str(n.meta.link) && <button className="ntf-btn ghost" onClick={() => window.open(str(n.meta.link), "_blank", "noopener")}>Peek ›</button>}
      </div>
    );
  }
  const buttons = bannerActions(card);
  return (
    <div className="ntf-acts">
      {buttons.map((b, i) => (
        <button key={b.action} className={`ntf-btn${i === 0 ? " ask" : b.action === "deny" ? " no" : ""}`} onClick={() => answer(b.action)}>{b.title}</button>
      ))}
      {n.kind === "login" && <button className="ntf-btn ask" onClick={() => openSettings("aimgmt", str(n.meta.slot) || undefined)}>Sign in ›</button>}
      <button className="ntf-btn ghost" onClick={() => openRow({ ...n, source: "session" })}>Open ›</button>
    </div>
  );
}

function RowActions({ n }: { n: Row }) {
  const m = n.meta;
  const b: ReactNode[] = [];
  if (n.kind === "rv_held") {
    b.push(<button key="go" className="ntf-btn" onClick={() => answerRivendell(m, true)}>Run it too</button>,
      <button key="no" className="ntf-btn ghost" onClick={() => answerRivendell(m, false)}>Dismiss</button>);
  }
  if (str(m.pr_url) || (n.source === "pr" && str(m.url))) {
    b.push(<button key="pr" className="ntf-btn" onClick={() => window.open(str(m.pr_url) || str(m.url), "_blank", "noopener")}>Open PR ↗</button>);
  }
  if (n.source === "rivendell" && str(m.session_id)) {
    b.push(<button key="s" className="ntf-btn ghost" onClick={() => env.openSession(str(m.session_id))}>Session ›</button>);
  } else if (n.kind === "rv_link" || n.kind === "rv_failed" || n.kind === "rv_refused") {
    b.push(<button key="d" className="ntf-btn ghost" onClick={() => openSettings("plugins", str(m.instance_id) || undefined)}>Details ›</button>);
  }
  if (n.kind === "failed") b.push(<button key="o" className="ntf-btn ghost" onClick={() => openRow(n)}>Open ›</button>);
  return b.length ? <div className="ntf-acts" onClick={(e) => e.stopPropagation()}>{b}</div> : null;
}

function metaLine(n: { source: string; subject: string; meta: Record<string, unknown> }): string[] {
  const m = n.meta;
  if (n.source === "rivendell") return ["rivendell", str(m.instance) || str(m.instance_id), str(m.job_kind)].filter(Boolean);
  if (n.source !== "session") return [];
  const sid = str(m.session_id) || n.subject;
  const br = env.branchOf(sid);
  return [projName(str(m.project)), br ? `⎇ ${br}` : "", typeof m.elapsed === "number" ? mins(m.elapsed) : ""].filter(Boolean);
}

function NoticeRow({ n, now, compact, onOpen }: { n: Row; now: number; compact: boolean; onOpen: () => void }) {
  const meta = metaLine(n);
  return (
    <div className={`ntf-row${compact ? " compact" : ""}${n.read ? "" : " unread"}`} onClick={onOpen}>
      <Source kind={n.kind} source={n.source} project={str(n.meta.project)} />
      <div className="ntf-mid">
        <div className="ntf-ttl"><span className={`ntf-verb ntf-v-${compact ? "dim" : toneOf(n.kind)}`}>{n.verb}</span><span className="ntf-s">{n.title}</span>
          {n.earlier > 0 && !compact && <span className="ntf-more">+{n.earlier}</span>}</div>
        {!compact && n.body && <div className="ntf-body">{n.body}</div>}
        {!compact && meta.length > 0 && <div className="ntf-meta">{meta.join(" · ")}</div>}
        {!compact && <RowActions n={n} />}
      </div>
      <span className="ntf-when">{ago(n.at, now)}</span>
    </div>
  );
}

function NeedRow({ n, now, done }: { n: Need; now: number; done: () => void }) {
  const meta = n.kind === "rv_offer"
    ? ["rivendell", str(n.meta.instance) || str(n.meta.instance_id), "offered by a teammate"]
    : n.session_id ? [projName(str(n.meta.project)), env.branchOf(n.session_id) ? `⎇ ${env.branchOf(n.session_id)}` : ""].filter(Boolean) : [];
  return (
    <div className="ntf-row needs">
      <Source kind={n.kind} source={n.kind === "rv_offer" ? "rivendell" : "session"} project={str(n.meta.project)} />
      <div className="ntf-mid">
        <div className="ntf-ttl"><span className="ntf-verb ntf-v-ask">{n.verb}</span><span className="ntf-s">{n.title || "session"}</span></div>
        {n.body && <div className={`ntf-body${n.kind === "approve" ? " mono" : ""}`}>{n.body}</div>}
        {meta.length > 0 && <div className="ntf-meta">{meta.join(" · ")}</div>}
        <NeedActions n={n} done={done} />
      </div>
      <span className="ntf-when">{n.at ? ago(n.at, now) : ""}</span>
    </div>
  );
}

// ---- the bell ------------------------------------------------------------------

const CURSOR_KEY = "hud-notice-cursor";
const NEWS_MS = 8000;
const NEEDS_MS = 30000;
interface Toast { n: Notice; until: number; left: number; paused: boolean }

const ICON = (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
    <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" />
  </svg>
);

/** Fire one OS banner for a feed row: the verb and the title, where it ran,
 *  what happened — and, in Mystical.app, the buttons that answer it. */
function osBanner(n: Notice) {
  const where = n.source === "rivendell" ? `Rivendell · ${str(n.meta.instance) || str(n.meta.instance_id)}`
    : [projName(str(n.meta.project)), env.branchOf(str(n.meta.session_id) || n.subject) ?? ""].filter(Boolean).join(" · ");
  const fire = (buttons?: { action: string; title: string }[], onAction?: (a: string) => void) =>
    push(`${n.verb[0]}${n.verb.slice(1).toLowerCase()} · ${n.title}`, n.body, n.subject, () => openRow(n),
      buttons, onAction, { subtitle: where, thread: n.subject });
  if (n.kind === "rv_offer") {
    return fire([{ action: "accept", title: "Accept" }, { action: "dismiss", title: "Dismiss" }],
      (a) => answerRivendell(n.meta, a === "accept"));
  }
  const jobId = str(n.meta.job_id);
  if ((n.kind === "approve" || n.kind === "question") && jobId) {
    return void api.job(jobId).then((s) => {
      const card = s.pending?.[0];
      const buttons = bannerActions(card);
      fire(buttons, buttons.length ? (a) => {
        const b = bannerAnswer(card, a);
        if (b) void api.respond(jobId, b).catch(() => { /* the card is still in the transcript */ });
      } : undefined);
    }).catch(() => fire());
  }
  fire();
}

export function NotificationCenter() {
  const liveNeeds = useSyncExternalStore(subscribe, () => needs);
  const liveLinks = useSyncExternalStore(subscribe, () => links);
  const [feed, setFeed] = useState<Notice[]>([]);
  const [prefs, setPrefs] = useState<NoticePrefs | null>(null);
  const [stale, setStale] = useState(false);
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<Filter>("all");
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [now, setNow] = useState(() => Date.now() / 1000);
  const wrapRef = useRef<HTMLSpanElement | null>(null);
  const shown = useRef<Set<number>>(new Set());

  const load = useRef(async () => {
    try {
      const r = await api.notices();
      setFeed(r.notices); setPrefs(r.prefs); setStale(false);
      const top = r.notices.reduce((a, n) => Math.max(a, n.id), 0);
      const raw = localStorage.getItem(CURSOR_KEY);
      // First look ever: the week's backlog is history, not news.
      const cursor = raw === null ? top : Number(raw) || 0;
      localStorage.setItem(CURSOR_KEY, String(Math.max(cursor, top)));
      if (raw === null) return;
      const quiet = isQuiet(r.prefs.quiet, new Date());
      const tones = new Set<ToneKey>();
      const fresh: Notice[] = [];
      for (const n of freshSince(r.notices, cursor)) {
        const d = popFor(n, { openSession: env.openSessionId, visible: document.visibilityState === "visible", prefs: r.prefs, quiet });
        if (!d) continue;
        if (d.sound) tones.add(d.sound);
        if (!d.pop) continue;
        // One place at a time: the toast while you're in this window, else the OS banner.
        if (!document.hasFocus() && env.push && pushGranted()) osBanner(n);
        else fresh.push(n);
      }
      // One sound per tone per batch: five sessions finishing together is one chime.
      if (env.pushSound) for (const t of tones) chime(t, env.pushVolume);
      if (fresh.length) {
        const t = Date.now();
        // Newest on top, but what waits on you above any news: three slots, and a
        // question must never be the one folded into "+n more".
        const rank = (x: Toast) => (x.n.tier === "needs" ? 0 : 1);
        setToasts((p) => [...fresh.reverse().map((n) => {
          const ms = n.tier === "needs" ? NEEDS_MS : NEWS_MS;
          return { n, until: t + ms, left: ms, paused: false };
        }), ...p].sort((a, b) => rank(a) - rank(b)));
      }
    } catch (e) {
      if (/404|not found/i.test((e as Error).message)) setStale(true);
    }
  });
  useEffect(() => {
    void load.current();
    const id = window.setInterval(() => void load.current(), 4000);
    return () => window.clearInterval(id);
  }, []);

  // Toast clock: expire, unless hovered (a hover freezes what's left).
  useEffect(() => {
    if (!toasts.length) return;
    const id = window.setInterval(() => {
      const t = Date.now();
      setNow(t / 1000);
      setToasts((p) => p.filter((x) => x.paused || x.until > t).map((x) => (x.paused ? x : { ...x, left: x.until - t })));
    }, 250);
    return () => window.clearInterval(id);
  }, [toasts.length]);
  useEffect(() => { if (open) setNow(Date.now() / 1000); }, [open, feed]);

  const rows = useMemo(() => groupBySubject(feed), [feed]);
  const unread = rows.filter((r) => !r.read).length;
  const quiet = prefs ? isQuiet(prefs.quiet, new Date(now * 1000)) : false;
  const b = badge(liveNeeds.length, unread, quiet);

  // Closing the bell marks what it showed read; click-outside closes it.
  const close = () => {
    setOpen(false);
    const ids = [...shown.current];
    shown.current = new Set();
    if (ids.length) void api.noticesRead(ids).then(() => load.current(), () => { /* next poll */ });
  };
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => { if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) close(); };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  const go = (n: Row) => { close(); openRow(n); };
  const markAll = () => { shown.current = new Set(); void api.noticesRead("all").then(() => load.current()); };

  const fNeeds = liveNeeds.filter((n) => needMatches(filter, n));
  const fRows = rows.filter((r) => matches(filter, r));
  const nowRows = filter === "rivendell" ? fRows.filter((r) => r.kind === "rv_started" || r.kind === "rv_held") : [];
  const rest = fRows.filter((r) => !nowRows.includes(r));
  const count = (f: Filter) => (f === "needs" ? liveNeeds.length
    : liveNeeds.filter((n) => needMatches(f, n)).length + rows.filter((r) => matches(f, r)).length);
  if (open) for (const r of fRows) if (!r.read) shown.current.add(r.id);

  const section = (label: string, list: Row[]) => list.length > 0 && (
    <>
      <div className="ntf-sec">{label}<span className="ln" /></div>
      {list.map((r) => <NoticeRow key={r.id} n={r} now={now} compact={r.read} onOpen={() => go(r)} />)}
    </>
  );
  const today = rest.filter((r) => sectionOf(r.at, new Date(now * 1000)) === "TODAY");
  const earlier = rest.filter((r) => sectionOf(r.at, new Date(now * 1000)) === "EARLIER");
  const nothing = !fNeeds.length && !fRows.length;
  const visibleToasts = open ? [] : toasts.slice(0, 3);
  const folded = open ? [] : toasts.slice(3);

  return (
    <span ref={wrapRef} style={{ position: "relative", flex: "none", display: "flex" }}>
      <button className={`ntf-bell${open ? " on" : ""}`} onClick={() => (open ? close() : setOpen(true))}
        title={b.kind === "count" ? `${b.n} waiting on you` : "notifications"} aria-label="notifications">
        {ICON}
        {b.kind === "count" && <span className="ntf-badge">{b.n > 9 ? "9+" : b.n}</span>}
        {b.kind === "dot" && <span className="ntf-dot" />}
        {b.kind === "moon" && <span className="ntf-moon"><Moon size={8} fill="currentColor" strokeWidth={0} /></span>}
      </button>

      {open && (
        <div className="ntf-pop">
          <div className="ntf-head">
            <span className="t">NOTIFICATIONS</span>
            {unread > 0 && <span className="n">{unread} new</span>}
            <span style={{ flex: 1 }} />
            {unread > 0 && <button className="ntf-lnk" onClick={markAll}>Mark all read</button>}
            <button className="ntf-lnk" title="Notify settings" onClick={() => { close(); openSettings("notifications"); }}>⚙</button>
          </div>
          <div className="ntf-filters">
            {(["all", "needs", "sessions", "rivendell", "prs"] as Filter[]).map((f) => (
              <button key={f} className={`ntf-flt${filter === f ? " on" : ""}`} onClick={() => setFilter(f)}>
                {f === "needs" && <i className="pip" />}
                {{ all: "All", needs: "Needs you", sessions: "Sessions", rivendell: "Rivendell", prs: "PRs" }[f]}
                {count(f) > 0 && <em>{count(f)}</em>}
              </button>
            ))}
          </div>
          {filter === "rivendell" && liveLinks.length > 0 && (
            <div className="ntf-links">
              {liveLinks.map((l) => {
                const st = l.status?.state ?? "off";
                return <span key={l.id} className={`l-${st}`}><i />{l.name} · {{ connected: "linked", connecting: "connecting", error: "down", auth_error: "token refused", off: "off" }[st]}</span>;
              })}
            </div>
          )}
          <div className="ntf-list mscroll">
            {stale && <div className="ntf-stale">This page is newer than the bridge. Restart it to see the feed.</div>}
            {fNeeds.length > 0 && (
              <>
                <div className="ntf-sec ask">NEEDS YOU<span className="ln" />{fNeeds.length}</div>
                {fNeeds.map((n) => <NeedRow key={n.subject} n={n} now={now} done={() => void load.current()} />)}
              </>
            )}
            {section("NOW", nowRows)}
            {section("TODAY", today)}
            {section("EARLIER", earlier)}
            {nothing && !stale && (
              <div className="ntf-empty">
                <div className="o">silence on every channel — i'll knock when something needs you.</div>
              </div>
            )}
          </div>
          <div className="ntf-foot">
            {prefs?.quiet.on ? <span className="q"><Moon size={11} strokeWidth={1.8} />Quiet {prefs.quiet.from} → {prefs.quiet.to}</span> : <span />}
            <span style={{ flex: 1 }} />
            <button className="ntf-lnk" onClick={() => { close(); openSettings("notifications"); }}>Notify settings ›</button>
          </div>
        </div>
      )}

      {(visibleToasts.length > 0 || folded.length > 0) && (
        <div className="ntf-toasts">
          {visibleToasts.map((t) => {
            const total = t.n.tier === "needs" ? NEEDS_MS : NEWS_MS;
            const row: Row = { ...t.n, earlier: 0 };
            const need: Need = { subject: t.n.subject, kind: t.n.kind, verb: t.n.verb, title: t.n.title, body: t.n.body, at: t.n.at, session_id: str(t.n.meta.session_id) || (t.n.source === "session" ? t.n.subject : null), meta: t.n.meta };
            const drop = () => setToasts((p) => p.filter((x) => x.n.id !== t.n.id));
            const hold = (paused: boolean) => setToasts((p) => p.map((x) => (x.n.id !== t.n.id ? x : paused
              ? { ...x, paused: true } : { ...x, paused: false, until: Date.now() + x.left })));
            return (
              <div key={t.n.id} className={`ntf-toast${t.n.tier === "needs" ? " needs" : ""}`}
                onMouseEnter={() => hold(true)} onMouseLeave={() => hold(false)}>
                {t.n.tier === "needs"
                  ? <NeedRow n={need} now={now} done={drop} />
                  : <NoticeRow n={row} now={now} compact={false} onOpen={() => { drop(); openRow(t.n); }} />}
                <button className="ntf-x" title="dismiss" onClick={drop}>×</button>
                <span className={`ntf-bar ntf-v-${toneOf(t.n.kind)}`} style={{ width: `${Math.max(0, Math.min(100, (t.left / total) * 100))}%` }} />
              </div>
            );
          })}
          {folded.length > 0 && (
            <button className="ntf-fold" onClick={() => { setToasts([]); setOpen(true); }}>
              <b>+{folded.length} more</b>
              <span style={{ flex: 1 }} />
              <span className="go">Open the bell ›</span>
            </button>
          )}
        </div>
      )}
    </span>
  );
}
