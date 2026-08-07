import { useState } from "react";
import { KEYS } from "../../lib/piano";
import type { HudSettings } from "../../lib/theme";
import { PianoKeyboard } from "./PianoKeyboard";
import { usePianoEngine } from "./usePianoEngine";

/** Something to do while the agent thinks: a playable two-octave keyboard.
 *  Keystrokes are only captured while the board has focus, so typing the next
 *  prompt in the composer never turns into a chord. */
export function PianoIndicator({
  hud,
  phrase,
  elapsed,
}: {
  hud: HudSettings;
  phrase: string;
  elapsed: number;
}) {
  const { held, noteOn, noteOff, allOff, status } = usePianoEngine(hud);
  const [live, setLive] = useState(false);

  return (
    <div className="my-2 ml-[18px] flex items-stretch gap-3 border border-border bg-[var(--ac-03)] p-2">
      <PianoKeyboard
        held={held}
        onPress={noteOn}
        onRelease={noteOff}
        onLive={(v) => {
          setLive(v);
          if (!v) allOff();
        }}
      />

      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
        <div className="flex items-center gap-2">
          <span className="glow text-[length:var(--t11)] tracking-[2.5px] text-primary">{phrase}</span>
          <span className="ml-auto font-mono text-[length:var(--t10)] tracking-[1px] text-muted-2">{elapsed}s</span>
        </div>
        <div className="flex items-center gap-2 text-[length:var(--t9)] tracking-[1.5px]">
          <span className={live ? "text-primary" : "text-muted-2"}>{live ? "● LIVE" : "○ CLICK TO PLAY"}</span>
          <span className="truncate text-muted-2">
            {held.length
              ? held.map((m) => KEYS.find((k) => k.midi === m)?.name).join(" ")
              : (status ?? "ZSXDCVGBHNJM · Q2W3ER5T6Y7U")}
          </span>
        </div>
      </div>
    </div>
  );
}
