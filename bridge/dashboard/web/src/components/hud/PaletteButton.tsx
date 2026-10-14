import { useState } from "react";

/** ⌘K at the foot of the right rail, under UPDATE. It used to sit in a 34px
 *  footer track of its own under the side columns, alongside the usage meter
 *  and the branch chain; those moved out (the composer's AGENT picker, the
 *  header's GitPopover) and the track went with them, handing its height
 *  back to the transcript. */
export function PaletteButton({ onPalette }: { onPalette: () => void }) {
  const [hovered, setHovered] = useState(false);
  return (
    <div className="flex h-[38px] items-center justify-center">
      <button
        onClick={onPalette}
        title="⌘K — command palette"
        aria-label="Command palette"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          appearance: "none",
          cursor: "pointer",
          width: 26,
          height: 22,
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          border: "1px solid color-mix(in srgb, var(--acc) 22%, transparent)",
          background: hovered ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent",
          color: hovered ? "var(--txb)" : "var(--txm)",
          fontFamily: "var(--mono)",
          fontSize: "var(--t10)",
          letterSpacing: "normal",
          padding: 0,
        }}
      >
        ⌘K
      </button>
    </div>
  );
}
