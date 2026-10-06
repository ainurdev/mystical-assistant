/** Open SETTINGS on one tab from anywhere in the tree — and, for PLUGINS,
 *  straight into editing one connection (the RIVENDELL tab's REPLACE TOKEN,
 *  the bell's broken-link entry).
 *
 *  ponytail: a window event rather than a prop threaded App → Terminal →
 *  Transcript → TurnBlock. The callers are a dead-login badge four layers
 *  down and the RIVENDELL tab's buttons; the only listener is App. The focus
 *  rides a module variable the panel takes once, on mount. Make it a context
 *  when a caller needs more than a tab and an id. */
let focus: string | null = null;

export function openSettings(tab: string, what?: string) {
  focus = what ?? null;
  window.dispatchEvent(new CustomEvent("hud:settings", { detail: tab }));
}

/** What openSettings asked the tab to open on (an instance id) — once. */
export function takeSettingsFocus(): string | null {
  const f = focus;
  focus = null;
  return f;
}
