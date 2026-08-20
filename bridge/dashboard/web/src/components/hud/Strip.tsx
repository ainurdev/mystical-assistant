import { useEffect, useState, type CSSProperties } from "react";
import { type Weather } from "../../api";
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
}

// Segmented-control button style for the popover's 24H/12H and °C/°F pickers.
const seg = (on: boolean): CSSProperties => ({
  flex: 1, appearance: "none", cursor: "pointer", border: 0,
  background: on ? "color-mix(in srgb, var(--acc) 16%, transparent)" : "transparent",
  color: on ? "var(--txb)" : "var(--txd)",
  fontFamily: "inherit", fontSize: "var(--t10)", letterSpacing: "1px", padding: "7px",
});

export function Strip(props: StripProps) {
  const { radio, onToggleRadio, onNextRadio, onOpenSettings, clock, weather, onSetCity, onSetUnit, openSettings, onFeed } = props;
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
        display: "flex",
        alignItems: "center",
        gap: "11px",
        padding: "7px 16px",
        borderBottom: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)",
        animation: "enterDown .55s cubic-bezier(.2,.8,.2,1) both",
      }}
    >
      <svg
        viewBox="0 0 100 100"
        style={{ width: "22px", height: "22px", flex: "none", overflow: "visible" }}
      >
        <circle
          cx="50"
          cy="50"
          r="40"
          fill="none"
          stroke="var(--acc)"
          strokeWidth="3"
          strokeDasharray="7 11"
          style={{ transformOrigin: "50px 50px", animation: "introspin 12s linear infinite" }}
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
      <span
        style={{ fontSize: "var(--t12)", letterSpacing: "3px", color: "var(--acc)" }}
        className="glow"
      >
        MYSTICAL//ASSISTANT
      </span>
      <WeekPanel />
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
            border: `1px solid ${clockHover ? "color-mix(in srgb, var(--acc) 30%, transparent)" : "color-mix(in srgb, var(--acc) 14%, transparent)"}`,
            background: "color-mix(in srgb, var(--panel2) 40%, transparent)",
            display: "flex",
            alignItems: "center",
            gap: "8px",
            padding: "3px 9px",
            fontFamily: "inherit",
          }}
        >
          <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t12)", color: "var(--txh)", letterSpacing: ".5px" }}>
            {clockMini}
          </span>
          {fmt12 && (
            <span style={{ fontSize: "var(--t7)", letterSpacing: "1px", color: "var(--txd)" }}>{ampm}</span>
          )}
          <span style={{ width: "1px", height: "11px", background: "color-mix(in srgb, var(--acc) 16%, transparent)", flex: "none" }}></span>
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="var(--warn)" strokeWidth="1.6" strokeLinecap="round" style={{ flex: "none" }}>
            <circle cx="12" cy="12" r="4" />
            <path d="M12 2v2M12 20v2M4 12H2M22 12h-2M5 5l1.4 1.4M17.6 17.6L19 19M19 5l-1.4 1.4M6.4 17.6L5 19" />
          </svg>
          <span style={{ fontFamily: "'JetBrains Mono',monospace", fontSize: "var(--t11)", color: "var(--txm)" }}>{wxTempStr}</span>
        </button>
        {clockOpen && (
          <div
            style={{
              position: "absolute",
              top: "calc(100% + 8px)",
              left: 0,
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
      <span style={{ flex: 1 }}></span>
      {/* One line: transport, alive-signal, track. Elapsed moved to the
          tooltip — it cost a second line, and a second line set the whole
          strip's height. */}
      <div
        title={`Claude FM — ${radio.elapsed} elapsed`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          border: "1px solid color-mix(in srgb, var(--acc) 18%, transparent)",
          background: "color-mix(in srgb, var(--panel2) 45%, transparent)",
          padding: "3px 5px 3px 7px",
          width: "220px",
          flex: "none",
        }}
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
            fontSize: "var(--t10)",
            color: "var(--tx)",
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
      <span
        style={{ width: "1px", height: "18px", background: "color-mix(in srgb, var(--acc) 18%, transparent)" }}
      ></span>
      <UpdateButton onFeed={onFeed} />
      <NotificationCenter />
      <button
        onClick={onOpenSettings}
        title="dashboard settings"
        onMouseEnter={() => setGearHover(true)}
        onMouseLeave={() => setGearHover(false)}
        style={{
          appearance: "none",
          cursor: "pointer",
          border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)",
          background: gearHover ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent",
          color: gearHover ? "var(--txb)" : "var(--txm)",
          fontFamily: "inherit",
          padding: "4px 6px",
          display: "flex",
          alignItems: "center",
        }}
      >
        <svg
          viewBox="0 0 24 24"
          width="14"
          height="14"
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
  );
}
