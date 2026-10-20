import { Forward, Users, X } from "lucide-react";
import type { SessionBrief } from "../api";
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
export function TeamBar({ s, src, onContinue, onDismiss }: { s: SessionBrief; src?: string | null; onContinue: () => void; onDismiss: () => void }) {
  const t = s.team;
  if (!t) return null;
  const first = t.from.name.split(" ")[0] || t.from.name;
  const when = sentAgo(t.sent, Date.now() / 1000);
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
          <span className="jobbar-w1" style={{ color: "var(--purple)" }}>FROM {t.from.name.toUpperCase()}</span>
          <span className="jobbar-w2" style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {when && when !== "now" ? `${when} ago · ` : ""}read-only · it ran on {first}'s machine
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
      <button type="button" className="jobbar-btn" data-pri style={{ flex: "none" }} onClick={onContinue}
        title="Your own session: their work attached, the prompt left for you to send">
        <Forward size={12} strokeWidth={2} aria-hidden />CONTINUE HERE
      </button>
    </div>
    </div>
  );
}
