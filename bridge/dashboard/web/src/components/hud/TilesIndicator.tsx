import { useEffect, useMemo, useRef, useState } from "react";
import { KEYS } from "../../lib/piano";
import { TRAVEL_MS, parseSong, songOf, type Note } from "../../lib/songs";
import type { HudSettings } from "../../lib/theme";
import { BOARD_W, PianoKeyboard, laneOf } from "./PianoKeyboard";
import { usePianoEngine } from "./usePianoEngine";

const FALL_H = 168; // height of the field a tile falls through
const HIT_MS = 130; // how early/late a press still counts
const GAP_UNITS = 8; // breather between loops, in sixteenths
const MIN_TILE = 7; // a sixteenth at speed FAST is only a few px — keep it tappable
const FLASH_MS = 130;

type Verdict = "hit" | "miss";

/** Piano Tiles: the melody falls down the lane of the key that plays it, and you
 *  clear each tile as it reaches the keyboard. Same board and same voice as the
 *  free-play piano — only the meaning of a keypress changes. */
export function TilesIndicator({
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
  const [score, setScore] = useState({ points: 0, combo: 0, best: 0, hits: 0, misses: 0 });
  const [flash, setFlash] = useState<Record<number, Verdict>>({});
  // Verdicts live in a ref because the rAF loop judges misses every frame;
  // `revision` just tells React that the ref changed and tiles need repainting.
  const verdicts = useRef<Record<number, Verdict>>({});
  const [revision, setRevision] = useState(0);

  const song = songOf(hud.tilesSong);
  const chart = useMemo(() => parseSong(song), [song]);
  const travel = TRAVEL_MS[hud.tilesSpeed];
  // Pixels per sixteenth, set so a tile takes exactly `travel` to cross the field.
  const unitPx = (FALL_H * chart.unitMs) / travel;
  const endMs = (chart.units + GAP_UNITS) * chart.unitMs;

  const sheet = useRef<HTMLDivElement | null>(null);
  // Offset by `travel` so the first note falls in from the top instead of
  // already sitting on the hit line at t=0.
  const start = useRef(0);
  const cursor = useRef(0); // notes before this index have been judged or passed

  const reset = () => {
    start.current = performance.now() + travel;
    cursor.current = 0;
    verdicts.current = {};
    setRevision((r) => r + 1);
  };

  // Restart the run whenever the chart or speed changes — the old positions and
  // verdicts refer to a layout that no longer exists.
  useEffect(reset, [chart, travel]);

  useEffect(() => {
    let raf = 0;
    const frame = () => {
      raf = requestAnimationFrame(frame);
      const songMs = performance.now() - start.current;
      // One transform for the whole sheet: 60fps with a single DOM write.
      if (sheet.current) {
        sheet.current.style.transform = `translate3d(0,${FALL_H + (songMs / chart.unitMs) * unitPx}px,0)`;
      }
      // Anything now past the late edge of its window and unjudged is a miss.
      let missed = 0;
      while (cursor.current < chart.notes.length) {
        const n = chart.notes[cursor.current];
        if (n.at * chart.unitMs + HIT_MS >= songMs) break;
        if (!verdicts.current[cursor.current]) {
          verdicts.current[cursor.current] = "miss";
          missed++;
        }
        cursor.current++;
      }
      if (missed) {
        setRevision((r) => r + 1);
        setScore((s) => ({ ...s, combo: 0, misses: s.misses + missed }));
      }
      if (songMs > endMs) reset();
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [chart, unitPx, endMs, travel]);

  /** A press both sounds the note and, if a tile is due, clears it. */
  const press = (midi: number) => {
    noteOn(midi);
    const songMs = performance.now() - start.current;
    let pick = -1;
    let closest = Infinity;
    // Only a handful of notes can be in the window; scan out from the cursor.
    for (let i = cursor.current; i < chart.notes.length; i++) {
      const n: Note = chart.notes[i];
      const delta = n.at * chart.unitMs - songMs;
      if (delta > HIT_MS) break;
      if (n.midi === midi && !verdicts.current[i] && Math.abs(delta) < closest) {
        closest = Math.abs(delta);
        pick = i;
      }
    }
    if (pick < 0) {
      // A wrong key still plays — it's a piano — but it breaks the streak.
      setScore((s) => ({ ...s, combo: 0 }));
      setFlash((f) => ({ ...f, [midi]: "miss" }));
    } else {
      verdicts.current[pick] = "hit";
      setRevision((r) => r + 1);
      setScore((s) => ({
        ...s,
        points: s.points + 10 + Math.min(s.combo, 20),
        combo: s.combo + 1,
        best: Math.max(s.best, s.combo + 1),
        hits: s.hits + 1,
      }));
      setFlash((f) => ({ ...f, [midi]: "hit" }));
    }
    setTimeout(
      () =>
        setFlash((f) => {
          const next = { ...f };
          delete next[midi];
          return next;
        }),
      FLASH_MS,
    );
  };

  const total = score.hits + score.misses;
  const accuracy = total ? Math.round((score.hits / total) * 100) : 100;

  return (
    <div className="my-2 ml-[18px] flex items-stretch gap-3 border border-border bg-[var(--ac-03)] p-2">
      <PianoKeyboard
        held={held}
        labels={false}
        onPress={press}
        onRelease={noteOff}
        onLive={(v) => {
          setLive(v);
          if (!v) allOff();
        }}
        tint={(midi) =>
          flash[midi] === "hit" ? "var(--acc)" : flash[midi] === "miss" ? "var(--err)" : undefined
        }
      >
        <div
          className="tiles-field relative overflow-hidden border-b border-primary"
          style={{ height: FALL_H, width: BOARD_W }}
        >
          {/* Lane guides, so a tile's column reads before it lands. */}
          {KEYS.filter((k) => !k.black).map((k) => (
            <span
              key={k.midi}
              className="absolute top-0 bottom-0 w-px bg-white/5"
              style={{ left: laneOf(k.midi).left }}
            />
          ))}
          <div ref={sheet} className="absolute top-0 left-0 will-change-transform">
            {chart.notes.map((n, i) => {
              const lane = laneOf(n.midi);
              const h = Math.max(MIN_TILE, n.dur * unitPx - 1);
              const v = verdicts.current[i];
              return (
                <span
                  key={i}
                  className={`tile absolute ${v ? `tile-${v}` : ""}`}
                  style={{
                    left: lane.left,
                    width: lane.width - 1,
                    height: h,
                    top: -n.at * unitPx - h,
                  }}
                  data-black={KEYS.find((k) => k.midi === n.midi)?.black ? "1" : undefined}
                />
              );
            })}
          </div>
        </div>
      </PianoKeyboard>

      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="glow text-[11px] tracking-[2.5px] text-primary">{phrase}</span>
          <span className="ml-auto font-mono text-[10px] tracking-[1px] text-muted-2">{elapsed}s</span>
        </div>

        <div className="text-[10px] leading-tight tracking-[1.5px] text-foreground-bright">
          {song.title}
        </div>
        <div className="text-[8.5px] tracking-[1px] text-muted-2">
          {song.composer} · {song.year} · PUBLIC DOMAIN
        </div>

        <div className="mt-1 font-mono text-[17px] leading-none text-primary">
          {score.points.toLocaleString()}
        </div>
        <div className="flex items-baseline gap-1">
          <span
            className="font-mono text-[13px] leading-none"
            style={{ color: score.combo >= 8 ? "var(--acc)" : "var(--txm)" }}
          >
            ×{score.combo}
          </span>
          <span className="text-[8px] tracking-[1px] text-muted-2">
            COMBO · BEST {score.best} · {accuracy}%
          </span>
        </div>

        <div className="mt-auto flex items-center gap-2 text-[9px] tracking-[1.5px]">
          <span className={live ? "text-primary" : "text-muted-2"}>
            {live ? "● LIVE" : "○ CLICK TO PLAY"}
          </span>
          <span className="truncate text-muted-2">{status ?? "HIT THE KEY AS ITS TILE LANDS"}</span>
        </div>
      </div>
    </div>
  );
}
