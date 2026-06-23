import { useEffect, useState } from "react";

const SPIN = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PHRASES = [
  "PROCESSING",
  "READING CONTEXT",
  "REASONING",
  "RUNNING TOOLS",
  "SYNTHESIZING",
  "COMPOSING RESPONSE",
  "ALIGNING TOKENS",
];

/** Animated "agent is working" line for the HUD terminal — a braille spinner,
 *  cycling status phrases, a live equalizer, and an elapsed counter. */
export function WorkingIndicator() {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 90);
    return () => clearInterval(id);
  }, []);

  const frame = SPIN[tick % SPIN.length];
  const elapsed = Math.floor((tick * 90) / 1000);
  const phrase = PHRASES[Math.floor(tick / 20) % PHRASES.length];

  return (
    <div className="my-2 ml-[18px] flex items-center gap-3 border border-border bg-[var(--ac-03)] px-3 py-2">
      <span className="text-[14px] leading-none text-primary">{frame}</span>
      <span className="glow text-[11px] tracking-[2.5px] text-primary">{phrase}</span>
      <span className="text-[11px] tracking-[2px] text-muted-2">{".".repeat(1 + (tick % 3))}</span>
      <span className="flex h-3 items-end gap-[2px]">
        {[0, 1, 2, 3, 4].map((b) => (
          <span
            key={b}
            className="w-[2px] origin-bottom bg-primary"
            style={{ height: "100%", animation: `eqbar .9s ease-in-out ${b * 0.12}s infinite` }}
          />
        ))}
      </span>
      <span className="ml-auto font-mono text-[10px] tracking-[1px] text-muted-2">{elapsed}s</span>
      <span
        className="inline-block h-[12px] w-[7px] bg-primary"
        style={{ animation: "caret 1.05s steps(1) infinite" }}
      />
    </div>
  );
}
