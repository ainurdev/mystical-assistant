// The Mini App's DISPLAY PROFILE: the dashboard's AURORA and CLAUDE, on a phone.
//
// The palettes below are generated from bridge/dashboard/web/src/lib/theme.ts —
// that file stays the source of truth, this is a trimmed copy, same as the
// langfor / stick / toolfold pairs (tests/test_miniapp_theme_sync.py checks it).
// Two deliberate differences:
//
//   1. DARK ONLY. A light ground is not a dark one recoloured: it needs the
//      whole `:root[data-light]` re-derivation in the dashboard's index.css
//      (opaque surfaces, washes mixed into --panel, real borders) because an 8%
//      accent veil over near-black is a 1.6x luminance step and the same veil
//      over white is 1.02x.
//   2. NO FLINT. FLINT is a family layer of its own in the dashboard's
//      stylesheet (THE FAMILIES), which the Mini App does not carry.

export type ThemeKey =
  | "aqua" | "green" | "amber" | "magenta" | "blueprint" | "void"
  | "claude" | "claude-ocean" | "claude-fern" | "claude-iris" | "claude-library" | "claude-dusk";

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
  { key: "aqua", name: "AURORA", feel: "orbital glass · clean signal", sw: "#7fe9d8", page: "#060a0a", font: "'Share Tech Mono','JetBrains Mono',ui-monospace,monospace", prad: "0", crt: true, pal: { "acc-on": "#06100e", tool: "#9fc7c0", think: "#7fa39c", ok: "#8fd9a8", warn: "#e3c279", err: "#e0897a", "err-hi": "#f0d0c8", "err-b": "#f4d5cd", "err-g": "#9a6f68", info: "#6fb5ff", "info-hi": "#9fc8ff", "info-b": "#dbeeff", purple: "#b9a6ff", "purple-d": "#a78bf0", "purple-h": "#cbb8ff", "purple-b": "#e7deff", "purple-g": "#6f6088", txb: "#dff8f2", txh: "#cfe9e3", tx: "#bfe6de", txm: "#9fc7c0", txd: "#7fa39c", txf: "#6f918b", txl: "#5f817b", txg: "#2e423f", panel: "#091010", panel2: "#070d0d", panel3: "#040707", canvas: "#060a0a", mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace", acc: "#7fe9d8", ask: "#b9a6ff", "accent-rgb": "127 233 216" } },
  { key: "green", name: "VIRIDIAN", feel: "buried relay · net-runner", sw: "#5fdd8f", page: "#060a08", font: "'Share Tech Mono','JetBrains Mono',ui-monospace,monospace", prad: "0", crt: true, pal: { "acc-on": "#04100a", tool: "#a3c8ae", think: "#83a48c", ok: "#8fd9a8", warn: "#e3c279", err: "#e0897a", "err-hi": "#f0d0c8", "err-b": "#f4d5cd", "err-g": "#9a6f68", info: "#6fb5ff", "info-hi": "#9fc8ff", "info-b": "#dbeeff", purple: "#b9a6ff", "purple-d": "#a78bf0", "purple-h": "#cbb8ff", "purple-b": "#e7deff", "purple-g": "#6f6088", txb: "#e2f9e6", txh: "#d2ead7", tx: "#c3e7cc", txm: "#a3c8ae", txd: "#83a48c", txf: "#72927c", txl: "#62826c", txg: "#304336", panel: "#09100d", panel2: "#070d0b", panel3: "#040706", canvas: "#060a08", mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace", acc: "#5fdd8f", ask: "#b9a6ff", "accent-rgb": "95 221 143" } },
  { key: "amber", name: "EMBER", feel: "salvage rig · warm static", sw: "#e8b04a", page: "#0a0905", font: "'Share Tech Mono','JetBrains Mono',ui-monospace,monospace", prad: "0", crt: true, pal: { "acc-on": "#140d02", tool: "#d0ba96", think: "#ac9777", ok: "#8fd9a8", warn: "#ff875a", err: "#ff6b7d", "err-hi": "#ffb3bb", "err-b": "#ffd3d8", "err-g": "#9e6670", info: "#6fb5ff", "info-hi": "#9fc8ff", "info-b": "#dbeeff", purple: "#b9a6ff", "purple-d": "#a78bf0", "purple-h": "#cbb8ff", "purple-b": "#e7deff", "purple-g": "#6f6088", txb: "#ffefd9", txh: "#f0e0c9", tx: "#f0d9b6", txm: "#d0ba96", txd: "#ac9777", txf: "#998668", txl: "#897658", txg: "#463c2a", panel: "#100e08", panel2: "#0d0c06", panel3: "#070604", canvas: "#0a0905", mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace", acc: "#e8b04a", ask: "#b9a6ff", "accent-rgb": "232 176 74" } },
  { key: "magenta", name: "NOVA", feel: "neon district · synthwave", sw: "#ff7ad9", page: "#0c0809", font: "'Share Tech Mono','JetBrains Mono',ui-monospace,monospace", prad: "0", crt: true, pal: { "acc-on": "#14060f", tool: "#d7b0c8", think: "#b08ea5", ok: "#8fd9a8", warn: "#e3c279", err: "#e0897a", "err-hi": "#f0d0c8", "err-b": "#f4d5cd", "err-g": "#9a6f68", info: "#6fb5ff", "info-hi": "#9fc8ff", "info-b": "#dbeeff", purple: "#b9a6ff", "purple-d": "#a78bf0", "purple-h": "#cbb8ff", "purple-b": "#e7deff", "purple-g": "#6f6088", txb: "#ffebf8", txh: "#f3daeb", tx: "#f5d0e8", txm: "#d7b0c8", txd: "#b08ea5", txf: "#9e7e92", txl: "#8e6e82", txg: "#4a3742", panel: "#130c0f", panel2: "#10090c", panel3: "#090506", canvas: "#0c0809", mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace", acc: "#ff7ad9", ask: "#7fe9d8", "accent-rgb": "255 122 217" } },
  { key: "blueprint", name: "BLUEPRINT", feel: "drafting table · blue phosphor", sw: "#7fb0ff", page: "#06101f", font: "'Share Tech Mono','JetBrains Mono',ui-monospace,monospace", prad: "0", crt: true, pal: { "acc-on": "#04101f", tool: "#93a6c4", think: "#7b8ead", ok: "#5fe0a8", warn: "#ffc861", err: "#ff8a7a", "err-hi": "#ffbdb2", "err-b": "#ffd8d0", "err-g": "#a4675c", info: "#63d7f0", "info-hi": "#9ee7f7", "info-b": "#cdf2fb", purple: "#c4a6ff", "purple-d": "#b18eff", "purple-h": "#d7c2ff", "purple-b": "#e8dcff", "purple-g": "#7a68ab", txb: "#e8f0fc", txh: "#cdd9ee", tx: "#b4c4de", txm: "#93a6c4", txd: "#7b8ead", txf: "#6f84a4", txl: "#677da6", txg: "#32405c", panel: "#081226", panel2: "#060e1c", panel3: "#040912", canvas: "#06101f", mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace", acc: "#7fb0ff", ask: "#c4a6ff", "accent-rgb": "127 176 255" } },
  { key: "void", name: "VOID", feel: "true black · white phosphor", sw: "#f4f7f6", page: "#000000", font: "'Share Tech Mono','JetBrains Mono',ui-monospace,monospace", prad: "0", crt: true, pal: { "acc-on": "#000000", tool: "#b4b4b4", think: "#9a9a9a", ok: "#4ade80", warn: "#fbbf24", err: "#f87171", "err-hi": "#fca5a5", "err-b": "#fecaca", "err-g": "#8a5c5c", info: "#60a5fa", "info-hi": "#93c5fd", "info-b": "#bfdbfe", purple: "#c084fc", "purple-d": "#a855f7", "purple-h": "#d8b4fe", "purple-b": "#e9d5ff", "purple-g": "#6f5b86", txb: "#ffffff", txh: "#ededed", tx: "#d4d4d4", txm: "#b4b4b4", txd: "#9a9a9a", txf: "#8d8d8d", txl: "#828282", txg: "#565656", panel: "#121212", panel2: "#0b0b0b", panel3: "#070707", canvas: "#000000", mono: "'JetBrains Mono', ui-monospace, SFMono-Regular, monospace", acc: "#f4f7f6", ask: "#c084fc", "accent-rgb": "244 247 246" } },
  { key: "claude", name: "CLAUDE", feel: "the app itself · warm clay", sw: "#d97757", page: "#262624", font: "ui-sans-serif,-apple-system,'Segoe UI',system-ui,sans-serif", prad: "8px", crt: false, pal: { "acc-on": "#1f1f1e", tool: "#a3b1c2", think: "#bdb3a3", ok: "#6bbf8a", warn: "#d8a657", err: "#e0796a", "err-hi": "#f2b5aa", "err-b": "#f8d3cc", "err-g": "#9c7068", info: "#7fb0e0", "info-hi": "#a8cbee", "info-b": "#cfe3f7", purple: "#a99cdb", "purple-d": "#9a8cd0", "purple-h": "#bfb4e8", "purple-b": "#dcd6f4", "purple-g": "#6e6890", txb: "#f5f4ef", txh: "#eceae5", tx: "#d7d5cd", txm: "#bfbdb4", txd: "#aba9a0", txf: "#a09d97", txl: "#999690", txg: "#4a4844", panel: "#30302e", panel2: "#262624", panel3: "#1f1f1e", canvas: "#262624", mono: "ui-monospace,SFMono-Regular,Menlo,monospace", acc: "#d97757", ask: "#a99cdb", "accent-rgb": "217 119 87" } },
  { key: "claude-ocean", name: "CLAUDE OCEAN", feel: "the app itself · cold water", sw: "#7fb0e0", page: "#262624", font: "ui-sans-serif,-apple-system,'Segoe UI',system-ui,sans-serif", prad: "8px", crt: false, pal: { "acc-on": "#1f1f1e", tool: "#a3b1c2", think: "#bdb3a3", ok: "#6bbf8a", warn: "#d8a657", err: "#e0796a", "err-hi": "#f2b5aa", "err-b": "#f8d3cc", "err-g": "#9c7068", info: "#7fb0e0", "info-hi": "#a8cbee", "info-b": "#cfe3f7", purple: "#a99cdb", "purple-d": "#9a8cd0", "purple-h": "#bfb4e8", "purple-b": "#dcd6f4", "purple-g": "#6e6890", txb: "#f5f4ef", txh: "#eceae5", tx: "#d7d5cd", txm: "#bfbdb4", txd: "#aba9a0", txf: "#a09d97", txl: "#999690", txg: "#4a4844", panel: "#30302e", panel2: "#262624", panel3: "#1f1f1e", canvas: "#262624", mono: "ui-monospace,SFMono-Regular,Menlo,monospace", acc: "#7fb0e0", ask: "#d97757", "accent-rgb": "127 176 224" } },
  { key: "claude-fern", name: "CLAUDE FERN", feel: "the app itself · quiet green", sw: "#6bbf8a", page: "#262624", font: "ui-sans-serif,-apple-system,'Segoe UI',system-ui,sans-serif", prad: "8px", crt: false, pal: { "acc-on": "#1f1f1e", tool: "#a3b1c2", think: "#bdb3a3", ok: "#6bbf8a", warn: "#d8a657", err: "#e0796a", "err-hi": "#f2b5aa", "err-b": "#f8d3cc", "err-g": "#9c7068", info: "#7fb0e0", "info-hi": "#a8cbee", "info-b": "#cfe3f7", purple: "#a99cdb", "purple-d": "#9a8cd0", "purple-h": "#bfb4e8", "purple-b": "#dcd6f4", "purple-g": "#6e6890", txb: "#f5f4ef", txh: "#eceae5", tx: "#d7d5cd", txm: "#bfbdb4", txd: "#aba9a0", txf: "#a09d97", txl: "#999690", txg: "#4a4844", panel: "#30302e", panel2: "#262624", panel3: "#1f1f1e", canvas: "#262624", mono: "ui-monospace,SFMono-Regular,Menlo,monospace", acc: "#6bbf8a", ask: "#d97757", "accent-rgb": "107 191 138" } },
  { key: "claude-iris", name: "CLAUDE IRIS", feel: "the app itself · dusk violet", sw: "#a99cdb", page: "#262624", font: "ui-sans-serif,-apple-system,'Segoe UI',system-ui,sans-serif", prad: "8px", crt: false, pal: { "acc-on": "#1f1f1e", tool: "#a3b1c2", think: "#bdb3a3", ok: "#6bbf8a", warn: "#d8a657", err: "#e0796a", "err-hi": "#f2b5aa", "err-b": "#f8d3cc", "err-g": "#9c7068", info: "#7fb0e0", "info-hi": "#a8cbee", "info-b": "#cfe3f7", purple: "#a99cdb", "purple-d": "#9a8cd0", "purple-h": "#bfb4e8", "purple-b": "#dcd6f4", "purple-g": "#6e6890", txb: "#f5f4ef", txh: "#eceae5", tx: "#d7d5cd", txm: "#bfbdb4", txd: "#aba9a0", txf: "#a09d97", txl: "#999690", txg: "#4a4844", panel: "#30302e", panel2: "#262624", panel3: "#1f1f1e", canvas: "#262624", mono: "ui-monospace,SFMono-Regular,Menlo,monospace", acc: "#a99cdb", ask: "#d97757", "accent-rgb": "169 156 219" } },
  { key: "claude-library", name: "CLAUDE LIBRARY", feel: "the app itself · lamplit gold", sw: "#cda76a", page: "#262624", font: "ui-sans-serif,-apple-system,'Segoe UI',system-ui,sans-serif", prad: "8px", crt: false, pal: { "acc-on": "#1f1f1e", tool: "#a3b1c2", think: "#bdb3a3", ok: "#6bbf8a", warn: "#d8a657", err: "#e0796a", "err-hi": "#f2b5aa", "err-b": "#f8d3cc", "err-g": "#9c7068", info: "#7fb0e0", "info-hi": "#a8cbee", "info-b": "#cfe3f7", purple: "#a99cdb", "purple-d": "#9a8cd0", "purple-h": "#bfb4e8", "purple-b": "#dcd6f4", "purple-g": "#6e6890", txb: "#f5f4ef", txh: "#eceae5", tx: "#d7d5cd", txm: "#bfbdb4", txd: "#aba9a0", txf: "#a09d97", txl: "#999690", txg: "#4a4844", panel: "#30302e", panel2: "#262624", panel3: "#1f1f1e", canvas: "#262624", mono: "ui-monospace,SFMono-Regular,Menlo,monospace", acc: "#cda76a", ask: "#7fb0e0", "accent-rgb": "205 167 106" } },
  { key: "claude-dusk", name: "CLAUDE DUSK", feel: "the app itself · muted slate", sw: "#8fb3b0", page: "#262624", font: "ui-sans-serif,-apple-system,'Segoe UI',system-ui,sans-serif", prad: "8px", crt: false, pal: { "acc-on": "#1f1f1e", tool: "#a3b1c2", think: "#bdb3a3", ok: "#6bbf8a", warn: "#d8a657", err: "#e0796a", "err-hi": "#f2b5aa", "err-b": "#f8d3cc", "err-g": "#9c7068", info: "#7fb0e0", "info-hi": "#a8cbee", "info-b": "#cfe3f7", purple: "#a99cdb", "purple-d": "#9a8cd0", "purple-h": "#bfb4e8", "purple-b": "#dcd6f4", "purple-g": "#6e6890", txb: "#f5f4ef", txh: "#eceae5", tx: "#d7d5cd", txm: "#bfbdb4", txd: "#aba9a0", txf: "#a09d97", txl: "#999690", txg: "#4a4844", panel: "#30302e", panel2: "#262624", panel3: "#1f1f1e", canvas: "#262624", mono: "ui-monospace,SFMono-Regular,Menlo,monospace", acc: "#8fb3b0", ask: "#d97757", "accent-rgb": "143 179 176" } },
];

/** AURORA and CLAUDE are one profile each in several colours; the picker
 *  draws each as one card with a colour row. */
export const AURORA_KEYS: ThemeKey[] = ["aqua", "green", "amber", "magenta", "blueprint", "void"];
export const CLAUDE_KEYS: ThemeKey[] = ["claude", "claude-ocean", "claude-fern", "claude-iris", "claude-library", "claude-dusk"];

/** Where a theme that left the picker lives now (the dashboard's FLINT
 *  colourings have no phone twin, so those land on the nearest hue here). */
const MOVED: Record<string, ThemeKey> = {
  dusk: "claude-dusk", library: "claude-library", nocturne: "claude-iris", studio: "claude-iris",
  signal: "green", graphite: "claude-ocean",
};

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
