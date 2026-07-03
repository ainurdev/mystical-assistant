# Project Memory Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-project Memory tab (with an Ask/Auto/Off posture) to the dashboard project modal, and auto-generate memory-grounded prompt suggestions in a new session's empty state — after fixing a latent bug that silently disables memory capture in production.

**Architecture:** Backend adds a per-project `memory_mode` to `project_config` (project-wide, default `ask`), enforced in `runner` for injection and capture; `memory.propose` gains an `auto` mode; a new `memory.suggest` runs a cached Haiku pass over a project's Context Pack. The dashboard exposes these via the existing `/local/project/settings` route plus a new `/local/memory/suggest`, and renders a `MemoryTab` in `AnalyzeModal` and `SuggestionChips` in the fresh-session state.

**Tech Stack:** Python 3 stdlib (bridge backend, sqlite3), React + TypeScript + Vite (dashboard `web`), lucide-react icons.

**Design spec:** `docs/superpowers/specs/2026-07-03-project-memory-dashboard-design.md`

## Global Constraints

- Backend is **Python stdlib only** — no new dependencies.
- **Memory posture values are exactly `ask` | `auto` | `off`**; default is `ask`. Invalid/blank coerces to `ask`.
- `memory_mode` is **project-wide** (bare-project key, branch ignored) — unlike `run_cmd`/`prod_url` which are per-branch.
- `config.MEMORY_ENABLE` remains the master gate: effective behavior = `MEMORY_ENABLE` AND per-project posture.
- The injected memory pack must stay **byte-stable within a session** (append last in the system prompt) — do not reorder `_compose_system_prompt`.
- The `run` callable passed to `memory.propose`/`memory.suggest` is **1-argument** `run(prompt) -> str`; the default binds `owner_id` via a closure.
- Match existing **test styles per file**: `tests/test_project_config.py` is pytest-style (`tmp_path`, `monkeypatch`); `tests/test_memory_*.py` are plain-function files with a `__main__` runner (run via `python tests/test_x.py`).
- The dashboard is served from a **prebuilt `dist`**; after any `web/src` change, rebuild with `npm --prefix bridge/dashboard/web run build`.
- Backend changes require a **bridge restart** to take effect. Do NOT restart the running bridge mid-session unless the user asks — the executor of this plan restarts at its own discretion.
- **Commit after every task.**

---

### Task 1: Fix the silently-broken memory capture default-run binding

`memory.propose` calls its `run` callable with one argument (the prompt), but the production default `_default_run(owner_id, prompt)` needs two. In production the call raises `TypeError`, which the `try/except` swallows, so `propose` always returns `[]` and no candidates are ever created. Existing tests inject a 1-arg `run` and mask this. Bind `owner_id` into the default so the 1-arg convention holds, and add a regression test that exercises the REAL default path.

**Files:**
- Modify: `bridge/memory.py:161`
- Test: `tests/test_memory_capture.py`

**Interfaces:**
- Consumes: `memory._default_run(owner_id: int, prompt: str) -> str` (unchanged); `runner.run_blocking(...)` returns a 4-tuple `(result, session_id, cost, is_error)`.
- Produces: `memory.propose(...)` default path now actually produces candidates.

- [ ] **Step 1: Write the failing regression test**

Add to `tests/test_memory_capture.py` (after `test_run_exception_is_swallowed`, before the `__main__` block):

```python
def test_default_run_path_produces_candidate():
    # Exercises the REAL default run (no injected `run`): a regression guard for the
    # owner-binding bug where propose() called a 2-arg _default_run with 1 arg.
    o = 4010
    sid, tid = _session_turn(o, "/p")
    from bridge import runner
    raw = '[{"op":"ADD","type":"convention","scope":"project","title":"pnpm","body":"use pnpm"}]'
    old = runner.run_blocking
    runner.run_blocking = lambda owner, prompt, **k: (raw, None, None, False)
    try:
        ids = memory.propose(o, sid, tid, "/p", "feat", "did real work", ["a.py"])
    finally:
        runner.run_blocking = old
    assert len(ids) == 1
    assert store.get_memory(ids[0])["title"] == "pnpm"
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python tests/test_memory_capture.py`
Expected: FAIL on `test_default_run_path_produces_candidate` — `assert len(ids) == 1` fails because `ids == []` (the TypeError from the mismatched default is swallowed).

- [ ] **Step 3: Fix the default-run binding**

In `bridge/memory.py`, inside `propose`, change line 161 from:

```python
    run = run or _default_run
```

to:

```python
    run = run or (lambda p: _default_run(owner_id, p))
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `python tests/test_memory_capture.py`
Expected: PASS — all tests including `test_default_run_path_produces_candidate`.

- [ ] **Step 5: Commit**

```bash
git add bridge/memory.py tests/test_memory_capture.py
git commit -m "fix(memory): bind owner_id into propose's default run (capture was a silent no-op)"
```

---

### Task 2: Add an `auto` mode to `memory.propose`

`auto=True` writes proposals straight to `status="active"` (skipping the Keep/Skip gate) and, for an UPDATE that supersedes an existing memory, archives the superseded row immediately (mirroring what `keep_or_skip` does on Keep).

**Files:**
- Modify: `bridge/memory.py:153-183` (the `propose` function)
- Test: `tests/test_memory_capture.py`

**Interfaces:**
- Consumes: `store.add_memory(..., status=...)`, `store.set_memory_status(mem_id, status)`.
- Produces: `memory.propose(..., *, run=None, auto: bool = False)` — when `auto`, candidates are created `active` and superseded targets are archived.

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_memory_capture.py` (after the Task 1 test):

```python
def test_auto_creates_active_not_candidate():
    o = 4011
    sid, tid = _session_turn(o, "/p")
    raw = '[{"op":"ADD","type":"convention","scope":"project","title":"pnpm","body":"use pnpm"}]'
    ids = memory.propose(o, sid, tid, "/p", "feat", "did stuff", ["a.py"],
                         run=lambda _p: raw, auto=True)
    assert len(ids) == 1
    assert store.get_memory(ids[0])["status"] == "active"


def test_auto_update_archives_superseded_target():
    o = 4012
    sid, tid = _session_turn(o, "/p")
    target = store.add_memory(o, "project", "goal", "old goal", "old",
                              project_path="/p", branch="feat", status="active")
    raw = ('[{"op":"UPDATE","id":"%s","type":"goal","scope":"project",'
           '"title":"new goal","body":"new"}]') % target["id"]
    ids = memory.propose(o, sid, tid, "/p", "feat", "x", [], run=lambda _p: raw, auto=True)
    assert store.get_memory(ids[0])["status"] == "active"
    assert store.get_memory(ids[0])["supersedes_id"] == target["id"]
    assert store.get_memory(target["id"])["status"] == "archived"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python tests/test_memory_capture.py`
Expected: FAIL — `propose() got an unexpected keyword argument 'auto'`.

- [ ] **Step 3: Add the `auto` parameter and behavior**

In `bridge/memory.py`, change the `propose` signature (currently lines 153-155):

```python
def propose(owner_id: int, session_id: str, turn_id: str, project: str,
            branch: "str | None", assistant_text: str, edited_files: list[str], *,
            run=None) -> list[str]:
```

to:

```python
def propose(owner_id: int, session_id: str, turn_id: str, project: str,
            branch: "str | None", assistant_text: str, edited_files: list[str], *,
            run=None, auto: bool = False) -> list[str]:
```

Then, inside the `for op in ops:` loop, change the `add_memory` call and add the archive-on-auto step. Replace (currently lines 176-180):

```python
        sup = op["id"] if (op["op"] == "UPDATE" and op.get("id") in existing_ids) else None
        m = store.add_memory(owner_id, scope, t, op["title"], op["body"],
                             project_path=proj, branch=br, status="candidate",
                             source_session_id=session_id, source_turn_id=turn_id,
                             supersedes_id=sup)
```

with:

```python
        sup = op["id"] if (op["op"] == "UPDATE" and op.get("id") in existing_ids) else None
        m = store.add_memory(owner_id, scope, t, op["title"], op["body"],
                             project_path=proj, branch=br,
                             status="active" if auto else "candidate",
                             source_session_id=session_id, source_turn_id=turn_id,
                             supersedes_id=sup)
        if auto and sup:                         # no human gate → archive the target now
            store.set_memory_status(sup, "archived")
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python tests/test_memory_capture.py`
Expected: PASS — all tests.

- [ ] **Step 5: Commit**

```bash
git add bridge/memory.py tests/test_memory_capture.py
git commit -m "feat(memory): auto-keep mode in propose (active + archive superseded)"
```

---

### Task 3: Per-project memory posture in `project_config`

Add `memory_mode` / `set_memory_mode`, stored at the bare-project key (project-wide, branch ignored).

**Files:**
- Modify: `bridge/project_config.py` (add after `set_prod_url`, ~line 88)
- Test: `tests/test_project_config.py`

**Interfaces:**
- Consumes: `project_config._get_field`, `project_config._set_field`.
- Produces: `project_config.memory_mode(project: str) -> str` (returns `ask`|`auto`|`off`, default `ask`); `project_config.set_memory_mode(project: str, mode: str) -> str` (validates, returns the stored mode).

- [ ] **Step 1: Write the failing tests**

Add to `tests/test_project_config.py`:

```python
def test_memory_mode_default_is_ask(tmp_path, monkeypatch):
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "pc.json"))
    assert project_config.memory_mode("/repo") == "ask"


def test_memory_mode_roundtrip_and_validation(tmp_path, monkeypatch):
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "pc.json"))
    assert project_config.set_memory_mode("/repo", "auto") == "auto"
    assert project_config.memory_mode("/repo") == "auto"
    assert project_config.set_memory_mode("/repo", "off") == "off"
    assert project_config.memory_mode("/repo") == "off"
    # invalid coerces to ask (and clears back to default)
    assert project_config.set_memory_mode("/repo", "bogus") == "ask"
    assert project_config.memory_mode("/repo") == "ask"


def test_memory_mode_is_project_wide_not_branch(tmp_path, monkeypatch):
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "pc.json"))
    project_config.set_memory_mode("/repo", "off")
    # A per-branch run_cmd does not shadow the project-wide posture.
    project_config.set_run_cmd("/repo", "npm run dev", branch="feat/x")
    assert project_config.memory_mode("/repo") == "off"
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pytest tests/test_project_config.py -v`
Expected: FAIL — `AttributeError: module 'bridge.project_config' has no attribute 'memory_mode'`.

- [ ] **Step 3: Implement `memory_mode` / `set_memory_mode`**

In `bridge/project_config.py`, add after `set_prod_url` (after line 87):

```python
_MEMORY_MODES = ("ask", "auto", "off")


def memory_mode(project: str) -> str:
    """Per-project memory posture: 'ask' (default) | 'auto' | 'off'. Project-wide
    (never branch-scoped), so it reads the bare-project key only."""
    return _get_field(project, None, "memory_mode") or "ask"


def set_memory_mode(project: str, mode: str) -> str:
    """Persist the posture; invalid/blank coerces to 'ask'. 'ask' is the default, so
    it is stored blank (clearing the field) to keep the JSON minimal. Returns the
    effective mode."""
    mode = (mode or "").strip().lower()
    if mode not in _MEMORY_MODES:
        mode = "ask"
    _set_field(project, None, "memory_mode", "" if mode == "ask" else mode)
    return mode
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pytest tests/test_project_config.py -v`
Expected: PASS — all tests.

- [ ] **Step 5: Commit**

```bash
git add bridge/project_config.py tests/test_project_config.py
git commit -m "feat(project_config): per-project memory_mode posture (ask/auto/off)"
```

---

### Task 4: `memory.suggest` — cached, memory-grounded prompt suggestions

A cheap Haiku pass over a project's Context Pack returning up to 3 next-step prompts, memoized per `(owner, project, branch, namespace_version)` so it only calls the model when memory changed.

**Files:**
- Modify: `bridge/memory.py` (add a new section after `render_pack`, before the capture section)
- Test: `tests/test_memory_suggest.py` (create)

**Interfaces:**
- Consumes: `memory.render_pack(owner_id, project, branch)`, `store.namespace_version(owner_id, project, branch)`, `memory._default_run(owner_id, prompt)`.
- Produces: `memory.suggest(owner_id: int, project: str, branch: "str | None", *, run=None) -> list[str]` (≤3 strings; `[]` when disabled/empty/malformed); `memory._parse_suggestions(raw: str) -> list[str]`; `memory._build_suggest_prompt(pack: str) -> str`.

- [ ] **Step 1: Write the failing tests**

Create `tests/test_memory_suggest.py`:

```python
"""Unit tests for memory.suggest (memory-grounded prompt ideas + cache).
Run: `python tests/test_memory_suggest.py`
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ.setdefault("BASE_PATH", "/tmp")
os.environ["BRIDGE_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")

from bridge import config, memory, store  # noqa: E402

store.init()


def _seed(owner, project):
    store.add_memory(owner, "project", "convention", "use pnpm", "always pnpm",
                     project_path=project, branch=None, status="active")


def test_parse_suggestions_caps_three_and_trims():
    assert memory._parse_suggestions('["one","two","three","four"]') == ["one", "two", "three"]
    assert memory._parse_suggestions('```json\n["a","b"]\n```') == ["a", "b"]
    assert memory._parse_suggestions("not json") == []
    assert memory._parse_suggestions('{"a":1}') == []          # object, not array


def test_suggest_empty_pack_returns_empty_without_calling():
    o = 5001
    calls = []
    out = memory.suggest(o, "/nomem", None, run=lambda _p: calls.append(1) or '["x"]')
    assert out == [] and calls == []


def test_suggest_parses_and_caps_three():
    o = 5002
    _seed(o, "/p")
    raw = '["one","two","three","four","five"]'
    assert memory.suggest(o, "/p", None, run=lambda _p: raw) == ["one", "two", "three"]


def test_suggest_caches_by_version():
    o = 5003
    _seed(o, "/p")
    calls = []
    run = lambda _p: calls.append(1) or '["a","b","c"]'  # noqa: E731
    first = memory.suggest(o, "/p", None, run=run)
    second = memory.suggest(o, "/p", None, run=run)
    assert first == ["a", "b", "c"] and second == ["a", "b", "c"]
    assert len(calls) == 1                                     # 2nd served from cache


def test_suggest_disabled_returns_empty():
    o = 5004
    _seed(o, "/p")
    old = config.MEMORY_ENABLE
    config.MEMORY_ENABLE = False
    try:
        assert memory.suggest(o, "/p", None, run=lambda _p: '["x"]') == []
    finally:
        config.MEMORY_ENABLE = old


def test_suggest_malformed_returns_empty():
    o = 5005
    _seed(o, "/p")
    assert memory.suggest(o, "/p", None, run=lambda _p: "garbage") == []


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items())
           if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL {fn.__name__}: {type(e).__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    raise SystemExit(1 if failed else 0)
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `python tests/test_memory_suggest.py`
Expected: FAIL — `module 'bridge.memory' has no attribute '_parse_suggestions'` / `suggest`.

- [ ] **Step 3: Implement `suggest`**

In `bridge/memory.py`, add after `render_pack` (after line 75) and before the `# --- capture` section:

```python
# --- suggestions (memory-grounded prompt ideas for a fresh session) ---------
# Memoized per (owner, project, branch) → (namespace_version, list[str]); recomputes
# only when the project's active memory changed, so auto-fetch on every new session
# is cheap.
_suggest_cache: dict = {}


def _build_suggest_prompt(pack: str) -> str:
    return (
        "Below is the curated memory for a software project. Propose exactly 3 "
        "concrete next-step prompts the developer could send to an AI coding "
        "assistant to make progress on THIS project — grounded in the goal, "
        "conventions, decisions, and gotchas below. Each is one imperative "
        "sentence, specific to this project (no generic advice).\n\n"
        "Return STRICT JSON only: an array of exactly 3 short strings. No prose.\n\n"
        f"{pack}")


def _parse_suggestions(raw: str) -> list[str]:
    """Parse the model's JSON array of strings; tolerant of ```json fences / prose;
    returns at most 3 non-empty strings, or [] on anything malformed (never raises)."""
    try:
        data = json.loads(raw)
    except Exception:  # noqa: BLE001
        m = re.search(r"\[.*\]", raw, re.S)
        if not m:
            return []
        try:
            data = json.loads(m.group(0))
        except Exception:  # noqa: BLE001
            return []
    if not isinstance(data, list):
        return []
    return [s.strip() for s in data if isinstance(s, str) and s.strip()][:3]


def suggest(owner_id: int, project: str, branch: "str | None", *, run=None) -> list[str]:
    """Up to 3 memory-grounded next-step prompts for a new session. Best-effort:
    [] when memory is disabled, the project has no memory, or the model output is
    malformed. Cached by namespace_version so repeat calls don't re-spend."""
    if not config.MEMORY_ENABLE:
        return []
    pack = render_pack(owner_id, project, branch)
    if not pack.strip():
        return []
    version = store.namespace_version(owner_id, project, branch)
    key = (owner_id, project, branch)
    cached = _suggest_cache.get(key)
    if cached and cached[0] == version:
        return cached[1]
    run = run or (lambda p: _default_run(owner_id, p))
    try:
        out = _parse_suggestions(run(_build_suggest_prompt(pack)) or "")
    except Exception:  # noqa: BLE001
        log.debug("memory suggest failed", exc_info=True)
        return []
    _suggest_cache[key] = (version, out)
    return out
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python tests/test_memory_suggest.py`
Expected: PASS — all tests.

- [ ] **Step 5: Commit**

```bash
git add bridge/memory.py tests/test_memory_suggest.py
git commit -m "feat(memory): suggest() — cached memory-grounded prompt ideas"
```

---

### Task 5: Enforce posture in the runner (injection + capture)

Read `project_config.memory_mode` in the runner: `off` suppresses the injected pack, `off` skips capture, `auto` captures without the human gate.

**Files:**
- Modify: `bridge/runner.py:22` (import), `bridge/runner.py:84-93` (`_memory_pack_for`), `bridge/runner.py:103-115` (`_capture_async`)
- Test: `tests/test_memory_runner.py`

**Interfaces:**
- Consumes: `project_config.memory_mode(project)`, `runner._project_key`, `runner._branch_for`, `memory.render_pack`, `memory.propose(..., auto=...)`.
- Produces: `_memory_pack_for` returns `""` when posture is `off`; `_capture_async` skips when `off` and passes `auto=True` when `auto`.

- [ ] **Step 1: Write the failing test**

Add to `tests/test_memory_runner.py`. First extend the imports line (currently line 16):

```python
from bridge import config, project_config, runner, store  # noqa: E402
```

Then add this test:

```python
def test_memory_pack_for_respects_off_posture():
    key = runner._project_key(555, "/tmp")
    store.add_memory(555, "project", "goal", "ship it", "finish the thing",
                     project_path=key, branch=None, status="active")
    old = project_config.memory_mode
    try:
        project_config.memory_mode = lambda _p: "ask"
        assert "ship it" in runner._memory_pack_for(555, "/tmp")
        project_config.memory_mode = lambda _p: "off"
        assert runner._memory_pack_for(555, "/tmp") == ""
    finally:
        project_config.memory_mode = old
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `python tests/test_memory_runner.py`
Expected: FAIL — with `off` posture the pack is still non-empty (posture not yet enforced), so `assert ... == ""` fails. (May also fail at import if `project_config` isn't imported yet — that's expected before Step 3.)

- [ ] **Step 3: Add the import and enforce posture**

In `bridge/runner.py`, add `project_config` to the bridge import group at line 22. Change:

```python
from bridge import (config, devserver, git, machine, memory, native_activity,
```

to include `project_config` (append it in the import list, keeping alphabetical-ish order):

```python
from bridge import (config, devserver, git, machine, memory, native_activity,
                    project_config,
```

(Insert `project_config,` into the existing parenthesized import — do not create a second `from bridge import`. Verify the final tuple still closes correctly.)

Then replace `_memory_pack_for` (lines 84-93):

```python
def _memory_pack_for(chat_id: int, cwd: "str | None") -> str:
    """Project+branch memory Context Pack for injection. Best-effort: disabled or
    any failure yields an empty pack (never blocks a turn)."""
    if not config.MEMORY_ENABLE:
        return ""
    try:
        return memory.render_pack(chat_id, _project_key(chat_id, cwd),
                                  _branch_for(chat_id, cwd))
    except Exception:  # noqa: BLE001
        return ""
```

with (add the posture check):

```python
def _memory_pack_for(chat_id: int, cwd: "str | None") -> str:
    """Project+branch memory Context Pack for injection. Best-effort: disabled, an
    'off' project posture, or any failure yields an empty pack (never blocks a turn)."""
    if not config.MEMORY_ENABLE:
        return ""
    try:
        project = _project_key(chat_id, cwd)
        if project_config.memory_mode(project) == "off":
            return ""
        return memory.render_pack(chat_id, project, _branch_for(chat_id, cwd))
    except Exception:  # noqa: BLE001
        return ""
```

Then replace `_capture_async` (lines 103-115):

```python
def _capture_async(chat_id: int, session_id: "str | None", turn_id: str,
                   cwd: "str | None", assistant_text: str, edited_files: list) -> None:
    """Run the post-turn memory extractor off the hot path (fire-and-forget)."""
    if not config.MEMORY_ENABLE or not session_id or not (assistant_text or "").strip():
        return

    def work():
        try:
            memory.propose(chat_id, session_id, turn_id, _project_key(chat_id, cwd),
                           _branch_for(chat_id, cwd), assistant_text, edited_files)
        except Exception:  # noqa: BLE001
            pass
    threading.Thread(target=work, daemon=True).start()
```

with (respect posture: skip on `off`, auto-keep on `auto`):

```python
def _capture_async(chat_id: int, session_id: "str | None", turn_id: str,
                   cwd: "str | None", assistant_text: str, edited_files: list) -> None:
    """Run the post-turn memory extractor off the hot path (fire-and-forget). The
    project's posture gates it: 'off' skips capture, 'auto' keeps without the gate."""
    if not config.MEMORY_ENABLE or not session_id or not (assistant_text or "").strip():
        return
    project = _project_key(chat_id, cwd)
    mode = project_config.memory_mode(project)
    if mode == "off":
        return

    def work():
        try:
            memory.propose(chat_id, session_id, turn_id, project,
                           _branch_for(chat_id, cwd), assistant_text, edited_files,
                           auto=(mode == "auto"))
        except Exception:  # noqa: BLE001
            pass
    threading.Thread(target=work, daemon=True).start()
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `python tests/test_memory_runner.py`
Expected: PASS — all tests including `test_memory_pack_for_respects_off_posture`.

- [ ] **Step 5: Commit**

```bash
git add bridge/runner.py tests/test_memory_runner.py
git commit -m "feat(runner): enforce per-project memory posture (off suppresses, auto auto-keeps)"
```

---

### Task 6: Dashboard endpoints — `memory_mode` in project settings + `/local/memory/suggest`

Thread `memory_mode` through the existing `/local/project/settings` GET+POST, and add a token-gated `POST /local/memory/suggest`. Endpoints are thin pass-throughs to functions unit-tested in Tasks 3–4; there is no dashboard-server test harness in this repo, so verification is a manual curl after a bridge restart.

**Files:**
- Modify: `bridge/dashboard/server.py:334-340` (settings GET), `bridge/dashboard/server.py:497-502` (settings POST), `bridge/dashboard/server.py` (add a memory-suggest POST route near the other `/local/memory/*` routes ~line 557)

**Interfaces:**
- Consumes: `project_config.memory_mode`, `project_config.set_memory_mode`, `memory.suggest`, `git.current_branch_cached`, `browser.rel`, `_abs_project`, `_abs_within`, `state.project_dir`, `self._json`, `_chat()`. All already imported in `server.py`.
- Produces: GET `/local/project/settings` includes `memory_mode`; POST accepts `memory_mode`; POST `/local/memory/suggest {project|cwd|cwd_rel}` → `{suggestions: string[]}`.

- [ ] **Step 1: Add `memory_mode` to the settings GET**

In `bridge/dashboard/server.py`, in the `/local/project/settings` GET handler, add the `memory_mode` line to the returned dict (currently lines 334-340):

```python
            return self._json({
                "scripts": project_config.package_scripts(abs_p),
                "run_cmd": project_config.run_cmd(rel, branch),
                "prod_url": project_config.prod_url(rel, branch),
                "memory_mode": project_config.memory_mode(rel),
                "default_cmd": config.START_CMD,
                "log_path": devserver.DEV_LOG_REL,
            })
```

- [ ] **Step 2: Handle `memory_mode` in the settings POST**

In the `/local/project/settings` POST handler, add a `memory_mode` branch (currently lines 497-502). After the `prod_url` block and before `return self._json(out)`:

```python
            out: dict = {"ok": True}
            if "run_cmd" in body:
                out["run_cmd"] = project_config.set_run_cmd(rel, (body.get("run_cmd") or "")[:1000], branch)
            if "prod_url" in body:
                out["prod_url"] = project_config.set_prod_url(rel, (body.get("prod_url") or "")[:1000], branch)
            if "memory_mode" in body:
                out["memory_mode"] = project_config.set_memory_mode(rel, body.get("memory_mode") or "")
            return self._json(out)
```

- [ ] **Step 3: Add the `/local/memory/suggest` POST route**

In the `_post_api` method, add this route immediately before the `/local/memory/candidate` route (before current line 557):

```python
        if path == "/local/memory/suggest":
            abs_p = (_abs_within((body.get("cwd") or "").strip())
                     or _abs_project(body.get("cwd_rel") or body.get("project"))
                     or state.project_dir(chat))
            rel = browser.rel(abs_p)
            if project_config.memory_mode(rel) == "off":
                return self._json({"suggestions": []})
            branch = git.current_branch_cached(abs_p) or None
            return self._json({"suggestions": memory.suggest(chat, rel, branch)})
```

- [ ] **Step 4: Verify the code imports/parses**

Run: `python -c "import ast; ast.parse(open('bridge/dashboard/server.py').read()); print('OK')"`
Expected: `OK` (syntax valid). Full endpoint behavior is verified manually in Task 10 after a bridge restart.

- [ ] **Step 5: Commit**

```bash
git add bridge/dashboard/server.py
git commit -m "feat(dashboard): memory_mode in project settings + /local/memory/suggest"
```

---

### Task 7: dashboard `api.ts` client additions

Add `memory_mode` to `ProjectSettings`, allow setting it via `setProjectSettings`, and add `memorySuggest`.

**Files:**
- Modify: `bridge/dashboard/web/src/api.ts:184-190` (`ProjectSettings`), `:597-603` (`setProjectSettings`), and inside the `api` object near the other memory calls (~`:562`)

**Interfaces:**
- Consumes: `req<T>`, `PreviewCtx`.
- Produces: `ProjectSettings.memory_mode: string`; `api.setProjectSettings(ctx, { memory_mode })`; `api.memorySuggest(project: string) => Promise<{ suggestions: string[] }>`.

- [ ] **Step 1: Add `memory_mode` to the `ProjectSettings` interface**

In `bridge/dashboard/web/src/api.ts`, change (lines 184-190):

```ts
export interface ProjectSettings {
  scripts: Record<string, string>;
  run_cmd: string | null;
  prod_url: string | null;
  memory_mode: string;
  default_cmd: string;
  log_path: string;
}
```

- [ ] **Step 2: Allow `memory_mode` in `setProjectSettings`**

Change `setProjectSettings` (lines 599-603):

```ts
  setProjectSettings: (ctx: PreviewCtx, patch: { run_cmd?: string; prod_url?: string; memory_mode?: string }) =>
    req<{ ok: boolean; run_cmd?: string | null; prod_url?: string | null; memory_mode?: string }>("/local/project/settings", {
      method: "POST",
      body: { ...ctx, ...patch },
    }),
```

- [ ] **Step 3: Add `memorySuggest`**

In `bridge/dashboard/web/src/api.ts`, inside the `api` object, add after the `memoryPin` function (after line 562):

```ts
  memorySuggest: (project: string) =>
    req<{ suggestions: string[] }>("/local/memory/suggest", {
      method: "POST",
      body: { project },
    }),
```

- [ ] **Step 4: Typecheck**

Run: `npm --prefix bridge/dashboard/web run build`
Expected: build succeeds (no TS errors). (This also builds `dist`; that's fine.)

- [ ] **Step 5: Commit**

```bash
git add bridge/dashboard/web/src/api.ts
git commit -m "feat(dashboard-web): api client for memory_mode + memorySuggest"
```

---

### Task 8: `MemoryTab` component + wire it into `AnalyzeModal`

**Files:**
- Create: `bridge/dashboard/web/src/components/hud/MemoryTab.tsx`
- Modify: `bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx` (Tab type line 23, tabs array ~150, body dispatch ~250, import)

**Interfaces:**
- Consumes: `api.memoryItems`, `api.projectSettings`, `api.setProjectSettings`, `api.memoryPin`, `api.memoryStatus`, `Memory`, `ProjectSettings`, `MemoryCandidateCard`.
- Produces: `<MemoryTab project={string} />`.

- [ ] **Step 1: Create `MemoryTab.tsx`**

Create `bridge/dashboard/web/src/components/hud/MemoryTab.tsx`:

```tsx
import { useCallback, useEffect, useState } from "react";
import { Brain, Pin, PinOff, Trash2 } from "lucide-react";
import { api, type Memory, type ProjectSettings } from "../../api";
import { MemoryCandidateCard } from "../MemoryCandidateCard";

const TYPE_LABEL: Record<string, string> = {
  convention: "Convention",
  decision: "Decision",
  preference: "Preference",
  goal: "Goal",
  gotcha: "Gotcha",
};
const MODES = ["ask", "auto", "off"] as const;
const MODE_HINT: Record<string, string> = {
  ask: "Proposed facts wait for your Keep/Skip.",
  auto: "Proposed facts are kept automatically.",
  off: "No facts are recorded or injected for this project.",
};

/** Project-scoped memory manager (AnalyzeModal MEMORY tab): posture control +
 *  pending Keep/Skip candidates + kept facts with pin / delete. */
export function MemoryTab({ project }: { project: string }) {
  const [active, setActive] = useState<Memory[]>([]);
  const [candidates, setCandidates] = useState<Memory[]>([]);
  const [mode, setMode] = useState<string>("ask");
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const [a, c, s] = await Promise.all([
        api.memoryItems(project, "active"),
        api.memoryItems(project, "candidate"),
        api.projectSettings({ project }),
      ]);
      setActive(a.items);
      setCandidates(c.items);
      setMode((s as ProjectSettings).memory_mode || "ask");
      setLoaded(true);
    } catch {
      /* ignore */
    }
  }, [project]);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      if (live) await load();
    };
    void tick();
    const id = setInterval(tick, 8000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [load]);

  async function pickMode(m: string) {
    setMode(m);
    try {
      await api.setProjectSettings({ project }, { memory_mode: m });
    } catch {
      /* ignore */
    }
    void load();
  }

  async function mutate(id: string, fn: () => Promise<unknown>) {
    setBusy(id);
    try {
      await fn();
      await load();
    } finally {
      setBusy(null);
    }
  }

  const off = mode === "off";

  return (
    <div className="space-y-3">
      <div className="space-y-2 rounded-md border border-border bg-card px-3 py-2.5">
        <div className="flex items-center gap-1.5 text-sm font-medium">
          <Brain size={15} className="text-[var(--brand-soft)]" aria-hidden />
          <span>Project memory</span>
          <span className="ml-auto text-xs text-muted-foreground">
            {active.length} kept · {candidates.length} pending
          </span>
        </div>
        <div className="text-xs text-muted-foreground">
          Facts kept here are injected into every session in this project, so Claude
          knows its conventions, decisions, and goal without re-deriving them.
        </div>
        <div className="flex gap-1">
          {MODES.map((m) => (
            <button
              key={m}
              onClick={() => void pickMode(m)}
              className={
                "rounded px-2.5 py-1 text-xs capitalize " +
                (mode === m
                  ? "bg-primary/20 text-foreground"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              {m}
            </button>
          ))}
        </div>
        <div className="text-[11px] text-muted-foreground">{MODE_HINT[mode]}</div>
      </div>

      {off ? null : (
        <>
          {candidates.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs font-medium text-[var(--brand-soft)]">Pending</div>
              {candidates.map((m) => (
                <MemoryCandidateCard
                  key={m.id}
                  itemId={m.id}
                  memType={m.type}
                  scope={m.scope}
                  title={m.title}
                  body={m.body}
                />
              ))}
            </div>
          )}

          {loaded && active.length === 0 && candidates.length === 0 ? (
            <div className="p-6 text-center text-sm text-muted-foreground">
              Nothing yet. Facts Claude learns in this project show up here.
            </div>
          ) : (
            active.map((m) => (
              <div
                key={m.id}
                className="flex items-start gap-2 rounded-md border border-border bg-card px-3 py-2"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="rounded bg-primary/15 px-1.5 py-0.5 text-[10px] text-muted-foreground">
                      {TYPE_LABEL[m.type] ?? m.type}
                    </span>
                    {m.pinned ? (
                      <Pin size={11} className="text-[var(--brand-soft)]" aria-label="pinned" />
                    ) : null}
                    <span className="min-w-0 truncate text-sm font-semibold">{m.title}</span>
                  </div>
                  <div className="mt-0.5 text-xs text-muted-foreground">{m.body}</div>
                </div>
                <button
                  disabled={busy === m.id}
                  onClick={() => void mutate(m.id, () => api.memoryPin(m.id, !m.pinned))}
                  className="shrink-0 rounded p-1 text-muted-foreground hover:text-foreground"
                  aria-label={m.pinned ? "Unpin" : "Pin"}
                >
                  {m.pinned ? <PinOff size={15} /> : <Pin size={15} />}
                </button>
                <button
                  disabled={busy === m.id}
                  onClick={() => void mutate(m.id, () => api.memoryStatus(m.id, "archived"))}
                  className="shrink-0 rounded p-1 text-red-300 hover:text-red-200"
                  aria-label="Delete"
                >
                  <Trash2 size={15} />
                </button>
              </div>
            ))
          )}
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Import `MemoryTab` in `AnalyzeModal.tsx`**

Add near the other tab-component imports at the top of `bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx`:

```tsx
import { MemoryTab } from "./MemoryTab";
```

- [ ] **Step 3: Add `"memory"` to the `Tab` type**

Change `AnalyzeModal.tsx:23`:

```tsx
type Tab = "overview" | "changes" | "worktrees" | "editor" | "terminal" | "skills" | "issues" | "memory";
```

- [ ] **Step 4: Add the tab to the `tabs` array**

In the `tabs` array (currently lines 142-150), add a `MEMORY` entry after `skills`:

```tsx
    { k: "skills", l: "SKILLS" },
    { k: "memory", l: "MEMORY" },
  ];
```

- [ ] **Step 5: Add the body dispatch**

In the tab-body block (currently ends ~line 250 with the `issues` branch), add before the closing `</div>` of the `.mscroll` container:

```tsx
          {tab === "memory" && <MemoryTab project={project} />}
```

- [ ] **Step 6: Build to typecheck**

Run: `npm --prefix bridge/dashboard/web run build`
Expected: build succeeds, no TS errors.

- [ ] **Step 7: Commit**

```bash
git add bridge/dashboard/web/src/components/hud/MemoryTab.tsx bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx
git commit -m "feat(dashboard-web): project Memory tab (posture + candidates + kept facts)"
```

---

### Task 9: Suggestion chips in the fresh-session empty state

**Files:**
- Create: `bridge/dashboard/web/src/components/hud/SuggestionChips.tsx`
- Modify: `bridge/dashboard/web/src/components/hud/Terminal.tsx` (import; props type ~159; destructure ~138; empty branch ~248-250)
- Modify: `bridge/dashboard/web/src/App.tsx` (Terminal render ~601)

**Interfaces:**
- Consumes: `api.memorySuggest`; `App.feed(texts: string[])`.
- Produces: `<SuggestionChips project={string | null} onPick={(text) => void} />`; `Terminal` prop `onSuggestPick?: (text: string) => void`.

- [ ] **Step 1: Create `SuggestionChips.tsx`**

Create `bridge/dashboard/web/src/components/hud/SuggestionChips.tsx`:

```tsx
import { useEffect, useState } from "react";
import { api } from "../../api";

/** Memory-grounded prompt ideas for a fresh session. Auto-fetched per project (the
 *  server caches by memory version, so repeat opens are cheap). Clicking a chip
 *  loads it into the composer for review — it does not send. */
export function SuggestionChips({
  project,
  onPick,
}: {
  project: string | null;
  onPick?: (text: string) => void;
}) {
  const [chips, setChips] = useState<string[]>([]);

  useEffect(() => {
    let live = true;
    setChips([]);
    if (!project) return;
    void api
      .memorySuggest(project)
      .then((r) => {
        if (live) setChips(r.suggestions.slice(0, 3));
      })
      .catch(() => {
        /* ignore */
      });
    return () => {
      live = false;
    };
  }, [project]);

  if (!chips.length) return null;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 8, justifyContent: "center", padding: "0 16px 12px", maxWidth: 560, margin: "0 auto" }}>
      {chips.map((c, i) => (
        <button
          key={i}
          onClick={() => onPick?.(c)}
          style={{ appearance: "none", cursor: "pointer", fontFamily: "inherit", fontSize: 12, lineHeight: 1.4, textAlign: "left", padding: "7px 11px", borderRadius: 8, border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: "color-mix(in srgb, var(--acc) 7%, transparent)", color: "var(--txh)" }}
        >
          {c}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Import `SuggestionChips` in `Terminal.tsx`**

Add near the top of `bridge/dashboard/web/src/components/hud/Terminal.tsx`:

```tsx
import { SuggestionChips } from "./SuggestionChips";
```

- [ ] **Step 3: Add the `onSuggestPick` prop to `Terminal`**

In the destructured params (lines 134-138), add `onSuggestPick`:

```tsx
export function Terminal({
  view, onView, selected, activeProject, branch, turns, activeId, onRespond,
  onReviewResolve,
  error, scrollRef, contentRef, composer, onOpenFromHistory, liveTurns, trailingWorking,
  loading, sessionId, onSuggestPick,
}: {
```

And in the props type, add after `sessionId?: string | null;` (line 159):

```tsx
  sessionId?: string | null;
  onSuggestPick?: (text: string) => void;
}) {
```

- [ ] **Step 4: Render chips in the empty branch**

In the empty-state dispatch (currently lines 247-254), change the `empty` (loaded) arm to render `FreshState` + `SuggestionChips`:

```tsx
            <div ref={contentRef}>
              {empty && loading ? (
                <ChannelTuning />
              ) : empty ? (
                <>
                  <FreshState project={sessionProject} />
                  <SuggestionChips project={sessionProject} onPick={onSuggestPick} />
                </>
              ) : (
                <Transcript turns={turns} activeId={activeId} onRespond={onRespond} onReviewResolve={onReviewResolve} liveTurns={liveTurns} trailingWorking={trailingWorking} />
              )}
```

- [ ] **Step 5: Wire `onSuggestPick` from `App.tsx`**

In `bridge/dashboard/web/src/App.tsx`, in the `<Terminal ... />` render (starts ~line 601), add the `onSuggestPick` prop (reuse the existing `feed`):

```tsx
              <Terminal
                view={view} onView={setView} selected={selected} sessionId={sessionId} activeProject={activeProject}
                branch={selected?.branch} model={model} turnCount={turns.length} turns={turns}
                activeId={active?.id ?? null} onRespond={(rid, o) => void respond(rid, o)} onReviewResolve={onReviewResolve} error={error}
                scrollRef={scrollRef} contentRef={contentRef}
                onSuggestPick={(t) => feed([t])}
                onOpenFromHistory={(s) => void openFromHistory(s)} liveTurns={liveTurns.current}
```

(Add only the `onSuggestPick={(t) => feed([t])}` line; leave the other props unchanged.)

- [ ] **Step 6: Build to typecheck**

Run: `npm --prefix bridge/dashboard/web run build`
Expected: build succeeds, no TS errors.

- [ ] **Step 7: Commit**

```bash
git add bridge/dashboard/web/src/components/hud/SuggestionChips.tsx bridge/dashboard/web/src/components/hud/Terminal.tsx bridge/dashboard/web/src/App.tsx
git commit -m "feat(dashboard-web): memory-grounded suggestion chips in the fresh-session state"
```

---

### Task 10: Full verification — backend suite, build, manual smoke

**Files:** none (verification only)

- [ ] **Step 1: Run all changed backend tests**

Run:
```bash
python tests/test_memory_capture.py && python tests/test_memory_suggest.py && python tests/test_memory_runner.py && pytest tests/test_project_config.py -v
```
Expected: every file reports all tests passing.

- [ ] **Step 2: Confirm the dashboard bundle is built**

Run: `npm --prefix bridge/dashboard/web run build`
Expected: build succeeds; `bridge/dashboard/web/dist/index.html` exists.

- [ ] **Step 3: Manual smoke (requires a bridge restart — do at your discretion)**

After restarting the bridge so the backend changes load, open the dashboard and verify:
1. Open a project's modal (Analyze) → the **MEMORY** tab appears; it lists that project's kept facts and shows the Ask/Auto/Off control.
2. Switch the posture to **Off**, start a new turn in that project → no memory pack is injected and no candidate is captured. Switch to **Auto** → a durable fact from a turn appears directly under "kept" (no Keep/Skip needed). Switch to **Ask** → new facts appear under "Pending" with Keep/Skip.
3. Open a **new session** in a project that has memory → up to 3 suggestion chips render under "awaiting your command"; clicking one fills the composer (does not send).

Optional curl (token from the dashboard URL, `<T>`):
```bash
curl -s "http://127.0.0.1:8790/local/project/settings?project=<rel>" | python -m json.tool   # includes "memory_mode"
curl -s -X POST "http://127.0.0.1:8790/local/memory/suggest" -H "X-Dash-Token: <T>" -H "Content-Type: application/json" -d '{"project":"<rel>"}'
```

- [ ] **Step 4: Final commit (if any verification tweaks were needed)**

```bash
git add -A && git commit -m "test: verify project-memory dashboard feature end to end"
```

(If no changes were needed in this task, skip the commit.)

---

## Self-Review

**Spec coverage:** Memory tab (Task 8) ✓; Ask/Auto/Off posture — storage (Task 3), enforcement (Task 5), endpoint (Task 6), UI control (Task 8) ✓; suggestions — generator (Task 4), endpoint (Task 6), client (Task 7), UI (Task 9) ✓; "explainer / handles memory" status strip (Task 8) ✓; capture fix (Task 1, added per user decision) ✓. Spec's "endpoint tests" were adjusted to unit-tested functions + manual curl because the repo has no dashboard-server test harness — noted in Task 6.

**Type consistency:** `memory_mode: string` used consistently across `project_config`, server GET/POST, `ProjectSettings`, and `setProjectSettings` patch. `suggest(owner_id, project, branch, *, run=None) -> list[str]` and `{ suggestions: string[] }` match between `memory.py`, the endpoint, `api.memorySuggest`, and `SuggestionChips`. `MemoryTab` uses `Memory` fields (`pinned: number`, `scope`, `type`, `title`, `body`) exactly as defined in `api.ts`. `onSuggestPick?: (text: string) => void` matches `feed([t])`.

**Placeholder scan:** No TBD/TODO; every code step contains full code; commands have expected output.
