// Which chat you had open, so a cold start comes back to it.
//
// Nothing server-side remembers this. The bridge's selected repo (state.active)
// lives in memory, so a restart forgets it and falls back to BASE_PATH — and the
// resolver, asked for "the newest chat in the active repo", lands you somewhere
// you have never worked instead of where you were.
//
// The id alone is enough here: the dashboard lists every repo's sessions, so the
// entry carries its own project, and one that has since been deleted (or whose
// repo is gone — the list filters those) simply isn't found, which is the same
// answer as never having seen it.

const KEY = "hud-last-session";

export function rememberOpen(id: string) {
  try { localStorage.setItem(KEY, id); } catch { /* quota / no storage */ }
}

export function lastOpen(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}
