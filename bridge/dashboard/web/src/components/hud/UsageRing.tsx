import type { Window } from "../../models";
import { barHeights, ringDash, ringText, RING_C, RING_R } from "../../lib/usagering";
import { dur } from "../../lib/week";
import { hhmm } from "../../lib/surfaces";
import { RailHero } from "./RailHero";

/* The Usage tab's hero: the open login's 5-hour window as a ring (what the
   composer's PROFILE chip reads, `left` and the refill time), and the week's
   agent time as seven day bars, today lit. Amber is the window, accent the days.
   No reading for the login: the ring says "—" at the same size. */
export function UsageRing({ win, range, back, elapsed, days, todayIdx }: {
  win: Window | null; range: string; back: boolean;
  /** the week's agent time, seconds; null while it loads */
  elapsed: number | null;
  days: { label: string; elapsed: number }[]; todayIdx: number;
}) {
  const left = win ? win.left : null;
  const h = barHeights(days.map((d) => d.elapsed), 44);
  const reset = win?.resets_at ? hhmm(Date.parse(win.resets_at) / 1000) : "";
  const label = `${back ? "Last" : "This"} week ${elapsed === null ? "loading" : `${dur(elapsed)} of agent time`}. 5-hour window ${
    left === null ? "not read" : `${left}% left${reset ? `, resets ${reset}` : ""}`}`;
  return (
    <RailHero label={label} top={<><span className="ur-range">{back ? "Last" : "This"} week · {range}</span><b className="ur-total">{elapsed === null ? "" : dur(elapsed)}</b></>}>
      <div className="ur">
        <div className="ur-ring">
          <svg viewBox="0 0 60 60" width="60" height="60" aria-hidden>
            <circle cx="30" cy="30" r={RING_R} className="ur-trk" />
            <circle cx="30" cy="30" r={RING_R} className="ur-arc" strokeDasharray={`${ringDash(left)} ${RING_C}`} transform="rotate(-90 30 30)" />
          </svg>
          <span className="ur-in"><b>{ringText(left)}</b><i>5-HOUR</i></span>
          <span className="ur-rs">{reset ? `resets ${reset}` : ""}</span>
        </div>
        <div className="ur-bars" aria-hidden>
          {days.map((d, i) => (
            <span key={i} className={i === todayIdx ? "on" : ""}><i style={{ height: h[i] }} /><em>{d.label}</em></span>
          ))}
        </div>
      </div>
    </RailHero>
  );
}
