# The project window, split up

## Why

The session header's ⊞ PROJECT opened ANALYZE, a window over the whole dashboard
with a tab for everything about a repo. Most of it already had a second home (the
rail's FILES and GIT, SETTINGS ▸ AI management ▸ Skills), the button was a second
door to the window the project menu opens, and the window covered the chat. So the
button goes and each tab moves to where it is used. ISSUES, TASKS and the
Teamwork/Jira trackers went first (`f4aee69c`, `034126e1`). Design draft and the
approved states: `.mystical/design-drafts/project-split` (29 Oct 2026).

## Decisions

| Was | Now |
|---|---|
| ⊞ PROJECT in the header | Gone. In COMPACT CHAT the header pill held only it, so with no clock row there is no pill. |
| Opening a file | The rail's FILES. It gains a **find field**: typing swaps the tree for the paths that hold the text (`lib/filefind`: name before folder, shortest name first, git-ignored last). ↑/↓ and ↵ open one, esc clears. **⌘P / Ctrl+P** opens FILES and focuses it from anywhere, except over the editor window, whose Ctrl+P is its own Go to File. |
| WORKTREES tab | The rail's **BRANCHES** (`BranchesPanel`, `lib/branchrows`), status only: WORKTREES, BRANCHES (folded after 8), MERGED. A row: activity dot (working / waits on you), name, HERE / BASE / CHECKOUT, last commit's age, then ↑/↓ against the base, not pushed / ↑n to push / ✓ pushed, ●n uncommitted. No buttons; create, merge and delete are a sentence to Claude. One bridge call, `GET /local/git/branchstatus` (`git.branch_status`). |
| DESIGN tab | The rail's **DESIGN** (`DesignPanel` around the same `DesignTab`), while Claude Design is installed. The project menu's Design system and SETTINGS ▸ Projects ▸ Design system open it; for a repo that isn't the chat's, the panel shows that repo and names it in its header. |
| SKILLS tab | **SETTINGS ▸ Skills**, a page of its own after AI management, with a **Project** picker (starts on the chat's repo). AI management keeps the extras' switches as a fold renamed **Extras**. SETTINGS ▸ Projects ▸ a project has a **Skills** row (its count, Open… lands on the page with it picked). |
| MAP tab | **A switch per repo**, SETTINGS ▸ Projects ▸ **Project map**, under the machine-wide PROJECT MAP extra. Never flipped, it is on where `graphify-out/graph.json` already exists and off elsewhere. Build, refresh, injection, explain and `/map` all ask `graphmap.blocked_reason(cwd)`; the MAP chip and the window's MAP tab show only where both are on. Stored as `map: on|off` in `project_config.json`; a worktree follows its repo. |
| GIT, TERMINAL | Stay in the window, which now opens only for a file, a diff, RUN / a re-run, or the MAP chip: Editor · Git · Terminal (+ Map). |

## Not built

From the draft, left out at review: a drafts list in DESIGN (every
`.mystical/design-drafts/*` with thumbnails), and the BRANCHES row extras (the
Rivendell task and column, session counts, "no commits yet", draft counts, a
click that opens the branch's newest session).

Fixed on the way: `git.merged_branches` reported a detached checkout's
`(HEAD detached at …)` line as a merged branch.
