export type Phosphor = "aqua" | "green" | "amber" | "magenta";
export const THEMES: Phosphor[] = ["aqua", "green", "amber", "magenta"];
const KEY = "hud-theme";

export function getTheme(): Phosphor {
  try {
    const t = localStorage.getItem(KEY);
    if (t && (THEMES as string[]).includes(t)) return t as Phosphor;
  } catch {
    /* ignore */
  }
  return "aqua";
}

export function applyTheme(t: Phosphor): void {
  const el = document.documentElement;
  if (t === "aqua") el.removeAttribute("data-theme");
  else el.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* ignore */
  }
}
