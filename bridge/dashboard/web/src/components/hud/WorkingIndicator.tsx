import { useEffect, useRef, useState } from "react";
import { themeCompensator, themeUnfilter, type HudSettings } from "../../lib/theme";
import { nyanGif, nyanLook, nyanTrack, type NyanMode } from "../../lib/nyan";
import { PianoIndicator } from "./PianoIndicator";
import { TilesIndicator } from "./TilesIndicator";

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
 *  form: the stock braille spinner + equalizer, a nyan.cat ride, a playable
 *  piano, or a game of piano tiles. All of them share the tick, the cycling
 *  phrase and the elapsed count. */
export function WorkingIndicator({ hud }: { hud?: HudSettings }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), 90);
    return () => clearInterval(id);
  }, []);

  const frame = SPIN[tick % SPIN.length];
  const elapsed = Math.floor((tick * 90) / 1000);
  const phrase = PHRASES[Math.floor(tick / 20) % PHRASES.length];

  if (hud?.indicator === "nyan") {
    return <NyanIndicator hud={hud} mode={hud.nyan} phrase={phrase} elapsed={elapsed} />;
  }
  if (hud?.indicator === "piano") {
    return <PianoIndicator hud={hud} phrase={phrase} elapsed={elapsed} />;
  }
  if (hud?.indicator === "tiles") {
    return <TilesIndicator hud={hud} phrase={phrase} elapsed={elapsed} />;
  }

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

/** The nyan.cat variant: the chosen cat over its proper sky, with its looping
 *  track. `nyanExtra` upgrades the stock scrolling starfield to the full ride —
 *  the cat flies the bar trailing nyan.cat's CSS rainbow through its pixel
 *  stars. Assets are hotlinked from www.nyan.cat. */
function NyanIndicator({
  hud,
  mode,
  phrase,
  elapsed,
}: {
  hud: HudSettings;
  mode: NyanMode;
  phrase: string;
  elapsed: number;
}) {
  const look = nyanLook(mode);
  const track = nyanTrack(mode, hud.nyanSound);
  const audio = useRef<HTMLAudioElement | null>(null);
  // The whole HUD runs through the theme's CSS filter, so nyan.cat's colours
  // are pre-corrected the same way the theme cards are; the GIF's pixels can
  // only be fixed with the inverse filter.
  const comp = themeCompensator(hud.theme);
  const unfilter = themeUnfilter(hud.theme);

  // Volume is a property, not an attribute — React won't set it from JSX.
  // play() can reject when the tab hasn't been interacted with; that's fine.
  useEffect(() => {
    const el = audio.current;
    if (!el) return;
    el.volume = hud.nyanVolume;
    el.play().catch(() => {});
  }, [track, hud.nyanVolume]);

  const cat = (h: number) => (
    <img
      src={nyanGif(mode)}
      alt="nyan cat"
      className="flex-none"
      style={{ height: h, imageRendering: "pixelated", filter: unfilter }}
    />
  );
  // `push` sends the elapsed counter to the far edge; the flying variant instead
  // keeps the whole readout together on the right, off the rainbow.
  const readout = (push: boolean) => (
    <>
      <span className="text-[11px] tracking-[2.5px] text-white/85 [text-shadow:0_1px_2px_#000]">
        {phrase}
      </span>
      <span
        className={`flex-none font-mono text-[10px] tracking-[1px] text-white/70 [text-shadow:0_1px_2px_#000] ${push ? "ml-auto" : ""}`}
      >
        {elapsed}s
      </span>
    </>
  );

  if (!hud.nyanExtra) {
    return (
      <div
        className="nyan-sky my-2 ml-[18px] flex items-center gap-3 overflow-hidden border border-border px-3 py-2"
        style={{ backgroundColor: comp(look.sky) }}
      >
        {cat(34)}
        {readout(true)}
      </div>
    );
  }

  const stripes = look.waves.map(comp);
  return (
    <div className="nyan-stage my-2 ml-[18px] border border-border" style={{ backgroundColor: comp(look.sky) }}>
      {look.star &&
        STARS.map((s, i) => (
          <span
            key={i}
            className="nyan-star"
            aria-hidden
            style={{
              fontSize: s.fs,
              top: s.top,
              color: comp(look.star as string),
              animationDuration: `0.66s, ${s.drift}s`,
              animationDelay: `0s, ${s.delay}s`,
            }}
          />
        ))}
      <div className="nyan-ride">
        {/* ponytail: the trail is centred on the bar rather than using each
            cat's own `.nyan-cat` margin offsets — those are tuned for
            nyan.cat's 200px stage and would throw the cat out of a HUD row. */}
        {!look.noTrail && (
          <div className="nyan-trail" aria-hidden>
            {Array.from({ length: 62 }, (_, i) => (
              <span key={i}>
                {stripes.map((c, j) => (
                  <i key={j} style={{ background: c }} />
                ))}
              </span>
            ))}
          </div>
        )}
        {cat(40)}
      </div>
      {/* Right-aligned: the rainbow owns the left of the bar. */}
      <div className="pointer-events-none absolute inset-0 flex items-center justify-end gap-3 px-3">
        {readout(false)}
      </div>
      {track && <audio ref={audio} src={track} loop autoPlay />}
    </div>
  );
}
