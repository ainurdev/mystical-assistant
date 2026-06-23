export type Phosphor = "teal" | "amber" | "green" | "violet";
export const THEMES: Phosphor[] = ["teal", "amber", "green", "violet"];
const KEY = "hud-theme";

export function getTheme(): Phosphor {
  try {
    const t = localStorage.getItem(KEY);
    if (t && (THEMES as string[]).includes(t)) return t as Phosphor;
  } catch {
    /* ignore */
  }
  return "teal";
}

export function applyTheme(t: Phosphor): void {
  const el = document.documentElement;
  if (t === "teal") el.removeAttribute("data-theme");
  else el.dataset.theme = t;
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* ignore */
  }
}
