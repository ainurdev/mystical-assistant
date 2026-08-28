import { useEffect, useState, type CSSProperties, type ReactNode } from "react";
import { type Weather } from "../../api";
import { hairline, shellCols, zoneRule } from "../../lib/shell";
import { NotificationCenter } from "./Notifications";
import { UpdateButton } from "./UpdateButton";
import { WeekPanel } from "./WeekPanel";

export interface StripProps {
  radio: { playing: boolean; title: string; artist: string; elapsed: string };
  onToggleRadio: () => void;
  onNextRadio: () => void;
  onOpenSettings: () => void;
  clock: string; // "HH:MM:SS" 24h, from telemetry
  weather: Weather;
  onSetCity: (city: string) => Promise<string | null>;
  onSetUnit: (unit: string) => Promise<string | null>;
  openSettings?: number; // nonce — bump to open the clock & weather popover (from the context menu)
  onFeed: (texts: string[]) => void; // composer inject — a failed update hands git's error to Claude
  rightOpen: boolean; // right panel expanded — the shell tracks (and zone layout) follow it
}

// Segmented-control button style for the popover's 24H/12H and °C/°F pickers.
const seg = (on: boolean): CSSProperties => ({
  flex: 1, appearance: "none", cursor: "pointer", border: 0,
  background: on ? "color-mix(in srgb, var(--acc) 16%, transparent)" : "transparent",
  color: on ? "var(--txb)" : "var(--txd)",
  fontFamily: "inherit", fontSize: "var(--t10)", letterSpacing: "1px", padding: "7px",
});

export function Strip(props: StripProps) {
  const { radio, onToggleRadio, onNextRadio, onOpenSettings, clock, weather, onSetCity, onSetUnit, openSettings, onFeed, rightOpen } = props;
  const [nextHover, setNextHover] = useState(false);
  const [gearHover, setGearHover] = useState(false);
  const [clockHover, setClockHover] = useState(false);
  const [clockOpen, setClockOpen] = useState(false);
  const [fmt12, setFmt12] = useState(false);
  const [city, setCityInput] = useState("");
  const [cityErr, setCityErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The context menu opens the popover by bumping `openSettings`.
  useEffect(() => {
    if (openSettings) { setCityInput(""); setCityErr(null); setClockOpen(true); }
  }, [openSettings]);

  function togglePopover() {
    if (!clockOpen) { setCityInput(weather.loc); setCityErr(null); }
    setClockOpen(!clockOpen);
  }

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

  const gear = (
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
  );

  // 48px rail cell — the gear, nothing else. Carries the zone rule on its left
  // edge (a track boundary in both the open and the collapsed layout).
  const rail: ReactNode = (
    <div style={{ position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <span aria-hidden style={zoneRule} />
      {gear}
    </div>
  );

  return (
    <div
      style={{
        // position + z-index lift the strip's stacking context above the main
        // grid: the `enterDown` fill-mode:both animation leaves the strip a
        // stacking context, which otherwise traps the clock/weather popover
        // (z 60) below the panels that follow it in the DOM.
        position: "relative",
        zIndex: 40,
        flex: "none",
        display: "grid",
        gridTemplateColumns: shellCols(rightOpen),
        height: 38,
        borderBottom: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)",
        animation: "enterDown .55s cubic-bezier(.2,.8,.2,1) both",
      }}
    >
      {/* L — mark + wordmark, on the SESSIONS head's own gutter. */}
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "0 12px", minWidth: 0 }}>
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
      </div>

      {/* C — TODAY ledger left, radio + clock right, on the Terminal head's gutter. */}
      <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 11, padding: "0 14px", minWidth: 0 }}>
        <span aria-hidden style={zoneRule} />
        <WeekPanel />
        <span style={{ flex: 1, minWidth: 14 }} />
        {/* One line: transport, alive-signal, track. Elapsed moved to the
            tooltip — it cost a second line, and a second line set the whole
            strip's height. */}
        <div
          title={`Claude FM — ${radio.elapsed} elapsed`}
          style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, maxWidth: 250 }}
        >
          <button
            onClick={onToggleRadio}
            title={radio.playing ? "pause" : "play"}
            style={{
              appearance: "none",
              cursor: "pointer",
              border: 0,
              background: "transparent",
              color: "var(--acc)",
              fontFamily: "inherit",
              padding: 0,
              display: "flex",
              alignItems: "center",
              flex: "none",
              lineHeight: 0,
            }}
          >
            {radio.playing ? (
              <svg viewBox="0 0 12 12" width="12" height="12" fill="currentColor">
                <rect x="2.6" y="2.3" width="2.5" height="7.4" />
                <rect x="6.9" y="2.3" width="2.5" height="7.4" />
              </svg>
            ) : (
              <svg viewBox="0 0 12 12" width="12" height="12" fill="currentColor">
                <path d="M3 2 L10 6 L3 10 Z" />
              </svg>
            )}
          </button>
          {radio.playing && (
            <span style={{ display: "inline-flex", alignItems: "flex-end", gap: "1.5px", height: "8px", flex: "none" }}>
              {[0, 0.18, 0.36].map((d) => (
                <span
                  key={d}
                  style={{
                    width: "2px",
                    height: "8px",
                    background: "var(--ok)",
                    transformOrigin: "bottom",
                    animation: `eqbar .8s ease-in-out infinite ${d}s`,
                  }}
                />
              ))}
            </span>
          )}
          <div
            style={{
              fontSize: "var(--t105)",
              color: "var(--txm)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              lineHeight: 1.3,
              flex: 1,
              minWidth: 0,
            }}
          >
            {radio.title} <span style={{ color: "var(--txf)" }}>· {radio.artist}</span>
          </div>
          <button
            onClick={onNextRadio}
            title="next track"
            onMouseEnter={() => setNextHover(true)}
            onMouseLeave={() => setNextHover(false)}
            style={{
              appearance: "none",
              cursor: "pointer",
              border: 0,
              background: "transparent",
              color: nextHover ? "var(--txb)" : "var(--txm)",
              fontFamily: "inherit",
              padding: "0 1px",
              flex: "none",
              lineHeight: 0,
            }}
          >
            <svg viewBox="0 0 12 12" width="12" height="12" fill="currentColor">
              <path d="M2 2 L7.2 6 L2 10 Z" />
              <rect x="8" y="2" width="2" height="8" />
            </svg>
          </button>
        </div>
        <span style={hairline(16)} />
        <span
          style={{ position: "relative", flex: "none" }}
          data-ctx-type="weather" data-ctx-id="weather" data-ctx-label={weather.loc}
        >
          <button
            onClick={togglePopover}
            title="clock & weather — click to configure"
            onMouseEnter={() => setClockHover(true)}
            onMouseLeave={() => setClockHover(false)}
            style={{
              appearance: "none",
              cursor: "pointer",
              border: 0,
              background: "transparent",
              display: "flex",
              alignItems: "center",
              gap: 7,
              padding: 0,
              fontFamily: "inherit",
            }}
          >
            {/* The clock stays the biggest type in the strip. */}
            <span style={{ fontFamily: "var(--mono)", fontSize: "var(--t135)", color: "var(--txb)", letterSpacing: ".6px" }}>
              {clockMini}
            </span>
            {fmt12 && (
              <span style={{ fontSize: "var(--t7)", letterSpacing: "1px", color: "var(--txd)" }}>{ampm}</span>
            )}
            <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="var(--warn)" strokeWidth="1.6" strokeLinecap="round" style={{ flex: "none" }}>
              <circle cx="12" cy="12" r="4" />
              <path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.4 1.4M17.6 17.6L19 19M19 5l-1.4 1.4M6.4 17.6L5 19" />
            </svg>
            <span style={{ fontFamily: "var(--mono)", fontSize: "var(--t105)", color: clockHover ? "var(--txh)" : "var(--txm)" }}>{wxTempStr}</span>
          </button>
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
        </span>
        {/* Collapsed right panel: SHIP and the bell land at the end of the
            centre zone instead of losing their track. */}
        {!rightOpen && (
          <>
            <span style={hairline(16)} />
            <UpdateButton onFeed={onFeed} />
            <NotificationCenter />
          </>
        )}
      </div>

      {/* R — panel zone (SHIP left, bell right) + the 48px rail. */}
      {rightOpen ? (
        <div style={{ display: "grid", gridTemplateColumns: "minmax(0,1fr) 48px" }}>
          <div style={{ position: "relative", display: "flex", alignItems: "center", gap: 10, padding: "0 12px", minWidth: 0 }}>
            <span aria-hidden style={zoneRule} />
            <UpdateButton onFeed={onFeed} />
            <span style={{ flex: 1 }} />
            <NotificationCenter />
          </div>
          {rail}
        </div>
      ) : (
        rail
      )}
    </div>
  );
}
