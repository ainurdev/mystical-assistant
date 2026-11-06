# GIT tab, diverged branch: merge in the tab, push is your choice

**Ask (2026-11-07):** "if we pull from button it will force to push next in prompt, fix it,
provide both options, maybe change its ui to something more meaningful and handling in git tab".
Designed with `/design-first`. The user picked **B · FORK** from three looks (mockups in
`.mystical/design-drafts/git-diverged/`, UX pattern `git-diverged-merge-choice`), and asked
that every case be handled "without confusion and with freedom to user".

**Before:** on a diverged branch the hero's **Pull N** didn't pull. It opened a session whose
draft ended "…re-run the checks, then push", and the readout repeated that with a note and
**Handle in a new session**.

## Behaviour
- **Merge runs in the tab** (`POST /local/git/merge-upstream`, `git.merge_upstream`). It makes a
  merge commit, never a rebase, so the branch's commits keep their shas.
- **Two choices.** **Merge N** stops after the merge: the hero's next hop becomes
  **Publish N+1**, a separate press. **Merge & push** merges, then pushes.
- **Dry run first.** `git merge-tree --write-tree` (`git.merge_check`) touches no file, index or ref.
  The hero's line says "Merges cleanly", "N files clash" or "Couldn't test the merge first".
  `GET /local/git/incoming` returns it together with origin's commits.
- **Clash:** nothing on disk changes. Both buttons turn into session hand-offs (pen icon).
  `divergedDraft(…, { push })` ends with the push only for Merge & push; Merge's draft says
  "Then stop: don't push". A clash the dry run missed (a race) is aborted at once, and its
  files come back the same way.
- **Uncommitted edits:** Commit stays first. Merge stays pressable (the user asked for freedom),
  and git refuses before starting if an edit is in the way. Without a dry run (git < 2.38) the
  server won't merge over edits, since `merge --abort` can't always give them back.
- **A refused push fetches.** The usual cause is origin moving on, so the hero turns into the
  fork and offers the merge.
- **COMING IN** lists origin's commits whenever origin is ahead, including a plain behind
  (amber rows; WAITING TO SHIP already lists yours).

## Where
`bridge/git.py` (`merge_check`, `merge_upstream`, `_commits` adds `ts`) · `bridge/dashboard/server.py`
(two routes) · `api.ts` (`gitIncoming`, `gitMergeUpstream`) · `lib/gitpipe.ts` (diverged: Merge +
`alt`) · `lib/pushfailed.ts` · `hud/GitTracker.tsx` (the fork, the check line) · `hud/GitPanel.tsx`
(merge flow, clash block, COMING IN) · `index.css` (`gt-fork`, `gt-chk`, `gp-clash`).
Tests: `tests/test_git.py`, `gitpipe.check.ts`, `pushfailed.check.ts`.
