import { useState } from "react";

type Model = "opus" | "sonnet" | "haiku";
type Mode = "plan" | "acceptEdits" | "auto";

interface ProjectRow {
  name: string;
  path: string;
  runCmd: string;
  dotColor: string;
  tag: string;
  tagColor: string;
}

export interface SettingsModalProps {
  wsRoot: string;
  projects: ProjectRow[];
  host: string;
  port: string;
  defModel: Model;
  defMode: Mode;
  onDefModel: (m: Model) => void;
  onDefMode: (m: Mode) => void;
  onOpenTheme: () => void;
  onClose: () => void;
}

const MODEL_OPTS: { label: string; value: Model }[] = [
  { label: "HAIKU", value: "haiku" },
  { label: "SONNET", value: "sonnet" },
  { label: "OPUS", value: "opus" },
];

const MODE_OPTS: { label: string; value: Mode }[] = [
  { label: "PLAN", value: "plan" },
  { label: "ACCEPT", value: "acceptEdits" },
  { label: "AUTO", value: "auto" },
];

export function SettingsModal(props: SettingsModalProps) {
  const {
    wsRoot,
    projects,
    host,
    port,
    defModel,
    defMode,
    onDefModel,
    onDefMode,
    onOpenTheme,
    onClose,
  } = props;

  const [escHover, setEscHover] = useState(false);
  const [rescanHover, setRescanHover] = useState(false);
  const [themeHover, setThemeHover] = useState(false);
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
          border: "1px solid rgba(127,233,216,.4)",
          background: "rgba(7,13,13,.98)",
          boxShadow: "0 0 70px rgba(0,0,0,.75),0 0 30px rgba(127,233,216,.08)",
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
            borderBottom: "1px solid rgba(127,233,216,.16)",
            flex: "none",
          }}
        >
          <svg
            viewBox="0 0 24 24"
            width="17"
            height="17"
            fill="none"
            stroke="#7fe9d8"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            style={{ flex: "none" }}
          >
            <circle cx="12" cy="12" r="3.2" />
            <path d="M12 3.3v2.4M12 18.3v2.4M20.7 12h-2.4M5.7 12H3.3M18.16 5.84l-1.7 1.7M7.54 16.46l-1.7 1.7M18.16 18.16l-1.7-1.7M7.54 7.54l-1.7-1.7" />
          </svg>
          <span style={{ fontSize: 9.5, letterSpacing: 2.5, color: "#3c544f" }}>
            CONFIGURE
          </span>
          <span
            style={{ fontSize: 15, color: "#dff8f2", letterSpacing: ".5px" }}
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

        {/* Body */}
        <div
          className="mscroll"
          style={{ flex: 1, overflowY: "auto", padding: 18 }}
        >
          <div
            style={{
              fontSize: 9.5,
              letterSpacing: 1.5,
              color: "#3c544f",
              marginBottom: 10,
            }}
          >
            WORKSPACE ROOT · where projects are scanned
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <span
              style={{
                fontSize: 14,
                color: "#7fe9d8",
                flex: "none",
                fontFamily: "'JetBrains Mono',monospace",
              }}
            >
              ⌂
            </span>
            <input
              value={wsRoot}
              disabled
              style={{
                flex: 1,
                minWidth: 0,
                background: "rgba(7,13,13,.6)",
                border: "1px solid rgba(127,233,216,.18)",
                outline: "none",
                color: "#dff8f2",
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
                border: "1px solid rgba(127,233,216,.3)",
                background: rescanHover
                  ? "rgba(127,233,216,.16)"
                  : "rgba(127,233,216,.06)",
                color: "#bfe6de",
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
              color: "#3c544f",
              margin: "20px 0 10px",
            }}
          >
            PROJECT PATHS &amp; RUN COMMANDS · {projects.length} found
          </div>
          <div style={{ border: "1px solid rgba(127,233,216,.12)" }}>
            {projects.map((p, i) => (
              <div
                key={i}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 11,
                  padding: "11px 13px",
                  borderBottom: "1px solid rgba(127,233,216,.07)",
                }}
              >
                <span
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: "50%",
                    background: p.dotColor,
                    flex: "none",
                  }}
                ></span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span
                      style={{
                        fontSize: 12,
                        color: "#dff8f2",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {p.name}
                    </span>
                    <span
                      style={{
                        fontSize: 8.5,
                        letterSpacing: ".5px",
                        color: p.tagColor,
                        border: `1px solid ${p.tagColor}`,
                        padding: "0 5px",
                        flex: "none",
                      }}
                    >
                      {p.tag}
                    </span>
                  </div>
                  <div
                    style={{
                      fontSize: 10,
                      color: "#6f938d",
                      fontFamily: "'JetBrains Mono',monospace",
                      marginTop: 3,
                      whiteSpace: "nowrap",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      direction: "rtl",
                      textAlign: "left",
                    }}
                  >
                    {p.path}
                  </div>
                </div>
                <div
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    flex: "none",
                    background: "rgba(7,13,13,.6)",
                    border: "1px solid rgba(127,233,216,.14)",
                    padding: "5px 8px",
                  }}
                >
                  <span
                    style={{
                      fontSize: 11,
                      color: "#b9a6ff",
                      fontFamily: "'JetBrains Mono',monospace",
                    }}
                  >
                    $
                  </span>
                  <span
                    style={{
                      fontSize: 11,
                      color: "#9fc7c0",
                      fontFamily: "'JetBrains Mono',monospace",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {p.runCmd}
                  </span>
                </div>
              </div>
            ))}
          </div>
          <div
            style={{
              fontSize: 9,
              letterSpacing: ".5px",
              color: "#456b65",
              marginTop: 7,
            }}
          >
            Run commands are auto-detected from each repo's outer package.json —
            override per project in Analyze ▸ Overview.
          </div>

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
                  color: "#3c544f",
                  marginBottom: 10,
                }}
              >
                BRIDGE
              </div>
              <div
                style={{
                  border: "1px solid rgba(127,233,216,.12)",
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
                    style={{ fontSize: 10, letterSpacing: 1, color: "#6f938d" }}
                  >
                    HOST
                  </span>
                  <span style={{ fontSize: 11, color: "#bfe6de" }}>{host}</span>
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
                    style={{ fontSize: 10, letterSpacing: 1, color: "#6f938d" }}
                  >
                    PORT
                  </span>
                  <input
                    value={port}
                    readOnly
                    style={{
                      width: 88,
                      textAlign: "right",
                      background: "rgba(7,13,13,.6)",
                      border: "1px solid rgba(127,233,216,.18)",
                      outline: "none",
                      color: "#dff8f2",
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
                    style={{ fontSize: 10, letterSpacing: 1, color: "#6f938d" }}
                  >
                    STATUS
                  </span>
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 6,
                      fontSize: 10,
                      color: "#8fd9a8",
                    }}
                  >
                    <span
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: "50%",
                        background: "#8fd9a8",
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
                  color: "#3c544f",
                  marginBottom: 10,
                }}
              >
                SESSION DEFAULTS
              </div>
              <div
                style={{
                  border: "1px solid rgba(127,233,216,.12)",
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
                      color: "#6f938d",
                      marginBottom: 6,
                    }}
                  >
                    MODEL
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: 2,
                      border: "1px solid rgba(127,233,216,.2)",
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
                            background: active ? "#7fe9d8" : "transparent",
                            color: active ? "#06100e" : "#bfe6de",
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
                      color: "#6f938d",
                      marginBottom: 6,
                    }}
                  >
                    PERMISSION MODE
                  </div>
                  <div
                    style={{
                      display: "flex",
                      gap: 2,
                      border: "1px solid rgba(127,233,216,.2)",
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
                            background: active ? "#7fe9d8" : "transparent",
                            color: active ? "#06100e" : "#bfe6de",
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
              onClick={onOpenTheme}
              onMouseEnter={() => setThemeHover(true)}
              onMouseLeave={() => setThemeHover(false)}
              style={{
                appearance: "none",
                cursor: "pointer",
                border: "1px solid rgba(127,233,216,.25)",
                background: themeHover ? "rgba(127,233,216,.08)" : "transparent",
                color: "#bfe6de",
                fontFamily: "inherit",
                fontSize: 10,
                letterSpacing: 1.5,
                padding: "9px 14px",
              }}
            >
              THEME &amp; CRT ▸
            </button>
            <button
              onClick={onClose}
              onMouseEnter={() => setDoneHover(true)}
              onMouseLeave={() => setDoneHover(false)}
              style={{
                appearance: "none",
                cursor: "pointer",
                border: "1px solid #7fe9d8",
                background: doneHover
                  ? "rgba(127,233,216,.22)"
                  : "rgba(127,233,216,.12)",
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
