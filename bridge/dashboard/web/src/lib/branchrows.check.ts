// Run: node bridge/dashboard/web/src/lib/branchrows.check.ts
import { autoClean, branchTree, codeName, facts, landList, landPrompt, mergePrompt, nextStep, plainTitle, shownRows,
  type Activity, type BranchPr, type BranchRow, type Node, type ShownRow } from "./branchrows.ts";

const row = (name: string, at: number, extra: Partial<BranchRow> = {}): BranchRow => ({
  name, at, subject: "", sha: `${name}-tip`, target: "master", ahead: 0, behind: 0, upstream: "", unpushed: null,
  worktree: null, main: false, dirty: null, merged: false, worked: true, clash: null, ...extra,
});
const pr = (number: number, extra: Partial<BranchPr> = {}): BranchPr =>
  ({ number, state: "OPEN", status: "review", sha: "", failed: 0, url: `u/${number}`, ...extra });
const names = (ns: Node[] | ShownRow[]) => ns.map((n) => ("row" in n ? n.row : n).name).join();

// --- Mystical, 2026-11-08: one base, two live, two to land, three landed ---------------------
const wt = (n: string) => `/Users/x/Projects/.worktrees/mystical-assistant/${n}`;
const ma = shownRows([
  row("master", 50, { target: "", worktree: "/Users/x/Projects/mystical-assistant", main: true, upstream: "origin/master", unpushed: 237 }),
  row("integrate/2026-11-08", 49, { worktree: "/private/tmp/mystical-integrate-1108", ahead: 6 }),
  row("feat/council-tab", 40, { worktree: wt("feat-council-tab"), ahead: 3 }),
  row("feat/make-settings-modal-bigger", 39, { worktree: wt("feat-make-settings"), ahead: 5, behind: 33, clash: [], dirty: 0 }),
  row("feat/clock-overlay-mini-calendar", 41, { worktree: wt("feat-clock"), ahead: 5, behind: 10, clash: ["a.tsx", "b.css"], dirty: 0 }),
  row("feat/git-diverged-merge", 30, { worktree: wt("feat-git-diverged-merge"), behind: 9, merged: true, dirty: 0 }),
  row("fix/restart-double-run", 31, { worktree: wt("feat-communication"), behind: 33, merged: true, dirty: 0 }),
  row("feat/communication-project-setup-and-checks", 29, { behind: 35, merged: true }),
  row("feat/just-opened", 52, { worktree: wt("feat-just-opened"), behind: 2, merged: true, worked: false, dirty: 0 }),
], "master", null, new Map<string, Activity>([["integrate/2026-11-08", "working"], ["feat/council-tab", "asking"]]));
const tree = branchTree(ma);
const [master] = tree;
console.assert(tree.length === 1 && master.row.name === "master", `one root, the base: ${names(tree)}`);
console.assert(names(master.kids) === "feat/council-tab,integrate/2026-11-08,feat/clock-overlay-mini-calendar,feat/make-settings-modal-bigger,feat/just-opened",
  `waits on you, working, then something to press by newest, then the rest: ${names(master.kids)}`);
console.assert(names(master.landed) === "fix/restart-double-run,feat/git-diverged-merge,feat/communication-project-setup-and-checks",
  `landed kids fold into the parent, newest first: ${names(master.landed)}`);
const just = ma.find((r) => r.name === "feat/just-opened")!;
console.assert(!just.landed && nextStep(just) === null, "a worktree that never moved past its start hasn't landed");
const ml = landList(master);
console.assert(names(ml.take) === "feat/clock-overlay-mini-calendar,feat/make-settings-modal-bigger", `Land 2: ${names(ml.take)}`);
console.assert(ml.held.map((h) => `${h.row.label} ${h.why}`).join() === "council-tab waits on you,2026-11-08 is working",
  `busy ones are named, not offered: ${ml.held.map((h) => h.why)}`);
const said = (rows: ShownRow[], n: string) => facts(rows.find((r) => r.name === n)!).map((f) => f.t).join(" · ");
console.assert(said(ma, "feat/clock-overlay-mini-calendar") === "5 commits · 10 behind · ⚠ 2 files clash", said(ma, "feat/clock-overlay-mini-calendar"));
console.assert(said(ma, "feat/make-settings-modal-bigger") === "5 commits · 33 behind · ✓ merges clean", said(ma, "feat/make-settings-modal-bigger"));
console.assert(said(ma, "feat/git-diverged-merge") === "in master", said(ma, "feat/git-diverged-merge"));
console.assert(said(ma, "master") === "237 to push", `the base: ${said(ma, "master")}`);

// auto clean-up: only landed, clean, quiet worktrees the bridge made (and plain branches)
const clean = (rows: ShownRow[], recent: string[] = []) => names(autoClean(rows, new Set(recent)));
console.assert(clean(ma) === "feat/git-diverged-merge,fix/restart-double-run,feat/communication-project-setup-and-checks", clean(ma));
console.assert(clean(ma, ["feat/git-diverged-merge"]) === "fix/restart-double-run,feat/communication-project-setup-and-checks",
  "a branch someone used in the last half hour stays");
const odd = shownRows([
  row("master", 9, { target: "", worktree: "/r", main: true }),
  row("feat/dirty", 8, { worktree: wt("feat-dirty"), behind: 1, merged: true, dirty: 2 }),
  row("integrate/x", 7, { worktree: "/private/tmp/mystical-integrate-x", behind: 1, merged: true, dirty: 0 }),
  row("feat/live", 6, { worktree: wt("feat-live"), behind: 1, merged: true, dirty: 0 }),
  row("feat/here", 5, { worktree: wt("feat-here"), behind: 1, merged: true, dirty: 0 }),
], "master", "feat/here", new Map<string, Activity>([["feat/live", "working"]]));
console.assert(clean(odd) === "", `uncommitted, a /tmp tree, a live session, the open branch: all stay; got ${clean(odd)}`);

// --- efas: two targets, PRs going to staging ----------------------------------------------
const efas = shownRows([
  row("main", 60, { target: "", worktree: "/e", main: true, dirty: 13, upstream: "origin/main", unpushed: 0 }),
  row("staging", 59, { target: "main", worktree: wt("staging"), ahead: 59, behind: 14, upstream: "origin/staging", unpushed: 0 }),
  row("feat/EFA-300", 58, { target: "staging", worktree: wt("feat-EFA-300"), ahead: 3, clash: [], upstream: "o", unpushed: 0 }),
  row("feat/EFA-358-multi-org-export", 57, { target: "staging", worktree: wt("feat-EFA-358"), ahead: 18, behind: 13, upstream: "o", unpushed: 0 }),
  row("feat/INR-71-EFA-317-message-recipients", 55, { target: "staging", worktree: wt("feat-EFA-317"), ahead: 3, behind: 88, upstream: "o", unpushed: 0 }),
  row("feat/EFA-248", 51, { target: "staging", worktree: wt("feat-EFA-248"), ahead: 1, behind: 86, upstream: "o", unpushed: 1 }),
  row("fix/INR-74-EFA-373-web-drain", 56, { target: "main", worktree: wt("fix-INR-74"), ahead: 2, behind: 6, upstream: "o", unpushed: 0 }),
  row("fix/EFA-298", 48, { target: "main", worktree: wt("fix-EFA-298"), behind: 43, merged: true, dirty: 2 }),
], "main", null, new Map(), {
  "feat/EFA-300": pr(213, { status: "ready", base: "staging", title: "Call the report RI&E-rapport on the client and Excel pages" }),
  "feat/EFA-358-multi-org-export": pr(181, { status: "ready" }),
  "feat/INR-71-EFA-317-message-recipients": pr(182, { status: "ready" }),
  "feat/EFA-248": pr(171, { state: "MERGED", status: "merged", sha: "older" }),
  "fix/INR-74-EFA-373-web-drain": pr(202),
});
const [main] = branchTree(efas);
const staging = main.kids.find((k) => k.row.name === "staging")!;
console.assert(names(main.kids) === "staging,fix/INR-74-EFA-373-web-drain", `staging is a parent, first: ${names(main.kids)}`);
console.assert(staging.row.parent && nextStep(staging.row) === null, "a branch others go into never lands by itself");
console.assert(names(staging.kids) === "feat/EFA-300,feat/EFA-358-multi-org-export,feat/INR-71-EFA-317-message-recipients,feat/EFA-248", names(staging.kids));
console.assert(names(main.landed) === "fix/EFA-298", "a landed branch with uncommitted files still folds; it never auto-cleans");
const sl = landList(staging);
console.assert(names(sl.take) === "feat/EFA-300,feat/EFA-358-multi-org-export,feat/INR-71-EFA-317-message-recipients", `Land 3: ${names(sl.take)}`);
console.assert(sl.held.map((h) => h.why).join() === "has 1 to push", sl.held.map((h) => h.why).join());
console.assert(landList(main).held.map((h) => h.why).join() === "PR #202 in review", "a PR in review waits");
console.assert(said(efas, "feat/EFA-300") === "PR #213 ready · 3 commits · ✓ merges clean", said(efas, "feat/EFA-300"));
console.assert(said(efas, "feat/EFA-248") === "1 to push · 1 commit · 86 behind", said(efas, "feat/EFA-248"));
console.assert(efas.find((r) => r.name === "feat/EFA-300")!.title.startsWith("Call the report"), "a code name gets its PR title");
console.assert(plainTitle("feat: INR-71 EFA-317 Target sector messages") === "Target sector messages"
  && plainTitle("fix(web): INR-74, INR-77 Stop 503s") === "Stop 503s" && plainTitle("EFA-358 PR 181 Review Fixes") === "PR 181 Review Fixes",
  "a title loses its commit prefix and ticket keys");
console.assert(facts(staging.row, 4).map((f) => f.t).join(" · ") === "4 go here · 59 ahead of main · 14 behind",
  `a parent says what goes into it: ${facts(staging.row, 4).map((f) => f.t).join(" · ")}`);
console.assert(efas.find((r) => r.name === "feat/INR-71-EFA-317-message-recipients")!.title === "", "a name with words needs none");
console.assert(codeName("EFA-300") && codeName("2026-11-08") && !codeName("make-settings-modal-bigger"), "code names");
console.assert(clean(efas) === "", "EFA-298 has 2 uncommitted: it stays");

// --- apex: a target only origin has, and a branch made from another branch ----------------
const apex = branchTree(shownRows([
  row("main", 9, { target: "", worktree: "/a", main: true }),
  row("feat/furkan-videos-6-12", 8, { target: "origin/release/dashboard-v1", worktree: wt("fv"), behind: 1, merged: true, dirty: 0 }),
  row("feat/furkan-v3-pins", 7, { target: "feat/furkan-videos-6-12", worktree: wt("pins"), behind: 10, merged: true, dirty: 0 }),
  row("feat/sheet-pages", 6, { target: "feat/furkan-videos-6-12", worktree: wt("sheet"), behind: 6, merged: true, dirty: 0 }),
], "main", null, new Map()));
console.assert(names(apex) === "main,release/dashboard-v1", `the base first, then origin's own target: ${names(apex)}`);
const rel = apex[1];
console.assert(rel.row.remote && rel.row.parent && nextStep(rel.row) === null, "origin's target is a parent you can't open");
console.assert(names(rel.kids) === "feat/furkan-videos-6-12" && names(rel.kids[0].landed) === "feat/furkan-v3-pins,feat/sheet-pages",
  "a landed parent with landed kids stays a row; its kids fold under it");

// --- a loop of picks is cut, not followed forever ------------------------------------------
const loop = branchTree(shownRows([
  row("main", 3, { target: "", worktree: "/l", main: true }),
  row("a", 2, { target: "b", ahead: 1 }), row("b", 1, { target: "a", ahead: 1 }),
], "main", null, new Map()));
console.assert(loop.length === 2 && names(loop.flatMap((n) => [n, ...n.kids])).split(",").sort().join() === "a,b,main", `cut: ${names(loop)}`);

// --- the next step: one per row, first match wins ------------------------------------------
const step = (extra: Partial<BranchRow>, act: Activity = null, p?: Partial<BranchPr>) =>
  nextStep(shownRows([row("feat/s", 1, extra)], "main", null, new Map(act ? [["feat/s", act]] : []),
    p ? { "feat/s": pr(7, { sha: "feat/s-tip", ...p }) } : {})[0]);
const WT = { worktree: "/w/s" };
console.assert(step({ ...WT, dirty: 3 }, "asking") === "answer", "waiting on you comes first");
console.assert(step({ ...WT, dirty: 3, ahead: 2 }, "working") === null, "a session working there: nothing to do");
console.assert(step({ ...WT, ahead: 2 }, null, { status: "conflicts" }) === "resolve", "conflicts in a checkout: resolve");
console.assert(step({ ahead: 2 }, null, { status: "conflicts" }) === "pr", "no checkout to resolve in: the PR link");
console.assert(step({ ...WT, ahead: 2 }, null, { status: "failing" }) === "fix", "failing checks: fix");
console.assert(step({ ...WT, merged: true, behind: 4, dirty: 1 }) === "cleanup", "landed: clean up");
console.assert(step({ worktree: "/r", main: true, merged: true, behind: 4 }) === null, "the repo folder is never cleaned up");
console.assert(step({ ...WT, dirty: 3, ahead: 2 }) === "commit", "uncommitted: commit");
console.assert(step({ ...WT, ahead: 2, upstream: "o/s", unpushed: 0 }, null, {}) === "pr", "a PR in review: its link");
console.assert(step({ ...WT, ahead: 2, upstream: "o/s", unpushed: 0 }, null, { status: "ready" }) === "land", "a ready PR: land it");
console.assert(step({ ...WT, ahead: 2, upstream: "o/s", unpushed: 2 }) === "push", "unpushed: push");
console.assert(step({ ahead: 2, upstream: "o/s", unpushed: 2 }) === "land", "push needs a checkout; without one, land");
console.assert(step({ ahead: 2 }) === "land", "local commits: land");
console.assert(step({ ahead: 2, target: "" }) === null, "pinned to none: it goes nowhere");
console.assert(step({ ...WT }) === null, "same as its target: nothing");
console.assert(nextStep(shownRows([row("x", 1, { name: "", head: "c09dd80", worktree: "/r", main: true, behind: 9 })], "main", null, new Map())[0]) === null,
  "a detached checkout: nothing");

// --- an old bridge sends no target: everything goes into the base, as before ----------------
const old = shownRows([{ ...row("feat/o", 1, { ahead: 2 }), target: undefined }, row("main", 2, { target: undefined })], "main", null, new Map());
console.assert(old[0].into === "main" && old[1].into === "" && nextStep(old[0]) === "land", "no target: the base");

// --- the prompts -----------------------------------------------------------------------------
const two = landPrompt(ml.take, "master");
console.assert(two.startsWith("Land these into master the way this repo does it, one at a time: feat/clock-overlay-mini-calendar, feat/make-settings-modal-bigger.")
  && two.includes("delete the branch. Don't push."), two);
const one = landPrompt(sl.take.slice(0, 1), "staging");
console.assert(one.startsWith("Land feat/EFA-300 into staging") && one.includes("(#213)"), one);
console.assert(mergePrompt(ml.take[0], "feat/make-settings-modal-bigger").includes("Then remove feat/clock-overlay-mini-calendar's worktree"), "merge into, then clean up");
console.assert(mergePrompt(ml.take[0], "master", true).includes("Keep the branch"), "merge only keeps it");
console.log("branchrows ok");
