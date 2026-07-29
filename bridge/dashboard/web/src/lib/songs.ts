// Song directory for the PIANO TILES indicator.
//
// Every melody here is PUBLIC DOMAIN — the canon's actual top hits rather than
// chart ones, because a modern hit's melody is a copyrighted composition and
// transcribing it into this file would be reproducing it. The instrument
// samples are separately licensed (CC-BY 3.0); that covers the recordings, not
// any tune played on them. Adding a song is a data-only edit: append a row.
//
// These are simplified single-line arrangements, transposed to fit the board's
// two octaves (C3–C5) — recognisable to play, not performance editions.
//
// Notation: space-separated tokens on a sixteenth-note grid.
//   E4      one sixteenth of E4
//   E4/4    four sixteenths (a quarter note)
//   -/8     a rest, eight sixteenths long
// Accidentals may be sharp (D#4) or flat (Eb4); both resolve to the same key.

export interface Song {
  key: string;
  title: string;
  composer: string;
  year: string;
  bpm: number;
  notes: string;
}

export const SONGS: Song[] = [
  {
    key: "fur-elise",
    title: "FÜR ELISE",
    composer: "BEETHOVEN",
    year: "1810",
    bpm: 76,
    notes:
      "E4 D#4 E4 D#4 E4 B3 D4 C4 A3/4 C3 E3 A3 B3/4 E3 G#3 B3 C4/4 E3 " +
      "E4 D#4 E4 D#4 E4 B3 D4 C4 A3/4 C3 E3 A3 B3/4 E3 C4 B3 A3/8 -/4",
  },
  {
    key: "ode-to-joy",
    title: "ODE TO JOY",
    composer: "BEETHOVEN",
    year: "1824",
    bpm: 112,
    notes:
      "E4/4 E4/4 F4/4 G4/4 G4/4 F4/4 E4/4 D4/4 C4/4 C4/4 D4/4 E4/4 E4/6 D4/2 D4/8 " +
      "E4/4 E4/4 F4/4 G4/4 G4/4 F4/4 E4/4 D4/4 C4/4 C4/4 D4/4 E4/4 D4/6 C4/2 C4/8 -/4",
  },
  {
    key: "entertainer",
    title: "THE ENTERTAINER",
    composer: "SCOTT JOPLIN",
    year: "1902",
    bpm: 96,
    notes:
      "D3/2 D#3/2 E3/2 C4/6 E3/2 C4/6 E3/2 C4/8 " +
      "C4/2 D4/2 D#4/2 E4/2 C4/2 D4/2 E4/6 B3/6 D4/4 C4/8 -/4",
  },
];

export const songOf = (key: string): Song => SONGS.find((s) => s.key === key) ?? SONGS[0];

/** One note, resolved to absolute time. `at`/`dur` are in sixteenths. */
export interface Note {
  midi: number;
  at: number;
  dur: number;
}

const PITCH: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
const TOKEN = /^([A-G])([#b]?)(-?\d+)(?:\/(\d+))?$/;

/** Parsed melody plus its total length, both in sixteenths. */
export interface Chart {
  notes: Note[];
  units: number;
  /** Milliseconds per sixteenth, from the song's tempo. */
  unitMs: number;
}

export function parseSong(song: Song): Chart {
  const notes: Note[] = [];
  let at = 0;
  for (const tok of song.notes.trim().split(/\s+/)) {
    if (tok.startsWith("-")) {
      at += Number(tok.split("/")[1] ?? 1);
      continue;
    }
    const m = TOKEN.exec(tok);
    if (!m) throw new Error(`${song.key}: cannot parse "${tok}"`);
    const [, letter, accidental, octave, len] = m;
    const midi =
      PITCH[letter] + (accidental === "#" ? 1 : accidental === "b" ? -1 : 0) + (Number(octave) + 1) * 12;
    const dur = Number(len ?? 1);
    notes.push({ midi, at, dur });
    at += dur;
  }
  return { notes, units: at, unitMs: 60000 / song.bpm / 4 };
}

/** How far a tile falls before reaching the keys — the game's difficulty knob. */
export const TILE_SPEEDS = ["slow", "normal", "fast"] as const;
export type TileSpeed = (typeof TILE_SPEEDS)[number];
export const TRAVEL_MS: Record<TileSpeed, number> = { slow: 2600, normal: 1900, fast: 1300 };

// ---- self-check -------------------------------------------------------------
// The melodies are hand-transcribed, and a note outside the board's range would
// drop a tile in a lane that has no key to clear it — unplayable, and silent.
// Run with: npx tsx src/lib/songs.ts
export function demo(): void {
  const LOW = 48; // C3
  const HIGH = 72; // C5
  console.assert(SONGS.length >= 3, "ship at least three songs");
  console.assert(new Set(SONGS.map((s) => s.key)).size === SONGS.length, "duplicate song key");
  for (const song of SONGS) {
    const chart = parseSong(song); // throws on an unparseable token
    console.assert(chart.notes.length > 8, `${song.key}: too short to be a tune`);
    console.assert(song.bpm > 20 && song.bpm < 240, `${song.key}: implausible bpm`);
    for (const n of chart.notes) {
      console.assert(
        n.midi >= LOW && n.midi <= HIGH,
        `${song.key}: ${n.midi} is outside the board's C3-C5`,
      );
      console.assert(n.dur > 0, `${song.key}: zero-length note`);
    }
    // Notes must come out sorted; the game's miss cursor walks them in order.
    console.assert(
      chart.notes.every((n, i) => i === 0 || n.at >= chart.notes[i - 1].at),
      `${song.key}: notes are not in time order`,
    );
    console.assert(chart.units > 0 && chart.unitMs > 0, `${song.key}: bad chart length`);
  }
  // Accidental spellings must agree, and octave numbering must be scientific
  // (C4 = middle C = 60) to line up with the keyboard's midi numbers.
  const probe = parseSong({ ...SONGS[0], notes: "C4 D#4 Eb4 C4/4" });
  console.assert(probe.notes[0].midi === 60, "C4 must be midi 60");
  console.assert(probe.notes[1].midi === probe.notes[2].midi, "D#4 and Eb4 are the same key");
  console.assert(probe.notes[3].dur === 4 && probe.units === 7, "durations accumulate");
  console.assert(parseSong({ ...SONGS[0], notes: "C4 -/4 C4" }).notes[1].at === 5, "rests advance time");
  console.log(
    `songs ok · ${SONGS.length} charts, ${SONGS.reduce((n, s) => n + parseSong(s).notes.length, 0)} notes`,
  );
}

if (typeof process !== "undefined" && process.argv?.[1]?.endsWith("songs.ts")) demo();
