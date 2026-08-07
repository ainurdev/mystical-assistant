/* Editor preferences — the three VS Code settings people actually change, kept
   per browser like every other HUD pref (see lib/prefs.ts). No settings panel:
   they're toggle commands in the editor's own Ctrl-Shift-P palette, which is
   where VS Code puts word wrap and font size too. */

export interface EditorPrefs {
  formatOnSave: boolean;
  wordWrap: boolean;
  fontSize: number;   // px
}

export const DEFAULT_PREFS: EditorPrefs = {
  formatOnSave: false,
  wordWrap: false,
  fontSize: 12,       // matches the crtTheme default in EditorTab
};

export const KEY = "hud-editor-prefs";
const FONT_MIN = 9;
const FONT_MAX = 22;

/** Keep the font inside a range the buffer stays readable at — the only way out
 *  of a bad value is clearing localStorage. */
export function clampFont(n: number): number {
  if (!Number.isFinite(n)) return DEFAULT_PREFS.fontSize;
  return Math.min(FONT_MAX, Math.max(FONT_MIN, Math.round(n)));
}

/** Defaults overlaid with whatever survived in storage. Unknown keys are dropped
 *  and wrongly typed ones fall back, so an old or hand-edited value can't put the
 *  editor in a state with no UI to escape it. */
export function mergePrefs(raw: string | null): EditorPrefs {
  let stored: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw || "{}");
    if (parsed && typeof parsed === "object") stored = parsed as Record<string, unknown>;
  } catch { /* corrupt — defaults */ }
  return {
    formatOnSave: typeof stored.formatOnSave === "boolean" ? stored.formatOnSave : DEFAULT_PREFS.formatOnSave,
    wordWrap: typeof stored.wordWrap === "boolean" ? stored.wordWrap : DEFAULT_PREFS.wordWrap,
    fontSize: typeof stored.fontSize === "number" ? clampFont(stored.fontSize) : DEFAULT_PREFS.fontSize,
  };
}

export function loadPrefs(): EditorPrefs {
  try { return mergePrefs(localStorage.getItem(KEY)); } catch { return DEFAULT_PREFS; }
}

export function savePrefs(p: EditorPrefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* ignore */ }
}
