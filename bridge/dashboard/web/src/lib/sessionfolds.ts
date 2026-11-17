/** Which SESSION tab sections are open (B · NOW + MORE, .mystical/design-drafts/session-islands).
 *  The list card (FLOWS, TIME, ON WHAT, HELPERS) opens one row at a time, so the tab
 *  never grows four tall sections at once; the window's curve and the turns fold on
 *  their own. Kept in localStorage under the key the flat sections used. */
export const OPEN0 = { window: false, flows: false, time: false, onwhat: false, helpers: false, turns: true };
export type Folds = typeof OPEN0;
export type Fold = keyof Folds;
const LIST: Fold[] = ["flows", "time", "onwhat", "helpers"];

/** Open or fold one section; opening a list row folds the other rows. */
export function flipFold(open: Folds, k: Fold): Folds {
  const next = { ...open, [k]: !open[k] };
  if (next[k] && LIST.includes(k)) for (const o of LIST) if (o !== k) next[o] = false;
  return next;
}

/** Fold the window and the list; the turns are the tab's body and stay as they are. */
export const foldAll = (open: Folds): Folds => ({ ...OPEN0, turns: open.turns });
export const anyOpen = (open: Folds) => open.window || LIST.some((k) => open[k]);

/** A stored set: unknown keys dropped, a set from before the list card keeps only its first open row. */
export function readFolds(raw: string | null): Folds {
  let p: Partial<Folds> = {};
  try { p = JSON.parse(raw || "{}") ?? {}; } catch { /* a fresh tab */ }
  const out = { ...OPEN0 };
  for (const k of Object.keys(OPEN0) as Fold[]) if (typeof p[k] === "boolean") out[k] = p[k]!;
  const first = LIST.find((k) => out[k]);
  for (const k of LIST) if (k !== first) out[k] = false;
  return out;
}
