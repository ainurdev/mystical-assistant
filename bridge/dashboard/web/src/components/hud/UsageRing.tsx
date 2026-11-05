import type { Window } from "../../models";
import { barHeights, capText, ringDash, ringText, RING_C, RING_R } from "../../lib/usagering";
import { dur } from "../../lib/week";
import { hhmm } from "../../lib/surfaces";
import { RailHero } from "./RailHero";

/* The Usage tab's hero: the open login's 5-hour window as a ring (what the
   composer's PROFILE chip reads, `left` and the refill time), and the week's
   agent time as seven day bars, today lit. Amber is the window, accent the days.
   No reading for the login: the ring says "—" at the same size. */
export function UsageRing({ win, range, back, elapsed, turns, sessions, days, todayIdx, pick, onPick }: {
  win: Window | null; range: string; back: boolean;
  /** the week's agent time, seconds; null while it loads */
  elapsed: number | null; turns: number; sessions: number;
  days: { key: string; date: Date; label: string; elapsed: number; turns: number }[]; todayIdx: number;
  /** the tapped day, or null for the whole week */
  pick: number | null; onPick: (i: number | null) => void;
}) {
  const left = win ? win.left : null;
  const h = barHeights(days.map((d) => d.elapsed), 30);
  const reset = win?.resets_at ? hhmm(Date.parse(win.resets_at) / 1000) : "";
  const day = pick !== null ? days[pick] : null;
  const dayName = day?.date.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  const shown = day ? day.elapsed : elapsed;
  const who = day ? dayName! : `${back ? "Last" : "This"} week`;
  const label = `${who} ${shown === null ? "loading" : `${dur(shown)} of agent time`}. 5-hour window ${
    left === null ? "not read" : `${left}% left${reset ? `, resets ${reset}` : ""}`}`;
  return (
    <RailHero label={label} top={<><span className="ur-range">{day ? dayName : `${back ? "Last" : "This"} week · ${range}`}</span><b className="ur-total">{shown === null ? "" : dur(shown)}</b></>}>
      <div className="ur">
        <div className="ur-ring">
          <svg viewBox="0 0 60 60" width="60" height="60" aria-hidden>
            <circle cx="30" cy="30" r={RING_R} className="ur-trk" />
            <circle cx="30" cy="30" r={RING_R} className="ur-arc" strokeDasharray={`${ringDash(left)} ${RING_C}`} transform="rotate(-90 30 30)" />
          </svg>
          <span className="ur-in"><b>{ringText(left)}</b><i>5-HOUR</i></span>
          <span className="ur-rs">{reset ? `resets ${reset}` : ""}</span>
        </div>
        <div className="ur-col">
          <div className="ur-bars">
            {days.map((d, i) => {
              const future = i > todayIdx && todayIdx >= 0 && !back;
              const tip = `${d.key} — ${capText(d.turns)} · ${dur(d.elapsed)}`;
              return (
                <button key={d.key} type="button" disabled={future} title={tip} aria-label={tip} aria-pressed={pick === i}
                  className={`${i === todayIdx ? "on" : ""}${pick === i ? " pick" : ""}${pick !== null && pick !== i ? " dim" : ""}`}
                  onClick={() => onPick(pick === i ? null : i)}>
                  <i style={{ height: h[i] }} /><em>{d.label}</em>
                </button>
              );
            })}
          </div>
          <div className="ur-cap">{day ? capText(day.turns) : capText(turns, sessions)}</div>
        </div>
      </div>
    </RailHero>
  );
}
