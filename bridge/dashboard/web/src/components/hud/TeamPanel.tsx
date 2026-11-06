import { useState, type ReactNode } from "react";
import { CornerUpLeft, Download, Eye, File as FileIcon, Forward, Image as ImageIcon, Layers, MessageSquare, RefreshCw, Send, Users, X } from "lucide-react";
import type { Received, Receiving, Share, TeamOverview, Teammate } from "../../api";
import { initials } from "../../lib/rivendelltasks";
import { hhmm, useClock12 } from "../../lib/surfaces";
import { room } from "../../lib/room";
import { teamFeed, type FeedItem } from "../../lib/teamfeed";
import { KIND_LABEL, byPresence, personTint, presence, relationLine, sentBefore, shareFacts } from "../../lib/team";
import { ImageLightbox } from "../ImageLightbox";
import { TabKick } from "./TabKick";
import { SendBar } from "./SendBar";
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
  boxSizing: "border-box", borderRadius: 7, border: `1px solid ${mix("var(--acc)", pri ? 52 : 22)}`,
  background: pri ? mix("var(--acc)", 15) : "transparent", color: pri ? "var(--txh)" : "var(--txm)", fontFamily: UI,
  fontSize: "var(--t95)", fontWeight: 600, letterSpacing: ".06em", whiteSpace: "nowrap", textDecoration: "none",
}) as const;

function Btn({ icon, label, pri, onClick, title }: { icon: ReactNode; label: string; pri?: boolean; onClick: () => void; title?: string }) {
  return <button type="button" onClick={onClick} title={title} style={btnStyle(pri)}>{icon}{label}</button>;
}

/** A small rounded tag beside a card's kind, or on a SEEN row: SENT BACK, UPDATE · V2, V3. */
export const Pill = ({ children, c }: { children: ReactNode; c: string }) => (
  <span style={{
    flex: "none", display: "inline-flex", alignItems: "center", gap: 4, padding: "1px 6px", borderRadius: 999, whiteSpace: "nowrap",
    border: `1px solid ${mix(c, 45)}`, background: mix(c, 10), color: c, fontFamily: MONO, fontSize: "var(--t8)", letterSpacing: 1,
  }}>{children}</span>
);

const Sect = ({ label, right, top = 12 }: { label: string; right?: ReactNode; top?: number }) => (
  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "var(--t9)", letterSpacing: 1.5, color: "var(--txl)", padding: `${top}px 12px 6px` }}>
    {label}<span style={{ letterSpacing: 0.5, fontFamily: MONO }}>{right}</span>
  </div>
);

/** The TEAM tab (bridge/team.py): what teammates sent you, who has Mystical on,
 *  who's away, how far your own sends got, and SEEN: what was sent to you that you
 *  opened or continued, one quiet line each until you remove it or it expires.
 *  App owns the data (it polls, and the rail badge and the session menu read it
 *  too). SEND on a teammate sends the session you have open: `sessionTitle` is
 *  null when it isn't yours to send. */
export function TeamPanel({ data, fail, sessionTitle, onRefresh, onSendTo, onOpen, onContinue, onNewSession, onContinueYours, onDismiss, step }: {
  data: TeamOverview | null;
  fail: string | null;
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
  const face = (id: string) => roster.find((t) => t.id === id)?.avatarUrl;
  const feed = data ? teamFeed(data, now) : { today: [], earlier: [] };

  const card = (r: Received) => {
    const f = shareFacts(r.kind, r.meta);
    const c = personTint(r.from.id || r.from.name);
    const thread = typeof r.meta.thread === "string" ? r.meta.thread : undefined;
    const rel = relationLine(r, now, r.relation === "back" ? sentBefore(data?.outbox ?? [], thread, r.from.id)?.last : null, h12);
    return (
      <div key={r.id} style={{
        margin: "0 12px 8px", padding: "11px", borderRadius: 13,
        border: `1px solid ${mix("var(--acc)", 38)}`, background: "color-mix(in srgb, var(--acc) 5%, var(--panel2))",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <Avatar id={r.from.id || r.from.name} name={r.from.name} src={face(r.from.id)} size={22} />
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

  const stamp = (at: number) => at && new Date(at * 1000).toDateString() === new Date(now * 1000).toDateString()
    ? hhmm(at, h12) : new Date(at * 1000).toLocaleDateString([], { month: "short", day: "numeric" });

  // One line per event; the verb or title is the line's own words, `who` leads in bold. A line
  // from the inbox (opened or continued) keeps its old actions: click reopens, hover offers
  // CONTINUE HERE and remove (your copy goes).
  const line = (it: Extract<FeedItem, { kind: "line" }>) => {
    const r = it.r, key = it.id;
    const Icon = it.icon === "send" ? Send : MessageSquare;
    const busy = r && step?.id === r.id ? step.text : null;
    const rest = it.text.startsWith(it.who) ? it.text.slice(it.who.length) : it.text;
    const text = <><b>{it.who}</b>{rest}</>;
    const col = it.tone === "ok" ? "var(--ok)" : it.tone === "warn" ? "var(--warn)" : it.tone === "err" ? "var(--err)" : "var(--txl)";
    return (
      <div key={key} className="tf-line" data-act={r ? "" : undefined} title={`${it.text}${it.tip ? ` · ${it.tip}` : ""} · ${stamp(it.at)}`}
        onClick={r ? () => reopen(r) : undefined} onMouseEnter={() => setHov(key)} onMouseLeave={() => setHov(null)}
        onFocus={() => setHov(key)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHov(null); }}>
        <span className="tf-ic"><Icon size={13} strokeWidth={2} /></span>
        {r ? <button type="button" className="tf-tx tf-btn">{text}</button> : <span className="tf-tx">{text}</span>}
        {r && hov === key && !busy ? (
          <span className="tf-r" style={{ display: "flex", gap: 2 }}>
            {r.yours
              ? <RowBtn label={`Continue in yours: “${r.yours.title}”`} color="var(--acc)" onClick={() => onContinueYours(r)}><CornerUpLeft size={12} strokeWidth={2} /></RowBtn>
              : <RowBtn label="Continue here" color="var(--acc)" onClick={() => onContinue(r)}><Forward size={12} strokeWidth={2} /></RowBtn>}
            <RowBtn label="Remove: your copy goes" color="var(--txl)" onClick={() => onDismiss(r)}><X size={12} strokeWidth={2} /></RowBtn>
          </span>
        ) : (
          <span className="tf-r" style={{ color: it.status ? col : "var(--txl)" }}>{busy ?? it.status ?? stamp(it.at)}</span>
        )}
      </div>
    );
  };
  const feedRow = (it: FeedItem) => it.kind === "share" ? card(it.r) : line(it);

  /** A share still arriving (bridge/team.py receiving): its bytes, then its turns filed. The tab
   *  looks again each second while one is here (App), so the bar moves as it comes. */
  const incoming = (r: Receiving) => (
    <div key={r.id} title={`${r.title} · from ${r.from}`} style={{ margin: "0 12px 8px", padding: "9px 10px 10px 11px", borderRadius: 13,
      border: `1px solid ${mix("var(--purple)", 30)}`, background: "color-mix(in srgb, var(--purple) 4%, var(--panel2))" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span style={{ flex: "none", color: "var(--purple)", display: "flex" }}><Download size={11} strokeWidth={2} /></span>
        <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontFamily: UI, fontSize: "var(--t115)", color: "var(--txh)" }}>{r.title}</span>
        <span style={{ flex: "none", fontFamily: MONO, fontSize: "var(--t8)", letterSpacing: 0.8, color: "var(--txm)" }}>
          {r.stage === "filing" ? "FILING" : "COMING IN"} {r.pct}%
        </span>
      </div>
      <div style={{ marginTop: 8, display: "flex" }}>
        <Bar style="sweep" pct={r.pct} color="var(--purple)" h={3} />
      </div>
      <div style={{ marginTop: 6, fontFamily: UI, fontSize: "var(--t105)", color: "var(--txl)" }}>
        from {r.from}{r.stage === "filing" ? " · writing its turns" : ""}
      </div>
    </div>
  );

  const body = (): ReactNode => {
    // A dashboard newer than the running bridge: the route is missing.
    if (fail === "not found") return <Empty title="The bridge needs a restart" text="This dashboard is newer than the running bridge, which can't show the team yet." />;
    if (fail) return <Empty title="Couldn't read the team" text={fail} />;
    if (!data) return [100, 100, 60].map((w, i) => <div key={i} style={{ height: 30, margin: "8px 12px", width: `calc(${w}% - 24px)`, background: mix("var(--acc)", 7) }} />);
    return (
      <>
        {(data.receiving?.length ?? 0) > 0 && <><Sect label="COMING IN" right={data.receiving!.length} top={10} />{data.receiving!.map(incoming)}</>}
        {data.error && <Empty title="No roster right now" text={data.error} />}
        {!data.error && !roster.length && !feed.today.length && !feed.earlier.length && <Empty title="No teammates yet" text="Everyone on your Rivendell shows here once they're added to it." />}
        {feed.today.length > 0 && <><Sect label="TODAY" top={10} />{feed.today.map(feedRow)}</>}
        {feed.earlier.length > 0 && (
          <>
            <Sect label="EARLIER" top={14} />
            {(allSeen ? feed.earlier : feed.earlier.slice(0, EARLIER_ROWS)).map(feedRow)}
            {feed.earlier.length > EARLIER_ROWS && (
              <button type="button" onClick={() => setAllSeen((v) => !v)} className="tf-fold">{allSeen ? "show less ↑" : `${feed.earlier.length - EARLIER_ROWS} more ↓`}</button>
            )}
          </>
        )}
      </>
    );
  };

  const r = room(data && !data.error ? roster : [], now, h12);
  const first = (n: string) => n.trim().split(/\s+/)[0] || n;
  const others = roster.filter((t) => t.id !== r.lead?.id && !t.online).slice(0, 2).map((t) => {
    const at = t.lastSeenAt ? Date.parse(t.lastSeenAt) / 1000 : NaN;
    return Number.isNaN(at) ? null : `${first(t.name)} ${stamp(at)}`;
  }).filter(Boolean);
  return (
    <div className="panel gp tf" style={{ border: `1px solid ${mix("var(--acc)", 16)}`, background: "color-mix(in srgb, var(--panel) 86%, transparent)", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <TabKick name="TEAM" tools={<button className="gp-ib" title="refresh" aria-label="refresh" onClick={onRefresh}><RefreshCw size={14} /></button>} />
      {data && !data.error && roster.length > 0 && (
        <div className="tf-pres">
          {r.shown.map((t) => (
            <span key={t.id} className={`tf-face${t.online ? " on" : ""}`} title={`${t.name} · ${presence(t, now, h12)}${t.device ? ` · shares ${t.device.name} (Mac)` : ""}`}>
              <Avatar id={t.id} name={t.name} src={t.avatarUrl} size={30} />
            </span>
          ))}
          {r.more > 0 && <span className="tf-face tf-more">+{r.more}</span>}
          <span className="tf-t">
            <b>{r.lead ? `${first(r.lead.name)} is on now` : "Nobody is on right now"}</b>
            <small>{others.join(" · ") || (r.lead ? "" : "A session you send now waits for them")}</small>
          </span>
        </div>
      )}
      <div className="mscroll" style={{ flex: 1, minHeight: 0, padding: "4px 0 10px" }}>{body()}</div>
      {sessionTitle && roster.length > 0 && <SendBar roster={roster} sessionTitle={sessionTitle} onSend={onSendTo} />}
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
