import { useState } from "react";
import { ChevronRight, Clock, CornerUpLeft, Forward, Layers, Plus, Users, X } from "lucide-react";
import { api, type Received, type SessionBrief, type TeamEarlier } from "../api";
import { sentAgo } from "../lib/team";
import { Avatar } from "./hud/TeamPanel";

/** The chat header's tile on a session a teammate sent: no project of yours. */
export function TeamTile() {
  return <b className="ptile" aria-hidden data-kind="icon" style={{ ["--pc" as string]: "var(--purple)" }}><Users /></b>;
}

/** In place of the composer on a session a teammate sent (lib/team): there is
 *  nothing to type into someone else's session, so the bar says whose it is and
 *  what they asked, and offers the two ways on: DISMISS, or CONTINUE HERE, which
 *  starts a session of your own with their work attached and the prompt unsent.
 *  Styled with JobBar's classes. */
export function TeamBar({ s, src, row, onContinue, onContinueYours, onDismiss, step }: {
  s: SessionBrief; src?: string | null; onContinue: () => void; onDismiss: () => void;
  row?: Received | null;          // its TEAM row: a newer state of a thread you have goes into yours
  onContinueYours?: () => void;
  step?: string | null;      // CLONE & INSTALL's progress, in place of CONTINUE HERE
}) {
  const t = s.team;
  if (!t) return null;
  const first = t.from.name.split(" ")[0] || t.from.name;
  const when = sentAgo(t.sent, Date.now() / 1000);
  const yours = !!row?.yours && !!onContinueYours;
  return (
    // In the composer's own wrapper, so it sits where the box would, as DeviceRunPlate does.
    <div className="composer">
    <div className="jobbar" data-state="team" style={{
      flexWrap: "nowrap", gap: 12,
      borderColor: "color-mix(in srgb, var(--purple) 32%, transparent)", background: "color-mix(in srgb, var(--purple) 4%, var(--panel2))",
    }}>
      <Avatar id={t.from.id || t.from.name} name={t.from.name} src={src} size={30} />
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 10, minWidth: 0 }}>
          <span className="jobbar-w1" style={{ color: "var(--purple)" }}>{row?.relation === "back" ? "SENT BACK BY" : "FROM"} {t.from.name.toUpperCase()}</span>
          <span className="jobbar-w2" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {when && when !== "now" ? `${when} ago · ` : ""}read-only{yours ? "" : ` · it ran on ${first}'s machine`}
          </span>
        </div>
        {t.note && (
          <div style={{
            paddingLeft: 9, borderLeft: "2px solid color-mix(in srgb, var(--purple) 45%, transparent)", fontFamily: "var(--ui-font, inherit)",
            fontSize: "var(--t115)", lineHeight: 1.45, color: "var(--txm)", overflowWrap: "anywhere",
          }}>{t.note}</div>
        )}
      </div>
      <button type="button" className="jobbar-btn" style={{ flex: "none" }} onClick={onDismiss} title="It leaves your list; nothing ran">
        <X size={12} strokeWidth={2} aria-hidden />DISMISS
      </button>
      {yours ? (
        <>
          <button type="button" className="jobbar-btn" style={{ flex: "none" }} onClick={onContinue}
            title="A new session of yours: their work attached, the prompt left for you to send">
            <Plus size={12} strokeWidth={2} aria-hidden />NEW SESSION
          </button>
          <button type="button" className="jobbar-btn" data-pri style={{ flex: "none" }} onClick={onContinueYours}
            title={`Your session “${row?.yours?.title}”: what's new attached, the prompt left for you to send`}>
            <CornerUpLeft size={12} strokeWidth={2} aria-hidden />{step ?? "CONTINUE IN YOURS"}
          </button>
        </>
      ) : (
        <button type="button" className="jobbar-btn" data-pri style={{ flex: "none" }} onClick={onContinue}
          title="Your own session: their work attached, the prompt left for you to send">
          <Forward size={12} strokeWidth={2} aria-hidden />{step ?? "CONTINUE HERE"}
        </button>
      )}
    </div>
    </div>
  );
}

const mix = (c: string, pct: number) => `color-mix(in srgb, ${c} ${pct}%, transparent)`;
const UI = "var(--ui-font, inherit)";

/** Above the first turn of a session a teammate continued from someone's: whose turns came
 *  before theirs. SHOW unfolds them in place, dimmed, each prompt with its answer. */
export function EarlierPlate({ share, facts, by, me }: {
  share: string;
  facts: NonNullable<NonNullable<SessionBrief["team"]>["earlier"]>;
  by: string;                    // who picked it up after them: the sender of this share
  me?: string | null;            // your Rivendell id, only on a session sent back to you: the turns were yours
}) {
  const [open, setOpen] = useState(false);
  const [got, setGot] = useState<TeamEarlier | null>(null);
  const [fail, setFail] = useState("");
  const whose = me && facts.from.id === me ? "Your" : `${facts.from.name}'s`;
  const ago = sentAgo(facts.sent, Date.now() / 1000);
  const toggle = () => {
    setOpen((v) => !v);
    if (!got) api.teamEarlier(share).then(setGot, (e: Error) => setFail(e.message === "not found" ? "They're no longer here." : e.message));
  };
  return (
    <div style={{ margin: "0 0 14px", borderRadius: 12, border: `1px dashed ${mix("var(--purple)", 40)}`, background: mix("var(--purple)", 5) }}>
      <button type="button" onClick={toggle} aria-expanded={open} style={{
        appearance: "none", width: "100%", display: "flex", alignItems: "center", gap: 11, padding: "10px 14px", border: 0,
        background: "transparent", cursor: "pointer", textAlign: "left", fontFamily: "inherit",
      }}>
        <span style={{ flex: "none", color: "var(--purple)", display: "flex" }}><Layers size={15} strokeWidth={2} /></span>
        <span style={{ flex: 1, minWidth: 0 }}>
          <span style={{ display: "block", fontFamily: "var(--mono)", fontSize: "var(--t8)", letterSpacing: 1.5, color: "var(--purple)" }}>EARLIER IN THIS THREAD</span>
          <span style={{ display: "block", marginTop: 3, fontFamily: UI, fontSize: "var(--t12)", color: "var(--txm)" }}>
            {whose} {facts.turns} turn{facts.turns === 1 ? "" : "s"}, before {by.split(" ")[0] || by} picked it up{ago ? ` · sent ${ago === "now" ? "just now" : `${ago} ago`}` : ""}
          </span>
        </span>
        <span style={{ flex: "none", display: "inline-flex", alignItems: "center", gap: 5, fontFamily: UI, fontSize: "var(--t105)", color: "var(--txl)" }}>
          {open ? "HIDE" : "SHOW"}<ChevronRight size={12} strokeWidth={2} style={{ transform: open ? "rotate(90deg)" : undefined }} />
        </span>
      </button>
      {open && (
        // Its own scroll: the transcript under it is windowed, and a long unfolded hop above the
        // list would push its window out of step.
        <div style={{ padding: "0 14px 12px 40px", display: "flex", flexDirection: "column", gap: 10, opacity: 0.8, maxHeight: "40vh", overflowY: "auto" }}>
          {fail ? <span style={{ fontFamily: UI, fontSize: "var(--t11)", color: "var(--txl)" }}>{fail}</span>
            : !got ? <span style={{ fontFamily: UI, fontSize: "var(--t11)", color: "var(--txl)" }}>Loading…</span>
            : got.turns.map((t, i) => (
              <div key={i} style={{ paddingLeft: 10, borderLeft: `2px solid ${mix("var(--purple)", 35)}`, fontFamily: UI, fontSize: "var(--t115)", lineHeight: 1.5 }}>
                <div style={{ color: "var(--txh)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{t.prompt || "(no words)"}</div>
                {t.answer && <div style={{ marginTop: 4, color: "var(--txm)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{t.answer}</div>}
              </div>
            ))}
        </div>
      )}
    </div>
  );
}

/** In place of the answer of a turn that was still running when its teammate sent the session. */
export function UnfinishedPlate({ who }: { who: string }) {
  return (
    <div style={{
      margin: "16px 0 4px", padding: "10px 14px", borderRadius: 12, border: `1px dashed ${mix("var(--warn)", 45)}`, background: mix("var(--warn)", 5),
      display: "flex", alignItems: "center", gap: 10, fontFamily: UI, fontSize: "var(--t12)", color: "var(--txm)",
    }}>
      <span style={{ flex: "none", color: "var(--warn)", display: "flex" }}><Clock size={14} strokeWidth={2} /></span>
      <span><b style={{ color: "var(--warn)", fontWeight: 600 }}>Unfinished</b> · still running when {who.split(" ")[0] || who} sent this, so there's no answer yet</span>
    </div>
  );
}

/** In the composer of your session after CONTINUE IN YOURS, until you send: what came into it. */
export function BackPill({ text }: { text: string }) {
  return (
    <div title="What came into this session; the draft says the rest. It goes when you send."
      style={{ alignSelf: "flex-start", display: "inline-flex", alignItems: "center", gap: 6, maxWidth: "100%", height: 24,
               boxSizing: "border-box", padding: "0 9px", borderRadius: 999, whiteSpace: "nowrap",
               border: `1px solid ${mix("var(--purple)", 40)}`, background: mix("var(--purple)", 8), color: "var(--purple-h)", fontSize: "var(--t105)" }}>
      <CornerUpLeft size={11} strokeWidth={2} aria-hidden style={{ flex: "none", color: "var(--purple)" }} />
      <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{text}</span>
    </div>
  );
}
