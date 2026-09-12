# Analyze-modal branch selector

The Analyze modal currently revolves around the **checked-out** branch
(`git.branch`): Overview groups sessions by every branch and merges each worktree
→ default; Changes compares the current branch against a picked one (or shows the
working tree with commit/push).

This change introduces two modal-level branch values that apply across all tabs:

- **`selectedBranch`** (source) — chosen in a new header dropdown. Defaults to the
  checked-out branch. **View-only**: switching it never runs `git checkout`; it
  only changes what the modal shows.
- **`destBranch`** (destination/target) — defaults to the repo default branch.
  Chosen in the merge panel and the Changes tab; both read/write the same value.

Everything is framed as **`selectedBranch` → `destBranch`**.

## What already exists (verified)

- **Backend needs no changes.** `api.merge(project, branch, into)` checks out
  `into` (server-side) then merges `branch` into it (`server.py` `/local/git/merge`).
  `api.compare(project, base, head, dots)` returns commit count + files + ±, 2-dot
  (tip-to-tip) or 3-dot (merge-base). `api.branches(project)` returns
  `{ branches, current, default }`. `api.gitDiff(project, path, base, head)` gives
  per-file diff between two refs.
- **Sessions already map to a branch**: `worktrees.find(w => w.path === s.cwd)
  ?.branch`, falling back to the checked-out branch for main-dir sessions
  (`AnalyzeModal` `OverviewTab.groups`).
- **No frontend test harness** (vite + `tsc` only). Verification is `tsc -b`
  (typecheck) + `vite build` + visual check, not unit tests.
- This is a **single-file change** to
  `bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx`, plus removing the now
  unused `onCommit` prop from its one call site in `App.tsx`.

## 1. Modal-level state + header selector

`AnalyzeModal` gains two state values lifted above the tabs:

- `selectedBranch` — init to `git?.branch || badge?.branch`. Re-synced when git
  loads.
- `destBranch` — init to `defaultBranch`; if that equals `selectedBranch`, fall
  back to the first other branch (so a comparison is meaningful).

The header's static `⎇ {branch}` chip becomes a **branch dropdown** listing all
branches, marking the checked-out one as `HEAD`. Selecting a branch only updates
`selectedBranch`.

`selectedBranch`/`destBranch` and a `setTab` handle are passed to the Overview and
Changes tabs.

## 2. Overview tab

**Left — Sessions.** Replace the group-by-every-branch layout with a flat list of
**only the sessions on `selectedBranch`** (same cwd→worktree→branch mapping, then
filter). Empty state when none. `+ NEW` creates a session on `selectedBranch`:
attach to its worktree (`onWorktreeSession(project, selectedBranch, false)`) when
one exists, else `onNewSession(project)` (main checkout).

**Right — Merge panel (new, top).** `MERGE {selectedBranch} → [dest dropdown]`,
with diff stats from `compare(destBranch, selectedBranch, 2)` — same call the
Changes tab uses, so the numbers match (commits · files · +/−) — a **MERGE** button (`api.merge(project, selectedBranch, destBranch)`), and a
**VIEW CHANGES →** button that calls `setTab("changes")` (destination already
shared). Both disabled when `selectedBranch === destBranch`.

**Right — Worktrees.** Kept for management (checkout / attach / new / remove). The
per-worktree `MERGE → default` button is **removed** — merge is centralized in the
panel above.

**Right — PR.** Kept. `head = selectedBranch`, `base = destBranch` (shares the
destination value with the merge panel).

## 3. Changes tab — comparison only

Read-only diff of **`selectedBranch` ↔ `destBranch`**:

- A destination dropdown at the top (writes the shared `destBranch`).
- File list from `compare(destBranch, selectedBranch, 2)` (tip-to-tip, no backend
  change); per-file diff from `gitDiff(project, path, destBranch, selectedBranch)`
  — direction shows what `selectedBranch` carries relative to `destBranch` (the
  merge preview).
- **Removed**: the working-tree view, commit message box, GEN, COMMIT ALL, PUSH.
  Committing/pushing is no longer available in this modal (done via chat/terminal).
  The `onCommit` prop is removed from `AnalyzeModal` and its `App.tsx` call site.

## 4. Issues / Logs

Unaffected — repo/server-global, not branch-scoped.

## Edge cases

- `selectedBranch === destBranch` → merge + compare disabled with a hint.
- `selectedBranch` with no worktree and not the checked-out branch → its session
  list is empty (those sessions live in worktrees); show the empty state.
- Single-branch repo → dropdowns show one entry; merge/compare disabled.

## Verification

- `npx tsc -b` passes (no type errors).
- `npm run build` succeeds.
- Visual: header dropdown switches the session list and compare base; merge panel
  shows stats and VIEW CHANGES jumps to a correctly-scoped Changes tab.
