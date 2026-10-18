# GIT tab readout: the tab is git's only home, and its push is a real button

**Ask (2026-10-18):** "remove git icon from header, we will go with git tab only and
enhance its push button, better status displaying and stuff". Designed with
`/design-first`. The user picked **C · READOUT** from three layouts (drafts in Claude
Design `drafts/git-tab-v2/`, mockups in `.mystical/design-drafts/git-tab-v2/`).

## What changed

- **Header:** the git icon and its popover (`hud/GitPopover`) are gone. The cluster is
  clock · weather · bell.
- **GIT tab header:** `GIT` · `⎇ branch` · ⟳. The `↑n`/`↓n` chips left. ⟳ now runs
  `git fetch` (`POST /local/git/fetch`) and then re-reads, so behind is as of now. It
  spins while it works.
- **Readout** under the header, above both folds: three cells, **TO PUSH** (or **TO
  PUBLISH**), **TO PULL** and **CHANGED**. Zeros dim, and "—" marks a count that can't
  exist (no upstream). The cell the action acts on carries the accent wash. On a
  diverged branch both counts go amber.
- **Sub-line:** where the branch stands and how fresh that is: `origin/master · checked
  4m ago`, `✓ up to date with origin/master · …`, `diverged from …`, `not on origin yet
  · only in this checkout`, `no remote · …`, `detached HEAD · …`. "checked" is the
  newest `FETCH_HEAD` across the repo's checkouts (`status().fetched_at`). FETCH_HEAD is
  per worktree, but the remote refs it moves are shared.
- **The one move** the state allows, as the panel's only solid button (agents commit,
  you push):

  | state | button |
  |---|---|
  | ahead | **PUSH n COMMITS** |
  | behind | **PULL n COMMITS** (ff-only, as before) |
  | never pushed, with commits of its own | **PUBLISH BRANCH** (`push -u origin HEAD`, as before) |
  | diverged | a sentence on why neither works, then tinted **HANDLE IN A NEW SESSION**, with a merge draft (`divergedDraft`) |
  | up to date, no origin, detached | none |

- **Feedback** stays in that slot. While a push or pull runs, the button holds a spinner
  and a 2px bar runs along the readout's foot. A success shows a green line ("Pushed 3
  commits to origin/master") for 4s. A failure shows git's own words in a red block
  (× dismisses it) with retry. A refused push or publish also offers HANDLE IN A NEW
  SESSION (`pushFailedDraft`, which now names the real branch). Push results no longer
  land under the commit box.
- **Rail badge:** the changed count as before. On a clean tree it now says what the
  header's dot used to: `↑n`, `↓n`, `↑↓`, or `↑n` for unpublished commits. A fresh
  branch with nothing of its own gets no badge.

## Where

- `bridge/git.py`: `status()` adds `fetched_at` and, only while there is no upstream,
  `unpublished`, the count of `HEAD --not --remotes` (null when there is no origin).
  `fetch()` returns `(ok, output)` like push/pull.
- `bridge/dashboard/server.py`: `POST /local/git/fetch`.
- `lib/gitsync.ts` (+ `gitsync.check.ts`): `syncOf(git)` → the state, and
  `syncBadge(state)` → the rail text.
- `lib/pushfailed.ts`: `divergedDraft`.
- `hud/GitPanel.tsx`: the readout and the op state. `App.tsx`: `handOffSession`, the
  rail badge, and the popover removed. `Strip.tsx` loses its `git` slot.
  `GitPopover.tsx` is deleted.
- `index.css`: `.gp-rd` / `.gp-ro*` / `.gp-pb` / `.gp-fail` / `.gp-done` in the GIT TAB
  section (FLINT idiom with HUD fallbacks, so AURORA stays square).

## Left out

- No auto-fetch: the bridge never fetches on its own, only on ⟳.
- No list of the commits a push sends. That was variant A; the graph's hollow dots
  still mark them.
- Until the bridge restarts after this lands, an old backend sends no `fetched_at`, so ⟳
  falls back to a plain re-read and an unpublished branch shows no PUBLISH button.
