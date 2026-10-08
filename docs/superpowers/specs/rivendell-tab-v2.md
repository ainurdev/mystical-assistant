# RIVENDELL tab v2: quiet cards, read before you run, two ways to start (design)

2026-10-07 · picked in chat: layout **B · quiet cards**, scope **★ first build**
· mockups in `.mystical/design-drafts/rivendell-tab-v2/` (git-ignored) and in
Claude Design at `drafts/rivendell-tab-v2/` · supersedes the card layout of
`rivendell-tasks-tab.md`; the run states from `rivendell-channel.md` stay

## Problem

With real data the tab was mostly buttons. IB Groups had 8 open tasks, nobody
assigned and no due dates, all in To do. Every card was a title, the words
"To do" and the same violet IMPLEMENT, and 7 of the 8 fit on screen. To learn
what a task asked for, you had to leave the dashboard: T26's description only
says "the spec stays in GitHub #43".

## What changed

- **Quiet cards.** A card at rest shows the task code on its own mono line
  (pulled from a `T26 — ` title prefix), the title in up to 2 lines, and a small
  ▶. Under the pointer the ▶ grows into ▶ IMPLEMENT, over the end of the
  title, so the title never re-wraps. The meta line shows only assignees, due
  date, and the column when the list spans more than one column.
- **Groups by what a task needs from you:** NEEDS YOU, then RUNNING (queued or
  running), then DONE, then YOURS, TEAM and LATER. A failed run stays in
  YOURS/TEAM, next to its RETRY.
- **LATER.** Titles with the team's `⏸ (deferred to …)` marker fold into a
  collapsible LATER group, which remembers whether it is open
  (`mystical:rivendell-later`). The marker is a title convention, not data; a
  Teamwork tag would be the real signal.
- **The peek.** A click opens the card in place and shows the task's
  description. When the description points at a GitHub issue, the peek shows
  that issue's opening lines instead. Below it: tasklist, author and date,
  estimate, tags, then IMPLEMENT · WORK ON IT · ↗.
- **IMPLEMENT asks inline** and replaces the old `askConfirm` dialog. It says
  RUNS ON ITS OWN · NO PERMISSION PROMPTS · PUSHES A BRANCH · OPENS A PR, takes
  an optional note, and offers START RUN (Ctrl+Enter) or CANCEL. RUN AGAIN and
  RETRY ask the same way.
- **WORK ON IT** opens a new session in this repo with the task already in the
  composer, unsent: its title, spec link and tracker links, or the description
  when there is no spec. Rivendell doesn't track that session.
- **NEXT UP.** Rivendell's prioritized todolist for the project heads the list:
  its first 3 open items. An item linked to one open task gets ▶, which opens
  and arms that task's card. An item linked to several says N TASKS ›. An item
  with a Sentry issue gets FIX IT, which does WORK ON IT with the issue. The
  todolist is read once per mount and on ⟳.

## Where the data comes from

| need | source |
|---|---|
| the peek | `GET /local/rivendell/task` → `rivendell.task_detail`: Rivendell's `/mcp` `get_task` with the bridge's own token (same `ApiTokenAuthGuard` + LLM capability as `/plugin/*`, checked live), plus `github.issue_spec` (`gh issue view` on the first issue link, opening only) |
| NEXT UP | `GET /local/rivendell/todolist` → `rivendell.todolist`: `/mcp` `get_todolist(projectId)`, open items with their TASK / SENTRY_ISSUE links. TASK link ids are `/plugin/tasks` ids (checked live) |
| the note | `POST /local/rivendell/implement {note}` → `rivendell.implement` keeps it in memory, under the worker's `_notes_lock`, and `_run_implementation` appends it to Rivendell's prompt when the job arrives. Rivendell's `customPrompt` is not used: it **replaces** the managed template. ponytail: a restart between the click and the claim drops the note, and so does a job claimed by another of the owner's bridges |

None of it needs a Rivendell change.

## Verified

- Tests: `tests/test_rivendell.py` covers task_detail, todolist and the note;
  `test_rivendell_tasks_endpoint.py` covers the routes;
  `test_github_checks.py` covers issue_spec and its opening. The full suite
  passes. `lib/rivendelltasks.check.ts` covers grouping, splitTitle, nextUp and
  the prompts.
- UI: a worktree build behind a read-only probe (the new GETs answered by the
  worktree code with real Rivendell and GitHub data, every POST refused), in
  STUDIO at 340px. Checked: rest, hover, peek (T26 shows #43), inline confirm
  with a note, LATER folded, NEXT UP on the rivendell repo with its jump-and-arm,
  WORK ON IT's prefilled composer, and the busy states (stub runs).

## Not in this

Tags on rows from the list itself (needs `tags`/`tasklistName` on
`/plugin/tasks`, a Rivendell PR), MARK DONE after a merge, filing a task from
chat, IMPLEMENT ALL, a kanban, a Mini App/bot surface, a MINE/TEAM toggle.
