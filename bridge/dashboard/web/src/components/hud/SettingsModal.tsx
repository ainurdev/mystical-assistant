import { useState, type CSSProperties } from "react";
import { themeUnfilter, type HudSettings, type Indicator, type ThemeKey } from "../../lib/theme";
import { NYAN_MODES, nyanThumb, type NyanSound } from "../../lib/nyan";
import { VOICES, VOICE_GROUPS } from "../../lib/piano";
import { CrtToggles, ThemeCardGrid } from "./ThemeModal";

type Model = string; // full model id from the Models API, or a short CLI alias
type Mode = "plan" | "acceptEdits" | "auto";

export interface SettingsModalProps {
  wsRoot: string;
  host: string;
  port: string;
  settings: HudSettings;
  onTheme: (t: ThemeKey) => void;
  onToggle: (key: "scanlines" | "sweep" | "glow") => void;
  onPatch: (patch: Partial<HudSettings>) => void;
  defModel: Model;
  defMode: Mode;
  onDefModel: (m: Model) => void;
  onDefMode: (m: Mode) => void;
  models: { id: Model; label: string }[];
  onClose: () => void;
}

const MODE_OPTS: { label: string; value: Mode }[] = [
  { label: "PLAN", value: "plan" },
  { label: "ACCEPT", value: "acceptEdits" },
  { label: "AUTO", value: "auto" },
];

// ---- WORKING INDICATOR ------------------------------------------------------
// Three forms share one tabbed panel so the modal stays one screen: the stock
// equalizer, a nyan.cat ride, and a playable piano. Picking a tab IS picking
// the form — `settings.indicator` is the tab state.

const INDICATOR_TABS: { key: Indicator; label: string; blurb: string }[] = [
  { key: "bar", label: "EQUALIZER", blurb: "the stock braille spinner, phrase ticker and level bars" },
  { key: "nyan", label: "NYAN CAT", blurb: "a nyan.cat ride — 36 cats, their trails, their music" },
  { key: "piano", label: "PIANO", blurb: "two octaves to play with mouse or keyboard while you wait" },
];

const field = {
  background: "var(--panel3)",
  border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)",
  outline: "none",
  color: "var(--txb)",
  fontFamily: "inherit",
  fontSize: 10,
  letterSpacing: 1,
  padding: "6px 8px",
};

/** An ON/OFF pill, matching the CRT rows. */
function Switch({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        appearance: "none",
        cursor: "pointer",
        border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)",
        background: "var(--panel3)",
        padding: 2,
        display: "flex",
        gap: 2,
        flex: "none",
        fontFamily: "inherit",
      }}
    >
      <span style={{ fontSize: 9, letterSpacing: 1, padding: "3px 10px", background: on ? "var(--acc)" : "transparent", color: on ? "var(--acc-on)" : "var(--txl)" }}>
        ON
      </span>
      <span style={{ fontSize: 9, letterSpacing: 1, padding: "3px 10px", background: on ? "transparent" : "color-mix(in srgb, var(--acc) 18%, transparent)", color: on ? "var(--txl)" : "var(--txb)" }}>
        OFF
      </span>
    </button>
  );
}

function Volume({ value, disabled, onChange }: { value: number; disabled?: boolean; onChange: (v: number) => void }) {
  return (
    <>
      <input
        type="range"
        min={0}
        max={1}
        step={0.05}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        title={`Volume ${Math.round(value * 100)}%`}
        style={{ width: 96, flex: "none", accentColor: "var(--acc)" }}
      />
      <span style={{ fontSize: 9.5, color: "var(--txl)", flex: "none", width: 30, textAlign: "right", fontFamily: "'JetBrains Mono',monospace" }}>
        {Math.round(value * 100)}%
      </span>
    </>
  );
}

const ROW: CSSProperties = { display: "flex", alignItems: "center", gap: 10, marginTop: 11 };
const CAPTION: CSSProperties = { fontSize: 9.5, letterSpacing: 1, color: "var(--txd)", flex: "none" };

function IndicatorPicker({
  settings,
  onPatch,
}: {
  settings: HudSettings;
  onPatch: (patch: Partial<HudSettings>) => void;
}) {
  const unfilter = themeUnfilter(settings.theme);
  const active = INDICATOR_TABS.find((t) => t.key === settings.indicator) ?? INDICATOR_TABS[0];

  return (
    <div style={{ border: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)", background: "color-mix(in srgb, var(--panel) 92%, transparent)" }}>
      <div style={{ display: "flex", gap: 2, borderBottom: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)" }}>
        {INDICATOR_TABS.map((t) => {
          const on = settings.indicator === t.key;
          return (
            <button
              key={t.key}
              onClick={() => onPatch({ indicator: t.key })}
              style={{
                flex: 1,
                appearance: "none",
                cursor: "pointer",
                border: 0,
                borderBottom: `2px solid ${on ? "var(--acc)" : "transparent"}`,
                background: on ? "color-mix(in srgb, var(--acc) 14%, transparent)" : "transparent",
                color: on ? "var(--txb)" : "var(--txd)",
                fontFamily: "inherit",
                fontSize: 9.5,
                letterSpacing: 1.5,
                padding: "8px 4px",
              }}
            >
              {t.label}
            </button>
          );
        })}
      </div>

      <div style={{ padding: "12px 13px" }}>
        <div style={{ fontSize: 9.5, color: "var(--txl)" }}>{active.blurb}</div>

        {settings.indicator === "nyan" && (
          <>
            <div
              className="mscroll"
              style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(52px,1fr))", gap: 5, maxHeight: 172, overflowY: "auto", marginTop: 11 }}
            >
              {NYAN_MODES.map((m) => {
                const on = settings.nyan === m.key;
                return (
                  <button
                    key={m.key}
                    onClick={() => onPatch({ nyan: m.key })}
                    title={m.label}
                    style={{
                      appearance: "none",
                      cursor: "pointer",
                      padding: 3,
                      lineHeight: 0,
                      background: on ? "color-mix(in srgb, var(--acc) 20%, transparent)" : "var(--panel3)",
                      border: `1px solid ${on ? "var(--acc)" : "color-mix(in srgb, var(--acc) 14%, transparent)"}`,
                    }}
                  >
                    <img src={nyanThumb(m.thumb)} alt={m.label} loading="lazy" style={{ width: "100%", display: "block", filter: unfilter }} />
                  </button>
                );
              })}
            </div>

            <div style={ROW}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: "var(--txh)", letterSpacing: 0.5 }}>EXTRA ANIMATIONS</div>
                <div style={{ fontSize: 9.5, color: "var(--txl)", marginTop: 2 }}>
                  fly the cat, draw nyan.cat's rainbow trail + pixel stars
                </div>
              </div>
              <Switch on={settings.nyanExtra} onClick={() => onPatch({ nyanExtra: !settings.nyanExtra })} />
            </div>

            <div style={ROW}>
              <span style={CAPTION}>SOUND</span>
              <select
                value={settings.nyanSound}
                onChange={(e) => onPatch({ nyanSound: e.target.value as NyanSound })}
                style={{ ...field, flex: 1, minWidth: 0 }}
              >
                <option value="match">MATCH THE CAT</option>
                <option value="off">MUTE</option>
                {NYAN_MODES.map((m) => (
                  <option key={m.key} value={m.key}>
                    {m.label}
                  </option>
                ))}
              </select>
              <Volume
                value={settings.nyanVolume}
                disabled={settings.nyanSound === "off"}
                onChange={(nyanVolume) => onPatch({ nyanVolume })}
              />
            </div>
          </>
        )}

        {settings.indicator === "piano" && (
          <>
            <div style={ROW}>
              <span style={CAPTION}>VOICE</span>
              <select
                value={settings.pianoVoice}
                onChange={(e) => onPatch({ pianoVoice: e.target.value })}
                style={{ ...field, flex: 1, minWidth: 0 }}
              >
                {VOICE_GROUPS.map((g) => (
                  <optgroup key={g} label={g}>
                    {VOICES.filter((v) => v.group === g).map((v) => (
                      <option key={v.key} value={v.key}>
                        {v.label}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <Volume value={settings.pianoVolume} onChange={(pianoVolume) => onPatch({ pianoVolume })} />
            </div>
            <div style={{ fontSize: 9.5, color: "var(--txl)", marginTop: 11, lineHeight: 1.7 }}>
              Click the board to arm the computer keys — unfocused, they stay yours for typing.
              <br />
              <span style={{ color: "var(--txd)" }}>SAMPLES</span> are real recordings, one MP3 per
              note, fetched on first use (~600&nbsp;KB a voice, then browser-cached); the synth
              covers until they land.{" "}
              <span style={{ color: "var(--txd)" }}>SYNTH</span> voices are generated locally and
              need no network.
              <br />
              <span style={{ fontFamily: "'JetBrains Mono',monospace", color: "var(--txd)" }}>
                Z S X D C V G B H N J M
              </span>{" "}
              plays C3–B3 ·{" "}
              <span style={{ fontFamily: "'JetBrains Mono',monospace", color: "var(--txd)" }}>
                Q 2 W 3 E R 5 T 6 Y 7 U I
              </span>{" "}
              plays C4–C5.
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function SettingsModal(props: SettingsModalProps) {
  const {
    wsRoot,
    host,
    port,
    settings,
    onTheme,
    onToggle,
    onPatch,
    defModel,
    defMode,
    onDefModel,
    onDefMode,
    models,
    onClose,
  } = props;

  const [escHover, setEscHover] = useState(false);
  const [rescanHover, setRescanHover] = useState(false);
  const [doneHover, setDoneHover] = useState(false);

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed",
        inset: 0,
        background: "color-mix(in srgb, var(--panel3) 72%, transparent)",
        zIndex: 93,
        display: "flex",
        alignItems: "flex-start",
        justifyContent: "center",
        paddingTop: "7vh",
        animation: "backdropIn .22s ease both",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="panel"
        style={{
          width: 720,
          maxWidth: "94vw",
          maxHeight: "86vh",
          display: "flex",
          flexDirection: "column",
          border: "1px solid color-mix(in srgb, var(--acc) 40%, transparent)",
          background: "color-mix(in srgb, var(--panel2) 98%, transparent)",
          boxShadow: "0 0 70px rgba(0,0,0,.75),0 0 30px color-mix(in srgb, var(--acc) 8%, transparent)",
          animation: "modalIn .46s cubic-bezier(.16,.84,.3,1) both",
        }}
      >
        {/* Header */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 11,
            padding: "14px 18px",
            borderBottom: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)",
            flex: "none",
          }}
        >
          <svg
            viewBox="0 0 24 24"
            width="17"
            height="17"
            fill="none"
            stroke="var(--acc)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flex: "none" }}
          >
            <circle cx="12" cy="12" r="3.2" />
            <path d="M12 3.3v2.4M12 18.3v2.4M20.7 12h-2.4M5.7 12H3.3M18.16 5.84l-1.7 1.7M7.54 16.46l-1.7 1.7M18.16 18.16l-1.7-1.7M7.54 7.54l-1.7-1.7" />
          </svg>
          <span style={{ fontSize: 9.5, letterSpacing: 2.5, color: "var(--txl)" }}>
            CONFIGURE
          </span>
          <span
            style={{ fontSize: 15, color: "var(--txb)", letterSpacing: ".5px" }}
            className="glow"
          >
            DASHBOARD SETTINGS
          </span>
          <span style={{ flex: 1 }}></span>
          <button
            onClick={onClose}
            onMouseEnter={() => setEscHover(true)}
            onMouseLeave={() => setEscHover(false)}
            style={{
              appearance: "none",
              cursor: "pointer",
              border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)",
              background: escHover ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent",
              color: "var(--txm)",
              fontFamily: "inherit",
              fontSize: 9.5,
              letterSpacing: 1.5,
              padding: "4px 10px",
            }}
          >
            ESC ✕
          </button>
        </div>

        {/* Body */}
        <div
          className="mscroll"
          style={{ flex: 1, overflowY: "auto", padding: 18 }}
        >
          <div
            style={{
              fontSize: 9.5,
              letterSpacing: 1.5,
              color: "var(--txl)",
              marginBottom: 10,
            }}
          >
            WORKSPACE ROOT · where projects are scanned
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <span
              style={{
                fontSize: 14,
                color: "var(--acc)",
                flex: "none",
                fontFamily: "'JetBrains Mono',monospace",
              }}
            >
              ⌂
            </span>
            <input
              value={wsRoot}
              disabled
              placeholder="/home/squared/dev"
              style={{
                flex: 1,
                minWidth: 0,
                background: "color-mix(in srgb, var(--panel2) 60%, transparent)",
                border: "1px solid color-mix(in srgb, var(--acc) 18%, transparent)",
                outline: "none",
                color: "var(--txb)",
                fontFamily: "'JetBrains Mono',monospace",
                fontSize: 12.5,
                padding: "9px 11px",
              }}
            />
            <button
              onMouseEnter={() => setRescanHover(true)}
              onMouseLeave={() => setRescanHover(false)}
              style={{
                appearance: "none",
                cursor: "pointer",
                border: "1px solid color-mix(in srgb, var(--acc) 30%, transparent)",
                background: rescanHover
                  ? "color-mix(in srgb, var(--acc) 16%, transparent)"
                  : "color-mix(in srgb, var(--acc) 6%, transparent)",
                color: "var(--tx)",
                fontFamily: "inherit",
                fontSize: 10,
                letterSpacing: 1.5,
                padding: "9px 13px",
                flex: "none",
              }}
            >
              RESCAN ↻
            </button>
          </div>

          <div
            style={{
              fontSize: 9.5,
              letterSpacing: 1.5,
              color: "var(--txl)",
              marginBottom: 11,
            }}
          >
            THEME · DISPLAY PROFILE
          </div>
          <ThemeCardGrid settings={settings} onTheme={onTheme} />

          <div
            style={{
              fontSize: 9.5,
              letterSpacing: 1.5,
              color: "var(--txl)",
              margin: "20px 0 11px",
            }}
          >
            CRT EFFECTS
          </div>
          <CrtToggles settings={settings} onToggle={onToggle} />

          <div
            style={{
              fontSize: 9.5,
              letterSpacing: 1.5,
              color: "var(--txl)",
              margin: "20px 0 11px",
            }}
          >
            WORKING INDICATOR
          </div>
          <IndicatorPicker settings={settings} onPatch={onPatch} />

          {/* 2-col grid */}
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "1fr 1fr",
              gap: 14,
              marginTop: 20,
            }}
          >
            {/* BRIDGE */}
            <div>
              <div
                style={{
                  fontSize: 9.5,
                  letterSpacing: 1.5,
                  color: "var(--txl)",
                  marginBottom: 10,
                }}
              >
                BRIDGE
              </div>
              <div
                style={{
                  border: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)",
                  padding: "12px 13px",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <span
                    style={{ fontSize: 10, letterSpacing: 1, color: "var(--txd)" }}
                  >
                    HOST
                  </span>
                  <span style={{ fontSize: 11, color: "var(--tx)" }}>{host}</span>
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginTop: 10,
                  }}
                >
                  <span
                    style={{ fontSize: 10, letterSpacing: 1, color: "var(--txd)" }}
                  >
                    PORT
                  </span>
                  <input
                    value={port}
                    readOnly
                    style={{
                      width: 88,
                      textAlign: "right",
                      background: "color-mix(in srgb, var(--panel2) 60%, transparent)",
                      border: "1px solid color-mix(in srgb, var(--acc) 18%, transparent)",
                      outline: "none",
                      color: "var(--txb)",
                      fontFamily: "'JetBrains Mono',monospace",
                      fontSize: 11,
                      padding: "4px 7px",
                    }}
                  />
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                    marginTop: 10,
                  }}
                >
                  <span
                    style={{ fontSize: 10, letterSpacing: 1, color: "var(--txd)" }}
                  >
                    STATUS
                  </span>
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 10,
                      color: "var(--ok)",
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: "var(--ok)",
                        animation: "mpulse 2.4s infinite",
                      }}
                    ></span>
                    ONLINE
                  </span>
                </div>
              </div>
            </div>

            {/* SESSION DEFAULTS */}
            <div>
              <div
                style={{
                  fontSize: 9.5,
                  letterSpacing: 1.5,
                  color: "var(--txl)",
                  marginBottom: 10,
                }}
              >
                SESSION DEFAULTS
              </div>
              <div
                style={{
                  border: "1px solid color-mix(in srgb, var(--acc) 12%, transparent)",
                  padding: "12px 13px",
                  display: "flex",
                  flexDirection: "column",
                  gap: 11,
                }}
              >
                <div>
                  <div
                    style={{
                      fontSize: 10,
                      letterSpacing: 1,
                      color: "var(--txd)",
                      marginBottom: 6,
                    }}
                  >
                    MODEL
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: 2,
                      border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)",
                    }}
                  >
                    {models.map((m) => {
                      const active = defModel === m.id;
                      return (
                        <button
                          key={m.id}
                          onClick={() => onDefModel(m.id)}
                          style={{
                            flex: 1,
                            appearance: "none",
                            cursor: "pointer",
                            border: 0,
                            background: active ? "var(--acc)" : "transparent",
                            color: active ? "var(--acc-on)" : "var(--txd)",
                            fontFamily: "inherit",
                            fontSize: 10,
                            letterSpacing: 1,
                            padding: "6px 4px",
                          }}
                        >
                          {m.label.toUpperCase()}
                        </button>
                      );
                    })}
                  </div>
                </div>
                <div>
                  <div
                    style={{
                      fontSize: 10,
                      letterSpacing: 1,
                      color: "var(--txd)",
                      marginBottom: 6,
                    }}
                  >
                    PERMISSION MODE
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: 2,
                      border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)",
                    }}
                  >
                    {MODE_OPTS.map((m) => {
                      const active = defMode === m.value;
                      return (
                        <button
                          key={m.value}
                          onClick={() => onDefMode(m.value)}
                          style={{
                            flex: 1,
                            appearance: "none",
                            cursor: "pointer",
                            border: 0,
                            background: active ? "var(--acc)" : "transparent",
                            color: active ? "var(--acc-on)" : "var(--txd)",
                            fontFamily: "inherit",
                            fontSize: 9,
                            letterSpacing: ".5px",
                            padding: "6px 4px",
                          }}
                        >
                          {m.label}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Footer */}
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginTop: 20,
            }}
          >
            <span
              style={{
                fontSize: 9,
                letterSpacing: ".5px",
                color: "#456b65",
                flex: 1,
              }}
            >
              Settings persist to ~/.mystical/config.toml on this host.
            </span>
            <button
              onClick={onClose}
              onMouseEnter={() => setDoneHover(true)}
              onMouseLeave={() => setDoneHover(false)}
              style={{
                appearance: "none",
                cursor: "pointer",
                border: "1px solid var(--acc)",
                background: doneHover
                  ? "color-mix(in srgb, var(--acc) 22%, transparent)"
                  : "color-mix(in srgb, var(--acc) 12%, transparent)",
                color: "var(--txb)",
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
