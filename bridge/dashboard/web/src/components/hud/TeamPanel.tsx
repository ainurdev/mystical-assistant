import { useState, type ReactNode } from "react";
import { Download, Eye, Forward, Image as ImageIcon, Laptop, Send, Users, X } from "lucide-react";
import type { Received, Share, TeamOverview, Teammate } from "../../api";
import { initials } from "../../lib/rivendelltasks";
import { useClock12 } from "../../lib/surfaces";
import { KIND_LABEL, byPresence, personTint, presence, sentAgo, sentStatus, shareFacts, type SentTone } from "../../lib/team";
import { ImageLightbox } from "../ImageLightbox";

const UI = "var(--ui-font, inherit)";
const MONO = "var(--mono)";
const mix = (c: string, pct: number) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;
const TONE: Record<SentTone, string> = { ok: "var(--ok)", purple: "var(--purple)", warn: "var(--warn)", dim: "var(--txl)" };
const toolBtn = {
  appearance: "none", cursor: "pointer", background: "transparent", color: "var(--txm)",
  border: `1px solid ${mix("var(--acc)", 20)}`, fontFamily: "inherit", fontSize: "var(--t95)", lineHeight: 1.3, padding: "2px 6px",
} as const;

/** A teammate's initials in their colour, with a presence dot when it is known. */
export function Avatar({ id, name, size = 26, state }: { id: string; name: string; size?: number; state?: "on" | "away" }) {
  const c = personTint(id);
  const dot = size >= 24 ? 9 : 7;
  return (
    <span aria-hidden style={{
      position: "relative", flex: "none", width: size, height: size, borderRadius: "50%", display: "grid", placeItems: "center",
      boxSizing: "border-box", background: `color-mix(in srgb, ${c} 15%, var(--panel2))`, border: `1px solid ${mix(c, 36)}`,
      color: c, fontFamily: UI, fontSize: size >= 26 ? "var(--t95)" : size >= 20 ? "var(--t8)" : "var(--t7)", fontWeight: 600,
      opacity: state === "away" ? 0.75 : 1,
    }}>
      {initials(name)}
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

const Sect = ({ label, right, top = 12 }: { label: string; right?: ReactNode; top?: number }) => (
  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: "var(--t9)", letterSpacing: 1.5, color: "var(--txl)", padding: `${top}px 12px 6px` }}>
    {label}<span style={{ letterSpacing: 0.5, fontFamily: MONO }}>{right}</span>
  </div>
);

/** The TEAM tab (bridge/team.py): what teammates sent you, who has Mystical on,
 *  who's away, and how far your own sends got. App owns the data (it polls, and
 *  the rail badge and the session menu read it too). SEND on a teammate sends the
 *  session you have open: `sessionTitle` is null when it isn't yours to send. */
export function TeamPanel({ data, fail, sessionTitle, onRefresh, onSendTo, onOpen, onContinue, onDismiss }: {
  data: TeamOverview | null;
  fail: string | null;
  sessionTitle: string | null;
  onRefresh: () => void;
  onSendTo: (t: Teammate) => void;
  onOpen: (r: Received) => void;
  onContinue: (r: Received) => void;
  onDismiss: (r: Received) => void;
}) {
  const h12 = useClock12();
  const now = Date.now() / 1000;
  const [hov, setHov] = useState<string | null>(null);
  const [zoom, setZoom] = useState<string | null>(null);
  const roster = [...(data?.roster ?? [])].sort(byPresence);
  const on = roster.filter((t) => t.online);
  const away = roster.filter((t) => !t.online);

  const mate = (t: Teammate) => (
    <div key={t.id} onMouseEnter={() => setHov(t.id)} onMouseLeave={() => setHov(null)} style={{
      display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", margin: "0 6px", borderRadius: 8,
      background: hov === t.id ? mix("var(--acc)", 7) : "transparent",
    }}>
      <Avatar id={t.id} name={t.name} size={28} state={t.online ? "on" : "away"} />
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
    return (
      <div key={r.id} style={{
        margin: "0 10px 8px", padding: "10px 10px 10px 11px", borderRadius: 10,
        border: `1px solid ${mix("var(--acc)", r.opened ? 18 : 30)}`, background: `color-mix(in srgb, var(--acc) ${r.opened ? 2 : 5}%, var(--panel2))`,
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
          <Avatar id={r.from.id || r.from.name} name={r.from.name} size={22} />
          <span style={{ fontFamily: UI, fontSize: "var(--t115)", fontWeight: 500, color: "var(--txh)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.from.name}</span>
          <span style={{ fontFamily: MONO, fontSize: "var(--t9)", color: "var(--txl)", whiteSpace: "nowrap" }}>{sentAgo(r.sent, now) || ""}</span>
          <span style={{ flex: 1 }} />
          {!r.opened && <i title="new" style={{ flex: "none", width: 7, height: 7, borderRadius: "50%", background: "var(--acc)", boxShadow: `0 0 8px ${mix("var(--acc)", 60)}` }} />}
          <button type="button" title="Dismiss — it leaves your list; nothing ran" onClick={() => onDismiss(r)} style={{
            appearance: "none", cursor: "pointer", display: "grid", placeItems: "center", width: 22, height: 22, flex: "none", border: 0, borderRadius: 6,
            background: "transparent", color: "var(--txl)", padding: 0,
          }}><X size={11} strokeWidth={2} /></button>
        </div>
        <div style={{ marginTop: 8, display: "flex", alignItems: "baseline", gap: 7, minWidth: 0 }}>
          <span style={{ flex: "none", fontFamily: MONO, fontSize: "var(--t8)", letterSpacing: 1, color: "var(--acc)" }}>{KIND_LABEL[r.kind]}</span>
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
          {f.bits.map((b) => <span key={b}>{b}</span>)}
        </div>
        <div style={{ marginTop: 10, display: "flex", gap: 6, flexWrap: "wrap" }}>
          {r.kind === "session" && r.session && <Btn icon={<Eye size={11} strokeWidth={2} />} label="OPEN" onClick={() => onOpen(r)} />}
          {r.kind === "picture" && r.url && <Btn icon={<ImageIcon size={11} strokeWidth={2} />} label="OPEN" onClick={() => { setZoom(r.url); onOpen(r); }} />}
          {r.kind === "file" && r.url && (
            <a href={r.url} download={r.file || undefined} onClick={() => onOpen(r)} style={btnStyle()}>
              <Download size={11} strokeWidth={2} />DOWNLOAD
            </a>
          )}
          <Btn icon={<Forward size={11} strokeWidth={2} />} label="CONTINUE HERE" pri onClick={() => onContinue(r)}
            title="Your own session: their work attached, the prompt left for you to send" />
        </div>
      </div>
    );
  };

  const sent = (s: Share) => {
    const st = sentStatus(s, now);
    return (
      <div key={s.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 12px", minWidth: 0 }} title={`${s.title} → ${s.to.name}`}>
        <span style={{ flex: "none", color: "var(--txl)", display: "flex" }}><Send size={11} strokeWidth={2} /></span>
        <span style={{ flex: 1, minWidth: 0, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", fontFamily: UI, fontSize: "var(--t11)", color: "var(--txm)" }}>{s.title}</span>
        <Avatar id={s.to.id} name={s.to.name} size={16} />
        <span style={{ flex: "none", minWidth: 72, textAlign: "right", fontFamily: MONO, fontSize: "var(--t8)", letterSpacing: 0.8, color: TONE[st.tone] }}>{st.text}</span>
      </div>
    );
  };

  const body = (): ReactNode => {
    // A dashboard newer than the running bridge: the route is missing (see SpendPanel).
    if (fail === "not found") return <Empty title="The bridge needs a restart" text="This dashboard is newer than the running bridge, which can't show the team yet." />;
    if (fail) return <Empty title="Couldn't read the team" text={fail} />;
    if (!data) return [100, 100, 60].map((w, i) => <div key={i} style={{ height: 30, margin: "8px 12px", width: `calc(${w}% - 24px)`, background: mix("var(--acc)", 7) }} />);
    return (
      <>
        {data.inbox.length > 0 && <><Sect label="SENT TO YOU" right={data.inbox.length} top={10} />{data.inbox.map(card)}</>}
        {data.error ? (
          <Empty title="No roster right now" text={data.error} />
        ) : (
          <>
            <Sect label="ON NOW" right={on.length} top={data.inbox.length ? 12 : 10} />
            {on.length ? on.map(mate) : (
              <>
                <div style={{ padding: "4px 12px 2px", fontFamily: UI, fontSize: "var(--t115)", color: "var(--txm)" }}>Nobody else is on right now.</div>
                <div style={{ padding: "3px 12px 12px", fontFamily: UI, fontSize: "var(--t105)", lineHeight: 1.45, color: "var(--txl)", maxWidth: 262 }}>
                  A session you send now waits in Rivendell, and reaches them the moment their Mystical comes back.
                </div>
              </>
            )}
            {away.length > 0 && <><Sect label="AWAY" right={away.length} />{away.map(mate)}</>}
            {data.outbox.length > 0 && <><Sect label="YOU SENT" top={14} />{data.outbox.slice(0, 3).map(sent)}</>}
            {!roster.length && <Empty title="No teammates yet" text="Everyone on your Rivendell shows here once they're added to it." />}
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

function Empty({ title, text }: { title: string; text: ReactNode }) {
  return (
    <div style={{ padding: "22px 16px", display: "flex", flexDirection: "column", alignItems: "center", gap: 10, textAlign: "center" }}>
      <span style={{ color: "var(--txg)" }}><Users size={24} strokeWidth={1.3} /></span>
      <div style={{ fontSize: "var(--t115)", color: "var(--txh)" }}>{title}</div>
      <div style={{ fontSize: "var(--t10)", lineHeight: 1.55, color: "var(--txl)", maxWidth: 240 }}>{text}</div>
    </div>
  );
}
