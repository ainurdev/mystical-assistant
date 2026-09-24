/** Open SETTINGS on one tab from anywhere in the tree.
 *
 *  ponytail: a window event rather than a prop threaded App → Terminal →
 *  Transcript → TurnBlock, because the only caller is a dead-login badge four
 *  layers down and the only listener is App. Make it a context if a third
 *  caller ever wants it. */
export function openSettings(tab: string) {
  window.dispatchEvent(new CustomEvent("hud:settings", { detail: tab }));
}
