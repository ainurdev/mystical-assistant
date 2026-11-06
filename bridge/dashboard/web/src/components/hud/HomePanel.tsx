// HOME, the right rail's first tab (/design-first right-rail-home, G2 · SIGIL
// over the spine). While it is open the column's cap merges into it: the cap
// hides its clock and weather and wears the top of this sky (RightCap's
// `sky`), and the time, the date and the weather are drawn here, big. Under
// the sky, today's wins (bridge/wins.py) run down a spine: one time column,
// even rows, the line in the project's colour, dashed where you were away.
// Not shown, by the user's cuts over six rounds: anything another tab or the
// chat already says (the running turn, session states, git state, meters).
import { useEffect, useState, type CSSProperties } from "react";
import { api, type TodayWins, type Weather } from "../../api";
import { HOME_TOP, dur, spine, type Sky } from "../../lib/home";
import { projectName, projectTint, useClock12 } from "../../lib/surfaces";
import { CAP_H } from "./Strip";

const RUNES: [number, number, string, number, number][] = [
  [150, -18, "✦", 13, .55], [204, 128, "◈", 15, .35], [36, 146, "✧", 12, .45], [254, 166, "⟁", 14, .3],
  [122, 160, "◇", 11, .35], [236, 80, "✦", 9, .6], [96, -26, "⌖", 12, .3],
];

const clockOf = (ts: number, h12: boolean) => {
  const d = new Date(ts * 1000), m = String(d.getMinutes()).padStart(2, "0");
  return h12 ? `${d.getHours() % 12 || 12}:${m}` : `${String(d.getHours()).padStart(2, "0")}:${m}`;
};

export function HomePanel({ clock, weather, sky, onClock, onOpen }: {
  clock: string; // "HH:MM:SS", the telemetry tick
  weather: Weather;
  sky: Sky;
  onClock: () => void; // the big clock opens the cap's Almanac
  onOpen: (session: string) => void;
}) {
  const h12 = useClock12();
  const [day, setDay] = useState<TodayWins | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    const load = () => api.wins()
      .then((d) => { if (live) { setDay(d); setErr(null); } })
      .catch((e: Error) => { if (live) setErr(e.message); });
    void load();
    // shortcut: re-read once a minute while HOME is open; a push from the turn's end when a minute ever feels slow.
    const id = setInterval(load, 60_000);
    return () => { live = false; clearInterval(id); };
  }, []);

  const [hh = "00", mm = "00"] = clock.split(":");
  const h = parseInt(hh, 10) || 0;
  const time = h12 ? `${h % 12 || 12}:${mm}` : `${hh}:${mm}`;
  const date = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  // "rain · 11° · Yerevan": the condition in lower case, the city title-cased, as the cap's date window reads.
  const city = (weather.loc || "").split(",")[0].trim().toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  const wx = weather.available
    ? [weather.cond.toLowerCase(), weather.temp === null ? "" : `${weather.temp}°`, city].filter((s) => s && s !== "—").join(" · ")
    : "";

  const rows = day ? spine(day) : [];
  const lastWin = rows.map((r) => r.kind).lastIndexOf("win");
  const projects = day ? [...new Set(day.wins.map((w) => w.project))] : [];
  const tint = (p: string) => projectTint(p).color;

  return (
    <div className="home flex min-h-0 flex-1 flex-col">
      {/* Longhands only: a `background` shorthand would reset the size and offset that line this up with the cap. */}
      <div className="home-top" style={{ backgroundImage: sky.bg, backgroundSize: `100% ${CAP_H + HOME_TOP}px`, backgroundPosition: `0 -${CAP_H}px`, backgroundRepeat: "no-repeat" }}>
        <svg className="home-emblem" width="250" height="250" viewBox="0 0 160 160" aria-hidden>
          <g className="ring"><circle cx="80" cy="80" r="70" fill="none" stroke={sky.ink} strokeWidth="1.2" strokeDasharray="4 7" /></g>
          <circle cx="80" cy="80" r="56" fill="none" stroke={sky.ink} strokeWidth=".8" opacity=".6" />
          <rect x="52" y="52" width="56" height="56" transform="rotate(45 80 80)" fill="none" stroke={sky.ink} strokeWidth="1.6" />
          <rect x="69" y="69" width="22" height="22" transform="rotate(45 80 80)" fill={sky.ink} opacity=".5" />
        </svg>
        {RUNES.map(([x, y, g, size, o], i) => (
          <span key={i} className="home-rune" aria-hidden
            style={{ left: x, top: y, fontSize: size, opacity: o, color: sky.rune, animationDelay: `${i * .4}s` }}>{g}</span>
        ))}
        <button type="button" className="home-clock" data-ctx-type="surface"
          title="the Almanac: calendar, weather, limit resets, world clocks" onClick={onClock}>
          <span className="home-time">{time}</span>
          <span className="home-date">{date}</span>
          {wx && <span className="home-wx">{wx}</span>}
        </button>
      </div>

      <div className="home-work mscroll">
        <div className="home-head">
          <span className="lab">TODAY'S WORK</span>
          {day && day.wins.length > 0 && (
            <span className="r"><b>{day.wins.length}</b> {day.wins.length === 1 ? "win" : "wins"}{day.worked >= 60 ? ` · ${dur(day.worked)}` : ""}</span>
          )}
        </div>
        {err ? (
          <div className="home-none">{err.startsWith("HTTP 404")
            ? <>Today's wins need a newer bridge<small>restart the bridge (⟳ on the rail) and they appear here</small></>
            : <>Couldn't read today's wins<small>{err}</small></>}</div>
        ) : !day ? (
          <div className="home-none" style={{ color: "var(--txl)" }}>reading the day…</div>
        ) : day.wins.length === 0 ? (
          <div className="home-none">Nothing shipped yet today<small>the day is unwritten — what shall we ship?</small></div>
        ) : (
          <>
            <div className="home-legend">
              {projects.map((p) => <span key={p}><i style={{ background: tint(p) }} />{projectName(p)}</span>)}
            </div>
            <div className="home-spine">
              <div className="home-row home-now"><span>NOW</span>
                <span className="mid" style={{ "--c": tint(day.wins[0].project) } as CSSProperties}><span className="dot" /></span><span /></div>
              {rows.map((r, i) => r.kind === "away" ? (
                <div key={`a${i}`} className="home-row home-away"><span /><span className="mid" /><span>{r.text}</span></div>
              ) : (
                <button key={`${r.win.turn}${r.win.kind}${r.win.ts}`} type="button" className={`home-row${i === lastWin ? " last" : ""}`}
                  onClick={() => onOpen(r.win.session)} title={`${projectName(r.win.project)} — open its session`}>
                  <time>{clockOf(r.win.ts, h12)}</time>
                  <span className="mid" style={{ "--c": tint(r.win.project), "--p": tint(r.win.project) } as CSSProperties}>
                    <span className={`dot${r.win.big ? " big" : ""}`} />
                  </span>
                  <span className="x"><b>{r.verb}</b>{r.rest && ` ${r.rest}`}{r.aside && <small> · {r.aside}</small>}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
