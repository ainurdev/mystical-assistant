# GIT tab — the changes and the graph in one rail tab

**Ask (2026-10-18):** "merge graph git into changes tab and tab will be git tab with
listing changes like now and vscode like collapse for git graph, redesign git tab as
well, cool and readable and useful."

**Scope:** the right rail's CHANGED FILES tab (`FilesPanel` in `changedOnly` mode) and
SOURCE CONTROL tab (`GitTab` → `CommitGraph`) become one **GIT** tab. Dashboard only;
the Mini App has no graph. Drawn in the user's theme, FLINT VIOLET, at the rail's real
size in Mystical.app (299px body + 48px rail at 1496px wide).

## What's wrong today (`.mystical/design-drafts/git-tab/_probe/before-*.png`)

- Two rail tabs for one thing, and the graph tab has **no header at all**: no branch,
  no refresh, no sha, no author.
- Ref chips come **before** the subject, so a row carrying `main` and `origin/main`
  shows five characters of its message (`Merg…`).
- CHANGES rows are full paths truncated from the left, with the status letter as the
  only figure. The `+N −N` line counts the API already sends are never shown.
- PUSH lives in the commit box, there is no PULL, and nothing says how far ahead or
  behind the branch is, although `GitStatus` carries `ahead`, `behind`, `upstream`.
- Commit buttons are tracked uppercase HUD mono inside a FLINT panel.

## The design

One panel, VS Code's Source Control shape: a repo header, then two **folds** (pane
headers with a chevron) that collapse by a click on their head.

### Header (36px)
`GIT` · a branch pill `⎇ master` (purple, mono, truncates at 132px, full name on hover)
· a **sync chip** · `⟳` refresh (re-reads status and log).
The sync chip reads the status: `↑7` = push 7 commits (the PUSH action, moved here from
the commit box); `↓85` = pull (new: `api.gitPull` exists, nothing else to build); both
when diverged; a quiet `✓ synced` when in step; `↑ push` with no count when the branch
has no upstream. Git's refusal still lands under the commit box, with HANDLE IN A NEW
SESSION, as today.

### Folds
- `▾ CHANGES 3` — head actions `+` stage all, `⋯` (the list's "all" actions: stage all,
  unstage all, discard all — today only in the right-click menu).
- `▾ GRAPH` — head action: the filter `all branches ▾` / `this branch` (the log endpoint
  already takes `branch`).
- Open/closed is remembered per fold (`useStickyFlag`, lib/prefs.ts). Both open:
  CHANGES takes its content height up to half the panel, GRAPH takes the rest; each
  scrolls on its own. CHANGES closed: GRAPH takes everything (card B). GRAPH closed: its
  head sits at the panel's foot and CHANGES takes everything (card D). No draggable
  sash in v1.
- Head: 28px, panel2 ground, hairlines above and below, Geist 600 10.5px uppercase
  tracked .08em, count in mono, chevron 12px.

### CHANGES fold
- The commit box: textarea with the placeholder **"Message (⌘↵ to commit on master)"**,
  then one row: `✧ GENERATE` (ghost, hidden while commit messages are off) and the
  primary `▸ COMMIT STAGED (1)` / `▸ COMMIT ALL (3)` (same label rule as today). The
  buttons are Geist 600, FLINT radius; the primary is acc 16% with an acc 60% edge.
- Groups `STAGED 1 −` and `UNSTAGED 2 +` only when the index holds something;
  otherwise the rows sit flat under the fold (the fold's count is the group).
- A row (24px): file icon · **filename** bright mono · the directory dim, truncated
  from the left so the nearest folder survives · `+18 −4` (ok/err at 80%) · the status
  letter, bold, in its colour (M warn, A/U ok, D err, R info). Untracked reads `U`,
  not `?`.
- Hover (card D): the figures give way to `◫ open changes` · `+ stage` (or `− unstage`
  in STAGED) · `↺ discard`. The right-click menu stays as it is.
- Empty: "Working tree clean." under a disabled box (card C).

### GRAPH fold
- Rails as today (lib/gitgraph lanes, lane colours acc/purple/warn/info/ok/err, gutter
  capped near 48px), but every row puts the **subject first**, in Geist 11.5px bright,
  with the age in mono at the right edge. A row with refs grows to 46px and carries its
  chips on a **second line**, so the message never pays for them. Two chips, then `+N`.
- Chips: `⎇ branch` (local, hairline), `☁ origin/x` (remote, dashed), `◇ v0.9.0`
  (tag, warn). HEAD's chip is accent-filled and carries the ahead/behind count:
  `⎇ master ↑7`, `⎇ main ↓85`. The HEAD row's subject is 500 weight.
- Dots: filled = on the remote; **hollow = not pushed yet** (HEAD's first parents down
  to the row carrying the upstream ref — a client-side walk, no backend change); HEAD
  = filled with a ring.
- Click a row (card B): a card hangs off the row's lane (its colour as the left rule),
  with `sha · author · date` and a copy button, then the commit's files as rows like
  CHANGES' (`+9 −4`, mark); click a file for its diff inline (hunk header info, added
  ok, removed err), as today but on panel3 inside a rounded block.
- `LOAD OLDER COMMITS` at the foot of the list, ghost, full width.

### The rail
One icon (lucide `GitBranch`), label "Git", the dirty count as its badge. The
`FileDiff` tab goes. A saved `rightTab: "changes"` maps to `git`.

## Cards

| | file | shows |
|---|---|---|
| A | `.mystical/design-drafts/git-tab/01-default.html` | both folds open: a staged file and two unstaged, a generated message, the graph with HEAD, 7 unpushed rows, a merge, `origin/master`, a tag |
| B | `.mystical/design-drafts/git-tab/02-commit-open.html` | CHANGES folded, a commit opened with its files and one diff, LOAD OLDER COMMITS |
| C | `.mystical/design-drafts/git-tab/03-clean-behind.html` | clean tree, `↓85` to pull, remote-first graph with HEAD lower down |
| D | `.mystical/design-drafts/git-tab/04-hover-pushfail.html` | row actions on hover, git's push refusal + HANDLE IN A NEW SESSION, GRAPH folded to the foot, diverged `↑7 ↓3` |

## Implementation sketch (after approval)

- `App.tsx`: one rail tab `git` (`GitBranch`, label "Git", `ownScroll`, scope
  `worktree`, badge = dirty) rendering a new `hud/GitPanel.tsx`; the `changes` tab and
  `GitTab.tsx` go; `onReveal` and the settings migration point `rightTab` at `git`.
- `hud/GitPanel.tsx`: owns the status poll (`api.git`) for the header and the list,
  the two folds and their sticky state. The CHANGES fold is `FilesPanel`'s
  `changedOnly` half moved over (commit box, draft store, groups, rows, context menu,
  push-failed hand-off); `FilesPanel` keeps only the tree.
- `CommitGraph.tsx`: subject-first rows, two-line ref rows, chip kinds, HEAD ring,
  hollow unpushed (new `upstream` + `ahead/behind` props), the opened-commit card, the
  branch filter. `AnalyzeModal`'s history pane keeps using it unchanged.
- `lib/gitgraph.ts`: edges keep lane indices; their y becomes `0 | mid | h` resolved
  per row at render, so a 46px row draws its rails to its own bottom.
- `index.css`: a `.gitp` block in the FLINT idiom with HUD fallbacks (as `.aim` does),
  so AURORA and CLAUDE draw the same bones in their own skin.
- Verify: headless captures of the four states under FLINT VIOLET, then AURORA.

## Open questions

1. The PULL chip (`↓n`) — keep it? It is one existing endpoint, but it is a new action
   in the rail.
2. Hollow dots for unpushed commits — keep, or plain dots and only the `↑7` on the chip?
3. CHANGES capped at half the panel, no sash — fine for v1?
4. `U` for untracked instead of `?`.
