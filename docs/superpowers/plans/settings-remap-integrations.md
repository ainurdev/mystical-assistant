# Settings remap, slice 2 — integrations as installable plugins: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rivendell, the task trackers (Teamwork, Jira) and Claude Design ship with Mystical but stay off and invisible until installed from Settings ▸ Integrations, and this machine keeps everything it already uses after the upgrade without a click.

**Architecture:** One registry, `bridge/integrations.py`, lists the three plugins and answers `installed(id)` from `plugins.json` beside the DB (the `aifeatures` lock-and-cache pattern); the first read with no file adopts what the machine already uses. Each server refuses a not-installed plugin's routes at its door, keyed on route prefixes in the registry, so no route branch changes. The Rivendell worker, its Telegram callbacks, the task digest and the next-up tracker read each ask `installed()` once. The dashboard reads the flags through `useIntegrations()` (the `useAiFeatures()` pattern), the Mini App reads them on `/api/state`, and Settings' PLUGINS tab becomes INTEGRATIONS: a card per installed plugin wrapping today's Rivendell and Trackers panels, and an AVAILABLE grid with INSTALL.

**Tech Stack:** Python 3 stdlib · React + TypeScript + Vite (both web apps) · pytest.

**Spec:** `docs/superpowers/specs/settings-remap-design.md` — "Integrations as plugins", "Pages ▸ Integrations", "Cross-surface", "Data and migration", "Delivery order" item 2. Visual target: `.mystical/design-drafts/settings-remap/07-integrations.html` (`shots/07-integrations.png`).

## Global Constraints

- Backend stdlib only; no new npm dependency in either web app.
- `plugins.json` lives beside `config.BRIDGE_DB` (live: `~/.bridge_state/plugins.json`), mode 0600, and every write records all three ids: `{"rivendell": true, "trackers": false, "design": false}`.
- Registry ids, in this order: `rivendell`, `trackers`, `design`. Entry fields `{id, label, blurb, needs, env_keys, origins}` plus `routes` (ruling 1).
- A route of a plugin that is not installed answers **404 `{"error": "not installed"}`** on both servers.
- `GET /local/integrations` → `{"plugins": [{id, label, blurb, needs, installed, summary}]}`. `POST /local/integrations {"id", "action": "install" | "remove"}` → `{"ok": true, "plugins": [...]}`.
- The Mini App's `/api/state` carries `"plugins": {"rivendell": bool, "trackers": bool, "design": bool}`.
- Rivendell owns `FFMPEG_BIN`, `WHISPER_BIN`, `WHISPER_MODEL`: `envsettings.state()` drops them while it is not installed. `envsettings.apply()` is unchanged.
- Removing a plugin leaves its own state on disk (`rivendell_instances.json`, `trackers.json`, `design_project` in `project_config.json`), so installing it again restores it.
- A `config.py` key that `setup.sh`, `.env.example` or the entry point reads stays. `RIVENDELL_ENABLE` stays (it seeds the first instance). `DESIGN_SYNC_ENABLE` is read by none of them and leaves with the `design` switch.
- AI MANAGEMENT is a collaborator's page: in `SkillsFold.tsx` change only the extras list, in its own idiom.
- Commit messages use the repo's `area: sentence` style, with no Claude attribution or co-author line (user rule).
- Backend suite on the Mac: `~/.cache/mystical-test-venv/bin/python -m pytest tests/ -q`. Baseline on master `af31c3d`: **7 failed, 1943 passed, 1 skipped**. The 7 are the known macOS-only failures (`test_clip_panel` ×1, `test_map_command` ×4, `test_startup` ×2). Anything else red is yours.
- Type-check from each `web/`: `./node_modules/.bin/tsc -p tsconfig.app.json --noEmit` (`tsc -p .` checks nothing).
- Work in a worktree, branch `feat/integrations`, per the `bridge-worktree` skill (where it lives, `node_modules`, keeping data off the live DB).

## Rulings

Where the spec left a choice open, or named something that turned out to need nothing:

1. **`routes` joins each registry entry**, and each server checks it once at its door (`path == r or path.startswith(r + "/")`) instead of in each of 16 route branches. The parametrised test sweeps every route, so a missed one fails a test, not a review.
2. **TASK DIGEST keeps its storage** (`aifeatures` key `tasks`, env `TASKS_DIGEST`); only its card moves, from the extras grid into the Trackers card. **The `design` switch is deleted**: installing Claude Design is that switch now.
3. **REMOVE Rivendell is refused (409) while a run is in flight.** A stopped worker interrupts its run (`Worker._wait_job` breaks on `_stop` and calls `job.interrupt()`), so a stray click would kill a three-hour implementation.
4. **A dashboard newer than its bridge** (`/local/integrations` 404s) reads every plugin as installed, which is what that bridge does, and the Integrations page says to restart it.
5. **Nothing to gate, checked:** `github.py`'s two hints are only called from `rivendell.py`. `skills.py`'s `from_design` labels skills on disk; its one consumer, the DESIGN tab, is gated. `dream.py` and `native_activity.py` have no tracker reads. `queue_manager` stays: recovery already leaves a Rivendell batch to its worker, and ruling 3 means REMOVE can't orphan one. `/local/project/settings` keeps its `design_project` and `tracker` fields (a shared route; the UI that sends them is gated). The `/design-first` and `/design-implement` skills are files outside the bridge; hiding the DESIGN button hides the bridge's way in.
6. **Move carries every plugin's state file whether installed or not**, plus `plugins.json`. Mine wins a merge conflict, so a machine that already booted keeps its own install set, while a CLI import before the first boot brings the old one. The "Rivendell came over switched OFF" step stays and points at Settings ▸ Integrations, which is right whether or not Rivendell is installed there.

## Review Focus

1. **REMOVE while a Rivendell run is in flight.** Expect a refusal that says so, never a killed run. Tests: Task 1, Task 2.
2. **A new dashboard on an old bridge** (the dist deployed before the restart). Expect today's UI, not every plugin vanishing, and a restart line on the Integrations page. Check: Task 9, capture 1.
3. **REPLACE TOKEN on an instance with a custom ws url**, now that the form has no ws url field. Expect the stored value to survive. Test: Task 5.
4. **First boot after the upgrade with `plugins.json` missing or corrupt.** Expect adoption of what the machine uses; once the file exists, removing everything sticks across restarts. Tests: Task 1.
5. **A Telegram tap or reply on an old Rivendell ping after REMOVE.** Expect "Rivendell isn't installed." and no accept or reject; a reply becomes an ordinary prompt instead of being swallowed. Tests: Task 4.

---

### Task 1: The registry — `bridge/integrations.py`

**Files:**
- Create: `bridge/integrations.py`
- Modify: `bridge/project_config.py` (add `design_link_count`)
- Modify: `tests/conftest.py` (autouse fixture, after the `from bridge import profiles, store` line, ~94)
- Create: `tests/test_integrations.py`

**Interfaces:**
- Produces (every later task uses these):
  - `PLUGINS: tuple[dict, ...]`, entries `{"id", "label", "blurb", "needs", "env_keys": tuple[str, ...], "origins": tuple[str, ...], "routes": tuple[str, ...]}`
  - `class IntegrationError(Exception)` — one line a panel can show (not a `ValueError` subclass)
  - `installed(pid: str) -> bool` — an unknown id reads False
  - `set_installed(pid: str, on: bool) -> None` — `ValueError` for an unknown id; `IntegrationError` when removing rivendell mid-run; persists; calls `rivendell.reconfigure()` when `pid == "rivendell"`
  - `flags() -> dict[str, bool]`
  - `state() -> list[dict]` — `[{id, label, blurb, needs, installed, summary}]`
  - `origins() -> tuple[str, ...]` — the installed plugins' origins
  - `is_plugin_origin(origin) -> bool` — replaces `config.is_plugin_origin` in Task 3
  - `route_owner(path: str) -> str | None` — the plugin a route belongs to, installed or not
  - `hidden_env_keys() -> set[str]` — env keys of plugins not installed
  - `project_config.design_link_count() -> int`

Registry values:

| id | label | origins | routes | env_keys | needs |
|---|---|---|---|---|---|
| `rivendell` | Rivendell | `("rivendell",)` | `("/local/rivendell",)` | `("FFMPEG_BIN", "WHISPER_BIN", "WHISPER_MODEL")` | Rivendell token |
| `trackers` | Teamwork · Jira | `()` | `("/local/trackers", "/local/tracker", "/api/tracker")` | `()` | API token |
| `design` | Claude Design | `()` | `("/local/design",)` | `()` | claude.ai login |

Blurbs (mockup 07's copy):
- rivendell: "Rivendell's Request review and Implement using AI buttons run as autonomous Claude sessions here. Adds the RIVENDELL tab, the queue, Telegram approvals and the video kind."
- trackers: "A repo linked to a Teamwork or Jira project opens every session with what is open and overdue. Adds the TASKS tab, LINK TASKS and updates posted through the run."
- design: "Link a repo to its Claude Design system: pull tokens and component specs as a skill, push finished work back. Adds the DESIGN tab and the DESIGN button."

- [ ] **Step 1: Write the failing tests** — create `tests/test_integrations.py`:

```python
"""bridge/integrations.py — which bundled plugins are installed, first-boot
adoption, and the door every plugin route passes on both servers.
Run: python -m pytest tests/test_integrations.py -v"""

import json
import os
import stat

import pytest

from bridge import integrations, project_config, rivendell, rivendell_instances, trackers

IDS = ["rivendell", "trackers", "design"]


@pytest.fixture
def fresh(monkeypatch, tmp_path):
    """A first boot with no plugins.json and nothing to adopt: a stranger's install."""
    path = tmp_path / "plugins.json"
    monkeypatch.setattr(integrations, "_path", lambda: str(path))
    monkeypatch.setattr(integrations, "_cache", None)
    monkeypatch.setattr(rivendell_instances, "raw_instances", lambda: [])
    monkeypatch.setattr(trackers, "connections", lambda: [])
    monkeypatch.setattr(project_config, "design_link_count", lambda: 0)
    monkeypatch.setattr(rivendell, "reconfigure", lambda: None)
    monkeypatch.setattr(rivendell, "running", lambda: [])
    return path


def test_the_registry_holds_the_three_bundled_plugins():
    assert [p["id"] for p in integrations.PLUGINS] == IDS
    for p in integrations.PLUGINS:
        assert {"id", "label", "blurb", "needs", "env_keys", "origins", "routes"} <= set(p)
    assert integrations.PLUGINS[0]["env_keys"] == ("FFMPEG_BIN", "WHISPER_BIN", "WHISPER_MODEL")
    assert integrations.PLUGINS[0]["origins"] == ("rivendell",)


def test_a_first_boot_with_nothing_to_adopt_installs_nothing(fresh):
    assert integrations.flags() == {"rivendell": False, "trackers": False, "design": False}
    assert json.loads(fresh.read_text()) == {"rivendell": False, "trackers": False, "design": False}
    assert stat.S_IMODE(os.stat(fresh).st_mode) == 0o600


ADOPT = {
    "rivendell": (rivendell_instances, "raw_instances", lambda: [{"id": "production"}]),
    "trackers": (trackers, "connections", lambda: [{"id": "c1"}]),
    "design": (project_config, "design_link_count", lambda: 1),
}


@pytest.mark.parametrize("pid", IDS)
def test_a_first_boot_adopts_what_the_machine_already_uses(fresh, monkeypatch, pid):
    mod, name, fake = ADOPT[pid]
    monkeypatch.setattr(mod, name, fake)
    assert integrations.flags() == {p: p == pid for p in IDS}


def test_adoption_runs_once_so_a_removal_survives_a_restart(fresh, monkeypatch):
    monkeypatch.setattr(rivendell_instances, "raw_instances", lambda: [{"id": "production"}])
    assert integrations.installed("rivendell")
    integrations.set_installed("rivendell", False)
    monkeypatch.setattr(integrations, "_cache", None)        # the next boot re-reads the file
    assert not integrations.installed("rivendell")


def test_a_corrupt_file_adopts_again(fresh, monkeypatch):
    fresh.write_text("{not json")
    monkeypatch.setattr(trackers, "connections", lambda: [{"id": "c1"}])
    assert integrations.installed("trackers")


def test_install_and_remove_persist(fresh):
    integrations.set_installed("design", True)
    assert json.loads(fresh.read_text())["design"] is True
    integrations.set_installed("design", False)
    assert integrations.installed("design") is False


def test_an_unknown_plugin_is_refused_and_reads_as_off(fresh):
    with pytest.raises(ValueError):
        integrations.set_installed("teleport", True)
    assert integrations.installed("teleport") is False


def test_rivendell_install_and_remove_reconcile_its_worker(fresh, monkeypatch):
    calls = []
    monkeypatch.setattr(rivendell, "reconfigure", lambda: calls.append(1))
    integrations.set_installed("rivendell", True)
    integrations.set_installed("rivendell", False)
    assert len(calls) == 2


def test_removing_rivendell_mid_run_is_refused(fresh, monkeypatch):
    integrations.set_installed("rivendell", True)
    monkeypatch.setattr(rivendell, "running", lambda: [{"request_id": "r1"}])
    with pytest.raises(integrations.IntegrationError, match="in flight"):
        integrations.set_installed("rivendell", False)
    assert integrations.installed("rivendell")


def test_plugin_origins_follow_the_install(fresh):
    assert not integrations.is_plugin_origin("rivendell:production")
    integrations.set_installed("rivendell", True)
    assert integrations.is_plugin_origin("rivendell:production")
    assert integrations.is_plugin_origin("rivendell")
    assert not integrations.is_plugin_origin("dashboard")
    assert not integrations.is_plugin_origin(None)


def test_every_plugin_route_has_an_owner():
    owner = integrations.route_owner
    assert owner("/local/rivendell") == owner("/local/rivendell/queue") == "rivendell"
    assert owner("/local/trackers") == owner("/local/tracker/tasks") == "trackers"
    assert owner("/api/tracker/update") == "trackers"
    assert owner("/local/design/prompt") == "design"
    assert owner("/local/rivendellx") is None
    assert owner("/local/sessions") is None


def test_state_summarises_only_what_is_installed(fresh, monkeypatch):
    monkeypatch.setattr(trackers, "connections", lambda: [{"id": "c1"}])
    integrations.set_installed("trackers", True)
    rows = {r["id"]: r for r in integrations.state()}
    assert set(rows["trackers"]) == {"id", "label", "blurb", "needs", "installed", "summary"}
    assert (rows["trackers"]["installed"], rows["trackers"]["summary"]) == (True, "1 connection")
    assert (rows["design"]["installed"], rows["design"]["summary"]) == (False, "")


def test_design_link_count_counts_linked_entries(monkeypatch, tmp_path):
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "project_config.json"))
    project_config.set_design_project("/app", "aaaa-1")
    project_config.set_design_project("/web", "bbbb-2", "main")
    project_config.set_run_cmd("/api", "npm run dev")
    assert project_config.design_link_count() == 2
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `~/.cache/mystical-test-venv/bin/python -m pytest tests/test_integrations.py -q`
Expected: FAIL — `ImportError: cannot import name 'integrations' from 'bridge'`.

- [ ] **Step 3: Implement `bridge/integrations.py` and `project_config.design_link_count()`**

The module docstring carries the why: preparing a public release; bundled, off by default, and "install" flips a switch with nothing downloaded; not installed means none of it exists (routes 404 at the door, the worker idle, no env rows, origins or Telegram callbacks, no UI); removing leaves the plugin's state for a reinstall; the first read without a file adopts existing state; persisted beside the DB like `aifeatures`, so a bridge mid-migration can read it. Not built: out-of-tree plugins (the table is shaped for them).

Persistence follows `aifeatures` (`_lock`, `_cache`, `_path()` beside `config.BRIDGE_DB`) and saves the way `rivendell_instances._save` does (tmp file, `chmod 0o600`, `os.replace`), swallowing `OSError` so the in-memory answer still holds. `_load()`: read the file into `{pid: bool(raw.get(pid)) for pid in ids}`; on `OSError`, `ValueError` or `AttributeError` (missing, corrupt, not an object), adopt and save. `_adopt()` imports `project_config`, `rivendell_instances` and `trackers` inside the function, so `rivendell.py` and `runner.py` can import this module without a cycle; each source is wrapped so a failure reads False: rivendell ← `rivendell_instances.raw_instances()` non-empty, trackers ← `trackers.connections()` non-empty, design ← `project_config.design_link_count() > 0`.

`set_installed`: the mid-run check runs before the write, `rivendell.running()` non-empty → `IntegrationError("A Rivendell run is in flight — let it finish, then remove Rivendell.")`. `summary`, installed plugins only: rivendell `"2 instances · 1 on"` (from `rivendell_instances.instances()` and each one's `enable`), trackers `"1 connection"`, design `"3 repos linked"`, singular at 1; `""` when not installed. `design_link_count()` counts `project_config` entries (repo or `repo@branch`) whose `design_project` is set, under `_lock`.

- [ ] **Step 4: Install every plugin for the rest of the suite** — in `tests/conftest.py`, after the `from bridge import profiles, store` line:

```python
from bridge import integrations  # noqa: E402


@pytest.fixture(autouse=True)
def _plugins_installed(monkeypatch, tmp_path):
    """Every bundled plugin installed, so the Rivendell, tracker and design
    suites keep testing their features; test_integrations.py starts from none."""
    monkeypatch.setattr(integrations, "_path", lambda: str(tmp_path / "conftest-plugins.json"))
    monkeypatch.setattr(integrations, "_cache", dict.fromkeys(("rivendell", "trackers", "design"), True))
```

- [ ] **Step 5: Run the tests**

Run: `~/.cache/mystical-test-venv/bin/python -m pytest tests/test_integrations.py -q` → all pass.
Run: `~/.cache/mystical-test-venv/bin/python -m pytest tests/ -q` → the baseline (7 known failures).

- [ ] **Step 6: Commit**

```bash
git add bridge/integrations.py bridge/project_config.py tests/conftest.py tests/test_integrations.py
git commit -m "integrations: one registry says which bundled plugin is installed — Rivendell, the trackers, Claude Design — and a first boot adopts what the machine already uses"
```

---

### Task 2: The doors — route gate, `/local/integrations`, the Mini App's flags

**Files:**
- Modify: `bridge/dashboard/server.py` — first statement of `_get_api` (~291) and `_post_api` (~807); a GET and a POST `/local/integrations` beside `/local/aifeatures` (~365, ~963)
- Modify: `bridge/miniapp/server.py` — `do_GET` right after the 401 check (~367), `do_POST` right after its 401 check (~438), `_api_state` (~502)
- Test: `tests/test_integrations.py`

**Interfaces:**
- Consumes: `integrations.route_owner`, `installed`, `set_installed`, `state`, `flags`, `IntegrationError` (Task 1)
- Produces: `GET /local/integrations`, `POST /local/integrations`, `/api/state.plugins`

- [ ] **Step 1: Write the failing tests** — append to `tests/test_integrations.py`:

```python
from urllib.parse import parse_qs, urlparse

from bridge import config, state
from bridge.dashboard import server as dash
from bridge.miniapp import server as mini


def call(method, path, body=None):
    """One request through the right server's route table, minus the socket."""
    mod = mini if path.startswith("/api/") else dash
    h = mod.Handler.__new__(mod.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    if mod is mini:
        h._auth = lambda: config.DASH_CHAT_ID
        h._read_json = lambda: body or {}
        h.path = path
        h.do_GET() if method == "GET" else h.do_POST()
    elif method == "GET":
        u = urlparse(path)
        h._get_api(u.path, parse_qs(u.query))
    else:
        h._post_api(path, body or {})
    return box


ROUTES = {
    "rivendell": [("GET", "/local/rivendell"), ("GET", "/local/rivendell/queue"),
                  ("GET", "/local/rivendell/tasks"), ("GET", "/local/rivendell/task"),
                  ("GET", "/local/rivendell/todolist"), ("POST", "/local/rivendell"),
                  ("POST", "/local/rivendell/queue"), ("POST", "/local/rivendell/implement"),
                  ("POST", "/local/rivendell/test")],
    "trackers": [("GET", "/local/trackers"), ("GET", "/local/tracker/projects"),
                 ("GET", "/local/tracker/tasks"), ("GET", "/local/tracker/statuses"),
                 ("POST", "/local/trackers"), ("POST", "/local/tracker/update"),
                 ("GET", "/api/tracker/tasks"), ("GET", "/api/tracker/statuses"),
                 ("POST", "/api/tracker/update")],
    "design": [("GET", "/local/design/prompt")],
}


@pytest.mark.parametrize("pid", IDS)
def test_a_plugin_that_is_not_installed_does_not_exist(fresh, pid):
    for method, path in ROUTES[pid]:
        assert call(method, path) == {"obj": {"error": "not installed"}, "code": 404}, (method, path)


def test_the_integrations_route_lists_installs_and_removes(fresh):
    box = call("GET", "/local/integrations")
    assert box["code"] == 200 and [p["id"] for p in box["obj"]["plugins"]] == IDS
    box = call("POST", "/local/integrations", {"id": "trackers", "action": "install"})
    assert box["code"] == 200 and box["obj"]["ok"] is True
    assert {p["id"]: p["installed"] for p in box["obj"]["plugins"]}["trackers"] is True
    assert call("GET", "/local/trackers")["code"] == 200
    call("POST", "/local/integrations", {"id": "trackers", "action": "remove"})
    assert call("GET", "/local/trackers")["code"] == 404


def test_the_integrations_route_refuses_what_it_does_not_know(fresh):
    assert call("POST", "/local/integrations", {"id": "teleport", "action": "install"})["code"] == 400
    assert call("POST", "/local/integrations", {"id": "design", "action": "explode"})["code"] == 400


def test_removing_rivendell_mid_run_answers_409(fresh, monkeypatch):
    integrations.set_installed("rivendell", True)
    monkeypatch.setattr(rivendell, "running", lambda: [{"request_id": "r1"}])
    box = call("POST", "/local/integrations", {"id": "rivendell", "action": "remove"})
    assert box["code"] == 409 and "in flight" in box["obj"]["error"]


def test_the_miniapp_state_carries_the_flags(fresh, monkeypatch):
    monkeypatch.setattr(mini.models, "get_models", lambda: [])
    monkeypatch.setattr(state, "project_dir", lambda chat_id: config.BASE_PATH)
    integrations.set_installed("trackers", True)
    assert call("GET", "/api/state")["obj"]["plugins"] == {
        "rivendell": False, "trackers": True, "design": False}
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `~/.cache/mystical-test-venv/bin/python -m pytest tests/test_integrations.py -q`
Expected: the sweep fails on the first route (the real handler answers instead of 404), the route tests get `{"error": "not found"}`, the state test a `KeyError: 'plugins'`.

- [ ] **Step 3: Add the door to both servers, both methods** — the first statement after auth (the dashboard's `_get_api` / `_post_api` have no auth step of their own; put it first):

```python
        if (owner := integrations.route_owner(path)) and not integrations.installed(owner):
            return self._json({"error": "not installed"}, 404)
```

Import `integrations` in each server's existing `from bridge import (...)` list.

- [ ] **Step 4: Add the two routes and the flags**

Dashboard GET `/local/integrations` → `{"plugins": integrations.state()}`. POST: an action other than `install` / `remove` → 400 `{"error": "action must be install or remove"}`; `ValueError` → 400 with its message; `IntegrationError` → 409 with its message; success → `{"ok": True, "plugins": integrations.state()}`. Mini App `_api_state`: add `"plugins": integrations.flags()`.

- [ ] **Step 5: Run the tests**

Run: `~/.cache/mystical-test-venv/bin/python -m pytest tests/test_integrations.py -q` → all pass.
Run: `~/.cache/mystical-test-venv/bin/python -m pytest tests/ -q` → the baseline.

- [ ] **Step 6: Commit**

```bash
git add bridge/dashboard/server.py bridge/miniapp/server.py tests/test_integrations.py
git commit -m "integrations: a plugin that isn't installed has no routes — both servers answer 404 at the door — and /local/integrations installs and removes"
```

---

### Task 3: Origins, the env registry, and the `design` switch

**Files:**
- Modify: `bridge/config.py` — delete `PLUGIN_ORIGINS` and `is_plugin_origin` (~277-292), and the Claude Design block with `DESIGN_SYNC_ENABLE` (~240-247)
- Modify: the four callers of `config.is_plugin_origin` → `integrations.is_plugin_origin`: `bridge/dashboard/server.py:390`, `bridge/miniapp/server.py:654`, `bridge/rivendell.py:2495`, `bridge/runner.py:1461`
- Modify: `bridge/envsettings.py` `state()` (~454) — skip `integrations.hidden_env_keys()`
- Modify: `bridge/aifeatures.py` — delete the `design` entry (~161-172)
- Modify: `bridge/dashboard/server.py` `/local/design/prompt` (~616) — drop the `aifeatures.enabled("design")` check, which the door now makes
- Test: `tests/test_integrations.py`, `tests/test_aifeatures.py`, `tests/test_design_endpoints.py`, `tests/test_rivendell.py:1609-1614`

**Interfaces:**
- Consumes: `integrations.is_plugin_origin`, `hidden_env_keys` (Task 1)

- [ ] **Step 1: Write the failing tests** — in `tests/test_integrations.py`, import `envsettings`, extend `test_a_plugin_that_is_not_installed_does_not_exist` with the spec's other two assertions, and add the installed counterpart:

```python
    spec = next(p for p in integrations.PLUGINS if p["id"] == pid)
    assert not any(integrations.is_plugin_origin(o) for o in spec["origins"])
    assert not {s["key"] for s in envsettings.state()} & set(spec["env_keys"])


def test_an_installed_rivendell_lists_its_env_keys(fresh):
    integrations.set_installed("rivendell", True)
    assert {"FFMPEG_BIN", "WHISPER_BIN", "WHISPER_MODEL"} <= {s["key"] for s in envsettings.state()}
```

In `tests/test_design_endpoints.py`, replace `test_design_prompt_is_refused_while_the_switch_is_off` with:

```python
def test_design_prompt_is_gone_while_claude_design_is_not_installed(client, tmp_repo, monkeypatch):
    monkeypatch.setattr(integrations, "_cache", {"rivendell": True, "trackers": True, "design": False})
    assert client.get(f"/local/design/prompt?kind=link&cwd={tmp_repo}") == {"error": "not installed"}
```

and delete the `monkeypatch.setattr(aifeatures, "enabled", lambda k: True)` line from its other four tests (import `integrations`; drop the `aifeatures` import once unused). In `tests/test_aifeatures.py`: take `"design"` out of the key set in `test_the_registry_covers_every_model_call_the_bridge_makes`, take `"DESIGN_SYNC_ENABLE": "1"` out of `shipped`, delete `test_design_switch_reads_its_env_setting`. In `tests/test_rivendell.py:1612-1614`, assert on `integrations.is_plugin_origin` instead of `rivendell.config.is_plugin_origin`.

- [ ] **Step 2: Run them to make sure the new ones fail**

Run: `~/.cache/mystical-test-venv/bin/python -m pytest tests/test_integrations.py tests/test_aifeatures.py tests/test_design_endpoints.py -q`
Expected: the sweep fails for rivendell on its env keys (`FFMPEG_BIN` is still listed), and `test_aifeatures` fails on the key set. The rest pass already and stay as guards: origins follow the install since Task 1, and the door already refuses the design route. `test_rivendell.py`'s origin test is edited now because Step 3 deletes the function it called.

- [ ] **Step 3: Implement** — delete from `config.py`, switch the four callers, filter `envsettings.state()`, delete the `design` feature and the route's switch check.

- [ ] **Step 4: Confirm nothing else read what you deleted**

Run: `git grep -n -E 'PLUGIN_ORIGINS|config\.is_plugin_origin|DESIGN_SYNC_ENABLE|enabled\("design"\)' -- bridge tests`
Expected: no output.

- [ ] **Step 5: Run the tests**

Run: `~/.cache/mystical-test-venv/bin/python -m pytest tests/ -q` → the baseline.

- [ ] **Step 6: Commit**

```bash
git add bridge/config.py bridge/dashboard/server.py bridge/miniapp/server.py bridge/rivendell.py bridge/runner.py bridge/envsettings.py bridge/aifeatures.py tests/
git commit -m "integrations: plugin origins and Rivendell's env rows exist only while it is installed, and installing Claude Design replaces its AI switch"
```

---

### Task 4: Background paths ask `installed()`

**Files:**
- Modify: `bridge/rivendell.py` `_desired()` (~2017)
- Modify: `bridge/dispatch.py` — `_rivendell_callback` (~140), `_question_callback` (~172), the reply branch of `on_message` (~218)
- Modify: `bridge/runner.py` `_tasks_digest_for` (~128)
- Modify: `bridge/nextup.py` `facts()` tracker read (~165)
- Test: `tests/test_integrations.py`, `tests/test_rivendell_channel.py` (beside `test_a_reply_to_any_other_message_is_still_a_prompt`, which has `_wait_until`), `tests/test_nextup.py`

**Interfaces:**
- Consumes: `integrations.installed` (Task 1)

- [ ] **Step 1: Write the failing tests**

In `tests/test_integrations.py`:

```python
def test_the_rivendell_worker_dials_nothing_while_not_installed(fresh, monkeypatch):
    inst = {"id": "p", "enable": True, "api_url": "http://r", "token": "t"}
    monkeypatch.setattr(rivendell_instances, "raw_instances", lambda: [inst])
    integrations.set_installed("rivendell", False)
    assert rivendell._desired() == {}
    integrations.set_installed("rivendell", True)
    assert rivendell._desired() == {"p": inst}


def test_the_task_digest_is_silent_while_trackers_are_not_installed(fresh, monkeypatch):
    from bridge import aifeatures, runner
    monkeypatch.setattr(aifeatures, "enabled", lambda key: True)
    monkeypatch.setattr(trackers, "digest", lambda rel: "3 open")
    assert runner._tasks_digest_for("/app", None) == ""
    integrations.set_installed("trackers", True)
    assert runner._tasks_digest_for("/app", None) == "3 open"
```

In `tests/test_rivendell_channel.py`:

```python
def test_a_tap_on_an_old_ping_after_remove_does_nothing(monkeypatch):
    """Review focus 5: the buttons outlive the plugin; a tap must not reach it."""
    from bridge import dispatch, integrations
    monkeypatch.setattr(integrations, "_cache", {"rivendell": False, "trackers": True, "design": True})
    acks, touched = [], []
    monkeypatch.setattr(dispatch, "answer_cb", lambda cid, text="": acks.append(text))
    monkeypatch.setattr(rivendell, "resolve_token", lambda t: touched.append(t))
    monkeypatch.setattr(rivendell, "answer_option", lambda t, i: touched.append(t))
    cb = {"id": "cb1", "from": {"id": config.DASH_CHAT_ID},
          "message": {"chat": {"id": config.DASH_CHAT_ID}, "message_id": 7, "text": "◆ ping"}}
    dispatch._rivendell_callback(cb, config.DASH_CHAT_ID, 7, "rv:a:tok")
    dispatch._question_callback(cb, config.DASH_CHAT_ID, 7, "rq:tok:1")
    assert acks == ["Rivendell isn't installed."] * 2 and touched == []


def test_a_reply_to_an_old_ping_after_remove_is_a_prompt(monkeypatch):
    from bridge import dispatch, integrations, state
    monkeypatch.setattr(integrations, "_cache", {"rivendell": False, "trackers": True, "design": True})
    started, asked = [], []
    monkeypatch.setattr(dispatch, "handle_task", lambda *a: started.append(a))
    monkeypatch.setattr(dispatch, "send", lambda *a, **k: None)
    monkeypatch.setattr(rivendell, "answer_reply", lambda mid, text: asked.append(mid))
    store.init()
    dispatch.on_message({"chat": {"id": 555}, "from": {"id": 555}, "text": "only last week",
                         "reply_to_message": {"message_id": 41, "text": "◆ Rivendell job needs you"}})
    _wait_until(lambda: started)
    state.release_run(started[0][2]["id"])
    assert asked == [] and started[0][1] == "only last week"
```

In `tests/test_nextup.py`:

```python
def test_no_tracker_is_read_while_trackers_are_not_installed(monkeypatch):
    from bridge import integrations, trackers
    monkeypatch.setattr(integrations, "_cache", {"rivendell": True, "trackers": False, "design": True})
    asked = []
    monkeypatch.setattr(trackers, "tasks", lambda *a, **k: asked.append(a) or {})
    f = nextup.facts(CHAT, _mkrepo())
    assert asked == [] and f["tracker"] == "" and f["tasks_due"] == []
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `~/.cache/mystical-test-venv/bin/python -m pytest tests/test_integrations.py tests/test_rivendell_channel.py tests/test_nextup.py -q`
Expected: all five new tests fail — the worker returns the instance, the digest returns "3 open", the tap reaches `resolve_token`, the reply is answered, the tracker is read.

- [ ] **Step 3: Implement**
  - `rivendell._desired()`: return `{}` when `not integrations.installed("rivendell")`, inside its existing `try` (local import, like its `rivendell_instances` one).
  - `dispatch._rivendell_callback` and `_question_callback`: first statement — not installed → `answer_cb(cb["id"], "Rivendell isn't installed.")` and return.
  - `dispatch.on_message`'s reply branch: `integrations.installed("rivendell")` joins its condition, so a reply goes on to be a prompt.
  - `runner._tasks_digest_for`: empty unless `integrations.installed("trackers")` and `aifeatures.enabled("tasks")`.
  - `nextup.facts`: `tk = {}` without asking the tracker unless `integrations.installed("trackers")`.

- [ ] **Step 4: Run the tests**

Run: `~/.cache/mystical-test-venv/bin/python -m pytest tests/ -q` → the baseline.

- [ ] **Step 5: Commit**

```bash
git add bridge/rivendell.py bridge/dispatch.py bridge/runner.py bridge/nextup.py tests/
git commit -m "integrations: nothing of a removed plugin runs in the background — no Rivendell socket, no answer to its old Telegram buttons, no task digest, no tracker read for NEXT UP"
```

---

### Task 5: The Rivendell card's data, and the move

**Files:**
- Modify: `bridge/rivendell_instances.py` `_clean` (~128) — a `ws_url` that is absent (`None`) keeps `existing["ws_url"]`; an empty string still clears it
- Modify: `bridge/dashboard/server.py` POST `/local/rivendell` (~1307) — `"ws_url"` is `body["ws_url"][:400]` when the body sends a string, else `None`
- Modify: `bridge/rivendell_video.py` — add `tools() -> dict[str, bool]`
- Modify: `bridge/dashboard/server.py` GET `/local/rivendell` (~535) — add `"video": rivendell_video.tools()`
- Modify: `bridge/move.py` — `"plugins.json"` into `_STATE_FILES` (~85); the `rivendell` next step's text (~2195)
- Test: `tests/test_rivendell_instances.py`, `tests/test_rivendell_video.py`, `tests/test_move.py`

**Interfaces:**
- Produces: `GET /local/rivendell` → `{"instances": [...], "video": {"ffmpeg": bool, "whisper": bool, "model": bool}}` (Task 7 reads `video`)

- [ ] **Step 1: Write the failing tests**

In `tests/test_rivendell_instances.py`:

```python
def test_update_without_a_ws_url_keeps_the_stored_one(monkeypatch):
    """Review focus 3: the panel's form lost its ws url field; REPLACE TOKEN must not wipe it."""
    _fresh_db(monkeypatch)
    a = ri.add_instance(name="p", api_url="http://x", token="rvd_original", ws_url="wss://x/agent")
    ri.update_instance(a["id"], name="p", api_url="http://x", token="rvd_new")
    assert ri.raw_instances()[0]["ws_url"] == "wss://x/agent"
    ri.update_instance(a["id"], name="p", api_url="http://x", token="", ws_url="")
    assert ri.raw_instances()[0]["ws_url"] == "", "an explicit empty value still clears it"
```

In `tests/test_rivendell_video.py` (it imports the module as `rv`):

```python
def test_tools_says_which_video_tools_are_found(monkeypatch, tmp_path):
    model = tmp_path / "ggml.bin"
    model.write_bytes(b"x")
    monkeypatch.setattr(rv.config, "FFMPEG_BIN", "/bin/sh")               # any executable
    monkeypatch.setattr(rv.config, "WHISPER_BIN", str(tmp_path / "no-whisper"))
    monkeypatch.setattr(rv.config, "WHISPER_MODEL", str(model))
    assert rv.tools() == {"ffmpeg": True, "whisper": False, "model": True}
```

In `tests/test_move.py`: where the old-machine fixture writes `trackers.json` (~182), also write `plugins.json` = `{"rivendell": true, "trackers": false, "design": false}`; add `"plugins.json"` to the export-listing assertion (~664); after the import (where ~371 reads the new machine's `rivendell_instances.json`), assert `json.load(open(os.path.join(new.state, "plugins.json"))) == {"rivendell": True, "trackers": False, "design": False}`.

- [ ] **Step 2: Run them to make sure they fail**

Run: `~/.cache/mystical-test-venv/bin/python -m pytest tests/test_rivendell_instances.py tests/test_rivendell_video.py tests/test_move.py -q`
Expected: the ws url test reads `""`, `tools` is missing, the move assertions don't find `plugins.json`.

- [ ] **Step 3: Implement**
  - `_clean`: `ws_url` from `fields` when it is not `None`, else `(existing or {}).get("ws_url", "")`, normalised as today.
  - `rivendell_video.tools()`: `shutil.which(config.FFMPEG_BIN)`, `shutil.which(config.WHISPER_BIN)`, `os.path.isfile(os.path.expanduser(config.WHISPER_MODEL))` — expanded the way `transcribe` expands it, since a saved override isn't.
  - `move.py` step text: "Rivendell came over switched OFF. Turn it on under Settings ▸ Integrations ▸ Rivendell only once the old machine's bridge is stopped, or both will run its jobs."

- [ ] **Step 4: Run the tests**

Run: `~/.cache/mystical-test-venv/bin/python -m pytest tests/ -q` → the baseline.

- [ ] **Step 5: Commit**

```bash
git add bridge/rivendell_instances.py bridge/rivendell_video.py bridge/dashboard/server.py bridge/move.py tests/
git commit -m "rivendell: an edit that doesn't send a ws url keeps the stored one, the panel learns whether the video tools are found, and a move carries which plugins are installed"
```

---

### Task 6: The dashboard reads the flags and hides what isn't installed

**Files:**
- Modify: `bridge/dashboard/web/src/api.ts` — types beside `AiFeature` (~984); methods beside `aiFeatures` (~1497); `rivendell()` (~1740)
- Create: `bridge/dashboard/web/src/lib/integrations.ts`
- Modify: `bridge/dashboard/web/src/App.tsx` — the RIVENDELL poll and tab (~1751-1782, ~1829), the project menu (~2025-2029)
- Modify: `bridge/dashboard/web/src/components/hud/SessionsPanel.tsx` — the `PLUGINS` registry (~82-97), `pluginsConfigured` (~320-332), `showPlugins` (~882-892), `<RivendellQueue>` (~1073)
- Modify: `bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx` — ~104, the tracker fetch (~142), the tabs (~218-221), the tracker chip / LINK TASKS (~268-300)
- Modify: `bridge/dashboard/web/src/components/Composer.tsx` — the DESIGN button (~912-952)
- Modify: `bridge/dashboard/web/src/components/hud/SkillsFold.tsx` — `EXTRA_ICONS` (~37), `ExtrasGrid` (~138-160)
- Modify: `bridge/dashboard/web/src/components/hud/MoveDock.tsx:157`

**Interfaces:**
- Consumes: `GET/POST /local/integrations`, `GET /local/rivendell`'s `video` (Tasks 2, 5)
- Produces (Task 7 uses):
  - `api.ts`: `export interface Integration { id: string; label: string; blurb: string; needs: string; installed: boolean; summary: string }`, `export interface VideoTools { ffmpeg: boolean; whisper: boolean; model: boolean }`, `api.integrations(): Promise<{ plugins: Integration[] }>`, `api.setIntegration(id: string, action: "install" | "remove"): Promise<{ ok: boolean; plugins: Integration[] }>`, and `api.rivendell()` typed `{ instances: RivendellInstance[]; video?: VideoTools }`
  - `lib/integrations.ts`: `useIntegrations(): Record<string, boolean>`, `refreshIntegrations(): Promise<void>`, `setIntegrations(list: Integration[]): void`

- [ ] **Step 1: Add the API types and methods, and `lib/integrations.ts`**

`lib/integrations.ts` is `lib/ai.ts`'s shape: one fetch, many readers, unknown reads as off. One addition: when the fetch fails with `"not found"` (what `req` throws for this server's 404, an old bridge), publish `{ rivendell: true, trackers: true, design: true }` — that bridge has no install step and shows everything (ruling 4). Any other failure keeps the last answer.

- [ ] **Step 2: Gate each surface** (`const plugins = useIntegrations()` where needed)
  - `App.tsx`: poll `/local/rivendell` only while `plugins.rivendell` (the effect re-runs on it); derive `links = plugins.rivendell ? rivendell : []` and read it everywhere `rivendell` is read below the poll (`rivendellOn`, `rivendellDown`, the bell's per-break notices), so REMOVE clears the tab, the castle alert and the bell at once. Project menu: "Design system" while `plugins.design` (was `ai.design`), "Tasks" while `plugins.trackers`.
  - `SessionsPanel.tsx`: delete `pluginsConfigured` and its effect, and the registry's `flag` field (it read `RIVENDELL_ENABLE` from the env registry, which stopped listing it, so the tab only ever appeared through leftover rows). The PLUGINS mode exists only while `plugins.rivendell`; a saved `plugins` mode with Rivendell not installed renders as Attention without overwriting the saved pref; `<RivendellQueue>` renders only while installed.
  - `AnalyzeModal.tsx`: the tracker chip / LINK TASKS span and the TASKS tab only while `plugins.trackers`, and the tracker fetch doesn't run otherwise (re-run it when `plugins.trackers` arrives, so a slow flag read doesn't leave TASKS missing). DESIGN tab on `plugins.design`, replacing `aiFeatures.design`.
  - `Composer.tsx`: the DESIGN button only while `plugins.design`.
  - `SkillsFold.tsx` `ExtrasGrid`: render the cards and the `on of total` count from the list without `tasks` (it lives in Settings ▸ Integrations ▸ Trackers now); delete `design: Shapes` from `EXTRA_ICONS`, and the `Shapes` import if nothing else uses it.
  - `MoveDock.tsx`: `"OPEN PLUGINS ▸"` → `"OPEN INTEGRATIONS ▸"` (keep `openSettings("plugins")`; Task 7 maps it).

- [ ] **Step 3: Type-check**

Run: `cd bridge/dashboard/web && ./node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: no output.

- [ ] **Step 4: Confirm nothing still gates on the deleted switch**

Run: `git grep -n -E 'ai\.design|aiFeatures\.design|pluginsConfigured' -- bridge/dashboard/web/src`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add bridge/dashboard/web/src
git commit -m "dashboard: Rivendell's tab, queue and alerts, LINK TASKS and TASKS, the DESIGN tab and button show only while their plugin is installed"
```

---

### Task 7: Settings ▸ Integrations

**Files:**
- Modify: `bridge/dashboard/web/src/components/hud/SettingsModal.tsx`:
  - `Tab` (~128): `"plugins"` → `"integrations"`
  - `LEGACY_TAB` / `normalizeTab` (~135-140): `plugins` → `integrations`, section `RIVENDELL`; the others keep landing on AI MANAGEMENT
  - `TABS` (~170): the INTEGRATIONS entry
  - `INDEX` (~207-208): `tab: "integrations"` for `RIVENDELL` and `ADD AN INSTANCE`, plus `TRACKERS`, `CLAUDE DESIGN`, `AVAILABLE`
  - render (~4346): `{shown === "integrations" && <IntegrationsPanel />}`; delete SYSTEM's TRACKERS `Section` (~4386-4396)
  - `RivendellPanel` (~1777, ~1789, ~1819): drop the ws url input, its state and its payload key (leave ~1750, which resends the stored value); add the VIDEO JOBS row
  - new `IntegrationsPanel` beside `RivendellPanel`, reusing `Section`, `Row`, `Switch`, `CARD`
- Avoid `index.css` changes: the AVAILABLE grid is `aim-xgrid` of `aim-x` cards

**Interfaces:**
- Consumes: Task 6's `api.integrations`, `api.setIntegration`, `setIntegrations`, `VideoTools`; `api.aiFeatures`, `api.setAiFeature`, `setAiFeatures` (existing); `askConfirm` from `../ui/Ask`

Values:
- TABS entry: `{ key: "integrations", label: "INTEGRATIONS", hint: "installed · available", icon: Waypoints, group: "THE WORK", about: "Other systems the bridge does work for. Each one ships with Mystical but stays silent until you install it: no tab, no card, no rows, no worker." }`
- INDEX terms: `TRACKERS` "teamwork jira tracker tasks link token connection digest"; `CLAUDE DESIGN` "claude design system link pull sync skill tokens components"; `AVAILABLE` "install integration plugin add rivendell teamwork jira claude design"; add "video ffmpeg whisper" to `RIVENDELL`'s.
- AVAILABLE copy (mockup 07): Teamwork — "A repo linked to a Teamwork project opens every session with what is open and overdue; TASKS tab, LINK TASKS, updates posted through the run." · foot "API key". Jira — "The same, against an Atlassian site: one connection per site, an API token and the account it belongs to." · foot "API token". Rivendell and Claude Design use the registry's `blurb` and `needs`. Chips: RV (`--ok`), TW (`--purple`), JR (`--info`), CD (`--warn`). The section's desc: "Install one to connect it. Nothing is downloaded; the code is already here, switched off."
- REMOVE confirm: "Remove {label}? Its tabs, buttons and worker go; its connections stay on disk, so installing it again restores them."
- Old bridge (the fetch fails `"not found"`): the page is one line — "This bridge is running code from before integrations. Restart it to install or remove one."
- All installed: AVAILABLE says "Everything that ships with Mystical is installed."

- [ ] **Step 1: Rename the tab, map the deep link, swap the index entries, move TRACKERS out of SYSTEM**

`openSettings("plugins", id)` (the RIVENDELL tab's REPLACE TOKEN, the bell's broken-link entry, MoveDock) keeps working: `normalizeTab` maps it, and `RivendellPanel` still takes the instance id with `takeSettingsFocus()` on mount.

- [ ] **Step 2: Build `IntegrationsPanel`**
  - Fetch `api.integrations()` on mount; hand every answer to `setIntegrations` (and the POST's `plugins`), so the rest of the dashboard changes in the same frame.
  - One `Section` per installed plugin, titled `RIVENDELL`, `TRACKERS` or `CLAUDE DESIGN` (search lands on these titles), its blurb as the desc, and a first row holding its `summary` and REMOVE. A refused REMOVE shows the bridge's message in that card (the 409's text verbatim).
    - RIVENDELL: `<RivendellPanel />`.
    - TRACKERS: a TASK DIGEST `Row` + `Switch`, its hint and ⓘ from the `tasks` row of `api.aiFeatures()`; toggling calls `api.setAiFeature("tasks", !on)` then `setAiFeatures(fresh)` (`ExtrasGrid`'s pattern). Then `<TrackersPanel />`.
    - CLAUDE DESIGN: one line — "Adds ANALYZE ▸ DESIGN (link · pull · sync), the composer's DESIGN button and the project menu's Design system. A repo is linked from ANALYZE ▸ DESIGN."
  - `Section title="AVAILABLE"`: a card per plugin not installed; `trackers` shows as two cards, Teamwork and Jira, both installing `trackers`. INSTALL → `api.setIntegration(id, "install")`.
- [ ] **Step 3: The Rivendell form and the VIDEO JOBS row** — drop the ws url field. Store the GET's `video`; while present, a `Row` "VIDEO JOBS" with desc "A client's recording, transcribed and framed on this machine: ffmpeg · whisper-cli · the model file" and a chip: all found → FOUND (`--ok`); otherwise "MISSING: " + the missing names (`--err`).

- [ ] **Step 4: Type-check**

Run: `cd bridge/dashboard/web && ./node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: no output.

- [ ] **Step 5: Confirm the old tab is gone everywhere it was a settings tab**

Run: `git grep -n -E 'tab: "plugins"|shown === "plugins"|"PLUGINS", hint' -- bridge/dashboard/web/src`
Expected: no output. (The MOVE panel's `"plugins"` section key and SKILLS' `"plugins"` mode are Claude Code plugins; leave them.)

- [ ] **Step 6: Commit**

```bash
git add bridge/dashboard/web/src
git commit -m "settings: PLUGINS becomes INTEGRATIONS — installed cards with their settings, available ones with INSTALL — and TRACKERS leaves SYSTEM for its card"
```

---

### Task 8: Mini App WORK

**Files:**
- Modify: `bridge/miniapp/web/src/lib/api.ts` — `AppState` (~19): `plugins?: Record<string, boolean>`
- Modify: `bridge/miniapp/web/src/routes/work.tsx` (~31-62, ~94)

**Interfaces:**
- Consumes: `/api/state.plugins` (Task 2)

- [ ] **Step 1: Gate WORK's tracker section**

Read `/api/state` with the shared `["state"]` query. `trackersOn` is false until the state answers, then `state.plugins?.trackers ?? true` (no `plugins` key means a bridge from before integrations, which has trackers). The TASKS tab, the label's tracker query (`enabled: trackersOn`) and `TasksTab`'s own query only while it is on; a `tasks` tab left selected after a removal renders QUEUE.

- [ ] **Step 2: Type-check**

Run: `cd bridge/miniapp/web && ./node_modules/.bin/tsc -p tsconfig.app.json --noEmit`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add bridge/miniapp/web/src
git commit -m "miniapp: WORK's TASKS tab shows only while the trackers plugin is installed"
```

---

### Task 9: Verify, then ship

**Files:**
- Modify: `docs/superpowers/specs/settings-remap-design.md` (status line, line 3)

- [ ] **Step 1: Backend suite** — `~/.cache/mystical-test-venv/bin/python -m pytest tests/ -q` → only the 7 known macOS-only failures.

- [ ] **Step 2: Both web apps build, and the existing checks still pass**

Run (from each `web/`): `./node_modules/.bin/tsc -b && ./node_modules/.bin/vite build` → builds.
Run (from `bridge/dashboard/web`): `for f in src/lib/*.check.ts; do node --experimental-strip-types "$f" >/dev/null || echo "FAIL $f"; done` → no FAIL line.

- [ ] **Step 3: Finish the branch** — `superpowers:finishing-a-development-branch`. The bridge runs master's checkout, so shipping needs the merge into local master; pushing waits for the user's explicit OK.

- [ ] **Step 4: Ask the user before shipping.** Building master's dists changes the live dashboard at once (the bridge reads its dist per request), and the restart briefly kills hosted turns (they auto-resume).

- [ ] **Step 5: Build master's dists (`bridge-ship`), then capture 1 before restarting (Review focus 2)** — the new dashboard on the still-old bridge, with the Mac kit (`.mystical/probe-mac/cdp.mjs`, see `bridge-eyes`). Expect the RIVENDELL rail tab still there and Settings ▸ INTEGRATIONS showing the restart line.

- [ ] **Step 6: Restart with `bridge-ship`** (from inside a session it needs `setsid`).

- [ ] **Step 7: Captures after the restart** — `curl -s 127.0.0.1:8790/local/integrations` shows rivendell installed (adopted: this Mac has an enabled instance) and `~/.bridge_state/plugins.json` is mode 0600. Capture Settings ▸ INTEGRATIONS in FLINT and AURORA against `shots/07-integrations.png`; SYSTEM without TRACKERS; the extras grid without TASK DIGEST or DESIGN SYSTEM. Install Claude Design, then remove it: the composer's DESIGN button and ANALYZE ▸ DESIGN appear, then leave. Deliver the captures with `mcp__verify__Attach`.

- [ ] **Step 8: Mark the spec on master** — its status line gains "slice 2 shipped <date> as <merge sha>"; commit.
