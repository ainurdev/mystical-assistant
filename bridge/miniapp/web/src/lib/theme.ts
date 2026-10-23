// The Mini App's DISPLAY PROFILE: the dashboard's five theme families, on a phone.
//
// Everything between COPIED FROM and END COPY is bridge/dashboard/web/src/lib/theme.ts
// verbatim — that file stays the source of truth; this is a copy because the
// dashboard's module drags in push/indicator/toolwidget, the same way the
// project duplicates langfor / stick / toolfold. tests/test_miniapp_theme_sync.py
// reads both with one parser and fails on any drift, so retint the dashboard and
// paste the block again.
//
// What the phone does with it lives below the copy: the family (`data-fam`),
// the ground (`data-light`), the CRT flourish (`data-fx`) and the two reading
// picks the dashboard keeps in HudSettings — the HEADER and the LAYOUT — set on
// :root, where index.css (THE FAMILIES) reads them.

// ---- COPIED FROM bridge/dashboard/web/src/lib/theme.ts ------------------------
export type ThemeKey =
  | "aqua" | "green" | "amber" | "magenta" | "blueprint" | "void"
  | "claude" | "claude-ocean" | "claude-fern" | "claude-iris" | "claude-library" | "claude-dusk"
  | "claude-light" | "claude-ocean-light" | "claude-fern-light" | "claude-iris-light" | "claude-library-light" | "claude-dusk-light"
  | "flint-ember" | "flint-fuchsia" | "flint-sunset" | "flint-kiln" | "flint-cobalt" | "flint-nocturne" | "flint-violet" | "flint-signal"
  | "flint-ember-light" | "flint-fuchsia-light" | "flint-sunset-light" | "flint-kiln-light" | "flint-cobalt-light"
  | "flint-nocturne-light" | "flint-signal-light"
  | "pebble-sky" | "pebble-mint" | "pebble-lilac" | "pebble-rose" | "pebble-coral"
  | "pebble-sky-light" | "pebble-mint-light" | "pebble-lilac-light" | "pebble-rose-light" | "pebble-coral-light"
  | "rivendell" | "moria" | "mordor" | "mirkwood" | "osgiliath" | "amroth" | "shire" | "guldur" | "caradhras" | "valinor"
  | "rivendell-light" | "havens-light" | "edoras-light" | "mirkwood-light" | "osgiliath-light" | "amroth-light" | "shire-light"
  | "tirith-light" | "anorien-light" | "ithilien-light";

export type Family = "aurora" | "claude" | "flint" | "pebble" | "middle-earth";
export const FAMILIES: Family[] = ["aurora", "claude", "flint", "pebble", "middle-earth"];

/** "#7fb0ff" → "127 176 255", for the `rgb(var(--accent-rgb)/x)` chrome. */
const rgbTriplet = (hex: string): string =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(" ");

// ---- the palettes ------------------------------------------------------------
// A ground is a family's ink ladder, surfaces and semantics; a row puts two
// roles on one. Light grounds are solved against their own canvas to fixed
// ratios (txb 14.8 · txh 11.6 · tx 9.4 · txm 7.4 · txd 6.1 · txf 5.5 · txl 5 ·
// txg 3.45; every colour used as text ≥ 4.9) — keep hue, move lightness if you
// retint one, then re-run tests/test_light_theme_contrast.py. The tests read
// these tables with a regex: one ground per `const`, one row per line.
//
// AURORA: the aqua ground is index.css's own :root; the others are it rotated
// to each phosphor in OKLCH, so every tier keeps its contrast. The dim tiers sit
// higher than the old HUD's (txl 4.6:1, was 2.4) — a quiet label still has to be
// read. EMBER's amber IS the warning hue, so its warn turns orange and err rose:
// trouble must never wear the phosphor. BLUEPRINT and VOID keep the ladders and
// semantics they were solved with as themes of their own.
//
// CLAUDE: Claude's surfaces, and its paper for daylight; only the roles move.
// FLINT: one graphite ink; SUNSET warms the ground, KILN drops it to near-black,
// NOCTURNE is the indigo night (NOCTURNE + STUDIO, before), and the colours are
// two roles each — COBALT's `info` moves to cyan so a link is not your blue,
// and NOCTURNE's `purple` to a magenta violet so a branch chip is not your violet.
// VIOLET is NOCTURNE's roles on the graphite ground, so it moves `purple` too;
// its daylight is NOCTURNE's, so it has no `-light` twin of its own.
// PEBBLE: FLINT's ink on a lifted, cooler slate, and a chalk daylight solved to
// FLINT daylight's targets; five colours, each with a twin. SKY moves `info` to
// cyan, LILAC `purple` to magenta and CORAL `err` to crimson — COBALT's,
// NOCTURNE's and EMBER's moves — so nothing semantic wears your colour.
// MIDDLE-EARTH: Rivendell's own schemes (rivendell/frontend/src/styles), each
// its own ground: RIVENDELL by day (paper, forest is you) and by night (forest,
// gold is you), GREY HAVENS and EDORAS by day, MORIA and MORDOR by night, then
// the apps it dresses as, named here for places that match their colours —
// MIRKWOOD (Slack), OSGILIATH (Linear), DOL AMROTH (Gmail) and THE SHIRE
// (GitHub) on both grounds, MINAS TIRITH (Notion), ANÓRIEN (Solarized) and
// ITHILIEN (Rosé Pine Dawn) by day, DOL GULDUR (Dracula), CARADHRAS (Nord) and
// VALINOR (Catppuccin Mocha) by night. Each carries `side` (the frame its
// sidebar stands on), `side-row` (the open row), `side-well` (search and tab
// wells) and `crest` (our emblem's heart). The light papers are solved to the
// floors above (a white background steps half-way to its muted surface, so the
// card stays the brightest); a night's button colour too dim to read as text
// is lifted at its hue, and what's on it flips dark (MIRKWOOD, OSGILIATH, THE
// SHIRE). Every scheme keeps its own semantics even where they sit by `acc`
// (Rivendell's gold is its warning's hue), as CLAUDE does.

/** [key, NAME, feel, ground, roles] — `roles` carries `acc` and `ask`, plus
 *  anything that one colouring moves off its ground. */
type Row = [ThemeKey, string, string, Record<string, string>, Record<string, string>];

const AURORA_GLASS: Record<string, string> = { "acc-on": "#06100e", tool: "#9fc7c0", think: "#7fa39c", ok: "#8fd9a8", warn: "#e3c279", err: "#e0897a", "err-hi": "#f0d0c8", "err-b": "#f4d5cd", "err-g": "#9a6f68", info: "#6fb5ff", "info-hi": "#9fc8ff", "info-b": "#dbeeff", purple: "#b9a6ff", "purple-d": "#a78bf0", "purple-h": "#cbb8ff", "purple-b": "#e7deff", "purple-g": "#6f6088", txb: "#dff8f2", txh: "#cfe9e3", tx: "#bfe6de", txm: "#9fc7c0", txd: "#7fa39c", txf: "#6f918b", txl: "#5f817b", txg: "#2e423f", panel: "#091010", panel2: "#070d0d", panel3: "#040707", canvas: "#060a0a", mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace" };
const VIRIDIAN_GLASS: Record<string, string> = { "acc-on": "#04100a", tool: "#a3c8ae", think: "#83a48c", ok: "#8fd9a8", warn: "#e3c279", err: "#e0897a", "err-hi": "#f0d0c8", "err-b": "#f4d5cd", "err-g": "#9a6f68", info: "#6fb5ff", "info-hi": "#9fc8ff", "info-b": "#dbeeff", purple: "#b9a6ff", "purple-d": "#a78bf0", "purple-h": "#cbb8ff", "purple-b": "#e7deff", "purple-g": "#6f6088", txb: "#e2f9e6", txh: "#d2ead7", tx: "#c3e7cc", txm: "#a3c8ae", txd: "#83a48c", txf: "#72927c", txl: "#62826c", txg: "#304336", panel: "#09100d", panel2: "#070d0b", panel3: "#040706", canvas: "#060a08", mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace" };
const EMBER_GLASS: Record<string, string> = { "acc-on": "#140d02", tool: "#d0ba96", think: "#ac9777", ok: "#8fd9a8", warn: "#ff875a", err: "#ff6b7d", "err-hi": "#ffb3bb", "err-b": "#ffd3d8", "err-g": "#9e6670", info: "#6fb5ff", "info-hi": "#9fc8ff", "info-b": "#dbeeff", purple: "#b9a6ff", "purple-d": "#a78bf0", "purple-h": "#cbb8ff", "purple-b": "#e7deff", "purple-g": "#6f6088", txb: "#ffefd9", txh: "#f0e0c9", tx: "#f0d9b6", txm: "#d0ba96", txd: "#ac9777", txf: "#998668", txl: "#897658", txg: "#463c2a", panel: "#100e08", panel2: "#0d0c06", panel3: "#070604", canvas: "#0a0905", mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace" };
const NOVA_GLASS: Record<string, string> = { "acc-on": "#14060f", tool: "#d7b0c8", think: "#b08ea5", ok: "#8fd9a8", warn: "#e3c279", err: "#e0897a", "err-hi": "#f0d0c8", "err-b": "#f4d5cd", "err-g": "#9a6f68", info: "#6fb5ff", "info-hi": "#9fc8ff", "info-b": "#dbeeff", purple: "#b9a6ff", "purple-d": "#a78bf0", "purple-h": "#cbb8ff", "purple-b": "#e7deff", "purple-g": "#6f6088", txb: "#ffebf8", txh: "#f3daeb", tx: "#f5d0e8", txm: "#d7b0c8", txd: "#b08ea5", txf: "#9e7e92", txl: "#8e6e82", txg: "#4a3742", panel: "#130c0f", panel2: "#10090c", panel3: "#090506", canvas: "#0c0809", mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace" };
const BLUEPRINT_GLASS: Record<string, string> = { "acc-on": "#04101f", tool: "#93a6c4", think: "#7b8ead", ok: "#5fe0a8", warn: "#ffc861", err: "#ff8a7a", "err-hi": "#ffbdb2", "err-b": "#ffd8d0", "err-g": "#a4675c", info: "#63d7f0", "info-hi": "#9ee7f7", "info-b": "#cdf2fb", purple: "#c4a6ff", "purple-d": "#b18eff", "purple-h": "#d7c2ff", "purple-b": "#e8dcff", "purple-g": "#7a68ab", txb: "#e8f0fc", txh: "#cdd9ee", tx: "#b4c4de", txm: "#93a6c4", txd: "#7b8ead", txf: "#6f84a4", txl: "#677da6", txg: "#32405c", panel: "#081226", panel2: "#060e1c", panel3: "#040912", canvas: "#06101f", mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace" };
const VOID_GLASS: Record<string, string> = { "acc-on": "#000000", tool: "#b4b4b4", think: "#9a9a9a", ok: "#4ade80", warn: "#fbbf24", err: "#f87171", "err-hi": "#fca5a5", "err-b": "#fecaca", "err-g": "#8a5c5c", info: "#60a5fa", "info-hi": "#93c5fd", "info-b": "#bfdbfe", purple: "#c084fc", "purple-d": "#a855f7", "purple-h": "#d8b4fe", "purple-b": "#e9d5ff", "purple-g": "#6f5b86", txb: "#ffffff", txh: "#ededed", tx: "#d4d4d4", txm: "#b4b4b4", txd: "#9a9a9a", txf: "#8d8d8d", txl: "#828282", txg: "#565656", panel: "#121212", panel2: "#0b0b0b", panel3: "#070707", canvas: "#000000", mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace" };
const CLAUDE_INK: Record<string, string> = { "acc-on": "#1f1f1e", tool: "#a3b1c2", think: "#bdb3a3", ok: "#6bbf8a", warn: "#d8a657", err: "#e0796a", "err-hi": "#f2b5aa", "err-b": "#f8d3cc", "err-g": "#9c7068", info: "#7fb0e0", "info-hi": "#a8cbee", "info-b": "#cfe3f7", purple: "#a99cdb", "purple-d": "#9a8cd0", "purple-h": "#bfb4e8", "purple-b": "#dcd6f4", "purple-g": "#6e6890", txb: "#f5f4ef", txh: "#eceae5", tx: "#d7d5cd", txm: "#bfbdb4", txd: "#aba9a0", txf: "#a09d97", txl: "#999690", txg: "#4a4844", panel: "#30302e", panel2: "#262624", panel3: "#1f1f1e", canvas: "#262624", mono: "ui-monospace,SFMono-Regular,Menlo,monospace" };
const CLAUDE_PAPER: Record<string, string> = { "acc-on": "#ffffff", tool: "#505e6e", think: "#6b5a44", ok: "#256f3b", warn: "#8a5701", err: "#b13631", "err-hi": "#9a2824", "err-b": "#7d1e1b", "err-g": "#9d7671", info: "#2064a3", "info-hi": "#16558c", "info-b": "#094374", purple: "#6854a9", "purple-d": "#5e4c99", "purple-h": "#544388", "purple-b": "#463875", "purple-g": "#817b9d", txb: "#1d1a14", txh: "#312d27", tx: "#3f3b35", txm: "#4e4b44", txd: "#5b5750", txf: "#615e57", txl: "#68645d", txg: "#817e76", panel: "#fdfcf8", panel2: "#f7f6f0", panel3: "#f3f1ea", canvas: "#efede5", mono: "ui-monospace,SFMono-Regular,Menlo,monospace" };
const FLINT_INK: Record<string, string> = { "acc-on": "#160b05", tool: "#9fb3cc", think: "#b8a9d9", ok: "#30d158", warn: "#f5c542", err: "#ff5d5d", "err-hi": "#ff8a85", "err-b": "#ffb3ae", "err-g": "#8a4d4a", info: "#64b5ff", "info-hi": "#93cbff", "info-b": "#c3e2ff", purple: "#c49bff", "purple-d": "#b585ff", "purple-h": "#d5b8ff", "purple-b": "#e6d6ff", "purple-g": "#6f6290", txb: "#fafafa", txh: "#ececef", tx: "#d4d4d8", txm: "#b4b4bc", txd: "#9a9aa3", txf: "#8d8d96", txl: "#808089", txg: "#55555c", panel: "#18181b", panel2: "#131315", panel3: "#0e0e10", canvas: "#0c0c0e", mono: "'Geist Mono','JetBrains Mono',ui-monospace,monospace" };
const FLINT_WARM: Record<string, string> = { ...FLINT_INK, tool: "#b9b0a6", think: "#c3a9d6", txb: "#fbf7f3", txh: "#efe9e3", tx: "#d8d2cc", txm: "#bbb3aa", txd: "#a0978d", txf: "#938a80", txl: "#867d73", txg: "#5a534c", panel: "#1b1816", panel2: "#151311", panel3: "#0f0d0c", canvas: "#0e0c0b" };
const FLINT_KILN: Record<string, string> = { ...FLINT_INK, tool: "#8e98a8", think: "#a8a2b8", panel: "#141415", panel2: "#0f0f10", panel3: "#0a0a0b", canvas: "#09090a" };
const FLINT_NIGHT: Record<string, string> = { ...FLINT_INK, tool: "#9fb0d6", think: "#c9a9d9", purple: "#d49af5", "purple-d": "#c788f0", "purple-h": "#e0b3f8", "purple-b": "#eed6fb", "purple-g": "#7a6690", txb: "#ebecf2", txh: "#d7d8e5", tx: "#c0c3d7", txm: "#a6aac6", txd: "#9399ba", txf: "#898eb3", txl: "#7f86ad", txg: "#616898", panel: "#1d1d2c", panel2: "#171724", panel3: "#13131d", canvas: "#101019" };
const PEBBLE_INK: Record<string, string> = { "acc-on": "#0f1014", tool: "#9fb3cc", think: "#b8a9d9", ok: "#30d158", warn: "#f5c542", err: "#ff5d5d", "err-hi": "#ff8a85", "err-b": "#ffb3ae", "err-g": "#8a4d4a", info: "#64b5ff", "info-hi": "#93cbff", "info-b": "#c3e2ff", purple: "#c49bff", "purple-d": "#b585ff", "purple-h": "#d5b8ff", "purple-b": "#e6d6ff", "purple-g": "#6f6290", txb: "#f7f7fa", txh: "#e9e9ef", tx: "#d2d3da", txm: "#b3b4bd", txd: "#9a9ba5", txf: "#8e8f99", txl: "#82838d", txg: "#585962", panel: "#23242b", panel2: "#1b1c22", panel3: "#16171c", canvas: "#131419", mono: "'Geist Mono','JetBrains Mono',ui-monospace,monospace" };
const PEBBLE_DAY: Record<string, string> = { "acc-on": "#ffffff", tool: "#4b5e73", think: "#615486", ok: "#057032", warn: "#775e01", err: "#bc2122", "err-hi": "#a50d14", "err-b": "#87000a", "err-g": "#a1726d", info: "#096790", "info-hi": "#00577c", "info-b": "#034562", purple: "#7a42c2", "purple-d": "#6f3bb1", "purple-h": "#6432a1", "purple-b": "#542988", "purple-g": "#85789f", txb: "#1b1d20", txh: "#2d3034", tx: "#3b3e42", txm: "#4b4d52", txd: "#57595e", txf: "#5e6065", txl: "#64666b", txg: "#7e8085", panel: "#ffffff", panel2: "#f8f9fb", panel3: "#f3f4f7", canvas: "#eef0f4", mono: "'Geist Mono','JetBrains Mono',ui-monospace,monospace" };
const FLINT_DAY: Record<string, string> = { "acc-on": "#ffffff", tool: "#4b5e73", think: "#615486", ok: "#057032", warn: "#775e01", err: "#bc2122", "err-hi": "#a50d14", "err-b": "#87000a", "err-g": "#a1726d", info: "#096790", "info-hi": "#00577c", "info-b": "#034562", purple: "#7a42c2", "purple-d": "#6f3bb1", "purple-h": "#6432a1", "purple-b": "#542988", "purple-g": "#85789f", txb: "#18181c", txh: "#2c2c30", tx: "#3a3b3e", txm: "#4a4a4e", txd: "#56565a", txf: "#5d5d61", txl: "#636367", txg: "#7c7d81", panel: "#ffffff", panel2: "#f7f7f8", panel3: "#f1f1f3", canvas: "#ebebed", mono: "'Geist Mono','JetBrains Mono',ui-monospace,monospace" };
const ME_RIVENDELL: Record<string, string> = { "acc-on": "#0f2a24", tool: "#a9bcd6", think: "#d6c3a0", ok: "#6ccb8e", warn: "#e4b564", err: "#e88b8b", "err-hi": "#fda3a2", "err-b": "#fec5c4", "err-g": "#7c4d4d", info: "#8ab4ee", "info-hi": "#a6cafd", "info-b": "#cbe0ff", purple: "#c6a6e3", "purple-d": "#b99ad6", "purple-h": "#d9b9f7", "purple-b": "#ead6fe", "purple-g": "#63566e", txb: "#f2f7f2", txh: "#e6ebe6", tx: "#d7dcd7", txm: "#b5c5be", txd: "#9aaaa3", txf: "#8d9c95", txl: "#7f8e87", txg: "#54615c", panel: "#163730", panel2: "#12302a", panel3: "#0f2a24", canvas: "#0b1f1a", side: "#0f2a24", "side-row": "#163730", "side-well": "rgb(255 255 255 / 5%)", crest: "#b6cbdc", mono: "'Source Code Pro',ui-monospace,SFMono-Regular,Menlo,monospace" };
const ME_MORIA: Record<string, string> = { "acc-on": "#0e1014", tool: "#9fb0d6", think: "#b8a9d9", ok: "#7fd1a0", warn: "#e4b564", err: "#f08c8c", "err-hi": "#fda9a8", "err-b": "#fecbc9", "err-g": "#834e4e", info: "#8ab4ee", "info-hi": "#a6cafd", "info-b": "#cbe0ff", purple: "#c3aef0", "purple-d": "#b6a1e3", "purple-h": "#d5c3fd", "purple-b": "#e9e0ff", "purple-g": "#645c77", txb: "#e4eaf3", txh: "#d9dee7", tx: "#cacfd8", txm: "#b1b8c5", txd: "#979eaa", txf: "#8a909d", txl: "#7d838f", txg: "#525863", panel: "#1b1f27", panel2: "#15181e", panel3: "#121419", canvas: "#0e1014", side: "#0a0c0f", "side-row": "#1d222b", "side-well": "rgb(255 255 255 / 5%)", crest: "#5fd4c4", mono: "'Source Code Pro',ui-monospace,SFMono-Regular,Menlo,monospace" };
const ME_MORDOR: Record<string, string> = { "acc-on": "#1a0f0c", tool: "#bba9a2", think: "#d9b8a4", ok: "#8fcf7a", warn: "#f5b83d", err: "#ff8a7a", "err-hi": "#ffafa3", "err-b": "#ffd1c9", "err-g": "#914c43", info: "#9ab8e0", "info-hi": "#b0cef7", "info-b": "#d3e4fb", purple: "#d0a6e0", "purple-d": "#c39ad3", "purple-h": "#e4b9f4", "purple-b": "#f3d6fe", "purple-g": "#68576f", txb: "#f8efeb", txh: "#ece3df", tx: "#ddd4d0", txm: "#c3b5b0", txd: "#a89b96", txf: "#9b8e89", txl: "#8e817c", txg: "#625551", panel: "#241c1a", panel2: "#1c1615", panel3: "#181312", canvas: "#141010", side: "#0f0b0b", "side-row": "#2a1c18", "side-well": "rgb(255 255 255 / 5%)", crest: "#f5b83d", mono: "'Source Code Pro',ui-monospace,SFMono-Regular,Menlo,monospace" };
const ME_MIRKWOOD: Record<string, string> = { "acc-on": "#1a1d21", tool: "#b7c8e2", think: "#e3cda6", ok: "#2bac76", warn: "#ecb22e", err: "#f2547d", "err-hi": "#fc7b97", "err-b": "#fea3b3", "err-g": "#85173a", info: "#36c5f0", "info-hi": "#74d9fd", "info-b": "#b6eafe", purple: "#d9bcd9", "purple-d": "#ccafcc", "purple-h": "#edcfed", "purple-b": "#f9edf9", "purple-g": "#6c6b6c", txb: "#dcddde", txh: "#d1d2d3", tx: "#c3c4c4", txm: "#b5b5b5", txd: "#a6a7a8", txf: "#99999a", txl: "#8b8c8d", txg: "#5f5f60", panel: "#2c2d30", panel2: "#222529", panel3: "#1e2125", canvas: "#1a1d21", side: "#19171d", "side-row": "#350d36", "side-well": "rgb(255 255 255 / 5%)", crest: "#36c5f0", mono: "'Source Code Pro',ui-monospace,SFMono-Regular,Menlo,monospace" };
const ME_OSGILIATH: Record<string, string> = { "acc-on": "#08090a", tool: "#b7c8e2", think: "#e3cda6", ok: "#4cb782", warn: "#f2c94c", err: "#eb5757", "err-hi": "#fc7672", "err-b": "#ff9c97", "err-g": "#7e1b20", info: "#4ea7fc", "info-hi": "#7fbdfd", "info-b": "#abd3fd", purple: "#d9bcd9", "purple-d": "#ccafcc", "purple-h": "#edcfed", "purple-b": "#f9edf9", "purple-g": "#6c6b6c", txb: "#fdfefe", txh: "#f7f8f8", tx: "#e8e9e9", txm: "#afb4bb", txd: "#959aa1", txf: "#898d94", txl: "#7c8087", txg: "#51555b", panel: "#1c1c1f", panel2: "#0f1011", panel3: "#0c0c0e", canvas: "#08090a", side: "#0b0c0d", "side-row": "#1c1c1f", "side-well": "rgb(255 255 255 / 5%)", crest: "#7170ff", mono: "'Source Code Pro',ui-monospace,SFMono-Regular,Menlo,monospace" };
const ME_AMROTH: Record<string, string> = { "acc-on": "#062e6f", tool: "#b7c8e2", think: "#e3cda6", ok: "#6dd58c", warn: "#fcc934", err: "#f2b8b5", "err-hi": "#fed4d1", "err-b": "#fff2f1", "err-g": "#837574", info: "#7cacf8", "info-hi": "#9dc3ff", "info-b": "#c2daff", purple: "#d9bcd9", "purple-d": "#ccafcc", "purple-h": "#edcfed", "purple-b": "#f9edf9", "purple-g": "#6c6b6c", txb: "#efefef", txh: "#e3e3e3", tx: "#d4d4d4", txm: "#b5babe", txd: "#9ba0a4", txf: "#8e9397", txl: "#81858a", txg: "#555a5e", panel: "#282a2c", panel2: "#1e1f20", panel3: "#18191a", canvas: "#131314", side: "#131314", "side-row": "#004a77", "side-well": "rgb(255 255 255 / 5%)", crest: "#f28b82", mono: "'Source Code Pro',ui-monospace,SFMono-Regular,Menlo,monospace" };
const ME_SHIRE: Record<string, string> = { "acc-on": "#0d1117", tool: "#b7c8e2", think: "#e3cda6", ok: "#3fb950", warn: "#d29922", err: "#f85149", "err-hi": "#fd7d71", "err-b": "#ffa399", "err-g": "#8a0f12", info: "#4493f8", "info-hi": "#6cabfe", "info-b": "#95c2fd", purple: "#d9bcd9", "purple-d": "#ccafcc", "purple-h": "#edcfed", "purple-b": "#f9edf9", "purple-g": "#6c6b6c", txb: "#fcfeff", txh: "#f0f6fc", tx: "#e1e7ed", txm: "#b3b8c0", txd: "#999ea5", txf: "#8b9198", txl: "#7e848b", txg: "#53595f", panel: "#212830", panel2: "#151b23", panel3: "#11161d", canvas: "#0d1117", side: "#010409", "side-row": "#212830", "side-well": "rgb(255 255 255 / 5%)", crest: "#4493f8", mono: "'Source Code Pro',ui-monospace,SFMono-Regular,Menlo,monospace" };
const ME_GULDUR: Record<string, string> = { "acc-on": "#21222c", tool: "#b7c8e2", think: "#e3cda6", ok: "#50fa7b", warn: "#ffb86c", err: "#ff5555", "err-hi": "#fd8781", "err-b": "#fdada6", "err-g": "#90151d", info: "#8be9fd", "info-hi": "#d3f7ff", "info-b": "#e4faff", purple: "#d9bcd9", "purple-d": "#ccafcc", "purple-h": "#edcfed", "purple-b": "#f9edf9", "purple-g": "#6c6b6c", txb: "#fefef8", txh: "#f8f8f2", tx: "#e9e9e3", txm: "#c8cdea", txd: "#afb5d1", txf: "#a2a6c3", txl: "#9398b3", txg: "#656983", panel: "#343746", panel2: "#2e303e", panel3: "#2b2d3a", canvas: "#282a36", side: "#21222c", "side-row": "#343746", "side-well": "rgb(255 255 255 / 5%)", crest: "#ff79c6", mono: "'Source Code Pro',ui-monospace,SFMono-Regular,Menlo,monospace" };
const ME_CARADHRAS: Record<string, string> = { "acc-on": "#2e3440", tool: "#b7c8e2", think: "#e3cda6", ok: "#a3be8c", warn: "#ebcb8b", err: "#e9868f", "err-hi": "#fe9ea6", "err-b": "#ffc1c5", "err-g": "#7d494e", info: "#81a1c1", "info-hi": "#96b7d8", "info-b": "#bbccdc", purple: "#d9bcd9", "purple-d": "#ccafcc", "purple-h": "#edcfed", "purple-b": "#f9edf9", "purple-g": "#6c6b6c", txb: "#f2f5fa", txh: "#eceff4", tx: "#dde0e5", txm: "#c9d1e1", txd: "#b9c3d2", txf: "#abb4c3", txl: "#9ca5b4", txg: "#6b7482", panel: "#434c5e", panel2: "#3b4252", panel3: "#343b49", canvas: "#2e3440", side: "#292e39", "side-row": "#3b4252", "side-well": "rgb(255 255 255 / 5%)", crest: "#5e81ac", mono: "'Source Code Pro',ui-monospace,SFMono-Regular,Menlo,monospace" };
const ME_VALINOR: Record<string, string> = { "acc-on": "#1e1e2e", tool: "#b7c8e2", think: "#e3cda6", ok: "#a6e3a1", warn: "#f9e2af", err: "#f38ba8", "err-hi": "#fdabc0", "err-b": "#feced9", "err-g": "#874e5e", info: "#89b4fa", "info-hi": "#accbfd", "info-b": "#cfe1fe", purple: "#d9bcd9", "purple-d": "#ccafcc", "purple-h": "#edcfed", "purple-b": "#f9edf9", "purple-g": "#6c6b6c", txb: "#d9e2fe", txh: "#cdd6f4", tx: "#bfc7e5", txm: "#b2b8cd", txd: "#a3a9be", txf: "#969bb0", txl: "#888ea2", txg: "#5c6174", panel: "#2a2b3c", panel2: "#232334", panel3: "#202031", canvas: "#1e1e2e", side: "#181825", "side-row": "#313244", "side-well": "rgb(255 255 255 / 5%)", crest: "#fab387", mono: "'Source Code Pro',ui-monospace,SFMono-Regular,Menlo,monospace" };
const ME_RIVENDELL_PAPER: Record<string, string> = { "acc-on": "#ffffff", tool: "#3f5470", think: "#6e5526", ok: "#2e7d4f", warn: "#916101", err: "#b3413f", "err-hi": "#9f2e2f", "err-b": "#8a181e", "err-g": "#d5605c", info: "#2f63b8", "info-hi": "#2154a8", "info-b": "#0e4295", purple: "#7d5c7d", "purple-d": "#735274", "purple-h": "#684969", "purple-b": "#5b3b5c", "purple-g": "#9c799d", txb: "#19221f", txh: "#2b3531", tx: "#38433f", txm: "#47524e", txd: "#535f5a", txf: "#5a6561", txl: "#606c67", txg: "#7a8681", panel: "#ffffff", panel2: "#fcfcfa", panel3: "#f9f8f5", canvas: "#f6f5f0", side: "#2e4a3f", "side-row": "rgb(255 255 255 / 11%)", "side-well": "rgb(255 255 255 / 8%)", crest: "#b6cbdc", mono: "'Source Code Pro',ui-monospace,SFMono-Regular,Menlo,monospace" };
const ME_HAVENS: Record<string, string> = { "acc-on": "#ffffff", tool: "#3f5470", think: "#6e5526", ok: "#287756", warn: "#906100", err: "#b3413f", "err-hi": "#9f2d2e", "err-b": "#8a171e", "err-g": "#d55f5b", info: "#0f6e78", "info-hi": "#00606a", "info-b": "#014e55", purple: "#7d5b7d", "purple-d": "#735273", "purple-h": "#684869", "purple-b": "#5a3b5c", "purple-g": "#9b799c", txb: "#112226", txh: "#23353a", tx: "#314348", txm: "#3f5257", txd: "#4c5f64", txf: "#52666b", txl: "#596c71", txg: "#72868b", panel: "#fbfdfd", panel2: "#f8fafa", panel3: "#f4f8f8", canvas: "#f1f5f5", side: "#e3eced", "side-row": "#fbfdfd", "side-well": "#d5dfe1", crest: "#c4513a", mono: "'Source Code Pro',ui-monospace,SFMono-Regular,Menlo,monospace" };
const ME_EDORAS: Record<string, string> = { "acc-on": "#fff6e0", tool: "#3f5470", think: "#6e5526", ok: "#3d6b1f", warn: "#835504", err: "#a3121b", "err-hi": "#9c0214", "err-b": "#7c000d", "err-g": "#d24743", info: "#2f5d8a", "info-hi": "#204e7a", "info-b": "#0b3c67", purple: "#715071", "purple-d": "#664768", "purple-h": "#5c3d5e", "purple-b": "#4e3050", "purple-g": "#8e6c8f", txb: "#180a03", txh: "#332218", tx: "#433127", txm: "#534035", txd: "#5f4d41", txf: "#675348", txl: "#6d594e", txg: "#877266", panel: "#faf1cf", panel2: "#f7ecc1", panel3: "#f4e6b4", canvas: "#f1e1a6", side: "#e6cf82", "side-row": "#faf1cf", "side-well": "#d8c078", crest: "#c79a2e", mono: "'Source Code Pro',ui-monospace,SFMono-Regular,Menlo,monospace" };
const ME_MIRKWOOD_PAPER: Record<string, string> = { "acc-on": "#ffffff", tool: "#3f5470", think: "#6e5526", ok: "#007a5a", warn: "#93660a", err: "#d91155", "err-hi": "#b70044", "err-b": "#970237", "err-g": "#fa3f6f", info: "#1264a3", "info-hi": "#075e9d", "info-b": "#004c83", purple: "#816082", "purple-d": "#775678", "purple-h": "#6d4c6e", "purple-b": "#5f3f60", "purple-g": "#a17ea1", txb: "#272527", txh: "#383638", tx: "#464446", txm: "#555355", txd: "#616061", txf: "#686668", txl: "#6f6d6f", txg: "#898789", panel: "#ffffff", panel2: "#fefefe", panel3: "#fdfdfd", canvas: "#fcfcfc", side: "#3f0e40", "side-row": "rgb(255 255 255 / 14%)", "side-well": "rgb(255 255 255 / 8%)", crest: "#2eb67d", mono: "'Source Code Pro',ui-monospace,SFMono-Regular,Menlo,monospace" };
const ME_OSGILIATH_PAPER: Record<string, string> = { "acc-on": "#ffffff", tool: "#3f5470", think: "#6e5526", ok: "#007e4e", warn: "#91660b", err: "#cd3235", "err-hi": "#b41220", "err-b": "#970215", "err-g": "#ed524f", info: "#226dca", "info-hi": "#0458b3", "info-b": "#044793", purple: "#805f81", "purple-d": "#765577", "purple-h": "#6c4b6d", "purple-b": "#5e3e5f", "purple-g": "#9f7da0", txb: "#23242a", txh: "#33363c", tx: "#41434a", txm: "#505259", txd: "#5d5f66", txf: "#63666d", txl: "#6a6c74", txg: "#84878e", panel: "#ffffff", panel2: "#fdfdfe", panel3: "#fcfcfd", canvas: "#fafafc", side: "#f5f5f7", "side-row": "#e8e9ee", "side-well": "#dcdde3", crest: "#5e6ad2", mono: "'Source Code Pro',ui-monospace,SFMono-Regular,Menlo,monospace" };
const ME_AMROTH_PAPER: Record<string, string> = { "acc-on": "#ffffff", tool: "#3f5470", think: "#6e5526", ok: "#146c2e", warn: "#8c5a00", err: "#b3261e", "err-hi": "#ad1f19", "err-b": "#940606", "err-g": "#e55749", info: "#0b57d0", "info-hi": "#0150c9", "info-b": "#0241a4", purple: "#7f5d80", "purple-d": "#755476", "purple-h": "#6b4a6c", "purple-b": "#5d3d5e", "purple-g": "#9e7b9f", txb: "#232222", txh: "#353434", tx: "#434242", txm: "#525151", txd: "#5e5e5d", txf: "#656464", txl: "#6b6b6b", txg: "#868585", panel: "#ffffff", panel2: "#fcfdfe", panel3: "#f9fafd", canvas: "#f6f8fc", side: "#f6f8fc", "side-row": "#d3e3fd", "side-well": "#e9eef6", crest: "#ea4335", mono: "'Source Code Pro',ui-monospace,SFMono-Regular,Menlo,monospace" };
const ME_SHIRE_PAPER: Record<string, string> = { "acc-on": "#ffffff", tool: "#3f5470", think: "#6e5526", ok: "#1a7f37", warn: "#9a6700", err: "#cf222e", "err-hi": "#b70c21", "err-b": "#990016", "err-g": "#f44c4d", info: "#0969da", "info-hi": "#0157bb", "info-b": "#034799", purple: "#815f82", "purple-d": "#775678", "purple-h": "#6d4c6e", "purple-b": "#5f3f60", "purple-g": "#a07ea1", txb: "#21262b", txh: "#33373d", tx: "#40454a", txm: "#4f545a", txd: "#5c6066", txf: "#63676d", txl: "#696d74", txg: "#83888f", panel: "#ffffff", panel2: "#fdfefe", panel3: "#fcfdfd", canvas: "#fafcfc", side: "#f6f8fa", "side-row": "#e7ebef", "side-well": "#d1d9e0", crest: "#0969da", mono: "'Source Code Pro',ui-monospace,SFMono-Regular,Menlo,monospace" };
const ME_TIRITH: Record<string, string> = { "acc-on": "#ffffff", tool: "#3f5470", think: "#6e5526", ok: "#3b7a58", warn: "#986201", err: "#c53d3a", "err-hi": "#ac2426", "err-b": "#970213", "err-g": "#e45b54", info: "#28749f", "info-hi": "#09608a", "info-b": "#004e73", purple: "#805f81", "purple-d": "#765577", "purple-h": "#6c4b6d", "purple-b": "#5e3e5f", "purple-g": "#9f7da0", txb: "#26241f", txh: "#38352f", tx: "#46433d", txm: "#55524c", txd: "#625f59", txf: "#686660", txl: "#6f6c66", txg: "#898680", panel: "#ffffff", panel2: "#fefdfd", panel3: "#fcfcfb", canvas: "#fbfaf9", side: "#f7f7f5", "side-row": "#ebebea", "side-well": "#e0dfdc", crest: "#2383e2", mono: "'Source Code Pro',ui-monospace,SFMono-Regular,Menlo,monospace" };
const ME_ANORIEN: Record<string, string> = { "acc-on": "#ffffff", tool: "#3f5470", think: "#6e5526", ok: "#63720e", warn: "#876705", err: "#d02425", "err-hi": "#b30312", "err-b": "#92040d", "err-g": "#f04841", info: "#0170b2", "info-hi": "#035c91", "info-b": "#044a77", purple: "#7e5c7e", "purple-d": "#745375", "purple-h": "#69496a", "purple-b": "#5c3c5d", "purple-g": "#9d7a9e", txb: "#12242b", txh: "#23363d", tx: "#31444b", txm: "#3f545b", txd: "#4c6068", txf: "#53676f", txl: "#596d75", txg: "#728890", panel: "#fffcf4", panel2: "#fefaee", panel3: "#fef8e9", canvas: "#fdf6e3", side: "#eee8d5", "side-row": "#fdf6e3", "side-well": "#e3dcc6", crest: "#cb4b16", mono: "'Source Code Pro',ui-monospace,SFMono-Regular,Menlo,monospace" };
const ME_ITHILIEN: Record<string, string> = { "acc-on": "#ffffff", tool: "#3f5470", think: "#6e5526", ok: "#286983", warn: "#975e06", err: "#a05269", "err-hi": "#8a3e56", "err-b": "#772c45", "err-g": "#bd6c82", info: "#286983", "info-hi": "#1a5e77", "info-b": "#004c65", purple: "#7d5b7d", "purple-d": "#735274", "purple-h": "#684969", "purple-b": "#5b3b5c", "purple-g": "#9c799d", txb: "#221b3e", txh: "#332e52", tx: "#413c61", txm: "#504b72", txd: "#5c577f", txf: "#635e86", txl: "#69648d", txg: "#837fa8", panel: "#fffaf3", panel2: "#fdf8f1", panel3: "#fcf6ef", canvas: "#faf4ed", side: "#f2e9e1", "side-row": "#fffaf3", "side-well": "#dfdad9", crest: "#907aa9", mono: "'Source Code Pro',ui-monospace,SFMono-Regular,Menlo,monospace" };
const AURORA_ROWS: Row[] = [
  ["aqua", "AURORA", "orbital glass · clean signal", AURORA_GLASS, { acc: "#7fe9d8", ask: "#b9a6ff" }],
  ["green", "VIRIDIAN", "buried relay · net-runner", VIRIDIAN_GLASS, { acc: "#5fdd8f", ask: "#b9a6ff" }],
  ["amber", "EMBER", "salvage rig · warm static", EMBER_GLASS, { acc: "#e8b04a", ask: "#b9a6ff" }],
  ["magenta", "NOVA", "neon district · synthwave", NOVA_GLASS, { acc: "#ff7ad9", ask: "#7fe9d8" }],
  ["blueprint", "BLUEPRINT", "drafting table · blue phosphor", BLUEPRINT_GLASS, { acc: "#7fb0ff", ask: "#c4a6ff" }],
  ["void", "VOID", "true black · white phosphor", VOID_GLASS, { acc: "#f4f7f6", ask: "#c084fc" }],
];
const CLAUDE_ROWS: Row[] = [
  ["claude", "CLAUDE", "the app itself · warm clay", CLAUDE_INK, { acc: "#d97757", ask: "#a99cdb" }],
  ["claude-ocean", "CLAUDE OCEAN", "the app itself · cold water", CLAUDE_INK, { acc: "#7fb0e0", ask: "#d97757" }],
  ["claude-fern", "CLAUDE FERN", "the app itself · quiet green", CLAUDE_INK, { acc: "#6bbf8a", ask: "#d97757" }],
  ["claude-iris", "CLAUDE IRIS", "the app itself · dusk violet", CLAUDE_INK, { acc: "#a99cdb", ask: "#d97757" }],
  ["claude-library", "CLAUDE LIBRARY", "the app itself · lamplit gold", CLAUDE_INK, { acc: "#cda76a", ask: "#7fb0e0" }],
  ["claude-dusk", "CLAUDE DUSK", "the app itself · muted slate", CLAUDE_INK, { acc: "#8fb3b0", ask: "#d97757" }],
  ["claude-light", "CLAUDE", "warm paper · clay", CLAUDE_PAPER, { acc: "#ab4626", ask: "#6b5aa8" }],
  ["claude-ocean-light", "CLAUDE OCEAN", "warm paper · cold water", CLAUDE_PAPER, { acc: "#2d69a2", ask: "#ab4626" }],
  ["claude-fern-light", "CLAUDE FERN", "warm paper · quiet green", CLAUDE_PAPER, { acc: "#2a733f", ask: "#ab4626" }],
  ["claude-iris-light", "CLAUDE IRIS", "warm paper · dusk violet", CLAUDE_PAPER, { acc: "#6b5aa8", ask: "#ab4626" }],
  ["claude-library-light", "CLAUDE LIBRARY", "warm paper · lamplit gold", CLAUDE_PAPER, { acc: "#885d15", ask: "#2d69a2" }],
  ["claude-dusk-light", "CLAUDE DUSK", "warm paper · muted slate", CLAUDE_PAPER, { acc: "#416d6a", ask: "#ab4626" }],
];
const FLINT_ROWS: Row[] = [
  ["flint-ember", "FLINT", "graphite · orange is you, magenta waits on you", FLINT_INK, { acc: "#ff8a3d", ask: "#ff4fa3" }],
  ["flint-fuchsia", "FLINT FUCHSIA", "graphite · magenta is you, orange waits on you", FLINT_INK, { acc: "#ff4fa3", ask: "#ff8a3d" }],
  ["flint-sunset", "FLINT SUNSET", "warm graphite · one orange → magenta gradient", FLINT_WARM, { acc: "#ff7a45", ask: "#ec4fa9", acc2: "#e64aa8" }],
  ["flint-kiln", "FLINT KILN", "near-black · no tints, accents only as bars", FLINT_KILN, { acc: "#ff8a3d", ask: "#ff4fa3" }],
  ["flint-cobalt", "FLINT COBALT", "graphite · blue is you, orange waits on you", FLINT_INK, { acc: "#4c9dff", ask: "#ff8a3d", info: "#5fd4ec", "info-hi": "#93e2f3", "info-b": "#c6f0f9" }],
  ["flint-nocturne", "FLINT NOCTURNE", "indigo night · violet is you, peach waits on you", FLINT_NIGHT, { acc: "#9d8cff", ask: "#ff9d5c" }],
  ["flint-violet", "FLINT VIOLET", "graphite · violet is you, peach waits on you", FLINT_INK, { acc: "#9d8cff", ask: "#ff9d5c", purple: "#d49af5", "purple-d": "#c788f0", "purple-h": "#e0b3f8", "purple-b": "#eed6fb", "purple-g": "#7a6690" }],
  ["flint-signal", "FLINT SIGNAL", "graphite · chartreuse is you, magenta waits on you", FLINT_INK, { acc: "#9ade4a", ask: "#ff4fa3" }],
  ["flint-ember-light", "FLINT", "daylight · orange is you, magenta waits on you", FLINT_DAY, { acc: "#aa4604", ask: "#c01573" }],
  ["flint-fuchsia-light", "FLINT FUCHSIA", "daylight · magenta is you, orange waits on you", FLINT_DAY, { acc: "#c01573", ask: "#aa4604" }],
  ["flint-sunset-light", "FLINT SUNSET", "daylight · one orange → magenta gradient", FLINT_DAY, { acc: "#aa4604", ask: "#c01573", acc2: "#c01573" }],
  ["flint-kiln-light", "FLINT KILN", "daylight · no tints, accents only as bars", FLINT_DAY, { acc: "#aa4604", ask: "#c01573" }],
  ["flint-cobalt-light", "FLINT COBALT", "daylight · blue is you, orange waits on you", FLINT_DAY, { acc: "#235dd2", ask: "#aa4604" }],
  ["flint-nocturne-light", "FLINT NOCTURNE", "daylight · violet is you, orange waits on you", FLINT_DAY, { acc: "#644fd0", ask: "#aa4604", purple: "#953b9c", "purple-d": "#88348e", "purple-h": "#7a2d80", "purple-b": "#66266a", "purple-g": "#937495" }],
  ["flint-signal-light", "FLINT SIGNAL", "daylight · green is you, magenta waits on you", FLINT_DAY, { acc: "#487005", ask: "#c01573" }],
];

const PEBBLE_ROWS: Row[] = [
  ["pebble-sky", "PEBBLE", "slate · blue is you, coral waits on you", PEBBLE_INK, { acc: "#4fa3ff", ask: "#ff8c5a", info: "#4fd8e8", "info-hi": "#8ae6f1", "info-b": "#c2f1f7" }],
  ["pebble-mint", "PEBBLE MINT", "slate · teal is you, rose waits on you", PEBBLE_INK, { acc: "#3ecfb0", ask: "#ff7eb6" }],
  ["pebble-lilac", "PEBBLE LILAC", "slate · violet is you, coral waits on you", PEBBLE_INK, { acc: "#b596ff", ask: "#ff8c5a", purple: "#e08cf0", "purple-d": "#d57ae8", "purple-h": "#e9a8f5", "purple-b": "#f3cdfa", "purple-g": "#7c6487" }],
  ["pebble-rose", "PEBBLE ROSE", "slate · pink is you, sky waits on you", PEBBLE_INK, { acc: "#ff7eb6", ask: "#4fa3ff" }],
  ["pebble-coral", "PEBBLE CORAL", "slate · orange is you, sky waits on you", PEBBLE_INK, { acc: "#ff8c5a", ask: "#4fa3ff", err: "#ff4d6d", "err-hi": "#ff8097", "err-b": "#ffb1bf", "err-g": "#8f4a57" }],
  ["pebble-sky-light", "PEBBLE", "chalk · blue is you, coral waits on you", PEBBLE_DAY, { acc: "#0268c0", ask: "#b14606", info: "#096e79", "info-hi": "#095d66", "info-b": "#1e494f" }],
  ["pebble-mint-light", "PEBBLE MINT", "chalk · teal is you, rose waits on you", PEBBLE_DAY, { acc: "#007561", ask: "#b33974" }],
  ["pebble-lilac-light", "PEBBLE LILAC", "chalk · violet is you, coral waits on you", PEBBLE_DAY, { acc: "#7555b8", ask: "#b14606", purple: "#9242a2", "purple-d": "#8c329e", "purple-h": "#74397e", "purple-b": "#58385d", "purple-g": "#91789d" }],
  ["pebble-rose-light", "PEBBLE ROSE", "chalk · pink is you, sky waits on you", PEBBLE_DAY, { acc: "#b33974", ask: "#0268c0" }],
  ["pebble-coral-light", "PEBBLE CORAL", "chalk · orange is you, sky waits on you", PEBBLE_DAY, { acc: "#b14606", ask: "#0268c0", err: "#c41445", "err-hi": "#9d2545", "err-b": "#6f2e3e", "err-g": "#b56c79" }],
];

const MIDDLE_EARTH_ROWS: Row[] = [
  ["rivendell", "RIVENDELL", "forest night · gold is you, blue waits on you", ME_RIVENDELL, { acc: "#d4b483", ask: "#8ab4ee" }],
  ["moria", "MORIA", "the mines · mithril is you, the runes wait on you", ME_MORIA, { acc: "#b8c9e3", ask: "#5fd4c4" }],
  ["mordor", "MORDOR", "ash and ember · lava is you, the forge waits on you", ME_MORDOR, { acc: "#e8613a", ask: "#f5b83d" }],
  ["mirkwood", "MIRKWOOD", "the darkened wood · green is you, cyan waits on you", ME_MIRKWOOD, { acc: "#389b79", ask: "#36c5f0" }],
  ["osgiliath", "OSGILIATH", "the citadel of the stars · indigo is you, yellow waits on you", ME_OSGILIATH, { acc: "#6775de", ask: "#f2c94c" }],
  ["amroth", "DOL AMROTH", "the swan's sea by night · pale blue is you, yellow waits on you", ME_AMROTH, { acc: "#a8c7fa", ask: "#fcc934" }],
  ["shire", "THE SHIRE", "night over the hills · green is you, blue waits on you", ME_SHIRE, { acc: "#349443", ask: "#4493f8" }],
  ["guldur", "DOL GULDUR", "the necromancer's hill · purple is you, pink waits on you", ME_GULDUR, { acc: "#bd93f9", ask: "#ff79c6" }],
  ["caradhras", "CARADHRAS", "the cruel snow · frost is you, gold waits on you", ME_CARADHRAS, { acc: "#88c0d0", ask: "#ebcb8b" }],
  ["valinor", "VALINOR", "the blessed realm · mauve is you, peach waits on you", ME_VALINOR, { acc: "#cba6f7", ask: "#fab387" }],
  ["rivendell-light", "RIVENDELL", "paper · forest is you, ochre waits on you", ME_RIVENDELL_PAPER, { acc: "#2e4a3f", ask: "#916101" }],
  ["havens-light", "GREY HAVENS", "sea mist · teal is you, the sunset waits on you", ME_HAVENS, { acc: "#0f6e78", ask: "#b6452e" }],
  ["edoras-light", "EDORAS", "the golden hall · red is you, blue waits on you", ME_EDORAS, { acc: "#8e1414", ask: "#2f5d8a" }],
  ["mirkwood-light", "MIRKWOOD", "white under the wood's shade · green is you, blue waits on you", ME_MIRKWOOD_PAPER, { acc: "#007a5a", ask: "#1264a3" }],
  ["osgiliath-light", "OSGILIATH", "pale stone by day · indigo is you, amber waits on you", ME_OSGILIATH_PAPER, { acc: "#5964cb", ask: "#91660b" }],
  ["amroth-light", "DOL AMROTH", "silver and sea · blue is you, amber waits on you", ME_AMROTH_PAPER, { acc: "#0b57d0", ask: "#8c5a00" }],
  ["shire-light", "THE SHIRE", "green hills by day · green is you, blue waits on you", ME_SHIRE_PAPER, { acc: "#108035", ask: "#0969da" }],
  ["tirith-light", "MINAS TIRITH", "the white city · blue is you, amber waits on you", ME_TIRITH, { acc: "#0d6ec7", ask: "#986201" }],
  ["anorien-light", "ANÓRIEN", "the sunland · blue is you, orange waits on you", ME_ANORIEN, { acc: "#0170b2", ask: "#bf4001" }],
  ["ithilien-light", "ITHILIEN", "the garden of gondor at dawn · rose is you, iris waits on you", ME_ITHILIEN, { acc: "#a05269", ask: "#77618f" }],
];

const FAMILY: Record<Family, { rows: Row[]; font: string; prad: string; fx: boolean }> = {
  aurora: { rows: AURORA_ROWS, font: "", prad: "0", fx: true },
  claude: { rows: CLAUDE_ROWS, font: "ui-sans-serif,-apple-system,'Segoe UI',system-ui,sans-serif", prad: "8px", fx: false },
  flint: { rows: FLINT_ROWS, font: "'Geist',system-ui,-apple-system,'Segoe UI',sans-serif", prad: "10px", fx: false },
  pebble: { rows: PEBBLE_ROWS, font: "'Nunito',system-ui,-apple-system,'Segoe UI',sans-serif", prad: "999px", fx: false },
  "middle-earth": { rows: MIDDLE_EARTH_ROWS, font: "'Source Sans 3',system-ui,-apple-system,'Segoe UI',sans-serif", prad: "10px", fx: false },
};

// ---- END COPY -------------------------------------------------------------------

/** The HUD's own voice: AURORA's FAMILY entry says "" (= keep the HUD mono),
 *  and the phone's body font has to be named. */
const HUD_FONT = "'Share Tech Mono','JetBrains Mono',ui-monospace,monospace";

export interface ThemeDef {
  key: ThemeKey;
  fam: Family;
  name: string;   // shown in the picker
  feel: string;   // flavour text
  sw: string;     // picker swatch: the `acc` role
  canvas: string; // the page ground
  font: string;   // body font-family
  prad: string;   // corner radius for the themed chrome
  crt: boolean;   // scanlines: AURORA's glass only
  pal: Record<string, string>; // design tokens, injected on :root
}

export const THEMES: ThemeDef[] = FAMILIES.flatMap((fam) => {
  const { rows, font, prad, fx } = FAMILY[fam];
  return rows.map(([key, name, feel, ground, roles]): ThemeDef => {
    const pal: Record<string, string> = { ...ground, ...roles, "accent-rgb": rgbTriplet(roles.acc) };
    return { key, fam, name, feel, sw: roles.acc, canvas: pal.canvas, font: font || HUD_FONT, prad, crt: fx, pal };
  });
});

/** How each family is named and described in the picker. */
export const FAMILY_INFO: Record<Family, { name: string; feel: string }> = {
  aurora: { name: "AURORA", feel: "the CRT · phosphor on glass" },
  claude: { name: "CLAUDE", feel: "the app itself · paper and clay" },
  flint: { name: "FLINT", feel: "the editor · graphite and one colour" },
  pebble: { name: "PEBBLE", feel: "the river stone · flint worn round" },
  "middle-earth": { name: "MIDDLE-EARTH", feel: "Rivendell's own · a frame round a sheet" },
};

export function themeDef(key: ThemeKey): ThemeDef {
  return THEMES.find((t) => t.key === key) ?? THEMES[0];
}

/** A light ground is `<colouring>-light`; everything else is dark. */
export function isLight(key: ThemeKey): boolean {
  return key.endsWith("-light");
}

/** A family's colourings on one ground, in picker order. AURORA is a tube, and
 *  a tube has no daylight — its light list is empty. */
export function colourings(fam: Family, light: boolean): ThemeKey[] {
  return THEMES.filter((d) => d.fam === fam && isLight(d.key) === light).map((d) => d.key);
}

/** The same colouring on the other ground, or null. */
export function twin(key: ThemeKey): ThemeKey | null {
  const k = (isLight(key) ? key.slice(0, -"-light".length) : `${key}-light`) as ThemeKey;
  return THEMES.some((t) => t.key === k) ? k : null;
}

/** Where a theme that left the picker lives now — the dashboard's own MOVED,
 *  so a key either surface ever stored lands on the same colouring. */
const MOVED: Record<string, ThemeKey> = {
  "claude-dark": "claude", library: "claude-library", dusk: "claude-dusk",
  graphite: "flint-cobalt", nocturne: "flint-nocturne", studio: "flint-nocturne", signal: "flint-signal",
  normal: "flint-cobalt-light", apex: "flint-cobalt-light", cupertino: "flint-cobalt-light", foundry: "flint-ember-light",
  candy: "flint-fuchsia-light", riso: "flint-fuchsia-light", newsprint: "claude-light", gloam: "claude-fern-light",
};

/** Every token any theme sets — so switching to a theme that does NOT set one
 *  clears it instead of inheriting the last theme's value. */
const TOKENS: string[] = Array.from(new Set(THEMES.flatMap((t) => Object.keys(t.pal))));

const KEY = "miniapp-theme";

export function loadTheme(): ThemeKey {
  try {
    const raw = localStorage.getItem(KEY);
    const k = raw ? MOVED[raw] ?? raw : "";
    if (THEMES.some((t) => t.key === k)) return k as ThemeKey;
  } catch {
    // no localStorage in a rare webview — fall through to the default
  }
  return "aqua";
}

/** Paint `key` onto :root and remember it. Called once at boot and on every
 *  pick, so the picker never has to thread the palette through React. */
export function applyTheme(key: ThemeKey): void {
  const def = themeDef(key);
  const root = document.documentElement;
  root.dataset.theme = def.key;
  root.dataset.fam = def.fam;
  // `data-light` re-derives every alpha wash for paper (index.css, LIGHT GROUNDS).
  if (isLight(def.key)) root.dataset.light = "1";
  else delete root.dataset.light;
  root.style.colorScheme = isLight(def.key) ? "light" : "dark";
  // `data-fx` gates the HUD flourishes (scanlines, glow) — AURORA's glass only.
  if (def.crt) root.dataset.fx = "1";
  else delete root.dataset.fx;
  for (const token of TOKENS) {
    const value = def.pal[token];
    if (value != null) root.style.setProperty(`--${token}`, value);
    else root.style.removeProperty(`--${token}`);
  }
  root.style.setProperty("--page-bg", def.canvas);
  root.style.setProperty("--page-font", def.font);
  root.style.setProperty("--prad", def.prad);
  // Telegram's own bar above the webview wears the theme's ground, so the app
  // doesn't sit under a stripe of the last theme's colour.
  const wa = window.Telegram?.WebApp;
  wa?.setHeaderColor?.(def.canvas);
  wa?.setBackgroundColor?.(def.canvas);
  try {
    localStorage.setItem(KEY, def.key);
  } catch {
    // quota / unavailable — the theme still applies, it just won't survive a reload
  }
}

/** How the chat's header sits over the transcript (the dashboard's
 *  HEADER_STYLES). FROST is glass the transcript blurs through; VEIL is no
 *  object at all, the top of the screen fading the transcript out under the
 *  title; TUCK is frost folded to the title, its buttons unfolding when you
 *  touch it. */
export const HEADER_STYLES = ["frost", "veil", "tuck"] as const;
export type HeaderStyle = (typeof HEADER_STYLES)[number];

/** How the chat column is laid out. DEFAULT: your prompt is a full-width plate
 *  over the reply. COMPACT reads as a chat: your prompt a bubble on the right,
 *  the reply on the left, neither wider than 85% of the screen. */
export const CHAT_LAYOUTS = ["default", "compact"] as const;
export type ChatLayout = (typeof CHAT_LAYOUTS)[number];

const HDR_KEY = "miniapp-header";
const LAYOUT_KEY = "miniapp-layout";

function load<T extends string>(key: string, all: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return all.includes(v as T) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}

export const loadHeaderStyle = (): HeaderStyle => load(HDR_KEY, HEADER_STYLES, "frost");
export const loadLayout = (): ChatLayout => load(LAYOUT_KEY, CHAT_LAYOUTS, "default");

/** Both picks live on :root (data-hdr, data-layout), like the theme: one
 *  attribute and every rule in index.css that reads it follows. */
export function applyHeaderStyle(h: HeaderStyle): void {
  document.documentElement.dataset.hdr = h;
  try { localStorage.setItem(HDR_KEY, h); } catch { /* not remembered, still applied */ }
}

export function applyLayout(l: ChatLayout): void {
  document.documentElement.dataset.layout = l;
  try { localStorage.setItem(LAYOUT_KEY, l); } catch { /* not remembered, still applied */ }
}
