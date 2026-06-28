import { useEffect, useState } from "react";
import type { HostStats, Weather } from "../../api";

export type WorkspacePanelProps = {
  clock: string;
  date: string;
  turns: number;
  host: HostStats;
  weather: Weather;
  focus: {
    h: number;
    goal: number;
    pct: number;
    sessions: number;
    commits: number;
    streak: number;
  };
  onSetCity?: (city: string) => Promise<string | null>;
  onSetUnit?: (unit: string) => Promise<string | null>;
  openSettings?: number; // nonce — bump to open the weather settings editor (from the context menu)
};

const fmtNet = (kb: number): string =>
  kb >= 1024 ? (kb / 1024).toFixed(1) + "M/s" : Math.round(kb) + "K/s";

export function WorkspacePanel(props: WorkspacePanelProps) {
  const { clock, date, turns, host, weather, focus, onSetCity, onSetUnit, openSettings } = props;
  const [editLoc, setEditLoc] = useState(false);
  const [city, setCity] = useState("");
  const [cityErr, setCityErr] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // The context menu opens the weather settings by bumping `openSettings`.
  useEffect(() => {
    if (openSettings) { setEditLoc(true); setCityErr(null); setCity(""); }
  }, [openSettings]);

  async function submitCity() {
    if (!onSetCity || !city.trim()) { setEditLoc(false); return; }
    setSaving(true);
    setCityErr(null);
    const err = await onSetCity(city.trim());
    setSaving(false);
    if (err) { setCityErr(err); return; }
    setCity("");
    setEditLoc(false);
  }

  async function pickUnit(u: "C" | "F") {
    if (!onSetUnit || saving) return;
    setSaving(true);
    await onSetUnit(u === "F" ? "fahrenheit" : "celsius");
    setSaving(false);
  }

  const hostStateColor = host.state === "BUSY" ? "#e3c279" : "#8fd9a8";
  const netUp = fmtNet(host.net_up);
  const netDown = fmtNet(host.net_down);
  const wxTemp = weather.temp === null ? "—" : `${weather.temp}`;

  return (
    <div
      className="panel"
      style={{
        border: "1px solid rgba(127,233,216,.16)",
        background: "rgba(9,16,16,.5)",
        animation: "enterLeft .55s cubic-bezier(.2,.8,.2,1) both .06s",
        flex: "none",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "8px 12px",
        }}
      >
        <span style={{ fontSize: "10.5px", letterSpacing: "2.5px", color: "#3c544f" }}>
          PANEL
        </span>
        <span style={{ fontSize: "10.5px", letterSpacing: "2.5px", color: "#7fe9d8" }}>
          WORKSPACE
        </span>
      </div>
      <div
        style={{
          height: "1px",
          background: "linear-gradient(90deg,#7fe9d8,rgba(127,233,216,.05))",
          transformOrigin: "left",
          animation: "drawline .7s ease both .1s",
        }}
      ></div>

      <div style={{ padding: "14px 14px 12px" }}>
        <div
          className="glow"
          style={{ fontSize: "46px", lineHeight: 1, letterSpacing: "2px", color: "#dff8f2" }}
        >
          {clock.split("").map((ch, i) =>
            ch === ":" ? (
              <span key={i} style={{ padding: "0 5px", opacity: 0.45 }}>
                {ch}
              </span>
            ) : (
              <span
                key={`${i}-${ch}`}
                style={{
                  display: "inline-block",
                  minWidth: "0.6em",
                  textAlign: "center",
                  animation: "digitflip .5s cubic-bezier(.2,.85,.25,1) both",
                }}
              >
                {ch}
              </span>
            ),
          )}
        </div>
        <div
          style={{
            display: "flex",
            gap: "10px",
            marginTop: "8px",
            fontSize: "11px",
            letterSpacing: "1.5px",
            color: "#6f938d",
          }}
        >
          <span>{date}</span>
          <span style={{ color: "#2e423f" }}>//</span>
          <span>SESSION {turns} TURNS</span>
        </div>

        {/* host vitals */}
        <div
          style={{
            marginTop: "18px",
            borderTop: "1px dashed rgba(127,233,216,.14)",
            paddingTop: "13px",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              fontSize: "9.5px",
              letterSpacing: "1.5px",
              color: "#3c544f",
            }}
          >
            <span>HOST · {host.host}</span>
            <span style={{ color: hostStateColor }}>{host.state}</span>
          </div>
          <div
            style={{ display: "flex", alignItems: "center", gap: "9px", marginTop: "11px" }}
          >
            <span
              style={{
                fontSize: "9.5px",
                letterSpacing: "1px",
                color: "#6f938d",
                width: "30px",
                flex: "none",
              }}
            >
              CPU
            </span>
            <span
              style={{
                flex: 1,
                height: "5px",
                background: "rgba(127,233,216,.12)",
                position: "relative",
                overflow: "hidden",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: 0,
                  width: `${host.cpu}%`,
                  background: "linear-gradient(90deg,#7fe9d8,#b9a6ff)",
                  transition: "width .8s ease",
                }}
              ></span>
            </span>
            <span
              style={{
                fontSize: "10px",
                color: "#bfe6de",
                width: "34px",
                textAlign: "right",
                flex: "none",
              }}
            >
              {host.cpu}%
            </span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: "9px", marginTop: "7px" }}>
            <span
              style={{
                fontSize: "9.5px",
                letterSpacing: "1px",
                color: "#6f938d",
                width: "30px",
                flex: "none",
              }}
            >
              MEM
            </span>
            <span
              style={{
                flex: 1,
                height: "5px",
                background: "rgba(127,233,216,.12)",
                position: "relative",
                overflow: "hidden",
              }}
            >
              <span
                style={{
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: 0,
                  width: `${host.mem_pct}%`,
                  background: "#8fd9a8",
                  transition: "width .8s ease",
                }}
              ></span>
            </span>
            <span
              style={{
                fontSize: "10px",
                color: "#bfe6de",
                width: "50px",
                textAlign: "right",
                flex: "none",
              }}
            >
              {host.mem_used}/{host.mem_total}G
            </span>
          </div>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginTop: "10px",
              fontSize: "10px",
              letterSpacing: ".5px",
              color: "#6f938d",
            }}
          >
            <span>
              NET <span style={{ color: "#8fd9a8" }}>↑{netUp}</span>{" "}
              <span style={{ color: "#6fb5ff" }}>↓{netDown}</span>
            </span>
            <span>
              LOAD <span style={{ color: "#bfe6de" }}>{host.load}</span>
            </span>
            <span>
              PROCS <span style={{ color: "#bfe6de" }}>{host.procs}</span>
            </span>
          </div>
        </div>

        {/* focus time (merged, compact) */}
        <div
          style={{
            marginTop: "16px",
            borderTop: "1px dashed rgba(127,233,216,.14)",
            paddingTop: "13px",
            display: "flex",
            alignItems: "center",
            gap: "13px",
          }}
        >
          <div style={{ flex: "none" }}>
            <div className="glow" style={{ lineHeight: 1, color: "#dff8f2" }}>
              <span style={{ fontSize: "23px" }}>{focus.h}</span>
              <span style={{ fontSize: "11px", color: "#6f938d", letterSpacing: ".5px" }}>
                {" "}
                / {focus.goal}H
              </span>
            </div>
            <div
              style={{
                fontSize: "8.5px",
                letterSpacing: "1px",
                color: "#7fe9d8",
                marginTop: "4px",
              }}
            >
              FOCUS · {focus.pct}% OF GOAL
            </div>
            <div
              style={{
                width: "124px",
                height: "3px",
                background: "rgba(127,233,216,.12)",
                marginTop: "6px",
                overflow: "hidden",
              }}
            >
              <div
                style={{
                  height: "100%",
                  width: `${focus.pct}%`,
                  background: "linear-gradient(90deg,#7fe9d8,#b9a6ff)",
                  animation: "grow 1s ease both .3s",
                }}
              ></div>
            </div>
          </div>
          <div
            style={{ marginLeft: "auto", display: "flex", gap: "15px", textAlign: "right" }}
          >
            <div>
              <div style={{ fontSize: "8px", letterSpacing: "1px", color: "#3c544f" }}>SESS</div>
              <div style={{ fontSize: "14px", color: "#bfe6de", marginTop: "2px" }}>
                {focus.sessions}
              </div>
            </div>
            <div>
              <div style={{ fontSize: "8px", letterSpacing: "1px", color: "#3c544f" }}>CMTS</div>
              <div style={{ fontSize: "14px", color: "#bfe6de", marginTop: "2px" }}>
                {focus.commits}
              </div>
            </div>
            <div>
              <div style={{ fontSize: "8px", letterSpacing: "1px", color: "#3c544f" }}>
                STREAK
              </div>
              <div style={{ fontSize: "14px", color: "#8fd9a8", marginTop: "2px" }}>
                {focus.streak}d
              </div>
            </div>
          </div>
        </div>

        {/* weather (merged) — right-click for city + unit settings */}
        <div
          data-ctx-type="weather"
          data-ctx-id="weather"
          data-ctx-label={weather.loc}
          title="right-click for weather settings"
          style={{
            marginTop: "16px",
            borderTop: "1px dashed rgba(127,233,216,.14)",
            paddingTop: "13px",
            display: "flex",
            alignItems: "center",
            gap: "12px",
          }}
        >
          <svg
            viewBox="0 0 48 48"
            style={{ width: "32px", height: "32px", flex: "none", overflow: "visible" }}
          >
            <circle cx="17" cy="16" r="7" fill="none" stroke="#e3c279" strokeWidth="1.6" />
            <g stroke="#e3c279" strokeWidth="1.5" strokeLinecap="round">
              <line x1="17" y1="3" x2="17" y2="6" />
              <line x1="6" y1="16" x2="9" y2="16" />
              <line x1="8" y1="7" x2="10" y2="9" />
              <line x1="26" y1="7" x2="24" y2="9" />
            </g>
            <path
              d="M16 42 a7 7 0 0 1 1 -13.9 a9 9 0 0 1 17 2 a6 6 0 0 1 -1 11.9 Z"
              fill="#0b1414"
              stroke="#7fe9d8"
              strokeWidth="1.8"
            />
          </svg>
          <div style={{ flex: "none" }}>
            <div className="glow" style={{ fontSize: "23px", lineHeight: 1, color: "#dff8f2" }}>
              {wxTemp}°<span style={{ fontSize: "13px", color: "#7fe9d8" }}>{weather.unit}</span>
            </div>
            <div
              style={{
                fontSize: "8.5px",
                letterSpacing: "1px",
                color: "#7fe9d8",
                marginTop: "3px",
              }}
            >
              {weather.cond}
            </div>
          </div>
          <div
            style={{
              marginLeft: "auto",
              textAlign: "right",
              fontSize: "9.5px",
              letterSpacing: ".5px",
              color: "#6f938d",
              lineHeight: 1.75,
            }}
          >
            {editLoc ? (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 5 }}>
                <input
                  autoFocus
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") void submitCity();
                    if (e.key === "Escape") { setEditLoc(false); setCityErr(null); }
                  }}
                  onBlur={() => { if (!saving) { setEditLoc(false); setCityErr(null); } }}
                  placeholder="city…"
                  disabled={saving}
                  style={{ width: 130, background: "rgba(7,13,13,.6)", border: `1px solid ${cityErr ? "#e0897a" : "rgba(127,233,216,.3)"}`, outline: "none", color: "#dff8f2", fontFamily: "inherit", fontSize: "9.5px", letterSpacing: ".5px", padding: "3px 6px", textAlign: "right" }}
                />
                <div style={{ display: "flex", gap: 4 }}>
                  {(["C", "F"] as const).map((u) => {
                    const on = weather.unit === u;
                    return (
                      <button
                        key={u}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => void pickUnit(u)}
                        disabled={saving || !onSetUnit}
                        title={u === "C" ? "Celsius" : "Fahrenheit"}
                        style={{ appearance: "none", cursor: saving ? "default" : "pointer", border: `1px solid ${on ? "#7fe9d8" : "rgba(127,233,216,.22)"}`, background: on ? "rgba(127,233,216,.16)" : "transparent", color: on ? "#dff8f2" : "#6f938d", fontFamily: "inherit", fontSize: "9.5px", letterSpacing: ".5px", padding: "2px 8px" }}
                      >
                        °{u}
                      </button>
                    );
                  })}
                </div>
                {cityErr && <div style={{ fontSize: "8.5px", color: "#e0897a" }}>{cityErr}</div>}
              </div>
            ) : (
              <div
                onClick={onSetCity ? () => { setEditLoc(true); setCityErr(null); setCity(""); } : undefined}
                title={onSetCity ? "click to change city" : undefined}
                style={{ cursor: onSetCity ? "pointer" : "default", color: cityErr ? "#e0897a" : "#6f938d" }}
              >
                {saving ? "…" : cityErr ? "not found" : weather.loc}
              </div>
            )}
            <div>
              H <span style={{ color: "#bfe6de" }}>{weather.hi}°</span> · L{" "}
              <span style={{ color: "#bfe6de" }}>{weather.lo}°</span>
            </div>
            <div>
              WIND <span style={{ color: "#9fc7c0" }}>{weather.wind}</span> · HUM{" "}
              <span style={{ color: "#9fc7c0" }}>{weather.hum}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
