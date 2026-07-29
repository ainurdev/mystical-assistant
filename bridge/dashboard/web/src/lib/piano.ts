// A two-octave playable keyboard for the working indicator. Key chars follow
// the layout every DAW uses (zsxdcvgbhnjm / q2w3er5t6y7u), so muscle memory
// from Ableton/GarageBand transfers.
//
// Two sound sources, kept separate in the picker:
//   SAMPLES — real recordings, one MP3 per note, streamed on demand from
//             gleitz/midi-js-soundfonts (FluidR3_GM, CC-BY 3.0). Nothing is
//             bundled; only the chosen voice's notes are fetched, then cached.
//   SYNTH   — additive oscillators, hand-tuned per instrument. Works with no
//             network at all, and covers for a sampled voice until it loads.

const NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
const CHARS = "zsxdcvgbhnjmq2w3er5t6y7ui"; // C3 → C5, chromatic

export interface PianoKey {
  midi: number;
  name: string; // e.g. "F#3"
  char: string; // the computer key that plays it
  black: boolean;
}

export const KEYS: PianoKey[] = Array.from(CHARS, (char, i) => {
  const midi = 48 + i;
  const pitch = NAMES[midi % 12];
  return { midi, name: `${pitch}${Math.floor(midi / 12) - 1}`, char, black: pitch.length > 1 };
});

export const WHITE_COUNT = KEYS.filter((k) => !k.black).length;

/** How many white keys sit left of this one — where a black key straddles. */
export function whiteIndex(i: number): number {
  let n = 0;
  for (let j = 0; j < i; j++) if (!KEYS[j].black) n++;
  return n;
}

export const freqOf = (midi: number): number => 440 * 2 ** ((midi - 69) / 12);

// ---- voices -----------------------------------------------------------------
// Real instrument tone without shipping a single sample: each voice is a
// harmonic amplitude table fed to WebAudio's createPeriodicWave, plus the
// envelope and unison/vibrato that actually distinguish the families. A struck
// string decays with the key still down (sustain 0); an organ pipe or a bowed
// section holds (sustain > 0). Partial N of `partials` is harmonic N+1, so a
// zero leaves that harmonic out — which is how the organ drawbars work.

export interface Voice {
  key: string;
  label: string;
  group: string; // optgroup heading in the picker
  /** GM sample directory. Set = stream real recordings; the synth fields below
   *  then only serve as the offline fallback. */
  gm?: string;
  /** Synth voice to stand in for a sampled one until (or unless) it loads. */
  fallback?: string;
  partials?: number[]; // harmonic amplitudes, fundamental first
  wave?: OscillatorType; // raw oscillator instead of a partial table
  a: number; // attack, seconds
  d: number; // decay to `s`, seconds
  s: number; // sustain level, 0..1 of peak; 0 = percussive, decays to silence
  r: number; // release, seconds
  detune?: number[]; // unison voices, in cents
  vibrato?: { hz: number; cents: number };
  cutoff?: number; // lowpass, Hz
  gain?: number; // trim for the harmonically dense voices
}

const SYNTH: Voice[] = [
  // Struck strings and their keyboard cousins — fast attack, no sustain.
  { key: "grand", label: "GRAND PIANO", group: "SYNTH · CLASSIC", partials: [1, 0.42, 0.28, 0.16, 0.1, 0.06, 0.04, 0.025, 0.015, 0.01], a: 0.004, d: 2.6, s: 0, r: 0.35, cutoff: 6000 },
  { key: "upright", label: "UPRIGHT PIANO", group: "SYNTH · CLASSIC", partials: [1, 0.55, 0.42, 0.3, 0.22, 0.16, 0.11, 0.08, 0.05, 0.03], a: 0.003, d: 1.8, s: 0, r: 0.25, cutoff: 7000 },
  { key: "rhodes", label: "ELECTRIC PIANO", group: "SYNTH · CLASSIC", partials: [1, 0.18, 0.06, 0.34, 0.05, 0.14, 0.02, 0.05], a: 0.006, d: 2.2, s: 0, r: 0.3 },
  { key: "harpsichord", label: "HARPSICHORD", group: "SYNTH · CLASSIC", partials: [1, 0.7, 0.55, 0.42, 0.34, 0.26, 0.2, 0.15, 0.11, 0.08, 0.06], a: 0.002, d: 0.9, s: 0, r: 0.1, gain: 0.8 },
  { key: "celesta", label: "CELESTA", group: "SYNTH · CLASSIC", partials: [1, 0.04, 0.02, 0.3, 0.02, 0.01, 0.08], a: 0.002, d: 1.7, s: 0, r: 0.2 },
  // Plucked, struck and blown acoustics.
  { key: "guitar", label: "NYLON GUITAR", group: "SYNTH · NATURAL", partials: [1, 0.35, 0.5, 0.18, 0.12, 0.14, 0.06, 0.05, 0.03], a: 0.004, d: 1.6, s: 0, r: 0.2 },
  { key: "harp", label: "HARP", group: "SYNTH · NATURAL", partials: [1, 0.3, 0.16, 0.1, 0.05, 0.03, 0.02], a: 0.003, d: 3.2, s: 0, r: 0.4 },
  { key: "marimba", label: "MARIMBA", group: "SYNTH · NATURAL", partials: [1, 0.05, 0.02, 0.5, 0.03, 0.02, 0.12], a: 0.002, d: 0.75, s: 0, r: 0.08 },
  { key: "musicbox", label: "MUSIC BOX", group: "SYNTH · NATURAL", partials: [1, 0.02, 0.14, 0.02, 0.4, 0.01, 0.06, 0.18], a: 0.002, d: 1.3, s: 0, r: 0.12 },
  { key: "flute", label: "FLUTE", group: "SYNTH · NATURAL", partials: [1, 0.12, 0.06, 0.03, 0.015], a: 0.08, d: 0.25, s: 0.8, r: 0.18, vibrato: { hz: 5, cents: 9 } },
  // Bowed, blown and voiced sections — they swell and hold.
  { key: "strings", label: "STRING SECTION", group: "SYNTH · ORCHESTRAL", partials: [1, 0.5, 0.33, 0.25, 0.2, 0.16, 0.14, 0.12, 0.1, 0.09, 0.08], a: 0.18, d: 0.4, s: 0.75, r: 0.35, detune: [-7, 0, 7], vibrato: { hz: 5.5, cents: 7 }, cutoff: 4200, gain: 0.7 },
  { key: "pizzicato", label: "PIZZICATO", group: "SYNTH · ORCHESTRAL", partials: [1, 0.45, 0.3, 0.22, 0.14, 0.09, 0.05], a: 0.003, d: 0.5, s: 0, r: 0.08, detune: [-6, 6], gain: 0.6 },
  { key: "brass", label: "BRASS SECTION", group: "SYNTH · ORCHESTRAL", partials: [1, 0.62, 0.48, 0.38, 0.3, 0.24, 0.18, 0.13, 0.09], a: 0.06, d: 0.3, s: 0.7, r: 0.2, detune: [-4, 4], vibrato: { hz: 4.5, cents: 4 }, cutoff: 5200, gain: 0.7 },
  { key: "organ", label: "PIPE ORGAN", group: "SYNTH · ORCHESTRAL", partials: [1, 0.6, 0.45, 0.4, 0, 0.25, 0, 0.2], a: 0.01, d: 0.01, s: 1, r: 0.12, gain: 0.85 },
  { key: "choir", label: "CHOIR", group: "SYNTH · ORCHESTRAL", partials: [1, 0.45, 0.28, 0.12, 0.2, 0.08, 0.05, 0.03], a: 0.22, d: 0.35, s: 0.8, r: 0.45, detune: [-9, 0, 9], vibrato: { hz: 5, cents: 11 }, cutoff: 3200, gain: 0.7 },
  // The bare oscillators this started as.
  { key: "triangle", label: "TRIANGLE", group: "SYNTH · OSCILLATOR", wave: "triangle", a: 0.005, d: 1.9, s: 0, r: 0.12 },
  { key: "sine", label: "SINE", group: "SYNTH · OSCILLATOR", wave: "sine", a: 0.005, d: 1.9, s: 0, r: 0.12 },
  { key: "square", label: "SQUARE", group: "SYNTH · OSCILLATOR", wave: "square", a: 0.005, d: 1.9, s: 0, r: 0.12, gain: 0.7 },
  { key: "sawtooth", label: "SAWTOOTH", group: "SYNTH · OSCILLATOR", wave: "sawtooth", a: 0.005, d: 1.9, s: 0, r: 0.12, gain: 0.7 },
];

// General MIDI program order, verbatim from FluidR3_GM/names.json (index 0 = program 1).
const GM_PROGRAMS = (
  "acoustic_grand_piano,bright_acoustic_piano,electric_grand_piano,honkytonk_piano," +
  "electric_piano_1,electric_piano_2,harpsichord,clavinet,celesta,glockenspiel,music_box," +
  "vibraphone,marimba,xylophone,tubular_bells,dulcimer,drawbar_organ,percussive_organ," +
  "rock_organ,church_organ,reed_organ,accordion,harmonica,tango_accordion," +
  "acoustic_guitar_nylon,acoustic_guitar_steel,electric_guitar_jazz,electric_guitar_clean," +
  "electric_guitar_muted,overdriven_guitar,distortion_guitar,guitar_harmonics,acoustic_bass," +
  "electric_bass_finger,electric_bass_pick,fretless_bass,slap_bass_1,slap_bass_2,synth_bass_1," +
  "synth_bass_2,violin,viola,cello,contrabass,tremolo_strings,pizzicato_strings," +
  "orchestral_harp,timpani,string_ensemble_1,string_ensemble_2,synth_strings_1,synth_strings_2," +
  "choir_aahs,voice_oohs,synth_choir,orchestra_hit,trumpet,trombone,tuba,muted_trumpet," +
  "french_horn,brass_section,synth_brass_1,synth_brass_2,soprano_sax,alto_sax,tenor_sax," +
  "baritone_sax,oboe,english_horn,bassoon,clarinet,piccolo,flute,recorder,pan_flute," +
  "blown_bottle,shakuhachi,whistle,ocarina,lead_1_square,lead_2_sawtooth,lead_3_calliope," +
  "lead_4_chiff,lead_5_charang,lead_6_voice,lead_7_fifths,lead_8_bass__lead,pad_1_new_age," +
  "pad_2_warm,pad_3_polysynth,pad_4_choir,pad_5_bowed,pad_6_metallic,pad_7_halo,pad_8_sweep," +
  "fx_1_rain,fx_2_soundtrack,fx_3_crystal,fx_4_atmosphere,fx_5_brightness,fx_6_goblins," +
  "fx_7_echoes,fx_8_scifi,sitar,banjo,shamisen,koto,kalimba,bagpipe,fiddle,shanai,tinkle_bell," +
  "agogo,steel_drums,woodblock,taiko_drum,melodic_tom,synth_drum,reverse_cymbal," +
  "guitar_fret_noise,breath_noise,seashore,bird_tweet,telephone_ring,helicopter,applause," +
  "gunshot"
).split(",");

/** The 16 canonical General MIDI families — eight programs each, in order. */
const GM_FAMILIES = [
  "PIANO", "CHROMATIC PERCUSSION", "ORGAN", "GUITAR", "BASS", "STRINGS", "ENSEMBLE", "BRASS",
  "REED", "PIPE", "SYNTH LEAD", "SYNTH PAD", "SYNTH FX", "ETHNIC", "PERCUSSIVE", "SOUND FX",
];

/** Per family, the synth voice that stands in while samples load or if the
 *  network is gone — close enough in character that the swap isn't jarring. */
const GM_FALLBACK = [
  "grand", "celesta", "organ", "guitar", "guitar", "strings", "choir", "brass",
  "flute", "flute", "square", "strings", "celesta", "guitar", "marimba", "sine",
];

// Every GM program, streamed a note at a time from the CDN. The envelope fields
// are the fallback's; for a sampled note only `r` is used, to damp on key-up.
const SAMPLED: Voice[] = GM_PROGRAMS.map((gm, i) => ({
  key: `gm:${gm}`,
  label: gm.replace(/_+/g, " ").toUpperCase(),
  group: `SAMPLES · ${GM_FAMILIES[i >> 3]}`,
  gm,
  fallback: GM_FALLBACK[i >> 3],
  a: 0.002,
  d: 1.6,
  s: 0,
  r: 0.28,
}));

/** Samples first — they are what most people want — then the offline synth. */
export const VOICES: Voice[] = [...SAMPLED, ...SYNTH];

/** Distinct optgroup headings, in list order. */
export const VOICE_GROUPS: string[] = [...new Set(VOICES.map((v) => v.group))];

const SAMPLE_BASE = "https://gleitz.github.io/midi-js-soundfonts/FluidR3_GM";
/** midi-js filenames use FLATS — Db3.mp3 exists, C#3.mp3 is a 404. */
const FLATS = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"];

export const sampleUrl = (gm: string, midi: number): string =>
  `${SAMPLE_BASE}/${gm}-mp3/${FLATS[midi % 12]}${Math.floor(midi / 12) - 1}.mp3`;

export type VoiceKey = string;
export const VOICE_KEYS: string[] = VOICES.map((v) => v.key);

export const voiceOf = (key: VoiceKey): Voice => VOICES.find((v) => v.key === key) ?? VOICES[0];

/** A held note on a sustaining voice still gets cut eventually, so a missed
 *  key-up can't leave an oscillator running for the life of the tab. */
export const MAX_HOLD = 30;

/** Chars → midi, for the keydown handler. */
export const BY_CHAR: Record<string, number> = Object.fromEntries(
  KEYS.map((k) => [k.char, k.midi]),
);

// ---- self-check -------------------------------------------------------------
// The layout is hand-written; a slipped character would silently mis-tune the
// board. Run with: npx tsx src/lib/piano.ts
export function demo(): void {
  console.assert(KEYS.length === 25, "two octaves plus the top C");
  console.assert(WHITE_COUNT === 15, `15 white keys, got ${WHITE_COUNT}`);
  console.assert(new Set(CHARS).size === CHARS.length, "no duplicate key chars");
  console.assert(KEYS[0].name === "C3" && KEYS[24].name === "C5", "spans C3–C5");
  console.assert(KEYS[12].name === "C4" && KEYS[12].char === "q", "C4 is on q");
  console.assert(Math.abs(freqOf(69) - 440) < 1e-9, "A4 = 440Hz");
  console.assert(Math.abs(freqOf(60) - 261.6255653) < 1e-6, "C4 = 261.63Hz");
  // Black keys never sit next to each other, and never bracket E/B.
  console.assert(!KEYS.some((k, i) => k.black && KEYS[i + 1]?.black), "no adjacent blacks");
  console.assert(whiteIndex(1) === 1 && whiteIndex(13) === 8, "black keys straddle correctly");

  console.assert(new Set(VOICE_KEYS).size === VOICES.length, "no duplicate voice keys");
  console.assert(SAMPLED.length === 128, `all 128 GM programs, got ${SAMPLED.length}`);
  console.assert(new Set(GM_PROGRAMS).size === 128, "GM program list has a duplicate or a typo");
  console.assert(GM_FAMILIES.length === 16 && GM_FALLBACK.length === 16, "16 GM families");
  for (const v of VOICES) {
    console.assert(v.a > 0 && v.d > 0 && v.r > 0, `${v.key}: zero-length ramps break exponentialRampTo`);
    console.assert(v.s >= 0 && v.s <= 1, `${v.key}: sustain out of range`);
    console.assert(!v.detune || v.detune.length > 0, `${v.key}: empty detune array plays nothing`);
    if (v.gm) {
      // A sampled voice is unplayable offline without a real synth stand-in.
      console.assert(!!v.fallback, `${v.key}: sampled voice needs a fallback`);
      console.assert(
        SYNTH.some((w) => w.key === v.fallback),
        `${v.key}: fallback "${v.fallback}" is not a synth voice`,
      );
    } else {
      // Exactly one tone source, or the wave silently wins over the table.
      console.assert(!!v.partials !== !!v.wave, `${v.key}: needs partials XOR wave`);
      console.assert(v.partials?.[0] !== 0, `${v.key}: a zero fundamental detunes the whole voice`);
    }
  }
  // Flats, not sharps: Db3.mp3 exists on the CDN, C#3.mp3 is a 404.
  console.assert(sampleUrl("acoustic_grand_piano", 60).endsWith("/C4.mp3"), "C4 url");
  console.assert(sampleUrl("acoustic_grand_piano", 49).endsWith("/Db3.mp3"), "C#3 must ask for Db3");
  console.assert(sampleUrl("acoustic_grand_piano", 72).endsWith("/C5.mp3"), "C5 url");
  // The four original oscillator names must survive as voice keys, or stored
  // settings from before the instrument list would fall back to GRAND PIANO.
  for (const w of ["triangle", "sine", "square", "sawtooth"]) {
    console.assert(VOICE_KEYS.includes(w), `legacy pianoWave "${w}" must still resolve`);
  }
  console.log(
    `piano layout ok · ${VOICES.length} voices ` +
      `(${SAMPLED.length} sampled, ${SYNTH.length} synth) in ${VOICE_GROUPS.length} groups`,
  );
}

if (typeof process !== "undefined" && process.argv?.[1]?.endsWith("piano.ts")) demo();
