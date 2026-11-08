/** The BRANCHES rail tab's rows (bridge git.branch_status), drawn as a TREE
 *  (.mystical/design-drafts/branches-reimagine, A): every branch hangs under the
 *  branch it goes into, its `target`. The bridge picks that: your Target ▸ pick,
 *  else its PR's base, else where git says it was made, else the repo's base.
 *  One base for every branch was wrong outside this repo: efas features read
 *  "62 ahead of main" while their PRs go to staging (2026-11-08).
 *
 *  A parent says its target once and takes Land N for its idle children; each
 *  row offers one next step (nextStep) and says where it stands in a few words
 *  (facts). Land = merge into the target, run the checks, then remove the
 *  worktree and branch, in one fresh session (landPrompt). Landed children fold
 *  into one line under their parent; with auto clean-up on, the ones nothing
 *  holds go by themselves (autoClean). */
export interface BranchRow {
  name: string;            // "" for a detached checkout, which carries `head`
  head?: string;
  at: number;              // last commit, epoch s
  subject: string;         // its first line
  sha: string;             // the tip, matched against a merged PR's head
  target?: string;         // the branch it goes into; "" for the base and a branch pinned to none (missing on an old bridge)
  ahead: number;           // against its target
  behind: number;
  upstream: string;        // "" = never pushed, or its remote branch is gone
  unpushed: number | null; // its commits the remote lacks; null without an upstream
  worktree: string | null; // the checkout holding it
  main: boolean;           // that checkout is the repo folder itself
  dirty: number | null;    // uncommitted files there; null without a checkout
  merged: boolean;         // contained in its target
  worked?: boolean;        // it moved after it was made; a worktree opened a minute ago sits on its start
  clash?: string[] | null; // a dry-run merge into its target: [] clean, the files that clash, null not asked
}
export interface BranchStatus { base: string; branches: BranchRow[]; picks?: Record<string, string> }

/** A branch's newest PR (bridge prstatus.branch_prs); `status` is the chat header chip's word.
 *  `url`, `base` and `title` are missing on a bridge from before they were added. */
export interface BranchPr { number: number; state: "OPEN" | "MERGED" | "CLOSED"; status: string; sha: string; failed: number;
  url?: string; base?: string; title?: string }

export type Activity = "working" | "asking" | null;
export interface ShownRow extends BranchRow {
  label: string;           // the sidebar's short form: the name's last segment
  into: string;            // where it goes, as a name ("" for nowhere): origin/x reads x
  here: boolean;
  base: boolean;
  activity: Activity;
  pr: BranchPr | null;     // open, or merged at this tip: an older merged PR says nothing about newer work
  prBefore: number | null; // an older PR that merged before the branch moved on (EFA-248 after #171)
  landed: boolean;         // its work is in its target, by git or by a PR merged at its tip (a squash merge)
  parent: boolean;         // other branches go into it: it never lands by itself (staging)
  remote: boolean;         // a target only origin has (release/x): a parent you can't check out from here
  title: string;           // a code name's PR or session title ("EFA-300" → "Call the report…"), else ""
}
export interface Node { row: ShownRow; kids: Node[]; landed: ShownRow[] }

/** A row's one next step. Land and the ✦ ones (commit, resolve, fix) start a
 *  fresh Claude session with a prompt; push and cleanup are git; pr is a link;
 *  answer opens the session waiting on you. */
export type Step = "answer" | "resolve" | "fix" | "cleanup" | "commit" | "pr" | "push" | "land";

const short = (t: string) => t.replace(/^origin\//, "");
/** A name that says nothing by itself: no lowercase word in it ("EFA-300", "2026-11-08"). */
export const codeName = (label: string) => !!label && !/[a-z]{3,}/.test(label);
/** A PR or session title, said once: "feat: INR-71 EFA-317 Target sector…" → "Target sector…". */
export const plainTitle = (t: string) =>
  t.replace(/^[a-z]+(\([^)]*\))?!?:\s*/i, "").replace(/^(?:[A-Z][A-Z0-9]*-\d+[\s,:·]*)+/, "").trim();

/** First match wins. Nothing while a session works there: Claude is on it.
 *  Steps that need the branch checked out (commit, push, resolve, fix) wait for a worktree. */
export function nextStep(r: ShownRow): Step | null {
  if (r.activity === "asking") return "answer";
  if (r.activity === "working") return null;
  if (r.worktree && r.pr?.status === "conflicts") return "resolve";
  if (r.worktree && r.pr?.status === "failing") return "fix";
  if (r.landed) return r.main ? null : "cleanup";     // the repo folder itself never goes
  if (!r.name || r.remote) return null;               // a detached checkout holds no branch
  if (r.dirty) return "commit";
  if (r.parent || r.base || !r.into) return null;     // others go into it: its Land N speaks for it
  if (r.pr?.state === "OPEN") return r.pr.status === "ready" ? "land" : r.pr.url ? "pr" : null;
  if (r.worktree && r.upstream && r.unpushed) return "push";
  return r.ahead ? "land" : null;
}

/** What Land N takes: idle branches with work and nothing in the way. */
export function landable(r: ShownRow): boolean {
  return nextStep(r) === "land";
}

/** Why a child with work is left out of Land N, said in the list: busy, or something to do first. */
export function heldBy(r: ShownRow): string {
  if (r.activity === "asking") return "waits on you";
  if (r.activity === "working") return "is working";
  if (r.dirty) return `has ${r.dirty} uncommitted`;
  if (r.pr?.state === "OPEN" && r.pr.status !== "ready") return `PR #${r.pr.number} ${PR_WORD[r.pr.status] ?? "is open"}`;
  if (r.upstream && r.unpushed) return `has ${r.unpushed} to push`;
  return "";
}

/** Landed branches nothing holds any more: no session on them in the last half
 *  hour (`recent`), none open here, no uncommitted file, and a worktree the
 *  bridge made (an integrate run's /tmp tree is its own to remove). Auto clean-up
 *  takes these; a branch that never moved past its start is never one. */
export function autoClean(rows: ShownRow[], recent: ReadonlySet<string>): ShownRow[] {
  return rows.filter((r) => r.landed && r.name && !r.main && !r.base && !r.parent && !r.here && !r.activity
    && !recent.has(r.name) && r.worked !== false
    && (!r.worktree || (r.dirty === 0 && r.worktree.includes("/.worktrees/"))));
}

const PR_WORD: Record<string, string> = {
  review: "in review", ready: "ready", running: "checks running", changes: "changes asked",
  failing: "checks failing", conflicts: "conflicts",
};
export type Fact = { t: string; tone?: "warn" | "err" | "merged" | "ok" };
const plural = (n: number, w: string) => `${n} ${n === 1 ? w : `${w}s`}`;

/** Where a row stands, in up to three short facts, in reading order: its PR or
 *  that it landed, what's uncommitted or unpushed, its commits and how far
 *  behind, then whether it would land clean. The most telling three are kept. */
export function facts(r: ShownRow, kids = 0): Fact[] {
  const f: (Fact & { p: number })[] = [];
  // a parent says what goes into it; its own drift is the rest, and whether it would land clean is noise
  if (r.parent && kids) f.push({ t: `${kids} go here`, p: 0 });
  if (r.pr) f.push(r.pr.state === "MERGED" ? { t: `merged · PR #${r.pr.number}`, tone: "merged", p: 0 }
    : { t: `PR #${r.pr.number} ${PR_WORD[r.pr.status] ?? "open"}`, p: 0,
        tone: r.pr.status === "failing" ? "err" : r.pr.status === "conflicts" ? "warn" : undefined });
  else if (r.landed) f.push({ t: `in ${short(r.into) || "its target"}`, tone: "merged", p: 0 });
  if (r.dirty) f.push({ t: `${r.dirty} uncommitted`, tone: "warn", p: 1 });
  if (r.upstream && r.unpushed) f.push({ t: `${r.unpushed} to push`, tone: "warn", p: 2 });
  if (!r.landed && !r.base && r.into) {
    if (r.ahead) f.push({ t: r.parent ? `${r.ahead} ahead of ${short(r.into)}` : plural(r.ahead, "commit"), p: 3 });
    if (r.behind) f.push({ t: `${r.behind} behind`, p: 6 });
    if (!r.ahead && !r.behind) f.push({ t: `same as ${short(r.into)}`, p: 3 });
    if (r.ahead && r.clash && !r.parent) f.push(r.clash.length ? { t: `⚠ ${plural(r.clash.length, "file")} clash`, tone: "warn", p: 4 }
      : { t: "✓ merges clean", tone: "ok", p: 5 });
  }
  if (r.prBefore && !r.pr && !r.base && !r.parent) f.push({ t: `after PR #${r.prBefore} merged`, p: 7 });
  if (r.base && !f.length) f.push({ t: "the base", p: 9 });
  const keep = new Set([...f].sort((a, b) => a.p - b.p).slice(0, 3));
  return f.filter((x) => keep.has(x)).map(({ p: _, ...x }) => x);
}

/** The rows as the tab shows them: who's on each (activity), its PR, whether it
 *  landed, whether others go into it, and a code name's title (`titles`: the
 *  newest session title per branch). */
export function shownRows(rows: BranchRow[], base: string, here: string | null,
                          activity: Map<string, Activity>, prs: Record<string, BranchPr> = {},
                          titles: Map<string, string> = new Map()): ShownRow[] {
  const shown: ShownRow[] = rows.map((r) => {
    const p = r.name ? prs[r.name] : undefined;
    const atTip = p?.state === "MERGED" && p.sha === r.sha;
    const isBase = !!r.name && r.name === base;
    // an old bridge sends no target: everything goes into the base, as before
    const into = r.target ?? (isBase ? "" : base);
    const label = r.name ? r.name.split("/").pop() || r.name : `detached · ${r.head ?? ""}`;
    return {
      ...r,
      label, into,
      here: !!r.name && r.name === here,
      base: isBase,
      activity: (r.name && activity.get(r.name)) || null,
      pr: p && (p.state === "OPEN" || atTip) ? p : null,
      prBefore: p?.state === "MERGED" && !atTip ? p.number : null,
      // A checkout at its target's own commit is new or just merged; git can't tell which, so it hasn't landed.
      // One that never moved past where it was made is new for sure.
      landed: !isBase && !!r.name && ((r.merged && r.worked !== false && (r.behind > 0 || !r.worktree)) || atTip),
      parent: false, remote: false,
      title: codeName(label) ? plainTitle(p?.title || (r.name && titles.get(r.name)) || "") : "",
    };
  });
  const goesInto = new Set(shown.filter((r) => r.name).map((r) => short(r.into)));
  for (const r of shown) r.parent = !!r.name && !r.base && goesInto.has(r.name);
  return shown;
}

// lower comes first: here, waits on you, working, something to press, the rest
const rank = (r: ShownRow) => r.here ? 0 : r.activity === "asking" ? 1 : r.activity === "working" ? 2
  : r.parent ? 3 : nextStep(r) ? 4 : !r.name ? 6 : 5;
const order = (a: Node, b: Node) => rank(a.row) - rank(b.row) || b.row.at - a.row.at;

/** The tree: each row under the row it goes into. A target only origin has
 *  becomes a parent row of its own; a loop of picks (a into b, b into a) is cut
 *  where it closes. Landed children fold into their parent's `landed`. */
export function branchTree(shown: ShownRow[]): Node[] {
  const nodes = new Map<string, Node>();
  for (const r of shown) if (r.name) nodes.set(r.name, { row: r, kids: [], landed: [] });
  const loose: Node[] = shown.filter((r) => !r.name).map((row) => ({ row, kids: [], landed: [] }));
  const up = (r: ShownRow): Node | null => {
    if (!r.into) return null;
    const hit = nodes.get(r.into) ?? nodes.get(short(r.into));
    if (hit) return hit;
    // a target nobody has here: origin's own, drawn as a parent you can land into but not open
    const name = short(r.into);
    const ghost: ShownRow = { name, at: 0, subject: "", sha: "", target: "", ahead: 0, behind: 0, upstream: "",
      unpushed: null, worktree: null, main: false, dirty: null, merged: false, label: name.split("/").pop() || name,
      into: "", here: false, base: false, activity: null, pr: null, prBefore: null, landed: false, parent: true,
      remote: true, title: "" };
    const n: Node = { row: ghost, kids: [], landed: [] };
    nodes.set(name, n);
    return n;
  };
  const parentOf = new Map<Node, Node | null>();
  for (const n of [...nodes.values(), ...loose]) parentOf.set(n, up(n.row));
  for (const n of nodes.values()) if (!parentOf.has(n)) parentOf.set(n, null);   // ghosts made above
  // a loop never closes: walk up, and the step that would come back to n is cut
  for (const n of parentOf.keys()) {
    const seen = new Set<Node>([n]);
    for (let p = parentOf.get(n); p; p = parentOf.get(p) ?? null) {
      if (seen.has(p)) { parentOf.set(n, null); break; }
      seen.add(p);
    }
  }
  const roots: Node[] = [];
  for (const [n, p] of parentOf) (p ? p.kids : roots).push(n);
  // landed kids fold into their parent's one line; one that still has kids of its own stays a row
  const fold = (n: Node) => {
    const gone = (k: Node) => k.row.landed && !k.kids.length;
    n.landed = n.kids.filter(gone).map((k) => k.row).sort((a, b) => b.at - a.at);
    n.kids = n.kids.filter((k) => !gone(k)).sort(order);
    n.kids.forEach(fold);
  };
  roots.forEach(fold);
  roots.sort(order);
  return roots.sort((a, b) => (b.row.base ? 1 : 0) - (a.row.base ? 1 : 0));
}

/** Every landable child under a node, nearest first (Land N's list), and the
 *  ones with work that wait for something (named, not offered). */
export function landList(n: Node): { take: ShownRow[]; held: { row: ShownRow; why: string }[] } {
  const take: ShownRow[] = [], held: { row: ShownRow; why: string }[] = [];
  for (const k of n.kids) {
    if (landable(k.row)) take.push(k.row);
    else if (k.row.ahead && !k.row.landed && !k.row.parent) { const why = heldBy(k.row); if (why) held.push({ row: k.row, why }); }
  }
  return { take, held };
}

/** Land prompts: one fresh session merges, runs the checks, then cleans up. */
export function landPrompt(rows: ShownRow[], into: string): string {
  const tail = "settle any conflicts, make sure the build and tests pass, then remove its worktree and delete the branch. Don't push.";
  const prs = rows.filter((r) => r.pr?.state === "OPEN");
  const via = prs.length ? ` Where a branch has an open PR (${prs.map((r) => `#${r.pr!.number}`).join(", ")}), land it by merging that PR.` : "";
  if (rows.length === 1) return `Land ${rows[0].name} into ${short(into)} the way this repo does it: merge it in, ${tail}${via}`;
  return `Land these into ${short(into)} the way this repo does it, one at a time: ${rows.map((r) => r.name).join(", ")}. `
    + `For each: merge it in, ${tail}${via}`;
}
/** Merge a branch into another (a drag, or ⋯ Merge into ▸); `keep` = Merge only. */
export function mergePrompt(r: ShownRow, into: string, keep = false): string {
  return `Merge ${r.name} into ${short(into)} the way this repo does it, settle any conflicts and make sure the build and tests pass. `
    + (keep ? "Keep the branch and its worktree. Don't push." : `Then remove ${r.name}'s worktree and delete the branch. Don't push.`);
}

/** Who is on each branch of `project` now, from the sidebar's sessions: the one
 *  working or waiting there (waiting on you outranks working), every session
 *  newest first, and the newest one's title (a code name's second name). */
export function branchActivity<S extends { id: string; project: string; branch?: string | null; archived?: boolean | number;
  updated: number; title?: string | null }>(sessions: S[], status: Map<string, { state?: string }>, project: string | null) {
  const activity = new Map<string, Activity>(), byBranch = new Map<string, S[]>(), live = new Map<string, S>();
  for (const s of sessions) {
    if (s.project !== project || !s.branch || s.archived) continue;
    (byBranch.get(s.branch) ?? byBranch.set(s.branch, []).get(s.branch)!).push(s);
    const st = status.get(s.id)?.state;
    if (st === "awaiting" || st === "asking") { activity.set(s.branch, "asking"); live.set(s.branch, s); }
    else if ((st === "working" || st === "checking") && activity.get(s.branch) !== "asking") { activity.set(s.branch, "working"); live.set(s.branch, s); }
  }
  const titles = new Map<string, string>();
  for (const [b, l] of byBranch) { l.sort((a, c) => c.updated - a.updated); if (l[0].title) titles.set(b, l[0].title); }
  return { activity, byBranch, live, titles };
}
