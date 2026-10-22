/** The fresh-session screen's LOCAL readout: every branch off the default one,
 *  paired with the newest session on it, and the two openers it offers.
 *
 *  Why these two openers and not the NEXT board this replaced: on 2026-10-23,
 *  0 of 346 dashboard sessions had started from the board, while about one
 *  first prompt in nine was local housekeeping typed in the same words each
 *  time — "clean up local, then …" and "merge all non-working branches into
 *  main, then clean up". The readout is what decides whether either is due.
 *  (.mystical/design-drafts/fresh-session-v2/SPEC.md) */

export interface LocalRow {
  branch: string;
  /** The newest session on the branch in this project, or null. */
  session: { id: string; title: string | null; updated: number } | null;
  /** Its session is working, asking, parked or waiting — not one to merge. */
  busy: boolean;
  merged: boolean;
  /** Checked out in a linked worktree. */
  held: boolean;
}

/** Busy first, then branches whose session is done (newest first), then
 *  worktrees nobody has a session on, then the rest in git's order — newest
 *  commit first, which is how `branches` arrives. */
export function localRows(
  branches: string[], def: string, held: Set<string>, merged: Set<string>,
  sessions: { id: string; branch?: string; title: string | null; updated: number }[],
  busy: (sessionId: string) => boolean,
): LocalRow[] {
  const newest = new Map<string, LocalRow["session"]>();
  for (const s of sessions) {
    const was = s.branch ? newest.get(s.branch) : undefined;
    if (s.branch && (!was || s.updated > was.updated))
      newest.set(s.branch, { id: s.id, title: s.title, updated: s.updated });
  }
  const rows = branches.filter((b) => b !== def).map((b) => {
    const session = newest.get(b) ?? null;
    return { branch: b, session, busy: !!session && busy(session.id), merged: merged.has(b), held: held.has(b) };
  });
  const rank = (r: LocalRow) => (r.busy ? 0 : r.session ? 1 : r.held ? 2 : 3);
  const pos = new Map(rows.map((r, i) => [r.branch, i]));
  return rows.sort((a, b) => rank(a) - rank(b)
    || (rank(a) === 1 ? b.session!.updated - a.session!.updated : 0)
    || pos.get(a.branch)! - pos.get(b.branch)!);
}

/** What the merge starter merges: open work nobody is on. A branch with
 *  neither a session nor a worktree is old, not idle — merging every stale
 *  branch of a 250-branch repo is not what the button means. */
export function mergeable(rows: LocalRow[]): string[] {
  return rows.filter((r) => !r.busy && !r.merged && (r.session || r.held)).map((r) => r.branch);
}

export const mergeClause = (branches: string[], def: string) =>
  `merge ${branches.join(", ")} into ${def}, then clean up local`;

/** A starter goes in front of what is in the prompt box already, so "clean
 *  up local" chains onto the task you were typing. `open` leaves the box on
 *  ", then " for the task still to come. */
export function startWith(clause: string, open: boolean, draft: string): string {
  const d = draft.trim();
  return d ? `${clause}, then ${d}` : open ? `${clause}, then ` : clause;
}
