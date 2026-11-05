# Skill paths + tickets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the skill router into the SKILL PATHS feature: Matt Pocock's skills bundled in Mystical, every prompt
given a path (rules first, then Claude), paths that walk themselves, and a TICKETS feature that builds approved tickets
as parallel worktree sessions merged in one pass.

**Architecture:** The backend gets two new modules. `bridge/paths.py` holds the bundled pack's location, the paths
table, the system-prompt pack, per-session flow state (`flows.json`) and the turn-end hook that starts the next step.
`bridge/tickets.py` parses ticket files, keeps `set.json`, schedules ticket sessions (3 at once) and starts the merge
session. Claude reports into both through two new tools on the existing `mystical-goals` MCP server (SetPath,
StepDone), which relay to new `/local/flow/*` endpoints. The dashboard gets a FLOW rail tab and a TICKETS sidebar mode.

**Tech Stack:** Python 3 stdlib (bridge), React + TypeScript + lucide (dashboard), pytest, node `*.check.ts`.

**Spec:** `docs/superpowers/specs/skill-paths.md` (approved 2026-11-05). Mockups: `.mystical/design-drafts/skill-paths/04-flow-tickets.html`.
The rail refresh (spec §8) has its own plan, `docs/superpowers/plans/rail-heroes.md`.

## Global Constraints

- Backend: Python stdlib only, no new dependencies. Dashboard: existing React app, lucide icons, existing tokens.
- Work in a worktree on `feat/skill-paths` (bridge-worktree skill). Never commit onto `master`. Never push.
  Commit messages are one line, under ~72 characters, with no co-author or attribution lines.
- New persisted state goes in JSON files beside the DB (`os.path.dirname(config.BRIDGE_DB)`), written atomically in
  `waits.py`'s pattern (`_path`, `_load_locked`, `_save_locked`). No DB tables or columns.
- `--append-system-prompt` text must stay byte-identical from turn to turn: constant strings only, no per-turn values.
- The vendored pack lives in `bridge/skills/mattpocock/`. Its plugin name stays `mattpocock-skills`, so commands are
  `/mattpocock-skills:<name>`.
- Unlocked skills (Claude may start them): `grill-with-docs`, `grill-me`, `improve-codebase-architecture`, `teach`.
  All other skills that carry `disable-model-invocation: true` upstream keep it.
- Ticket files: `.mystical/tickets/<feature-slug>/<NN>-<slug>.md` in the flow session's checkout, with `set.json`
  beside them. Ticket branches are `tk/<feature-slug>-<NN>`, the feature branch is `feat/<feature-slug>`, and at most
  **3** ticket sessions run at once per set.
- Switch keys: `router` (label SKILL PATHS), sub-switches `autopick`, `nextstep` (label AUTO NEXT STEPS) and
  `smartzone`, and new `ticketruns` (label TICKETS, env `TICKET_RUNS`, default `"0"`, parent `router`). Removed:
  `askmatt`, `setupnudge` and `tickets`.
- No automatic step builds on, commits to or pushes the default branch.
- Suite: `~/.cache/mystical-test-venv/bin/python -m pytest tests/ -q` takes about 5–7 min. Three tests fail on this Mac
  before any change: `test_clip_panel::test_clip_marks_round_trip` and two in `test_startup`. Anything else red is
  ours. Dashboard checks: `node src/<path>.check.ts` from `bridge/dashboard/web/`, `npx tsc -p tsconfig.app.json`.
- Shipping is the user's ⟳ (bridge-ship skill), never a restart from inside a session.

## Review Focus

1. **Bridge restart mid-BUILD.** `tickets.boot()` must reconcile from `set.json` and never start a ticket twice. A ticket
   with a `session_id` is only ever retried explicitly. → Task 10, `test_boot_never_double_starts`.
2. **A ticket file deleted or renamed after approval.** The scheduler marks that ticket `missing` and holds its
   dependents, without raising. → Task 10, `test_missing_ticket_file_is_held_not_fatal`.
3. **StepDone twice in one turn, or in a session with no path.** The handler is idempotent per turn, and a
   session with no path gets a plain answer and no enqueue. → Task 5, `test_step_done_idempotent`;
   Task 6, `test_no_path_no_enqueue`.
4. **A ticket's branch or worktree already exists** (the set re-run, or a `-2` directory). It is reused, not a
   failure. → Task 10, `test_existing_branch_is_reused`.
5. **SKILL PATHS or TICKETS switched off mid-flow.** No new auto step and no new ticket session start; running ones
   finish. → Task 6, `test_router_off_no_enqueue`; Task 10, `test_tick_starts_nothing_when_off`.

---

### Task 1: Vendor Matt's pack

**Files:**
- Create: `bridge/skills/mattpocock/.claude-plugin/plugin.json`, `LICENSE`, `README.md`, and `skills/<group>/<name>/**`
  for exactly the 27 skills the upstream manifest lists. Leave out `in-progress/`, `node_modules`, `scripts` and `docs`.
- Test: `tests/test_vendored_pack.py`

**Interfaces:**
- Produces: the folder `bridge/skills/mattpocock/`, a valid Claude Code plugin root.

- [ ] **Step 1: Copy the pack.** Source is the installed v1.3.1 under
  `~/.mystical/accounts/3/plugins/cache/claude-plugins-official/mattpocock-skills/1.3.1/`. In the four unlocked
  skills' `SKILL.md` frontmatter, delete the line `disable-model-invocation: true`. `README.md` names the source
  (`mattpocock/skills`, v1.3.1), the MIT licence, the four edits, and the refresh step: copy again, then redo the four edits.
- [ ] **Step 2: Write the tests**

```python
PACK = os.path.join(os.path.dirname(bridge.__file__), "skills", "mattpocock")
UNLOCKED = {"grill-with-docs", "grill-me", "improve-codebase-architecture", "teach"}
USER_ONLY = {"ask-matt", "implement", "implement-spec", "retro", "setup-matt-pocock-skills", "to-spec",
             "to-tickets", "triage", "wayfinder", "handoff", "to-questionnaire", "wait-what"}

def test_manifest_lists_27_existing_skills():
    m = json.load(open(os.path.join(PACK, ".claude-plugin", "plugin.json")))
    assert m["name"] == "mattpocock-skills" and len(m["skills"]) == 27
    for rel in m["skills"]:
        assert os.path.isfile(os.path.join(PACK, rel, "SKILL.md"))

def test_unlocked_and_user_only_flags():
    for name, flagged in [(n, False) for n in UNLOCKED] + [(n, True) for n in USER_ONLY]:
        text = open(_skill_md(name)).read()
        assert ("disable-model-invocation: true" in text) is flagged, name

def test_licence_is_mit():
    assert "MIT License" in open(os.path.join(PACK, "LICENSE")).read()
```

- [ ] **Step 3: Run** `~/.cache/mystical-test-venv/bin/python -m pytest tests/test_vendored_pack.py -q`. Expect PASS.
- [ ] **Step 4: Commit** `git commit -m "skills: vendor Matt Pocock's pack (MIT, v1.3.1)"`

### Task 2: Load the pack in every run, list it once

**Files:**
- Create: `bridge/paths.py` (module docstring: why the pack is vendored, why it's loaded inside `_base_cmd`)
- Modify: `bridge/runner.py` `_base_cmd` :569 (the `if interactive:` block :616-630), `bridge/commands.py` `available` :160-171
- Test: `tests/test_paths.py`, `tests/test_commands.py`

**Interfaces:**
- Produces: `paths.PACK_DIR: str`, `paths.PLUGIN_ID = "mattpocock-skills@claude-plugins-official"`, `paths.on() -> bool` (= `aifeatures.enabled("router")`).

- [ ] **Step 1: Check the name clash by hand.** In a scratch dir, run
  `claude -p --plugin-dir <worktree>/bridge/skills/mattpocock --max-turns 1 "/mattpocock-skills:wait-what what?"`
  with the installed plugin still enabled. Write down whether it errors, doubles the commands or prefers one copy.
  If it does anything but run cleanly once, Step 4 also adds the override below. Record the result in the commit message.
- [ ] **Step 2: Write the failing tests**

```python
def test_base_cmd_adds_plugin_dir_when_router_on(router_on):
    cmd = runner._base_cmd("hi", 1, stream=True, interactive=True, claude_session_id="c1")
    assert cmd[cmd.index("--plugin-dir") + 1] == paths.PACK_DIR

def test_base_cmd_no_plugin_dir_when_off_or_skip_pack(router_off):
    assert "--plugin-dir" not in runner._base_cmd("hi", 1, stream=True, interactive=True, claude_session_id="c1")

def test_available_lists_bundled_pack_once(router_on, fake_installed_mattpocock):
    names = [c["name"] for c in commands.available(None)]
    assert names.count("mattpocock-skills:grill-with-docs") == 1
```

- [ ] **Step 3: Implement.** In `_base_cmd`, under `interactive and claude_session_id and not skip_pack`, add
  `--plugin-dir paths.PACK_DIR` when `paths.on()`. It goes here, not through `extra_args`, so queued, resumed and
  recovered runs keep it. In `commands.available`, when `paths.on()`, add `PACK_DIR` as a plugin root named
  `mattpocock-skills` and skip any installed root with that short name.
- [ ] **Step 4 (only if Step 1 showed a clash):** merge `{"enabledPlugins": {PLUGIN_ID: false}}` into the run's
  `--settings` (`_one_settings` :287 merges them). Test: `test_installed_copy_disabled_when_bundled`.
- [ ] **Step 5: Run** `pytest tests/test_paths.py tests/test_commands.py -q`. Expect PASS.
- [ ] **Step 6: Commit** `git commit -m "runner: load the bundled skill pack while SKILL PATHS is on"`

### Task 3: The paths pack in the system prompt

**Files:**
- Modify: `bridge/paths.py`, `bridge/runner.py` `_compose_system_prompt` :215 and its call at :661
- Test: `tests/test_paths.py`, `tests/test_pack_cache.py`

**Interfaces:**
- Produces: `paths.PACK_TEXT: str` (the constant below), `paths.pack_for(claude_session_id: str) -> str`. That's
  `PACK_TEXT` when `paths.on()` and the session's origin doesn't start with `rivendell` or `device-run`, else `""`,
  cached per session the way `_rivendell_note_for` :249 caches.
  `_compose_system_prompt(graph="", rivendell="", paths_pack="")`.

- [ ] **Step 1: Write the failing tests**

```python
def test_pack_in_prompt_when_on(router_on, session_c1):
    assert paths.PACK_TEXT in runner._compose_system_prompt(paths_pack=paths.pack_for("c1"))

def test_pack_is_constant(router_on, session_c1):
    assert runner._compose_system_prompt(paths_pack=paths.pack_for("c1")) == runner._compose_system_prompt(paths_pack=paths.pack_for("c1"))

def test_no_pack_for_rivendell_jobs(router_on, rivendell_session_c2):
    assert paths.pack_for("c2") == ""
```

- [ ] **Step 2: Implement** `PACK_TEXT` as exactly this text:

```text
Skill paths. Matt Pocock's skills are loaded as /mattpocock-skills:<name>.
When a prompt has no /command in front, first decide whether one of these paths fits it:
- feature: a new feature or idea. Start grill-with-docs.
- bug: something broken, failing or slow. Start diagnosing-bugs.
- refactor: tangled code or architecture work. Start improve-codebase-architecture.
- one: research, a prototype, a review, a PR or teaching. Start that one skill (research, prototype, code-review, pr, teach).
If one fits, call SetPath with the path and a one-line why, then start its skill with the Skill tool.
If none fits (a plain question, a small edit, a chat reply), just answer and start nothing.
If the message begins "No path for this message.", start nothing.
When you finish a step of a path and need nothing more from the user, call StepDone. After a grill, pass choice "here" if the work fits this one session, or "tickets" if it needs several. Never call StepDone while waiting on the user.
Tickets: the tracker is local files. Write one ticket per file to .mystical/tickets/<feature-slug>/<NN>-<slug>.md in this checkout, using the local ticket template, numbered from 01 in dependency order. Triage labels: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix.
```

  Pass `paths_pack=paths.pack_for(claude_session_id)` at runner :661, in the same guarded call as the Rivendell note.
- [ ] **Step 3: Run** `pytest tests/test_paths.py tests/test_pack_cache.py -q`. Expect PASS.
- [ ] **Step 4: Commit** `git commit -m "runner: the skill paths pack in the system prompt"`

### Task 4: Flow state (`flows.json`)

**Files:**
- Modify: `bridge/paths.py`
- Test: `tests/test_paths.py`

**Interfaces:**
- Produces:
  - `PATHS: dict[str, list[tuple[str, str | None, str]]]`, where each entry is `(station, skill or None, "you" | "auto")`:
    - `feature`: grill/grill-with-docs/you, spec/to-spec/auto, tickets/to-tickets/you, build/None/auto, merge/None/auto, retro/retro/auto
    - `feature-here`: grill/grill-with-docs/you, build-here/implement/auto, retro/retro/auto
    - `bug`: diagnose/diagnosing-bugs/auto, fix/tdd/auto, retro/retro/auto
    - `refactor`: improve/improve-codebase-architecture/you, tickets/to-tickets/you, build/None/auto, merge/None/auto, retro/retro/auto
    - `one`: built per use, `[(skill, skill, "auto")]`
  - `set_path(session_id: str, path: str, why: str, by: str, skill: str | None = None) -> dict`. `by` is `"rule"` or
    `"claude"`. An unknown path raises `ValueError`.
  - `get(session_id: str) -> dict | None`, shaped `{path, by, why, auto: bool, at: int, done: [str], next: {station, turn_id} | None}`.
  - `set_auto(session_id: str, on: bool) -> None`
  - `step_done(session_id: str, turn_id: str, choice: str | None = None) -> str | None` returns the next station or
    None. `choice="here"` on `feature`'s grill switches the path to `feature-here`. Idempotent per `turn_id`.
  - `path_for_command(skill: str) -> tuple[str, str]` gives `(path, station)` for a typed flow command, by first
    station match, else `("one", skill)`.

- [ ] **Step 1: Write the failing tests**

```python
def test_feature_grill_done_goes_to_spec(state_dir):
    paths.set_path("s1", "feature", "new feature", "claude")
    assert paths.step_done("s1", "t1") == "spec"

def test_choice_here_switches_to_feature_here(state_dir):
    paths.set_path("s1", "feature", "small", "claude")
    assert paths.step_done("s1", "t1", choice="here") == "build-here"
    assert paths.get("s1")["path"] == "feature-here"

def test_step_done_same_turn_twice_is_one_step(state_dir):
    paths.set_path("s1", "bug", "crash", "rule")
    assert paths.step_done("s1", "t1") == "fix" and paths.step_done("s1", "t1") == "fix"

def test_flows_survive_reload(state_dir):
    paths.set_path("s1", "bug", "crash", "rule"); paths._cache.clear()
    assert paths.get("s1")["path"] == "bug"

def test_unknown_path_rejected(state_dir):
    with pytest.raises(ValueError): paths.set_path("s1", "nope", "", "claude")

def test_typed_to_tickets_joins_feature_at_tickets():
    assert paths.path_for_command("to-tickets") == ("feature", "tickets")
```

- [ ] **Step 2: Implement** with `waits.py`'s locked, atomic JSON pattern at
  `os.path.join(os.path.dirname(config.BRIDGE_DB), "flows.json")`.
- [ ] **Step 3: Run** `pytest tests/test_paths.py -q`. Expect PASS.
- [ ] **Step 4: Commit** `git commit -m "paths: per-session flow state"`

### Task 5: SetPath and StepDone tools

**Files:**
- Modify: `bridge/goal_mcp.py` (`_TOOLS` :27, `_call` :146, `tools/list` :239), `bridge/dashboard/server.py`
  (POST `/local/flow/set`, `/local/flow/done`, `/local/flow/auto`, and GET `/local/flow`, next to `/local/wait` :1395)
- Test: `tests/test_goals.py`, `tests/test_paths.py`

**Interfaces:**
- Consumes: Task 4 API.
- Produces:
  - `goal_mcp._paths_on() -> bool`: `paths.on()` and the origin is not `rivendell*`/`device-run*`, the way
    `_rivendell_on` :203 decides. `tools/list` returns `_TOOLS + _RV_TOOLS? + (_PATH_TOOLS if _paths_on())`.
  - `SetPath {path: "feature"|"bug"|"refactor"|"one", why: str, skill?: str}` →
    `_bridge("/local/flow/set", …)` → `paths.set_path(sid, path, why, "claude", skill)`.
  - `StepDone {choice?: "here"|"tickets"}` → `_bridge("/local/flow/done", …)` → `paths.step_done(sid, <the
    session's running turn id>, choice)`. The answer text is
    `"Step done. Next: <station>, which starts when this turn ends."` or `"Step done. That was the last step."`
  - `GET /local/flow?session=<id>` → `{flow: paths.get(id), set: tickets.summary_for(id) | null}`. The `set` part
    is null until Task 9. `POST /local/flow/auto {session, on}` → `paths.set_auto`.

- [ ] **Step 1: Write the failing tests**

```python
def test_path_tools_listed_only_when_on(router_on):
    assert {"SetPath", "StepDone"} <= {t["name"] for t in _list_tools()}

def test_path_tools_hidden_for_rivendell_origin(router_on, rivendell_origin):
    assert "SetPath" not in {t["name"] for t in _list_tools()}

def test_step_done_idempotent(server, flow_session):
    a = server.post("/local/flow/done", {"claude_session_id": "c1"}); b = server.post("/local/flow/done", {"claude_session_id": "c1"})
    assert paths.get(flow_session)["next"]["station"] == "spec" and a == b
```

- [ ] **Step 2: Implement** the tool entries, the dispatch and the four handlers. The token is checked as at server :385.
- [ ] **Step 3: Run** `pytest tests/test_goals.py tests/test_paths.py -q`. Expect PASS.
- [ ] **Step 4: Commit** `git commit -m "goals mcp: SetPath and StepDone for skill paths"`

### Task 6: Start the next step when a turn ends

**Files:**
- Modify: `bridge/paths.py`; `bridge/runner.py` `_run_streaming` `finally:` (beside `goals.continue_after_turn` :3067)
  and the turn start (beside `goals.on_user_turn` :3278)
- Test: `tests/test_paths.py`

**Interfaces:**
- Consumes: `queue_manager.enqueue(sid, text, prompt, images, model, effort, permission_mode, width, sel, surface, chat_id, project)` (:475).
  `tickets.start_build(flow_session_id) -> str` and `flowbranch.ensure_feature_branch` come in later tasks. Until
  they exist, `build` and `build-here` don't start by themselves.
- Produces:
  - `paths.on_turn_start(session_id: str, prompt: str) -> None`. A prompt starting `/mattpocock-skills:<x>` in a
    session without a path records `path_for_command(x)` with `by="rule"` and the rule's why (`route._WHY`).
  - `paths.continue_after_turn(job, effort=None) -> bool`. Guards: status done, not interrupted, not `acp:`,
    `paths.on()`, `aifeatures.enabled("nextstep")`, the session's `auto`, and a `next` recorded in **this** turn.
    It enqueues `/mattpocock-skills:<skill>` with `surface="flow"`. With `smartzone` on and `ctx_tokens > 150_000`,
    it enqueues `/compact Keep the decisions so far; the next step is <station>.` first. `build`/`merge` go to
    tickets (when `ticketruns` is on; otherwise it returns False, and FLOW shows the step as YOU). It returns True
    when anything was started, which suppresses the DONE ping, as goals does.
  - `paths.advance(session_id: str, station: str) -> bool`. It marks `station` done in another session's flow (MERGE
    finishing in its own session) and enqueues that flow's next step the same way. Test:
    `test_advance_from_merge_enqueues_retro`.

- [ ] **Step 1: Write the failing tests**

```python
def test_grill_step_done_enqueues_to_spec(router_on, fake_queue, flow_job):
    paths.step_done(flow_job.session_id, flow_job.turn_id)
    assert paths.continue_after_turn(flow_job) is True
    assert fake_queue.items[-1]["prompt"] == "/mattpocock-skills:to-spec"

def test_no_step_done_no_enqueue(router_on, fake_queue, flow_job):
    assert paths.continue_after_turn(flow_job) is False and not fake_queue.items

def test_no_path_no_enqueue(router_on, fake_queue, plain_job):
    assert paths.continue_after_turn(plain_job) is False

def test_router_off_no_enqueue(router_off, fake_queue, flow_job_with_next):
    assert paths.continue_after_turn(flow_job_with_next) is False

def test_held_auto_no_enqueue(router_on, fake_queue, flow_job_with_next):
    paths.set_auto(flow_job_with_next.session_id, False)
    assert paths.continue_after_turn(flow_job_with_next) is False

def test_compact_first_past_150k(router_on, fake_queue, flow_job_with_next_at_160k):
    paths.continue_after_turn(flow_job_with_next_at_160k)
    assert fake_queue.items[0]["prompt"].startswith("/compact ")
```

- [ ] **Step 2: Implement** both functions and the two runner hooks
  (`resumed = paths.continue_after_turn(job, effort) or resumed`).
- [ ] **Step 3: Run** `pytest tests/test_paths.py -q`. Expect PASS.
- [ ] **Step 4: Commit** `git commit -m "paths: the next step starts by itself"`

### Task 7: The feature branch (shared by both BUILD routes)

**Files:**
- Create: `bridge/flowbranch.py` (docstring: why only the flow's own files move, and why a stash carries them)
- Modify: `bridge/git.py` (move `_WT_ROOT`/`_worktree_path` from server.py :131-139 into
  `git.worktree_path_for(repo_root: str, branch: str) -> str`), with server.py using it. `bridge/paths.py` (`build-here`)
- Test: `tests/test_flowbranch.py` (temporary git repos)

**Interfaces:**
- Produces:
  - `flowbranch.flow_files(session_id: str, since: int) -> list[str]`: absolute paths from the session's
    Write/Edit/MultiEdit/NotebookEdit tool uses since the path began (`flows.json` `at`), read the way GET
    `/local/sessions/<id>` (server :579) reads turns and events. Only files inside the checkout count.
  - `flowbranch.ensure_feature_branch(session: dict, slug: str) -> tuple[str, str]` returns `(branch, checkout)`:
    - If the session's checkout (`work_cwd or cwd`) is a linked worktree on a non-default branch, it uses that.
    - Otherwise it runs `git.worktree_add(main, worktree_path_for(main, "feat/<slug>"), "feat/<slug>", start="HEAD")`.
  - `flowbranch.carry_and_commit(src: str, dst: str, files: list[str], slug: str) -> bool`.
    - When `src != dst`: `git stash push -u -m "mystical flow <slug>" -- <files>` in `src`, then `git stash pop` in `dst`.
    - Then `git add -- <files>` and `git commit -m "docs: decisions from the <slug> flow"` in `dst`.
    - With no files it does nothing and returns False.
  - `build-here` in `continue_after_turn`: `ensure_feature_branch`, then `carry_and_commit`, then enqueue
    `/mattpocock-skills:implement Work in <checkout> on branch <branch>, and commit there.`

- [ ] **Step 1: Write the failing tests**

```python
def test_default_branch_gets_feature_worktree(repo):
    branch, co = flowbranch.ensure_feature_branch({"cwd": repo.main}, "x")
    assert branch == "feat/x" and co != repo.main and repo.branch_of(co) == "feat/x"

def test_feature_worktree_is_reused(repo_on_feature):
    assert flowbranch.ensure_feature_branch({"cwd": repo_on_feature.wt}, "x") == ("feat/y", repo_on_feature.wt)

def test_only_flow_files_move_and_master_untouched(repo):
    repo.write("GLOSSARY.md"); repo.write("other.txt")   # other.txt belongs to someone else
    _, co = flowbranch.ensure_feature_branch({"cwd": repo.main}, "x")
    assert flowbranch.carry_and_commit(repo.main, co, [repo.path("GLOSSARY.md")], "x")
    assert repo.dirty(repo.main) == {"other.txt"} and repo.head_moved("master") is False
    assert repo.last_subject(co) == "docs: decisions from the x flow"

def test_no_files_no_commit(repo):
    _, co = flowbranch.ensure_feature_branch({"cwd": repo.main}, "x")
    assert flowbranch.carry_and_commit(repo.main, co, [], "x") is False
```

- [ ] **Step 2: Implement.** Keep `_worktree`'s `.env` copy (server :2076) by calling the moved helper from both places.
- [ ] **Step 3: Run** `pytest tests/test_flowbranch.py tests/test_paths.py -q`, plus the server worktree tests
  (`pytest -q -k worktree`). Expect PASS.
- [ ] **Step 4: Commit** `git commit -m "flowbranch: feature branch and the flow's own files"`

### Task 8: FLOW tab

**Files:**
- Create: `bridge/dashboard/web/src/components/hud/FlowPanel.tsx`, `bridge/dashboard/web/src/lib/flowview.ts`, `bridge/dashboard/web/src/lib/flowview.check.ts`
- Modify: `web/src/lib/theme.ts:342` (`"flow"` after `"turns"`), `web/src/App.tsx:2349` (the tab, only while `ai.router`),
  `web/src/api.ts` (`getFlow`, `setFlowAuto`), the panel stylesheet the Turns tab uses

**Interfaces:**
- Consumes: `GET /local/flow`, `POST /local/flow/auto` (Task 5).
- Produces: `flowView(flow: Flow | null, turns: Turn[]) -> FlowView`, where FlowView is
  `{stations: {key, label, state: "done"|"now"|"you"|"auto"|"next"}[], step: number, total: number, why: string, by: "rule"|"claude", nowTurn?: {started: number, tools: number, activity: string}}`.

- [ ] **Step 1: Write the failing check** `flowview.check.ts` asserting three things. For a `feature` flow with
  `done:["grill"]` and a running turn, the stations are `done, now, you, auto, auto, auto` and step `2` of `6`. For
  `feature-here`, there are 3 stations. A `null` flow gives `stations: []`.
- [ ] **Step 2: Run** `node src/lib/flowview.check.ts` from `bridge/dashboard/web/`. Expect FAIL.
- [ ] **Step 3: Implement** `flowView`, then `FlowPanel` as drawn in `04-flow-tickets.html` col 1:
  - the 132px hero with the path map (`aria-label` listing the stations and their states) and the AUTO pill (`setFlowAuto`)
  - the why line, the folded done lines, the running step's card and the next rows (AUTO / YOU APPROVE)
  - the zone line
  - the empty state: "no path for this session"
  - lucide `Route` for the tab icon
  - motion off under `prefers-reduced-motion`
- [ ] **Step 4: Run** the check, `npx tsc -p tsconfig.app.json`, and every `*.check.ts`. Expect PASS.
- [ ] **Step 5: Look at it.** Run a bridge-eyes capture of a build of this worktree through
  `.mystical/probe-mac/follow/roserve.mjs`, then compare it with `.mystical/design-drafts/skill-paths/shots/r2-flow.png`.
- [ ] **Step 6: Commit** `git commit -m "dashboard: FLOW tab with the path map"`

### Task 9: Ticket sets: parse, order, `set.json`

**Files:**
- Create: `bridge/tickets.py` (docstring: tickets are Matt's local files, why `set.json` sits beside them, the
  3-at-once rule and the merge-at-end rule, with the spec's calls 3–6)
- Test: `tests/test_tickets.py`

**Interfaces:**
- Produces:
  - `Ticket(NamedTuple)`: `n: str` ("01"), `title: str`, `path: str`, `blocked_by: tuple[str, ...]`
  - `parse_dir(folder: str) -> list[Ticket]`. It reads `# NN: Title` and the `**Blocked by:**` line (numbers `#?\d{1,2}`
    or exact titles; "None…" means no blockers).
  - `order(tickets: list[Ticket]) -> list[str]`. Topological order, lowest number first among ready ones. Raises
    `TicketError("cycle: #02 → #05 → #02")` or `TicketError("#06 is blocked by #09, which doesn't exist")`.
  - `load(folder) -> dict`, `save(folder, state) -> None` (atomic) and `summary_for(session_id) -> dict | None`, with
    `set.json` shaped `{slug, parent_session, checkout, feature_branch, feature_checkout, status: "building"|"merging"|"merged"|"stopped", tickets: {n: {status: "queued"|"running"|"done"|"fix"|"missing", branch, worktree, session_id, base}}, merge_session}`.
  - Registry: `ticketsets.json` beside the DB, holding `[{folder, project, slug, created}]`, via `register(folder, project, slug)` and `sets() -> list[dict]`.

- [ ] **Step 1: Write the failing tests:** `test_parse_numbers_titles_and_none`, `test_order_lowest_first`,
  `test_cycle_names_the_loop` (asserting the exact message above), `test_missing_blocker_named` and
  `test_set_json_round_trip`.
- [ ] **Step 2: Implement.** **Step 3: Run** `pytest tests/test_tickets.py -q`. Expect PASS.
- [ ] **Step 4: Commit** `git commit -m "tickets: parse ticket files and keep set state"`

### Task 10: The scheduler: BUILD, 3 at once

**Files:**
- Modify: `bridge/tickets.py`, `bridge/paths.py` (`build` → `tickets.start_build`), `bridge/runner.py` (turn-end
  hook beside Task 6's), bridge startup (call `tickets.boot()` where `waits`/`limits` boot), `bridge/notices.py`
  (kind `tickets` in `CATALOG`/`VERBS`/`DEFAULTS`)
- Test: `tests/test_tickets.py`

**Interfaces:**
- Consumes: `flowbranch.ensure_feature_branch`, `carry_and_commit` and `flow_files` (Task 7);
  `git.worktree_add`/`worktree_path_for`; `store.create_session(chat_id, project, *, origin, cwd)`;
  `store.rename(session_id, title)`; `runner.start_streaming_job(chat_id, prompt, [], project=…, session_id=…, origin="ticket")`.
- Produces:
  - `MAX_RUNNING = 3`
  - `start_build(flow_session_id: str) -> str`. It takes the newest folder under `<checkout>/.mystical/tickets/` written
    since the path began, then parses and orders it. A `TicketError` sets status `stopped`, posts
    `notices.emit("tickets", …)` and returns the message. Otherwise it prepares the feature branch, saves, registers
    and calls `tick`.
  - `tick(folder: str) -> None`. Under a lock, and only while `aifeatures.enabled("ticketruns")`, it starts ready
    tickets until 3 are running.
  - `after_turn(job) -> bool`. For a ticket session, the ticket is done when StepDone was recorded this turn and the
    branch has ≥1 commit past its base. An error that isn't a usage limit marks it `fix`. Either way it calls `tick`,
    and when all tickets are done it calls `start_merge`.
  - `retry(folder, n) -> None`. A `fix` ticket goes back to running, with a new turn in its own session.
  - `boot() -> None`. It reconciles every `building` set, never starts a ticket that has a `session_id`, then calls `tick`.
- Each ticket's base:
  - No blockers: the feature branch head.
  - One blocker: that ticket's branch.
  - Several: the first blocker's branch with the others merged `--no-ff` at creation. A clash is noted in the prompt.
- Each ticket's first prompt:
  `/mattpocock-skills:implement <abs ticket path>\n\nThis is ticket #<n> of <slug>. Work on branch <branch> in this checkout and commit there. When it is done and the tests pass, call StepDone.`
  (Add `\nFirst resolve the merge of <branches> left in this checkout.` when a several-blocker merge clashed.)
- The session's title is `#<n> <title>`.

- [ ] **Step 1: Write the failing tests.** All use fakes for `start_streaming_job`, `create_session` and `worktree_add`:

```python
def test_at_most_three_run(built_set_of_5_independent):
    assert built_set.running() == ["01", "02", "03"]

def test_dependent_waits_then_bases_on_blocker(built_set_04_after_01):
    built_set.finish("01")
    assert built_set.state["tickets"]["04"]["base"] == "tk/x-01"

def test_two_blockers_merge_second_in(built_set_06_after_02_03):
    built_set.finish("02"); built_set.finish("03")
    assert "git merge --no-ff tk/x-03" in built_set.git_log_for("06")

def test_error_marks_fix_and_holds_dependents(built_set_04_after_01):
    built_set.fail("01")
    assert built_set.status("01") == "fix" and built_set.status("04") == "queued"

def test_boot_never_double_starts(built_set_running_01):
    tickets._reset_memory(); tickets.boot()
    assert built_set.start_calls("01") == 1

def test_missing_ticket_file_is_held_not_fatal(built_set_04_after_01):
    os.remove(built_set.path("01")); tickets.tick(built_set.folder)
    assert built_set.status("01") == "missing" and built_set.status("04") == "queued"

def test_existing_branch_is_reused(built_set_with_existing_tk_01):
    assert built_set.worktree_add_calls("01")[0]["create"] is False

def test_tick_starts_nothing_when_off(ticketruns_off, built_set_of_5_independent):
    assert built_set.running() == []

def test_cycle_stops_the_set_with_a_notice(cyclic_folder, fake_notices):
    assert tickets.start_build("s1").startswith("cycle:") and fake_notices.kinds == ["tickets"]
```

- [ ] **Step 2: Implement.** **Step 3: Run** `pytest tests/test_tickets.py tests/test_paths.py -q`. Expect PASS.
- [ ] **Step 4: Commit** `git commit -m "tickets: build approved tickets 3 at once in worktrees"`

### Task 11: MERGE, RETRO, clean-up

**Files:**
- Modify: `bridge/tickets.py`, `bridge/paths.py`, `bridge/dashboard/server.py` (GET `/local/tickets`, POST
  `/local/tickets/retry` and `/local/tickets/cleanup`)
- Test: `tests/test_tickets.py`

**Interfaces:**
- Produces:
  - `start_merge(folder: str) -> None`. It opens a session (origin `ticket-merge`, title `Merge <slug>`) in
    `feature_checkout` and runs:
    `Merge these branches into <feature_branch>, in this order, each with git merge --no-ff: <tk/…-01>, <tk/…-02>, …\nResolve any clash so both tickets' work survives, run the project's full test suite, fix what breaks, and commit. Then call StepDone.`
  - When the merge session's StepDone arrives and its turn ends, status becomes `merged`, and
    `paths.advance(flow_session_id, "merge")` enqueues `/mattpocock-skills:retro` in the flow session.
  - `merged_count(state) -> int` comes from `git branch --merged <feature_branch>` in `feature_checkout`.
  - `cleanup(folder) -> list[str]` removes merged ticket worktrees and `git branch -d`s their branches. Unmerged ones
    are skipped and named in the return.
  - `GET /local/tickets` → `{sets: [summary…]}`, newest first, where a summary is `set.json` plus `merged` and each
    ticket's live session status.

- [ ] **Step 1: Write the failing tests:**
  - `test_merge_prompt_lists_branches_in_dependency_order`
  - `test_merge_done_enqueues_retro_in_flow_session`
  - `test_cleanup_skips_unmerged` (asserts the returned name and that the worktree still exists)
- [ ] **Step 2: Implement.** **Step 3: Run** `pytest tests/test_tickets.py -q`. Expect PASS.
- [ ] **Step 4: Commit** `git commit -m "tickets: one merge session, then retro"`

### Task 12: Switches, rule changes and "No path"

**Files:**
- Modify:
  - `bridge/aifeatures.py` :183-275: the `router` label and copy, the `nextstep` label and copy; remove `askmatt`,
    `setupnudge` and `tickets`; add `ticketruns`.
  - `bridge/config.py` :185-201: remove `ROUTER_ASK_MATT`, `ROUTER_SETUP` and `ROUTER_TICKETS`; add `TICKET_RUNS` (default "0").
  - `tests/conftest.py`: pin `TICKET_RUNS=0`.
  - `bridge/route.py`:
    - `SUBS = ("autopick", "nextstep", "smartzone")`
    - drop the Ask Matt fallback and the setup nudge
    - `_TICKET` → `r"\.mystical/tickets/[^/\s]+/[^/\s]+\.md"`
    - `_first_ticket`/`_next_ticket` read `.mystical/tickets/*/`
  - `bridge/dashboard/server.py` `_run` :2165: `no_path`.
  - the dashboard composer: send `no_path: true` when an auto pick was removed with Esc before Send.
  - `web/src/api.ts` `RunBody` :1596.
- Test: `tests/test_aifeatures.py` :76/:101, `tests/test_route.py`, `tests/test_paths.py`

**Interfaces:**
- Copy:
  - SKILL PATHS hint: "gives every prompt a path through Matt Pocock's skills, bundled in Mystical"
  - SKILL PATHS cost: "~300 tokens in every run's system prompt"
  - AUTO NEXT STEPS hint: "a step starts by itself when the last one ends"
  - TICKETS hint: "approved tickets build as sessions, 3 at once, merged at the end"
  - Each `about` follows the spec's §3–4 wording.
- `_run`: `if body.get("no_path") is True: prompt = "No path for this message.\n\n" + prompt`. This is skipped
  when the prompt starts with `/`.

- [ ] **Step 1: Update the tests.**
  - The key set is `{…, "router", "autopick", "nextstep", "smartzone", "ticketruns", "grillcards"}`, with
    `ticketruns` defaulting to False.
  - Remove the route tests for Ask Matt and the setup nudge.
  - Move the ticket-ghost tests to `.mystical/tickets/` paths.
  - Add `test_no_path_prefix` and `test_no_path_ignored_for_commands`.
- [ ] **Step 2: Run them.** Expect FAIL. **Step 3: Implement.** **Step 4: Run** `pytest tests/test_aifeatures.py tests/test_route.py tests/test_paths.py -q`.
  Expect PASS. Then run the dashboard checks and tsc. While a session's queue holds a `surface: "flow"` item, the
  composer hides the NEXT STEP ghost, so the queued step isn't offered twice.
- [ ] **Step 5: Commit** `git commit -m "ai: SKILL PATHS and TICKETS switches, no-path on Esc"`

### Task 13: TICKETS sidebar mode

**Files:**
- Create: `web/src/components/hud/TicketsMode.tsx`, `web/src/lib/ticketdag.ts`, `web/src/lib/ticketdag.check.ts`
- Modify: `web/src/components/hud/SessionsPanel.tsx`:
  - `Mode` :70 adds `"tickets"`
  - `modeTabs` :1016 adds it after Projects, only while `ai.ticketruns`, with lucide `Ticket`
  - `DETAIL_DEFAULT` :101
  - render the mode's list with `TicketsMode`
- Modify: `web/src/api.ts` (`getTickets`, `retryTicket`, `cleanupTickets`).

**Interfaces:**
- Consumes: `GET /local/tickets`, `POST /local/tickets/retry|cleanup` (Task 11).
- Produces: `dagLayout(tickets: {n: string, blockedBy: string[]}[]) -> {nodes: {n, col, row}[], edges: {from, to}[], cols: number}`.
  A ticket's column is 1 + its longest blocker chain, rows go by number inside a column, and MERGE is the last column.

- [ ] **Step 1: Write the failing check.** `ticketdag.check.ts` asserts the mock's set: 01–04 in col 0, 05 and 06 in
  col 1, MERGE in col 2, and edges 04→05, 02→06, 03→06.
- [ ] **Step 2: Run it.** Expect FAIL. **Step 3: Implement** `dagLayout` and `TicketsMode` as drawn in
  `04-flow-tickets.html` cols 2–3:
  - the set card with the graph and the 3 slots
  - the stubs (RUN/ASK/WAIT/DONE/FIX, body, live line), with Answer jumping to the ask and a click opening the session
  - the MERGE stub (N / M from `merged`)
  - a finished set folded to one line, whose ⋯ offers Clean up worktrees through `askConfirm`
  - FIX's stub carries Retry
- [ ] **Step 4: Run** the checks, tsc and a bridge-eyes capture against `shots/r2-tickets.png`/`r2-tickets-merge.png`.
- [ ] **Step 5: Commit** `git commit -m "dashboard: TICKETS mode with stubs and the ticket graph"`

### Task 14: The bench gate (before this reaches the user)

**Files:**
- Modify: `.mystical/skill-bench/bench.py` (git-ignored). Point `MATT` at `bridge/skills/mattpocock` and add a mode
  that appends `paths.PACK_TEXT` and the goals MCP (`--mcp-config` with `MYSTICAL_DASH` set to a closed port, so SetPath
  answers with an error and the run goes on).
- Write: `.mystical/skill-bench/results-paths.md`

- [ ] **Step 1: Run** 12 unrouted prompts: 3 bugs, 3 vague features, 2 research asks, 1 review ask and 3 plain
  questions ("what does `_base_cmd` return?", "rename this variable", "thanks, that worked"). Use 1 run each, 6
  turns max, writes and shell blocked, as in the 11-04 bench. Also run the same 12 without the pack for cost.
- [ ] **Step 2: Score** the first Skill tool use per prompt. It passes with ≥10/12 right or rightly none, **0** paths
  started on the 3 plain questions, and the cost per prompt ≤ +15% against no pack.
- [ ] **Step 3:** If it fails, adjust `PACK_TEXT` (Task 3) at most twice and re-run. If it still fails, stop and report
  to the user with the numbers. The rules-only router still works with the pack text removed.

### Task 15: Integrate, verify, hand to the user

- [ ] **Step 1:** Run the full suite (`~/.cache/mystical-test-venv/bin/python -m pytest tests/ -q`). The only reds
  should be the 3 known Mac ones. Then run every dashboard `*.check.ts`, `npx tsc -p tsconfig.app.json`, and both web
  builds into `/tmp`.
- [ ] **Step 2: Real smoke run, only after the user says yes, since it spends usage.** Use a scratch repo and a
  2-ticket feature ("add a /health endpoint and its test"). The walk should be GRILL as cards, SPEC by itself,
  TICKETS approval, 2 ticket worktree sessions, the MERGE session (green) and RETRO. Then restart the scratch bridge
  mid-BUILD once to watch `boot()`.
- [ ] **Step 3:** Run the merge routine (the user's "merge + cleanup" memory): an integrate branch, the suite, then
  `--ff-only` into master **after asking**. Then ⟳ by the user. After it's live, ask before uninstalling the
  installed `mattpocock-skills` plugin.
