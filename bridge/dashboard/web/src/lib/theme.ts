// Theme system — the design's "DISPLAY PROFILE · 9 THEMES". The whole HUD is
// authored in the aqua palette; every other profile recolors the ENTIRE
// dashboard by running the themed container through a CSS `filter`, so all
// accents shift together (several profiles are light themes via invert(1)).
// `data-theme` drives panel/edge SHAPE only (rules live in index.css);
// `canvas`/`font` restyle the page ground + type voice. CRT effects
// (scanlines / sweep / glow) have per-theme defaults applied on pick.

import { NYAN_KEYS, type NyanMode, type NyanSound } from "./nyan";
import { TONES, type ToneKey } from "./push";
import { PUSH_EVENT_KEYS, type PushEvent, type SoundChoice } from "./sounds";
import { VOICE_KEYS, type VoiceKey } from "./piano";
import { SONGS, TILE_SPEEDS, type TileSpeed } from "./songs";

export type ThemeKey =
  | "aqua"
  | "green"
  | "amber"
  | "magenta"
  | "normal"
  | "newsprint"
  | "candy"
  | "blueprint"
  | "claude"
  | "claude-ocean"
  | "claude-fern"
  | "claude-iris"
  | "dusk"
  | "library"
  | "apex"
  | "gloam"
  | "riso"
  | "void"
  | "nocturne";

/**
 * AURORA is one theme in four colours — same glass, same CRT, only the
 * hue-rotate differs. The picker shows a single card with a colour row; each
 * colour stays its own ThemeKey underneath so nothing else has to know.
 */
export const AURORA_KEYS: ThemeKey[] = ["aqua", "green", "amber", "magenta"];

/** CLAUDE is dark-only, in four accents; same card, one colour row. */
export const CLAUDE_KEYS: ThemeKey[] = ["claude", "claude-ocean", "claude-fern", "claude-iris"];

/**
 * The themes that sit on a LIGHT ground. Everything else is dark. The picker
 * shows the two sets as separate groups; their palettes are tuned so every text
 * tier clears WCAG AA (4.5:1) against their own canvas — `txg`, the decorative
 * ghost tier (line numbers, empty states), clears 3.3:1.
 *
 * A light ground is NOT a dark one inverted. Two rules from the daylight design
 * systems (Primer, Radix, Atlassian) that this palette set follows:
 *   1. The biggest surface is never the brightest. `canvas` is a tinted ground
 *      a few percent DOWN from white and `panel` is the bright card on top of
 *      it, so panels read as raised paper instead of dissolving into the page.
 *   2. Depth comes from an ordered surface ladder + real borders + a hairline
 *      shadow — never from a glow, and never from a faint alpha wash: an 8%
 *      accent veil over near-black is a 1.6x luminance step, the same veil over
 *      white is 1.02x, i.e. invisible. `:root[data-light]` in index.css
 *      re-derives every alpha-tinted token at light-appropriate strength.
 */
export const LIGHT_KEYS: ThemeKey[] = ["normal", "newsprint", "candy", "apex", "gloam", "riso"];

export function isLight(t: ThemeKey): boolean {
  return LIGHT_KEYS.includes(t);
}

const FAMILIES: ThemeKey[][] = [AURORA_KEYS, CLAUDE_KEYS];

/** Two keys that are the same profile in another colour/ground. */
export function sameFamily(a: ThemeKey, b: ThemeKey): boolean {
  return FAMILIES.some((f) => f.includes(a) && f.includes(b));
}

/** CRT effects belong to the sci-fi glass only; paper and daylight themes hide them. */
export function themeHasCrt(t: ThemeKey): boolean {
  return AURORA_KEYS.includes(t);
}

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

/** "#7fb0ff" → "127 176 255", for the `rgb(var(--accent-rgb)/x)` chrome. */
const rgbTriplet = (hex: string): string =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(" ");

// Claude's own surfaces: dark ground, system type, no effects. One palette in
// four accents — only `acc` (and the picker swatch) differs between them.
const CLAUDE_PAL: Record<string, string> = { "acc-on": "#1f1f1e", ok: "#6bbf8a", warn: "#d8a657", err: "#e0796a", "err-hi": "#f2b5aa", "err-b": "#f8d3cc", "err-g": "#9c7068", info: "#7fb0e0", "info-hi": "#a8cbee", "info-b": "#cfe3f7", purple: "#a99cdb", "purple-d": "#9a8cd0", "purple-h": "#bfb4e8", "purple-b": "#dcd6f4", "purple-g": "#6e6890", txb: "#f5f4ef", txh: "#eceae5", tx: "#d7d5cd", txm: "#bfbdb4", txd: "#aba9a0", txf: "#a09d97", txl: "#999690", txg: "#4a4844", panel: "#30302e", panel2: "#262624", panel3: "#1f1f1e", canvas: "#262624", mono: "ui-monospace,SFMono-Regular,Menlo,monospace" };

const CLAUDE_ACCENTS: [ThemeKey, string, string, string][] = [
  ["claude", "CLAUDE", "the app itself · warm clay", "#d97757"],
  ["claude-ocean", "CLAUDE OCEAN", "the app itself · cold water", "#7fb0e0"],
  ["claude-fern", "CLAUDE FERN", "the app itself · quiet green", "#6bbf8a"],
  ["claude-iris", "CLAUDE IRIS", "the app itself · dusk violet", "#a99cdb"],
];

const CLAUDE_DEFS: ThemeDef[] = CLAUDE_ACCENTS.map(([key, name, feel, acc]) => ({
  key, name, feel, filter: "none", ops: [], sw: acc, bg: "rgba(30,30,29,.55)", pbg: "#262624",
  crt: false, swp: false, glw: false, canvas: "#262624",
  font: "ui-sans-serif,-apple-system,'Segoe UI',system-ui,sans-serif", prad: "8px",
  pal: { ...CLAUDE_PAL, acc, "accent-rgb": rgbTriplet(acc) },
}));

export const THEME_DEFS: ThemeDef[] = [
  { key: "aqua", name: "AURORA", feel: "orbital glass · clean signal", filter: "none", ops: [], sw: "#7fe9d8", bg: "rgba(10,26,32,.55)", pbg: "#04090b", crt: true, swp: true, glw: true, canvas: "#060a0a", font: "", prad: "0" },
  { key: "green", name: "VIRIDIAN", feel: "buried relay · net-runner", filter: "hue-rotate(-58deg) saturate(1.5)", ops: [["hue", -58], ["sat", 1.5]], sw: "#5fdd8f", bg: "rgba(8,28,16,.5)", pbg: "#040a07", crt: true, swp: true, glw: true, canvas: "#060a0a", font: "", prad: "0" },
  { key: "amber", name: "EMBER", feel: "salvage rig · warm static", filter: "hue-rotate(-146deg) saturate(1.7)", ops: [["hue", -146], ["sat", 1.7]], sw: "#e8b04a", bg: "rgba(34,20,4,.5)", pbg: "#0a0703", crt: true, swp: true, glw: true, canvas: "#060a0a", font: "", prad: "0" },
  { key: "magenta", name: "NOVA", feel: "neon district · synthwave", filter: "hue-rotate(132deg) saturate(1.6)", ops: [["hue", 132], ["sat", 1.6]], sw: "#ff7ad9", bg: "rgba(28,8,34,.55)", pbg: "#090410", crt: true, swp: true, glw: true, canvas: "#060a0a", font: "", prad: "0" },
  // The 4 palette themes: filter:"none" + an explicit `pal{}` (true colours), per
  // the design mock. `canvas` is the real (often light) ground; `sw` the picker swatch.
  // The three LIGHT_KEYS palettes in this block are contrast-tuned against their own
  // canvas — the ink tiers hit fixed ratios (txb 14.6 · txh 11.4 · tx 9.3 ·
  // txm 7.3 · txd 6 · txf 5.4 · txl 4.9 · txg 3.45) and every semantic colour
  // used as text clears 4.7:1. Keep hue, move lightness, if you retint one of
  // these, then re-run tests/test_light_theme_contrast.py.
  //
  // NORMAL is the daylight neutral: a cool blue-grey ground with white cards,
  // and semantics lifted off the Tailwind/Radix 600-700 steps then darkened to
  // clear the floor on this ground (a 500-step hue is AA on white but not on a
  // tinted ground).
  { key: "normal", name: "NORMAL", feel: "plain dashboard · daylight", filter: "none", ops: [], sw: "#235ddc", bg: "rgba(200,211,224,.55)", pbg: "#e3e9ef", crt: false, swp: false, glw: false, canvas: "#e3e9ef", font: "system-ui,-apple-system,'Segoe UI',sans-serif", prad: "6px", pal: { acc: "#235ddc", "acc-on": "#ffffff", "accent-rgb": "35 93 220", ok: "#107635", warn: "#a54c08", err: "#c62222", "err-hi": "#b91c1c", "err-b": "#991b1b", "err-g": "#a66b6b", info: "#026ca2", "info-hi": "#0369a1", "info-b": "#075985", purple: "#7b3aec", "purple-d": "#6d28d9", "purple-h": "#5b21b6", "purple-b": "#4c1d95", "purple-g": "#80759d", txb: "#0d1822", txh: "#222e37", tx: "#313c45", txm: "#404b54", txd: "#4d5760", txf: "#545e67", txl: "#5b646d", txg: "#737d85", panel: "#ffffff", panel2: "#f5f8fa", panel3: "#eaeff4", canvas: "#e3e9ef", mono: "ui-monospace,SFMono-Regular,Menlo,monospace" } },
  // NEWSPRINT is warm pulp, not grey: the ground is cream and the ink is a warm
  // near-black. Its accent stays press-black (that IS the identity), so colour
  // arrives the way a printed page gets it — spot inks: a printer's green, an
  // ochre highlight, correction red, an ink blue, a plum.
  { key: "newsprint", name: "NEWSPRINT", feel: "morning paper · ink & spot colour", filter: "none", ops: [], sw: "#1a1a18", bg: "rgba(210,201,181,.55)", pbg: "#e8e2d3", crt: false, swp: false, glw: false, canvas: "#e8e2d3", font: "Georgia,'Times New Roman',serif", prad: "0", pal: { acc: "#1a1a18", "acc-on": "#f6f4ee", "accent-rgb": "26 26 24", ok: "#2f6b45", warn: "#7b5f10", err: "#b02a2a", "err-hi": "#8f2222", "err-b": "#711b1b", "err-g": "#916d6d", info: "#1f5586", "info-hi": "#18446b", "info-b": "#123350", purple: "#6b4a72", "purple-d": "#5c3f63", "purple-h": "#4d3453", "purple-b": "#3e2a43", "purple-g": "#827187", txb: "#14110c", txh: "#2b2821", tx: "#3a362f", txm: "#49453e", txd: "#56524a", txf: "#5d5950", txl: "#646057", txg: "#7c776d", panel: "#fbf9f3", panel2: "#f2eee2", panel3: "#e9e4d5", canvas: "#e8e2d3", mono: "'Courier New',monospace" } },
  // CANDY is a saturated bubblegum ground (it used to be near-white with a pink
  // hint) with rose-white cards on top, and warm/cool candy semantics.
  { key: "candy", name: "CANDY", feel: "bubblegum · playful pop", filter: "none", ops: [], sw: "#b41b78", bg: "rgba(240,196,220,.5)", pbg: "#f6d7e8", crt: false, swp: false, glw: false, canvas: "linear-gradient(180deg,#fce6f2,#f6d7e8)", font: "'Trebuchet MS','Comic Sans MS',sans-serif", prad: "99px", pal: { acc: "#b41b78", "acc-on": "#ffffff", "accent-rgb": "180 27 120", ok: "#0e6c65", warn: "#8a5406", err: "#bd1d1d", "err-hi": "#ad1a1a", "err-b": "#8f1616", "err-g": "#9b6671", info: "#1d4ed8", "info-hi": "#1e40af", "info-b": "#1e3a8a", purple: "#882ed1", "purple-d": "#7e22ce", "purple-h": "#6b21a8", "purple-b": "#581c87", "purple-g": "#9362a3", txb: "#1a0612", txh: "#34202b", tx: "#442e3b", txm: "#543e4a", txd: "#614b57", txf: "#68515e", txl: "#6f5764", txg: "#886e7d", panel: "#fffafd", panel2: "#fdeef6", panel3: "#f9e2ee", canvas: "#f6d7e8", mono: "Menlo,Consolas,monospace" } },
  ...CLAUDE_DEFS,
  // BLUEPRINT used to be blue-on-blue: acc/info/purple all landed within ~10° of
  // hue, so a warning and a link were the same colour. The blue drafting ink
  // stays the accent; the semantics are the annotations that actually go on a
  // blueprint — red pencil, highlighter amber, approval-stamp green — plus a
  // cyan and a violet far enough off the ink to be told apart at a glance.
  { key: "blueprint", name: "BLUEPRINT", feel: "drafting table · pencil annotations", filter: "none", ops: [], sw: "#7fb0ff", bg: "rgba(5,10,22,.55)", pbg: "#061024", crt: false, swp: false, glw: false, canvas: "repeating-linear-gradient(0deg,rgba(127,176,255,.06) 0 1px,transparent 1px 26px),repeating-linear-gradient(90deg,rgba(127,176,255,.06) 0 1px,transparent 1px 26px),#06101f", font: "", prad: "0", pal: { acc: "#7fb0ff", "acc-on": "#04101f", "accent-rgb": "127 176 255", ok: "#5fe0a8", warn: "#ffc861", err: "#ff8a7a", "err-hi": "#ffbdb2", "err-b": "#ffd8d0", "err-g": "#a4675c", info: "#63d7f0", "info-hi": "#9ee7f7", "info-b": "#cdf2fb", purple: "#c4a6ff", "purple-d": "#b18eff", "purple-h": "#d7c2ff", "purple-b": "#e8dcff", "purple-g": "#7a68ab", txb: "#e8f0fc", txh: "#cdd9ee", tx: "#b4c4de", txm: "#93a6c4", txd: "#7b8ead", txf: "#6f84a4", txl: "#677da6", txg: "#32405c", panel: "#081226", panel2: "#060e1c", panel3: "#040912", canvas: "#06101f", mono: "'JetBrains Mono',monospace" } },
  // ---- ported from vvd.world -----------------------------------------------
  // Four themes from vvd's public theme gallery, picked for long reading: the
  // two most-applied on the platform (Dusk, 11 applies; Apex, 4 — its most-used
  // light one) plus its dark-academia and sage-paper looks. Chosen for LOW
  // chroma and no motion; the platform's loud themes (neon pink, 80% grain)
  // were skipped on purpose.
  //
  // A vvd theme is only (mode, primaryColor, grain, headingFont, bodyFont,
  // wallpaper) — an accent over a photo, not a token set. So `acc` keeps vvd's
  // primaryColor HUE and the rest of the palette is derived here: each ink tier
  // and semantic is placed at a fixed hue and its lightness solved until it hits
  // this file's documented ratio on that theme's own canvas. Two consequences:
  //   - The light pair darkens vvd's primary to clear the 4.45:1 floor — a
  //     mid-tone steel or sage is AA on a photo, not on a paper ground.
  //   - LIBRARY's #604020 is a GROUND at its own lightness, so its accent is
  //     that same brown lifted to a gold; the brown became the canvas instead.
  // vvd's `grain` survives only on the two paper themes, as a ~2% cross-hatch in
  // `canvas` (the BLUEPRINT grid trick) — at vvd's own strength it would fight
  // 9px caption text.
  { key: "dusk", name: "DUSK", feel: "muted slate · vvd's most-applied", filter: "none", ops: [], sw: "#8fb3b0", bg: "rgba(18,24,24,.55)", pbg: "#0e1414", crt: false, swp: false, glw: false, canvas: "#121818", font: "'EB Garamond',Georgia,serif", prad: "6px", pal: { acc: "#8fb3b0", "acc-on": "#0d1414", "accent-rgb": "143 179 176", ok: "#3d965b", warn: "#a18226", err: "#d6614f", "err-hi": "#dd7e6f", "err-b": "#e4988c", "err-g": "#9a6057", info: "#3e8bc2", "info-hi": "#5f9fcd", "info-b": "#7db1d6", purple: "#a470c9", "purple-d": "#9f68c6", "purple-h": "#b287d1", "purple-b": "#c19eda", "purple-g": "#85619e", txb: "#eceff0", txh: "#d6dddd", tx: "#bec9ca", txm: "#a1b1b2", txd: "#8da0a1", txf: "#819698", txl: "#768d8f", txg: "#5d7072", panel: "#1a2323", panel2: "#151d1d", panel3: "#101616", canvas: "#121818", mono: "'JetBrains Mono',monospace" } },
  { key: "library", name: "THE LIBRARY", feel: "lamplit vellum · vvd dark academia", filter: "none", ops: [], sw: "#cda76a", bg: "rgba(23,18,12,.55)", pbg: "#120e08", crt: false, swp: false, glw: false, canvas: "repeating-linear-gradient(27deg,rgba(205,167,106,.022) 0 1px,transparent 1px 4px),repeating-linear-gradient(-63deg,rgba(205,167,106,.018) 0 1px,transparent 1px 5px),#17120c", font: "'EB Garamond',Georgia,serif", prad: "3px", pal: { acc: "#cda76a", "acc-on": "#150f08", "accent-rgb": "205 167 106", ok: "#3f9262", warn: "#848727", err: "#d65c50", "err-hi": "#dd796f", "err-b": "#e4938b", "err-g": "#9d5a54", info: "#3e8bb1", "info-hi": "#539ec3", "info-b": "#73b0ce", purple: "#a56bc2", "purple-d": "#a163bf", "purple-h": "#b483cc", "purple-b": "#c29ad6", "purple-g": "#855e99", txb: "#eceae7", txh: "#dcd7d1", tx: "#c9c2b8", txm: "#b2a99c", txd: "#a39787", txf: "#9a8d7c", txl: "#928471", txg: "#736859", panel: "#221a11", panel2: "#1c150e", panel3: "#13100a", canvas: "#17120c", mono: "'JetBrains Mono',monospace" } },
  { key: "apex", name: "APEX", feel: "steel daylight · vvd sci-fi calm", filter: "none", ops: [], sw: "#39688c", bg: "rgba(198,209,220,.55)", pbg: "#e4e9ee", crt: false, swp: false, glw: false, canvas: "#e4e9ee", font: "'Work Sans',system-ui,-apple-system,sans-serif", prad: "8px", pal: { acc: "#39688c", "acc-on": "#ffffff", "accent-rgb": "57 104 140", ok: "#217149", warn: "#895916", err: "#ba3023", "err-hi": "#9d291e", "err-b": "#822119", "err-g": "#9e6c67", info: "#1a6e71", "info-hi": "#165d5f", "info-b": "#124c4e", purple: "#8d35cd", "purple-d": "#822fbe", "purple-h": "#782cae", "purple-b": "#642491", "purple-g": "#8b6e9f", txb: "#11181f", txh: "#212d3a", tx: "#2b3b4c", txm: "#364b60", txd: "#3f5770", txf: "#445e79", txl: "#496582", txg: "#5b7ea2", panel: "#ffffff", panel2: "#f4f7fa", panel3: "#eaeff4", canvas: "#e4e9ee", mono: "'JetBrains Mono',monospace" } },
  { key: "gloam", name: "GLOAM", feel: "sage paper · vvd quiet serif", filter: "none", ops: [], sw: "#4e6b3a", bg: "rgba(206,211,196,.55)", pbg: "#e6e8e0", crt: false, swp: false, glw: false, canvas: "repeating-linear-gradient(27deg,rgba(78,107,58,.02) 0 1px,transparent 1px 4px),repeating-linear-gradient(-63deg,rgba(78,107,58,.016) 0 1px,transparent 1px 5px),#e6e8e0", font: "'Spectral',Georgia,serif", prad: "4px", pal: { acc: "#4e6b3a", "acc-on": "#ffffff", "accent-rgb": "78 107 58", ok: "#25704b", warn: "#805d17", err: "#b73225", "err-hi": "#992a1f", "err-b": "#80231a", "err-g": "#9e6b67", info: "#286795", "info-hi": "#21577e", "info-b": "#1c4868", purple: "#9137be", "purple-d": "#8532ae", "purple-h": "#7a2ea0", "purple-b": "#652684", "purple-g": "#8d6c9d", txb: "#131711", txh: "#262d21", tx: "#323c2b", txm: "#404c37", txd: "#4b5941", txf: "#516046", txl: "#56664a", txg: "#6b805d", panel: "#fbfbf7", panel2: "#f2f3ec", panel3: "#ebece4", canvas: "#e6e8e0", mono: "'JetBrains Mono',monospace" } },
  // RISO is the only theme whose palette is a CONSTRAINT rather than a hue: a
  // risograph press has a fixed ink catalog and no blending, so colour is
  // chosen from stock inks and extended by OVERPRINTING one plate over another.
  // Hence `purple` is not a picked violet — it's pink-over-blue, the third
  // colour the press gives you for free. The inks are darkened off their fluoro
  // originals (real riso pink #ff48b0 is ~1.9:1 on paper, i.e. invisible as
  // text); hue is what survives, lightness is solved against the stock like
  // every other light theme here.
  //
  // Two structural tells, both in index.css: the `canvas` carries two offset
  // halftone dot fields — one per plate, pink and blue — and `.panel` drops the
  // neutral shadow for a MISREGISTERED pair of 1.5px ink edges, the way a sheet
  // that shifted between passes prints.
  { key: "riso", name: "RISO", feel: "three-ink zine · overprint & misregistration", filter: "none", ops: [], sw: "#bd1a5e", bg: "rgba(214,209,199,.55)", pbg: "#f0eee9", crt: false, swp: false, glw: false, canvas: "radial-gradient(rgba(189,26,94,.05) .5px,transparent .5px) 0 0/6px 6px,radial-gradient(rgba(9,104,172,.045) .5px,transparent .5px) 3px 3px/6px 6px,#f0eee9", font: "'Space Grotesk',system-ui,-apple-system,sans-serif", prad: "2px", pal: { acc: "#bd1a5e", "acc-on": "#ffffff", "accent-rgb": "189 26 94", ok: "#0c7443", warn: "#9b5108", err: "#c5211c", "err-hi": "#b01a15", "err-b": "#9b140f", "err-g": "#b56c69", info: "#0968ac", "info-hi": "#065c9a", "info-b": "#045087", purple: "#962ed2", "purple-d": "#8526bc", "purple-h": "#771fab", "purple-b": "#6a1899", "purple-g": "#9a6fb3", txb: "#181c25", txh: "#2b303b", tx: "#383d49", txm: "#474d5a", txd: "#535966", txf: "#5a606e", txl: "#606774", txg: "#76808d", panel: "#fefdfb", panel2: "#faf8f4", panel3: "#f5f3ee", canvas: "#f0eee9", mono: "'JetBrains Mono',monospace" } },
  // VOID is the dark counterpart to NEWSPRINT: its accent is achromatic on
  // purpose (paper-white, where NEWSPRINT's is press-black), so the only colour
  // on screen is a colour that MEANS something — a warning, an error, a link.
  // The ground is true #000, so on an OLED panel the canvas is unlit pixels and
  // a panel is one step of grey above nothing. No glow and no shadow: a drop
  // shadow on black is invisible, so depth is that surface step plus the
  // accent's own 16% hairline (--border), and nothing else.
  { key: "void", name: "VOID", feel: "true black · colour only where it means something", filter: "none", ops: [], sw: "#ffffff", bg: "rgba(0,0,0,.55)", pbg: "#000000", crt: false, swp: false, glw: false, canvas: "#000000", font: "system-ui,-apple-system,'Segoe UI',sans-serif", prad: "0", pal: { acc: "#ffffff", "acc-on": "#000000", "accent-rgb": "255 255 255", ok: "#4ade80", warn: "#fbbf24", err: "#f87171", "err-hi": "#fca5a5", "err-b": "#fecaca", "err-g": "#8a5c5c", info: "#60a5fa", "info-hi": "#93c5fd", "info-b": "#bfdbfe", purple: "#c084fc", "purple-d": "#a855f7", "purple-h": "#d8b4fe", "purple-b": "#e9d5ff", "purple-g": "#6f5b86", txb: "#ffffff", txh: "#ededed", tx: "#d4d4d4", txm: "#b4b4b4", txd: "#9a9a9a", txf: "#8d8d8d", txl: "#828282", txg: "#565656", panel: "#121212", panel2: "#0b0b0b", panel3: "#070707", canvas: "#000000", mono: "'JetBrains Mono',monospace" } },
  // NOCTURNE is the gap the other eleven darks leave: every one of them is loud
  // about something — CRT glass (AURORA), true black (VOID), a drafting grid
  // (BLUEPRINT), a mood (LIBRARY, DUSK). This one is the plain low-chroma night
  // an editor theme is: an indigo ground, a periwinkle accent, and ink solved to
  // DUSK's contrast ladder (txb 15.5 · txh 13 · tx 10.5 · txm 8 · txd 6.5 ·
  // txf 5.75 · txl 5.1 · txg 3.45 on its own canvas) so 9px captions survive a
  // long session. The ink carries the ground's hue (232°) instead of going
  // neutral grey — grey ink on a tinted ground is the tell that a palette was
  // recoloured rather than authored.
  //
  // Its semantics deliberately spread AWAY from the accent: the accent is a
  // blue-violet, so `info` is pushed to cyan (195°) and `purple` to a magenta
  // violet (271°), keeping every pair >20° apart. The only structural tell is a
  // faint sky-glow at the top of the canvas — no grid, no grain, no bloom.
  { key: "nocturne", name: "NOCTURNE", feel: "indigo night · low chroma, long sessions", filter: "none", ops: [], sw: "#a3b3f5", bg: "rgba(20,20,31,.55)", pbg: "#101019", crt: false, swp: false, glw: false, canvas: "radial-gradient(120% 80% at 50% 0%,rgba(163,179,245,.05),transparent 60%),#14141f", font: "'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace", prad: "6px", pal: { acc: "#a3b3f5", "acc-on": "#12121c", "accent-rgb": "163 179 245", ok: "#6fd7a2", warn: "#e0b458", err: "#e88b7d", "err-hi": "#f2b3a8", "err-b": "#f7d2ca", "err-g": "#8c6058", info: "#63c7e8", "info-hi": "#95dcf2", "info-b": "#c4ecf9", purple: "#c79af0", "purple-d": "#b98ae8", "purple-h": "#d5b0f5", "purple-b": "#e6d1fa", "purple-g": "#7a6690", txb: "#ebecf2", txh: "#d7d8e5", tx: "#c0c3d7", txm: "#a6aac6", txd: "#9399ba", txf: "#898eb3", txl: "#7f86ad", txg: "#616898", panel: "#1f1f2e", panel2: "#191926", panel3: "#101019", canvas: "#14141f", mono: "'JetBrains Mono',monospace" } },
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

/**
 * A theme carries a palette and a DEFAULT type voice; the voice is not welded
 * to it. `HudSettings.font` holds a key from here ("" = whatever the theme
 * brought), so any palette can be read in any of these. The list is exactly the
 * families the dashboard already loads (index.css `@import`, main.tsx
 * `@fontsource`) — picking one never waits on a font that isn't there.
 */
export const FONTS: { key: string; label: string; stack: string }[] = [
  { key: "", label: "THEME", stack: "" },
  { key: "hud", label: "SHARE TECH", stack: '"Share Tech Mono","JetBrains Mono",ui-monospace,monospace' },
  { key: "jetbrains", label: "JETBRAINS", stack: "'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace" },
  { key: "system", label: "SYSTEM", stack: "system-ui,-apple-system,'Segoe UI',sans-serif" },
  { key: "work", label: "WORK SANS", stack: "'Work Sans',system-ui,-apple-system,sans-serif" },
  { key: "grotesk", label: "GROTESK", stack: "'Space Grotesk',system-ui,-apple-system,sans-serif" },
  { key: "garamond", label: "GARAMOND", stack: "'EB Garamond',Georgia,serif" },
  { key: "spectral", label: "SPECTRAL", stack: "'Spectral',Georgia,serif" },
  { key: "georgia", label: "GEORGIA", stack: "Georgia,'Times New Roman',serif" },
  { key: "trebuchet", label: "TREBUCHET", stack: "'Trebuchet MS','Comic Sans MS',sans-serif" },
];

/** "" (or an unknown key) → the theme's own font. */
export function fontStack(key: string, t: ThemeKey): string {
  return FONTS.find((f) => f.key === key && f.key)?.stack || themeFont(t);
}

export function themePrad(t: ThemeKey): string {
  return themeDef(t).prad;
}

/**
 * The CSS filter that UNDOES the active theme's filter — apply it to media that
 * must keep its true colours inside the themed container (the nyan cat GIF; a
 * hue-rotated nyan cat is not a nyan cat). Each op is inverted and the chain
 * reversed. "none" for the palette themes, which don't filter at all. Only the
 * cleanly invertible ops are undone — `gray`/`invert` are lossy, and no theme
 * uses them today.
 */
export function themeUnfilter(t: ThemeKey): string {
  const ops = themeDef(t).ops;
  if (!ops.length) return "none";
  const out = [...ops]
    .reverse()
    .map(([k, v]) =>
      k === "hue" ? `hue-rotate(${-v}deg)`
      : k === "sat" && v > 0 ? `saturate(${1 / v})`
      : k === "bright" && v > 0 ? `brightness(${1 / v})`
      : k === "contrast" && v > 0 ? `contrast(${1 / v})`
      : "",
    )
    .filter(Boolean);
  return out.length ? out.join(" ") : "none";
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

export const RIGHT_TABS = ["projects", "files", "changes", "git", "learn", "queue"] as const;
export type RightTab = (typeof RIGHT_TABS)[number];

/** What the transcript shows while the agent works. */
export const INDICATORS = ["bar", "nyan", "piano", "tiles"] as const;
export type Indicator = (typeof INDICATORS)[number];

export interface HudSettings {
  theme: ThemeKey;
  scanlines: boolean;
  sweep: boolean;
  glow: boolean;
  rightOpen: boolean; // right sidebar expanded
  rightTab: RightTab; // which sidebar tab it opens on
  indicator: Indicator; // which working-indicator form is live
  nyan: NyanMode; // which cat, when indicator === "nyan"
  nyanSound: NyanSound; // "match" = the picked cat's own track
  nyanVolume: number; // 0..1
  nyanExtra: boolean; // fly the cat + draw nyan.cat's CSS rainbow and pixel stars
  pianoVoice: VoiceKey; // instrument voice (see VOICES)
  pianoVolume: number; // 0..1
  tilesSong: string; // which melody the tiles game drops
  tilesSpeed: TileSpeed; // how long a tile takes to fall
  radioVolume: number; // 0..1, Claude·FM
  font: string; // FONTS key; "" = the theme's own voice
  baseFont: number; // BASE FONT SIZE in px — the whole type scale is derived
                    // from it (index.css --fs); 0 = AUTO (from the viewport)
  openResults: boolean; // bash output and edit diffs draw themselves open
  // The composer's four run knobs. Kept here so they survive a reload — the
  // SESSION tab and the composer's dropdowns are the same state.
  model: string; // model id, or a short CLI alias
  allModels: boolean; // false = pickers show only the newest of each family
  effort: string; // "" = auto
  perm: string; // "" = the session's own mode
  ponytail: string; // "" = default
  // Who runs the turn: 'claude:<slot>' (a login) or 'opencode:<provider>' (a
  // free agent). "" = the ambient login, same as claude:1.
  agent: string;
  // OS-level notification when a session finishes or needs you, for the sessions
  // you're not watching. Needs the browser's permission, asked for on switch-on.
  push: boolean;
  pushSound: boolean; // blip alongside that notification
  pushTone: ToneKey; // the blip an event with no sound of its own falls back to
  pushVolume: number; // 0..1
  // One sound per event (see PUSH_EVENTS) — a synth tone, a PeonPing pack
  // sound, or "off". An event missing here has never been assigned and rings
  // pushTone, so an install that never opens this panel sounds unchanged.
  pushSounds: Partial<Record<PushEvent, SoundChoice>>;
  // Which right-sidebar panels stand on the CANVAS board, in pin order. Ids
  // are RightPanel tab ids; one that no longer exists is dropped when the pins
  // are matched against the live tab list, so no migration is needed here.
  canvasPins: string[];
}

const KEY = "hud-settings";
const DEFAULTS: HudSettings = {
  theme: "aqua", scanlines: true, sweep: true, glow: true, rightOpen: true, rightTab: "projects",
  indicator: "bar", nyan: "original", nyanSound: "match", nyanVolume: 0.4, nyanExtra: true,
  pianoVoice: "gm:acoustic_grand_piano", pianoVolume: 0.3,
  tilesSong: "fur-elise", tilesSpeed: "normal", radioVolume: 0.6,
  font: "", baseFont: 0, openResults: false,
  model: "opus", allModels: false, effort: "", perm: "", ponytail: "",
  agent: "", push: false, pushSound: true,
  pushTone: "blip", pushVolume: 0.6, pushSounds: {}, canvasPins: [],
};

/** The base every size in the type scale is authored against (index.css --fs). */
export const BASE_FONT = 12;

/** The BASE FONT SIZE picker's fixed steps, in px. 0 = AUTO. */
export const BASE_FONTS = [0, 10, 11, 12, 13, 14, 16] as const;

/**
 * AUTO base font size: the HUD is authored at 12px for a 1440×900 window, so
 * track the viewport and clamp — small laptops stay readable, big displays stop
 * rendering 9px captions. Height counts as much as width: the three-column
 * layout runs out of vertical room first on a short screen. `baseFont`
 * overrides this when non-zero.
 */
export function autoBaseFont(width: number, height: number): number {
  const fit = Math.min(width / 1440, height / 900);
  return Math.round(BASE_FONT * Math.min(1.25, Math.max(0.85, fit)));
}

const str = (v: unknown, fallback: string): string => (typeof v === "string" ? v : fallback);

const legacyVoice = (p: Partial<HudSettings> & { pianoWave?: string }): unknown =>
  p.pianoVoice ?? p.pianoWave;

const clamp01 = (v: unknown, fallback: number): number =>
  typeof v === "number" ? Math.min(1, Math.max(0, v)) : fallback;

/** Keep only the events we still ship and the entries that still look like a
 *  choice — a stored sound is a URL someone else's repo owns, so a hand-edited
 *  or half-written value shouldn't take the whole settings blob down with it. */
const soundChoices = (v: unknown): Partial<Record<PushEvent, SoundChoice>> => {
  const out: Partial<Record<PushEvent, SoundChoice>> = {};
  if (!v || typeof v !== "object") return out;
  for (const k of PUSH_EVENT_KEYS) {
    const c = (v as Record<string, unknown>)[k] as SoundChoice | undefined;
    if (c && typeof c.src === "string" && c.src) {
      out[k] = { src: c.src, label: typeof c.label === "string" && c.label ? c.label : c.src };
    }
  }
  return out;
};

export function loadSettings(): HudSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const p = JSON.parse(raw) as Partial<HudSettings> & { textScale?: number };
      return {
        // Unknown / legacy keys migrate to aqua; CLAUDE's old dark key is now
        // the only CLAUDE ground, so it lands on the clay default.
        theme:
          (p.theme as string) === "claude-dark" ? "claude"
          : THEMES.includes(p.theme as ThemeKey) ? (p.theme as ThemeKey)
          : "aqua",
        scanlines: p.scanlines ?? true,
        sweep: p.sweep ?? true,
        glow: p.glow ?? true,
        rightOpen: p.rightOpen ?? true,
        rightTab: RIGHT_TABS.includes(p.rightTab as RightTab) ? (p.rightTab as RightTab) : "projects",
        // `nyan` used to carry "off" to mean the stock bar; that role moved to
        // `indicator`, so a stored "off" migrates to indicator:"bar".
        indicator: INDICATORS.includes(p.indicator as Indicator)
          ? (p.indicator as Indicator)
          : NYAN_KEYS.includes(p.nyan as string)
            ? "nyan"
            : "bar",
        nyan: NYAN_KEYS.includes(p.nyan as string) ? (p.nyan as NyanMode) : "original",
        nyanSound:
          p.nyanSound === "off" || p.nyanSound === "match" || NYAN_KEYS.includes(p.nyanSound as string)
            ? (p.nyanSound as NyanSound)
            : "match",
        nyanVolume: clamp01(p.nyanVolume, 0.4),
        nyanExtra: p.nyanExtra ?? true,
        // `pianoWave` held a raw oscillator name before the instrument list;
        // those names survive as SYNTH voice keys, so it carries straight over.
        pianoVoice: VOICE_KEYS.includes(legacyVoice(p) as string) ? (legacyVoice(p) as VoiceKey) : "grand",
        pianoVolume: clamp01(p.pianoVolume, 0.3),
        tilesSong: SONGS.some((x) => x.key === p.tilesSong) ? (p.tilesSong as string) : "fur-elise",
        tilesSpeed: TILE_SPEEDS.includes(p.tilesSpeed as TileSpeed)
          ? (p.tilesSpeed as TileSpeed)
          : "normal",
        radioVolume: clamp01(p.radioVolume, 0.6),
        font: FONTS.some((f) => f.key === p.font) ? (p.font as string) : "",
        // `textScale` was the old whole-HUD zoom factor; a stored one carries
        // over as the base font size it was effectively rendering at.
        baseFont:
          typeof p.baseFont === "number" && p.baseFont >= 8 && p.baseFont <= 24 ? p.baseFont
          : typeof p.textScale === "number" && p.textScale >= 0.7 && p.textScale <= 1.6
            ? Math.round(BASE_FONT * p.textScale)
            : 0,
        openResults: p.openResults === true,
        // A stored model id that the live Models API no longer offers is
        // snapped to an available one on load (see App's modelOpts effect).
        model: str(p.model, "opus"),
        allModels: p.allModels === true,
        effort: str(p.effort, ""),
        perm: str(p.perm, ""),
        ponytail: str(p.ponytail, ""),
        // Like model: an agent that has gone away (account removed, key
        // cleared) is snapped back to the default login by App's agentOpts effect.
        agent: str(p.agent, ""),
        // Stored true only ever means "and the browser said yes at the time" —
        // push() re-checks the live permission before every notification.
        push: p.push ?? false,
        pushSound: p.pushSound ?? true,
        pushTone: p.pushTone && p.pushTone in TONES ? p.pushTone : "blip",
        pushVolume: clamp01(p.pushVolume, 0.6),
        pushSounds: soundChoices(p.pushSounds),
        canvasPins: Array.isArray(p.canvasPins) ? p.canvasPins.filter((x) => typeof x === "string") : [],
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
