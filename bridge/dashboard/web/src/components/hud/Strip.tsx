import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { type Weather } from "../../api";
import { NotificationCenter } from "./Notifications";
import { UpdateButton } from "./UpdateButton";
import { WeekPanel } from "./WeekPanel";

/* The shell's chrome, minus the row it used to be.
 *
 * This was a 38px strip across all three columns, and every pixel of it came
 * out of the transcript. Now its ends cap the side columns — Brand over
 * SESSIONS, RightCap over the right panel — and the transcript runs to the top
 * edge, its own header the top line. The middle folded into `Strip`, split in
 * two: an instrument on the left — the clock as the one big readout, the
 * weather and Claude·FM stacked small beside it — and the actions on the
 * right, SHIP and the bell, by the gear. It used to be one right-aligned run
 * of five different treatments; splitting readouts from actions is what reads
 * as order, and the gap between the halves takes up whatever width a theme's
 * font adds or saves, so no theme moves an edge. Every text sits on a trimmed
 * box (`.trim`, index.css) so Consolas and Courier New centre like JetBrains.
 * The clock is the handle for everything that used to sit beside it: a click
 * opens the dashboard's context menu (App builds the `weather` rows — week
 * report, clock & weather settings, next station, the dashboard rows).
 *
 * Collapsed, the right column is the rail's 48px, too narrow for the cluster,
 * so App hands it to the chat header instead (Terminal's `chrome`). */

// The chat header's 40px row plus its 1px rule, so a cap's bottom line sits
// level with the header's (border-box: the border is inside the height).
const CAP_H = 41;
const CAP_LINE = "1px solid color-mix(in srgb, var(--acc) 14%, transparent)";
const CAP_IN = "enterDown .55s cubic-bezier(.2,.8,.2,1) both";

export interface StripProps {
  radio: { playing: boolean; title: string; artist: string; elapsed: string };
  onToggleRadio: () => void;
  clock: string; // "HH:MM:SS" 24h, from telemetry
  weather: Weather;
  onSetCity: (city: string) => Promise<string | null>;
  onSetUnit: (unit: string) => Promise<string | null>;
  openSettings?: number; // nonce — bump to open the clock & weather popover (from the menu)
  openReport?: number; // nonce — bump to open the week report (from the menu)
  onFeed: (texts: string[]) => void; // composer inject — a failed update hands git's error to Claude
}

// Segmented-control button style for the popover's 24H/12H and °C/°F pickers.
const seg = (on: boolean): CSSProperties => ({
  flex: 1, appearance: "none", cursor: "pointer", border: 0,
  background: on ? "color-mix(in srgb, var(--acc) 16%, transparent)" : "transparent",
  color: on ? "var(--txb)" : "var(--txd)",
  fontFamily: "inherit", fontSize: "var(--t10)", letterSpacing: "1px", padding: "7px",
});

/** Left column cap: mark + wordmark, on the SESSIONS head's own gutter, and at
 *  its end the week report — the readout the TODAY chip used to carry before
 *  the strip became these caps. Its popover hangs off this cap's left edge;
 *  the clock's menu still opens the same panel over on the right. */
export function Brand() {
  const [week, setWeek] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Closes on a press anywhere outside the cap, like the clock's popovers.
  useEffect(() => {
    if (!week) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setWeek(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [week]);

  return (
    // Relative + a stacking context above the sessions list under it, so the
    // report draws over the panel rather than behind it.
    <div ref={ref} style={{ position: "relative", zIndex: 40, flex: "none", height: CAP_H, display: "flex", alignItems: "center", gap: 9, padding: "0 12px", minWidth: 0, borderBottom: CAP_LINE, animation: CAP_IN }}>
      <svg
        viewBox="0 0 100 100"
        style={{ width: 19, height: 19, flex: "none", overflow: "visible" }}
      >
        <circle
          cx="50"
          cy="50"
          r="40"
          fill="none"
          stroke="var(--acc)"
          strokeWidth="3"
          strokeDasharray="7 11"
          style={{ transformOrigin: "50px 50px", animation: "introspin 14s linear infinite" }}
        />
        <rect
          x="30"
          y="30"
          width="40"
          height="40"
          fill="none"
          stroke="var(--acc)"
          strokeWidth="3"
          style={{ transformOrigin: "50px 50px", transform: "rotate(45deg)" }}
        />
        <rect
          x="41"
          y="41"
          width="18"
          height="18"
          fill="var(--purple)"
          style={{ transformOrigin: "50px 50px", transform: "rotate(45deg)" }}
        />
      </svg>
      <span style={{ fontSize: "var(--t12)", letterSpacing: "2.6px", color: "var(--txb)", whiteSpace: "nowrap" }}>
        MYSTICAL<span style={{ color: "var(--acc)" }}>//</span><span style={{ color: "var(--txd)" }}>ASSISTANT</span>
      </span>
      <span style={{ flex: 1, minWidth: 6 }} />
      <ReportButton on={week} onClick={() => setWeek((v) => !v)} />
      {week && <WeekPanel left />}
    </div>
  );
}

/** The bars are the report: turns, time and tokens per project. */
function ReportButton({ on, onClick }: { on: boolean; onClick: () => void }) {
  const [hover, setHover] = useState(false);
  return (
    <button
      onClick={onClick}
      aria-haspopup="dialog"
      aria-expanded={on}
      title="week report — turns, time and tokens per project"
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        appearance: "none", cursor: "pointer", border: 0, background: "transparent", padding: 0,
        flex: "none", width: 22, height: 22, display: "flex", alignItems: "center", justifyContent: "center",
        color: on ? "var(--acc)" : hover ? "var(--txb)" : "var(--txd)", transition: "color .15s ease",
      }}
    >
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
        <path d="M6 20v-6M12 20V4M18 20v-9" />
      </svg>
    </button>
  );
}

/** Right column cap: the cluster over the panel, the gear over the rail.
 *  Collapsed there are no children — the column is the rail's 48px alone. */
export function RightCap({ onOpenSettings, children }: { onOpenSettings: () => void; children?: ReactNode }) {
  const [gearHover, setGearHover] = useState(false);
  return (
    // position + z-index lift the cap's stacking context (its entry animation
    // makes one) above the panel under it, which would otherwise cover the
    // clock's popovers.
    <div className="rcap" style={{ position: "relative", zIndex: 40, display: "flex", height: CAP_H, borderBottom: CAP_LINE, animation: CAP_IN }}>
      {children && (
        <div style={{ flex: 1, minWidth: 0, display: "flex", alignItems: "center", padding: "0 12px", borderLeft: "1px solid var(--border)" }}>
          {children}
        </div>
      )}
      {/* The rail's own width, hairline and ground, so the rail reads as
          running to the top. */}
      <div style={{ width: 48, flex: "none", marginLeft: "auto", display: "flex", alignItems: "center", justifyContent: "center", borderLeft: "1px solid var(--border)", background: "var(--panel3)" }}>
        <button
          onClick={onOpenSettings}
          title="dashboard settings"
          onMouseEnter={() => setGearHover(true)}
          onMouseLeave={() => setGearHover(false)}
          style={{
            appearance: "none", cursor: "pointer", border: 0, background: "transparent",
            color: gearHover ? "var(--txb)" : "var(--txm)", fontFamily: "inherit",
            padding: 0, width: 26, height: 26,
            display: "flex", alignItems: "center", justifyContent: "center",
          }}
        >
          <svg
            viewBox="0 0 24 24"
            width="15"
            height="15"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>
    </div>
  );
}

/** SHIP, the radio, clock & weather, the bell — the old strip's middle and
 *  right, as one row that sits wherever App puts it (RightCap, or the chat
 *  header while the right panel is collapsed). */
export function Strip(props: StripProps) {
  const { radio, onToggleRadio, clock, weather, onSetCity, onSetUnit, openSettings, openReport, onFeed } = props;
  const [fmHover, setFmHover] = useState(false);
  const [clockHover, setClockHover] = useState(false);
  const [clockOpen, setClockOpen] = useState(false);
  const [weekOpen, setWeekOpen] = useState(false);
  // Kept in localStorage: the cluster remounts every time the right panel
  // folds (it moves into the chat header), and 12H must survive the move.
  const [fmt12, setFmt12] = useState(() => localStorage.getItem("hud-clock12") === "1");
  const [city, setCityInput] = useState("");
  const [cityErr, setCityErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const anchorRef = useRef<HTMLSpanElement>(null);
  // The menu's nonces as they stood at mount. Compared, not truth-tested: on a
  // remount, a nonce bumped an hour ago would reopen its popover.
  const asked = useRef({ settings: openSettings, report: openReport });

  useEffect(() => { localStorage.setItem("hud-clock12", fmt12 ? "1" : ""); }, [fmt12]);

  useEffect(() => {
    if (openSettings === asked.current.settings) return;
    asked.current.settings = openSettings;
    setCityInput(weather.loc); setCityErr(null); setWeekOpen(false); setClockOpen(true);
  }, [openSettings]);

  useEffect(() => {
    if (openReport === asked.current.report) return;
    asked.current.report = openReport;
    setClockOpen(false); setWeekOpen(true);
  }, [openReport]);

  // Either popover closes on a press anywhere outside the clock.
  useEffect(() => {
    if (!clockOpen && !weekOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!anchorRef.current?.contains(e.target as Node)) { setClockOpen(false); setWeekOpen(false); }
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [clockOpen, weekOpen]);

  async function submitCity() {
    if (!city.trim() || saving) return;
    setSaving(true);
    setCityErr(null);
    const err = await onSetCity(city.trim());
    setSaving(false);
    if (err) setCityErr(err);
  }

  const [hh = "00", mm = "00"] = clock.split(":");
  const h24 = parseInt(hh, 10) || 0;
  const clockMini = fmt12 ? `${h24 % 12 || 12}:${mm}` : `${hh}:${mm}`;
  const ampm = h24 < 12 ? "AM" : "PM";
  const wxTempStr = weather.temp === null ? "—" : `${weather.temp}°${weather.unit}`;
  // The cap reads the number alone; the popover below says which unit.
  const wxTemp = weather.temp === null ? "—" : `${weather.temp}°`;

  // The clock and the weather line beside it are one handle: a click re-fires
  // as a contextmenu under the instrument and App builds the rows. A popover
  // already open just closes — one thing under the clock at a time.
  const openMenu = (el: HTMLElement) => {
    if (clockOpen || weekOpen) { setClockOpen(false); setWeekOpen(false); return; }
    const r = (anchorRef.current ?? el).getBoundingClientRect();
    el.dispatchEvent(new MouseEvent("contextmenu", { bubbles: true, clientX: r.left, clientY: r.bottom + 8 }));
  };
  const clockHov = { onMouseEnter: () => setClockHover(true), onMouseLeave: () => setClockHover(false) };
  const bare: CSSProperties = {
    appearance: "none", cursor: "pointer", border: 0, background: "transparent", padding: 0,
    fontFamily: "inherit", display: "flex", alignItems: "center", flex: "none",
  };

  return (
    // Relative here, not on the clock: both popovers hang off the cluster's
    // right edge, which stays inside the right column (or at the chat header's
    // end) wherever the clock itself sits.
    <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flex: "1 1 auto", minWidth: 0 }}>
      <span
        ref={anchorRef}
        style={{ display: "flex", alignItems: "center", gap: 9, flex: "none" }}
        data-ctx-type="weather" data-ctx-id="weather"
        data-ctx-label={[weather.cond, weather.loc].filter(Boolean).join(" · ")}
      >
        {/* The one big readout. At t17 it outranks the chat's t14 title —
            chosen over a quieter split, 2026-09-11. */}
        <button onClick={(e) => openMenu(e.currentTarget)} aria-haspopup="menu" title="clock & weather — click for the menu" {...clockHov} style={{ ...bare, gap: 4, height: 26 }}>
          <span className="trim" style={{ fontFamily: "var(--mono)", fontSize: "var(--t17)", color: "var(--txb)", letterSpacing: ".4px" }}>
            {clockMini}
          </span>
          {fmt12 && (
            <span className="trim" style={{ fontSize: "var(--t8)", letterSpacing: "1px", color: "var(--txd)" }}>{ampm}</span>
          )}
        </button>
        {/* Two small readouts stacked beside it: the weather (the clock's
            handle again) over Claude·FM. */}
        <span style={{ display: "flex", flexDirection: "column", gap: 3 }}>
          <button
            className="wx"
            onClick={(e) => openMenu(e.currentTarget)}
            aria-haspopup="menu"
            title={`${[weather.cond, weather.loc].filter(Boolean).join(" · ") || "weather"} — click for the menu`}
            {...clockHov}
            style={{ ...bare, gap: 5, height: 13, color: "var(--txd)" }}
          >
            <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" style={{ flex: "none" }}>
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.4 1.4M17.6 17.6L19 19M19 5l-1.4 1.4M6.4 17.6L5 19" />
            </svg>
            <span className="trim" style={{ fontFamily: "var(--mono)", fontSize: "var(--t95)", color: clockHover ? "var(--txh)" : "var(--txm)" }}>{wxTemp}</span>
          </button>
          <button
            className="fm"
            onClick={onToggleRadio}
            title={`Claude·FM — ${radio.title} · ${radio.artist}${radio.playing ? ` · ${radio.elapsed}` : ""} — click to ${radio.playing ? "pause" : "play"}`}
            aria-label={radio.playing ? "Pause Claude·FM" : "Play Claude·FM"}
            aria-pressed={radio.playing}
            onMouseEnter={() => setFmHover(true)}
            onMouseLeave={() => setFmHover(false)}
            style={{
              ...bare, gap: 5, height: 13,
              color: radio.playing ? "var(--acc)" : fmHover ? "var(--txm)" : "var(--txl)",
              // Glow, not shadow: the phosphor bleeds while it plays.
              filter: radio.playing ? "drop-shadow(0 0 3px color-mix(in srgb, var(--acc) 60%, transparent))" : "none",
              transition: "color .15s ease",
            }}
          >
            {/* At rest a note, not a still spectrum — four stepped bars read as
                phone signal strength. The bars are for playing; the fixed slot
                keeps FM from shifting when they swap. */}
            <span style={{ width: 12, height: 10, flex: "none", display: "flex", alignItems: "flex-end", justifyContent: "center", gap: 1.5 }}>
              {radio.playing
                ? [0, 0.3, 0.12, 0.42].map((d, i) => (
                    <span key={i} style={{ width: 2, height: 10, background: "currentColor", transformOrigin: "bottom", animation: `eqbar ${0.72 + i * 0.13}s ease-in-out ${d}s infinite` }} />
                  ))
                : (
                  <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M9 18V5l12-2v13" />
                    <circle cx="6" cy="18" r="3" />
                    <circle cx="18" cy="16" r="3" />
                  </svg>
                )}
            </span>
            <span className="trim" style={{ fontFamily: "var(--mono)", fontSize: "var(--t8)", letterSpacing: "1.5px" }}>FM</span>
          </button>
        </span>
        {clockOpen && (
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 8px)",
              right: 0,
              zIndex: 60,
              width: "240px",
              border: "1px solid color-mix(in srgb, var(--acc) 40%, transparent)",
              background: "color-mix(in srgb, var(--panel2) 99%, transparent)",
              boxShadow: "0 16px 44px var(--shadow-pop)",
              padding: "13px",
              animation: "mslide .16s ease both",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "7px", marginBottom: "11px" }}>
              <span style={{ fontSize: "var(--t9)", letterSpacing: "2px", color: "var(--acc)" }}>CLOCK &amp; WEATHER</span>
              <span style={{ flex: 1 }}></span>
              <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t9)", color: "var(--txf)" }}>
                {weather.cond} {wxTempStr}
              </span>
            </div>
            <div style={{ fontSize: "var(--t8)", letterSpacing: "1.5px", color: "var(--txl)", marginBottom: "6px" }}>LOCATION</div>
            <input
              value={city}
              onChange={(e) => setCityInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") void submitCity(); }}
              placeholder="City"
              disabled={saving}
              style={{ width: "100%", boxSizing: "border-box", background: "color-mix(in srgb, var(--panel3) 60%, transparent)", border: `1px solid ${cityErr ? "var(--err)" : "color-mix(in srgb, var(--acc) 22%, transparent)"}`, outline: "none", color: "var(--txb)", fontFamily: "inherit", fontSize: "var(--t12)", padding: "7px 9px" }}
            />
            {cityErr && (
              <div style={{ fontSize: "var(--t85)", color: "var(--err)", marginTop: "4px" }}>{cityErr}</div>
            )}
            <div style={{ fontSize: "var(--t8)", letterSpacing: "1.5px", color: "var(--txl)", margin: "12px 0 6px" }}>TIME FORMAT</div>
            <div style={{ display: "flex", gap: "2px", border: "1px solid color-mix(in srgb, var(--acc) 18%, transparent)" }}>
              <button onClick={() => setFmt12(false)} style={seg(!fmt12)}>24H</button>
              <button onClick={() => setFmt12(true)} style={seg(fmt12)}>12H</button>
            </div>
            <div style={{ fontSize: "var(--t8)", letterSpacing: "1.5px", color: "var(--txl)", margin: "12px 0 6px" }}>UNITS</div>
            <div style={{ display: "flex", gap: "2px", border: "1px solid color-mix(in srgb, var(--acc) 18%, transparent)" }}>
              <button onClick={() => void onSetUnit("celsius")} style={seg(weather.unit === "C")}>°C</button>
              <button onClick={() => void onSetUnit("fahrenheit")} style={seg(weather.unit === "F")}>°F</button>
            </div>
          </div>
        )}
        {weekOpen && <WeekPanel />}
      </span>

      {/* The actions, by the gear: SHIP and the bell. */}
      <span style={{ display: "flex", alignItems: "center", gap: 12, flex: "none" }}>
        <UpdateButton onFeed={onFeed} />
        <NotificationCenter />
      </span>
    </div>
  );
}
