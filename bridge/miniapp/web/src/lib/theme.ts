// The Mini App's DISPLAY PROFILE: the dashboard's DARK themes, on a phone.
//
// The palettes below are generated from bridge/dashboard/web/src/lib/theme.ts —
// that file stays the source of truth, this is a trimmed copy, same as the
// langfor / stick / toolfold pairs. Three deliberate differences:
//
//   1. DARK ONLY. A light ground is not a dark one recoloured: it needs the
//      whole `:root[data-light]` re-derivation in the dashboard's index.css
//      (opaque surfaces, washes mixed into --panel, real borders) because an 8%
//      accent veil over near-black is a 1.6x luminance step and the same veil
//      over white is 1.02x. Porting six light themes means porting that block.
//   2. AURORA's four carry no pal{} on the dashboard — they recolour the whole
//      UI through one CSS `filter` on a wrapper, which is a full-screen
//      composite every frame. Here they stay the 4-var accent overrides the
//      Mini App has always used, so the phone never pays for it.
//   3. DUSK and THE LIBRARY ask for EB Garamond, which the dashboard fetches
//      from Google Fonts. The Mini App bundles its fonts (@fontsource) and does
//      not add a network request for two themes — both font stacks end in
//      `serif`, so they land on Georgia / Noto Serif instead.

export type ThemeKey =
  | "aqua"
  | "green"
  | "amber"
  | "magenta"
  | "claude"
  | "claude-ocean"
  | "claude-fern"
  | "claude-iris"
  | "blueprint"
  | "dusk"
  | "library"
  | "nocturne"
  | "void"
  | "signal";

export interface ThemeDef {
  key: ThemeKey;
  name: string;   // shown in the picker
  feel: string;   // flavour text
  sw: string;     // picker swatch
  page: string;   // the page ground — may be a gradient, so it is not pal.canvas
  font: string;   // body font-family
  prad: string;   // corner radius for the themed chrome
  crt: boolean;   // scanlines: the sci-fi glass only
  /** Design-token overrides, injected on :root. Empty = the aqua base already
   *  in index.css, which IS the AURORA palette. */
  pal: Record<string, string>;
}

export const THEMES: ThemeDef[] = [
  { key: "aqua", name: "AURORA", feel: "orbital glass · clean signal", sw: "#7fe9d8", page: "#060a0a", font: "'Share Tech Mono','JetBrains Mono',ui-monospace,monospace", prad: "0", crt: true, pal: {} },
  { key: "green", name: "VIRIDIAN", feel: "buried relay · net-runner", sw: "#5fdd8f", page: "#060a0a", font: "'Share Tech Mono','JetBrains Mono',ui-monospace,monospace", prad: "0", crt: true, pal: { acc: "#5fdd8f", "accent-rgb": "95 221 143", tx: "#aee0bd", txb: "#d6ffe1" } },
  { key: "amber", name: "EMBER", feel: "salvage rig · warm static", sw: "#e8b04a", page: "#060a0a", font: "'Share Tech Mono','JetBrains Mono',ui-monospace,monospace", prad: "0", crt: true, pal: { acc: "#e8b04a", "accent-rgb": "232 176 74", tx: "#e6cf9c", txb: "#ffe7b0" } },
  { key: "magenta", name: "NOVA", feel: "neon district · synthwave", sw: "#ff7ad9", page: "#060a0a", font: "'Share Tech Mono','JetBrains Mono',ui-monospace,monospace", prad: "0", crt: true, pal: { acc: "#ff7ad9", "accent-rgb": "255 122 217", tx: "#f1c2e6", txb: "#ffd9f3" } },
  { key: "claude", name: "CLAUDE", feel: "the app itself · warm clay", sw: "#d97757", page: "#262624", font: "ui-sans-serif,-apple-system,'Segoe UI',system-ui,sans-serif", prad: "8px", crt: false, pal: { "acc-on": "#1f1f1e", ok: "#6bbf8a", warn: "#d8a657", err: "#e0796a", "err-hi": "#f2b5aa", "err-b": "#f8d3cc", "err-g": "#9c7068", info: "#7fb0e0", "info-hi": "#a8cbee", "info-b": "#cfe3f7", purple: "#a99cdb", "purple-d": "#9a8cd0", "purple-h": "#bfb4e8", "purple-b": "#dcd6f4", "purple-g": "#6e6890", txb: "#f5f4ef", txh: "#eceae5", tx: "#d7d5cd", txm: "#bfbdb4", txd: "#aba9a0", txf: "#a09d97", txl: "#999690", txg: "#4a4844", panel: "#30302e", panel2: "#262624", panel3: "#1f1f1e", canvas: "#262624", mono: "ui-monospace,SFMono-Regular,Menlo,monospace", acc: "#d97757", "accent-rgb": "217 119 87" } },
  { key: "claude-ocean", name: "CLAUDE OCEAN", feel: "the app itself · cold water", sw: "#7fb0e0", page: "#262624", font: "ui-sans-serif,-apple-system,'Segoe UI',system-ui,sans-serif", prad: "8px", crt: false, pal: { "acc-on": "#1f1f1e", ok: "#6bbf8a", warn: "#d8a657", err: "#e0796a", "err-hi": "#f2b5aa", "err-b": "#f8d3cc", "err-g": "#9c7068", info: "#7fb0e0", "info-hi": "#a8cbee", "info-b": "#cfe3f7", purple: "#a99cdb", "purple-d": "#9a8cd0", "purple-h": "#bfb4e8", "purple-b": "#dcd6f4", "purple-g": "#6e6890", txb: "#f5f4ef", txh: "#eceae5", tx: "#d7d5cd", txm: "#bfbdb4", txd: "#aba9a0", txf: "#a09d97", txl: "#999690", txg: "#4a4844", panel: "#30302e", panel2: "#262624", panel3: "#1f1f1e", canvas: "#262624", mono: "ui-monospace,SFMono-Regular,Menlo,monospace", acc: "#7fb0e0", "accent-rgb": "127 176 224" } },
  { key: "claude-fern", name: "CLAUDE FERN", feel: "the app itself · quiet green", sw: "#6bbf8a", page: "#262624", font: "ui-sans-serif,-apple-system,'Segoe UI',system-ui,sans-serif", prad: "8px", crt: false, pal: { "acc-on": "#1f1f1e", ok: "#6bbf8a", warn: "#d8a657", err: "#e0796a", "err-hi": "#f2b5aa", "err-b": "#f8d3cc", "err-g": "#9c7068", info: "#7fb0e0", "info-hi": "#a8cbee", "info-b": "#cfe3f7", purple: "#a99cdb", "purple-d": "#9a8cd0", "purple-h": "#bfb4e8", "purple-b": "#dcd6f4", "purple-g": "#6e6890", txb: "#f5f4ef", txh: "#eceae5", tx: "#d7d5cd", txm: "#bfbdb4", txd: "#aba9a0", txf: "#a09d97", txl: "#999690", txg: "#4a4844", panel: "#30302e", panel2: "#262624", panel3: "#1f1f1e", canvas: "#262624", mono: "ui-monospace,SFMono-Regular,Menlo,monospace", acc: "#6bbf8a", "accent-rgb": "107 191 138" } },
  { key: "claude-iris", name: "CLAUDE IRIS", feel: "the app itself · dusk violet", sw: "#a99cdb", page: "#262624", font: "ui-sans-serif,-apple-system,'Segoe UI',system-ui,sans-serif", prad: "8px", crt: false, pal: { "acc-on": "#1f1f1e", ok: "#6bbf8a", warn: "#d8a657", err: "#e0796a", "err-hi": "#f2b5aa", "err-b": "#f8d3cc", "err-g": "#9c7068", info: "#7fb0e0", "info-hi": "#a8cbee", "info-b": "#cfe3f7", purple: "#a99cdb", "purple-d": "#9a8cd0", "purple-h": "#bfb4e8", "purple-b": "#dcd6f4", "purple-g": "#6e6890", txb: "#f5f4ef", txh: "#eceae5", tx: "#d7d5cd", txm: "#bfbdb4", txd: "#aba9a0", txf: "#a09d97", txl: "#999690", txg: "#4a4844", panel: "#30302e", panel2: "#262624", panel3: "#1f1f1e", canvas: "#262624", mono: "ui-monospace,SFMono-Regular,Menlo,monospace", acc: "#a99cdb", "accent-rgb": "169 156 219" } },
  { key: "blueprint", name: "BLUEPRINT", feel: "drafting table · pencil annotations", sw: "#7fb0ff", page: "repeating-linear-gradient(0deg,rgba(127,176,255,.06) 0 1px,transparent 1px 26px),repeating-linear-gradient(90deg,rgba(127,176,255,.06) 0 1px,transparent 1px 26px),#06101f", font: "'Share Tech Mono','JetBrains Mono',ui-monospace,monospace", prad: "0", crt: false, pal: { acc: "#7fb0ff", "acc-on": "#04101f", "accent-rgb": "127 176 255", ok: "#5fe0a8", warn: "#ffc861", err: "#ff8a7a", "err-hi": "#ffbdb2", "err-b": "#ffd8d0", "err-g": "#a4675c", info: "#63d7f0", "info-hi": "#9ee7f7", "info-b": "#cdf2fb", purple: "#c4a6ff", "purple-d": "#b18eff", "purple-h": "#d7c2ff", "purple-b": "#e8dcff", "purple-g": "#7a68ab", txb: "#e8f0fc", txh: "#cdd9ee", tx: "#b4c4de", txm: "#93a6c4", txd: "#7b8ead", txf: "#6f84a4", txl: "#677da6", txg: "#32405c", panel: "#081226", panel2: "#060e1c", panel3: "#040912", canvas: "#06101f", mono: "'JetBrains Mono',monospace" } },
  { key: "dusk", name: "DUSK", feel: "muted slate · vvd's most-applied", sw: "#8fb3b0", page: "#121818", font: "'EB Garamond',Georgia,serif", prad: "6px", crt: false, pal: { acc: "#8fb3b0", "acc-on": "#0d1414", "accent-rgb": "143 179 176", ok: "#3d965b", warn: "#a18226", err: "#d6614f", "err-hi": "#dd7e6f", "err-b": "#e4988c", "err-g": "#9a6057", info: "#3e8bc2", "info-hi": "#5f9fcd", "info-b": "#7db1d6", purple: "#a470c9", "purple-d": "#9f68c6", "purple-h": "#b287d1", "purple-b": "#c19eda", "purple-g": "#85619e", txb: "#eceff0", txh: "#d6dddd", tx: "#bec9ca", txm: "#a1b1b2", txd: "#8da0a1", txf: "#819698", txl: "#768d8f", txg: "#5d7072", panel: "#1a2323", panel2: "#151d1d", panel3: "#101616", canvas: "#121818", mono: "'JetBrains Mono',monospace" } },
  { key: "library", name: "THE LIBRARY", feel: "lamplit vellum · vvd dark academia", sw: "#cda76a", page: "repeating-linear-gradient(27deg,rgba(205,167,106,.022) 0 1px,transparent 1px 4px),repeating-linear-gradient(-63deg,rgba(205,167,106,.018) 0 1px,transparent 1px 5px),#17120c", font: "'EB Garamond',Georgia,serif", prad: "3px", crt: false, pal: { acc: "#cda76a", "acc-on": "#150f08", "accent-rgb": "205 167 106", ok: "#3f9262", warn: "#848727", err: "#d65c50", "err-hi": "#dd796f", "err-b": "#e4938b", "err-g": "#9d5a54", info: "#3e8bb1", "info-hi": "#539ec3", "info-b": "#73b0ce", purple: "#a56bc2", "purple-d": "#a163bf", "purple-h": "#b483cc", "purple-b": "#c29ad6", "purple-g": "#855e99", txb: "#eceae7", txh: "#dcd7d1", tx: "#c9c2b8", txm: "#b2a99c", txd: "#a39787", txf: "#9a8d7c", txl: "#928471", txg: "#736859", panel: "#221a11", panel2: "#1c150e", panel3: "#13100a", canvas: "#17120c", mono: "'JetBrains Mono',monospace" } },
  { key: "nocturne", name: "NOCTURNE", feel: "indigo night · low chroma, long sessions", sw: "#a3b3f5", page: "radial-gradient(120% 80% at 50% 0%,rgba(163,179,245,.05),transparent 60%),#14141f", font: "'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace", prad: "6px", crt: false, pal: { acc: "#a3b3f5", "acc-on": "#12121c", "accent-rgb": "163 179 245", ok: "#6fd7a2", warn: "#e0b458", err: "#e88b7d", "err-hi": "#f2b3a8", "err-b": "#f7d2ca", "err-g": "#8c6058", info: "#63c7e8", "info-hi": "#95dcf2", "info-b": "#c4ecf9", purple: "#c79af0", "purple-d": "#b98ae8", "purple-h": "#d5b0f5", "purple-b": "#e6d1fa", "purple-g": "#7a6690", txb: "#ebecf2", txh: "#d7d8e5", tx: "#c0c3d7", txm: "#a6aac6", txd: "#9399ba", txf: "#898eb3", txl: "#7f86ad", txg: "#616898", panel: "#1f1f2e", panel2: "#191926", panel3: "#101019", canvas: "#14141f", mono: "'JetBrains Mono',monospace" } },
  { key: "void", name: "VOID", feel: "true black · colour only where it means something", sw: "#ffffff", page: "#000000", font: "system-ui,-apple-system,'Segoe UI',sans-serif", prad: "0", crt: false, pal: { acc: "#ffffff", "acc-on": "#000000", "accent-rgb": "255 255 255", ok: "#4ade80", warn: "#fbbf24", err: "#f87171", "err-hi": "#fca5a5", "err-b": "#fecaca", "err-g": "#8a5c5c", info: "#60a5fa", "info-hi": "#93c5fd", "info-b": "#bfdbfe", purple: "#c084fc", "purple-d": "#a855f7", "purple-h": "#d8b4fe", "purple-b": "#e9d5ff", "purple-g": "#6f5b86", txb: "#ffffff", txh: "#ededed", tx: "#d4d4d4", txm: "#b4b4b4", txd: "#9a9a9a", txf: "#8d8d8d", txl: "#828282", txg: "#565656", panel: "#121212", panel2: "#0b0b0b", panel3: "#070707", canvas: "#000000", mono: "'JetBrains Mono',monospace" } },
  { key: "signal", name: "SIGNAL", feel: "black box · chartreuse go, level inks", sw: "#9ade4a", page: "#0a0a0b", font: "'JetBrains Mono',ui-monospace,SFMono-Regular,Menlo,monospace", prad: "0", crt: false, pal: { acc: "#9ade4a", "acc-on": "#0c0c0d", "accent-rgb": "154 222 74", ok: "#9ade4a", warn: "#e8b13c", err: "#ff6b5e", "err-hi": "#ff938a", "err-b": "#ffb8b1", "err-g": "#8f5f5a", info: "#7fb8ff", "info-hi": "#a5cdff", "info-b": "#cce2ff", purple: "#a98bff", "purple-d": "#9a79f2", "purple-h": "#bfa3ff", "purple-b": "#d9c9ff", "purple-g": "#6d6383", txb: "#f2f2ee", txh: "#e4e4df", tx: "#dcdcd8", txm: "#a5a5ad", txd: "#8b8b93", txf: "#77777f", txl: "#5a5a60", txg: "#33333a", panel: "#131316", panel2: "#101012", panel3: "#0c0c0d", canvas: "#0a0a0b", mono: "'JetBrains Mono',monospace" } },
];

/** AURORA is one profile in four colours; the picker draws it as one row. */
export const AURORA_KEYS: ThemeKey[] = ["aqua", "green", "amber", "magenta"];

/** Every token any theme sets — so switching back to a theme that does NOT set
 *  one clears it instead of inheriting the last theme's value. */
const TOKENS: string[] = Array.from(
  new Set(THEMES.flatMap((t) => Object.keys(t.pal))),
);

const KEY = "miniapp-theme";

export function themeDef(key: ThemeKey): ThemeDef {
  return THEMES.find((t) => t.key === key) ?? THEMES[0];
}

export function loadTheme(): ThemeKey {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw && THEMES.some((t) => t.key === raw)) return raw as ThemeKey;
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
  // `data-fx` gates the HUD flourishes (scanlines) in index.css — a CRT overlay
  // on CLAUDE's flat greys reads as a dirty screen, not as a theme.
  if (def.crt) root.dataset.fx = "1";
  else delete root.dataset.fx;
  for (const token of TOKENS) {
    const value = def.pal[token];
    if (value != null) root.style.setProperty(`--${token}`, value);
    else root.style.removeProperty(`--${token}`);
  }
  root.style.setProperty("--page-bg", def.page);
  root.style.setProperty("--page-font", def.font);
  root.style.setProperty("--prad", def.prad);
  try {
    localStorage.setItem(KEY, def.key);
  } catch {
    // quota / unavailable — the theme still applies, it just won't survive a reload
  }
}
