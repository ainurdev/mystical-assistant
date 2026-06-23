/** The Mystical emblem: a slowly-spinning dashed ring, a diamond, and a violet
 *  core. Strokes follow the active phosphor accent; the core stays violet. */
export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg viewBox="0 0 100 100" width={size} height={size} className="flex-none overflow-visible">
      <circle
        cx="50"
        cy="50"
        r="40"
        fill="none"
        strokeWidth="3"
        strokeDasharray="7 11"
        className="stroke-primary"
        style={{ transformOrigin: "50px 50px", animation: "introspin 12s linear infinite" }}
      />
      <rect
        x="30"
        y="30"
        width="40"
        height="40"
        fill="none"
        strokeWidth="3"
        className="stroke-primary"
        style={{ transformOrigin: "50px 50px", transform: "rotate(45deg)" }}
      />
      <rect
        x="41"
        y="41"
        width="18"
        height="18"
        className="fill-violet"
        style={{ transformOrigin: "50px 50px", transform: "rotate(45deg)" }}
      />
    </svg>
  );
}
