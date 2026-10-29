/** The BRANCHES rail tab's rows (bridge git.branch_status): every branch and
 *  checkout of the open session's repo. Three groups: WORKTREES (anything
 *  checked out somewhere), BRANCHES (no checkout, its work not in the base yet)
 *  and MERGED (no checkout, its work landed).
 *
 *  Worktrees order by what you'd look for: the open session's branch, then one
 *  waiting on you or working, then the newest commit, then the base, and a
 *  detached checkout last (it holds no branch, only a commit).
 *
 *  Each row offers its one next step (nextStep) and says where it stands in a
 *  few words (facts); the panel's ⋯ lists everything else. */
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

/** A branch's newest PR (bridge prstatus.branch_prs); `status` is the chat header chip's word.
 *  `url` is missing on a bridge from before it was added. */
export interface BranchPr { number: number; state: "OPEN" | "MERGED" | "CLOSED"; status: string; sha: string; failed: number; url?: string }

export type Activity = "working" | "asking" | null;
export interface ShownRow extends BranchRow {
  label: string;           // the sidebar's short form: the name's last segment
  here: boolean;
  base: boolean;
  activity: Activity;
  pr: BranchPr | null;     // open, or merged at this tip: an older merged PR says nothing about newer work
  landed: boolean;         // its work is in the base, by git or by a PR merged at its tip (a squash merge)
}

/** A row's one next step. The ones a Claude session does (commit, merge,
 *  openpr, resolve, fix) start a fresh session with a prompt; push and
 *  cleanup are git; pr is a link; answer opens the session waiting on you. */
export type Step = "answer" | "resolve" | "fix" | "cleanup" | "commit" | "pr" | "push" | "openpr" | "merge";

/** First match wins. Nothing while a session works there: Claude is on it.
 *  Steps that need the branch checked out (commit, push, resolve, fix) wait for a worktree. */
export function nextStep(r: ShownRow): Step | null {
  if (r.activity === "asking") return "answer";
  if (r.activity === "working") return null;
  if (r.worktree && r.pr?.status === "conflicts") return "resolve";
  if (r.worktree && r.pr?.status === "failing") return "fix";
  if (r.landed) return r.main ? null : "cleanup";     // the repo folder itself never goes
  if (!r.name) return null;                           // a detached checkout holds no branch
  if (r.dirty) return "commit";
  if (r.pr?.state === "OPEN") return r.pr.url ? "pr" : null;
  if (r.worktree && r.upstream && r.unpushed) return "push";
  if (r.base) return null;
  if (r.ahead) return r.upstream ? "openpr" : "merge";
  return null;
}

const PR_WORD: Record<string, string> = {
  review: "in review", ready: "ready", running: "checks running", changes: "changes asked",
  failing: "checks failing", conflicts: "conflicts",
};
export type Fact = { t: string; tone?: "warn" | "err" | "merged" };

/** Where a row stands, in up to three short facts: its PR or that it landed,
 *  what's uncommitted, how far from the base, and whether it's pushed. */
export function facts(r: ShownRow, base: string): Fact[] {
  const f: Fact[] = [];
  if (r.pr) f.push(r.pr.state === "MERGED" ? { t: `merged · PR #${r.pr.number}`, tone: "merged" }
    : { t: `PR ${PR_WORD[r.pr.status] ?? "open"}`, tone: r.pr.status === "failing" ? "err" : r.pr.status === "conflicts" ? "warn" : undefined });
  else if (r.landed) f.push({ t: `in ${base}`, tone: "merged" });
  if (r.dirty) f.push({ t: `${r.dirty} uncommitted`, tone: "warn" });
  if (!r.landed) {
    f.push({ t: r.base ? "the base" : r.ahead || r.behind
      ? [r.ahead && `${r.ahead} ahead`, r.behind && `${r.behind} behind`].filter(Boolean).join(", ") : `same as ${base}` });
    if (r.name && !r.pr) f.push({ t: !r.upstream ? "local" : r.unpushed ? `${r.unpushed} to push` : "pushed" });
  }
  return f.slice(0, 3);
}

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
