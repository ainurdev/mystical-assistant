// FILES' ✦ marks: which files of the session's checkout its turns wrote, and the
// one a running turn wrote last (lit until the turn ends — an edit lands in
// milliseconds, so "being written right now" would never be seen). Pure — read
// off the write tools' paths in the turns that are loaded, so a tailed
// transcript marks only what it holds. A path outside `root` (another worktree,
// a memory file) isn't in this tree and is skipped.

import { toolKind } from "./tools.ts";

/** Only what the read needs off a turn. */
type T = { status: string; events: { type: string; name?: string; summary?: string; detail?: string }[] };

export function sessionEdits(turns: T[], root: string | null | undefined): { edited: Set<string>; now: string | null } {
  const edited = new Set<string>();
  let now: string | null = null;
  if (!root) return { edited, now };
  const pre = root.endsWith("/") ? root : `${root}/`;
  for (const t of turns) {
    for (const e of t.events) {
      if (e.type !== "tool" || toolKind(e.name ?? "") !== "write") continue;
      // `detail` is the path whole when the 120-char summary cut it.
      const p = e.detail ?? e.summary ?? "";
      if (!p.startsWith(pre)) continue;
      edited.add(p.slice(pre.length));
      if (t.status === "running") now = p.slice(pre.length);
    }
  }
  return { edited, now };
}
