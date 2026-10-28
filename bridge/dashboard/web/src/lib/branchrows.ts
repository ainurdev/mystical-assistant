/** The BRANCHES rail tab's rows (bridge git.branch_status): every branch and
 *  checkout of the open session's repo. Three groups: WORKTREES (anything
 *  checked out somewhere), BRANCHES (no checkout, its work not in the base yet)
 *  and MERGED (no checkout, its work landed).
 *
 *  Worktrees order by what you'd look for: the open session's branch, then one
 *  waiting on you or working, then the newest commit, then the base, and a
 *  detached checkout last (it holds no branch, only a commit). */
export interface BranchRow {
  name: string;            // "" for a detached checkout, which carries `head`
  head?: string;
  at: number;              // last commit, epoch s
  subject: string;         // its first line
  sha: string;             // the tip, matched against a merged PR's head
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

/** A branch's newest PR (bridge prstatus.branch_prs); `status` is the chat header chip's word. */
export interface BranchPr { number: number; state: "OPEN" | "MERGED" | "CLOSED"; status: string; sha: string; failed: number }

export type Activity = "working" | "asking" | null;
export interface ShownRow extends BranchRow {
  label: string;           // the sidebar's short form: the name's last segment
  here: boolean;
  base: boolean;
  activity: Activity;
  pr: BranchPr | null;     // open, or merged at this tip: an older merged PR says nothing about newer work
  landed: boolean;         // its work is in the base, by git or by a PR merged at its tip (a squash merge)
}

/** The overview chips: each counts the rows it filters to, so the two can't disagree.
 *  The panel shows waiting in working's place while anything waits on you. */
export const CHIPS = {
  waiting: (r: ShownRow) => r.activity === "asking",
  working: (r: ShownRow) => !!r.activity,
  uncommitted: (r: ShownRow) => !!r.dirty,
  unmerged: (r: ShownRow) => !!r.name && !r.base && r.ahead > 0 && !r.landed,
  merged: (r: ShownRow) => r.landed,
};
export type Chip = keyof typeof CHIPS;

export function branchGroups(rows: BranchRow[], base: string, here: string | null,
                             activity: Map<string, Activity>, prs: Record<string, BranchPr> = {}) {
  const shown: ShownRow[] = rows.map((r) => {
    const p = r.name ? prs[r.name] : undefined;
    const atTip = p?.state === "MERGED" && p.sha === r.sha;
    const isBase = !!r.name && r.name === base;
    return {
      ...r,
      label: r.name ? r.name.split("/").pop() || r.name : `detached · ${r.head ?? ""}`,
      here: !!r.name && r.name === here,
      base: isBase,
      activity: (r.name && activity.get(r.name)) || null,
      pr: p && (p.state === "OPEN" || atTip) ? p : null,
      // A checkout at the base's own commit is new or just merged; git can't tell which, so it hasn't landed.
      landed: !isBase && ((r.merged && (r.behind > 0 || !r.worktree)) || atTip),
    };
  });
  // lower comes first: here, waits on you, working, the rest, the base, detached
  const rank = (r: ShownRow) => r.here ? 0 : r.activity === "asking" ? 1 : r.activity === "working" ? 2
    : r.base ? 4 : !r.name ? 5 : 3;
  const newest = (a: ShownRow, b: ShownRow) => b.at - a.at;
  return {
    all: shown,
    worktrees: shown.filter((r) => r.worktree).sort((a, b) => rank(a) - rank(b) || newest(a, b)),
    branches: shown.filter((r) => !r.worktree && !r.landed).sort(newest),
    merged: shown.filter((r) => !r.worktree && r.landed).sort(newest),
  };
}
