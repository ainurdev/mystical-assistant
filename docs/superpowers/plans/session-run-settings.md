# Session run settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A session keeps the model and permission mode last picked for it. Every surface runs on them: the dashboard, the Mini App, the bot chat, queued prompts and auto-resumes. A pick made mid-turn switches the running turn.

**Architecture:** `sessions.model` joins `sessions.permission_mode` on the row, and `store.set_run_settings` writes either one. `runner.start_streaming_job` falls back to the row when its caller brings no picks, and `handle_task` (the bot chat) always reads it. The `/run` routes save what they were sent. A new `POST …/session/settings` on both servers saves a pick and switches the live child over the stream-json control channel (`set_model` / `set_permission_mode`). Both frontends load the open session's picks into the composer, follow the 5-second session poll, and snap an unknown pick to its family only after the server's list has arrived.

**Tech Stack:** Python 3 stdlib (`sqlite3`, `subprocess`, `http.server`), React 19 + TypeScript + Vite in `bridge/dashboard/web` and `bridge/miniapp/web` (TanStack Query in the Mini App), pytest, Node 24 `.check.ts` scripts (run with plain `node`; type stripping is built in), Claude Code CLI 2.1.280.

**Spec:** [`docs/superpowers/specs/session-run-settings-design.md`](../specs/session-run-settings-design.md)

## Global Constraints

- Backend is Python stdlib only; no framework, no new dependency. Frontends add no dependency.
- The schema change is additive: `model TEXT` in `_SCHEMA` plus an idempotent `ALTER TABLE` in `init()`, "so master's code keeps reading the DB."
- Validation stays `normalize_model_effort` and `normalize_permission_mode` (`bridge/miniapp/server.py`); on the settings routes "anything invalid gets a 400 and nothing is saved."
- Routes: `POST /api/session/settings` (Mini App) and `POST /local/session/settings` (dashboard), taking `{session_id, model?, permission_mode?}`.
- Control requests: `{"subtype": "set_model", "model": …}` and `{"subtype": "set_permission_mode", "mode": …}` over `Job._write_stdin`.
- A switch to `bypassPermissions` approves every pending entry of kind `permission`; questions (AskUserQuestion) stay open.
- Briefs report `permission_mode` as "the effective interactive mode: `permission_mode or MINIAPP_PERMISSION_MODE`."
- "Internal callers keep their explicit values and do not write them to the session: Rivendell (`bypassPermissions`), trackers (`manual`), next-up (`plan`), goals."
- Family: "the first id segment after `claude-`". Snap: "Fall back to Opus, then to the first model, only when the family isn't offered." Nothing snaps before the server's list arrives.
- Out of scope, verbatim: "effort and ponytail stay per-device. The Mini App SYSTEM tab's `MODE ·` line (the server fallback, not the session's mode) is left as it is."
- Repo rules: `ponytail:` comments are load-bearing; module docstrings carry the why; `tests/conftest.py` pins env before `bridge.config` is imported, so no env setup in a test module. Manual scripts run with `BRIDGE_DB=/tmp/plan-srs.db`; never `~/.bridge_state`.
- Work only in `/home/mhzrerfani/projects/.worktrees/mystical-assistant/feat-session-run-settings` (branch `feat/session-run-settings`). Never restart the bridge, never push. Commit messages carry no `Co-Authored-By` and no "Generated with" line.

## Review Focus

The spec doesn't test these five cases, and they are the most likely to bite. Each has a test in the task named.

1. **A turn that has printed `result` but whose child is still alive** (waiting on background agents, open-ended since 666d29a1). Its stdin is already closed, so the pick must save, report "not live", and approve nothing blind. Task 4: `test_a_turn_with_no_live_channel_says_so_and_approves_nothing`.
2. **A malformed body on the internet-facing settings route.** This covers a non-string model or mode, an unknown value, and a valid half next to a bad one. Expect a 400 with nothing saved and nothing switched. Task 6: `test_an_invalid_pick_is_a_400_and_changes_nothing`.
3. **Another chat's session id, or none**, on either settings route. Expect a 404, no save and no control request. Task 6: `test_someone_elses_session_is_a_404`.
4. **A session that never ran from a composer** (fresh, bot or VS Code; `model` is NULL), a stored legacy `""` mode, or a brief from an older bridge with neither field. Expect this device's picks rather than the bridge's new-session bypass. `""` defers to the session, and an old brief changes nothing. Tasks 8 and 9: the `runPicks` cases in `models.check.ts`.
5. **The CLI refusing a control request** (bypass disabled by settings, or an unknown model). Expect a visible error row, the saved pick standing, and the turn carrying on. Task 4: `test_a_refused_control_request_leaves_an_error_row`.

## Verified 2026-10-06: spec drift and evidence

- **Bypass needs an offer at spawn (spec gap, verified live).** The spec says "CLI 2.1.280 supports both" control requests. That holds for the subtypes, but `set_permission_mode → bypassPermissions` on a child launched in any other mode is refused with `{"subtype":"error","error":"Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions"}`.
  - The check lives in the 2.1.280 binary (`Nge()`: `if(!o.isBypassPermissionsModeAvailable)return{ok:!1,error:…}`), and availability is set only by a bypass launch mode or `--allow-dangerously-skip-permissions`.
  - Haiku probes (`--setting-sources project --no-session-persistence`, no hooks), with a default-mode turn running two `touch` calls and the switch sent at the first card:
    - without the flag, the switch errors and the second tool asks too (2 cards);
    - with the flag, the switch succeeds (`system/status permissionMode=bypassPermissions`) and the second tool doesn't ask (1 card).
  - `set_model` mid-turn works: the next request ran on `claude-sonnet-5`. An unknown model answers `Model '…' not found`.
  - Task 4 adds the flag to every interactive spawn.
  - Static reading of 2.1.280 says the flag changes nothing else under `-p`. Plan mode's bypass-when-available path (`$F`) requires an interactive session, so it doesn't fire. One edge: in plan mode entered from `auto`, the auto classifier stops running when bypass is available (`b0e`).
- **666d29a1 (master moved).** `_run_env` (`bridge/runner.py:162-185`) gained `CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS=0`, which shifts the runner's later lines by about five. The behavioural change matters more. A child that printed `result` can now live as long as its background agents. Its stdin was already closed at `result` (`runner.py:1936-1939`), though, so a live switch cannot reach it. `Job.set_run_settings` reports False and the save alone carries the pick (Review Focus 1).
- **Line references.** `miniapp/web/src/lib/chat.tsx:300` is exact. For `dashboard/web/src/App.tsx:1605`, the effect is at 1606-1609 (1604-1605 is its comment). `store.set_permission_mode` still has one caller (`runner.py:2049`, `_adopt_native`).
- **"The bridge logs it" has no code yet.** The CLI's `control_response` lines fall through `_handle_event` (`runner.py:1525`) and are dropped silently. Task 4 adds an error row.
- **Lazy create is not built.** The spec's "a fresh, not-yet-created session sends its picks with its first prompt" assumes it. In practice both apps create a session on New: dashboard `newSession` (`App.tsx:1327`) and `startIn` (`:1286`), Mini App `newChat` (`chat.tsx:643`) and `heldStartNew` (`:573`). The new session carries `NEW_SESSION_PERMISSION_MODE` (bypass) and no model. See decision 4.
- **Recovery with `model=None` drops Rivendell's model.** Rivendell creates its own sessions (`rivendell.py:821-831`) with a mode but no model. A boot-resumed plugin turn would run on the CLI default. See decision 8.
- **One brief, both lists.** The dashboard's session list *is* `_session_brief` (`dashboard/server.py:379`), so one edit covers both. `tests/test_bridge.py:445-449` pins the brief's exact key set and must gain the two keys (Task 5).
- **The bot's mode branch adds `--strict-mcp-config`** (`runner.py:399-404`). That changes nothing: a bot run already got it from the `disabled_tools is None` branch (`runner.py:407-416`).
- **Baselines.** Backend: `python3 -m pytest tests/ -q` gives 1460 passed, 2 skipped (CLAUDE.md's 1007 is stale). Dashboard `tsc -p tsconfig.app.json` reports one error before any change: `src/components/Markdown.tsx(4,26): error TS2307: Cannot find module 'remark-breaks'`. The shared `node_modules` predates 4a73fed3, which added the dependency. The Mini App tsc is clean.
- **Backfill on real data.** On a read-only copy of the live DB (1479 sessions, 3367 turns) the backfill took 4 ms. 1143 sessions got a model, and `adc154ec` got `claude-opus-5-5` (mode `bypassPermissions`), matching the spec's account.
- **Dry run.** Every code block below was applied to a throwaway copy of this tree (since deleted). The backend went to 1498 passed, 2 skipped; both `tsc` runs stayed at baseline; every `.check.ts` passed. A headless before/after on the Mini App read back `claude-opus-5-5` / "Opus 5.5" on master and `claude-fable-5-1` / "Fable 5.1" on the change. Task 10's live script printed `LIVE SWITCH OK` with exactly one permission card.

## Decisions the spec left open

1. **`--allow-dangerously-skip-permissions` on every interactive spawn.** This puts bypass on offer without turning it on. Only the bridge writes the child's stdin, so only the settings routes, behind the existing auth, can use it.
2. **`/run` saves after `start_streaming_job`, to `job.store_session_id`.** The spec says before. Saving after means one code path, with the session resolved and ownership-checked by the runner (a lazily created session included), and the run itself is identical because the request's values win.
3. **A pick POSTs the pair the picker shows.** Otherwise a model pick on a fresh session would leave the bridge's mode under a picker showing the device's.
4. **A session with no `model` shows the device's picks** (`runPicks`; see the lazy-create drift). Without this, every New would silently show and run the bridge's bypass over the mode you keep picking.
5. **The family snap is display-only.** It doesn't POST and doesn't write localStorage, so a cold-cache alias list never rewrites a session's stored full id.
6. **The Mini App follows other devices through a 5 s `/api/sessions?project=` query.** It had no session-list poll before; the dashboard already polls every 5 s.
7. **`Job.model` feeds crash resumes, limit parks and goal nudges.** A live switch moves it, so they run what the turn ended on.
8. **Rivendell writes its model onto its own new session**, beside the `bypassPermissions` it already writes. This is not a user session, so "internal callers don't write" still holds.
9. **`store.duplicate` carries `model`**, as it already carries `permission_mode` and `fallback_policy`.
10. **A refusal is a transcript row** `{"type":"log","src":"control","error":true}`, and both apps' `log` type unions gain `"control"`.
11. **Settings routes** answer `200 {"ok": true, "model": str|null, "permission_mode": <effective>}`; 400 for a non-string or invalid value; 404 for a session not owned by the caller. An empty pick is a 200 no-op.
12. **The dashboard's SESSION tab (RUN DEFAULTS) and PROFILES APPLY stay the composer's knobs.** They show and pick for the open session.
13. **The Mini App label** "OPERATING MODE · THIS RUN" becomes "OPERATING MODE". The mode is the session's now.
14. **After a successful send, both apps mirror the sent picks into their local session list.** A session minted for that prompt then doesn't read as never-run until the next poll.
15. **An older bridge 404s the settings route.** The client swallows that, and the pick still rides `/run` as before (bridge-feature-slice: "the client may be newer than the server").

## File structure

| File | Change | Responsibility |
|------|--------|----------------|
| `bridge/store.py` | modify | `sessions.model` + backfill; `set_run_settings`; `duplicate` carries it |
| `bridge/runner.py` | modify | run resolution, `Job.model`, `Job.set_run_settings`, `apply_run_settings`, refusal rows, interactive argv flag, bot chat picks |
| `bridge/recovery.py` | modify | boot resume passes `model=None` |
| `bridge/rivendell.py` | modify | `_new_session` seeds its model |
| `bridge/miniapp/server.py` | modify | `save_run_settings` (shared), brief fields, `/api/run` saves, `/api/session/settings`, enqueue drops picks |
| `bridge/dashboard/server.py` | modify | `/local/run` saves, `/local/session/settings`, enqueue drops picks |
| `tests/test_session_run_settings.py` | create | store + runner logic |
| `tests/test_session_run_settings_endpoint.py` | create | both servers' routes |
| `tests/test_recovery.py`, `tests/test_bridge.py` | modify | changed expectations |
| `bridge/dashboard/web/src/models.ts` (+ `models.check.ts`) | modify / create | `familyOf`, `snapModel`, `runPicks` |
| `bridge/dashboard/web/src/{App.tsx,api.ts}`, `components/{Composer.tsx,design/useSessionQueue.ts,hud/SettingsModal.tsx}`, `lib/theme.ts` | modify | composer state per session, pick → POST, follow, enqueue, "Session" option gone |
| `bridge/miniapp/web/src/lib/models.ts` (+ `models.check.ts`) | modify / create | same three helpers |
| `bridge/miniapp/web/src/lib/{chat.tsx,api.ts}`, `components/Composer.tsx`, `routes/work.tsx` | modify | same, plus the 5 s brief poll |

Bridge-feature-slice rows. 1, no new module: the logic extends `store.py`/`runner.py`. 2-8 are touched as listed. 9, no bot command: the bot change is `handle_task`, so `HELP` is unchanged. 10, no pubsub: the 5 s session poll carries a change, and a mid-turn approval already streams as `permission_resolved`. 11 is the two test files.

## Commands used throughout

- Backend: `cd /home/mhzrerfani/projects/.worktrees/mystical-assistant/feat-session-run-settings && python3 -m pytest tests/ -q` (baseline 1460 passed, 2 skipped).
- A check file: `node bridge/dashboard/web/src/models.check.ts` (from the worktree root; Node 24 strips the types).
- Typecheck: `cd bridge/dashboard/web && node_modules/.bin/tsc -p tsconfig.app.json` (and the same in `bridge/miniapp/web`). Never `tsc -p .`: it checks nothing.
- Line numbers are those of the unedited files at 666d29a1. Within a task an earlier edit shifts the lines after it, so the quoted text is the anchor; every quoted "replace" block was checked to match the current code.

---

### Task 1: `sessions.model` and `store.set_run_settings`

**Files:**
- Modify: `bridge/store.py:39-41` (`_SCHEMA`), `:182-183` (`init()`), `:362-364` (after `set_permission_mode`), `:843-846` (`duplicate`)
- Create: `tests/test_session_run_settings.py`

**Interfaces:**
- Consumes: nothing.
- Produces: column `sessions.model TEXT` (NULL = never picked, so no `--model`); every `store.get_session()` row carries `"model"`. `store.set_run_settings(session_id: str, model: str | None = None, permission_mode: str | None = None) -> None`: None leaves that half alone.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_session_run_settings.py`. The import list is the file's final one: later tasks append sections that use `json`, `subprocess`, `runner` and `state`.

```python
"""Session run settings: a session row carries the model and permission mode last
picked for it, and every run path reads them from there.

Logic only (store + runner). The two servers' routes are in
test_session_run_settings_endpoint.py.
Spec: docs/superpowers/specs/session-run-settings-design.md
"""

import json
import os
import sqlite3
import subprocess
import tempfile

from bridge import config, runner, state, store

store.init()

CHAT = 555


# --- storage -------------------------------------------------------------------

def _old_db(path):
    """A DB from before sessions.model: no such column, and turns carry models."""
    c = sqlite3.connect(path)
    c.executescript("""
        CREATE TABLE sessions (id TEXT PRIMARY KEY, chat_id INTEGER NOT NULL,
          project TEXT NOT NULL, claude_session_id TEXT, title TEXT,
          created REAL NOT NULL, updated REAL NOT NULL,
          archived INTEGER NOT NULL DEFAULT 0, permission_mode TEXT);
        CREATE TABLE turns (id TEXT PRIMARY KEY, session_id TEXT NOT NULL,
          seq INTEGER NOT NULL, prompt TEXT NOT NULL,
          attachments TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL,
          cost REAL, elapsed INTEGER, started REAL NOT NULL, model TEXT);
        INSERT INTO sessions(id, chat_id, project, created, updated, permission_mode)
          VALUES ('picked', 555, '/p', 0, 0, 'bypassPermissions'),
                 ('bot', 555, '/p', 0, 0, NULL),
                 ('blank', 555, '/p', 0, 0, NULL);
        INSERT INTO turns(id, session_id, seq, prompt, status, started, model) VALUES
          ('t0', 'picked', 0, 'a', 'done', 0, 'opus'),
          ('t1', 'picked', 1, 'b', 'done', 0, 'claude-fable-5-1'),
          ('t2', 'picked', 2, 'c', 'error', 0, NULL),
          ('t3', 'bot', 0, 'd', 'done', 0, NULL);
    """)
    c.commit()
    c.close()


def test_an_old_db_gains_the_column_backfilled_from_its_latest_turn(monkeypatch):
    path = os.path.join(tempfile.mkdtemp(), "old.db")
    _old_db(path)
    monkeypatch.setattr(config, "BRIDGE_DB", path)
    store.init()
    assert store.get_session("picked")["model"] == "claude-fable-5-1"   # newest non-null
    assert store.get_session("bot")["model"] is None                    # nobody picked one
    assert store.get_session("blank")["model"] is None                  # never ran
    assert store.get_session("picked")["permission_mode"] == "bypassPermissions"
    # A second boot neither fails nor re-runs the backfill over a newer pick.
    store.set_run_settings("picked", model="claude-opus-5-5")
    store.init()
    assert store.get_session("picked")["model"] == "claude-opus-5-5"


def test_set_run_settings_writes_only_what_it_is_given():
    s = store.create_session(CHAT, "/srs-set", permission_mode="bypassPermissions")
    store.set_run_settings(s["id"], model="claude-fable-5-1")
    row = store.get_session(s["id"])
    assert (row["model"], row["permission_mode"]) == ("claude-fable-5-1", "bypassPermissions")
    store.set_run_settings(s["id"], permission_mode="default")
    row = store.get_session(s["id"])
    assert (row["model"], row["permission_mode"]) == ("claude-fable-5-1", "default")
    store.set_run_settings(s["id"])                     # nothing given: nothing changes
    row = store.get_session(s["id"])
    assert (row["model"], row["permission_mode"]) == ("claude-fable-5-1", "default")


def test_a_duplicate_keeps_the_sources_picks():
    s = store.create_session(CHAT, "/srs-dup", permission_mode="default")
    store.set_run_settings(s["id"], model="claude-fable-5-1")
    copy = store.duplicate(s["id"])
    assert (copy["model"], copy["permission_mode"]) == ("claude-fable-5-1", "default")
```

- [ ] **Step 2: Run them to verify they fail**

Run: `python3 -m pytest tests/test_session_run_settings.py -q`
Expected: 3 failed, with `KeyError: 'model'` and `AttributeError: module 'bridge.store' has no attribute 'set_run_settings'`.

- [ ] **Step 3: Add the column to `_SCHEMA`**

In `bridge/store.py`, replace lines 39-41:

```python
  ctx_tokens        INTEGER,
  autocompact       TEXT
);
```

with:

```python
  ctx_tokens        INTEGER,
  autocompact       TEXT,
  model             TEXT
);
```

- [ ] **Step 4: Add the migration and backfill to `init()`**

Right after lines 182-183 (`if "work_cwd" not in scols:` / `c.execute("ALTER TABLE sessions ADD COLUMN work_cwd TEXT")`), insert:

```python
        # The model last picked for this session, on any surface
        # (set_run_settings). NULL = never picked: a run passes no --model. Rows
        # from before the column take their latest turn that recorded one.
        if "model" not in scols:
            c.execute("ALTER TABLE sessions ADD COLUMN model TEXT")
            c.execute("UPDATE sessions SET model=(SELECT t.model FROM turns t "
                      "WHERE t.session_id=sessions.id AND t.model IS NOT NULL "
                      "ORDER BY t.seq DESC LIMIT 1)")
```

`turns.model` already exists by then; `init()` adds it at lines 138-139 for very old DBs.

- [ ] **Step 5: Add `set_run_settings`**

After `set_permission_mode` (lines 362-364), insert:

```python


def set_run_settings(session_id: str, model: "str | None" = None,
                     permission_mode: "str | None" = None) -> None:
    """Save a model and/or permission-mode pick to the session — the row every
    surface's next run reads (runner.start_streaming_job, handle_task). None
    leaves that half alone; there is no clearing a pick. Only people's picks
    land here (the /run and settings routes): internal callers run their own
    values without writing them. Validated by the servers'
    normalize_model_effort / normalize_permission_mode, not here."""
    with closing(_connect()) as c:
        c.execute("UPDATE sessions SET model=COALESCE(?, model), "
                  "permission_mode=COALESCE(?, permission_mode) WHERE id=?",
                  (model, permission_mode, session_id))
```

- [ ] **Step 6: Let `duplicate` carry the model**

Replace lines 843-846:

```python
        c.execute("UPDATE sessions SET title=?, title_source=?, fork_from=?, "
                  "fallback_policy=?, updated=? WHERE id=?",
                  (title, "manual", src.get("claude_session_id"),
                   src.get("fallback_policy"), now, copy["id"]))
```

with:

```python
        c.execute("UPDATE sessions SET title=?, title_source=?, fork_from=?, "
                  "fallback_policy=?, model=?, updated=? WHERE id=?",
                  (title, "manual", src.get("claude_session_id"),
                   src.get("fallback_policy"), src.get("model"), now, copy["id"]))
```

- [ ] **Step 7: Run the tests, then the suite**

Run: `python3 -m pytest tests/test_session_run_settings.py -q`
Expected: 3 passed.
Run: `python3 -m pytest tests/ -q`
Expected: 1463 passed, 2 skipped.

- [ ] **Step 8: Commit**

```bash
git add bridge/store.py tests/test_session_run_settings.py
git commit -m "store: sessions.model + set_run_settings — the row carries a session's model pick"
```

---

### Task 2: A run with no picks of its own runs its session's

**Files:**
- Modify: `bridge/runner.py:592` (`Job.__init__`), `:2109-2111` (`start_streaming_job` docstring), `:2127-2129` (resolution)
- Test: `tests/test_session_run_settings.py` (append)

**Interfaces:**
- Consumes: `session["model"]` (Task 1).
- Produces: `Job.model: str | None`, the model the child was started on (Task 4 updates it on a live switch, Task 3 reads it at the turn's end). The rule in `start_streaming_job`: `model = model or session.get("model")`, recorded on the turn and passed to `_run_streaming`. `permission_mode` resolution is unchanged (`_finalize_run_context`).

- [ ] **Step 1: Append the failing tests**

```python


# --- a run resolves to the session's picks --------------------------------------

def _start(monkeypatch, **kw):
    """start_streaming_job up to the spawn: what _run_streaming would have been
    handed, plus the job. Releases the run slot the stubbed turn never will."""
    from bridge import titler
    seen = {}
    monkeypatch.setattr(runner, "_jobs", {})
    monkeypatch.setattr(titler, "kick", lambda *a, **k: None)
    monkeypatch.setattr(runner, "_run_streaming",
                        lambda job, prompt, images, cwd, model, effort, perm, ponytail:
                        seen.update(model=model, perm=perm))
    job = runner.start_streaming_job(CHAT, "go", [], project=config.BASE_PATH, **kw)
    state.release_run(job.store_session_id)
    return job, seen


def test_a_run_with_no_picks_of_its_own_runs_the_sessions(monkeypatch):
    s = store.create_session(CHAT, "/srs-run", cwd=config.BASE_PATH,
                             permission_mode="default")
    store.set_run_settings(s["id"], model="claude-fable-5-1")
    job, seen = _start(monkeypatch, session_id=s["id"])
    assert seen == {"model": "claude-fable-5-1", "perm": "default"}
    assert job.model == "claude-fable-5-1"
    # The turn records what it ran on, not the blank it was asked with.
    assert store.transcript(s["id"])["turns"][-1]["model"] == "claude-fable-5-1"


def test_a_caller_that_brings_picks_runs_them_and_writes_nothing(monkeypatch):
    """Rivendell, trackers, goals: their values win for the run, and the session
    keeps the picks a person made for it."""
    s = store.create_session(CHAT, "/srs-internal", cwd=config.BASE_PATH,
                             permission_mode="bypassPermissions")
    store.set_run_settings(s["id"], model="claude-fable-5-1")
    job, seen = _start(monkeypatch, session_id=s["id"], model="sonnet",
                       permission_mode="manual")
    assert seen == {"model": "sonnet", "perm": "manual"}
    row = store.get_session(s["id"])
    assert (row["model"], row["permission_mode"]) == ("claude-fable-5-1", "bypassPermissions")


def test_a_session_nobody_picked_a_model_for_passes_none(monkeypatch):
    s = store.create_session(CHAT, "/srs-none", cwd=config.BASE_PATH)
    job, seen = _start(monkeypatch, session_id=s["id"])
    assert seen["model"] is None and job.model is None   # no --model: the CLI's default
```

- [ ] **Step 2: Run them to verify they fail**

Run: `python3 -m pytest tests/test_session_run_settings.py -q`
Expected: 2 failed (`seen["model"]` is `None`, and `AttributeError: 'Job' object has no attribute 'model'`), 4 passed.

- [ ] **Step 3: Give `Job` a model**

In `bridge/runner.py`, after line 592 (`self.runtime: str | None = None   # 'opencode:<provider>' when a free agent runs it`), insert:

```python
        self.model: str | None = None     # what the child runs on; a live switch moves it
```

- [ ] **Step 4: Resolve the model in `start_streaming_job`**

Replace lines 2127-2129:

```python
        session, cwd, perm = _finalize_run_context(
            session, project_dir, permission_mode=permission_mode, origin=origin)
        job = Job(job_id or uuid.uuid4().hex, chat_id, session["id"])
```

with:

```python
        session, cwd, perm = _finalize_run_context(
            session, project_dir, permission_mode=permission_mode, origin=origin)
        # The session's own model unless the caller brought one: the /run routes
        # save theirs to the row; internal callers (Rivendell, trackers, goals)
        # run theirs without writing it. Neither = no --model, the CLI default.
        model = model or session.get("model")
        job = Job(job_id or uuid.uuid4().hex, chat_id, session["id"])
        job.model = model
```

`store.start_turn(..., model=model, ...)` (line 2140) and the `_run_streaming` thread args (line 2147) already take `model`, which is now the resolved one.

- [ ] **Step 5: Say so in the docstring**

Replace lines 2109-2111:

```python
    Resolves (or creates) the store session and runs it in the session's own cwd
    with its own permission posture; --resume continuity comes from that session's
    claude_session_id. `origin` marks where a newly-created session started.
```

with:

```python
    Resolves (or creates) the store session and runs it in the session's own cwd
    with its own model and permission posture (an explicit model/permission_mode
    wins for this run and is not written back); --resume continuity comes from
    that session's claude_session_id. `origin` marks where a newly-created
    session started.
```

- [ ] **Step 6: Run the tests, then the suite**

Run: `python3 -m pytest tests/test_session_run_settings.py -q`
Expected: 6 passed.
Run: `python3 -m pytest tests/ -q`
Expected: 1466 passed, 2 skipped.

- [ ] **Step 7: Commit**

```bash
git add bridge/runner.py tests/test_session_run_settings.py
git commit -m "runner: a run with no model of its own runs its session's"
```

---

### Task 3: Resumes follow the session's model

**Files:**
- Modify: `bridge/runner.py:2008` and `:2014` (`_run_streaming`'s finally), `bridge/recovery.py:48-50`, `bridge/rivendell.py:827-830` (`Worker._new_session`)
- Modify: `tests/test_recovery.py:102`
- Test: `tests/test_session_run_settings.py` (append)

**Interfaces:**
- Consumes: `Job.model` (Task 2), `store.set_run_settings` (Task 1).
- Produces: `_maybe_auto_resume(job, cwd, job.model, effort)` and `goals.continue_after_turn(job, job.model, effort)`, so crash resumes, limit and ladder parks, auth resumes and goal nudges carry the turn's latest model. `recovery.recover` calls `run(..., model=None, ...)`. A Rivendell session row carries `model=Worker.model`.

- [ ] **Step 1: Append the failing tests**

```python


# --- resumes follow the session ---------------------------------------------------

def test_the_turns_end_hands_on_the_model_it_was_switched_to(monkeypatch):
    """Crash resumes, limit parks and goal nudges all take their model from the
    turn's end, so a switch made mid-turn has to be the model they see."""
    from bridge import goals, tailstate, toolsets
    s = store.create_session(CHAT, "/srs-end", cwd=config.BASE_PATH)
    seen = {}
    monkeypatch.setattr(runner, "_maybe_auto_resume",
                        lambda job, cwd, model, effort: seen.update(resume=model) or False)
    monkeypatch.setattr(goals, "continue_after_turn",
                        lambda job, model=None, effort=None: seen.update(goal=model) or False)
    monkeypatch.setattr(tailstate, "kick", lambda job, cwd=None: None)
    monkeypatch.setattr(toolsets, "ready", lambda: True)

    class Popen:                              # the spawn fails at once: straight to finally
        def __init__(self, cmd, **kw):
            raise FileNotFoundError
    monkeypatch.setattr(runner.subprocess, "Popen", Popen)
    job = runner.Job("j-srs-end", CHAT, s["id"])
    job.model = "claude-fable-5-1"            # where a live switch left it
    runner._run_streaming(job, "p", [], config.BASE_PATH, "opus", None, None, None)
    assert seen == {"resume": "claude-fable-5-1", "goal": "claude-fable-5-1"}


def test_a_plugin_run_seeds_its_own_session_with_its_model():
    """Recovery resumes on the session's model (model=None), so a Rivendell
    session, which no person picks for, has to start out carrying its run's."""
    from bridge import rivendell
    w = rivendell.Worker({"id": "srs", "name": "srs", "model": "sonnet"})
    s = store.get_session(w._new_session(config.BASE_PATH))
    assert (s["model"], s["permission_mode"]) == ("sonnet", "bypassPermissions")
```

In `tests/test_recovery.py`, replace line 102:

```python
    assert call["project"] == "/tmp/rez" and call["model"] == "sonnet"
```

with:

```python
    # model=None: the run reads the session's own (a switch made mid-turn
    # included), not the "sonnet" this turn started on.
    assert call["project"] == "/tmp/rez" and call["model"] is None
```

- [ ] **Step 2: Run them to verify they fail**

Run: `python3 -m pytest tests/test_session_run_settings.py tests/test_recovery.py -q`
Expected: 3 failed. `seen` holds `"opus"` for both, Rivendell's session `model` is `None`, and recovery passes `"sonnet"`.

- [ ] **Step 3: Hand on `job.model` at the turn's end**

In `bridge/runner.py`, replace line 2008:

```python
        resumed = not restart_killed and _maybe_auto_resume(job, cwd, model, effort)
```

with:

```python
        # job.model, not `model`: a live switch (Job.set_run_settings) moves it,
        # and the resume, a limit park and a goal nudge must run what the turn
        # ended on, not what it started on.
        resumed = not restart_killed and _maybe_auto_resume(job, cwd, job.model, effort)
```

and line 2014:

```python
            resumed = goals.continue_after_turn(job, model, effort) or resumed
```

with:

```python
            resumed = goals.continue_after_turn(job, job.model, effort) or resumed
```

- [ ] **Step 4: Boot recovery resumes on the session's model**

In `bridge/recovery.py`, replace lines 48-50:

```python
            job = run(t["chat_id"], NUDGE, [], project=t["cwd"],
                      session_id=sid, model=t["model"],
                      account_slot=slot, runtime=runtime)
```

with:

```python
            # model=None: the session's own, read when the run starts, so a pick
            # made while the turn ran (a live switch) survives the restart.
            job = run(t["chat_id"], NUDGE, [], project=t["cwd"],
                      session_id=sid, model=None,
                      account_slot=slot, runtime=runtime)
```

- [ ] **Step 5: Rivendell's sessions carry Rivendell's model**

In `bridge/rivendell.py`, replace lines 827-830:

```python
        session = store.create_session(
            config.DASH_CHAT_ID, rel(workdir), session_id=uuid.uuid4().hex,
            origin=self.origin, cwd=workdir, permission_mode="bypassPermissions")
        return session["id"]
```

with:

```python
        session = store.create_session(
            config.DASH_CHAT_ID, rel(workdir), session_id=uuid.uuid4().hex,
            origin=self.origin, cwd=workdir, permission_mode="bypassPermissions")
        # Its model on the row beside its mode: a resume (boot recovery, a limit
        # park) runs the session's model, and nobody picks one for a plugin run.
        store.set_run_settings(session["id"], model=self.model)
        return session["id"]
```

- [ ] **Step 6: Run the tests, then the suite**

Run: `python3 -m pytest tests/test_session_run_settings.py tests/test_recovery.py tests/test_rivendell.py -q`
Expected: all passed.
Run: `python3 -m pytest tests/ -q`
Expected: 1468 passed, 2 skipped.

- [ ] **Step 7: Commit**

```bash
git add bridge/runner.py bridge/recovery.py bridge/rivendell.py tests/test_session_run_settings.py tests/test_recovery.py
git commit -m "runner: resumes follow the session's model — the turn's end, boot recovery, Rivendell's own rows"
```

---

### Task 4: Switch a running turn over the control channel

**Files:**
- Modify: `bridge/runner.py:346-348` (interactive argv), `:634-645` (`_write_stdin`), after `:721` (`Job.set_run_settings`), after `:831` (`apply_run_settings`), after `:1609` (`_handle_event`)
- Test: `tests/test_session_run_settings.py` (append)

**Interfaces:**
- Consumes: `Job.model` (Task 2), `Job.respond`, `_latest_jobs`.
- Produces:
  - `Job._write_stdin(obj: dict) -> bool`: True once written; False with no child or a dead stdin.
  - `Job.set_run_settings(model: str | None = None, permission_mode: str | None = None) -> bool`: whether anything reached the child.
  - `runner.apply_run_settings(session_id: str, model: str | None = None, permission_mode: str | None = None) -> bool`.
  - Transcript event `{"type": "log", "src": "control", "error": True, "text": <CLI error>}` on a refused control request.

- [ ] **Step 1: Append the failing tests**

```python


# --- switching a running turn ------------------------------------------------------

class _Stdin:
    """The child's stdin: records each JSON line; refuses writes once closed, as a
    real pipe does after claude -p's `result`."""
    closed = False

    def __init__(self):
        self.lines = []

    def write(self, s):
        if self.closed:
            raise ValueError("I/O operation on closed file")
        self.lines.append(json.loads(s))

    def flush(self):
        pass


class _Proc:
    def __init__(self):
        self.stdin = _Stdin()

    def poll(self):
        return None


def _live_job(sid, *pending, job_id=None):
    job = runner.Job(job_id or f"j-{sid}", CHAT, sid)
    job.proc = _Proc()
    for p in pending:
        job.add_pending(dict(p))
    return job


PERM = {"request_id": "p1", "kind": "permission", "tool_name": "Bash",
        "summary": "touch a", "input": {"command": "touch a"}}
QUESTION = {"request_id": "q1", "kind": "question", "tool_name": "AskUserQuestion",
            "questions": []}


def test_interactive_runs_offer_bypass_so_a_switch_can_reach_it():
    """claude 2.1.280 refuses set_permission_mode -> bypassPermissions on a child
    launched without bypass on offer (checked live 2026-10-06)."""
    assert "--allow-dangerously-skip-permissions" in runner._base_cmd(
        "p", CHAT, stream=True, interactive=True, permission_mode="default")
    # The bot's one-shot has no control channel to switch over.
    assert "--allow-dangerously-skip-permissions" not in runner._base_cmd(
        "p", CHAT, stream=False)


def test_a_switch_writes_one_control_request_per_setting():
    job = _live_job("s-switch")
    assert job.set_run_settings(model="claude-fable-5-1", permission_mode="acceptEdits")
    assert [l["request"] for l in job.proc.stdin.lines] == [
        {"subtype": "set_model", "model": "claude-fable-5-1"},
        {"subtype": "set_permission_mode", "mode": "acceptEdits"}]
    assert all(l["type"] == "control_request" and l["request_id"]
               for l in job.proc.stdin.lines)
    assert job.model == "claude-fable-5-1"


def test_a_switch_to_bypass_approves_waiting_permissions_not_questions():
    job = _live_job("s-bypass", PERM, QUESTION)
    job.set_run_settings(permission_mode="bypassPermissions")
    switch, allow = job.proc.stdin.lines
    # The mode lands before the approval, so the tool after this one doesn't ask.
    assert switch["request"] == {"subtype": "set_permission_mode", "mode": "bypassPermissions"}
    assert allow == {"type": "control_response", "response": {
        "subtype": "success", "request_id": "p1",
        "response": {"behavior": "allow", "updatedInput": {"command": "touch a"}}}}
    assert [p["request_id"] for p in job.pending] == ["q1"]   # a decision, not a permission
    assert {"type": "permission_resolved", "request_id": "p1",
            "behavior": "allow"} in job.events


def test_other_modes_leave_waiting_cards_alone():
    job = _live_job("s-ask", PERM)
    job.set_run_settings(permission_mode="acceptEdits")
    assert [p["request_id"] for p in job.pending] == ["p1"]


def test_a_turn_with_no_live_channel_says_so_and_approves_nothing():
    """No child yet (boot, or a free agent), or a stdin claude -p closed at
    `result` -- since 666d29a1 such a child can stay up for as long as its
    background agents run. The saved row is then all the next turn needs."""
    assert runner.Job("j-nochild", CHAT, "s-nochild").set_run_settings(model="opus") is False
    done = _live_job("s-closed", PERM)
    done.proc.stdin.closed = True
    assert done.set_run_settings(model="opus", permission_mode="bypassPermissions") is False
    assert [p["request_id"] for p in done.pending] == ["p1"]    # nothing approved blind
    assert done.model is None


def test_apply_run_settings_reaches_the_sessions_newest_job(monkeypatch):
    monkeypatch.setattr(runner, "_jobs", {})
    old = _live_job("s-apply", job_id="j-old")
    new = _live_job("s-apply", job_id="j-new")
    old.started, new.started = 1.0, 2.0
    runner._register(old)
    runner._register(new)
    assert runner.apply_run_settings("s-apply", model="claude-fable-5-1") is True
    assert new.proc.stdin.lines and not old.proc.stdin.lines
    assert runner.apply_run_settings("s-nobody", model="opus") is False


def test_a_refused_control_request_leaves_an_error_row():
    job = runner.Job("j-refused", CHAT)
    runner._handle_event(job, {"type": "control_response", "response": {
        "subtype": "error", "request_id": "r1",
        "error": "Cannot set permission mode to bypassPermissions because it is "
                 "disabled by settings or configuration"}})
    ev = job.events[-1]
    assert (ev["type"], ev["src"], ev["error"]) == ("log", "control", True)
    assert "disabled by settings" in ev["text"]
    runner._handle_event(job, {"type": "control_response", "response": {
        "subtype": "success", "request_id": "r2", "response": {"mode": "plan"}}})
    assert job.events[-1] is ev                               # an accepted one is silent
```

- [ ] **Step 2: Run them to verify they fail**

Run: `python3 -m pytest tests/test_session_run_settings.py -q`
Expected: 7 failed (no flag in the argv, no `set_run_settings`, no `apply_run_settings`, no error row), 8 passed.

- [ ] **Step 3: Put bypass on offer at spawn**

In `bridge/runner.py`, replace lines 346-348:

```python
        cmd += ["--input-format", "stream-json",
                "--permission-mode", permission_mode or config.MINIAPP_PERMISSION_MODE,
                "--permission-prompt-tool", "stdio"]
```

with:

```python
        cmd += ["--input-format", "stream-json",
                "--permission-mode", permission_mode or config.MINIAPP_PERMISSION_MODE,
                # Bypass on offer, not on: the mode above is what runs until a
                # pick switches it mid-turn (Job.set_run_settings), and claude
                # 2.1.280 refuses that switch to bypassPermissions on a child
                # launched without this ("not launched with
                # --dangerously-skip-permissions"). Only the bridge writes this
                # child's stdin, so only the settings routes can use it.
                "--allow-dangerously-skip-permissions",
                "--permission-prompt-tool", "stdio"]
```

- [ ] **Step 4: Make `_write_stdin` say whether it wrote**

Replace lines 634-645:

```python
    def _write_stdin(self, obj: dict):
        """Write one JSON line to the live process's stdin (control channel)."""
        proc = self.proc
        if proc is None or proc.stdin is None:
            return
        line = json.dumps(obj) + "\n"
        with self._stdin_lock:
            try:
                proc.stdin.write(line)
                proc.stdin.flush()
            except (BrokenPipeError, ValueError, OSError):
                pass
```

with:

```python
    def _write_stdin(self, obj: dict) -> bool:
        """Write one JSON line to the live process's stdin (control channel).
        False when nothing took it: no child yet, or its stdin is gone (closed
        at the turn's `result`, or the child exited)."""
        proc = self.proc
        if proc is None or proc.stdin is None:
            return False
        line = json.dumps(obj) + "\n"
        with self._stdin_lock:
            try:
                proc.stdin.write(line)
                proc.stdin.flush()
            except (BrokenPipeError, ValueError, OSError):
                return False
        return True
```

The existing callers (`interrupt`, `respond`, `steer`, the prompt write) ignore the result.

- [ ] **Step 5: Add `Job.set_run_settings`**

After `respond()`, which ends at line 721 with `return True`, insert:

```python

    def set_run_settings(self, model: "str | None" = None,
                         permission_mode: "str | None" = None) -> bool:
        """Switch the live child's model and/or permission mode mid-turn, over
        the stream-json control channel interrupt() uses: claude 2.1.280's
        `set_model` / `set_permission_mode` control requests (bypass needs the
        offer _base_cmd makes at spawn). Returns whether anything reached the
        child; False means the caller's saved row is all the next turn gets.

        A switch to bypassPermissions also approves every permission card
        already waiting — "stop asking" has to cover the one on screen.
        Questions (AskUserQuestion) stay open: they ask for a decision, not a
        permission. The CLI answers each request on stdout; a refusal becomes an
        error row (_handle_event) and the saved pick still stands.

        ponytail: a pick that lands before the child spawns (the MCP health
        check at boot) misses this turn, and a can_use_tool already in the
        stdout pipe when bypass is sent still shows its card. Both are saved
        or answerable; re-read the row at spawn if either ever matters."""
        def control(request: dict) -> bool:
            return self._write_stdin({"type": "control_request",
                                      "request_id": uuid.uuid4().hex,
                                      "request": request})
        sent = False
        if model and control({"subtype": "set_model", "model": model}):
            self.model, sent = model, True
        if permission_mode and control({"subtype": "set_permission_mode",
                                        "mode": permission_mode}):
            sent = True
            if permission_mode == "bypassPermissions":
                with self._lock:
                    waiting = [p["request_id"] for p in self.pending
                               if p.get("kind") == "permission"]
                for rid in waiting:
                    self.respond(rid, behavior="allow")
        return sent
```

- [ ] **Step 6: Add `apply_run_settings`**

After `boot_phase()` (lines 825-831), insert:

```python


def apply_run_settings(session_id: str, model: "str | None" = None,
                       permission_mode: "str | None" = None) -> bool:
    """Switch a session's in-flight turn to a pick its row already holds (the
    settings routes save first). False when nothing live took it. The newest
    job is the only one that can still be live; whether it is, is
    Job.set_run_settings' call (a closed stdin says no)."""
    job = _latest_jobs().get(session_id)
    return job.set_run_settings(model=model, permission_mode=permission_mode) if job else False
```

This is not `steer()`'s `status == "running"` lookup. A turn that printed `result` reads "done" while its child is still up, and the stdin check decides that case.

- [ ] **Step 7: Turn a refusal into a row**

In `_handle_event`, after lines 1608-1609 (`elif t == "system" and d.get("subtype") == "hook_response":` / `_hook_log(job, d)`), insert:

```python
    elif t == "control_response":
        # The CLI's answer to one of ours (interrupt, set_model,
        # set_permission_mode). Only a refusal earns a row: the pick it carried
        # is saved either way, and the next turn spawns with it.
        r = d.get("response") or {}
        if r.get("subtype") == "error":
            job.add({"type": "log", "src": "control", "error": True,
                     "text": str(r.get("error") or "control request refused")[:_LOG_MAX]})
```

The stdout loop already routes `control_response` lines here; only `control_request` is intercepted before `_handle_event` (`runner.py:1932-1934`).

- [ ] **Step 8: Run the tests, then the suite**

Run: `python3 -m pytest tests/test_session_run_settings.py -q`
Expected: 15 passed.
Run: `python3 -m pytest tests/ -q`
Expected: 1475 passed, 2 skipped.

- [ ] **Step 9: Commit**

```bash
git add bridge/runner.py tests/test_session_run_settings.py
git commit -m "runner: switch a running turn's model and mode over the control channel"
```

---

### Task 5: `/run` saves its picks, briefs carry them, enqueue leaves them to the session

**Files:**
- Modify: `bridge/miniapp/server.py:151` (`_session_brief`), `:533-537` (`_api_run`), `:767-769` and `:781-783` (`_api_queue_post`)
- Modify: `bridge/dashboard/server.py:1589-1592` (`_run`), `:1629-1632` and `:1650-1652` (`_queue` enqueue)
- Modify: `tests/test_bridge.py:445-449` (the pinned brief shape)
- Create: `tests/test_session_run_settings_endpoint.py`

**Interfaces:**
- Consumes: `store.set_run_settings` (Task 1), the resolution in `start_streaming_job` (Task 2).
- Produces:
  - `_session_brief` gains `"model": str | None` and `"permission_mode": str` (always set: stored, else `config.MINIAPP_PERMISSION_MODE`). Both apps read these in Tasks 8 and 9.
  - Both `/run` routes call `store.set_run_settings(job.store_session_id, model=…, permission_mode=…)` after a successful start.
  - Dashboard and Mini App enqueue store `model=None, permission_mode=None`. Rivendell's and goals' direct `queue_manager.enqueue` calls are untouched.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_session_run_settings_endpoint.py`. Its import list is the file's final one (Task 6 appends to it):

```python
"""The two servers' half of session run settings: briefs carry a session's picks,
/run saves the ones it was sent, enqueue leaves them to the session, and
POST …/session/settings saves a pick and switches the running turn.

Socket-free via Handler.__new__ (the test_context_meter.py pattern).
Spec: docs/superpowers/specs/session-run-settings-design.md
"""

import json
from types import SimpleNamespace

import pytest

from bridge import config, models, queue_manager, relevance, runner, store
from bridge.dashboard import server as dash
from bridge.miniapp import server as mini
from bridge.queue_manager import PreviewQueue

store.init()

CHAT = 555          # config.DASH_CHAT_ID under conftest, and an allowed Mini App user


def _handler(mod):
    h = mod.Handler.__new__(mod.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


@pytest.fixture(autouse=True)
def offline(monkeypatch):
    """Model validation asks models.model_ids(), which would start a Models API
    fetch; a brief of a session with no tool choice asks `claude mcp list` (~6s)."""
    monkeypatch.setattr(models, "model_ids", lambda: {"claude-fable-5-1", "claude-opus-5-5"})
    monkeypatch.setattr(store, "default_disabled_tools", lambda: [])


# --- the briefs -------------------------------------------------------------------

def test_briefs_carry_the_model_and_the_effective_mode():
    s = store.create_session(CHAT, "/srs-brief", permission_mode="default")
    store.set_run_settings(s["id"], model="claude-fable-5-1")
    b = mini._session_brief(store.get_session(s["id"]))
    assert (b["model"], b["permission_mode"]) == ("claude-fable-5-1", "default")
    # No mode stored (a session the bot started): the one an interactive run uses.
    bot = mini._session_brief(store.create_session(CHAT, "/srs-brief-bot"))
    assert bot["model"] is None
    assert bot["permission_mode"] == config.MINIAPP_PERMISSION_MODE


# --- /run saves what it was sent --------------------------------------------------

def _fake_start(monkeypatch, sid):
    seen = {}

    def start(chat, prompt, paths, project=None, **kw):
        seen.update(kw)
        return SimpleNamespace(id="j-run", store_session_id=sid)
    monkeypatch.setattr(runner, "start_streaming_job", start)
    monkeypatch.setattr(relevance, "gate", lambda *a, **k: None)
    return seen


def _run(surface, body):
    h, box = _handler(dash if surface == "dashboard" else mini)
    (h._run if surface == "dashboard" else h._api_run)(CHAT, body)
    return box


@pytest.mark.parametrize("surface", ["dashboard", "miniapp"])
def test_run_saves_the_picks_it_was_sent(monkeypatch, surface):
    s = store.create_session(CHAT, f"/srs-run-{surface}", permission_mode="bypassPermissions")
    seen = _fake_start(monkeypatch, s["id"])
    box = _run(surface, {"prompt": "hi", "session_id": s["id"],
                         "model": "claude-fable-5-1", "permission_mode": "default"})
    assert box["code"] == 200
    assert (seen["model"], seen["permission_mode"]) == ("claude-fable-5-1", "default")
    row = store.get_session(s["id"])
    assert (row["model"], row["permission_mode"]) == ("claude-fable-5-1", "default")


@pytest.mark.parametrize("surface", ["dashboard", "miniapp"])
def test_a_run_without_picks_leaves_the_sessions_alone(monkeypatch, surface):
    s = store.create_session(CHAT, f"/srs-run0-{surface}", permission_mode="default")
    store.set_run_settings(s["id"], model="claude-fable-5-1")
    _fake_start(monkeypatch, s["id"])
    assert _run(surface, {"prompt": "hi", "session_id": s["id"]})["code"] == 200
    row = store.get_session(s["id"])
    assert (row["model"], row["permission_mode"]) == ("claude-fable-5-1", "default")


# --- enqueue leaves model + mode to the session ------------------------------------

@pytest.fixture()
def held_queue(monkeypatch):
    q = PreviewQueue(run_fn=lambda item: None, persist_path=None)   # busy: items stay queued
    monkeypatch.setattr(queue_manager, "_instance", q)
    return q


def test_dashboard_enqueue_drops_model_and_mode(held_queue):
    h, box = _handler(dash)
    h._queue("enqueue", CHAT, {"session_id": "s-q-dash", "text": "later", "effort": "high",
                               "model": "claude-opus-5-5", "permission_mode": "default"})
    assert box["code"] == 200
    [it] = held_queue.snapshot("s-q-dash")["items"]
    assert (it["model"], it["permission_mode"], it["effort"]) == (None, None, "high")


def test_miniapp_enqueue_drops_model_and_mode(held_queue):
    s = store.create_session(CHAT, "/srs-q-mini")
    h, box = _handler(mini)
    h._api_queue_post(CHAT, {"op": "enqueue", "session_id": s["id"], "prompt": "later",
                             "effort": "high", "model": "claude-opus-5-5",
                             "permission_mode": "default"})
    assert box["code"] == 200
    [it] = held_queue.snapshot(s["id"])["items"]
    assert (it["model"], it["permission_mode"], it["effort"]) == (None, None, "high")
```

In `tests/test_bridge.py`, replace lines 448-449:

```python
                      "ctx_tokens", "ctx_window", "autocompact", "work_cwd",
                      "worktree"}
```

with:

```python
                      "ctx_tokens", "ctx_window", "autocompact", "work_cwd",
                      "worktree", "model", "permission_mode"}
```

- [ ] **Step 2: Run them to verify they fail**

Run: `python3 -m pytest tests/test_session_run_settings_endpoint.py tests/test_bridge.py::test_session_brief_shape -q`
Expected: 6 failed, 2 passed. The failures are both brief tests (no keys), `test_run_saves_the_picks_it_was_sent[*]` and both enqueue tests. `test_a_run_without_picks_leaves_the_sessions_alone[*]` already passes; it guards the "None leaves it alone" half.

- [ ] **Step 3: The brief carries the picks**

In `bridge/miniapp/server.py`, after line 151 (`"autocompact": s.get("autocompact"),`), insert:

```python
            # The session's run picks (store.set_run_settings), which both
            # composers load. The mode as an interactive run would get it: the
            # stored one, else the bridge's default — never a blank to guess at.
            "model": s.get("model"),
            "permission_mode": s.get("permission_mode") or config.MINIAPP_PERMISSION_MODE,
```

- [ ] **Step 4: Both `/run` routes save what they were sent**

In `bridge/miniapp/server.py` (`_api_run`), and also in `bridge/dashboard/server.py` (`_run`, lines 1589-1592), replace the tail:

```python
        if job is None:
            runner._cleanup_uploads(job_id)
            return self._json({"error": "busy"}, 409)
        self._json({"job_id": job.id, "session_id": job.store_session_id})
```

with:

```python
        if job is None:
            runner._cleanup_uploads(job_id)
            return self._json({"error": "busy"}, 409)
        # The picks this prompt was sent with are the session's now, on every
        # surface. After the start, so the row is the one the run resolved for
        # this chat (a fresh session is created by this very call).
        store.set_run_settings(job.store_session_id, model=model,
                               permission_mode=permission_mode)
        self._json({"job_id": job.id, "session_id": job.store_session_id})
```

(Mini App lines 534-537.) The block is unique in each file: the dashboard's tracker route (lines 1335-1337) ends differently, and so does the Mini App's.

- [ ] **Step 5: Enqueue leaves model and mode to the session**

In `bridge/miniapp/server.py` (`_api_queue_post`), replace lines 767-769:

```python
            ok, model, effort = normalize_model_effort(body.get("model"), body.get("effort"))
            if not ok:
                return self._json({"error": "invalid model"}, 400)
```

with:

```python
            # No model or mode: a queued prompt runs on the session's when it
            # starts, so a pick made while it waits still applies.
            _ok, _model, effort = normalize_model_effort(None, body.get("effort"))
```

and lines 782-783:

```python
                sid, text=prompt, prompt=prompt, images=paths, model=model, effort=effort,
                permission_mode=normalize_permission_mode(body.get("permission_mode")),
```

with:

```python
                sid, text=prompt, prompt=prompt, images=paths, model=None, effort=effort,
                permission_mode=None,
```

In `bridge/dashboard/server.py` (`_queue`, enqueue branch), replace lines 1629-1632:

```python
            ok, model, effort = normalize_model_effort(body.get("model"), body.get("effort"))
            if not ok:
                return self._json({"error": "invalid model"}, 400)
            permission_mode = normalize_permission_mode(body.get("permission_mode"))
```

with:

```python
            # No model or mode: a queued prompt runs on the session's when it
            # starts, so a pick made while it waits still applies.
            _ok, _model, effort = normalize_model_effort(None, body.get("effort"))
```

and lines 1651-1652:

```python
                sid, text=(text or prompt), prompt=prompt, images=paths, model=model,
                effort=effort, permission_mode=permission_mode, width=width, sel=sel,
```

with:

```python
                sid, text=(text or prompt), prompt=prompt, images=paths, model=None,
                effort=effort, permission_mode=None, width=width, sel=sel,
```

`queue_manager._default_run_fn` passes the item's `None`s to `start_streaming_job`, which resolves the session's at start (Task 2).

- [ ] **Step 6: Run the tests, then the suite**

Run: `python3 -m pytest tests/test_session_run_settings_endpoint.py -q`
Expected: 7 passed.
Run: `python3 -m pytest tests/ -q`
Expected: 1482 passed, 2 skipped.

- [ ] **Step 7: Commit**

```bash
git add bridge/miniapp/server.py bridge/dashboard/server.py tests/test_session_run_settings_endpoint.py tests/test_bridge.py
git commit -m "servers: /run saves its picks to the session, briefs carry them, enqueue leaves them to it"
```

---

### Task 6: `POST /api/session/settings` and `POST /local/session/settings`

**Files:**
- Modify: `bridge/miniapp/server.py` (new `save_run_settings` after `normalize_permission_mode` at lines 89-95; a route after lines 420-422; `_api_session_settings` after `_api_session_autocompact`, which ends at line 661)
- Modify: `bridge/dashboard/server.py:41-44` (import), after `:1019` (route)
- Test: `tests/test_session_run_settings_endpoint.py` (append)

**Interfaces:**
- Consumes: `store.set_run_settings` (Task 1), `runner.apply_run_settings` (Task 4), `normalize_model_effort`, `normalize_permission_mode`.
- Produces: `bridge.miniapp.server.save_run_settings(session: dict, body: dict) -> tuple[dict, int]`. Both routes take `{session_id, model?, permission_mode?}` and answer:
  - `200 {"ok": true, "model": str | null, "permission_mode": str}` (effective);
  - `400` for a non-string or invalid value (nothing saved or switched);
  - `404` for a missing or unowned session.

  The frontends call them in Tasks 8 and 9.

- [ ] **Step 1: Append the failing tests**

```python


# --- POST …/session/settings ----------------------------------------------------

def _settings(surface, body, chat=CHAT):
    """The route as each server dispatches it (the Mini App's past its initData gate)."""
    if surface == "dashboard":
        h, box = _handler(dash)
        h._post_api("/local/session/settings", body)
        return box
    h, box = _handler(mini)
    h._auth = lambda: chat
    h._read_json = lambda: body
    h.path = "/api/session/settings"
    h.do_POST()
    return box


class _Stdin:
    def __init__(self):
        self.lines = []

    def write(self, s):
        self.lines.append(json.loads(s))

    def flush(self):
        pass


PERM = {"request_id": "p1", "kind": "permission", "tool_name": "Bash",
        "summary": "touch a", "input": {"command": "touch a"}}
QUESTION = {"request_id": "q1", "kind": "question", "tool_name": "AskUserQuestion",
            "questions": []}


def _live(monkeypatch, sid, *pending):
    """A fake in-flight turn for `sid`, registered where apply_run_settings looks."""
    monkeypatch.setattr(runner, "_jobs", {})
    job = runner.Job("j-" + sid, CHAT, sid)
    job.proc = SimpleNamespace(stdin=_Stdin(), poll=lambda: None)
    for p in pending:
        job.add_pending(dict(p))
    runner._register(job)
    return job


@pytest.mark.parametrize("surface", ["dashboard", "miniapp"])
def test_a_pick_is_saved_and_switches_the_running_turn(monkeypatch, surface):
    s = store.create_session(CHAT, f"/srs-pick-{surface}", permission_mode="default")
    job = _live(monkeypatch, s["id"], PERM, QUESTION)
    box = _settings(surface, {"session_id": s["id"], "model": "claude-fable-5-1",
                              "permission_mode": "bypassPermissions"})
    assert box["code"] == 200
    assert box["obj"] == {"ok": True, "model": "claude-fable-5-1",
                          "permission_mode": "bypassPermissions"}
    row = store.get_session(s["id"])
    assert (row["model"], row["permission_mode"]) == ("claude-fable-5-1", "bypassPermissions")
    lines = job.proc.stdin.lines
    assert [l["request"] for l in lines if l["type"] == "control_request"] == [
        {"subtype": "set_model", "model": "claude-fable-5-1"},
        {"subtype": "set_permission_mode", "mode": "bypassPermissions"}]
    # The waiting permission card is approved; the question still waits on you.
    assert [l["response"]["request_id"] for l in lines if l["type"] == "control_response"] == ["p1"]
    assert [p["request_id"] for p in job.pending] == ["q1"]


@pytest.mark.parametrize("surface", ["dashboard", "miniapp"])
def test_with_nothing_running_the_save_is_enough(monkeypatch, surface):
    monkeypatch.setattr(runner, "_jobs", {})
    s = store.create_session(CHAT, f"/srs-idle-{surface}")
    box = _settings(surface, {"session_id": s["id"], "permission_mode": "plan"})
    assert box["code"] == 200
    assert box["obj"] == {"ok": True, "model": None, "permission_mode": "plan"}
    assert store.get_session(s["id"])["permission_mode"] == "plan"


@pytest.mark.parametrize("surface", ["dashboard", "miniapp"])
@pytest.mark.parametrize("bad", [{"model": "gpt-5"}, {"permission_mode": "yolo"},
                                 {"model": 5}, {"permission_mode": ["bypassPermissions"]}])
def test_an_invalid_pick_is_a_400_and_changes_nothing(monkeypatch, surface, bad):
    s = store.create_session(CHAT, f"/srs-bad-{surface}", permission_mode="default")
    store.set_run_settings(s["id"], model="claude-opus-5-5")
    job = _live(monkeypatch, s["id"], PERM)
    # A valid half beside the bad one must not slip through on its own.
    box = _settings(surface, {"session_id": s["id"], "model": "claude-fable-5-1",
                              "permission_mode": "plan", **bad})
    assert box["code"] == 400
    row = store.get_session(s["id"])
    assert (row["model"], row["permission_mode"]) == ("claude-opus-5-5", "default")
    assert job.proc.stdin.lines == [] and [p["request_id"] for p in job.pending] == ["p1"]


@pytest.mark.parametrize("surface", ["dashboard", "miniapp"])
def test_someone_elses_session_is_a_404(monkeypatch, surface):
    mine = store.create_session(CHAT, f"/srs-mine-{surface}")
    assert _settings(surface, {"session_id": mine["id"], "model": "claude-opus-5-5"})["code"] == 200
    other = store.create_session(999, f"/srs-other-{surface}", permission_mode="default")
    job = _live(monkeypatch, other["id"], PERM)
    box = _settings(surface, {"session_id": other["id"], "permission_mode": "bypassPermissions"})
    assert box["code"] == 404
    assert store.get_session(other["id"])["permission_mode"] == "default"
    assert job.proc.stdin.lines == []
    assert _settings(surface, {"permission_mode": "plan"})["code"] == 404   # no id at all
```

- [ ] **Step 2: Run them to verify they fail**

Run: `python3 -m pytest tests/test_session_run_settings_endpoint.py -q`
Expected: 14 failed (both routes answer 404 "not found" for everything, so the owned-session check at the top of the 404 test fails too), 7 passed.

- [ ] **Step 3: Add the shared handler body**

In `bridge/miniapp/server.py`, after `normalize_permission_mode` (lines 89-95) and before `AUTOCOMPACT_MIN, AUTOCOMPACT_MAX = …` (line 98), insert:

```python
def save_run_settings(session: dict, body: dict) -> "tuple[dict, int]":
    """POST /api/session/settings and /local/session/settings: one function, so
    both servers take and answer exactly the same.

    Saves a model and/or permission-mode pick to the session, then switches the
    session's running turn to it (runner.apply_run_settings); with nothing
    running, the saved row is what the next turn reads. Either may be omitted.
    Anything invalid is a 400 with nothing saved and nothing switched: every
    surface now runs what this row says, so a bad value would follow the session
    everywhere. Returns (json, status)."""
    m, p = body.get("model"), body.get("permission_mode")
    if not all(v is None or isinstance(v, str) for v in (m, p)):
        return {"error": "model and permission_mode must be strings"}, 400
    ok, model, _ = normalize_model_effort(m, None)
    mode = normalize_permission_mode(p)
    if not ok or ((p or "").strip() and mode is None):
        return {"error": "invalid model or permission_mode"}, 400
    store.set_run_settings(session["id"], model=model, permission_mode=mode)
    runner.apply_run_settings(session["id"], model=model, permission_mode=mode)
    s = store.get_session(session["id"]) or session
    return {"ok": True, "model": s.get("model"),
            "permission_mode": s.get("permission_mode") or config.MINIAPP_PERMISSION_MODE}, 200


```

- [ ] **Step 4: The Mini App route**

In `do_POST`, after lines 420-422 (the `/autocompact` route), insert:

```python
            if path == "/api/session/settings":
                return self._api_session_settings(chat_id, body)
```

After `_api_session_autocompact` (which ends at line 661 with `self._json({"ok": True, "autocompact": value})`), insert:

```python

    def _api_session_settings(self, chat_id: int, body: dict):
        """A model/mode pick for a session: saved, and applied to its running
        turn (save_run_settings)."""
        s = self._owned_session(chat_id, (body.get("session_id") or "").strip())
        if not s:
            return self._json({"error": "not found"}, 404)
        self._json(*save_run_settings(s, body))
```

`/api/session/settings` can't be swallowed: no route above it starts with `/api/session` without the `s/`.

- [ ] **Step 5: The dashboard route**

In `bridge/dashboard/server.py`, extend the import at lines 41-44:

```python
from bridge.miniapp.server import (_SERVABLE, _pre_title, _qs_int, _save_images,
                                   _session_brief,
                                   normalize_model_effort, normalize_permission_mode,
                                   save_run_settings,
                                   transcript_for)
```

In `_post_api`, after the `/autocompact` handler (which ends at line 1019 with `return self._json({"ok": True, "autocompact": value})`), insert:

```python
        if path == "/local/session/settings":
            # A model/mode pick for a session: saved, and applied to its running
            # turn. Same body and answer as the Mini App's (save_run_settings).
            sid = (body.get("session_id") or "").strip()
            s = store.get_session(sid) if sid else None
            if not s or s["chat_id"] != chat:
                return self._json({"error": "not found"}, 404)
            return self._json(*save_run_settings(s, body))
```

Its CSRF gate (Host + Origin + `X-Dash-Token`) is `do_POST`'s, as for every dashboard POST.

- [ ] **Step 6: Run the tests, then the suite**

Run: `python3 -m pytest tests/test_session_run_settings_endpoint.py -q`
Expected: 21 passed.
Run: `python3 -m pytest tests/ -q`
Expected: 1496 passed, 2 skipped.

- [ ] **Step 7: Commit**

```bash
git add bridge/miniapp/server.py bridge/dashboard/server.py tests/test_session_run_settings_endpoint.py
git commit -m "servers: POST session/settings saves a pick and switches the running turn"
```

---

### Task 7: The bot chat runs its session's model and mode

**Files:**
- Modify: `bridge/runner.py:328-329` (`_base_cmd` docstring), `:399-403` (branch comment), `:481-482` (`handle_task` docstring), `:494-495` (the `run_blocking` call)
- Test: `tests/test_session_run_settings.py` (append)

**Interfaces:**
- Consumes: `session["model"]` and `session["permission_mode"]` (Task 1). `handle_task`'s `session` is a full `SELECT *` row from `store.ensure_session` or `create_session` (`dispatch.py:239`, `:124`).
- Produces: bot argv with `--model <session.model>` when set, and `--permission-mode <session.permission_mode> --strict-mcp-config` instead of `EXTRA_CLAUDE_ARGS` when the session has a mode.

- [ ] **Step 1: Append the failing tests**

```python


# --- the bot chat ------------------------------------------------------------------

def _bot_argv(monkeypatch, sid):
    """The claude argv handle_task builds for `sid`, Telegram and side calls stubbed."""
    from bridge import learn, titler
    seen = {}

    def run(cmd, **kw):
        seen["cmd"] = cmd
        return subprocess.CompletedProcess(cmd, 0, stdout=json.dumps(
            {"result": "ok", "session_id": "c-bot", "total_cost_usd": 0}), stderr="")
    monkeypatch.setattr(runner.subprocess, "run", run)
    for name in ("send", "typing", "_graph_pack_for", "_tasks_digest_for",
                 "_dream_pack_for", "_graph_refresh_after_turn"):
        monkeypatch.setattr(runner, name, lambda *a, **k: "")
    monkeypatch.setattr(titler, "kick", lambda *a, **k: None)
    monkeypatch.setattr(learn, "kick", lambda *a, **k: None)
    monkeypatch.setattr(config, "EXTRA_CLAUDE_ARGS", "--permission-mode acceptEdits")
    runner.handle_task(CHAT, "hi", store.get_session(sid))
    return seen["cmd"]


def test_the_bot_chat_runs_the_sessions_model_and_mode(monkeypatch):
    s = store.create_session(CHAT, "/srs-bot", origin="dashboard",
                             permission_mode="bypassPermissions")
    store.set_run_settings(s["id"], model="claude-fable-5-1")
    cmd = _bot_argv(monkeypatch, s["id"])
    assert cmd[cmd.index("--model") + 1] == "claude-fable-5-1"
    assert cmd[cmd.index("--permission-mode") + 1] == "bypassPermissions"
    assert "acceptEdits" not in cmd


def test_a_session_the_bot_started_keeps_extra_claude_args(monkeypatch):
    s = store.create_session(CHAT, "/srs-bot-own", origin="bot")
    cmd = _bot_argv(monkeypatch, s["id"])
    assert "--model" not in cmd
    assert cmd[cmd.index("--permission-mode") + 1] == "acceptEdits"
```

`config.EXTRA_CLAUDE_ARGS` is patched because conftest doesn't pin it, and the bridge exports `.env` into the shells it hosts.

- [ ] **Step 2: Run them to verify they fail**

Run: `python3 -m pytest tests/test_session_run_settings.py -q -k bot`
Expected: `test_the_bot_chat_runs_the_sessions_model_and_mode` fails (`ValueError: '--model' is not in list`); the bot-session test passes.

- [ ] **Step 3: Pass the session's picks**

In `bridge/runner.py`, replace lines 494-495:

```python
        result, sid, cost, is_error = run_blocking(
            chat_id, prompt, resume_id=claude_sid, new_session=is_new, fork=fork)
```

with:

```python
        result, sid, cost, is_error = run_blocking(
            chat_id, prompt, resume_id=claude_sid, new_session=is_new, fork=fork,
            model=session.get("model"), permission_mode=session.get("permission_mode"))
```

- [ ] **Step 4: Document it (the spec's security note goes in the docstring)**

Replace lines 481-482:

```python
def handle_task(chat_id: int, prompt: str, session: dict):
    """Runs in a thread; the caller already claimed `session`'s run slot."""
```

with:

```python
def handle_task(chat_id: int, prompt: str, session: dict):
    """Runs in a thread; the caller already claimed `session`'s run slot.

    Runs on the session's own model and mode, the last ones picked for it on any
    surface. A mode replaces EXTRA_CLAUDE_ARGS (_base_cmd), so a session created
    as bypassPermissions (the dashboard and Mini App default) runs unattended
    here too: the same allow-listed user can already do that from the Mini App.
    An asking mode can't show a card in a chat, so the tools it would ask about
    are denied, as under acceptEdits. A session the bot started has no mode and
    keeps EXTRA_CLAUDE_ARGS."""
```

In `_base_cmd`'s docstring, replace lines 328-329:

```python
    asking permission mode so tool use surfaces Allow/Deny cards. The bot's
    plain-text path stays non-interactive and keeps EXTRA_CLAUDE_ARGS.
```

with:

```python
    asking permission mode so tool use surfaces Allow/Deny cards. The bot's
    plain-text path stays non-interactive and keeps EXTRA_CLAUDE_ARGS, unless its
    session carries a mode (handle_task).
```

Replace the comment at lines 400-403 (the branch at 399, `elif not interactive and permission_mode:`, is unchanged):

```python
        # An internal one-shot that must *read* the repo (the next-up scout).
        # Its own permission mode instead of EXTRA_CLAUDE_ARGS: 'plan' leaves the
        # read tools available and takes editing and shell off the table. Still an
        # internal one-shot, so it skips MCP for the same second it saves above.
```

with:

```python
        # A one-shot with a mode of its own instead of EXTRA_CLAUDE_ARGS: the
        # next-up scout's 'plan' (read tools stay, editing and shell go), or the
        # bot chat running its session's mode (handle_task). No MCP, for the same
        # second it saves above; the bot path never had any (see below).
```

- [ ] **Step 5: Run the tests, then the suite**

Run: `python3 -m pytest tests/test_session_run_settings.py -q`
Expected: 17 passed.
Run: `python3 -m pytest tests/ -q`
Expected: 1498 passed, 2 skipped.

- [ ] **Step 6: Commit**

```bash
git add bridge/runner.py tests/test_session_run_settings.py
git commit -m "runner: the bot chat runs its session's model and mode"
```

---

### Task 8: Dashboard, where the composer's model and mode follow the open session

**Files:**
- Modify: `bridge/dashboard/web/src/models.ts` (after `modelOptions`, lines 39-41)
- Create: `bridge/dashboard/web/src/models.check.ts`
- Modify: `bridge/dashboard/web/src/api.ts:46-47`, `:101-103`, `:1057`, `:1218-1222`, `:1653`
- Modify: `bridge/dashboard/web/src/components/design/useSessionQueue.ts:16-18`
- Modify: `bridge/dashboard/web/src/App.tsx:23`, `:281-290`, after `:330`, `:1085-1089`, after `:1117`, `:1604-1609`, `:2204`
- Modify: `bridge/dashboard/web/src/components/Composer.tsx:23-30`, `:44`, `:227-229`
- Modify: `bridge/dashboard/web/src/components/hud/SettingsModal.tsx:4306-4309`
- Modify: `bridge/dashboard/web/src/lib/theme.ts:391`

**Interfaces:**
- Consumes: brief fields `model?: string | null` and `permission_mode?: string` (Task 5); `POST /local/session/settings` (Task 6).
- Produces:
  - `familyOf(id: string): string`
  - `snapModel(pick: string, list?: ModelOption[]): string | null`
  - `runPicks(s: {model?: string | null; permission_mode?: string | null}, device: {model: string; perm: string}): {model: string; perm: string}`
  - `api.setRunSettings(id: string, pick: {model?: string; permission_mode?: string}): Promise<RunSettings>`
  - `interface RunSettings { ok: boolean; model: string | null; permission_mode: string }`

- [ ] **Step 1: Write the failing check**

Create `bridge/dashboard/web/src/models.check.ts`:

```ts
// Run: node bridge/dashboard/web/src/models.check.ts
// The picker's Opus reset (docs/superpowers/specs/session-run-settings-design.md):
// a stored claude-fable-5-1 snapped to Opus on every reload because the snap ran
// against the pre-load alias FALLBACK. And runPicks: which picks a session shows.
import { familyOf, runPicks, snapModel } from "./models.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const list = (...ids: string[]) => ids.map((id) => ({ id, label: id }));
// What the bridge serves with a cold cache or the Models API down (models._fallback)…
const ALIASES = list("opus", "sonnet", "haiku", "fable");
// …and once it is warm: full ids, newest first.
const LIVE = list("claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5",
  "claude-fable-5", "claude-haiku-4-5-20251001");

ok(familyOf("claude-fable-5-1") === "fable" && familyOf("fable") === "fable", "an id and its alias share a family");
ok(familyOf("claude-haiku-4-5-20251001") === "haiku", "a dated id keeps its family");

ok(snapModel("claude-fable-5-1", undefined) === null, "pre-load: no list, no snap");
ok(snapModel("claude-fable-5-1", []) === null, "an empty list is no list");
ok(snapModel("claude-fable-5-1", LIVE) === null, "an offered pick stays");
ok(snapModel("fable", ALIASES) === null, "an offered alias stays");

ok(snapModel("claude-fable-5-1", ALIASES) === "fable", "full id -> its alias on the fallback list");
ok(snapModel("fable", LIVE) === "claude-fable-5-1", "alias -> the family's newest once the list warms");
ok(snapModel("claude-fable-4-9", LIVE) === "claude-fable-5-1", "a retired release -> its family's newest");

ok(snapModel("claude-mythos-5", LIVE) === "claude-opus-5-5", "a family not offered -> Opus");
ok(snapModel("claude-mythos-5", list("claude-sonnet-5", "claude-haiku-4-5")) === "claude-sonnet-5",
  "no Opus either -> the first model");

const DEV = { model: "claude-opus-5-5", perm: "default" };
const ran = runPicks({ model: "claude-fable-5-1", permission_mode: "bypassPermissions" }, DEV);
ok(ran.model === "claude-fable-5-1" && ran.perm === "bypassPermissions", "a session that has run carries both picks");
const fresh = runPicks({ model: null, permission_mode: "bypassPermissions" }, DEV);
ok(fresh.model === "claude-opus-5-5" && fresh.perm === "default",
  "a session that never ran starts from this device's picks, not the bridge's mode");
const legacy = runPicks({ model: null, permission_mode: "bypassPermissions" }, { model: "opus", perm: "" });
ok(legacy.perm === "bypassPermissions", 'a device mode of "" (the retired Session option) defers to the session');
const old = runPicks({}, { model: "opus", perm: "" });
ok(old.model === "opus" && old.perm === "", "an older bridge's brief (no fields) leaves this device's picks");
console.log("models.check: all ok");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node bridge/dashboard/web/src/models.check.ts`
Expected: `SyntaxError: The requested module './models.ts' does not provide an export named 'familyOf'`.

- [ ] **Step 3: Add the three helpers**

In `bridge/dashboard/web/src/models.ts`, after `modelOptions` (lines 39-41), insert:

```ts

/** "claude-fable-5-1" -> "fable": the first id segment after `claude-`, so a
 *  full id and its CLI alias share a family. By id, not label — family() below
 *  reads labels, which differ between the server's alias fallback ("Fable")
 *  and the live list ("Claude Fable 5.1"). */
export function familyOf(id: string): string {
  return id.replace(/^claude-/, "").split("-")[0];
}

/**
 * The model to show when `pick` isn't one the server offers, or null to leave it
 * be. Nothing snaps until the server's own list is in: snapping against the
 * pre-load FALLBACK is what turned every stored full id into Opus on reload. A
 * pick then keeps its family — the alias list a cold Models API cache serves and
 * the full-id list once it warms name the same models — and only a family the
 * server doesn't offer falls to Opus, then to the first model.
 */
export function snapModel(pick: string, list?: ModelOption[]): string | null {
  if (!list?.length || list.some((m) => m.id === pick)) return null;
  const of = (f: string) => list.find((m) => familyOf(m.id) === f);
  return (of(familyOf(pick)) ?? of("opus") ?? list[0]).id;
}

/**
 * The model + mode the composer shows for a session. One that has run from a
 * composer has a model and carries both picks; one that hasn't (fresh, or
 * started by the bot or VS Code) starts from this device's — or a new session
 * would quietly show the bridge's new-session mode over the one you keep
 * picking. A device mode of "" (the retired "Session" option) defers to the
 * session's own.
 */
export function runPicks(
  s: { model?: string | null; permission_mode?: string | null },
  device: { model: string; perm: string },
): { model: string; perm: string } {
  return s.model
    ? { model: s.model, perm: s.permission_mode || device.perm }
    : { model: device.model, perm: device.perm || s.permission_mode || "" };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node bridge/dashboard/web/src/models.check.ts`
Expected: 17 `ok - …` lines, then `models.check: all ok`.

- [ ] **Step 5: API types and the client call**

In `bridge/dashboard/web/src/api.ts`, replace lines 46-47:

```ts
  lifecycle?: Lifecycle | null; // null = active; anything else is why it's hidden
}
```

with:

```ts
  lifecycle?: Lifecycle | null; // null = active; anything else is why it's hidden
  // The session's run picks (bridge store.set_run_settings), loaded into the
  // composer. Absent from a bridge older than this field.
  model?: string | null; // last model picked for it on any surface; null = none yet
  permission_mode?: string; // the mode its next run gets: stored, else the bridge default
}

/** What POST /local/session/settings saved (and switched a running turn to). */
export interface RunSettings {
  ok: boolean;
  model: string | null;
  permission_mode: string;
}
```

Replace lines 102-103:

```ts
  // stderr (normally nothing — a dying MCP server, or --debug).
  | { type: "log"; src: "hook" | "stderr"; label?: string; text: string; error?: boolean }
```

with:

```ts
  // stderr (normally nothing — a dying MCP server, or --debug), or a control
  // request it refused (src "control": a mid-turn model/mode switch).
  | { type: "log"; src: "hook" | "stderr" | "control"; label?: string; text: string; error?: boolean }
```

`RunStream.tsx`'s `LogRow` already prints any `src`, so no render change is needed.

Replace line 1057:

```ts
  permission_mode?: string; // per-message operating mode; omit to use the session's
```

with:

```ts
  permission_mode?: string; // the picker's mode — the run saves it to the session; omit to keep the session's
```

After `setPolicy` (lines 1218-1222), insert:

```ts
  // A model/mode pick for a session: saved, and applied to its running turn.
  setRunSettings: (id: string, pick: { model?: string; permission_mode?: string }) =>
    req<RunSettings>("/local/session/settings", {
      method: "POST",
      body: { session_id: id, ...pick },
    }),
```

In `queueEnqueue`, replace line 1653:

```ts
    model?: string; effort?: string; permission_mode?: string; surface?: string;
```

with:

```ts
    effort?: string; surface?: string; // no model/mode: it runs on the session's
```

In `bridge/dashboard/web/src/components/design/useSessionQueue.ts`, replace lines 16-18:

```ts
  model?: string;
  effort?: string;
  permission_mode?: string;
```

with:

```ts
  effort?: string; // no model or mode: a queued prompt runs on the session's
```

- [ ] **Step 6: App, where the session owns the model and mode**

In `bridge/dashboard/web/src/App.tsx`, replace line 23:

```ts
import { modelOptions, latestPerFamily, type AgentOption } from "./models";
```

with:

```ts
import { modelOptions, latestPerFamily, runPicks, snapModel, type AgentOption } from "./models";
```

Replace lines 281-290:

```ts
  // The composer's four run knobs live in settings so they survive a reload —
  // the SESSION tab and the composer's dropdowns write the same state.
  const model = settings.model as ModelId;
  const effort = settings.effort as EffortLevel | "";
  const permMode = settings.perm;
  const ponytail = settings.ponytail;
  const setModel = (m: ModelId) => patchSettings({ model: m });
  const setEffort = (e: EffortLevel | "") => patchSettings({ effort: e });
  const setPermMode = (m: string) => patchSettings({ perm: m });
  const setPonytail = (p: string) => patchSettings({ ponytail: p });
```

with:

```ts
  // Effort and ponytail are this browser's: settings, so they survive a reload.
  // Model and mode belong to the open session — its row is the source of truth
  // (bridge store.set_run_settings), loaded by the effect beside the model
  // picker below. settings.model/perm only remember the last pick made here,
  // which is what a session that never ran from a composer starts on (runPicks).
  const [model, setModelState] = useState<ModelId>(() => settings.model as ModelId);
  const [permMode, setPermState] = useState<string>(() => settings.perm);
  const effort = settings.effort as EffortLevel | "";
  const ponytail = settings.ponytail;
  const setEffort = (e: EffortLevel | "") => patchSettings({ effort: e });
  const setPonytail = (p: string) => patchSettings({ ponytail: p });
```

After lines 329-330 (`const sessionIdRef = useRef(sessionId);` / `sessionIdRef.current = sessionId;`), insert:

```ts
  // A pick: shown now, remembered as this browser's default, and saved to the
  // open session as the pair the picker shows — a fresh session would otherwise
  // keep the bridge's mode under a picker showing yours. Saving also switches a
  // running turn (runner.apply_run_settings). A bridge too old for the route
  // 404s; the pick still rides the next /local/run, as it always did.
  const pickRun = (m: ModelId, p: string) => {
    setModelState(m);
    setPermState(p);
    patchSettings({ model: m, perm: p });
    const sid = sessionIdRef.current;
    if (sid) void api.setRunSettings(sid, { model: m, permission_mode: p || undefined }).catch(() => {});
  };
  const setModel = (m: ModelId) => pickRun(m, permMode);
  const setPermMode = (p: string) => pickRun(model, p);
  // The SESSION tab's MODEL/MODE (and a PROFILE's APPLY) are the composer's
  // knobs, so they show and pick for the open session too; the rest is ours.
  const settingsView = useMemo(() => ({ ...settings, model, perm: permMode }), [settings, model, permMode]);
  const patchFromSettings = (p: Partial<HudSettings>) => {
    const { model: m, perm: pm, ...rest } = p;
    if (m || pm) pickRun(m || model, pm || permMode);
    if (Object.keys(rest).length) patchSettings(rest);
  };
```

`patchSettings` is a hoisted function declaration (line 464). `useMemo` and `HudSettings` are already imported (lines 1 and 41).

Replace lines 1085-1089 (in `send`):

```ts
    const enqueue = () => queue.enqueue({
      text, prompt: text, images, project,
      model, effort: effort || undefined, permission_mode: permMode || undefined,
      agent: settings.agent || undefined,
    }, sid);
```

with:

```ts
    // No model or mode: a queued prompt runs on the session's when it starts,
    // so a pick made while it waits still applies.
    const enqueue = () => queue.enqueue({
      text, prompt: text, images, project, effort: effort || undefined,
      agent: settings.agent || undefined,
    }, sid);
```

After line 1117 (`setHeldMap((m) => omit(m, sid));`, in `send`'s success path), insert:

```ts
      // The run saved these picks to the session (/local/run); mirror that here,
      // or a session minted for this prompt reads as never-run until the next
      // poll and the picker flips to this browser's defaults meanwhile.
      setSessions((prev) => prev.map((s) => (s.id === sid
        ? { ...s, model, permission_mode: permMode || s.permission_mode } : s)));
```

Replace lines 1604-1609:

```ts
  // Once the live list loads, snap the selection to an available model (prefer
  // Opus) if the current one isn't offered — the old default was a fixed alias.
  useEffect(() => {
    if (!modelOpts.length || modelOpts.some((m) => m.id === model)) return;
    setModel((modelOpts.find((m) => m.id.includes("opus")) ?? modelOpts[0]).id);
  }, [modelOpts, model]);
```

with:

```ts
  // A pick the server's list doesn't offer (aliases while the Models API cache
  // is cold, full ids once it warms) moves to its family's model — on screen
  // only: neither the session nor settings is rewritten. Nothing snaps before
  // /local/state lands; modelOpts' pre-load FALLBACK is not a list to snap to.
  useEffect(() => {
    const to = snapModel(model, state?.models);
    if (to) setModelState(to);
  }, [state?.models, model]);
  // The open session's picks load when it opens and follow the 5s session poll
  // when another device changes them. Keyed on the values, so a poll that left
  // before a pick made here can't put the old one back.
  useEffect(() => {
    if (!selected) return;
    const r = runPicks(selected, { model: settings.model, perm: settings.perm });
    setModelState(r.model);
    setPermState(r.perm);
  }, [sessionId, selected?.model, selected?.permission_mode]);
```

`selected` is `sessions.find((s) => s.id === sessionId) ?? null` (line 410), fed by `loadSessions` every 5 s (line 614).

Replace line 2204:

```tsx
                settings={settings} onTheme={setTheme} onToggle={toggleCrt} onPatch={patchSettings}
```

with:

```tsx
                settings={settingsView} onTheme={setTheme} onToggle={toggleCrt} onPatch={patchFromSettings}
```

- [ ] **Step 7: Composer, SESSION tab, settings comment**

In `bridge/dashboard/web/src/components/Composer.tsx`, replace lines 23-30:

```ts
// Per-message operating mode ("" keeps the session's). These are Claude Code's
// own permission modes — the ids and titles the CLI itself uses, in its own
// least-authority-first order — so the picker can't offer a posture `claude
// --permission-mode` would reject, or name one something Claude doesn't. The
// CLI also takes "manual", but that is just its alias for "default". Each row's
// tooltip is Claude's own one-line description of the mode.
export const PERMS: { id: string; label: string; title?: string }[] = [
  { id: "", label: "Session", title: "Keep the mode this session was started with." },
```

with:

```ts
// The session's operating mode. These are Claude Code's own permission modes —
// the ids and titles the CLI itself uses, in its own least-authority-first
// order — so the picker can't offer a posture `claude --permission-mode` would
// reject, or name one something Claude doesn't. The CLI also takes "manual", but
// that is just its alias for "default". Each row's tooltip is Claude's own
// one-line description of the mode.
export const PERMS: { id: string; label: string; title?: string }[] = [
```

Delete the first row of `FREE_PERMS` (line 44 in the unedited file; the identical `PERMS` row went with the block above):

```ts
  { id: "", label: "Session", title: "Keep the mode this session was started with." },
```

Replace lines 227-229 (in the `RunPopover` comment):

```ts
 *  effort is almost always AUTO, so it is a stepped slider below rather than a
 *  menu. The trigger names only what differs from the default: the model
 *  always, the mode and effort only once they are set. Lists open inline, so
```

with:

```ts
 *  effort is almost always AUTO, so it is a stepped slider below rather than a
 *  menu. The trigger names the model and the session's mode always, effort only
 *  once it is set. Lists open inline, so
```

In `bridge/dashboard/web/src/components/hud/SettingsModal.tsx`, replace lines 4306-4309:

```tsx
                      The composer&apos;s dropdowns are these same knobs — set them here and they
                      stick across reloads. MODE ·{" "}
                      <span style={{ color: "var(--txd)" }}>Session</span> keeps whatever mode the
                      session was started with. AGENT ·{" "}
```

with:

```tsx
                      The composer&apos;s dropdowns are these same knobs. MODEL and MODE belong to
                      the open session — a pick is saved to it and follows it to every surface;
                      EFFORT, PONYTAIL and AGENT stay with this browser. AGENT ·{" "}
```

In `bridge/dashboard/web/src/lib/theme.ts`, replace line 391:

```ts
  perm: string; // "" = the session's own mode
```

with:

```ts
  perm: string; // the last mode picked here — what a never-run session starts on ("" = the bridge's)
```

- [ ] **Step 8: Typecheck and run every dashboard check**

Run: `cd bridge/dashboard/web && node_modules/.bin/tsc -p tsconfig.app.json; cd -`
Expected: only the baseline line `src/components/Markdown.tsx(4,26): error TS2307: Cannot find module 'remark-breaks' …`.
Run: `for f in $(find bridge/dashboard/web/src -name '*.check.ts' | sort); do node "$f" >/dev/null || echo "FAIL $f"; done`
Expected: no `FAIL` line.

- [ ] **Step 9: Commit**

```bash
git add bridge/dashboard/web/src
git commit -m "dashboard: the composer's model and mode follow the open session"
```

---

### Task 9: Mini App, where the composer's model and mode follow the open session

**Files:**
- Modify: `bridge/miniapp/web/src/lib/models.ts` (after `modelOptions`, lines 16-18)
- Create: `bridge/miniapp/web/src/lib/models.check.ts`
- Modify: `bridge/miniapp/web/src/lib/api.ts:68-69`, `:148-149`, after `:680`, `:709-711`
- Modify: `bridge/miniapp/web/src/lib/chat.tsx:25`, `:262-266`, `:296-303`, after `:538`
- Modify: `bridge/miniapp/web/src/components/Composer.tsx:27-34`, `:177-179`, `:340`
- Modify: `bridge/miniapp/web/src/routes/work.tsx:103`, `:118-120`, `:352`, `:372-374`, `:459`, `:484-486`

**Interfaces:**
- Consumes: the brief fields (Task 5) through `api.listSessions`; `POST /api/session/settings` (Task 6).
- Produces: the same `familyOf`, `snapModel` and `runPicks` as Task 8 (separate app, hand-kept copy); `api.setRunSettings`; `RunSettings`. `ChatContextValue`'s `model`/`setModel`/`perm`/`setPerm` keep their names and types.

- [ ] **Step 1: Write the failing check**

Create `bridge/miniapp/web/src/lib/models.check.ts`. Its content is Task 8 Step 1's file exactly, except for the first line:

```ts
// Run: node bridge/miniapp/web/src/lib/models.check.ts
// The picker's Opus reset (docs/superpowers/specs/session-run-settings-design.md):
// a stored claude-fable-5-1 snapped to Opus on every reload because the snap ran
// against the pre-load alias FALLBACK. And runPicks: which picks a session shows.
import { familyOf, runPicks, snapModel } from "./models.ts";

const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(`FAIL: ${what}`);
  console.log(`ok - ${what}`);
};
const list = (...ids: string[]) => ids.map((id) => ({ id, label: id }));
// What the bridge serves with a cold cache or the Models API down (models._fallback)…
const ALIASES = list("opus", "sonnet", "haiku", "fable");
// …and once it is warm: full ids, newest first.
const LIVE = list("claude-fable-5-1", "claude-opus-5-5", "claude-sonnet-5",
  "claude-fable-5", "claude-haiku-4-5-20251001");

ok(familyOf("claude-fable-5-1") === "fable" && familyOf("fable") === "fable", "an id and its alias share a family");
ok(familyOf("claude-haiku-4-5-20251001") === "haiku", "a dated id keeps its family");

ok(snapModel("claude-fable-5-1", undefined) === null, "pre-load: no list, no snap");
ok(snapModel("claude-fable-5-1", []) === null, "an empty list is no list");
ok(snapModel("claude-fable-5-1", LIVE) === null, "an offered pick stays");
ok(snapModel("fable", ALIASES) === null, "an offered alias stays");

ok(snapModel("claude-fable-5-1", ALIASES) === "fable", "full id -> its alias on the fallback list");
ok(snapModel("fable", LIVE) === "claude-fable-5-1", "alias -> the family's newest once the list warms");
ok(snapModel("claude-fable-4-9", LIVE) === "claude-fable-5-1", "a retired release -> its family's newest");

ok(snapModel("claude-mythos-5", LIVE) === "claude-opus-5-5", "a family not offered -> Opus");
ok(snapModel("claude-mythos-5", list("claude-sonnet-5", "claude-haiku-4-5")) === "claude-sonnet-5",
  "no Opus either -> the first model");

const DEV = { model: "claude-opus-5-5", perm: "default" };
const ran = runPicks({ model: "claude-fable-5-1", permission_mode: "bypassPermissions" }, DEV);
ok(ran.model === "claude-fable-5-1" && ran.perm === "bypassPermissions", "a session that has run carries both picks");
const fresh = runPicks({ model: null, permission_mode: "bypassPermissions" }, DEV);
ok(fresh.model === "claude-opus-5-5" && fresh.perm === "default",
  "a session that never ran starts from this device's picks, not the bridge's mode");
const legacy = runPicks({ model: null, permission_mode: "bypassPermissions" }, { model: "opus", perm: "" });
ok(legacy.perm === "bypassPermissions", 'a device mode of "" (the retired Session option) defers to the session');
const old = runPicks({}, { model: "opus", perm: "" });
ok(old.model === "opus" && old.perm === "", "an older bridge's brief (no fields) leaves this device's picks");
console.log("models.check: all ok");
```

- [ ] **Step 2: Run it to verify it fails**

Run: `node bridge/miniapp/web/src/lib/models.check.ts`
Expected: `SyntaxError: The requested module './models.ts' does not provide an export named 'familyOf'`.

- [ ] **Step 3: Add the three helpers**

In `bridge/miniapp/web/src/lib/models.ts`, after `modelOptions` (lines 16-18), insert:

```ts

/** "claude-fable-5-1" -> "fable": the first id segment after `claude-`, so a
 *  full id and its CLI alias share a family. By id, not label: the server's
 *  alias fallback says "Fable", the live list "Claude Fable 5.1". */
export function familyOf(id: string): string {
  return id.replace(/^claude-/, "").split("-")[0];
}

/**
 * The model to show when `pick` isn't one the server offers, or null to leave it
 * be. Nothing snaps until the server's own list is in: snapping against the
 * pre-load FALLBACK is what turned every stored full id into Opus on reload. A
 * pick then keeps its family — the alias list a cold Models API cache serves and
 * the full-id list once it warms name the same models — and only a family the
 * server doesn't offer falls to Opus, then to the first model.
 */
export function snapModel(pick: string, list?: ModelOption[]): string | null {
  if (!list?.length || list.some((m) => m.id === pick)) return null;
  const of = (f: string) => list.find((m) => familyOf(m.id) === f);
  return (of(familyOf(pick)) ?? of("opus") ?? list[0]).id;
}

/**
 * The model + mode the composer shows for a session. One that has run from a
 * composer has a model and carries both picks; one that hasn't (fresh, or
 * started by the bot or VS Code) starts from this phone's — or a new session
 * would quietly show the bridge's new-session mode over the one you keep
 * picking. A phone mode of "" (the retired "Session default") defers to the
 * session's own.
 */
export function runPicks(
  s: { model?: string | null; permission_mode?: string | null },
  device: { model: string; perm: string },
): { model: string; perm: string } {
  return s.model
    ? { model: s.model, perm: s.permission_mode || device.perm }
    : { model: device.model, perm: device.perm || s.permission_mode || "" };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `node bridge/miniapp/web/src/lib/models.check.ts`
Expected: ends with `models.check: all ok`.

- [ ] **Step 5: API types and the client call**

In `bridge/miniapp/web/src/lib/api.ts`, replace lines 68-69:

```ts
  cwd?: string | null; // run dir — a linked worktree differs from the project dir
}
```

with:

```ts
  cwd?: string | null; // run dir — a linked worktree differs from the project dir
  // The session's run picks (bridge store.set_run_settings), loaded into the
  // composer. Absent from a bridge older than this field.
  model?: string | null; // last model picked for it on any surface; null = none yet
  permission_mode?: string; // the mode its next run gets: stored, else the bridge default
}

/** What POST /api/session/settings saved (and switched a running turn to). */
export interface RunSettings {
  ok: boolean;
  model: string | null;
  permission_mode: string;
}
```

Replace lines 148-149:

```ts
  // stderr (normally nothing — a dying MCP server, or --debug).
  | { type: "log"; src: "hook" | "stderr"; label?: string; text: string; error?: boolean }
```

with:

```ts
  // stderr (normally nothing — a dying MCP server, or --debug), or a control
  // request it refused (src "control": a mid-turn model/mode switch).
  | { type: "log"; src: "hook" | "stderr" | "control"; label?: string; text: string; error?: boolean }
```

After `setAutocompact` (lines 676-680), insert:

```ts
  // A model/mode pick for a session: saved, and applied to its running turn.
  setRunSettings: (id: string, pick: { model?: string; permission_mode?: string }) =>
    request<RunSettings>("/api/session/settings", {
      method: "POST",
      body: { session_id: id, ...pick },
    }),
```

In `queueOp`'s body type, replace lines 709-711:

```ts
    model?: string;
    effort?: string;
    permission_mode?: string;
```

with:

```ts
    effort?: string; // no model or mode: a queued prompt runs on the session's
```

- [ ] **Step 6: Chat state, where the session owns the model and mode**

In `bridge/miniapp/web/src/lib/chat.tsx`, replace line 25:

```ts
import { modelOptions } from "./models";
```

with:

```ts
import { modelOptions, runPicks, snapModel } from "./models";
```

Replace lines 262-266:

```ts
  const [model, setModel] = usePersistentState<ModelId>("miniapp:model:v1", "opus");
  const [effort, setEffort] = usePersistentState<EffortLevel | "">("miniapp:effort:v1", "");
  // Per-message permission override ("" = use the session's mode). Lets you flip a
  // single run to ask/plan/full-auto from the phone, like Shift+Tab in the CLI.
  const [perm, setPerm] = usePersistentState<string>("miniapp:perm:v1", "");
```

with:

```ts
  // Model + mode belong to the open session: its row is the source of truth
  // (bridge store.set_run_settings), loaded below when it opens and followed
  // when another device picks for it. The persisted pair only remembers the last
  // pick on this phone — what a session that never ran from a composer starts
  // on (lib/models.runPicks). Effort stays this phone's.
  const [defModel, setDefModel] = usePersistentState<ModelId>("miniapp:model:v1", "opus");
  const [model, setModelState] = useState<ModelId>(defModel);
  const [effort, setEffort] = usePersistentState<EffortLevel | "">("miniapp:effort:v1", "");
  const [defPerm, setDefPerm] = usePersistentState<string>("miniapp:perm:v1", "");
  const [perm, setPermState] = useState<string>(defPerm);
```

Replace lines 296-303:

```ts
  // Model picker options — the live list served from /api/state (Models API).
  const models = modelOptions(stateQuery.data?.models);
  // Once the live list loads, snap the persisted selection to an available
  // model (prefer Opus) if the stored one isn't offered.
  useEffect(() => {
    if (!models.length || models.some((m) => m.id === model)) return;
    setModel((models.find((m) => m.id.includes("opus")) ?? models[0]).id);
  }, [models, model, setModel]);
```

with:

```ts
  // Model picker options — the live list served from /api/state (Models API).
  const models = modelOptions(stateQuery.data?.models);
  // A pick the server's list doesn't offer (aliases while the Models API cache
  // is cold, full ids once it warms) moves to its family's model — on screen
  // only: neither the session nor this phone's default is rewritten. Nothing
  // snaps before /api/state lands; modelOptions' FALLBACK is no list to snap to.
  useEffect(() => {
    const to = snapModel(model, stateQuery.data?.models);
    if (to) setModelState(to);
  }, [stateQuery.data?.models, model]);

  // This project's briefs on the same 5s beat as /api/state, for the open
  // session's picks: one made on another device lands here before this phone
  // sends over it. `sessions` (the resolver's copy) covers a session minted
  // since the last poll.
  const briefsQ = useQuery({
    queryKey: ["sessions", project],
    queryFn: () => api.listSessions(project as string),
    enabled: project !== null,
    refetchInterval: 5000,
  });
  const brief = briefsQ.data?.sessions.find((s) => s.id === sessionId)
    ?? sessions.find((s) => s.id === sessionId);
  // Keyed on the values, so a poll that left before a pick made here can't put
  // the old one back.
  useEffect(() => {
    if (!brief) return;
    const r = runPicks(brief, { model: defModel, perm: defPerm });
    setModelState(r.model);
    setPermState(r.perm);
  }, [sessionId, brief?.model, brief?.permission_mode]);

  // A pick: shown now, remembered as this phone's default, and saved to the
  // open session as the pair the picker shows (a fresh session would otherwise
  // keep the bridge's mode under a picker showing yours). Saving also switches a
  // running turn (runner.apply_run_settings). A bridge too old for the route
  // 404s; the pick still rides the next /api/run, as it always did.
  function pickRun(m: ModelId, p: string) {
    setModelState(m);
    setPermState(p);
    setDefModel(m);
    setDefPerm(p);
    if (sessionId)
      void api.setRunSettings(sessionId, { model: m, permission_mode: p || undefined }).catch(() => {});
  }
  const setModel = (m: ModelId) => pickRun(m, perm);
  const setPerm = (p: string) => pickRun(model, p);
```

No query uses the `["sessions", project]` key yet. `runPrompt` already sends `model` and `perm || undefined` (lines 526-528), which `/api/run` now saves. After line 538 (`onSent?.();`, in `runPrompt`'s success path), insert:

```ts
      // The run saved these picks to the session (/api/run); mirror that here,
      // or a session minted for this prompt reads as never-run until the next
      // poll and the picker flips to this phone's defaults meanwhile.
      setSessions((prev) => prev.map((s) => (s.id === sid
        ? { ...s, model, permission_mode: perm || s.permission_mode } : s)));
```

- [ ] **Step 7: Composer and WORK tab**

In `bridge/miniapp/web/src/components/Composer.tsx`, replace lines 27-34:

```ts
// Per-message operating mode ("" keeps the session's). These are Claude Code's
// own permission modes — the CLI's ids, in its own least-authority-first order —
// so a phone can't pick a posture `claude --permission-mode` would reject. (It
// also takes "manual", but that is only its alias for "default".) The Mini App
// has no free-agent picker, so this list is Claude's alone; the dashboard's
// composer carries opencode's shorter one.
const PERMS: { id: string; label: string }[] = [
  { id: "", label: "Session default" },
```

with:

```ts
// The session's operating mode. These are Claude Code's own permission modes —
// the CLI's ids, in its own least-authority-first order — so a phone can't pick
// a posture `claude --permission-mode` would reject. (It also takes "manual",
// but that is only its alias for "default".) The Mini App has no free-agent
// picker, so this list is Claude's alone; the dashboard's composer carries
// opencode's shorter one.
const PERMS: { id: string; label: string }[] = [
```

In `queue()`, replace lines 177-179:

```ts
        model,
        effort: effort || undefined,
        permission_mode: perm || undefined,
```

with:

```ts
        // No model or mode: it runs on the session's when it starts.
        effort: effort || undefined,
```

Replace line 340:

```tsx
              label="OPERATING MODE · THIS RUN"
```

with:

```tsx
              label="OPERATING MODE"
```

In `bridge/miniapp/web/src/routes/work.tsx`:

- Replace line 103, `const { sessionId, sessions, model, effort, perm } = useChat();`, with `const { sessionId, sessions, effort } = useChat();`.
- Replace lines 352 and 459, both `const { setDraft, sessionId, model, effort, perm } = useChat();`, with `const { setDraft, sessionId, effort } = useChat();`.
- Replace each of the three blocks at 118-120, 372-374 and 484-486:

```ts
        model,
        effort: effort || undefined,
        permission_mode: perm || undefined,
```

with:

```ts
        effort: effort || undefined,     // model + mode: the session's, when it runs
```

The Mini App's `tsconfig.app.json` sets `noUnusedLocals`, so a leftover `model` or `perm` destructure fails the typecheck. That is the point of dropping them from `queueOp`'s type.

- [ ] **Step 8: Typecheck and run every Mini App check**

Run: `cd bridge/miniapp/web && node_modules/.bin/tsc -p tsconfig.app.json; echo "exit $?"; cd -`
Expected: no output, `exit 0`.
Run: `for f in $(find bridge/miniapp/web/src -name '*.check.ts' | sort); do node "$f" >/dev/null || echo "FAIL $f"; done`
Expected: no `FAIL` line.

- [ ] **Step 9: Commit**

```bash
git add bridge/miniapp/web/src
git commit -m "miniapp: the composer's model and mode follow the open session"
```

---

### Task 10: Verification

No code unless something here fails. A failure goes back to the task that owns it.

**Files:** none (scratch files only under `/tmp`).

- [ ] **Step 1: Whole backend suite**

Run: `python3 -m pytest tests/ -q`
Expected: 1498 passed, 2 skipped.

- [ ] **Step 2: Both typechecks and every check file**

Run each as in Task 8 Step 8 and Task 9 Step 8. Expected: the dashboard at its one baseline error, the Mini App clean, and no `FAIL`.

- [ ] **Step 3: Headless, where a seeded `claude-fable-5-1` survives a reload (both apps)**

This tests the worktree's builds against the live bridge's data through `.mystical/probe/probe.py`. The probe proxies GETs only and answers every POST with 405, so nothing reaches the live DB. The live bridge still runs old code: its briefs carry no `model`, so the device pick decides (`runPicks`) and the snap runs against its real, full-id list.

Build both apps:

```bash
WT=/home/mhzrerfani/projects/.worktrees/mystical-assistant/feat-session-run-settings
cd $WT/bridge/miniapp/web && node_modules/.bin/vite build
# The dashboard needs remark-breaks, which the shared node_modules predates
# (4a73fed3). Give this worktree its own install; the symlink is git-excluded.
cd $WT/bridge/dashboard/web && rm node_modules && npm ci && node_modules/.bin/vite build
```

Forge Mini App init-data for an allowed user. The shell the bridge hosts has `TELEGRAM_BOT_TOKEN` and `ALLOWED_CHAT_IDS`. `quote_via=quote` matters: the server `unquote`s, so a `+` for a space would break the hash.

```bash
python3 - > /tmp/srs-initdata.txt <<'EOF'
import hashlib, hmac, json, os, time, urllib.parse
tok = os.environ["TELEGRAM_BOT_TOKEN"]
uid = min(int(x) for x in os.environ["ALLOWED_CHAT_IDS"].replace(" ", "").split(",") if x)
data = {"auth_date": str(int(time.time())), "query_id": "srs-probe",
        "user": json.dumps({"id": uid, "first_name": "probe"}, separators=(",", ":"))}
check = "\n".join(f"{k}={data[k]}" for k in sorted(data))
secret = hmac.new(b"WebAppData", tok.encode(), hashlib.sha256).digest()
data["hash"] = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
print(urllib.parse.urlencode(data, quote_via=urllib.parse.quote))
EOF
P=/home/mhzrerfani/projects/mystical-assistant/.mystical/probe
(python3 $P/probe.py 8887 $WT/bridge/miniapp/web/dist 8787 "$(cat /tmp/srs-initdata.txt)" >/dev/null 2>&1 &)
(python3 $P/probe.py 8890 $WT/bridge/dashboard/web/dist 8790 >/dev/null 2>&1 &)
sleep 1
cd $P
node shot2.mjs 'http://127.0.0.1:8887/' /tmp/srs-mini.png 390 844 7000 \
  '{"miniapp:model:v1": "\"claude-fable-5-1\""}' \
  'JSON.stringify({stored: localStorage.getItem("miniapp:model:v1"), chip: [...document.querySelectorAll("button")].map(b => b.textContent.trim()).filter(t => /fable|opus|sonnet|haiku/i.test(t)).slice(0, 3)})' 500
node shot2.mjs 'http://127.0.0.1:8890/?skipboot=1' /tmp/srs-dash.png 1280 800 7000 \
  '{"hud-settings": {"model": "claude-fable-5-1"}}' \
  'JSON.stringify({stored: JSON.parse(localStorage.getItem("hud-settings") || "{}").model, shown: [...document.querySelectorAll("button")].map(b => b.title || "").filter(t => /^MODEL —|^Model /.test(t)).slice(0, 2)})' 500
```

Expected Mini App result (seen in the dry run): `eval: "{\"stored\":\"\\\"claude-fable-5-1\\\"\",\"chip\":[\"Fable 5.1\"]}"`. Master's dist (`/home/mhzrerfani/projects/mystical-assistant/bridge/miniapp/web/dist` through the same probe) reads back `claude-opus-5-5` / `"Opus 5.5"`, which is the bug.

Expected dashboard result: `stored` is `claude-fable-5-1`, and the MODEL title (the `Drop` button's `MODEL — …`, or the compact trigger's `Model …`) names Fable. That selector is from code reading, so `Read /tmp/srs-dash.png` and look as well.

Stop the probes by port (not `pkill -f`, which kills your own shell). Then put the dashboard's `node_modules` symlink back if you want the tree as it was.

```bash
for port in 8887 8890; do pid=$(ss -ltnp 2>/dev/null | awk -v p=":$port" '$4 ~ p {print $6}' | grep -o 'pid=[0-9]*' | cut -d= -f2); [ -n "$pid" ] && kill $pid; done
rm -f /tmp/srs-initdata.txt
```

- [ ] **Step 4: Live, once, through the real runner, route and CLI**

This costs about a cent on Haiku. It uses a scratch DB, sends nothing to Telegram (`NOTIFY_ENABLE=0`), and runs none of your hooks: `--setting-sources project` keeps peon-ping and the ntfy push on `Stop` out of it. The titler, learn and tailstate kicks are stubbed because each would start its own claude one-shot. Save as `/tmp/srs-live.py`:

```python
"""One live switch, end to end: a real claude turn in `default` mode asks for a
permission; a Bypass pick through the dashboard route approves that card and the
next tool doesn't ask. Scratch DB, no Telegram, none of your hooks.

Run from the repo root:
  BRIDGE_DB=/tmp/plan-srs.db NOTIFY_ENABLE=0 AUTO_RESUME=0 python3 /tmp/srs-live.py
"""
import os
import shutil
import sys
import tempfile
import time

sys.path.insert(0, os.getcwd())
from bridge import config, learn, runner, store, tailstate, titler  # noqa: E402

assert config.BRIDGE_DB == "/tmp/plan-srs.db", config.BRIDGE_DB      # never the live DB
from bridge.dashboard import server as dash  # noqa: E402

store.init()
# Each of these spawns its own claude one-shot; none is what's under test.
titler.kick = learn.kick = tailstate.kick = lambda *a, **k: None
cwd = tempfile.mkdtemp(prefix="srs-live-")
prompt = ("Run exactly two Bash tool calls, one after the other (not in parallel): "
          "first `touch a.txt`, then `touch b.txt`. Then reply with the single word done.")
# --setting-sources project: your user hooks (peon-ping, the ntfy push on Stop)
# and plugins stay out of a test turn. The rest is the bridge's own argv.
job = runner.start_streaming_job(config.DASH_CHAT_ID, prompt, [], project=cwd,
                                 model="haiku", permission_mode="default",
                                 origin="dashboard",
                                 extra_args=["--setting-sources", "project"])


def wait(cond, secs):
    end = time.time() + secs
    while time.time() < end and not cond():
        time.sleep(0.25)
    return cond()


try:
    assert wait(lambda: any(p["kind"] == "permission" for p in job.pending), 180), \
        f"no permission card: {[e.get('type') for e in job.events]}"
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    h._post_api("/local/session/settings", {"session_id": job.store_session_id,
                                            "permission_mode": "bypassPermissions"})
    assert box.get("code") == 200, box
    assert wait(job.exited.is_set, 180), "the turn never ended"
    kinds = [e.get("type") for e in job.events]
    print("status:", job.status, "| events:", kinds)
    assert kinds.count("permission") == 1, "a tool after the switch still asked"
    assert [e for e in job.events if e.get("type") == "permission_resolved"
            and e.get("behavior") == "allow"], "the waiting card was not approved"
    assert not [e for e in job.events if e.get("type") == "log" and e.get("error")], \
        "the CLI refused a control request"
    assert os.path.exists(os.path.join(cwd, "a.txt")) and os.path.exists(os.path.join(cwd, "b.txt"))
    assert store.get_session(job.store_session_id)["permission_mode"] == "bypassPermissions"
    print("LIVE SWITCH OK")
finally:
    shutil.rmtree(cwd, ignore_errors=True)
    enc = cwd.replace("/", "-").replace(".", "-").replace("_", "-")
    shutil.rmtree(os.path.expanduser(f"~/.claude/projects/{enc}"), ignore_errors=True)
```

Run: `cd $WT && BRIDGE_DB=/tmp/plan-srs.db NOTIFY_ENABLE=0 AUTO_RESUME=0 python3 /tmp/srs-live.py`
Expected (from the dry run): `status: done | events: ['thinking', 'tool', 'permission', 'permission_resolved', 'tool_done', 'tool', 'tool_done', 'text', 'result']`, then `LIVE SWITCH OK`.

Clean up afterwards. Side files land next to `BRIDGE_DB`. The live bridge never sees this run: its disk scan is `BASE_PATH`-only, and the registry scan skips `sdk` children.

```bash
rm -f /tmp/plan-srs.db /tmp/plan-srs.db-wal /tmp/plan-srs.db-shm /tmp/preview_queue.json /tmp/limit_resume.json /tmp/srs-live.py
```

- [ ] **Step 5: Report, don't ship**

None of this is live until it is merged, the dashboard and Mini App are rebuilt, and the bridge restarts. That is the **bridge-ship** skill's job, after review, and is not part of this plan. Say so when reporting.
