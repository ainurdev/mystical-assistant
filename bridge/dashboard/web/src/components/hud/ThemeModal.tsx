import { useState } from "react";
import { THEME_DEFS, themeCompensator, type HudSettings, type ThemeKey } from "../../lib/theme";

export interface ThemeModalProps {
  settings: HudSettings;
  onTheme: (t: ThemeKey) => void;
  onToggle: (key: "scanlines" | "sweep" | "glow") => void;
  onReplayBoot: () => void;
  onClose: () => void;
}

interface ToggleDef {
  key: "scanlines" | "sweep" | "glow";
  label: string;
  desc: string;
}

const TOGGLES: ToggleDef[] = [
  { key: "scanlines", label: "SCANLINES", desc: "horizontal CRT raster lines" },
  { key: "sweep", label: "SCAN SWEEP", desc: "roaming refresh glow band" },
  { key: "glow", label: "TEXT GLOW", desc: "phosphor bloom on headings" },
];

// The 9-card "DISPLAY PROFILE" grid. Because the whole app is run through the
// active theme's CSS filter, every swatch/preview colour is pre-corrected by
// the INVERSE of that filter's color matrix so the cards render TRUE colours.
// Shared by ThemeModal and SettingsModal.
export function ThemeCardGrid({
  settings,
  onTheme,
}: {
  settings: HudSettings;
  onTheme: (t: ThemeKey) => void;
}) {
  const [hover, setHover] = useState<ThemeKey | null>(null);
  const comp = themeCompensator(settings.theme);
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 9 }}>
      {THEME_DEFS.map((t) => {
        const on = settings.theme === t.key;
        const sw = comp(t.sw);
        const cardBd = on ? comp(t.sw) : comp("#26413d");
        const cardBg = on ? comp("#132824") : comp("#0d1517");
        const dim = comp("#20332f");
        const pbg = comp(t.pbg);
        const nameC = comp("#dff8f2");
        const descC = comp("#8fa8a2");
        const chipC = comp("#06100e");
        const pfont = t.font || "inherit";
        const prad = t.prad || "0";
        return (
          <button
            key={t.key}
            onClick={() => onTheme(t.key)}
            onMouseEnter={() => setHover(t.key)}
            onMouseLeave={() => setHover(null)}
            style={{
              appearance: "none",
              textAlign: "left",
              cursor: "pointer",
              fontFamily: "inherit",
              border: `1px solid ${hover === t.key ? "rgba(127,233,216,.45)" : cardBd}`,
              background: cardBg,
              padding: 0,
              overflow: "hidden",
            }}
          >
            <div
              style={{
                position: "relative",
                height: 38,
                background: pbg,
                borderBottom: `1px solid ${dim}`,
                overflow: "hidden",
                padding: "7px 9px",
              }}
            >
              <div style={{ display: "flex", gap: 3, alignItems: "flex-end", height: "100%" }}>
                <span style={{ flex: 1, height: "55%", background: sw, opacity: 0.8 }}></span>
                <span style={{ flex: 1, height: "100%", background: sw }}></span>
                <span style={{ flex: 1, height: "45%", background: sw, opacity: 0.5 }}></span>
                <span style={{ flex: 1, height: "80%", background: sw, opacity: 0.8 }}></span>
                <span style={{ flex: 1, height: "30%", background: sw, opacity: 0.35 }}></span>
                <span style={{ flex: 1, height: "65%", background: sw, opacity: 0.8 }}></span>
              </div>
              {t.crt && (
                <div
                  style={{
                    position: "absolute",
                    inset: 0,
                    pointerEvents: "none",
                    background:
                      "repeating-linear-gradient(0deg,rgba(0,0,0,0) 0,rgba(0,0,0,0) 2px,rgba(0,0,0,.28) 3px,rgba(0,0,0,0) 4px)",
                    opacity: 0.55,
                  }}
                ></div>
              )}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "6px 9px" }}>
              <span
                style={{
                  width: 10,
                  height: 10,
                  background: sw,
                  border: "1px solid rgba(0,0,0,.45)",
                  flex: "none",
                  borderRadius: prad,
                }}
              ></span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 10.5,
                    letterSpacing: 1,
                    color: nameC,
                    fontFamily: pfont,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {t.name}
                </div>
                <div
                  style={{
                    fontSize: 8,
                    letterSpacing: 0.4,
                    color: descC,
                    marginTop: 1,
                    fontFamily: pfont,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {t.feel}
                </div>
              </div>
              {on && (
                <span
                  style={{
                    fontSize: 7,
                    letterSpacing: 1,
                    color: chipC,
                    background: sw,
                    padding: "1px 5px",
                    flex: "none",
                  }}
                >
                  ON
                </span>
              )}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// CRT EFFECTS toggle rows (scanlines / sweep / glow). Shared by ThemeModal
// and SettingsModal.
export function CrtToggles({
  settings,
  onToggle,
}: {
  settings: HudSettings;
  onToggle: (key: "scanlines" | "sweep" | "glow") => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 1,
        border: "1px solid rgba(127,233,216,.14)",
        background: "rgba(127,233,216,.08)",
      }}
    >
      {TOGGLES.map((g) => {
        const v = settings[g.key];
        const onBg = v ? "#7fe9d8" : "transparent";
        const onColor = v ? "#06100e" : "#3c544f";
        const offBg = v ? "transparent" : "rgba(127,233,216,.18)";
        const offColor = v ? "#3c544f" : "#dff8f2";
        return (
          <div
            key={g.key}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              padding: "12px 14px",
              background: "rgba(9,16,16,.92)",
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 12, color: "#cfe9e3", letterSpacing: 0.5 }}>{g.label}</div>
              <div style={{ fontSize: 9.5, color: "#3c544f", marginTop: 2 }}>{g.desc}</div>
            </div>
            <button
              onClick={() => onToggle(g.key)}
              style={{
                appearance: "none",
                cursor: "pointer",
                border: "1px solid rgba(127,233,216,.25)",
                background: "#060a0a",
                padding: 2,
                display: "flex",
                gap: 2,
                fontFamily: "inherit",
              }}
            >
              <span style={{ fontSize: 9, letterSpacing: 1, padding: "3px 10px", background: onBg, color: onColor }}>
                ON
              </span>
              <span style={{ fontSize: 9, letterSpacing: 1, padding: "3px 10px", background: offBg, color: offColor }}>
                OFF
              </span>
            </button>
          </div>
        );
      })}
    </div>
  );
}

export function ThemeModal(props: ThemeModalProps) {
  const { settings, onTheme, onToggle, onReplayBoot, onClose } = props;
  const [escHover, setEscHover] = useState(false);
  const [replayHover, setReplayHover] = useState(false);
  const [doneHover, setDoneHover] = useState(false);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(4,7,7,.72)",
        zIndex: 93,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "8vh",
        animation: "backdropIn .2s ease",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="panel"
        style={{
          width: 660,
          maxWidth: "94vw",
          maxHeight: "84vh",
          display: "flex",
          flexDirection: "column",
          border: "1px solid rgba(127,233,216,.4)",
          background: "rgba(7,13,13,.98)",
          boxShadow: "0 0 70px rgba(0,0,0,.75),0 0 30px rgba(127,233,216,.08)",
          animation: "modalIn .26s cubic-bezier(.2,.9,.3,1)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 11,
            padding: "14px 18px",
            borderBottom: "1px solid rgba(127,233,216,.16)",
            flex: "none",
          }}
        >
          <svg viewBox="0 0 100 100" style={{ width: 20, height: 20, flex: "none", overflow: "visible" }}>
            <circle
              cx="50"
              cy="50"
              r="40"
              fill="none"
              stroke="#7fe9d8"
              strokeWidth="3"
              strokeDasharray="7 11"
              style={{ transformOrigin: "50px 50px", animation: "introspin 12s linear infinite" }}
            />
            <rect
              x="41"
              y="41"
              width="18"
              height="18"
              fill="#b9a6ff"
              style={{ transformOrigin: "50px 50px", transform: "rotate(45deg)" }}
            />
          </svg>
          <span style={{ fontSize: 9.5, letterSpacing: 2.5, color: "#3c544f" }}>DISPLAY</span>
          <span style={{ fontSize: 15, color: "#dff8f2", letterSpacing: 0.5 }} className="glow">
            THEME &amp; CRT
          </span>
          <span style={{ flex: 1 }}></span>
          <button
            onClick={onClose}
            onMouseEnter={() => setEscHover(true)}
            onMouseLeave={() => setEscHover(false)}
            style={{
              appearance: "none",
              cursor: "pointer",
              border: "1px solid rgba(127,233,216,.25)",
              background: escHover ? "rgba(127,233,216,.08)" : "transparent",
              color: "#9fc7c0",
              fontFamily: "inherit",
              fontSize: 9.5,
              letterSpacing: 1.5,
              padding: "4px 10px",
            }}
          >
            ESC ✕
          </button>
        </div>

        <div className="mscroll" style={{ flex: 1, overflowY: "auto", padding: 18 }}>
          <div style={{ fontSize: 9.5, letterSpacing: 1.5, color: "#3c544f", marginBottom: 11 }}>
            DISPLAY PROFILE · 9 THEMES
          </div>
          <ThemeCardGrid settings={settings} onTheme={onTheme} />

          <div style={{ fontSize: 9.5, letterSpacing: 1.5, color: "#3c544f", margin: "20px 0 11px" }}>CRT EFFECTS</div>
          <CrtToggles settings={settings} onToggle={onToggle} />

          <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 18 }}>
            <button
              onClick={onReplayBoot}
              onMouseEnter={() => setReplayHover(true)}
              onMouseLeave={() => setReplayHover(false)}
              style={{
                appearance: "none",
                cursor: "pointer",
                border: "1px solid rgba(127,233,216,.25)",
                background: replayHover ? "rgba(127,233,216,.08)" : "transparent",
                color: "#bfe6de",
                fontFamily: "inherit",
                fontSize: 10,
                letterSpacing: 1.5,
                padding: "9px 14px",
              }}
            >
              ▸ REPLAY BOOT SEQUENCE
            </button>
            <span style={{ flex: 1 }}></span>
            <button
              onClick={onClose}
              onMouseEnter={() => setDoneHover(true)}
              onMouseLeave={() => setDoneHover(false)}
              style={{
                appearance: "none",
                cursor: "pointer",
                border: "1px solid #7fe9d8",
                background: doneHover ? "rgba(127,233,216,.22)" : "rgba(127,233,216,.12)",
                color: "#dff8f2",
                fontFamily: "inherit",
                fontSize: 10,
                letterSpacing: 2,
                padding: "9px 22px",
              }}
            >
              DONE
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
