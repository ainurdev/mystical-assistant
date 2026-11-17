import { useEffect, useState, type ReactNode } from "react";
import { CornerUpLeft, Download, Eye, File as FileIcon, Forward, Image as ImageIcon, Layers, MessageSquare, RefreshCw, Users, X } from "lucide-react";
import type { Received, Receiving, RivendellTask, TeamOverview, Teammate } from "../../api";
import { api } from "../../api";
import { initials, splitTitle } from "../../lib/rivendelltasks";
import { hhmm, useClock12 } from "../../lib/surfaces";
import { byDay, teamFeed, type FeedItem } from "../../lib/teamfeed";
import { KIND_LABEL, byPresence, onWhat, personTint, presence, relationLine, sentBefore, shareFacts } from "../../lib/team";
import { ImageLightbox } from "../ImageLightbox";
import { Bar } from "./MoveDock";

const UI = "var(--ui-font, inherit)";
const MONO = "var(--mono)";
const mix = (c: string, pct: number) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;
const KIND_ICON = { session: MessageSquare, picture: ImageIcon, file: FileIcon } as const;
const EARLIER_ROWS = 6;    // EARLIER shows this many, the rest behind "N more"

/** A teammate's picture from Rivendell (their photo or a Middle-earth one), else
 *  their initials in their colour, with a presence dot when it is known. A
 *  picture that fails to load falls back to the initials. */
export function Avatar({ id, name, src, size = 26, state }: { id: string; name: string; src?: string | null; size?: number; state?: "on" | "away" }) {
  const c = personTint(id);
  const dot = size >= 24 ? 9 : 7;
  const [broken, setBroken] = useState<string | null>(null);
  const pic = src && src !== broken ? src : null;
  return (
    <span aria-hidden style={{
      position: "relative", flex: "none", width: size, height: size, borderRadius: "50%", display: "grid", placeItems: "center",
      boxSizing: "border-box", background: `color-mix(in srgb, ${c} 15%, var(--panel2))`, border: `1px solid ${mix(c, 36)}`,
      color: c, fontFamily: UI, fontSize: size >= 26 ? "var(--t95)" : size >= 20 ? "var(--t8)" : "var(--t7)", fontWeight: 600,
      opacity: state === "away" ? 0.75 : 1,
    }}>
      {pic ? <img src={pic} alt="" onError={() => setBroken(pic)} style={{
        position: "absolute", inset: 0, width: "100%", height: "100%", borderRadius: "50%", objectFit: "cover",
      }} /> : initials(name)}
      {state && <i style={{
        position: "absolute", right: -2, bottom: -2, width: dot, height: dot, borderRadius: "50%", boxSizing: "border-box",
        boxShadow: "0 0 0 2px var(--panel)",
        ...(state === "on" ? { background: "var(--ok)" } : { background: "var(--panel)", border: "1.5px solid var(--txl)" }),
      }} />}
    </span>
  );
}

const btnStyle = (pri?: boolean) => ({
  appearance: "none", cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 6, height: 26, padding: "0 10px",
  boxSizing: "border-box", borderRadius: 7, border: `1px solid ${pri ? "var(--acc)" : "transparent"}`, ...(pri ? {} : { padding: "0 6px 0 0" }),
  background: "transparent", color: pri ? "var(--acc)" : "var(--txm)", fontFamily: UI,
  fontSize: "var(--t95)", fontWeight: 600, letterSpacing: ".06em", whiteSpace: "nowrap", textDecoration: "none",
}) as const;

function Btn({ icon, label, pri, onClick, title }: { icon: ReactNode; label: string; pri?: boolean; onClick: () => void; title?: string }) {
  return <button type="button" onClick={onClick} title={title} style={btnStyle(pri)}>{icon}{label}</button>;
}

/** A small tag beside a card's kind: SENT BACK, UPDATE · V2. Coloured text, no fill (flat, as TASKS). */
export const Pill = ({ children, c }: { children: ReactNode; c: string }) => (
  <span style={{
    flex: "none", display: "inline-flex", alignItems: "center", gap: 4, whiteSpace: "nowrap",
    color: c, fontFamily: MONO, fontSize: "var(--t8)", letterSpacing: 1,
  }}>{children}</span>
);

/** A day in the STREAM: its name in small caps, a hairline to the edge. */
const Day = ({ label }: { label: string }) => (
  <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "12px 12px 4px", fontSize: "var(--t9)", letterSpacing: 2, color: "var(--txl)", textTransform: "uppercase" }}>
    {label}<span style={{ flex: 1, height: 1, background: mix("var(--line)", 60) }} />
  </div>
);

/** The TEAM tab (bridge/team.py), C · STREAM: who's here as faces you tap to send
 *  the session you have open (the task they're on under each: WHO'S ON WHAT, read
 *  off this repo's Rivendell tasks, or every project's when no project links it),
 *  then one timeline split by day: shares still coming in, what they sent you (a
 *  card while it waits for you), how far your own sends got, what you opened or
 *  continued. Flat, as TASKS since rivendell-tab-v3: no fills, a share to you is
 *  the one left rule. App owns the team data (it polls, and the rail badge and
 *  the session menu read it too); the task list is read here, once a minute while
 *  showing. `sessionTitle` is null when the open session isn't yours to send.
 *  Design: .mystical/design-drafts/team-flat (C · STREAM). */
export function TeamPanel({ data, fail, project, sessionTitle, onRefresh, onSendTo, onOpen, onContinue, onNewSession, onContinueYours, onDismiss, step }: {
  data: TeamOverview | null;
  fail: string | null;
  project: string | null;
  sessionTitle: string | null;
  onRefresh: () => void;
  onSendTo: (t: Teammate) => void;
  onOpen: (r: Received) => void;
  onContinue: (r: Received) => void;         // CONTINUE HERE: a session, as yours with its history; else into a new one
  onNewSession: (r: Received) => void;       // NEW SESSION FROM IT: a new session, their work attached, the prompt drafted
  onContinueYours: (r: Received) => void;     // a newer state of a thread you have: into your session in it
  onDismiss: (r: Received) => void;
  step?: { id: string; text: string } | null;    // CLONE & INSTALL's progress, on the share it is for
}) {
  const h12 = useClock12();
  const now = Date.now() / 1000;
  const [hov, setHov] = useState<string | null>(null);   // the EARLIER line the pointer or focus is on
  const [zoom, setZoom] = useState<string | null>(null);
  const [allSeen, setAllSeen] = useState(false);
  const roster = [...(data?.roster ?? [])].sort(byPresence);
  const faceOf = (id: string) => roster.find((t) => t.id === id)?.avatarUrl;
  const feed = data ? teamFeed(data, now) : { today: [], earlier: [] };
  const [tasks, setTasks] = useState<RivendellTask[]>([]);
  useEffect(() => {
    if (!project) return;
    let alive = true;
    const read = () => api.rivendellTasks(project).then((r) => { if (alive) setTasks(r.tasks); }).catch(() => {});
    read();
    const t = setInterval(read, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, [project]);

  const card = (r: Received) => {
    const f = shareFacts(r.kind, r.meta);
    const c = personTint(r.from.id || r.from.name);
    const thread = typeof r.meta.thread === "string" ? r.meta.thread : undefined;
    const rel = relationLine(r, now, r.relation === "back" ? sentBefore(data?.outbox ?? [], thread, r.from.id)?.last : null, h12);
    return (
      <div key={r.id} style={{
        margin: "2px 12px 10px", padding: "4px 0 6px 10px", borderLeft: "2px solid var(--acc)",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <Avatar id={r.from.id || r.from.name} name={r.from.name} src={faceOf(r.from.id)} size={22} />
          <span style={{ minWidth: 0, fontFamily: UI, fontSize: "var(--t115)", color: "var(--txm)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            <b style={{ color: "var(--txh)", fontWeight: 600 }}>{r.from.name}</b> sent you{r.at ? ` · ${stamp(r.at)}` : ""}
          </span>
          <span style={{ flex: 1 }} />
          <button type="button" title="Dismiss — it leaves your list; nothing ran" onClick={() => onDismiss(r)} style={{
            appearance: "none", cursor: "pointer", display: "grid", placeItems: "center", width: 22, height: 22, flex: "none", border: 0, borderRadius: 6,
            background: "transparent", color: "var(--txl)", padding: 0,
          }}><X size={11} strokeWidth={2} /></button>
        </div>
        <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", alignItems: "baseline", gap: 7, minWidth: 0 }}>
          <span style={{ flex: "none", fontFamily: MONO, fontSize: "var(--t8)", letterSpacing: 1, color: "var(--acc)" }}>{KIND_LABEL[r.kind]}</span>
          {r.relation === "back" && <Pill c="var(--purple)"><CornerUpLeft size={9} strokeWidth={2} />SENT BACK</Pill>}
          {r.relation === "update" && <Pill c="var(--acc)"><Layers size={9} strokeWidth={2} />UPDATE{(r.version ?? 1) > 1 ? ` · V${r.version}` : ""}</Pill>}
          <span style={{ minWidth: 0, fontFamily: UI, fontSize: "var(--t12)", fontWeight: 600, color: "var(--txh)", lineHeight: 1.3, overflowWrap: "anywhere" }}>{r.title}</span>
        </div>
        {r.kind === "picture" && r.url && (
          <button type="button" onClick={() => { setZoom(r.url); onOpen(r); }} title="Open the picture" style={{ appearance: "none", border: 0, padding: 0, marginTop: 8, background: "transparent", cursor: "zoom-in", display: "block" }}>
            <img src={r.url} alt={r.title} style={{ display: "block", maxWidth: "100%", maxHeight: 140, borderRadius: 7, border: "1px solid var(--line2)", objectFit: "cover" }} />
          </button>
        )}
        {r.note && (
          <div style={{ marginTop: 7, padding: "1px 0 1px 9px", borderLeft: `2px solid ${mix(c, 45)}`, fontFamily: UI, fontSize: "var(--t11)", lineHeight: 1.45, color: "var(--txm)", overflowWrap: "anywhere" }}>{r.note}</div>
        )}
        <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", alignItems: "center", gap: "4px 10px", fontFamily: MONO, fontSize: "var(--t9)", color: "var(--txl)" }}>
          {f.project && <span style={{ color: "var(--info)", fontFamily: UI }}>{f.project}</span>}
          {f.branch && <span>⎇ {f.branch}</span>}
          {r.kind !== "session" && r.file && r.file !== r.title && <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{r.file}</span>}
          {f.bits.map((b) => <span key={b}>{b}</span>)}
        </div>
        {rel && (
          <div style={{ marginTop: 7, display: "flex", gap: 7, alignItems: "flex-start", fontFamily: UI, fontSize: "var(--t105)", lineHeight: 1.45, color: "var(--txm)" }}>
            <span style={{ flex: "none", marginTop: 2, color: "var(--purple)", display: "flex" }}>
              {r.relation === "back" ? <CornerUpLeft size={11} strokeWidth={2} /> : <Layers size={11} strokeWidth={2} />}
            </span>
            <span><b style={{ color: "var(--txh)", fontWeight: 600 }}>{rel.strong}</b>{rel.rest}</span>
          </div>
        )}
        <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
          {r.kind === "session" && r.session && <Btn icon={<Eye size={11} strokeWidth={2} />} label="OPEN" onClick={() => onOpen(r)} />}
          {r.kind === "picture" && r.url && <Btn icon={<ImageIcon size={11} strokeWidth={2} />} label="OPEN" onClick={() => { setZoom(r.url); onOpen(r); }} />}
          {r.kind === "file" && r.url && (
            <a href={r.url} download={r.file || undefined} onClick={() => onOpen(r)} style={btnStyle()}>
              <Download size={11} strokeWidth={2} />DOWNLOAD
            </a>
          )}
          <Btn icon={<Forward size={11} strokeWidth={2} />} label={!r.yours && step?.id === r.id ? step.text : "CONTINUE HERE"} pri={!r.yours}
            onClick={() => onContinue(r)}
            title={r.kind === "session" ? "Their session as yours: its history stays and you type the next prompt"
              : "A new session of yours with it attached, the prompt left for you to send"} />
          {r.yours && (
            <Btn icon={<CornerUpLeft size={11} strokeWidth={2} />} label={step?.id === r.id ? step.text : "CONTINUE IN YOURS"} pri onClick={() => onContinueYours(r)}
              title={`Your session “${r.yours.title}”: what's new attached, the prompt left for you to send`} />
          )}
        </div>
        {r.kind === "session" && (
          <button type="button" onClick={() => onNewSession(r)} style={{
            appearance: "none", border: 0, background: "transparent", padding: "6px 0 0", cursor: "pointer", fontFamily: UI, fontSize: "var(--t105)",
            color: "var(--txl)", textDecoration: "underline", textDecorationColor: mix("var(--txl)", 40), textUnderlineOffset: 3,
          }}>or start a new session from it</button>
        )}
      </div>
    );
  };

  /** A SEEN row opens what it was again: the session read only, the picture large, the file downloaded. */
  const reopen = (r: Received) => {
    if (r.kind === "picture" && r.url) setZoom(r.url);
    if (r.kind === "file" && r.url) Object.assign(document.createElement("a"), { href: r.url, download: r.file || "" }).click();
    onOpen(r);
  };

  const stamp = (at: number) => !at ? "" : new Date(at * 1000).toDateString() === new Date(now * 1000).toDateString()
    ? hhmm(at, h12) : new Date(at * 1000).toLocaleDateString([], { month: "short", day: "numeric" });

  // One line per event; the verb or title is the line's own words, `who` leads in bold. A line
  // from the inbox (opened or continued) keeps its old actions: click reopens, hover offers
  // CONTINUE HERE and remove (your copy goes).
  const line = (it: Extract<FeedItem, { kind: "line" }>) => {
    const r = it.r, key = it.id;
    const busy = r && step?.id === r.id ? step.text : null;
    const rest = it.text.startsWith(it.who) ? it.text.slice(it.who.length) : it.text;
    const text = <><b>{it.who}</b>{rest}</>;
    const col = it.tone === "ok" ? "var(--ok)" : it.tone === "warn" ? "var(--warn)" : it.tone === "err" ? "var(--err)" : "var(--txl)";
    return (
      <div key={key} className="tf-line" data-act={r ? "" : undefined} title={`${it.text}${it.tip ? ` · ${it.tip}` : ""} · ${stamp(it.at)}`}
        onClick={r ? () => reopen(r) : undefined} onMouseEnter={() => setHov(key)} onMouseLeave={() => setHov(null)}
        onFocus={() => setHov(key)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHov(null); }}>
        <span className="tf-tm">{hhmm(it.at, h12)}</span>
        {r ? <button type="button" className="tf-tx tf-btn">{text}</button> : <span className="tf-tx">{text}</span>}
        {r && hov === key && !busy ? (
          <span className="tf-r" style={{ display: "flex", gap: 2 }}>
            {r.yours
              ? <RowBtn label={`Continue in yours: “${r.yours.title}”`} color="var(--acc)" onClick={() => onContinueYours(r)}><CornerUpLeft size={12} strokeWidth={2} /></RowBtn>
              : <RowBtn label="Continue here" color="var(--acc)" onClick={() => onContinue(r)}><Forward size={12} strokeWidth={2} /></RowBtn>}
            <RowBtn label="Remove: your copy goes" color="var(--txl)" onClick={() => onDismiss(r)}><X size={12} strokeWidth={2} /></RowBtn>
          </span>
        ) : (
          <span className="tf-r" style={{ color: it.status ? col : "var(--txl)" }}>{busy ?? it.status ?? ""}</span>
        )}
      </div>
    );
  };
  const feedRow = (it: FeedItem) => it.kind === "share" ? card(it.r) : line(it);

  /** A share still arriving (bridge/team.py receiving): its bytes, then its turns filed. The tab
   *  looks again each second while one is here (App), so the bar moves as it comes. */
  const incoming = (r: Receiving) => (
    <div key={r.id} title={`${r.title} · from ${r.from}`} style={{ margin: "2px 12px 10px", padding: "2px 0 2px 10px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span style={{ flex: "none", color: "var(--purple)", display: "flex" }}><Download size={11} strokeWidth={2} /></span>
        <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontFamily: UI, fontSize: "var(--t115)", color: "var(--txh)" }}>{r.title}</span>
        <span style={{ flex: "none", fontFamily: MONO, fontSize: "var(--t8)", letterSpacing: 0.8, color: "var(--txm)" }}>
          {r.stage === "filing" ? "FILING" : "COMING IN"} {r.pct}%
        </span>
      </div>
      <div style={{ marginTop: 8, display: "flex" }}>
        <Bar style="sweep" pct={r.pct} color="var(--purple)" h={2} />
      </div>
      <div style={{ marginTop: 6, fontFamily: UI, fontSize: "var(--t105)", color: "var(--txl)" }}>
        from {r.from}{r.stage === "filing" ? " · writing its turns" : ""}
      </div>
    </div>
  );

  /** A teammate as a face to tap: it sends them the open session (the send sheet).
   *  Under it, the task they're on, else when they were on. */
  const face = (t: Teammate) => {
    const w = onWhat(t, tasks);
    const st = w.task?.implementation?.status;
    const busy = st === "IN_PROGRESS" || st === "PENDING";
    const name = t.name.trim().split(/\s+/)[0] || t.name;
    const send = sessionTitle ? `Send “${sessionTitle}” to ${name}` : "Open a session of yours to send it";
    const at = t.lastSeenAt ? Date.parse(t.lastSeenAt) / 1000 : NaN;
    const sub = w.task ? `${w.task.key || splitTitle(w.task.name).title}${busy ? ` · ${st === "PENDING" ? "queued" : "running"}` : ""}`
      : Number.isNaN(at) ? "not linked" : `${t.online ? "on" : "off"} · ${stamp(at)}`;
    return (
      <button key={t.id} type="button" className="tf-face" disabled={!sessionTitle} onClick={() => onSendTo(t)} aria-label={send}
        title={`${send}\n${t.name} · ${presence(t, now, h12)}${w.task ? `\n${w.task.key ? `${w.task.key} ` : ""}${splitTitle(w.task.name).title}${w.n > 1 ? ` (+${w.n - 1} more)` : ""}` : ""}${t.device ? `\nshares ${t.device.name} (Mac)` : ""}`}
        data-away={t.online ? undefined : ""}>
        <Avatar id={t.id} name={t.name} src={t.avatarUrl} size={38} state={t.online ? "on" : "away"} />
        <b>{name}</b>
        <small style={{ color: busy ? "var(--acc)" : undefined }}>{sub}</small>
      </button>
    );
  };

  const body = (): ReactNode => {
    // A dashboard newer than the running bridge: the route is missing.
    if (fail === "not found") return <Empty title="The bridge needs a restart" text="This dashboard is newer than the running bridge, which can't show the team yet." />;
    if (fail) return <Empty title="Couldn't read the team" text={fail} />;
    if (!data) return [100, 100, 60].map((w, i) => <div key={i} style={{ height: 30, margin: "8px 12px", width: `calc(${w}% - 24px)`, background: mix("var(--acc)", 7) }} />);
    const shown = [...feed.today, ...(allSeen ? feed.earlier : feed.earlier.slice(0, EARLIER_ROWS))];
    const days = byDay(shown, now);
    const coming = data.receiving ?? [];
    if (coming.length && days[0]?.label !== "Today") days.unshift({ label: "Today", items: [] });
    return (
      <>
        {!data.error && roster.length > 0 && <div className="tf-faces">{roster.map(face)}</div>}
        {data.error && <Empty title="No roster right now" text={data.error} />}
        {!data.error && !roster.length && !days.length && <Empty title="No teammates yet" text="Everyone on your Rivendell shows here once they're added to it." />}
        {days.map((d, i) => (
          <div key={d.label}>
            <Day label={d.label} />
            {i === 0 && d.label === "Today" && coming.map(incoming)}
            {d.items.map(feedRow)}
          </div>
        ))}
        {feed.earlier.length > EARLIER_ROWS && (
          <button type="button" onClick={() => setAllSeen((v) => !v)} className="tf-fold">{allSeen ? "show less ↑" : `${feed.earlier.length - EARLIER_ROWS} more ↓`}</button>
        )}
      </>
    );
  };

  return (
    <div className="gp tf" style={{ display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div className="tf-to">
        <span>{sessionTitle ? <>Tap a face to send <b>{sessionTitle}</b></> : "Open a session of yours to send it"}</span>
        <button className="gp-ib" title="refresh" aria-label="refresh" onClick={onRefresh}><RefreshCw size={13} /></button>
      </div>
      <div className="mscroll" style={{ flex: 1, minHeight: 0, padding: "4px 0 10px" }}>{body()}</div>
      {zoom && <ImageLightbox src={zoom} onClose={() => setZoom(null)} />}
    </div>
  );
}

function RowBtn({ label, color, onClick, children }: { label: string; color: string; onClick: () => void; children: ReactNode }) {
  return (
    <button type="button" title={label} aria-label={label} onClick={(e) => { e.stopPropagation(); onClick(); }} style={{
      appearance: "none", cursor: "pointer", display: "grid", placeItems: "center", width: 22, height: 22, flex: "none", border: 0, borderRadius: 6,
      background: "transparent", color, padding: 0,
    }}>{children}</button>
  );
}

function Empty({ title, text }: { title: string; text: ReactNode }) {
  return (
    <div style={{ padding: "22px 16px", display: "flex", flexDirection: "column", alignItems: "center", gap: 10, textAlign: "center" }}>
      <span style={{ color: "var(--txg)" }}><Users size={24} strokeWidth={1.3} /></span>
      <div style={{ fontSize: "var(--t115)", color: "var(--txh)" }}>{title}</div>
      <div style={{ fontSize: "var(--t10)", lineHeight: 1.55, color: "var(--txl)", maxWidth: 240 }}>{text}</div>
    </div>
  );
}
