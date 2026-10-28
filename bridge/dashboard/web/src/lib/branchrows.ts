/** The BRANCHES rail tab's rows (bridge git.branch_status): every branch and
 *  checkout of the open session's repo, status only. Three groups:
 *  WORKTREES (anything checked out somewhere), BRANCHES (no checkout, not in
 *  the base yet) and MERGED (no checkout, already in the base).
 *
 *  Worktrees order by what you'd look for: the open session's branch, then one
 *  waiting on you or working, then the newest commit, then the base, and a
 *  detached checkout last (it holds no branch, only a commit). */
export interface BranchRow {
  name: string;            // "" for a detached checkout, which carries `head`
  head?: string;
  at: number;              // last commit, epoch s
  ahead: number;           // against the base
  behind: number;
  upstream: string;        // "" = never pushed, or its remote branch is gone
  unpushed: number | null; // its commits the remote lacks; null without an upstream
  worktree: string | null; // the checkout holding it
  main: boolean;           // that checkout is the repo folder itself
  dirty: number | null;    // uncommitted files there; null without a checkout
  merged: boolean;         // contained in the base
}
export interface BranchStatus { base: string; branches: BranchRow[] }

export type Activity = "working" | "asking" | null;
export interface ShownRow extends BranchRow {
  label: string;           // the sidebar's short form: the name's last segment
  here: boolean;
  base: boolean;
  activity: Activity;
}

export function branchGroups(rows: BranchRow[], base: string, here: string | null,
                             activity: Map<string, Activity>) {
  const shown: ShownRow[] = rows.map((r) => ({
    ...r,
    label: r.name ? r.name.split("/").pop() || r.name : `detached · ${r.head ?? ""}`,
    here: !!r.name && r.name === here,
    base: !!r.name && r.name === base,
    activity: (r.name && activity.get(r.name)) || null,
  }));
  // lower comes first: here, waits on you, working, the rest, the base, detached
  const rank = (r: ShownRow) => r.here ? 0 : r.activity === "asking" ? 1 : r.activity === "working" ? 2
    : r.base ? 4 : !r.name ? 5 : 3;
  const newest = (a: ShownRow, b: ShownRow) => b.at - a.at;
  return {
    worktrees: shown.filter((r) => r.worktree).sort((a, b) => rank(a) - rank(b) || newest(a, b)),
    branches: shown.filter((r) => !r.worktree && !r.merged).sort(newest),
    merged: shown.filter((r) => !r.worktree && r.merged).sort(newest),
  };
}
