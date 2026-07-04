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
        borderTop: "1px solid color-mix(in srgb, var(--acc) 14%, transparent)",
        fontSize: "10px",
        letterSpacing: "1.5px",
        color: "var(--txl)",
        animation: "enterUp .55s cubic-bezier(.2,.8,.2,1) both .36s",
      }}
    >
      <span style={{ color: "var(--txd)" }}>
        MOUNT <span style={{ color: "var(--acc)" }}>{mount}</span>
      </span>
      <span style={{ display: "flex", alignItems: "center", gap: "7px" }}>
        USED {usedPct}%
        <span
          style={{
            width: "120px",
            height: "4px",
            background: "color-mix(in srgb, var(--acc) 12%, transparent)",
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
              background: "var(--acc)",
              animation: "grow 1.2s ease both .4s",
            }}
          />
        </span>
      </span>
      <span style={{ flex: 1 }} />
      <span>
        REPO <span style={{ color: "var(--tx)" }}>{repo}</span>
      </span>
      <span style={{ color: "var(--warn)" }}>{changes} CHANGES</span>
      <button
        onClick={onPalette}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          appearance: "none",
          cursor: "pointer",
          border: "1px solid color-mix(in srgb, var(--acc) 22%, transparent)",
          background: hovered ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent",
          color: hovered ? "var(--tx)" : "var(--txd)",
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
