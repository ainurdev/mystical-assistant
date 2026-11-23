// HOME, the right rail's first tab (/design-first right-rail-home, G2 · SIGIL
// over the spine). While it is open the column's cap merges into it: the cap
// hides its clock and weather and holds the top of this sky (RightCap's
// `sky`, a HomeSky), and the time, the date and the weather are drawn here,
// big. The sky is the theme's (/design-first home-theme, A · THEME SKY). Under
// the sky, today's wins (bridge/wins.py) run down a spine: one time column,
// even rows, the line in the project's colour, dashed where you were away.
// Not shown, by the user's cuts over six rounds: anything another tab or the
// chat already says (the running turn, session states, git state, meters).
import { useState, type CSSProperties } from "react";
import { Cloud } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import type { TodayWins, Weather } from "../../api";
import { rail } from "../../lib/queries";
import { HOME_TOP, dur, spine, type Sky } from "../../lib/home";
import { projectName, projectTint, useClock12 } from "../../lib/surfaces";
import { WX_ICON } from "./Almanac";
import { CAP_H } from "./Strip";

// x, y from the column's top edge (the cap's top), glyph, size, opacity.
const RUNES: [number, number, string, number, number][] = [
  [150, 22, "✦", 13, .55], [204, 168, "◈", 15, .35], [36, 186, "✧", 12, .45], [254, 212, "⟁", 14, .3],
  [122, 206, "◇", 11, .35], [236, 120, "✦", 9, .6], [96, 14, "⌖", 12, .3],
];

/** HOME's sky: the theme's accent over its own ground, lit where the hour's sun
 *  stands, Mystical's emblem large and faint behind the time, a few runes. One
 *  picture held twice, each holder clipping its share: the cap the top CAP_H px
 *  (RightCap's `sky`), HOME's top the rest, so the emblem crosses the seam whole.
 *  `top` is how far down the column its holder starts. */
export function HomeSky({ sky, top }: { sky: Sky; top: number }) {
  // Both copies turn and twinkle on the wall clock, so their halves meet at the seam whichever mounted first.
  const [t0] = useState(() => Date.now() / 1000);
  const style = { top: -top, height: CAP_H + HOME_TOP, "--hx": `${sky.x}%`, "--hy": `${sky.y}%`, "--hw": `${sky.w}px`, "--hh": `${sky.h}px`,
    "--ha": `${sky.a}%`, "--l1": sky.l1, "--c1": sky.c1, "--l2": sky.l2, "--c2": sky.c2 } as CSSProperties;
  return (
    <div className="home-sky" style={style} aria-hidden>
      <svg className="home-emblem" width="230" height="230" viewBox="0 0 160 160">
        <g className="ring" style={{ animationDelay: `${-(t0 % 40)}s` }}><circle cx="80" cy="80" r="70" strokeWidth="1.2" strokeDasharray="4 7" /></g>
        <circle cx="80" cy="80" r="56" strokeWidth=".8" opacity=".6" />
        <rect x="52" y="52" width="56" height="56" transform="rotate(45 80 80)" strokeWidth="1.6" />
        <rect className="core" x="69" y="69" width="22" height="22" transform="rotate(45 80 80)" opacity=".5" />
      </svg>
      {RUNES.map(([x, y, g, size, o], i) => (
        <span key={i} className="home-rune" style={{ left: x, top: y, fontSize: size, opacity: o, animationDelay: `${i * .4 - (t0 % 3.2)}s` }}>{g}</span>
      ))}
    </div>
  );
}

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
  // shortcut: re-read once a minute while HOME is open (lib/queries); a push from the turn's end when a minute ever feels slow.
  const winsQ = useQuery(rail.wins());
  const day: TodayWins | null = winsQ.data ?? null;
  const err = winsQ.error?.message ?? null;

  const [hh = "00", mm = "00"] = clock.split(":");
  const h = parseInt(hh, 10) || 0;
  const time = h12 ? `${h % 12 || 12}:${mm}` : `${hh}:${mm}`;
  const date = new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" });
  // "rain · 11° · Yerevan": the condition in lower case, the city title-cased, as the cap's date window reads.
  const city = (weather.loc || "").split(",")[0].trim().toLowerCase().replace(/\b\p{L}/gu, (c) => c.toUpperCase());
  const wx = weather.available
    ? [weather.cond.toLowerCase(), weather.temp === null ? "" : `${weather.temp}°`, city].filter((s) => s && s !== "—").join(" · ")
    : "";
  const Wx = WX_ICON.find(([re]) => re.test(weather.cond))?.[1] ?? Cloud;

  const rows = day ? spine(day) : [];
  const lastWin = rows.map((r) => r.kind).lastIndexOf("win");
  const projects = day ? [...new Set(day.wins.map((w) => w.project))] : [];
  const tint = (p: string) => projectTint(p).color;

  return (
    <div className="home flex min-h-0 flex-1 flex-col">
      <div className="home-top">
        <HomeSky sky={sky} top={CAP_H} />
        <button type="button" className="home-clock" data-ctx-type="surface"
          title="the Almanac: calendar, weather, limit resets, world clocks" onClick={onClock}>
          <span className="home-time">{time}</span>
          <span className="home-date">{date}</span>
          {wx && <span className="home-wx"><Wx size={13} strokeWidth={2} aria-hidden />{wx}</span>}
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
          <div className="home-none">Nothing shipped yet today<small>the day is unwritten — what shall we ship?</small>
            {!!day.yesterday?.wins && (
              <span className="home-yday">yesterday · <b>{day.yesterday.wins}</b> {day.yesterday.wins === 1 ? "win" : "wins"}{day.yesterday.worked >= 60 ? ` · ${dur(day.yesterday.worked)}` : ""}</span>
            )}</div>
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
