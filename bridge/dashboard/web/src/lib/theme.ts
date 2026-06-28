// Phosphor themes. The whole HUD is authored in the aqua palette; other moods are
// produced by hue-rotating + saturating the entire dashboard with a CSS filter
// (matching the design's approach), so every accent — primary, violet, blue,
// green — shifts together. CRT effects (scanlines / sweep / glow) toggle on top.

export type Phosphor = "aqua" | "green" | "amber" | "magenta";

export interface ThemeDef {
  key: Phosphor;
  name: string; // display name shown in the theme picker
  feel: string; // flavour text
  deg: number; // hue-rotate degrees applied to the dashboard
  sat: number; // saturate multiplier
  sw: string; // representative swatch colour
  bg: string; // ambient background tint behind the dashboard
  pbg: string; // preview-card background
}

export const THEME_DEFS: ThemeDef[] = [
  { key: "aqua", name: "AURORA", feel: "orbital glass · clean signal", deg: 0, sat: 1.0, sw: "#7fe9d8", bg: "rgba(10,26,32,.55)", pbg: "#04090b" },
  { key: "green", name: "VIRIDIAN", feel: "buried relay · net-runner", deg: -58, sat: 1.5, sw: "#5fdd8f", bg: "rgba(8,28,16,.5)", pbg: "#040a07" },
  { key: "amber", name: "EMBER", feel: "salvage rig · warm static", deg: -146, sat: 1.7, sw: "#e8b04a", bg: "rgba(34,20,4,.5)", pbg: "#0a0703" },
  { key: "magenta", name: "NOVA", feel: "neon district · synthwave", deg: 132, sat: 1.6, sw: "#ff7ad9", bg: "rgba(28,8,34,.55)", pbg: "#090410" },
];

export const THEMES: Phosphor[] = THEME_DEFS.map((t) => t.key);

export function themeDef(t: Phosphor): ThemeDef {
  return THEME_DEFS.find((d) => d.key === t) ?? THEME_DEFS[0];
}

export function themeFilter(t: Phosphor): string {
  const d = themeDef(t);
  return `hue-rotate(${d.deg}deg) saturate(${d.sat})`;
}

export interface HudSettings {
  theme: Phosphor;
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
        theme: THEMES.includes(p.theme as Phosphor) ? (p.theme as Phosphor) : "aqua",
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
    if (old && (THEMES as string[]).includes(old)) return { ...DEFAULTS, theme: old as Phosphor };
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
