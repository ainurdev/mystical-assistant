// Which chat you had open, so a cold start comes back to it.
//
// Nothing server-side remembers this. The bridge's selected repo (state.active)
// lives in memory, so a restart forgets it and falls back to BASE_PATH — and the
// resolver, asked for "the latest chat in the active repo", either lands you in
// a repo you have never worked in or starts a brand-new chat there.
//
// The repo travels with the id because this app only ever lists one repo at a
// time: reopening the chat has to re-select its project before the list it lives
// in can even be asked for.

export type LastOpen = { id: string; project: string };

const KEY = "miniapp:session:v1";

export function rememberOpen(id: string, project: string) {
  try { localStorage.setItem(KEY, JSON.stringify({ id, project })); }
  catch { /* quota / no storage */ }
}

/** null when nothing is remembered, or what's there isn't a pair we can use. */
export function lastOpen(): LastOpen | null {
  try {
    const r = JSON.parse(localStorage.getItem(KEY) || "null") as Partial<LastOpen> | null;
    if (!r || typeof r.id !== "string" || typeof r.project !== "string") return null;
    return { id: r.id, project: r.project };
  } catch { return null; }
}
