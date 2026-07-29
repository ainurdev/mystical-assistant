import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type RefObject,
} from "react";
import {
  BY_CHAR,
  KEYS,
  MAX_HOLD,
  WHITE_COUNT,
  freqOf,
  sampleUrl,
  voiceOf,
  whiteIndex,
} from "../../lib/piano";
import type { HudSettings } from "../../lib/theme";

const WHITE_W = 17;
const BLACK_W = 11;
const H = 46;

interface Held {
  /** Sampled notes stop the buffer source; synth notes stop their oscillators. */
  stop: (at: number) => void;
  env: GainNode;
  release: number; // captured at note-on, so changing voice mid-note is safe
}

/** Sample-set load state, per voice. `null` = this voice is pure synth. */
type Load = { done: number; total: number; failed: boolean } | null;

/** Loudest sample in the buffer. The soundfont is mastered far below full
 *  scale (it's meant to be mixed 128 channels deep), so without measuring it
 *  a sampled voice lands ~8x quieter than a synth one and switching between
 *  the two groups jumps the volume. */
function peakOf(buf: AudioBuffer): number {
  let peak = 0;
  for (let ch = 0; ch < buf.numberOfChannels; ch++) {
    const data = buf.getChannelData(ch);
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
  }
  return peak;
}

/** Harmonic table → PeriodicWave, cached per voice: the table is fixed, and
 *  rebuilding it on every keypress is pure waste. */
function periodicWave(
  ctx: AudioContext,
  cache: Map<string, PeriodicWave>,
  key: string,
  partials: number[],
): PeriodicWave {
  const hit = cache.get(key);
  if (hit) return hit;
  // Index 0 is DC and must stay silent; harmonic N lives at index N.
  const real = new Float32Array(partials.length + 1);
  const imag = new Float32Array(partials.length + 1);
  partials.forEach((amp, i) => (imag[i + 1] = amp));
  const wave = ctx.createPeriodicWave(real, imag); // normalised to peak 1 by default
  cache.set(key, wave);
  return wave;
}

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
  const [held, setHeld] = useState<number[]>([]);
  const [live, setLive] = useState(false);
  const [load, setLoad] = useState<Load>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const voices = useRef(new Map<number, Held>());
  const waves = useRef(new Map<string, PeriodicWave>());
  const buffers = useRef(new Map<string, AudioBuffer>()); // "<gm>/<midi>" → decoded note
  const makeup = useRef(new Map<string, number>()); // gm → gain that matches the synth's level
  const dragging = useRef(false);
  // Read in callbacks that outlive a render, so a mid-note settings change
  // doesn't need to re-bind anything.
  const cfg = useRef(hud);
  cfg.current = hud;

  // Pull the whole 25-note set for a sampled voice up front. Until it lands the
  // synth fallback plays, so the board is never dead — and if the fetch fails
  // (offline, CDN down) it simply stays on the fallback.
  useEffect(() => {
    const v = voiceOf(hud.pianoVoice);
    if (!v.gm) {
      setLoad(null);
      return;
    }
    const gm = v.gm;
    if (KEYS.every((k) => buffers.current.has(`${gm}/${k.midi}`))) {
      setLoad({ done: KEYS.length, total: KEYS.length, failed: false });
      return;
    }
    const abort = new AbortController();
    let done = 0;
    let failed = false;
    let loudest = 0;
    setLoad({ done: 0, total: KEYS.length, failed: false });
    // decodeAudioData needs a context; reuse the playback one if it exists.
    const ctx = (ctxRef.current ??= new AudioContext());
    void Promise.all(
      KEYS.map(async (k) => {
        const id = `${gm}/${k.midi}`;
        if (buffers.current.has(id)) return;
        try {
          const res = await fetch(sampleUrl(gm, k.midi), { signal: abort.signal });
          if (!res.ok) throw new Error(String(res.status));
          const buf = await ctx.decodeAudioData(await res.arrayBuffer());
          buffers.current.set(id, buf);
          loudest = Math.max(loudest, peakOf(buf));
        } catch {
          // One missing note (cello and fiddle each lack one upstream) just
          // falls through to the synth for that key.
          failed = true;
        } finally {
          if (!abort.signal.aborted) setLoad({ done: ++done, total: KEYS.length, failed });
        }
      }),
    ).then(() => {
      // Normalise the voice off its loudest note, so relative dynamics between
      // notes survive. The soundfont peaks around 0.1, so this is ~10x. Capped,
      // or a near-silent set would just amplify hiss.
      if (loudest > 0) makeup.current.set(gm, Math.min(24, 1 / loudest));
    });
    return () => abort.abort();
  }, [hud.pianoVoice]);

  const noteOn = useCallback((midi: number) => {
    if (voices.current.has(midi)) return;
    // Created on the first note: an AudioContext made before a user gesture
    // starts suspended.
    const ctx = (ctxRef.current ??= new AudioContext());
    if (ctx.state === "suspended") void ctx.resume();
    const picked = voiceOf(cfg.current.pianoVoice);
    const buf = picked.gm ? buffers.current.get(`${picked.gm}/${midi}`) : undefined;
    const t = ctx.currentTime;

    // A real recording: play the note back as-is, no pitch shifting — the set
    // has one file per key. Only the release ramp is ours.
    if (buf) {
      const env = ctx.createGain();
      // Same target level as the synth path, so switching groups doesn't jump.
      // The gain is deliberately >1: these buffers peak around 0.1, and since
      // `makeup <= 1/loudest`, output still lands at or under the synth target.
      const level = cfg.current.pianoVolume * 0.5 * (makeup.current.get(picked.gm as string) ?? 1);
      env.gain.setValueAtTime(Math.max(0.0001, level), t);
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.connect(env).connect(ctx.destination);
      src.start(t);
      src.onended = () => {
        if (voices.current.get(midi)?.env === env) voices.current.delete(midi);
        setHeld((h) => h.filter((m) => m !== midi));
      };
      voices.current.set(midi, { stop: (at) => src.stop(at), env, release: picked.r });
      setHeld((h) => (h.includes(midi) ? h : [...h, midi]));
      return;
    }

    // Synth: either a SYNTH voice, or standing in for samples still in flight.
    const v = picked.gm ? voiceOf(picked.fallback ?? "grand") : picked;

    // oscillators → envelope → [lowpass] → out
    const env = ctx.createGain();
    let tail: AudioNode = env;
    if (v.cutoff) {
      const lp = ctx.createBiquadFilter();
      lp.type = "lowpass";
      lp.frequency.value = v.cutoff;
      env.connect(lp);
      tail = lp;
    }
    tail.connect(ctx.destination);

    const wave = v.partials ? periodicWave(ctx, waves.current, v.key, v.partials) : null;
    const spread = v.detune ?? [0];
    const oscs = spread.map((cents) => {
      const osc = ctx.createOscillator();
      if (wave) osc.setPeriodicWave(wave);
      else osc.type = v.wave ?? "triangle";
      osc.frequency.value = freqOf(midi);
      osc.detune.value = cents;
      osc.connect(env);
      osc.start(t);
      return osc;
    });

    // One LFO for the whole note, wired into every unison voice's detune.
    let lfo: OscillatorNode | null = null;
    if (v.vibrato) {
      lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = v.vibrato.hz;
      depth.gain.value = v.vibrato.cents;
      lfo.connect(depth);
      for (const osc of oscs) depth.connect(osc.detune);
      lfo.start(t);
    }

    // ADSR. `s === 0` is a struck string: it decays to silence with the key
    // still down, and the release only matters if you lift early.
    const peak =
      Math.max(0.0004, cfg.current.pianoVolume * 0.5 * (v.gain ?? 1)) / Math.sqrt(spread.length);
    const floor = 0.0001;
    env.gain.setValueAtTime(floor, t);
    env.gain.exponentialRampToValueAtTime(peak, t + v.a);
    env.gain.exponentialRampToValueAtTime(Math.max(peak * v.s, floor), t + v.a + v.d);

    // Percussive voices free themselves; sustaining ones are capped so a missed
    // key-up can't leak an oscillator.
    const stopAt = v.s > 0 ? t + MAX_HOLD : t + v.a + v.d + v.r;
    for (const osc of oscs) osc.stop(stopAt);
    lfo?.stop(stopAt);
    oscs[0].onended = () => {
      if (voices.current.get(midi)?.env === env) voices.current.delete(midi);
      setHeld((h) => h.filter((m) => m !== midi));
    };

    voices.current.set(midi, {
      stop: (at) => {
        for (const osc of oscs) osc.stop(at);
        lfo?.stop(at);
      },
      env,
      release: v.r,
    });
    setHeld((h) => (h.includes(midi) ? h : [...h, midi]));
  }, []);

  const noteOff = useCallback((midi: number) => {
    setHeld((h) => h.filter((m) => m !== midi));
    const v = voices.current.get(midi);
    const ctx = ctxRef.current;
    if (!v || !ctx) return;
    voices.current.delete(midi);
    const t = ctx.currentTime;
    // Damp from wherever the envelope currently is, not from the peak.
    v.env.gain.cancelScheduledValues(t);
    v.env.gain.setValueAtTime(Math.max(v.env.gain.value, 0.0001), t);
    v.env.gain.exponentialRampToValueAtTime(0.0001, t + v.release);
    v.stop(t + v.release + 0.01);
  }, []);

  // Releasing outside the board would otherwise leave a key stuck down.
  useEffect(() => {
    const up = () => {
      dragging.current = false;
    };
    window.addEventListener("pointerup", up);
    return () => {
      window.removeEventListener("pointerup", up);
      void ctxRef.current?.close(); // kills every scheduled voice with it
    };
  }, []);

  // While samples stream in, say so — the fallback synth is audible meanwhile,
  // and a voice that never finishes should read as degraded, not broken.
  const status = !load
    ? "ZSXDCVGBHNJM · Q2W3ER5T6Y7U"
    : load.done < load.total
      ? `LOADING SAMPLES ${load.done}/${load.total}`
      : load.failed
        ? "SAMPLES INCOMPLETE · SYNTH FILLS IN"
        : "SAMPLES READY";

  return (
    <div className="my-2 ml-[18px] flex items-stretch gap-3 border border-border bg-[var(--ac-03)] p-2">
      <div
        role="application"
        aria-label="piano"
        tabIndex={0}
        // The keys preventDefault to stop text-selection drag, which also
        // suppresses the implicit focus — so take focus here, on the bubble.
        onPointerDown={(e) => e.currentTarget.focus()}
        onFocus={() => setLive(true)}
        onBlur={() => {
          setLive(false);
          for (const midi of voices.current.keys()) noteOff(midi);
        }}
        onKeyDown={(e) => {
          const midi = BY_CHAR[e.key.toLowerCase()];
          if (midi === undefined) return;
          e.preventDefault();
          if (!e.repeat) noteOn(midi);
        }}
        onKeyUp={(e) => {
          const midi = BY_CHAR[e.key.toLowerCase()];
          if (midi !== undefined) noteOff(midi);
        }}
        className="relative flex-none outline-none ring-primary focus-visible:ring-1"
        style={{ width: WHITE_COUNT * WHITE_W, height: H }}
      >
        {/* Whites lay out in a row; blacks straddle the seams above them. */}
        <div className="absolute inset-0 flex">
          {KEYS.filter((k) => !k.black).map((k) => (
            <Key key={k.midi} k={k} on={held.includes(k.midi)} noteOn={noteOn} noteOff={noteOff} dragging={dragging} />
          ))}
        </div>
        {KEYS.map((k, i) =>
          k.black ? (
            <Key
              key={k.midi}
              k={k}
              on={held.includes(k.midi)}
              noteOn={noteOn}
              noteOff={noteOff}
              dragging={dragging}
              left={whiteIndex(i) * WHITE_W - BLACK_W / 2}
            />
          ) : null,
        )}
      </div>

      <div className="flex min-w-0 flex-1 flex-col justify-center gap-1">
        <div className="flex items-center gap-2">
          <span className="glow text-[11px] tracking-[2.5px] text-primary">{phrase}</span>
          <span className="ml-auto font-mono text-[10px] tracking-[1px] text-muted-2">{elapsed}s</span>
        </div>
        <div className="flex items-center gap-2 text-[9px] tracking-[1.5px]">
          <span className={live ? "text-primary" : "text-muted-2"}>{live ? "● LIVE" : "○ CLICK TO PLAY"}</span>
          <span className="truncate text-muted-2">
            {held.length
              ? held.map((m) => KEYS.find((k) => k.midi === m)?.name).join(" ")
              : status}
          </span>
        </div>
      </div>
    </div>
  );
}

function Key({
  k,
  on,
  left,
  noteOn,
  noteOff,
  dragging,
}: {
  k: { midi: number; name: string; char: string; black: boolean };
  on: boolean;
  left?: number;
  noteOn: (m: number) => void;
  noteOff: (m: number) => void;
  dragging: RefObject<boolean>;
}) {
  const common = {
    title: `${k.name} · ${k.char.toUpperCase()}`,
    onPointerDown: (e: ReactPointerEvent) => {
      e.preventDefault(); // keep focus on the board so the keyboard stays live
      dragging.current = true;
      noteOn(k.midi);
    },
    onPointerEnter: () => dragging.current && noteOn(k.midi),
    onPointerUp: () => noteOff(k.midi),
    onPointerLeave: () => noteOff(k.midi),
  };
  if (k.black) {
    return (
      <span
        {...common}
        className="absolute top-0 z-10 cursor-pointer border border-black/70"
        style={{ left, width: BLACK_W, height: H * 0.62, background: on ? "var(--acc)" : "#14181a" }}
      />
    );
  }
  return (
    <span
      {...common}
      className="flex flex-1 cursor-pointer items-end justify-center border-r border-black/25 pb-[2px] text-[7px] leading-none last:border-r-0"
      style={{ background: on ? "var(--acc)" : "#e8eceb", color: on ? "var(--acc-on)" : "#8a9694" }}
    >
      {k.char.toUpperCase()}
    </span>
  );
}
