import { Send } from "lucide-react";
import type { TeamOverview, Teammate } from "../../api";
import { useClock12 } from "../../lib/surfaces";
import { room } from "../../lib/room";
import { Avatar } from "./TeamPanel";
import { RailHero } from "./RailHero";

/* The Team tab's hero: up to 5 avatars (a green ring and live dot when on now,
   dimmed when away), a Send circle, and who is on and since when. Send is the
   panel's own send action, aimed at the first person on now; it is disabled
   when there is no session of yours to send. */
export function TeamRoom({ data, fail, sessionTitle, onSendTo }: {
  data: TeamOverview | null;
  /** the roster fetch's error, if it failed: the box says so instead of "loading" */
  fail?: string | null;
  sessionTitle: string | null; onSendTo: (t: Teammate) => void;
}) {
  const h12 = useClock12();
  const roster = data && !data.error ? data.roster : [];
  const r = room(roster, Date.now() / 1000, h12);
  const broke = !!fail || !!data?.error, loading = !data && !fail;
  const label = broke ? "couldn't load the team" : loading ? "Team: loading" : !roster.length ? "nobody on your team yet"
    : `Rivendell team, ${r.on} on now of ${roster.length}. ${r.caption}`;
  const target = r.lead ?? r.shown[0];
  return (
    <RailHero label={label} top={roster.length ? <>
      <span className="tr-k">◆ RIVENDELL</span>
      <span className="tr-pill" style={{ color: r.on ? "var(--ok)" : "var(--txl)" }}>{r.on} ON NOW</span>
    </> : <span className="tr-k">◆ RIVENDELL</span>}>
      <div className="tr-row">
        <div className="tr-avs">
        {r.shown.map((t) => (
          <div key={t.id} className={`tr-p${t.online ? " on" : ""}`} title={t.name}>
            <span className="tr-av"><Avatar id={t.id} name={t.name} src={t.avatarUrl} size={34} />{t.online && <i className="tr-live" />}</span>
            <span className="tr-n">{t.name.trim().split(/\s+/)[0]}</span>
          </div>
        ))}
        {r.more > 0 && <div className="tr-p"><span className="tr-av tr-more">+{r.more}</span><span className="tr-n">more</span></div>}
        </div>
        {target && sessionTitle && (
          <button type="button" className="tr-p tr-send" aria-label={`Send “${sessionTitle}” to ${target.name}`} onClick={() => onSendTo(target)}>
            <span className="tr-av"><Send size={15} strokeWidth={2} aria-hidden /></span><span className="tr-n">Send</span>
          </button>
        )}
      </div>
      <div className="tr-cap">{broke ? "couldn't load the team" : loading ? "loading…" : roster.length ? r.caption : "nobody on your team yet"}</div>
    </RailHero>
  );
}
