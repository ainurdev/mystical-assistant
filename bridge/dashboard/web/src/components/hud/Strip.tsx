import { useState } from "react";

export interface StripProps {
  radio: { playing: boolean; title: string; artist: string; elapsed: string };
  onToggleRadio: () => void;
  onNextRadio: () => void;
  onOpenSettings: () => void;
}

export function Strip(props: StripProps) {
  const { radio, onToggleRadio, onNextRadio, onOpenSettings } = props;
  const [nextHover, setNextHover] = useState(false);
  const [gearHover, setGearHover] = useState(false);

  return (
    <div
      style={{
        flex: "none",
        display: "flex",
        alignItems: "center",
        gap: "11px",
        padding: "7px 16px",
        borderBottom: "1px solid rgba(127,233,216,.14)",
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
          stroke="#7fe9d8"
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
          stroke="#7fe9d8"
          strokeWidth="3"
          style={{ transformOrigin: "50px 50px", transform: "rotate(45deg)" }}
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
      <span
        style={{ fontSize: "12px", letterSpacing: "3px", color: "#7fe9d8" }}
        className="glow"
      >
        MYSTICAL//ASSISTANT
      </span>
      <span style={{ fontSize: "11px", letterSpacing: "2px", color: "#3c544f" }}>
        REMOTE DEV BRIDGE
      </span>
      <span style={{ flex: 1 }}></span>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "8px",
          border: "1px solid rgba(127,233,216,.18)",
          background: "rgba(7,13,13,.45)",
          padding: "3px 5px 3px 7px",
          width: "248px",
          flex: "none",
        }}
      >
        <button
          onClick={onToggleRadio}
          title="Claude FM"
          style={{
            appearance: "none",
            cursor: "pointer",
            border: 0,
            background: "transparent",
            color: "#7fe9d8",
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
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0, flex: 1 }}>
          <div style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <span
              style={{ fontSize: "7.5px", letterSpacing: "1.5px", color: "#7fe9d8", flex: "none" }}
            >
              CLAUDE·FM
            </span>
            {radio.playing && (
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "flex-end",
                  gap: "1.5px",
                  height: "8px",
                  flex: "none",
                }}
              >
                <span
                  style={{
                    width: "2px",
                    height: "8px",
                    background: "#8fd9a8",
                    transformOrigin: "bottom",
                    animation: "eqbar .8s ease-in-out infinite",
                  }}
                ></span>
                <span
                  style={{
                    width: "2px",
                    height: "8px",
                    background: "#8fd9a8",
                    transformOrigin: "bottom",
                    animation: "eqbar .8s ease-in-out infinite .18s",
                  }}
                ></span>
                <span
                  style={{
                    width: "2px",
                    height: "8px",
                    background: "#8fd9a8",
                    transformOrigin: "bottom",
                    animation: "eqbar .8s ease-in-out infinite .36s",
                  }}
                ></span>
              </span>
            )}
            <span style={{ flex: 1 }}></span>
            <span
              style={{
                fontSize: "7.5px",
                color: "#456b65",
                flex: "none",
                fontFamily: "'JetBrains Mono',monospace",
              }}
            >
              {radio.elapsed}
            </span>
          </div>
          <div
            style={{
              fontSize: "10px",
              color: "#bfe6de",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              marginTop: "1px",
              lineHeight: 1.3,
            }}
          >
            {radio.title} <span style={{ color: "#5a6f6a" }}>· {radio.artist}</span>
          </div>
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
            color: nextHover ? "#dff8f2" : "#9fc7c0",
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
        style={{ width: "1px", height: "18px", background: "rgba(127,233,216,.18)" }}
      ></span>
      <button
        onClick={onOpenSettings}
        title="dashboard settings"
        onMouseEnter={() => setGearHover(true)}
        onMouseLeave={() => setGearHover(false)}
        style={{
          appearance: "none",
          cursor: "pointer",
          border: "1px solid rgba(127,233,216,.25)",
          background: gearHover ? "rgba(127,233,216,.08)" : "transparent",
          color: gearHover ? "#dff8f2" : "#9fc7c0",
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
