# BRANCHES as a tree: land work where it goes

Approved 2026-11-08 from `/design-first rething and reimagine branch tab` (A · TREE over B · ROUTES
and C · BASKET; drafts in `.mystical/design-drafts/branches-reimagine/`, UX pattern
`branches-tab-targets-tree`). Replaces DIVERGENCE (11-05).

## Why
- 30 days of prompts: ~160 typed "merge X into Y, then clean up" / "clean up local"; the tab's own
  Merge ran once.
- One base for every branch was wrong outside this repo. efas: EFA-300 read "62 ahead, 14 behind
  main" while its PR goes to staging, where it is 3 ahead. apex: three worktrees read
  "455 ahead · Merge" while all three were already in release/dashboard-v1.

## Behaviour (decided by card)
1. **Each branch has a target**: your Target ▸ pick, else its open PR's base, else where git's reflog
   says it was made ("Created from origin/staging"), else the repo's base. "Created from HEAD":
   the base when the start commit is in its history, else the branch whose own reflog stood on
   that commit. A closed PR says nothing. Ahead/behind, merged and the dry run are all against it.
2. **Land = merge, then clean up**: one fresh session merges it into its target the way the repo
   does it, runs the checks, removes the worktree and deletes the branch. Never pushes. A ready
   PR lands by merging that PR.
3. **Land N** on each parent: every idle child with work, listed and ticked; untick any; the busy
   ones are named with why (waits on you, is working, has N to push, PR in review). A branch that
   others go into (staging) never joins a Land N and never lands by itself.
4. **Drag a row onto another** to merge it there (asks once); ⋯ also has Merge into ▸.

## Add-ons (all three taken)
- The rail tile reads **LAND n** while idle branches wait to land.
- **Clean up by itself**, switchable: the broom in the tab header (lit = on, the default). Takes
  only landed branches with nothing holding them: no session on them in the last 30 minutes, not
  the open session's branch, nothing uncommitted, a worktree the bridge made (under
  `.worktrees/`), never a parent, the base or the repo folder, and never a branch that didn't move
  past where it was made. Each is tried once per page; a notice says what went.
- **Titles for code names**: a name with no word in it (EFA-300, 2026-11-08) shows its PR or
  newest session title after it, minus the commit prefix and ticket keys. Drawn on line 1, not
  line 2 as the card said: line 2 keeps the facts.

## Safety
- Removing a worktree from the dashboard moves its git-ignored scratch (`.mystical`,
  `.superpowers`) to the repo's `.mystical/archive/<worktree>/` first (`git.archive_scratch`).
- The route refuses to remove a worktree while a running turn works in it (`store.running_in`).
- A branch that never moved past its start commit is not landed, even when it looks merged
  (efas fix/EFA-298: made from origin/main, never committed to, 2 uncommitted files; the old tab
  offered Clean up).

## Pieces
- Bridge: `git.branch_status(cwd, targets)` (target, worked, clash), `git._made_from`,
  `git.merge_check(cwd, ours, theirs)`, `git.archive_scratch`; `prstatus.branch_prs` adds `base`
  and `title`, `prstatus.cached_bases` (open PRs, no gh call); `project_config.branch_targets` /
  `set_branch_target`; routes `GET /local/git/branchstatus` (+ `picks`), `POST
  /local/git/branch/target`, `POST /local/git/worktree/remove` (+ `archive`, running guard).
- Dashboard: `lib/branchrows` (shownRows, branchTree, nextStep with land, facts, landList,
  autoClean, prompts), `components/hud/useBranches` (one poll in App; auto clean-up),
  `BranchesPanel` (the tree, Land N list, drag, ⋯ items), `HudSettings.autoClean`.
- Mini App and bot: no BRANCHES tab there, nothing to add.

## Known limits
- A stacked branch merged into a different branch than it was cut from (apex sheet-pages: cut from
  v3-pins, merged into furkan-videos) reads as unlanded against its maker. Target ▸ fixes it.
- The dry run is capped at 12 branches per read; the rest show no readiness.
