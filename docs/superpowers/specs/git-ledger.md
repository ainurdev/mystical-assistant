# GIT tab: the ledger

`/design-first let reimagine new git tab` (2026-11-11). Replaces the DELIVERY TRACKER hero.
UX pattern `git-tab-ledger`; mockups in `.mystical/design-drafts/git-reimagine/` (A · LEDGER picked over B · ROUTE and C · DOCK).

## Decided before drawing
- Commit and Push stay two presses. No one-press Ship (the user's pick, against the recommendation).
- The tab opens the pull request and then shows its checks.
- One line says how the branch stands against its base. The base is a menu (master, staging, any branch), kept per branch: it is BRANCHES' Target (`project_config.branch_targets`), then the PR's base, then the default branch.
- History is commits that open in place to their files. The graph stays behind a link.

## What it is
One line read downward (`hud/GitPanel.tsx`, styles `GIT LEDGER` in index.css):
1. **Not committed**: files, stage/discard, the commit box.
2. **Only on this Mac**: what a push sends (hollow dots), with Push N / Publish N.
3. **On origin, not here** (behind or diverged, amber): Pull N, or Merge / Merge & push with the dry run's line.
4. Marker: **origin is here**, and how fresh the fetch is.
5. **Not in `<base>` yet**: commits origin has that the base lacks; Open PR (title and body prefilled from the commits), or the open PR with its checks and Send failure to chat.
6. Marker: **the base**, a menu; `moved N` + Update when the base moved.

## Backend
- `git.ledger(cwd, base)`, `git.base_ref`, `git.undo_commit`; `merge_upstream(cwd, theirs)` now takes the ref to merge.
- `GET /local/git/ledger`, `POST /local/git/update-base`, `POST /local/git/undo-commit`.
- Update is a merge commit, never a rebase; a clash changes nothing and goes to a new session as an unsent draft.
- Undo is `reset --soft HEAD~1`, only for a plain commit origin doesn't have.

## Deviations from the mockup
- No "Open diff" button: a file in an opened commit shows its diff under it.
- The diverged FORK drawing went; its two buttons and dry-run line live in the amber stretch.
- A stretch shows 6 commits, then "Show all"; past the 30 the route returns it points at the graph.

## Not built
- Reviewers in the PR card, merging a PR from the tab.
- Undo is offered on a merge commit too and the bridge refuses it with a sentence.
