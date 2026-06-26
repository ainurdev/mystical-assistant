import { useState } from "react";

export interface StatusBarProps {
  mount: string;
  usedPct: number;
  repo: string;
  changes: number;
  onPalette: () => void;
}

export function StatusBar(props: StatusBarProps) {
  const { mount, usedPct, repo, changes, onPalette } = props;
  const [hovered, setHovered] = useState(false);

  return (
    <div
      style={{
        flex: "none",
        display: "flex",
        alignItems: "center",
        gap: "16px",
        padding: "8px 16px",
        borderTop: "1px solid rgba(127,233,216,.14)",
        fontSize: "10px",
        letterSpacing: "1.5px",
        color: "#3c544f",
        animation: "enterUp .55s cubic-bezier(.2,.8,.2,1) both .36s",
      }}
    >
      <span style={{ color: "#6f938d" }}>
        MOUNT <span style={{ color: "#7fe9d8" }}>{mount}</span>
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: "7px" }}>
        USED {usedPct}%
        <span
          style={{
            width: "120px",
            height: "4px",
            background: "rgba(127,233,216,.12)",
            display: "inline-block",
            position: "relative",
            overflow: "hidden",
          }}
        >
          <span
            style={{
              position: "absolute",
              left: 0,
              top: 0,
              bottom: 0,
              width: `${usedPct}%`,
              background: "#7fe9d8",
              animation: "grow 1.2s ease both .4s",
            }}
          />
        </span>
      </span>
      <span style={{ flex: 1 }} />
      <span>
        REPO <span style={{ color: "#bfe6de" }}>{repo}</span>
      </span>
      <span style={{ color: "#e3c279" }}>{changes} CHANGES</span>
      <button
        onClick={onPalette}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          appearance: "none",
          cursor: "pointer",
          border: "1px solid rgba(127,233,216,.22)",
          background: hovered ? "rgba(127,233,216,.08)" : "transparent",
          color: hovered ? "#bfe6de" : "#6f938d",
          fontFamily: "inherit",
          fontSize: "10px",
          letterSpacing: "1.5px",
          padding: "4px 11px",
        }}
      >
        ⌘K COMMAND
      </button>
    </div>
  );
}
