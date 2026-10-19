# Rivendell: a task for every piece of work

## Why

Sessions in repos that belong to a Rivendell project often do work that no
Rivendell task covers: a fix found on the way, a request made in chat. That work
leaves no record on the board, so nobody can see what was done beyond the
planned tasks. The user wants every piece of work in a Rivendell project tied to
a task. When no task covers it, a task gets created (after asking) and the work
gets linked to it.

## What the user decided

- **Ask first.** When no open task covers the work, the session asks with one
  card (*Create "Fix login redirect" on NR Chatbot & Complaints ▸ Inbox?*,
  Create / Skip) and creates the task only on yes.
- **Created tasks carry a tag**, and the tag's name doesn't mention "scope".
  The name is `unplanned`. I proposed it in the playback, and the user
  approved that playback.
- **The design as played back in chat** was approved with "lets go" on
  2026-10-19. That covers the parts below that are not marked as my call.

## Goals

1. A session that is about to change code in a repo on a Rivendell board checks
   the repo's open tasks first.
2. If a task covers the work, the work carries its key: in the branch name and
   in the PR title. Rivendell already links a PR to a task when the PR's title,
   body or branch has the key (`work-graph-detector.service.ts`). Every GitHub
   webhook triggers the repo sync that runs that link, so the link appears
   within moments of the PR opening.
3. If none does, one card asks. On yes the task is created on that board, tagged
   `unplanned`, and its key is used the same way.
4. WORK ON IT (RIVENDELL tab) prompts carry the same key line, so work started
   from an existing task links too.

## Non-goals

- No change to Rivendell. Everything goes through routes it already has, called
  through its MCP's `read_route` / `write_route` with the bridge's own token
  (the same path `rivendell.link_repo` uses).
- No Mystical UI for the session↔task link (no chip, no RIVENDELL-tab
  "worked in" marker). The key on the branch is the record, as with
  trackers (`issuebranch.ts` `branchForTask`).
- No assignee, column, estimate or due date on created tasks. Rivendell records
  who created a task. New tasks land in the board's Backlog column.
- No task for questions, reviews or research. Only work that changes code.
- Work committed straight to a branch with no PR is not linked. Rivendell links
  PRs only. The key still goes in the commit message for people to read.
- Telegram-bot runs get nothing; they have no goals server.
- **Rivendell's own job runs get neither the note nor the tools** (my call,
  from the builder check). These are sessions whose origin starts with
  `rivendell`: reviews, IMPLEMENT, todolists, changelogs, decks, video. They do
  get the goals server today, because `_start_run` passes `skip_pack=False` for
  everything except meeting notes. But they run unattended in
  bypassPermissions, so nobody is there to answer the card. IMPLEMENT already
  links its PR through its own template, and a todolist's RECOMMENDATIONS step
  proposes tasks in JSON, so it must not create any.

## How it works

### 1. A note for sessions in a repo on a board (`bridge/runner.py`)

An interactive run gets the goals server. Its appended system prompt gets a
fixed note when all of these hold: its working directory is a git checkout
whose Rivendell project has a task board, the `rvtrack` switch is on, and the
session's origin isn't `rivendell…`. The note (wording is the builder's; content below). The note's text
never varies, so it can't churn the prompt cache. Whether a session gets it is
decided at the session's first run and memoized per claude session id for the
bridge process's life, the same idea as `_packed_sessions`. A board linked
later, or a Rivendell that is down at that moment, never re-writes a running
session's appended prompt. The note goes in every turn, not only the first.
`--append-system-prompt` is sent on every spawn, so a note sent once would be
gone by turn 2.

The note says:
- Before changing code for a piece of work, call
  `mcp__goals__ListRivendellTasks`. It's a deferred tool, so load it with
  ToolSearch first.
- If an open task covers the work, put its key in the branch name (keep the
  repo's own branch convention, e.g. `fix/NRA-61-login-redirect`) and in the PR
  title.
- If none does, ask the user with one AskUserQuestion card whether to create
  one, naming the board and list the tool reports. On yes, call
  `mcp__goals__CreateRivendellTask` and use the new key the same way. On Skip,
  don't ask again for that work.
- Do this once per piece of work, again for each new piece in the same session.
  Questions, reviews and research need none.

**"Has a board"** means Rivendell's `/plugin/tasks?repository=<slug>`
answer has a non-empty `projects` list. It names only projects that have a
board the token's owner can read (`plugin-tasks.service.ts`). Every remote's
slug is tried, origin first, until one names a project. The live check
(2026-10-19) showed why origin alone isn't enough. Rivendell matches a repo or
its registered mirror, but an NR checkout's origin is the `ainurdev` copy that
Rivendell doesn't know, and only its `nr` remote names the upstream the project
links (`nationalerijschool/apex`). `projectmarks` matches on every remote for
the same reason. Each running worker's cached last answer
(`Worker._last_tasks[slug]`) is used when present. Otherwise the fetches run,
and the spawn waits at most 2 s for them (a thread joined with a
timeout, like `trackers.tasks(rel, wait=2.0)`). On a timeout or any error
there is no note. The finished fetch still fills the cache for the next
session.

### 2. Two tools on the goals server (`bridge/goal_mcp.py`)

The goals server is spawned for every interactive run. It gains two tools. It
lists them only when three things hold: a Rivendell connection is configured
(`rivendell_instances`), the `rvtrack` switch is on, and the session's origin
isn't `rivendell…`. A bridge with no Rivendell never shows them. Both call the
bridge over the dashboard's localhost API, as `WaitForSession` does, and
return text. The route refuses `rivendell…` sessions too.

- `ListRivendellTasks {repo?}` returns the boards this repo's work can go on,
  each with the list a new task would land in, and then the open tasks (key,
  title, column, "yours"). It ends with the one-line rule: carry the key if a
  task covers the work, otherwise ask before creating one.
- `CreateRivendellTask {title, description?, board?, repo?}` creates the task
  and returns its key, board, list and Rivendell URL, plus the line about
  carrying the key. `board` (a name) is needed only when the repo is on more
  than one board. Without it the answer names the boards and asks to call
  again.

`repo` is a path. When it's left out, the session's own directory is used: its
worktree cwd if it moved into one, else its project. The agent passes `repo`
when it works in a different checkout, e.g. a session started in a folder that
holds several repos.

### 3. The bridge side (`bridge/dashboard/server.py`, `bridge/rivendell.py`)

`POST /local/rivendell/work` with `{claude_session_id, action: "list" | "create",
repo?, title?, description?, board?}` returns `{text}`. Like `/local/wait`, it
resolves the session by claude session id and checks its chat, and every answer
is text for Claude, refusals included. `repo` must resolve inside BASE_PATH
(`_abs_within`). With no `repo`, the directory is `_abs_within(session.cwd)` or
`_abs_project(session.project)`.

`rivendell.py` does the Rivendell calls, through `tasks(slug)` and `_tool`:
- **Boards:** for each project `tasks(slug)` names (with its instance), call
  `read_route /projects/<id>` and take its `teamworkProjects`, dropping
  `missing`. Dedupe by board id. Label with the instance name when more than
  one connection answers.
- **List a new task lands in:** `read_route
  /task-management/projects/<board>/tasklists`. Use the first named `Inbox`,
  then `Unorganized` (case-insensitive), else the first list (my call).
- **Tag:** `read_route /task-management/tags` and match `unplanned` without
  regard to case. If it's missing, `write_route POST /task-management/tags
  {"name": "unplanned"}` (account-wide), then re-read once if that call fails,
  since another session may have just made it. If there's still no tag, create
  the task untagged and say so. A tracked task beats a perfect one.
- **Create:** `write_route POST /task-management/tasks {tasklistId, name,
  description, tagExternalIds}`. It answers with the task, including its `key`.
  Since Rivendell aa6f81b9 (2026-10-15), board edits land only in Rivendell's
  own tables, so the task, and a tag made here, live in Rivendell and not in
  Teamwork. The task's `htmlUrl` may be null, so the answer gives the
  Rivendell URL.
- **URL:** the same shape Rivendell's own `taskUrl` builds,
  `<frontend>/task-management/projects/<board>?task=<id>`. `<frontend>` comes
  from a project url in the `/plugin/tasks` answer (`<frontend>/projects/<id>`).

Errors use the existing `TasksError` lines ("Rivendell refused the token", the
route's own message). The tools pass them on as text.

### 4. WORK ON IT (`bridge/dashboard/web/src/lib/rivendelltasks.ts`)

`workPrompt` adds one line when the task has a key: carry it in the branch name
and the PR title, so Rivendell links the PR to the task. `RivendellTask` in
`api.ts` gains `key: string | null`, which `/plugin/tasks` already sends.

## Who gets it

Every Mystical bridge with a Rivendell connection, teammates included, once it
updates. That was in the playback the user approved.

**It also gets a switch** (my call, from the builder check), because the note is
a per-run prompt and this codebase registers every one in `bridge/aifeatures.py`
(`test_the_registry_covers_every_model_call_the_bridge_makes`). The registry
entry is `rvtrack`, env `RIVENDELL_TRACK`, and it ships ON, as `TASKS_DIGEST`
does. The AI tab's extras grid (`SkillsFold.tsx` `ExtrasGrid`) renders every
entry, so the switch needs no frontend code. Off means no note and no tools.
That gives a teammate who doesn't want the cards a way out without a code
change.

**Known limit:** the tag is found by name. If someone renames `unplanned` in
Rivendell, the next create makes a new `unplanned` tag.

## Testing

- `tests/test_rivendell.py`: board resolution (dedupe, missing boards dropped),
  list choice (Inbox → Unorganized → first), tag found / created / re-read /
  untagged, the create body, the URL, more than one board with and without
  `board`, and no board. Use fake `_api` answers, as the existing
  `link_repo` tests do.
- `tests/test_rivendell_tasks_endpoint.py` (or a sibling): the route resolves
  the session's directory, refuses a `repo` outside BASE_PATH, and checks the
  chat.
- `tests/test_goals.py` (or a sibling): the two tools are listed only with a
  Rivendell connection, the switch on, and a session that isn't from
  Rivendell. They relay to the route.
- The runner: the note appears for a repo with a board, and not for a repo
  without one, a Rivendell-origin session or the switch off. It stays the same
  for a session even when the board answer changes between runs.
- `tests/test_aifeatures.py`: `rvtrack` is in the registry and ships `"1"`.
- `lib/rivendelltasks.check.ts`: the key line in `workPrompt`.
- A live read-only check against the real Rivendell: list for `apex`. Creating
  a real task is left to the user's first real use, because it writes to a
  client's Teamwork.

## Left to the builder

The note's exact wording, the tool descriptions, and the text layout of the
tool answers.
