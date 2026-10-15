import { useEffect, useMemo, useRef, useState } from "react";
import type { TimedEvent } from "../../api";
import { type HudSettings } from "../../lib/theme";
import { workState, type WorkState } from "../../lib/workstate";

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

/** The "agent is working" line for the HUD terminal. `hud.indicator` picks the
 *  form: the stock braille spinner + equalizer, or STATUS, which drops the
 *  cycling phrase for what the turn is actually doing (lib/workstate). Both
 *  share the tick and the elapsed count. */
export function WorkingIndicator({
  hud,
  events,
  boot,
  started,
}: {
  hud?: HudSettings;
  /** The live turn's events. Absent on the trailing row, which has no turn. */
  events?: TimedEvent[];
  boot?: string | null;
  started?: number;
}) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 90);
    return () => clearInterval(id);
  }, []);
  const state = useMemo(() => (events ? workState(events, boot, started) : null), [events, boot, started]);

  const frame = SPIN[tick % SPIN.length];
  const elapsed = Math.floor((tick * 90) / 1000);
  const phrase = PHRASES[Math.floor(tick / 20) % PHRASES.length];

  if (hud?.indicator === "status") {
    return <StatusLine frame={frame} state={state} elapsed={elapsed} />;
  }

  return (
    <div className="my-2 ml-[18px] flex items-center gap-3 border border-border bg-[var(--ac-03)] px-3 py-2">
      <span className="text-[length:var(--t14)] leading-none text-primary">{frame}</span>
      <span className="glow text-[length:var(--t11)] tracking-[2.5px] text-primary">{phrase}</span>
      <span className="text-[length:var(--t11)] tracking-[2px] text-muted-2">{".".repeat(1 + (tick % 3))}</span>
      <span className="flex h-3 items-end gap-[2px]">
        {[0, 1, 2, 3, 4].map((b) => (
          <span
            key={b}
            className="w-[2px] origin-bottom bg-primary"
            style={{ height: "100%", animation: `eqbar .9s ease-in-out ${b * 0.12}s infinite` }}
          />
        ))}
      </span>
      <span className="ml-auto font-mono text-[length:var(--t10)] tracking-[1px] text-muted-2">{elapsed}s</span>
      <span
        className="inline-block h-[12px] w-[7px] bg-primary"
        style={{ animation: "caret 1.05s steps(1) infinite" }}
      />
    </div>
  );
}

/** The STATUS form: one bare line, no box and no bars. With no turn to read
 *  (`state` null) it can only say WORKING. */
function StatusLine({ frame, state, elapsed }: { frame: string; state: WorkState | null; elapsed: number }) {
  // Seconds in this state, on the store's clock so the count survives the row
  // remounting. The mount clock covers an event the store hasn't stamped yet.
  const secs = state?.since != null ? Math.max(0, Math.floor(Date.now() / 1000 - state.since)) : elapsed;
  return (
    <div className="my-1 ml-[18px] flex min-w-0 items-center gap-2.5 px-3 py-1">
      <span aria-hidden className="text-[length:var(--t14)] leading-none text-primary">{frame}</span>
      <span className="whitespace-nowrap text-[length:var(--t11)] uppercase tracking-[2.5px] text-primary">
        {state?.tag ?? "WORKING"}
      </span>
      {state?.detail && <span className="min-w-0 truncate text-muted-foreground">{state.detail}</span>}
      {!!state?.more && <span className="whitespace-nowrap text-[length:var(--t10)] text-muted-2">+{state.more}</span>}
      <span className="ml-auto whitespace-nowrap font-mono text-[length:var(--t10)] tracking-[1px] text-muted-2">
        {secs}s
      </span>
    </div>
  );
}

// Star field for the EXTRA ride: size (= the pixel-dot size), vertical seat, and
// how far into the drift each one starts, so the stream never bunches up.
const STARS = [
  { fs: 3, top: "14%", drift: 3.1, delay: -0.0 },
  { fs: 2, top: "62%", drift: 2.3, delay: -0.9 },
  { fs: 3, top: "84%", drift: 3.6, delay: -1.7 },
  { fs: 2, top: "34%", drift: 2.6, delay: -2.2 },
  { fs: 4, top: "50%", drift: 4.2, delay: -0.5 },
  { fs: 2, top: "8%", drift: 2.9, delay: -1.3 },
  { fs: 3, top: "72%", drift: 3.4, delay: -2.6 },
  { fs: 2, top: "26%", drift: 2.1, delay: -1.9 },
];
