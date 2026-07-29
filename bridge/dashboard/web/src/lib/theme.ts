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
  // Per-theme palette overrides (the design's `pal{}`) for the 5 non-filter
  // themes. When present, the theme recolours by injecting these as CSS vars on
  // the themed container (filter:"none"); absent → recolour via `filter`.
  pal?: Record<string, string>;
}

export const THEME_DEFS: ThemeDef[] = [
  { key: "aqua", name: "AURORA", feel: "orbital glass · clean signal", filter: "none", ops: [], sw: "#7fe9d8", bg: "rgba(10,26,32,.55)", pbg: "#04090b", crt: true, swp: true, glw: true, canvas: "#060a0a", font: "", prad: "0" },
  { key: "green", name: "VIRIDIAN", feel: "buried relay · net-runner", filter: "hue-rotate(-58deg) saturate(1.5)", ops: [["hue", -58], ["sat", 1.5]], sw: "#5fdd8f", bg: "rgba(8,28,16,.5)", pbg: "#040a07", crt: true, swp: true, glw: true, canvas: "#060a0a", font: "", prad: "0" },
  { key: "amber", name: "EMBER", feel: "salvage rig · warm static", filter: "hue-rotate(-146deg) saturate(1.7)", ops: [["hue", -146], ["sat", 1.7]], sw: "#e8b04a", bg: "rgba(34,20,4,.5)", pbg: "#0a0703", crt: true, swp: true, glw: true, canvas: "#060a0a", font: "", prad: "0" },
  { key: "magenta", name: "NOVA", feel: "neon district · synthwave", filter: "hue-rotate(132deg) saturate(1.6)", ops: [["hue", 132], ["sat", 1.6]], sw: "#ff7ad9", bg: "rgba(28,8,34,.55)", pbg: "#090410", crt: true, swp: true, glw: true, canvas: "#060a0a", font: "", prad: "0" },
  // The 5 palette themes: filter:"none" + an explicit `pal{}` (true colours), per
  // the design mock. `canvas` is the real (often light) ground; `sw` the picker swatch.
  { key: "adventure", name: "ADVENTURE", feel: "quest log · tavern & gold", filter: "none", ops: [], sw: "#d9a94e", bg: "rgba(30,22,8,.5)", pbg: "#0c0805", crt: false, swp: false, glw: true, canvas: "radial-gradient(120% 90% at 50% 0%, #1a1208 0%, #0b0704 70%)", font: "'IM Fell English',Georgia,serif", prad: "2px", pal: { acc: "#d9a94e", "acc-on": "#241706", ok: "#9ec06a", warn: "#e0b45e", err: "#d0745a", "err-hi": "#f0c8b4", "err-b": "#f6d8c8", "err-g": "#a4735c", info: "#8fb6d9", "info-hi": "#aecfe8", "info-b": "#cfe4f4", purple: "#b591c9", "purple-d": "#a680ba", "purple-h": "#c8a8d8", "purple-b": "#e2ccec", "purple-g": "#7e6690", txb: "#f4e8ce", txh: "#e4d4b2", tx: "#d4c29a", txm: "#b6a17a", txd: "#93805c", txf: "#7a6848", txl: "#645430", txg: "#463a22", panel: "#171006", panel2: "#110b04", panel3: "#0a0702", mono: "'JetBrains Mono',monospace" } },
  { key: "normal", name: "NORMAL", feel: "plain dashboard · daylight", filter: "none", ops: [], sw: "#2f7cc4", bg: "rgba(16,20,22,.4)", pbg: "#eef1f3", crt: false, swp: false, glw: false, canvas: "#eef1f4", font: "system-ui,-apple-system,'Segoe UI',sans-serif", prad: "6px", pal: { acc: "#2f7cc4", "acc-on": "#ffffff", ok: "#1e9e5a", warn: "#b0821c", err: "#d05252", "err-hi": "#8c3030", "err-b": "#7c2828", "err-g": "#c08a8a", info: "#2f6fc4", "info-hi": "#255ba6", "info-b": "#1c4680", purple: "#7b5bd6", "purple-d": "#8a6ee0", "purple-h": "#6a4ec2", "purple-b": "#523aa6", "purple-g": "#a89ac8", txb: "#111e28", txh: "#22343f", tx: "#31454f", txm: "#50666f", txd: "#71858e", txf: "#8fa0a8", txl: "#a2b1b8", txg: "#cdd8dc", panel: "#ffffff", panel2: "#f4f7f9", panel3: "#e8edf1", mono: "ui-monospace,SFMono-Regular,Menlo,monospace" } },
  { key: "newsprint", name: "NEWSPRINT", feel: "morning paper · ink & pulp", filter: "none", ops: [], sw: "#1f1f1f", bg: "rgba(17,17,17,.4)", pbg: "#f2f0ea", crt: false, swp: false, glw: false, canvas: "#f0ede4", font: "Georgia,'Times New Roman',serif", prad: "0", pal: { acc: "#1f1f1f", "acc-on": "#f6f4ee", ok: "#2c5e3f", warn: "#87681d", err: "#9e3535", "err-hi": "#5e2020", "err-b": "#4e1a1a", "err-g": "#9a6a6a", info: "#2b4a68", "info-hi": "#223c56", "info-b": "#1a2e42", purple: "#50505e", "purple-d": "#606070", "purple-h": "#40404c", "purple-b": "#30303a", "purple-g": "#90909c", txb: "#141414", txh: "#242424", tx: "#333333", txm: "#4d4d4d", txd: "#6e6e6e", txf: "#8a8a8a", txl: "#9c9c9c", txg: "#c6c4bc", panel: "#faf8f2", panel2: "#f0eee6", panel3: "#e5e2d8", mono: "'Courier New',monospace" } },
  { key: "candy", name: "CANDY", feel: "bubblegum · playful pop", filter: "none", ops: [], sw: "#e0559a", bg: "rgba(18,16,14,.4)", pbg: "#fdedf4", crt: false, swp: false, glw: false, canvas: "linear-gradient(180deg,#fdeef6,#f8e4ef)", font: "'Trebuchet MS','Comic Sans MS',sans-serif", prad: "99px", pal: { acc: "#e0559a", "acc-on": "#ffffff", ok: "#18a06c", warn: "#d0821e", err: "#e0556b", "err-hi": "#8c2c3c", "err-b": "#7a2434", "err-g": "#c88a96", info: "#4e7de0", "info-hi": "#3c67c2", "info-b": "#2c50a2", purple: "#a262e0", "purple-d": "#b47ae8", "purple-h": "#8e4cd0", "purple-b": "#7038b0", "purple-g": "#c8a2e0", txb: "#3a1226", txh: "#4e2036", tx: "#603046", txm: "#7c4a60", txd: "#96647e", txf: "#ac8298", txl: "#ba94a8", txg: "#e4c8d4", panel: "#fff8fc", panel2: "#fceaf3", panel3: "#f6dcea", mono: "Menlo,Consolas,monospace" } },
  { key: "blueprint", name: "BLUEPRINT", feel: "drafting table · dashed ink", filter: "none", ops: [], sw: "#7fb0ff", bg: "rgba(5,10,22,.55)", pbg: "#061024", crt: false, swp: false, glw: false, canvas: "repeating-linear-gradient(0deg,rgba(127,176,255,.06) 0 1px,transparent 1px 26px),repeating-linear-gradient(90deg,rgba(127,176,255,.06) 0 1px,transparent 1px 26px),#06101f", font: "", prad: "0", pal: { acc: "#7fb0ff", "acc-on": "#04101f", ok: "#74d0a6", warn: "#e0c279", err: "#e08a8a", "err-hi": "#f0cccc", "err-b": "#f6dada", "err-g": "#a06a6a", info: "#9cc2ff", "info-hi": "#c2daff", "info-b": "#e0edff", purple: "#a6b9ff", "purple-d": "#94a8f0", "purple-h": "#bccbff", "purple-b": "#dde5ff", "purple-g": "#68729e", txb: "#e8f0fc", txh: "#cdd9ee", tx: "#b4c4de", txm: "#93a6c4", txd: "#6d82a4", txf: "#586c8c", txl: "#465878", txg: "#32405c", panel: "#081226", panel2: "#060e1c", panel3: "#040912", mono: "'JetBrains Mono',monospace" } },
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

/**
 * CSS custom-property overrides for a palette theme, injected on the themed
 * container so every descendant recolours. Empty for the filter themes
 * (aqua/green/amber/magenta), which recolour via `filter` instead.
 */
export function themeVars(t: ThemeKey): Record<string, string> {
  const pal = themeDef(t).pal;
  if (!pal) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(pal)) out[`--${k}`] = v;
  return out;
}

/**
 * Every design-token CSS var a palette theme may override. Injected on :root
 * (not just the themed wrapper) so the DERIVED tokens defined via `var()` in
 * index.css `:root` (--primary, --card, --border, --ac-NN …) re-resolve to the
 * palette; used to CLEAR stale overrides when switching back to a filter theme.
 */
export const THEME_TOKEN_KEYS: string[] = Array.from(
  new Set(THEME_DEFS.flatMap((t) => (t.pal ? Object.keys(t.pal) : []))),
).map((k) => `--${k}`);

export const RIGHT_TABS = ["projects", "files", "queue"] as const;
export type RightTab = (typeof RIGHT_TABS)[number];

export interface HudSettings {
  theme: ThemeKey;
  scanlines: boolean;
  sweep: boolean;
  glow: boolean;
  rightOpen: boolean; // right sidebar expanded
  rightTab: RightTab; // which sidebar tab it opens on
}

const KEY = "hud-settings";
const DEFAULTS: HudSettings = {
  theme: "aqua", scanlines: true, sweep: true, glow: true, rightOpen: true, rightTab: "projects",
};

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
        rightOpen: p.rightOpen ?? true,
        rightTab: RIGHT_TABS.includes(p.rightTab as RightTab) ? (p.rightTab as RightTab) : "projects",
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
