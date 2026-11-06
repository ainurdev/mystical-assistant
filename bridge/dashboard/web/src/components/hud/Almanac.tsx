import { Fragment, useEffect, useState } from "react";
import {
  ChevronDown, ChevronLeft, ChevronRight, ChevronUp, Cloud, CloudDrizzle, CloudFog, CloudLightning, CloudRain,
  CloudSnow, CloudSun, Droplet, Settings, Sun, Wind, type LucideIcon,
} from "lucide-react";
import type { AccountInfo, Weather } from "../../api";
import {
  atWork, dayKey, fmtOffset, isoWeek, monthGrid, placeName, resetDays, resetEvents, shortLogin, sunArc, whenLabel,
  workBand, zoneCity, zoneMinutes, zoneTime,
} from "../../lib/almanac";
import { openSettings } from "../../lib/opensettings";
import type { WorldClock } from "../../lib/theme";

/* The Almanac: the Clock's drop-down (GLOSSARY.md), drawn as picked on
 * 2026-11-06 (.mystical/design-drafts/almanac/SPEC.md): the month on the left
 * over the world clocks, the weather and the limit resets on the right.
 *
 * The month (C1 · TILES) is a month to look at, not a planner: today a lit
 * tile, each login's weekly reset a dot in that login's colour. Its title zooms
 * out to the year's twelve months; TODAY shows once you've left this month; the
 * keys walk it (←→ a day, ↑↓ a week, PgUp/PgDn a month, T today, Esc the year
 * view and then the Almanac). It keeps one height in every state, so nothing
 * under it jumps. World clocks (W1 · OVERLAP) lay each city's 09–18 on your own
 * 24 hours. Weather (X1 · SUN ARC) draws the day as the sun's path. Limit
 * resets (L2 · NEXT UP) list every login's resets, soonest first.
 *
 * It unmounts on close, so it always reopens on this month. */

// A login keeps one colour everywhere in here: its calendar dots, the legend, its resets.
// The theme's own tones, so a light or CRT theme recolours them.
// shortcut: a fifth login reuses the first colour; add colours if anyone runs five.
const LOGIN_COLORS = ["var(--info)", "var(--purple)", "var(--ok)", "var(--warn)"];
const DOW = ["M", "T", "W", "T", "F", "S", "S"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// open-meteo's WMO labels (bridge/weather.py _CODES) by the word that decides the icon.
export const WX_ICON: [RegExp, LucideIcon][] = [
  [/THUNDER|HAIL/, CloudLightning], [/SNOW/, CloudSnow], [/DRIZZLE/, CloudDrizzle], [/RAIN|SHOWER/, CloudRain],
  [/FOG/, CloudFog], [/PARTLY|MAINLY/, CloudSun], [/OVERCAST/, Cloud], [/CLEAR/, Sun],
];

export function Almanac({ weather, accounts, clocks, h12, onClose }: {
  weather: Weather;
  accounts: AccountInfo[];
  clocks: WorldClock[];
  h12: boolean;
  onClose: () => void;
}) {
  const now = new Date();
  const here = { y: now.getFullYear(), m: now.getMonth() };
  const [view, setView] = useState(here);
  const [years, setYears] = useState(false); // the title zoomed out to the year's months
  const [focus, setFocus] = useState<Date | null>(null); // the day the keys walk, once a key is pressed
  const away = view.y !== here.y || view.m !== here.m;
  const show = (d: Date) => setView({ y: d.getFullYear(), m: d.getMonth() });
  const step = (n: number) => (years ? setView((v) => ({ ...v, y: v.y + n })) : show(new Date(view.y, view.m + n, 1)));
  const toToday = () => { setView(here); setYears(false); setFocus(null); };

  // The keys, while it's open (Strip closes it on a press outside, this on Esc).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;   // ⌥↑/⌥↓ and friends are App's
      if ((e.target as HTMLElement | null)?.closest?.("input, textarea, [contenteditable='true']")) return;
      const by = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<string, number>)[e.key];
      if (by !== undefined || e.key === "PageUp" || e.key === "PageDown") {
        e.preventDefault();
        const from = focus ?? (away ? new Date(view.y, view.m, 1) : new Date());
        const m = from.getMonth() + (e.key === "PageUp" ? -1 : e.key === "PageDown" ? 1 : 0);
        // A month on, the 31st lands on the new month's last day rather than spilling into the next.
        const next = by !== undefined ? new Date(from.getFullYear(), from.getMonth(), from.getDate() + by)
          : new Date(from.getFullYear(), m, Math.min(from.getDate(), new Date(from.getFullYear(), m + 1, 0).getDate()));
        setYears(false);
        setFocus(next);
        show(next);
      } else if (e.key === "t" || e.key === "T") {
        e.preventDefault();
        toToday();
      } else if (e.key === "Escape") {
        if (years) setYears(false);
        else onClose();
      } else return;
      // On document, before App's window listeners: an Esc here shuts this, not the overlay under it.
      e.stopPropagation();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const today = dayKey(now);
  const focused = focus && dayKey(focus);
  const marks = resetDays(accounts);
  const logins = accounts.filter((a) => !a.disabled);
  const colorOf = (slot: number) => LOGIN_COLORS[Math.max(0, logins.findIndex((a) => a.slot === slot)) % LOGIN_COLORS.length];
  const nameOf = (slot: number) => { const a = logins.find((x) => x.slot === slot); return a ? shortLogin(a) : `account ${slot}`; };
  const toSettings = () => { onClose(); openSettings("clock"); };
  const title = years ? String(view.y) : new Date(view.y, view.m, 1).toLocaleDateString("en-GB", { month: "long", year: "numeric" });

  return (
    <div className="alm" role="dialog" aria-label="Almanac">
      <div className="alm-top">
        <span className="alm-k caps">Almanac</span>
        <span className="alm-date">
          {now.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}
          <span> · week {isoWeek(now)}</span>
        </span>
        <button className="alm-ib" title="Clock & weather settings" aria-label="Clock and weather settings" onClick={toSettings}>
          <Settings size={14} strokeWidth={1.7} aria-hidden />
        </button>
      </div>

      <div className="alm-body">
        <div className="alm-col">
          <section className="alm-cal" aria-label={title}>
            <div className="alm-nav">
              <button className="alm-title" data-open={years || undefined} aria-expanded={years} aria-live="polite"
                title={years ? "Back to the month" : "Pick a month or a year"} onClick={() => setYears((y) => !y)}>
                {title}
                {years ? <ChevronUp size={13} strokeWidth={2.4} aria-hidden /> : <ChevronDown size={13} strokeWidth={2.4} aria-hidden />}
              </button>
              <span className="alm-sp" />
              {away && <button className="alm-today caps" onClick={toToday} title="Back to today (T)">Today</button>}
              <button className="alm-ib" aria-label={years ? "Previous year" : "Previous month"} onClick={() => step(-1)}><ChevronLeft size={16} strokeWidth={2.2} aria-hidden /></button>
              <button className="alm-ib" aria-label={years ? "Next year" : "Next month"} onClick={() => step(1)}><ChevronRight size={16} strokeWidth={2.2} aria-hidden /></button>
            </div>

            {/* The year's months lie over the month grid, which stays laid out under them,
                so the box is the same height in both at any type size. */}
            <div className="alm-stage">
              <div className="alm-grid" data-hide={years || undefined} aria-hidden={years || undefined}>
                <span className="alm-h alm-wk caps" title="ISO week">wk</span>
                {DOW.map((d, i) => <span key={i} className="alm-h" data-we={i > 4 || undefined}>{d}</span>)}
                {monthGrid(view.y, view.m).map((w) => (
                  <Fragment key={dayKey(w.days[0])}>
                    <span className="alm-wk">{w.week}</span>
                    {w.days.map((d, i) => {
                      const k = dayKey(d);
                      const who = marks[k];
                      return (
                        <span key={k} className="alm-d" data-out={d.getMonth() !== view.m || undefined}
                          data-today={k === today || undefined} data-focus={k === focused || undefined} data-we={i > 4 || undefined}
                          title={who ? `Weekly limit resets: ${who.map(nameOf).join(", ")}` : undefined}>
                          {d.getDate()}
                          {who && <Dots slots={who} colorOf={colorOf} />}
                        </span>
                      );
                    })}
                  </Fragment>
                ))}
              </div>
              {years && (
                <div className="alm-months">
                  {MONTHS.map((m, i) => {
                    const key = `${view.y}-${String(i + 1).padStart(2, "0")}`;
                    const slots = [...new Set(Object.entries(marks).filter(([k]) => k.startsWith(key)).flatMap(([, s]) => s))];
                    return (
                      <button key={m} data-cur={(view.y === here.y && i === here.m) || undefined}
                        onClick={() => { setView({ y: view.y, m: i }); setYears(false); }}>
                        {m}
                        <Dots slots={slots} colorOf={colorOf} />
                      </button>
                    );
                  })}
                </div>
              )}
            </div>

            {/* One footer line, one height: the legend, or the keys once you use them, or the year view's how-to. */}
            <div className="alm-foot">
              {years ? <>Pick a month · <kbd>‹</kbd><kbd>›</kbd> step a year · <kbd>Esc</kbd> back</>
                : focus ? <><kbd>←→↑↓</kbd> days <kbd>PgUp</kbd><kbd>PgDn</kbd> months <kbd>T</kbd> today</>
                : <>{logins.map((a) => <span key={a.slot} title={a.email ?? undefined}><i style={{ background: colorOf(a.slot) }} />{shortLogin(a)}</span>)}<em>weekly resets</em></>}
            </div>
          </section>

          <WorldClocks clocks={clocks} h12={h12} at={now.getTime()} onSettings={toSettings} />
        </div>

        <div className="alm-col alm-side">
          <WeatherArc weather={weather} at={now.getTime()} />
          <NextResets accounts={accounts} at={now.getTime()} h12={h12} colorOf={colorOf} nameOf={nameOf} />
        </div>
      </div>
    </div>
  );
}

/** Each login whose weekly window resets in a day (or a month), as a dot in its colour. */
function Dots({ slots, colorOf }: { slots: number[]; colorOf: (slot: number) => string }) {
  return slots.length ? <i className="alm-dots" aria-hidden>{slots.map((s) => <b key={s} style={{ background: colorOf(s) }} />)}</i> : null;
}

/** W1 · OVERLAP: you, then each world clock, with its 09–18 laid on your own day and a tick at now. */
function WorldClocks({ clocks, h12, at, onSettings }: { clocks: WorldClock[]; h12: boolean; at: number; onSettings: () => void }) {
  if (!clocks.length) {
    return (
      <section className="alm-sec">
        <h4 className="caps">World clocks</h4>
        <button className="alm-add" onClick={onSettings}>Pick up to two in SETTINGS ›</button>
      </section>
    );
  }
  const nowAt = (zoneMinutes(undefined, at) / 1440) * 100;
  const home = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const rows = [{ zone: home, you: true }, ...clocks.map((c) => ({ zone: c.zone, you: false }))];
  const working = clocks.filter((c) => atWork(c.zone, at)).map((c) => zoneCity(c.zone));
  return (
    <section className="alm-sec alm-clocks">
      <h4 className="caps">World clocks <span>· their 9–18 on your day</span></h4>
      {rows.map(({ zone, you }) => {
        const t = zoneTime(zone, at, h12);
        return (
          <div key={you ? "you" : zone} className="alm-zone">
            <div className="alm-zrow">
              <span className="alm-city">{zoneCity(zone)}{you && <em> · you</em>}</span>
              <b>{t.time}{t.ampm && <small> {t.ampm}</small>}</b>
              <span className="alm-off">{you ? "" : fmtOffset(t.offset)}{t.shift ? (t.shift > 0 ? " +1d" : " −1d") : ""}</span>
            </div>
            <div className="alm-band" data-you={you || undefined} aria-hidden>
              {workBand(you ? 0 : t.offset).map(([from, to]) => <i key={from} style={{ left: `${(from / 24) * 100}%`, width: `${((to - from) / 24) * 100}%` }} />)}
              <b style={{ left: `${nowAt}%` }} />
            </div>
          </div>
        );
      })}
      <div className="alm-axis" aria-hidden><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
      <div className="alm-note">{working.length ? <>At work now: <b>{working.join(", ")}</b></> : "Nobody's at work there now"}</div>
    </section>
  );
}

/** X1 · SUN ARC: the temperature big, and the day as the sun's path from sunrise to sunset,
 *  on the weather place's own clock (its `tz`; this browser's on an older bridge). */
function WeatherArc({ weather, at }: { weather: Weather; at: number }) {
  const city = placeName(weather.loc).split(",")[0];
  const head = <h4 className="caps">Weather{city && <span> · {city}</span>}</h4>;
  if (!weather.available) return <section className="alm-sec">{head}<div className="alm-note">offline</div></section>;
  const Icon = WX_ICON.find(([re]) => re.test(weather.cond))?.[1] ?? Cloud;
  const cond = weather.cond.charAt(0) + weather.cond.slice(1).toLowerCase();
  const placeNow = () => { try { return zoneMinutes(weather.tz ?? undefined, at); } catch { return zoneMinutes(undefined, at); } };
  const arc = weather.sunrise && weather.sunset ? sunArc(weather.sunrise, weather.sunset, placeNow()) : null;
  // The path is half an ellipse over a 234×70 box; the sun rides it, the moon waits past whichever end.
  const sx = 117 - 98 * Math.cos(Math.PI * (arc?.f ?? 0)), sy = 60 - 50 * Math.sin(Math.PI * (arc?.f ?? 0));
  return (
    <section className="alm-sec alm-wx">
      {head}
      <div className="alm-wxtop">
        <span className="alm-temp">{weather.temp}°</span>
        <span className="alm-cond">{cond}{weather.hi !== null && <span>↑{weather.hi}°  ↓{weather.lo}°</span>}</span>
        <Icon size={22} strokeWidth={1.6} aria-hidden className="alm-wxic" />
      </div>
      {arc && (
        <>
          <svg className="alm-arc" viewBox="0 0 234 70" aria-hidden>
            <path d="M19 60 A 98 50 0 0 1 215 60 Z" className="alm-arc-fill" />
            <line x1="4" y1="60" x2="230" y2="60" className="alm-arc-ground" />
            <path d="M19 60 A 98 50 0 0 1 215 60" className="alm-arc-path" />
            {arc.up ? <><circle cx={sx} cy={sy} r="10" className="alm-halo" /><circle cx={sx} cy={sy} r="5" className="alm-sun" /></>
              : <path transform={`translate(${arc.f ? 226 : 8} 50)`} d="M1-4a4 4 0 1 0 3 7 5.5 5.5 0 1 1-3-7z" className="alm-moon" />}
          </svg>
          <div className="alm-ends"><span>↑ {weather.sunrise}</span><span>{weather.sunset} ↓</span></div>
          <div className="alm-note"><b>{arc.daylight}</b> of daylight · {arc.caption}</div>
        </>
      )}
      <div className="alm-chips">
        <span><Wind size={12} strokeWidth={2} aria-hidden /> {weather.wind}</span>
        <span><Droplet size={12} strokeWidth={2} aria-hidden /> {weather.hum} humidity</span>
      </div>
    </section>
  );
}

/** L2 · NEXT UP: every reset across the logins, soonest first; idle 5-hour windows fold into one line. */
function NextResets({ accounts, at, h12, colorOf, nameOf }: {
  accounts: AccountInfo[]; at: number; h12: boolean; colorOf: (slot: number) => string; nameOf: (slot: number) => string;
}) {
  const { events, ready, out, blind } = resetEvents(accounts, at);
  const email = (slot: number) => accounts.find((a) => a.slot === slot)?.email ?? undefined;
  return (
    <section className="alm-sec alm-resets">
      <h4 className="caps">Limit resets <span>· soonest first</span></h4>
      {events.map((e) => (
        <div key={`${e.slot}-${e.kind}`} className="alm-ev" title={email(e.slot)}>
          <span className="alm-when" data-soon={e.at - at < 86_400_000 || undefined}>{whenLabel(e.at, at, h12)}</span>
          <i style={{ background: colorOf(e.slot) }} />
          <span className="alm-what">{nameOf(e.slot)} <em>· {e.kind}</em></span>
        </div>
      ))}
      {ready.length > 0 && <div className="alm-ready">5-hour ready <span>· {ready.map(nameOf).join(", ")}</span></div>}
      {out.length > 0 && <div className="alm-note">signed out · {out.map(nameOf).join(", ")}</div>}
      {blind.length > 0 && <div className="alm-note">no reading · {blind.map(nameOf).join(", ")}</div>}
    </section>
  );
}
