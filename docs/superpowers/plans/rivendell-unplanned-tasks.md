# Rivendell unplanned tasks: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A session that is about to change code in a repo on a Rivendell board
finds the task that covers the work, or asks and then files one tagged
`unplanned`. The work then carries that task's key, so Rivendell links its PR.

**Architecture:** `bridge/rivendell.py` gains the Rivendell side: board lookup,
landing list, tag and create, all through `tasks(slug)` and the MCP's
`read_route`/`write_route` with the bridge token. A new dashboard route
`POST /local/rivendell/work` exposes it to two new tools on the goals MCP
server. `bridge/runner.py` adds a fixed note to the appended system prompt of
sessions in a repo on a board. The note is decided once per session and gated
by the `rvtrack` AI switch. WORK ON IT's prompt gains the same key line.

**Tech Stack:** Python 3 stdlib (bridge), pytest, TypeScript (dashboard lib +
node strip-types check).

**Spec:** `docs/superpowers/specs/rivendell-unplanned-tasks.md`

## Global Constraints

- Backend is Python stdlib only. No new dependency anywhere.
- Tool names are exactly `ListRivendellTasks` and `CreateRivendellTask` on the
  goals server. In prompts they appear as `mcp__goals__ListRivendellTasks` and
  `mcp__goals__CreateRivendellTask`.
- The tag name is exactly `unplanned`, matched case-insensitively
  (`rivendell.UNPLANNED_TAG`).
- The AI switch is key `rvtrack`, env `RIVENDELL_TRACK`, and it ships `"1"`.
- The route is `POST /local/rivendell/work` with body `{claude_session_id,
  action: "list"|"create", repo?, title?, description?, board?}`. It answers
  `{"text": str}` always, refusals included.
- Rivendell is reached only through `tasks(slug)` and `_tool(w,
  "read_route"|"write_route", …)`. Nothing changes in the Rivendell repo.
- Sessions whose `origin` starts with `rivendell` get neither the note nor the
  tools.
- Task names are capped at 500 characters, Rivendell's `MaxLength`.
- Commits carry no `Co-Authored-By` line (the user's CLAUDE.md).
- Tests on this Mac run with `~/.cache/mystical-test-venv/bin/python -m pytest`.
  The 7 known macOS-only failures (clip_panel, map_command ×4, startup ×2) are
  not this change's.

## Review Focus

1. **A session working in a linked git worktree** (`.git` is a file, not a
   dir). The slug must still resolve, or every worktree session silently gets
   no note. Pinned in Task 1 (`test_repo_slug_reads_a_worktree_of_the_checkout`).
2. **Rivendell slow or hung at a session's first run.** The spawn waits at most
   `wait` seconds, then runs without the note. Pinned in Task 1
   (`test_on_board_gives_up_after_wait`).
3. **The same task filed twice** (a retried call, or two sessions on one
   piece of work). A create whose title matches an open task on that board
   returns the existing key instead of a duplicate on the client's board.
   Pinned in Task 1 (`test_work_create_refuses_a_title_an_open_task_has`).
4. **An over-long title.** It's cut to 500 characters rather than refused with
   a 400. Pinned in Task 1 (`test_work_create_cuts_a_long_title_to_500`).
5. **The switch turned off mid-session.** The next turn drops the note
   without asking Rivendell again. Pinned in Task 3
   (`test_switching_off_mid_session_drops_the_note_next_turn`).

---

### Task 1: The Rivendell side (`bridge/rivendell.py`)

**Files:**
- Modify: `bridge/rivendell.py`. Add a new section after `link_repo` (about
  line 2806), headed `# --- a task for every piece of work`.
- Test: `tests/test_rivendell.py`. Add a section at the end.

**Interfaces:**
- Consumes (existing): `tasks(slug) -> dict`, `_tool(w, name, args)`,
  `_worker(instance_id) -> Worker`, `TasksError`, `Worker._last_tasks`,
  `_workers`, `_manager_lock`.
- Produces:
  - `UNPLANNED_TAG = "unplanned"`
  - `_repo_slug(path: str) -> str | None` is the tab's rule,
    `github.origin_slug(path) or github.remote_slug(path)`, with a local
    `from bridge import github`.
  - `on_board(path: str, wait: float = 2.0) -> bool`
  - `work_list(path: str) -> str`
  - `work_create(path: str, title: str, description: str = "", board: str = "") -> str`
  - `_landing_list(rows: list) -> dict | None` takes a tasklists answer. It
    picks the first list named `inbox` (case-insensitive, trimmed), then
    `unorganized`, then the first row. Rows with no `id`, or with
    `completed` truthy, are skipped.

Behaviour the tests pin:
- `on_board` returns False when there's no slug or no running worker. If any
  running worker has `slug` in `_last_tasks`, it answers from those cached
  answers alone: True if any has a non-empty `projects`. Otherwise it runs
  `tasks(slug)` on a daemon thread, joins for `wait` seconds, and then answers
  from `_last_tasks`.
- Boards come from each project in the `tasks(slug)` answer, through
  `read_route /projects/<id>` → `teamworkProjects`. Drop `missing`, dedupe by
  (instance, `teamworkProjectId`), and label with `name`, or
  `"name (instance)"` when more than one instance answered. Each board keeps
  its `frontend`: the project's `url` up to `/projects/`.
- `work_list` text has: one line per board, `- <label> ▸ <landing list name>`;
  then the open tasks, `- <key> <name> · <column> · yours` (column and
  "yours" only when set, plus `· <projectName>` when there's more than one
  board, and "(last known)" on stale rows); then this exact last line:
  `If one of these covers your work, put its key in the branch name and the PR title. If none does, ask the user with one card before calling CreateRivendellTask.`
- The no-board text contains `isn't on a Rivendell task board`. The no-slug
  text contains `pass repo`. With no running instance, the text says no
  Rivendell connection is on. A `TasksError` anywhere becomes
  `Rivendell couldn't answer: <its line>`.
- `work_create`:
  1. An empty title means `title is required.`
  2. On more than one board, `board` must match one label
     (case-insensitive). Otherwise the answer lists the labels and nothing is
     written.
  3. A title equal to an open task's name on that board (case-insensitive,
     trimmed) returns `<key> already covers that: …` and nothing is written.
  4. Find or make the tag: re-read once if making it fails; if there's still
     none, go on untagged.
  5. `write_route POST /task-management/tasks` with body `{"tasklistId",
     "name": title[:500], "description"?, "tagExternalIds"?}` (keys only
     when they have a value).
  6. The text is `Created <key> "<name>" on <label> ▸ <list>, tagged unplanned: <frontend>/task-management/projects/<board>?task=<id>`,
     or `, untagged (Rivendell wouldn't make the unplanned tag)`, followed by
     `\nPut <key> in the branch name and the PR title, so Rivendell links the PR to it.`

- [ ] **Step 1: Write the failing tests**

Add a fake that answers both Rivendell paths:

```python
def _rv(tasks_answer, routes, calls):
    """/plugin/tasks answers `tasks_answer`; /mcp answers by (tool, path) as _routes does."""
    mcp = _routes(routes, calls)
    def api(path, payload=None):
        if path.startswith("/plugin/tasks"):
            calls.append(("plugin", path)); return json.loads(json.dumps(tasks_answer))
        return mcp(path, payload)
    return api
```

Fixtures: project `p1` at url `https://rv/projects/p1`. `/projects/p1` has
`teamworkProjects` `[{"teamworkProjectId": "b1", "name": "NR Chatbot & Complaints"}, {"teamworkProjectId": "b0", "name": "Old", "missing": True}]`.
The tasklists for `b1` are `[{"id": "l-fu", "name": "Follow-ups"}, {"id": "l-in", "name": "Inbox"}]`.
The open task is `{"id": "t61", "key": "NRA-61", "name": "Fix login redirect", "column": "In progress", "mine": True, "projectName": "NR Chatbot & Complaints"}`.
The tags are `[{"externalId": "tag-1", "name": "Unplanned"}]`. The create
answers `{"id": "t74", "key": "NRA-74", "name": "Add audit log"}`. Monkeypatch
`rivendell._repo_slug` to return `"acme/app"` everywhere except the worktree
test.

Tests and their key assertions:
- `test_repo_slug_reads_a_worktree_of_the_checkout`: a real `git init`
  repo in `tmp_path` with origin `git@github.com:acme/app.git`, one commit,
  then `git worktree add`. `rivendell._repo_slug(wt) == "acme/app"`.
- `test_on_board_uses_the_cached_answer_without_asking`: `w._last_tasks["acme/app"] = {"projects": [{"id": "p1"}]}`.
  `w._api` raises if called. `on_board("/x") is True`.
- `test_on_board_asks_once_when_nothing_is_cached`: True, and a second call
  adds no `("plugin", …)` call.
- `test_on_board_is_false_without_a_board`: `projects: []` gives False.
- `test_on_board_gives_up_after_wait`: monkeypatch `rivendell.tasks` to sleep
  1 s. `on_board("/x", wait=0.05) is False` within 0.5 s.
- `test_work_list_names_board_list_and_open_tasks`: the text contains
  `NR Chatbot & Complaints ▸ Inbox`, `NRA-61 Fix login redirect · In progress · yours`
  and the exact last line. It does not contain `Old`.
- `test_work_list_without_a_board_says_there_is_nothing_to_track_in`
- `test_work_list_without_a_github_remote_asks_for_repo`: `_repo_slug`
  gives None, and the text contains `pass repo`.
- `test_landing_list_prefers_inbox_then_unorganized_then_first`: three row
  shapes, plus a completed `Inbox` that is skipped.
- `test_work_create_files_a_tagged_task_on_the_inbox`: the last call is
  `("write_route", "POST", "/task-management/tasks", {"tasklistId": "l-in", "name": "Add audit log", "description": "Why.", "tagExternalIds": ["tag-1"]})`.
  The text contains `Created NRA-74`, `tagged unplanned` and
  `https://rv/task-management/projects/b1?task=t74`.
- `test_work_create_makes_the_tag_once_when_missing`: with tags `[]`,
  `write_route POST /task-management/tags {"name": "unplanned"}` answers
  `{"externalId": "tag-new"}`, and the task body carries `["tag-new"]`.
- `test_work_create_files_untagged_when_no_tag_can_be_had`: the tag POST
  answers an error string, the re-read is empty, the body has no
  `tagExternalIds`, and the text contains `untagged`.
- `test_work_create_on_two_boards_needs_board`: two boards and `board=""`
  give text naming both and no `write_route` call. With `board="elvou"` it
  creates on Elvou's list.
- `test_work_create_refuses_a_title_an_open_task_has`: the title
  `"fix login redirect "` gives text containing `NRA-61` and no
  `write_route` call.
- `test_work_create_cuts_a_long_title_to_500`: `len(body["name"]) == 500`.
- `test_work_create_reports_rivendells_refusal`: the create answers
  `"POST /task-management/tasks answered 403: Forbidden resource"`, and the
  text contains `403`.

- [ ] **Step 2: Run them, expect failures**

Run: `~/.cache/mystical-test-venv/bin/python -m pytest tests/test_rivendell.py -q -k "repo_slug or on_board or work_ or landing_list"`
Expected: FAIL (AttributeError: module 'bridge.rivendell' has no attribute …)

- [ ] **Step 3: Implement the Interfaces above in `bridge/rivendell.py`**

Write a module-docstring paragraph (house rule) saying why this lives here:
the bridge token and `tasks()` are already here, and the tools are only a
relay.

- [ ] **Step 4: Run them, expect PASS; then the whole file**

Run: `~/.cache/mystical-test-venv/bin/python -m pytest tests/test_rivendell.py -q`
Expected: all pass.

- [ ] **Step 5: Commit**

`git add bridge/rivendell.py tests/test_rivendell.py && git commit -m "rivendell: find the task behind a repo's work, or file one tagged unplanned"`

---

### Task 2: The route, the tools and the switch

**Files:**
- Modify: `bridge/config.py`. Add `RIVENDELL_TRACK = os.environ.get("RIVENDELL_TRACK", "1").lower() not in ("0", "false", "no", "")`
  next to `TASKS_DIGEST`, with a comment block in that section's style.
- Modify: `bridge/aifeatures.py`. Add a `FEATURES` entry after `tasks`:
  key `rvtrack`, env `RIVENDELL_TRACK`, label `RIVENDELL TASKS`. Hint, cost
  (`no extra call; a note per run in a repo on a board, plus a tool call per piece of work`),
  tokens (`~200 tokens a turn`) and about are copy you write: what it does,
  that it asks before filing, and that off means no note and no tools.
- Modify: `tests/test_aifeatures.py`. Add `"rvtrack"` to the registry set
  and `"RIVENDELL_TRACK": "1"` to `shipped`.
- Modify: `bridge/dashboard/server.py`. Add the route in `_post_api`, right
  after `/local/wait`.
- Modify: `bridge/goal_mcp.py`. Add the two tool schemas, `_rivendell_on()`,
  `_rivendell(name, args)`, and a shared `_bridge(path, body) -> str`. That
  is `_wait`'s urlopen block moved out, and `_wait` calls it.
- Test: `tests/test_rivendell_tasks_endpoint.py` for the route, and a new
  `tests/test_rivendell_track.py` for the tools.

**Interfaces:**
- Consumes: `rivendell.work_list(path)` and `rivendell.work_create(path,
  title, description, board)` from Task 1.
- Produces: `aifeatures.enabled("rvtrack")`; `goal_mcp._rivendell_on() ->
  bool`; the route.

The route's behaviour:
1. Look the session up with `store.get_by_claude_session_id`. A missing
   session, or one in another chat, gets `{"text": "No session is bound to this tool, so it can't reach Rivendell."}`.
2. An origin that starts with `rivendell` gets a text refusal.
3. The base directory is `_abs_within(s["cwd"] or "")`, or
   `_abs_project(s["project"])`.
4. When `repo` is given, use `_abs_within(os.path.join(base, repo))`. If
   that is None, answer with text saying it isn't a folder inside the
   workspace.
5. Action `create` calls `work_create(d, title, description, board)`.
   Anything else calls `work_list(d)`.

`_rivendell_on()` is True only when all of these hold:
`integrations.installed("rivendell")`, any
`rivendell_instances.instances()` row has `enable`,
`aifeatures.enabled("rvtrack")`, and the bound session's row exists with an
origin that doesn't start with `rivendell`. Any exception reads as False.
`tools/list` returns `_TOOLS + _RV_TOOLS` when it holds, and `_TOOLS`
otherwise. `_call` routes the two names to `_rivendell`. That POSTs
`{"action": "list"|"create", **args, "claude_session_id": …}` to
`/local/rivendell/work` through `_bridge`.

Tool schemas, with your own description copy:
- `ListRivendellTasks`: `repo` (optional string: the checkout being changed,
  absolute or relative to the session's folder).
- `CreateRivendellTask`: `title` (required), `description`, `board` (the
  board name, when ListRivendellTasks showed more than one), and `repo`. The
  description must say: call only after the user said yes on a card.

- [ ] **Step 1: Write the failing tests**

Route tests reuse `dpost` and `_repo` from `test_rivendell_tasks_endpoint.py`.
Make a session with the store's own create helper, set its claude session id
with `store.set_claude_session_id`, and stub `rivendell.work_list` /
`rivendell.work_create` to record their arguments.
- `test_work_lists_for_the_sessions_own_folder`: `work_list` gets the
  project's absolute path, and the answer is `{"text": <stub's>}`.
- `test_work_uses_the_worktree_the_session_moved_into`
- `test_work_resolves_repo_against_the_sessions_folder`: a subfolder `sub`.
- `test_work_refuses_a_repo_outside_the_workspace`: `repo="/etc"`. Text
  only, and the stub is not called.
- `test_work_refuses_rivendells_own_runs`: origin `"rivendell:a"`.
- `test_work_with_an_unknown_session_says_so`
- `test_work_create_relays_title_description_board`

Tool tests (new file, conftest-pinned like the rest):
- `test_rivendell_tools_are_listed_only_where_they_can_work`: monkeypatch
  `_rivendell_on`. True means both names are in `tools/list`; False means
  neither.
- `test_rivendell_on_needs_install_connection_switch_and_a_user_session`:
  monkeypatch `integrations.installed`, `rivendell_instances.instances` and
  `aifeatures.enabled`, and bind a session (origin `None`, then
  `"rivendell:a"`). Each missing piece gives False.
- `test_the_rivendell_tools_post_to_the_bridge`: fake `urlopen`, as
  `test_waits.test_the_tool_posts_to_the_bridge` does. The URL ends with
  `/local/rivendell/work`, and the body is `{"action": "create", "title": "T", "claude_session_id": "csid-x"}`.
- `test_initialize_and_tools_list` in `tests/test_goals.py` must stay green
  unchanged. Its state has no Rivendell.

- [ ] **Step 2: Run them, expect failures**

Run: `~/.cache/mystical-test-venv/bin/python -m pytest tests/test_rivendell_tasks_endpoint.py tests/test_rivendell_track.py tests/test_aifeatures.py -q`
Expected: FAIL. The new tests fail, and the aifeatures registry asserts fail.

- [ ] **Step 3: Implement as above**

- [ ] **Step 4: Run them plus `tests/test_goals.py tests/test_waits.py`, expect PASS**

- [ ] **Step 5: Commit**

`git commit -m "goals: ListRivendellTasks and CreateRivendellTask, behind the RIVENDELL TASKS switch"`

---

### Task 3: The note (`bridge/runner.py`)

**Files:**
- Modify: `bridge/runner.py`. Add `_RIVENDELL_NOTE` next to `_PUSH_NOTE`, a
  `rivendell: str = ""` parameter on `_compose_system_prompt` (placed after
  the browser note, before `graph`), and `_rivendell_notes: dict[str, bool]`
  with `_rivendell_note_for` near `_packed_sessions`. Wire it in `_base_cmd`.
- Test: `tests/test_rivendell_track.py`.

**Interfaces:**
- Consumes: `rivendell.on_board(path, wait=2.0)` (Task 1) and
  `aifeatures.enabled("rvtrack")` (Task 2).
- Produces: `_rivendell_note_for(chat_id: int, claude_session_id: str, cwd: str | None) -> str`.
  It returns "" while the switch is off and doesn't touch the memo. Otherwise
  it memoizes `bool`, which is True only when the session row's origin
  doesn't start with `rivendell` and
  `on_board(cwd or state.project_dir(chat_id))` holds. Exceptions read as
  False. It returns `_RIVENDELL_NOTE` when the memo is True, else "". In
  `_base_cmd` it's computed only when
  `interactive and claude_session_id and not skip_pack`, the same condition
  that attaches the goals server.

The note's content is the spec's §1 bullet list in your words. It must name
`mcp__goals__ListRivendellTasks`, ToolSearch, the branch and PR title,
AskUserQuestion, `mcp__goals__CreateRivendellTask`, and "Questions, reviews
and research need no task".

- [ ] **Step 1: Write the failing tests**

Build commands with `runner._base_cmd("hi", 555, stream=True,
interactive=True, claude_session_id=csid, cwd=d)` and read the
`--append-system-prompt` value. Monkeypatch `rivendell.on_board` with a
counter, and clear `runner._rivendell_notes` in a fixture.
- `test_a_session_in_a_repo_on_a_board_gets_the_note`
- `test_no_note_without_a_board`
- `test_no_note_for_rivendells_own_runs`: bind a store session with origin
  `"rivendell:a"` to `csid`. `on_board` is not called.
- `test_no_note_while_the_switch_is_off`
- `test_the_note_is_decided_once_per_session`: `on_board` gives True, then
  False. The same `csid` still has the note and `on_board` was called once. A
  new `csid` has no note.
- `test_switching_off_mid_session_drops_the_note_next_turn`: True, then the
  switch goes off (no note), then back on (the note returns, still one
  `on_board` call).
- `test_one_shots_and_bot_runs_never_get_the_note`: `skip_pack=True`, and
  then `interactive=False`. `on_board` is not called.

- [ ] **Step 2: Run, expect failures**

Run: `~/.cache/mystical-test-venv/bin/python -m pytest tests/test_rivendell_track.py -q`

- [ ] **Step 3: Implement as above**

- [ ] **Step 4: Run it plus `tests/test_mcp_startup.py tests/test_dream.py`, expect PASS**

- [ ] **Step 5: Commit**

`git commit -m "runner: sessions in a repo on a Rivendell board are told to find or file its task"`

---

### Task 4: WORK ON IT carries the key (dashboard)

**Files:**
- Modify: `bridge/dashboard/web/src/api.ts`. Add `key: string | null;   // e.g. NRA-61`
  to `RivendellTask`.
- Modify: `bridge/dashboard/web/src/lib/rivendelltasks.ts`. `workPrompt`
  takes `Pick<RivendellTask, "name" | "url" | "htmlUrl" | "key">`. When
  `t.key` is set, add a line after the Teamwork/Rivendell line:
  `Put <key> in the branch name and the PR title, so Rivendell links the PR to this task.`
- Test: `bridge/dashboard/web/src/lib/rivendelltasks.check.ts`.

- [ ] **Step 1: Write the failing check**

```ts
eq(workPrompt({ ...task, key: "NRA-61" }, null),
  "Rivendell task: T26 — Moneybird OAuth ⏸\nTeamwork: https://tw/50998944 · Rivendell: https://rv/tasks/t26\nPut NRA-61 in the branch name and the PR title, so Rivendell links the PR to this task.\n\n",
  "WORK ON IT tells the session to carry the task key");
```

The existing `workPrompt` checks pass `task` with no `key` and must stay
byte-identical.

- [ ] **Step 2: Run it, expect FAIL**

Run (from `bridge/dashboard/web`): `node --experimental-strip-types src/lib/rivendelltasks.check.ts`

- [ ] **Step 3: Implement**

- [ ] **Step 4: Run it, expect PASS; type-check with the web project's own command**

The worktree has no `node_modules`. Symlink master's for the check, and
never commit it.

- [ ] **Step 5: Commit**

`git commit -m "dashboard: WORK ON IT tells the session to carry the task key"`

---

### Task 5: Whole-branch verification

- [ ] Full suite: `~/.cache/mystical-test-venv/bin/python -m pytest tests/ -q`.
  Expect only the 7 known macOS failures.
- [ ] `~/.cache/mystical-test-venv/bin/python -m pyflakes` over the touched
  Python files.
- [ ] A live read-only check against the real Rivendell, with the worktree
  code, from a scratch script in `.mystical/`. Start one `rivendell.Worker`
  from `rivendell_instances.raw_instances()` without its socket, put it in
  `_workers`, and print `work_list(<a local NR checkout>)` and
  `on_board(<this repo>)` (expected False: Mystical Assistant has no board).
  Do **not** call `work_create` live, because it writes to a client board.
- [ ] Remove the `node_modules` symlink if one was made.
