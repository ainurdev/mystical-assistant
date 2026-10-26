import { useState, type ReactNode } from "react";
import { CornerUpLeft, Download, Eye, File as FileIcon, Forward, Image as ImageIcon, Laptop, Layers, MessageSquare, Send, Users, X } from "lucide-react";
import type { Received, Share, TeamOverview, Teammate } from "../../api";
import { initials } from "../../lib/rivendelltasks";
import { useClock12 } from "../../lib/surfaces";
import { KIND_LABEL, byPresence, foldSent, personTint, presence, relationLine, seen, sentAgo, sentBefore, sentStatus, shareFacts, type SentTone } from "../../lib/team";
import { ImageLightbox } from "../ImageLightbox";

const UI = "var(--ui-font, inherit)";
const MONO = "var(--mono)";
const mix = (c: string, pct: number) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;
const TONE: Record<SentTone, string> = { ok: "var(--ok)", purple: "var(--purple)", warn: "var(--warn)", dim: "var(--txl)", err: "var(--err)" };
const KIND_ICON = { session: MessageSquare, picture: ImageIcon, file: FileIcon } as const;
const SEEN_ROWS = 3;       // SEEN shows this many, the rest behind "N more"
const toolBtn = {
  appearance: "none", cursor: "pointer", background: "transparent", color: "var(--txm)",
  border: `1px solid ${mix("var(--acc)", 20)}`, fontFamily: "inherit", fontSize: "var(--t95)", lineHeight: 1.3, padding: "2px 6px",
} as const;

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
export function TeamPanel({ data, fail, sessionTitle, onRefresh, onSendTo, onOpen, onContinue, onContinueYours, onDismiss, step }: {
  data: TeamOverview | null;
  fail: string | null;
  sessionTitle: string | null;
  onRefresh: () => void;
  onSendTo: (t: Teammate) => void;
  onOpen: (r: Received) => void;
  onContinue: (r: Received) => void;
  onContinueYours: (r: Received) => void;     // a newer state of a thread you have: into your session in it
  onDismiss: (r: Received) => void;
  step?: { id: string; text: string } | null;    // CLONE & INSTALL's progress, on the share it is for
}) {
  const h12 = useClock12();
  const now = Date.now() / 1000;
  const [hov, setHov] = useState<string | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const [allSeen, setAllSeen] = useState(false);
  const roster = [...(data?.roster ?? [])].sort(byPresence);
  const on = roster.filter((t) => t.online);
  const away = roster.filter((t) => !t.online);
  const face = (id: string) => roster.find((t) => t.id === id)?.avatarUrl;
  const fresh = (data?.inbox ?? []).filter((r) => !seen(r));
  const old = (data?.inbox ?? []).filter(seen);

  const mate = (t: Teammate) => (
    <div key={t.id} onMouseEnter={() => setHov(t.id)} onMouseLeave={() => setHov(null)} style={{
      display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", margin: "0 6px", borderRadius: 8,
      background: hov === t.id ? mix("var(--acc)", 7) : "transparent",
    }}>
      <Avatar id={t.id} name={t.name} src={t.avatarUrl} size={28} state={t.online ? "on" : "away"} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontFamily: UI, fontSize: "var(--t12)", fontWeight: 500, color: t.online ? "var(--txh)" : "var(--txm)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{t.name}</div>
        <div style={{ marginTop: 2, fontFamily: MONO, fontSize: "var(--t9)", color: t.online ? "var(--ok)" : "var(--txl)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{presence(t, now, h12)}</div>
      </div>
      {hov === t.id && sessionTitle ? (
        <Btn icon={<Send size={11} strokeWidth={2} />} label="SEND" pri onClick={() => onSendTo(t)} title={`Send “${sessionTitle}” to ${t.name}`} />
      ) : t.device && (
        <span title={`${t.name} shares ${t.device.name} with you for device runs`} style={{
          flex: "none", display: "inline-flex", alignItems: "center", gap: 4, padding: "2px 6px", borderRadius: 5,
          border: "1px solid var(--line2)", fontFamily: MONO, fontSize: "var(--t8)", letterSpacing: 0.5, color: t.online ? "var(--txd)" : "var(--txl)",
        }}><Laptop size={10} strokeWidth={2} />MAC</span>
      )}
    </div>
  );

  const card = (r: Received) => {
    const f = shareFacts(r.kind, r.meta);
    const c = personTint(r.from.id || r.from.name);
    const thread = typeof r.meta.thread === "string" ? r.meta.thread : undefined;
    const rel = relationLine(r, now, r.relation === "back" ? sentBefore(data?.outbox ?? [], thread, r.from.id)?.last : null, h12);
    return (
      <div key={r.id} style={{
        margin: "0 10px 8px", padding: "10px 10px 10px 11px", borderRadius: 10,
        border: `1px solid ${mix("var(--acc)", 30)}`, background: "color-mix(in srgb, var(--acc) 5%, var(--panel2))",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <Avatar id={r.from.id || r.from.name} name={r.from.name} src={face(r.from.id)} size={22} />
          <span style={{ fontFamily: UI, fontSize: "var(--t115)", fontWeight: 500, color: "var(--txh)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.from.name}</span>
          <span style={{ fontFamily: MONO, fontSize: "var(--t9)", color: "var(--txl)", whiteSpace: "nowrap" }}>{sentAgo(r.sent, now) || ""}</span>
          <span style={{ flex: 1 }} />
          <i title="new" style={{ flex: "none", width: 7, height: 7, borderRadius: "50%", background: "var(--acc)", boxShadow: `0 0 8px ${mix("var(--acc)", 60)}` }} />
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
          {r.yours ? (
            <Btn icon={<CornerUpLeft size={11} strokeWidth={2} />} label={step?.id === r.id ? step.text : "CONTINUE IN YOURS"} pri onClick={() => onContinueYours(r)}
              title={`Your session “${r.yours.title}”: what's new attached, the prompt left for you to send`} />
          ) : (
            <Btn icon={<Forward size={11} strokeWidth={2} />} label={step?.id === r.id ? step.text : "CONTINUE HERE"} pri onClick={() => onContinue(r)}
              title="Your own session: their work attached, the prompt left for you to send" />
          )}
        </div>
        {r.yours && (
          <button type="button" onClick={() => onContinue(r)} style={{
            appearance: "none", border: 0, background: "transparent", padding: "6px 0 0", cursor: "pointer", fontFamily: UI, fontSize: "var(--t105)",
            color: "var(--txl)", textDecoration: "underline", textDecorationColor: mix("var(--txl)", 40), textUnderlineOffset: 3,
          }}>or start a new session with it</button>
        )}
      </div>
    );
  };

  const sent = (s: Share) => {
    const st = sentStatus(s, now);
    return (
      <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", minWidth: 0 }}
        title={`${s.title} → ${s.to.name}${s.queued ? (s.error ? ` · not sent: ${s.error}` : " · goes when its running turn ends") : ""}`}>
        <span style={{ flex: "none", color: "var(--txl)", display: "flex" }}><Send size={11} strokeWidth={2} /></span>
        <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontFamily: UI, fontSize: "var(--t11)", color: "var(--txm)" }}>{s.title}</span>
        <Avatar id={s.to.id} name={s.to.name} src={face(s.to.id)} size={16} />
        <span style={{ flex: "none", minWidth: 72, textAlign: "right", fontFamily: MONO, fontSize: "var(--t8)", letterSpacing: 0.8, color: TONE[st.tone] }}>{st.text}</span>
      </div>
    );
  };

  /** A SEEN row opens what it was again: the session read only, the picture large, the file downloaded. */
  const reopen = (r: Received) => {
    if (r.kind === "picture" && r.url) setZoom(r.url);
    if (r.kind === "file" && r.url) Object.assign(document.createElement("a"), { href: r.url, download: r.file || "" }).click();
    onOpen(r);
  };

  // One quiet line, as YOU SENT's are. Hovered or focused, its stamp gives way to
  // CONTINUE HERE and remove (dismiss: your copy goes).
  const seenRow = (r: Received) => {
    const Icon = KIND_ICON[r.kind];
    const key = `seen:${r.id}`;
    const busy = step?.id === r.id ? step.text : null;
    const ago = sentAgo(r.sent, now);
    return (
      <div key={r.id} onClick={() => reopen(r)} onMouseEnter={() => setHov(key)} onMouseLeave={() => setHov(null)}
        onFocus={() => setHov(key)} onBlur={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setHov(null); }}
        title={`${r.title} · from ${r.from.name}${ago ? ` · sent ${ago === "now" ? "just now" : `${ago} ago`}` : ""}`}
        style={{ display: "flex", alignItems: "center", gap: 8, padding: 6, margin: "0 6px", minWidth: 0, borderRadius: 8, cursor: "pointer",
                 background: hov === key ? mix("var(--acc)", 7) : "transparent" }}>
        <span style={{ flex: "none", color: "var(--txl)", display: "flex" }}><Icon size={11} strokeWidth={2} /></span>
        <button type="button" style={{
          flex: 1, minWidth: 0, appearance: "none", border: 0, padding: 0, background: "transparent", cursor: "pointer", textAlign: "left",
          whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontFamily: UI, fontSize: "var(--t11)", color: hov === key ? "var(--txh)" : "var(--txm)",
        }}>{r.title}</button>
        {(r.version ?? 1) > 1 && <Pill c="var(--txl)">V{r.version}</Pill>}
        <Avatar id={r.from.id || r.from.name} name={r.from.name} src={face(r.from.id)} size={16} />
        {hov === key && !busy ? (
          <span style={{ flex: "none", minWidth: 72, display: "flex", justifyContent: "flex-end", gap: 2 }}>
            {r.yours
              ? <RowBtn label={`Continue in yours: “${r.yours.title}”`} color="var(--acc)" onClick={() => onContinueYours(r)}><CornerUpLeft size={12} strokeWidth={2} /></RowBtn>
              : <RowBtn label="Continue here" color="var(--acc)" onClick={() => onContinue(r)}><Forward size={12} strokeWidth={2} /></RowBtn>}
            <RowBtn label="Remove: your copy goes" color="var(--txl)" onClick={() => onDismiss(r)}><X size={12} strokeWidth={2} /></RowBtn>
          </span>
        ) : (
          <span style={{ flex: "none", minWidth: 72, textAlign: "right", fontFamily: MONO, fontSize: "var(--t8)", letterSpacing: 0.8,
                         color: busy ? "var(--txm)" : r.continued ? "var(--purple)" : "var(--ok)" }}>
            {busy ?? (r.continued ? "CONTINUED" : "OPENED")}
          </span>
        )}
      </div>
    );
  };

  const body = (): ReactNode => {
    // A dashboard newer than the running bridge: the route is missing.
    if (fail === "not found") return <Empty title="The bridge needs a restart" text="This dashboard is newer than the running bridge, which can't show the team yet." />;
    if (fail) return <Empty title="Couldn't read the team" text={fail} />;
    if (!data) return [100, 100, 60].map((w, i) => <div key={i} style={{ height: 30, margin: "8px 12px", width: `calc(${w}% - 24px)`, background: mix("var(--acc)", 7) }} />);
    return (
      <>
        {fresh.length > 0 && <><Sect label="SENT TO YOU" right={fresh.length} top={10} />{fresh.map(card)}</>}
        {data.error ? (
          <Empty title="No roster right now" text={data.error} />
        ) : (
          <>
            <Sect label="ON NOW" right={on.length} top={fresh.length ? 12 : 10} />
            {on.length ? on.map(mate) : (
              <>
                <div style={{ padding: "4px 12px 2px", fontFamily: UI, fontSize: "var(--t115)", color: "var(--txm)" }}>Nobody else is on right now.</div>
                <div style={{ padding: "3px 12px 12px", fontFamily: UI, fontSize: "var(--t105)", lineHeight: 1.45, color: "var(--txl)", maxWidth: 262 }}>
                  A session you send now waits in Rivendell, and reaches them the moment their Mystical comes back.
                </div>
              </>
            )}
            {away.length > 0 && <><Sect label="AWAY" right={away.length} />{away.map(mate)}</>}
            {data.outbox.length > 0 && <><Sect label="YOU SENT" top={14} />{foldSent(data.outbox).slice(0, 3).map(sent)}</>}
            {!roster.length && <Empty title="No teammates yet" text="Everyone on your Rivendell shows here once they're added to it." />}
          </>
        )}
        {old.length > 0 && (
          <>
            <Sect label="SEEN" right={old.length} top={16} />
            {(allSeen ? old : old.slice(0, SEEN_ROWS)).map(seenRow)}
            {old.length > SEEN_ROWS && (
              <button type="button" onClick={() => setAllSeen((v) => !v)} style={{
                display: "block", width: "100%", textAlign: "left", padding: "7px 12px", border: 0, background: "transparent", cursor: "pointer",
                fontFamily: "inherit", fontSize: "var(--t95)", letterSpacing: ".1em", color: "var(--txl)",
              }}>{allSeen ? "show less ↑" : `${old.length - SEEN_ROWS} more ↓`}</button>
            )}
          </>
        )}
      </>
    );
  };

  return (
    <div className="panel" style={{ border: `1px solid ${mix("var(--acc)", 16)}`, background: "color-mix(in srgb, var(--panel) 86%, transparent)", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px" }}>
        <span style={{ fontSize: "var(--t105)", letterSpacing: 2.5, color: "var(--txl)" }}>TEAM</span>
        <button style={toolBtn} title="refresh" onClick={onRefresh}>⟳</button>
      </div>
      <div style={{ height: 1, background: "linear-gradient(90deg,var(--acc),transparent)" }} />
      {data && !data.error && (
        <div className="swapin" style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 12px 2px", fontSize: "var(--t95)", color: "var(--purple-h)", minWidth: 0 }}>
          <span style={{ color: "var(--purple)", flex: "none" }}>◆</span>
          <span>Rivendell</span>
          <span style={{ marginLeft: "auto", flex: "none", color: on.length ? "var(--ok)" : "var(--txl)" }}>{on.length} ON NOW</span>
        </div>
      )}
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
