import { useState } from "react";
import type { HudSettings, ThemeKey } from "../../lib/theme";
import { CrtToggles, ThemeCardGrid } from "./ThemeModal";

type Model = "fable" | "opus" | "sonnet" | "haiku";
type Mode = "plan" | "acceptEdits" | "auto";

export interface SettingsModalProps {
  wsRoot: string;
  host: string;
  port: string;
  settings: HudSettings;
  onTheme: (t: ThemeKey) => void;
  onToggle: (key: "scanlines" | "sweep" | "glow") => void;
  defModel: Model;
  defMode: Mode;
  onDefModel: (m: Model) => void;
  onDefMode: (m: Mode) => void;
  onClose: () => void;
}

const MODEL_OPTS: { label: string; value: Model }[] = [
  { label: "HAIKU", value: "haiku" },
  { label: "SONNET", value: "sonnet" },
  { label: "OPUS", value: "opus" },
  { label: "FABLE", value: "fable" },
];

const MODE_OPTS: { label: string; value: Mode }[] = [
  { label: "PLAN", value: "plan" },
  { label: "ACCEPT", value: "acceptEdits" },
  { label: "AUTO", value: "auto" },
];

export function SettingsModal(props: SettingsModalProps) {
  const {
    wsRoot,
    host,
    port,
    settings,
    onTheme,
    onToggle,
    defModel,
    defMode,
    onDefModel,
    onDefMode,
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
                    {MODEL_OPTS.map((m) => {
                      const active = defModel === m.value;
                      return (
                        <button
                          key={m.value}
                          onClick={() => onDefModel(m.value)}
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
                          {m.label}
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
