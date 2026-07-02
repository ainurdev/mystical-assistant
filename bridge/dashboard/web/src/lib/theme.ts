// Theme system — the design's "DISPLAY PROFILE · 9 THEMES". The whole HUD is
// authored in the aqua palette; every other profile recolors the ENTIRE
// dashboard by running the themed container through a CSS `filter`, so all
// accents shift together (several profiles are light themes via invert(1)).
// `data-theme` drives panel/edge SHAPE only (rules live in index.css);
// `canvas`/`font` restyle the page ground + type voice. CRT effects
// (scanlines / sweep / glow) have per-theme defaults applied on pick.

export type ThemeKey =
  | "aqua"
  | "green"
  | "amber"
  | "magenta"
  | "adventure"
  | "normal"
  | "newsprint"
  | "candy"
  | "blueprint";

/** One decomposed CSS-filter op — feeds the inverse color matrix below. */
export type FilterOp = readonly [
  "hue" | "sat" | "sepia" | "invert" | "bright" | "contrast" | "gray",
  number,
];

export interface ThemeDef {
  key: ThemeKey;
  name: string; // display name shown in the theme picker
  feel: string; // flavour text
  filter: string; // CSS filter applied to the themed container (colour source)
  ops: FilterOp[]; // `filter` decomposed, for the inverse color matrix
  sw: string; // representative swatch colour
  bg: string; // ambient background tint behind the dashboard
  pbg: string; // preview-card background
  crt: boolean; // default SCANLINES toggle when this theme is picked
  swp: boolean; // default SCAN SWEEP toggle
  glw: boolean; // default TEXT GLOW toggle
  canvas: string; // page background of the themed container
  font: string; // font-family override ("" = keep the HUD mono)
  prad: string; // corner radius used on small chips/swatches
}

export const THEME_DEFS: ThemeDef[] = [
  { key: "aqua", name: "AURORA", feel: "orbital glass · clean signal", filter: "none", ops: [], sw: "#7fe9d8", bg: "rgba(10,26,32,.55)", pbg: "#04090b", crt: true, swp: true, glw: true, canvas: "#060a0a", font: "", prad: "0" },
  { key: "green", name: "VIRIDIAN", feel: "buried relay · net-runner", filter: "hue-rotate(-58deg) saturate(1.5)", ops: [["hue", -58], ["sat", 1.5]], sw: "#5fdd8f", bg: "rgba(8,28,16,.5)", pbg: "#040a07", crt: true, swp: true, glw: true, canvas: "#060a0a", font: "", prad: "0" },
  { key: "amber", name: "EMBER", feel: "salvage rig · warm static", filter: "hue-rotate(-146deg) saturate(1.7)", ops: [["hue", -146], ["sat", 1.7]], sw: "#e8b04a", bg: "rgba(34,20,4,.5)", pbg: "#0a0703", crt: true, swp: true, glw: true, canvas: "#060a0a", font: "", prad: "0" },
  { key: "magenta", name: "NOVA", feel: "neon district · synthwave", filter: "hue-rotate(132deg) saturate(1.6)", ops: [["hue", 132], ["sat", 1.6]], sw: "#ff7ad9", bg: "rgba(28,8,34,.55)", pbg: "#090410", crt: true, swp: true, glw: true, canvas: "#060a0a", font: "", prad: "0" },
  { key: "adventure", name: "ADVENTURE", feel: "quest log · tavern & gold", filter: "sepia(.5) hue-rotate(-14deg) saturate(1.65) brightness(1.03)", ops: [["sepia", 0.5], ["hue", -14], ["sat", 1.65], ["bright", 1.03]], sw: "#d9a94e", bg: "rgba(30,22,8,.5)", pbg: "#0c0805", crt: false, swp: false, glw: true, canvas: "#0b0704", font: "'IM Fell English',Georgia,serif", prad: "2px" },
  { key: "normal", name: "NORMAL", feel: "plain dashboard · daylight", filter: "invert(1) hue-rotate(200deg) saturate(.85) contrast(.94)", ops: [["invert", 1], ["hue", 200], ["sat", 0.85], ["contrast", 0.94]], sw: "#4f86c6", bg: "rgba(16,20,22,.4)", pbg: "#eef1f3", crt: false, swp: false, glw: false, canvas: "#101416", font: "system-ui,-apple-system,'Segoe UI',sans-serif", prad: "6px" },
  { key: "newsprint", name: "NEWSPRINT", feel: "morning paper · ink & pulp", filter: "grayscale(.82) invert(1) contrast(1.05) brightness(1.02)", ops: [["gray", 0.82], ["invert", 1], ["contrast", 1.05], ["bright", 1.02]], sw: "#3a3a3a", bg: "rgba(17,17,17,.4)", pbg: "#f2f0ea", crt: false, swp: false, glw: false, canvas: "#111111", font: "Georgia,'Times New Roman',serif", prad: "0" },
  { key: "candy", name: "CANDY", feel: "bubblegum · playful pop", filter: "invert(1) hue-rotate(-18deg) saturate(1.4) brightness(1.04)", ops: [["invert", 1], ["hue", -18], ["sat", 1.4], ["bright", 1.04]], sw: "#ef6fa7", bg: "rgba(18,16,14,.4)", pbg: "#fdedf4", crt: false, swp: false, glw: false, canvas: "#12100e", font: "'Trebuchet MS','Comic Sans MS',sans-serif", prad: "99px" },
  { key: "blueprint", name: "BLUEPRINT", feel: "drafting table · dashed ink", filter: "hue-rotate(48deg) saturate(1.25) contrast(1.06)", ops: [["hue", 48], ["sat", 1.25], ["contrast", 1.06]], sw: "#6f9ff0", bg: "rgba(5,10,22,.55)", pbg: "#061024", crt: false, swp: false, glw: false, canvas: "#040a14", font: "", prad: "0" },
];

export const THEMES: ThemeKey[] = THEME_DEFS.map((t) => t.key);

export function themeDef(t: ThemeKey): ThemeDef {
  return THEME_DEFS.find((d) => d.key === t) ?? THEME_DEFS[0];
}

export function themeFilter(t: ThemeKey): string {
  return themeDef(t).filter;
}

export function themeCanvas(t: ThemeKey): string {
  return themeDef(t).canvas;
}

export function themeFont(t: ThemeKey): string {
  return themeDef(t).font;
}

export function themePrad(t: ThemeKey): string {
  return themeDef(t).prad;
}

export interface HudSettings {
  theme: ThemeKey;
  scanlines: boolean;
  sweep: boolean;
  glow: boolean;
}

const KEY = "hud-settings";
const DEFAULTS: HudSettings = { theme: "aqua", scanlines: true, sweep: true, glow: true };

export function loadSettings(): HudSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<HudSettings>;
      return {
        // Unknown / legacy keys migrate to aqua.
        theme: THEMES.includes(p.theme as ThemeKey) ? (p.theme as ThemeKey) : "aqua",
        scanlines: p.scanlines ?? true,
        sweep: p.sweep ?? true,
        glow: p.glow ?? true,
      };
    }
  } catch {
    /* ignore */
  }
  // Migrate the old single-key theme if present.
  try {
    const old = localStorage.getItem("hud-theme");
    if (old && (THEMES as string[]).includes(old)) return { ...DEFAULTS, theme: old as ThemeKey };
  } catch {
    /* ignore */
  }
  return { ...DEFAULTS };
}

export function saveSettings(s: HudSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}

// ---- inverse color matrix ---------------------------------------------------
// Because the whole themed container is run through the profile's CSS filter,
// anything that must render in TRUE colour inside it (the theme-picker swatch
// cards) is pre-corrected by the INVERSE of that filter's color matrix.
// Straight port of the design's I3/mul3/satM/hueM/sepM/opA/inv3/parseCol math.

type Mat3 = number[][];

const I3: Mat3 = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
const mul3 = (A: Mat3, B: Mat3): Mat3 =>
  A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]));
const mulV = (A: Mat3, v: number[]): number[] =>
  A.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const satM = (s: number): Mat3 => [
  [0.213 + 0.787 * s, 0.715 - 0.715 * s, 0.072 - 0.072 * s],
  [0.213 - 0.213 * s, 0.715 + 0.285 * s, 0.072 - 0.072 * s],
  [0.213 - 0.213 * s, 0.715 - 0.715 * s, 0.072 + 0.928 * s],
];
const hueM = (deg: number): Mat3 => {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [
    [0.213 + 0.787 * c - 0.213 * s, 0.715 - 0.715 * c - 0.715 * s, 0.072 - 0.072 * c + 0.928 * s],
    [0.213 - 0.213 * c + 0.143 * s, 0.715 + 0.285 * c + 0.140 * s, 0.072 - 0.072 * c - 0.283 * s],
    [0.213 - 0.213 * c - 0.787 * s, 0.715 - 0.715 * c + 0.715 * s, 0.072 + 0.928 * c + 0.072 * s],
  ];
};
const sepM = (a: number): Mat3 => {
  const S = [[0.393, 0.769, 0.189], [0.349, 0.686, 0.168], [0.272, 0.534, 0.131]];
  return S.map((r, i) => r.map((v, j) => v * a + (i === j ? 1 - a : 0)));
};
// Each op as an affine transform: [matrix, offset].
const opA = (op: FilterOp): [Mat3, number[]] => {
  const k = op[0];
  const v = op[1];
  if (k === "sat") return [satM(v), [0, 0, 0]];
  if (k === "gray") return [satM(1 - v), [0, 0, 0]];
  if (k === "hue") return [hueM(v), [0, 0, 0]];
  if (k === "sepia") return [sepM(v), [0, 0, 0]];
  if (k === "invert") return [I3.map((r) => r.map((x) => x * (1 - 2 * v))), [v, v, v]];
  if (k === "bright") return [I3.map((r) => r.map((x) => x * v)), [0, 0, 0]];
  if (k === "contrast") return [I3.map((r) => r.map((x) => x * v)), [(1 - v) / 2, (1 - v) / 2, (1 - v) / 2]];
  return [I3, [0, 0, 0]];
};
const det3 = (m: Mat3): number =>
  m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
  m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
  m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
const inv3 = (m: Mat3): Mat3 | null => {
  const d = det3(m);
  if (Math.abs(d) < 1e-6) return null;
  const x = (a: number, b: number, c2: number, d2: number) => a * d2 - b * c2;
  return [
    [x(m[1][1], m[1][2], m[2][1], m[2][2]) / d, -x(m[0][1], m[0][2], m[2][1], m[2][2]) / d, x(m[0][1], m[0][2], m[1][1], m[1][2]) / d],
    [-x(m[1][0], m[1][2], m[2][0], m[2][2]) / d, x(m[0][0], m[0][2], m[2][0], m[2][2]) / d, -x(m[0][0], m[0][2], m[1][0], m[1][2]) / d],
    [x(m[1][0], m[1][1], m[2][0], m[2][1]) / d, -x(m[0][0], m[0][1], m[2][0], m[2][1]) / d, x(m[0][0], m[0][1], m[1][0], m[1][1]) / d],
  ];
};
const parseCol = (str: string): number[] | null => {
  if (typeof str !== "string") return null;
  if (str[0] === "#" && str.length >= 7) {
    return [
      parseInt(str.slice(1, 3), 16) / 255,
      parseInt(str.slice(3, 5), 16) / 255,
      parseInt(str.slice(5, 7), 16) / 255,
      1,
    ];
  }
  const m = str.match(/rgba?\(([^)]+)\)/);
  if (!m) return null;
  const p = m[1].split(",").map((x) => parseFloat(x));
  return [p[0] / 255, p[1] / 255, p[2] / 255, p.length > 3 ? p[3] : 1];
};

/**
 * Compensator for the active theme: maps an authored colour to the
 * pre-corrected colour that renders TRUE under the theme's CSS filter.
 * Identity when the theme has no filter ops or the matrix isn't invertible.
 */
export function themeCompensator(t: ThemeKey): (color: string) => string {
  const cur = themeDef(t);
  let thM: Mat3 = I3;
  let thO = [0, 0, 0];
  for (const op of cur.ops) {
    const mo = opA(op);
    const Mv = mulV(mo[0], thO);
    thM = mul3(mo[0], thM);
    thO = [Mv[0] + mo[1][0], Mv[1] + mo[1][1], Mv[2] + mo[1][2]];
  }
  const thInv = inv3(thM);
  return (color: string) => {
    if (!thInv || !cur.ops.length) return color;
    const c = parseCol(color);
    if (!c) return color;
    const v = [c[0] - thO[0], c[1] - thO[1], c[2] - thO[2]];
    const r = mulV(thInv, v).map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255));
    return `rgba(${r[0]},${r[1]},${r[2]},${c[3]})`;
  };
}
