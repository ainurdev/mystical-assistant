# Profiles + ACP agents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server-side profiles that bind a session to an agent, an account and run settings, plus a stdlib ACP client that lets a session run on Codex, opencode or Gemini CLI with the same transcript rows, cards and Stop as a Claude turn.

**Architecture:** `bridge/profiles.py` resolves a session's effective settings per knob: the session's own value, else its profile's, else today's default. Every run path reads from it. Claude keeps the existing `claude -p` runner. Any profile whose agent isn't `claude` makes `start_streaming_job` mint an `AcpJob` with `runtime="acp:<agent>"`. `_run_streaming` hands that job to `acp.run_turn`, which speaks ACP v1 (newline-delimited JSON-RPC over stdio) to one agent process per turn and maps its updates onto the existing transcript events. `bridge/acp_agents.py` holds the vetted presets, the agent accounts (0600) and the scrubbed child environment.

**Tech Stack:** Python 3 stdlib only on the backend (threads, subprocess, json, sqlite3), with pytest. React + TypeScript on both frontends (Vite). Typecheck with `npx tsc -p tsconfig.app.json --noEmit`, not `tsc -p .`.

**Spec:** `docs/superpowers/specs/profiles-and-acp-agents.md`. Read it before any task.

**Worktree:** `/home/mhzrerfani/projects/.worktrees/mystical-assistant/feat-agent-profiles` (branch `feat/agent-profiles`).
- Every shell command runs from there: `cd` into it each time, because the shell resets to the main checkout.
- `node_modules` in both web apps are symlinks to the main checkout.
- Never run `mystical …` and never restart anything. The live bridge runs master.

## Global Constraints

- Backend is stdlib only. No new Python dependency, no new npm dependency.
- Tests: `python3 -m pytest tests/ -q` must be fully green. There is no known-failure floor: anything red is your change.
- Never set env inside a test module's preamble. `tests/conftest.py` pins env before `bridge.config` is imported.
- Schema changes are additive only: a line in `_SCHEMA` plus an idempotent `ALTER TABLE` in `store.init()`.
- Module docstrings carry the *why*, including what was chosen not to build. Write one for every new module.
- `ponytail:` comments mark a deliberate shortcut and name its ceiling.
- Commit with explicit paths only: `git add <files>` then `git commit -m "…" -- <files>`. Other sessions share git state. No `Co-Authored-By` lines and no attribution footers. Never push.
- Safety rules from the spec are requirements, not suggestions:
  1. Vetted presets only, with no custom command field anywhere.
  2. Never read or forward a CLI's credential file. API keys live in a 0600 file and are returned masked.
  3. Scrubbed child env: an allow-list plus the preset env plus the account var. No `DASH_TOKEN`, `TELEGRAM_*`, `ANTHROPIC_*` or `CLAUDE_*` var.
  4. Claude models are refused for agents.
  5. No Copilot, Antigravity, Amp or Droid presets.
  6. Agent turns only for `config.DASH_CHAT_ID`.
  7. Asking mode by default.
- The client may be newer than the server. Every new dashboard or Mini App call tolerates a 404: hide the feature and say "restart the bridge".
- Two servers, one shape: a route's JSON comes from one function in `bridge/<module>.py`, called by both servers.

## Review Focus

1. **A profile deleted, or a project default pointing at one.** Briefs, runs and the composer must fall back to "no profile" and keep running the same settings, with no crash and no 500. → Task 1 (delete freezes values), Task 3 (brief of an unbound session).
2. **A Claude profile whose account slot was removed or disabled.** The turn must fail at start, naming the profile and slot. It must never silently run on another login. → Task 2.
3. **An agent that never answers `initialize`, crashes mid-turn or prints junk on stdout.** The turn ends `error` with the stderr tail, the run slot is released, no process is left behind, and junk lines are skipped. → Task 7.
4. **Stop pressed while an agent's permission card is waiting.** The card is answered `cancelled`, the turn ends "stopped", and the process group is killed after the grace period even if the agent ignores `session/cancel`. → Task 7.
5. **An old client that sends model, mode and effort on every send to a profiled session.** It must not pin the session: values equal to the profile store NULL. An agent mode id sent for a Claude session, or a Claude mode for an agent session, is refused or ignored, never passed through. → Task 3, Task 8.

---

## Part 1: Profiles (Claude only, shippable on its own)

### Task 1: `bridge/profiles.py` + store columns

**Files:**
- Create: `bridge/profiles.py`
- Modify: `bridge/store.py`:
  - `_SCHEMA` sessions block (lines ~22-42)
  - `init()` sessions migrations (~143-200)
  - `create_session` (236)
  - `ensure_session` (359)
  - new helpers after `set_run_settings` (384)
- Modify: `bridge/project_config.py`: add `profile`, `set_profile`, `profiles_by_project`, `drop_profile` next to `run_cmd`
- Test: `tests/test_profiles.py`

**Interfaces:**
- Produces (later tasks rely on these exact names):
  - `profiles.CLAUDE == "claude"`
  - `profiles.KNOBS == {"model": "model", "permission_mode": "mode", "effort": "effort"}`
  - `profiles.all_profiles() -> list[dict]`
  - `profiles.get(pid) -> dict | None`
  - `profiles.create(fields) -> dict`
  - `profiles.update(pid, fields) -> dict` (KeyError if unknown)
  - `profiles.delete(pid)`
  - `profiles.effective(session) -> dict`: keys `profile_id agent account model permission_mode effort disabled_tools overrides`
  - `profiles.tools_for(session) -> list[str]`
  - `profiles.save_pick(session, field, value)`
  - `profiles.bind(session, pid) -> (json, status)`
  - `profiles.project_default(project) -> str | None`
  - `profiles.set_project_default(project, pid)`
  - `profiles.api_list() -> dict`
  - `profiles.api_write(body) -> (json, status)`
  - `profiles.brief(session) -> dict`
  - `profiles.claude_slot_usable(slot) -> bool`
  - `profiles.refusal(eff, chat_id) -> str | None` (Claude checks only; Task 8 extends it)
  - `store.set_session_field(session_id, field, value)` for whitelisted columns
  - `store.count_turns(session_id) -> int`
  - `store.unbind_profile(pid, model, mode, effort, tools_json)`
  - `store.create_session(..., profile_id=None)`
  - `store.ensure_session(..., profile_id=None)`

- [ ] **Step 1: Write the failing tests** in `tests/test_profiles.py`

```python
"""profiles.py: CRUD validation, effective() precedence, save_pick, bind, delete.
Spec: docs/superpowers/specs/profiles-and-acp-agents.md (Part 1)."""
import json

import pytest

from bridge import accounts, config, models, profiles, project_config, store

store.init()
CHAT = 555


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(profiles, "PATH", str(tmp_path / "profiles.json"))
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "project_config.json"))
    monkeypatch.setattr(accounts, "list_accounts", lambda: [
        {"slot": 1, "disabled": False}, {"slot": 2, "disabled": False},
        {"slot": 3, "disabled": True}])
    monkeypatch.setattr(models, "model_ids", lambda: {"claude-opus-5-5", "claude-fable-5-1"})
    monkeypatch.setattr(store, "default_disabled_tools", lambda: ["mcp__x"])


def _mk(**kw):
    return profiles.create({"name": "Work", "agent": "claude", "account": "2",
                            "model": "claude-opus-5-5", "mode": "bypassPermissions",
                            "effort": "high", "tools": None, **kw})


def test_create_assigns_an_id_and_keeps_the_fields():
    p = _mk()
    assert p["id"].startswith("p_") and profiles.get(p["id"]) == p
    assert (p["account"], p["model"], p["mode"], p["effort"]) == (
        "2", "claude-opus-5-5", "bypassPermissions", "high")


@pytest.mark.parametrize("bad, msg", [
    ({"name": ""}, "name"), ({"name": "x" * 33}, "name"),
    ({"account": "3"}, "account"), ({"account": "9"}, "account"),
    ({"model": "gpt-9"}, "model"), ({"mode": "yolo"}, "mode"),
    ({"effort": "extreme"}, "effort"), ({"agent": "nope"}, "agent"),
    ({"tools": "Bash"}, "tools"),
])
def test_create_rejects(bad, msg):
    with pytest.raises(ValueError, match=msg):
        _mk(**bad)


def test_names_are_unique_but_an_update_may_keep_its_own():
    p = _mk()
    with pytest.raises(ValueError, match="already exists"):
        _mk()
    assert profiles.update(p["id"], {"effort": "low"})["effort"] == "low"


def test_effective_precedence_session_then_profile_then_none():
    p = _mk(tools=["Bash"])
    s = store.create_session(CHAT, "/pf-eff", profile_id=p["id"])
    e = profiles.effective(s)
    assert (e["agent"], e["account"], e["model"], e["permission_mode"], e["effort"]) == (
        "claude", "2", "claude-opus-5-5", "bypassPermissions", "high")
    assert e["disabled_tools"] == ["Bash"] and e["overrides"] == []
    store.set_session_field(s["id"], "model", "claude-fable-5-1")
    store.set_disabled_tools(s["id"], [])            # "[]" = everything on, a real choice
    e = profiles.effective(store.get_session(s["id"]))
    assert e["model"] == "claude-fable-5-1" and e["disabled_tools"] == []
    assert set(e["overrides"]) == {"model", "disabled_tools"}


def test_an_unprofiled_session_reads_exactly_its_own_columns():
    s = store.create_session(CHAT, "/pf-plain", permission_mode="default")
    e = profiles.effective(s)
    assert (e["profile_id"], e["agent"], e["model"], e["permission_mode"]) == (
        None, "claude", None, "default")
    assert e["disabled_tools"] is None and profiles.tools_for(s) == ["mcp__x"]


def test_save_pick_follows_overrides_and_resets():
    p = _mk()
    s = store.create_session(CHAT, "/pf-pick", profile_id=p["id"])
    profiles.save_pick(s, "model", "claude-opus-5-5")         # echo of the profile
    assert store.get_session(s["id"])["model"] is None
    profiles.save_pick(s, "model", "claude-fable-5-1")        # a real pick
    assert store.get_session(s["id"])["model"] == "claude-fable-5-1"
    profiles.save_pick(store.get_session(s["id"]), "model", "claude-opus-5-5")  # reset
    assert store.get_session(s["id"])["model"] is None


def test_save_pick_on_an_unprofiled_session_stores_and_ignores_blank():
    s = store.create_session(CHAT, "/pf-pick2")
    profiles.save_pick(s, "effort", "high")
    profiles.save_pick(store.get_session(s["id"]), "effort", None)
    assert store.get_session(s["id"])["effort"] == "high"


def test_bind_clears_overrides_and_unbind_freezes_the_effective_values():
    a, b = _mk(), _mk(name="Fable", model="claude-fable-5-1", account="")
    s = store.create_session(CHAT, "/pf-bind", profile_id=a["id"])
    store.set_session_field(s["id"], "effort", "low")
    assert profiles.bind(store.get_session(s["id"]), b["id"]) == (
        {"ok": True, "profile_id": b["id"]}, 200)
    row = store.get_session(s["id"])
    assert row["profile_id"] == b["id"] and row["effort"] is None
    profiles.bind(row, "")
    row = store.get_session(s["id"])
    assert row["profile_id"] is None
    assert (row["model"], row["permission_mode"], row["effort"]) == (
        "claude-fable-5-1", "bypassPermissions", "high")


def test_bind_to_a_missing_profile_is_404():
    s = store.create_session(CHAT, "/pf-bind404")
    assert profiles.bind(s, "p_gone")[1] == 404


def test_delete_unbinds_freezes_and_clears_project_defaults():
    p = _mk(tools=["Bash"])
    s = store.create_session(CHAT, "/pf-del", profile_id=p["id"])
    profiles.set_project_default("/pf-del", p["id"])
    profiles.delete(p["id"])
    row = store.get_session(s["id"])
    assert row["profile_id"] is None and row["model"] == "claude-opus-5-5"
    assert json.loads(row["disabled_tools"]) == ["Bash"]
    assert profiles.project_default("/pf-del") is None
    assert profiles.api_list()["project_defaults"] == {}


def test_project_default_ignores_a_profile_that_is_gone(tmp_path):
    project_config.set_profile("/pf-stale", "p_gone")
    assert profiles.project_default("/pf-stale") is None


def test_api_write_reports_errors_as_statuses():
    assert profiles.api_write({"action": "zap"})[1] == 400
    assert profiles.api_write({"action": "update", "id": "p_nope", "name": "x"})[1] == 404
    assert profiles.api_write({"action": "create", "name": ""})[1] == 400
    j, code = profiles.api_write({"action": "create", "name": "Ok", "agent": "claude"})
    assert code == 200 and j["profile"]["name"] == "Ok"


def test_brief_fills_defaults_the_composer_needs():
    p = _mk(mode="", effort="")
    s = store.create_session(CHAT, "/pf-brief", profile_id=p["id"])
    b = profiles.brief(s)
    assert b["permission_mode"] == config.MINIAPP_PERMISSION_MODE
    assert b["disabled_tools"] == ["mcp__x"] and b["profile_id"] == p["id"]


def test_refusal_names_a_dead_claude_slot(monkeypatch):
    p = _mk()
    s = store.create_session(CHAT, "/pf-dead", profile_id=p["id"])
    monkeypatch.setattr(accounts, "list_accounts",          # slot 2 removed since
                        lambda: [{"slot": 1, "disabled": False}])
    msg = profiles.refusal(profiles.effective(s), CHAT)
    assert msg and "Work" in msg and "2" in msg
```

- [ ] **Step 2: Run them to see them fail**

Run: `cd /home/mhzrerfani/projects/.worktrees/mystical-assistant/feat-agent-profiles && python3 -m pytest tests/test_profiles.py -q`
Expected: collection error, `ModuleNotFoundError: No module named 'bridge.profiles'`.

- [ ] **Step 3: Store changes** (`bridge/store.py`)

In `_SCHEMA`'s `sessions` table, after `model TEXT`, add `profile_id TEXT,` and `effort TEXT` (mind the commas). In `init()` after the `model` migration:

```python
        # The profile this session is bound to (bridge/profiles.py) and its
        # hand-set effort. NULL = no profile / follow the profile.
        for col in ("profile_id", "effort"):
            if col not in scols:
                c.execute(f"ALTER TABLE sessions ADD COLUMN {col} TEXT")
```

Add a `profile_id: str | None = None` keyword to `create_session` and include it in the INSERT column list and values. Add the same keyword to `ensure_session` and pass it through. Below `set_run_settings` add:

```python
_SESSION_FIELDS = {"model", "permission_mode", "effort", "profile_id"}


def set_session_field(session_id: str, field: str, value: "str | None") -> None:
    """Write one run-setting column, NULL included — set_run_settings can't
    clear, and a profiled session's NULL means 'follow the profile'."""
    if field not in _SESSION_FIELDS:
        raise ValueError(f"not a settable session field: {field}")
    with closing(_connect()) as c:
        c.execute(f"UPDATE sessions SET {field}=? WHERE id=?", (value, session_id))


def count_turns(session_id: str) -> int:
    with closing(_connect()) as c:
        return c.execute("SELECT COUNT(*) FROM turns WHERE session_id=?",
                         (session_id,)).fetchone()[0]


def unbind_profile(pid: str, model: "str | None", mode: "str | None",
                   effort: "str | None", tools_json: "str | None") -> None:
    """A deleted profile's sessions keep running what it gave them: each knob
    they never set by hand takes the profile's value, then the binding goes."""
    with closing(_connect()) as c:
        c.execute("UPDATE sessions SET model=COALESCE(model, ?), "
                  "permission_mode=COALESCE(permission_mode, ?), "
                  "effort=COALESCE(effort, ?), "
                  "disabled_tools=COALESCE(disabled_tools, ?), profile_id=NULL "
                  "WHERE profile_id=?", (model, mode, effort, tools_json, pid))
```

- [ ] **Step 4: project_config helpers** (`bridge/project_config.py`, after `set_run_cmd`)

```python
def profile(project: str) -> "str | None":
    """The profile new sessions in this project are bound to (bridge/profiles.py)."""
    return _get_field(project, None, "profile")


def set_profile(project: str, pid: "str | None") -> "str | None":
    return _set_field(project, None, "profile", pid or "")


def profiles_by_project() -> dict:
    with _lock:
        return {k: v["profile"] for k, v in _load().items()
                if isinstance(v, dict) and v.get("profile")}


def drop_profile(pid: str) -> None:
    """Forget a deleted profile everywhere it was a project's default."""
    with _lock:
        data = _load()
        for key in list(data):
            entry = data[key]
            if isinstance(entry, dict) and entry.get("profile") == pid:
                entry.pop("profile")
                if not entry:
                    data.pop(key)
        _save(data)
```

- [ ] **Step 5: Write `bridge/profiles.py`**

```python
"""Profiles: which agent and account run a session, and with what settings.

A profile is a named, server-side bundle (agent, account, model, permission
mode, effort, tool switches) that a session is *bound* to (sessions.profile_id)
rather than stamped from. Per knob, a value set by hand in that session wins,
then the profile's, then today's default (effective()). So editing a profile
reaches every session that uses it, from its next turn, except where that
session was set by hand.

save_pick() is the one writer of those hand-set values. It stores NULL for a
pick equal to the profile's. That way a client echoing the picker on every send
(both /run routes do) never pins a session, and picking the profile's value
again is how a knob goes back to following it.

Why a JSON file and not a table: a few rows, edited from one screen, read at
every turn start. It follows the project_config.py pattern: atomic replace,
beside the DB, git-ignored, re-read only when its mtime moves. A project's
default profile is a field in project_config.

What a profile is not: a credential store. A Claude account is an accounts.py
slot and an agent account lives in acp_agents; a profile only names one. This
replaces the dashboard's browser-only PROFILES card (lib/profiles.ts), whose
saved entries the dashboard imports here once.

Stdlib only.
"""

import json
import os
import threading
import uuid

from bridge import accounts, config, project_config, store

CLAUDE = "claude"
NAME_MAX = 32
# session column -> profile field, for the knobs a picker can hand-set
KNOBS = {"model": "model", "permission_mode": "mode", "effort": "effort"}

PATH = os.path.join(os.path.dirname(config.BRIDGE_DB), "profiles.json")
_lock = threading.RLock()
_cache: "tuple[tuple, list]" = ((), [])   # ((path, mtime_ns), rows)


def _load() -> list:
    global _cache
    try:
        key = (PATH, os.stat(PATH).st_mtime_ns)
    except OSError:
        return []
    if _cache[0] != key:
        try:
            with open(PATH, encoding="utf-8") as f:
                rows = json.load(f)
        except (OSError, ValueError):
            rows = []
        rows = [r for r in rows if isinstance(r, dict) and r.get("id")] \
            if isinstance(rows, list) else []
        _cache = (key, rows)
    return [dict(r) for r in _cache[1]]


def _save(rows: list) -> None:
    global _cache
    os.makedirs(os.path.dirname(PATH), exist_ok=True)
    tmp = PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(rows, f, indent=2)
    os.replace(tmp, PATH)
    # mtime can be jiffy-coarse: two saves in one tick would look unchanged.
    _cache = ((), [])


def all_profiles() -> list:
    with _lock:
        return _load()


def get(pid) -> "dict | None":
    if not pid:
        return None
    return next((p for p in all_profiles() if p["id"] == pid), None)


def claude_slot_usable(slot: int) -> bool:
    return any(a["slot"] == slot and not a.get("disabled")
               for a in accounts.list_accounts())


def _check_claude(account: str, model: str, mode: str, effort: str) -> None:
    # Lazy: the servers import this module, and these live in the Mini App's.
    from bridge.miniapp.server import normalize_model_effort, normalize_permission_mode
    if account and not (account.isdigit() and claude_slot_usable(int(account))):
        raise ValueError(f"no usable Claude account in slot {account!r}")
    ok, _, _ = normalize_model_effort(model, None)
    if not ok:
        raise ValueError(f"unknown model {model!r}")
    if mode and normalize_permission_mode(mode) is None:
        raise ValueError(f"unknown permission mode {mode!r}")
    if effort and effort not in config.MINIAPP_EFFORTS:
        raise ValueError(f"unknown effort {effort!r}")


def _check_agent(agent: str, account: str, model: str, mode: str, effort: str) -> None:
    raise ValueError(f"unknown agent {agent!r}")      # Task 8: ACP presets


def _clean(fields: dict, keep_id: "str | None" = None) -> dict:
    """A validated profile body; ValueError carries the message the UI shows."""
    name = str(fields.get("name") or "").strip()
    if not 1 <= len(name) <= NAME_MAX:
        raise ValueError(f"name must be 1-{NAME_MAX} characters")
    if any(p["name"] == name and p["id"] != keep_id for p in _load()):
        raise ValueError(f"a profile named {name!r} already exists")
    agent = str(fields.get("agent") or CLAUDE).strip()
    account = str(fields.get("account") or "").strip()
    model = str(fields.get("model") or "").strip()
    mode = str(fields.get("mode") or "").strip()
    effort = str(fields.get("effort") or "").strip()
    tools = fields.get("tools")
    if tools is not None and not (isinstance(tools, list)
                                  and all(isinstance(t, str) for t in tools)):
        raise ValueError("tools must be a list of deny rules or null")
    if agent == CLAUDE:
        _check_claude(account, model, mode, effort)
    else:
        _check_agent(agent, account, model, mode, effort)
    return {"name": name, "agent": agent, "account": account, "model": model,
            "mode": mode, "effort": effort, "tools": tools}


def create(fields: dict) -> dict:
    with _lock:
        p = {"id": "p_" + uuid.uuid4().hex[:8], **_clean(fields)}
        _save(_load() + [p])
        return p


def update(pid: str, fields: dict) -> dict:
    with _lock:
        rows = _load()
        i = next((i for i, p in enumerate(rows) if p["id"] == pid), None)
        if i is None:
            raise KeyError(pid)
        rows[i] = {"id": pid, **_clean({**rows[i], **fields}, keep_id=pid)}
        _save(rows)
        return rows[i]


def delete(pid: str) -> None:
    with _lock:
        rows = _load()
        p = next((r for r in rows if r["id"] == pid), None)
        if p is None:
            raise KeyError(pid)
        _save([r for r in rows if r["id"] != pid])
    store.unbind_profile(pid, p.get("model") or None, p.get("mode") or None,
                         p.get("effort") or None,
                         None if p.get("tools") is None else json.dumps(p["tools"]))
    project_config.drop_profile(pid)


def effective(session: "dict | None") -> dict:
    """What this session's next turn runs with, knob by knob."""
    s = session or {}
    p = get(s.get("profile_id")) or {}
    raw = s.get("disabled_tools")
    if raw is not None:
        tools = store.parse_str_list(raw)
    elif p.get("tools") is not None:
        tools = list(p["tools"])
    else:
        tools = None                      # the caller's default applies
    out = {"profile_id": p.get("id"), "agent": p.get("agent") or CLAUDE,
           "account": p.get("account") or "", "disabled_tools": tools,
           "overrides": []}
    for col, field in KNOBS.items():
        out[col] = s.get(col) or p.get(field) or None
        if p and s.get(col):
            out["overrides"].append(col)
    if p and raw is not None:
        out["overrides"].append("disabled_tools")
    return out


def tools_for(session: "dict | None") -> list:
    """The deny rules this session's next run uses."""
    t = effective(session)["disabled_tools"]
    return store.default_disabled_tools() if t is None else t


def brief(session: dict) -> dict:
    """The run-settings half of a session brief, defaults filled in, so both
    composers show what the next turn will actually run."""
    e = effective(session)
    mode = e["permission_mode"]
    if mode is None and e["agent"] == CLAUDE:
        mode = config.MINIAPP_PERMISSION_MODE
    return {"profile_id": e["profile_id"], "agent": e["agent"], "account": e["account"],
            "model": e["model"], "permission_mode": mode, "effort": e["effort"],
            "disabled_tools": tools_for(session), "overrides": e["overrides"]}


def save_pick(session: dict, field: str, value: "str | None") -> None:
    """Save a person's pick for one knob, keeping the profile live."""
    if field not in KNOBS:
        raise ValueError(field)
    p = get(session.get("profile_id"))
    if p is None:
        if value:
            store.set_session_field(session["id"], field, value)
        return
    follow = not value or value == (p.get(KNOBS[field]) or None)
    store.set_session_field(session["id"], field, None if follow else value)


def bind(session: dict, pid: "str | None") -> "tuple[dict, int]":
    """Bind (or with "" unbind) a session's profile. Binding clears the knobs
    set by hand so the new profile shows through; unbinding freezes what the
    old one gave, so nothing changes under a running conversation. Another
    agent only before the first turn: an agent can't read another's history."""
    pid = (pid or "").strip() or None
    new = get(pid)
    if pid and new is None:
        return {"error": "no such profile"}, 404
    eff = effective(session)
    new_agent = (new or {}).get("agent") or CLAUDE
    if eff["agent"] != new_agent and store.count_turns(session["id"]):
        return {"error": "This session already ran on another agent. Start a "
                         "new session with that profile."}, 409
    store.set_session_field(session["id"], "profile_id", pid)
    for col in KNOBS:
        store.set_session_field(session["id"], col, None if pid else eff[col])
    if pid is None and session.get("disabled_tools") is None \
            and eff["disabled_tools"] is not None:
        store.set_disabled_tools(session["id"], eff["disabled_tools"])
    return {"ok": True, "profile_id": pid}, 200


def project_default(project: str) -> "str | None":
    pid = project_config.profile(project)
    return pid if get(pid) else None


def set_project_default(project: str, pid: "str | None") -> None:
    if pid and not get(pid):
        raise ValueError("no such profile")
    project_config.set_profile(project, pid)


def claude_slot(eff: dict) -> "int | None":
    """A Claude profile's account as the slot start_streaming_job takes."""
    a = eff.get("account") or ""
    return int(a) if eff.get("agent") == CLAUDE and a.isdigit() else None


def refusal(eff: dict, chat_id) -> "str | None":
    """Why this session's bound profile can't run right now, or None. Never
    a silent fallback to another login (the ladder.resolve_agent rule)."""
    slot = claude_slot(eff)
    if slot is not None and not claude_slot_usable(slot):
        name = (get(eff.get("profile_id")) or {}).get("name") or "?"
        return (f"Profile {name!r} runs on Claude account {slot}, which is gone "
                f"or disabled. Edit the profile or pick another.")
    return None


def api_list() -> dict:
    return {"profiles": all_profiles(),
            "project_defaults": {k: v for k, v in project_config.profiles_by_project().items()
                                 if get(v)}}


def api_write(body: dict) -> "tuple[dict, int]":
    """POST …/profiles: {action: create|update|delete, id?, …fields}."""
    action = body.get("action")
    try:
        if action == "create":
            return {"ok": True, "profile": create(body)}, 200
        if action == "update":
            return {"ok": True, "profile": update(str(body.get("id") or ""), body)}, 200
        if action == "delete":
            delete(str(body.get("id") or ""))
            return {"ok": True}, 200
    except KeyError:
        return {"error": "no such profile"}, 404
    except ValueError as e:
        return {"error": str(e)}, 400
    return {"error": "action must be create, update or delete"}, 400
```

`claude_slot_usable` must call `accounts.list_accounts()` through the module attribute (as written) so the tests' monkeypatch reaches it.

- [ ] **Step 6: Run the tests**

Run: `python3 -m pytest tests/test_profiles.py -q`, then `python3 -m pytest tests/ -q`
Expected: all pass. If an existing test asserts the exact `sessions` column list or `create_session`'s INSERT, update it for the new column.

- [ ] **Step 7: Commit**

```bash
git add bridge/profiles.py bridge/store.py bridge/project_config.py tests/test_profiles.py
git commit -m "feat(profiles): server-side profiles bound to sessions, per-knob precedence" -- bridge/profiles.py bridge/store.py bridge/project_config.py tests/test_profiles.py
```

### Task 2: Runner resolves the bound profile

**Files:**
- Modify: `bridge/runner.py`:
  - `run_blocking` (501)
  - `handle_task` (534)
  - `_run_streaming`: `denied =` line (~2131), plus a refusal check at the top
  - `_resolve_session` (2348)
  - `_resolve_run_context` (2357)
  - `_finalize_run_context` (2367)
  - `start_streaming_job` (2391)
  - `Job.__init__`: add `self.refusal = None`
- Modify: `bridge/dispatch.py:285` (bot plain-text session creation gets the project default)
- Test: `tests/test_profiles_runner.py`

**Interfaces:**
- Consumes: Task 1's `profiles.effective`, `profiles.tools_for`, `profiles.claude_slot`, `profiles.refusal`, `profiles.project_default`, `profiles.get`, and `store.ensure_session(..., profile_id=)`.
- Produces:
  - `runner.start_streaming_job(..., profile_id: str | None = None)`
  - `Job.refusal: str | None`. When set, `_run_streaming` ends the turn with that error before spawning anything. Task 8 reuses it for agent preconditions.
  - `runner.run_blocking(..., account_slot=None)`

- [ ] **Step 1: Write the failing tests** (`tests/test_profiles_runner.py`; copy `_start` from `tests/test_session_run_settings.py:87-99`, extended to record effort too):

```python
"""The runner reads a session's bound profile: model/mode/effort/account/tools
follow it, a fresh session takes the project default, a dead slot refuses."""
import os
import uuid

import pytest

from bridge import accounts, config, models, profiles, project_config, runner, state, store

store.init()
CHAT = 555


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(profiles, "PATH", str(tmp_path / "profiles.json"))
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "project_config.json"))
    monkeypatch.setattr(accounts, "list_accounts", lambda: [
        {"slot": 1, "disabled": False}, {"slot": 2, "disabled": False}])
    monkeypatch.setattr(models, "model_ids", lambda: {"claude-opus-5-5", "claude-fable-5-1"})
    monkeypatch.setattr(store, "default_disabled_tools", lambda: [])


def _start(monkeypatch, project=None, **kw):
    from bridge import titler
    seen = {}
    monkeypatch.setattr(runner, "_jobs", {})
    monkeypatch.setattr(titler, "kick", lambda *a, **k: None)
    monkeypatch.setattr(runner, "_run_streaming",
                        lambda job, prompt, images, cwd, model, effort, perm, ponytail:
                        seen.update(model=model, effort=effort, perm=perm))
    job = runner.start_streaming_job(CHAT, "go", [], project=project or config.BASE_PATH, **kw)
    state.release_run(job.store_session_id)
    return job, seen


def _fresh_project():
    """A project nobody has a session in yet: the DB and BASE_PATH are shared
    suite-wide, and ensure_session resumes a project's latest session."""
    d = os.path.join(config.BASE_PATH, f"pr-{uuid.uuid4().hex[:8]}")
    os.makedirs(d)
    return d


def _profile(**kw):
    return profiles.create({"name": "P", "agent": "claude", "account": "2",
                            "model": "claude-fable-5-1", "mode": "plan",
                            "effort": "high", **kw})


def test_a_bound_session_runs_its_profile(monkeypatch):
    p = _profile()
    s = store.create_session(CHAT, "/pr-run", cwd=config.BASE_PATH, profile_id=p["id"])
    job, seen = _start(monkeypatch, session_id=s["id"])
    assert seen == {"model": "claude-fable-5-1", "effort": "high", "perm": "plan"}
    assert job.account_slot == 2 and job.runtime == "claude:2"


def test_a_hand_set_knob_beats_the_profile_and_a_caller_beats_both(monkeypatch):
    p = _profile()
    s = store.create_session(CHAT, "/pr-own", cwd=config.BASE_PATH, profile_id=p["id"])
    store.set_session_field(s["id"], "model", "claude-opus-5-5")
    _, seen = _start(monkeypatch, session_id=s["id"])
    assert seen["model"] == "claude-opus-5-5"
    _, seen = _start(monkeypatch, session_id=s["id"], model="sonnet", account_slot=1)
    assert seen["model"] == "sonnet"


def test_a_fresh_session_takes_the_project_default_and_no_seeded_mode(monkeypatch):
    p = _profile()
    d = _fresh_project()
    profiles.set_project_default(runner.rel(d), p["id"])
    job, seen = _start(monkeypatch, project=d, origin="dashboard")
    row = store.get_session(job.store_session_id)
    assert row["profile_id"] == p["id"] and row["permission_mode"] is None
    assert seen["perm"] == "plan"


def test_a_body_profile_beats_the_project_default_on_creation(monkeypatch):
    a, b = _profile(), _profile(name="Q", effort="low")
    d = _fresh_project()
    profiles.set_project_default(runner.rel(d), a["id"])
    job, seen = _start(monkeypatch, project=d, profile_id=b["id"], origin="dashboard")
    assert store.get_session(job.store_session_id)["profile_id"] == b["id"]
    assert seen["effort"] == "low"


def test_an_unprofiled_fresh_session_still_gets_the_surface_default_mode(monkeypatch):
    job, _ = _start(monkeypatch, project=_fresh_project(), origin="dashboard")
    row = store.get_session(job.store_session_id)
    assert row["profile_id"] is None
    assert row["permission_mode"] == config.NEW_SESSION_PERMISSION_MODE


def test_a_dead_slot_refuses_instead_of_running_elsewhere(monkeypatch):
    p = _profile()
    s = store.create_session(CHAT, "/pr-dead", cwd=config.BASE_PATH, profile_id=p["id"])
    monkeypatch.setattr(accounts, "list_accounts", lambda: [{"slot": 1, "disabled": False}])
    job, _ = _start(monkeypatch, session_id=s["id"])
    assert job.refusal and "account 2" in job.refusal and job.account_slot is None
```

Note: `runner.rel` is `bridge.browser.rel`, already imported in runner. Add one more test that calls the real `_run_streaming` with `job.refusal` set: build a `runner.Job("j", CHAT, s["id"])`, set `.refusal = "nope"`, call `runner._run_streaming(job, "x", [], config.BASE_PATH)` with `store.start_turn` done first. Assert that `job.status == "error"` and that the events contain `{"type": "error", "message": "nope"}`. Monkeypatch `subprocess.Popen` to raise `AssertionError("must not spawn")`.

- [ ] **Step 2: Run them; they fail** (`profile_id` is an unexpected keyword, and `refusal` doesn't exist).

- [ ] **Step 3: Implement** in `bridge/runner.py`:

```python
from bridge import profiles   # add to the existing `from bridge import (...)` list

def _resolve_session(chat_id, project_dir, *, session_id, permission_mode, origin,
                     profile_id=None) -> dict:
    """Resolve/create the session row. A new one is bound to the profile the
    caller named, else its project's default; a bound one gets no seeded mode,
    so the profile's applies (spec: Creation and switching)."""
    project = rel(project_dir)
    pid = profile_id if profiles.get(profile_id) else profiles.project_default(project)
    return store.ensure_session(
        chat_id, project, session_id, origin=origin, cwd=project_dir,
        permission_mode=permission_mode or (None if pid else _surface_default_permission(origin)),
        profile_id=pid)
```

`_resolve_run_context` passes `profile_id=None` through unchanged. In `_finalize_run_context`, change the return to:

```python
    return session, cwd, permission_mode or profiles.effective(session)["permission_mode"]
```

In `start_streaming_job`, add the `profile_id: str | None = None` parameter and pass it to `_resolve_session`. After `_finalize_run_context`, replace `model = model or session.get("model")` with:

```python
        eff = profiles.effective(session)
        model = model or eff["model"]
        effort = effort or eff["effort"]
        refusal = profiles.refusal(eff, chat_id) if account_slot is None and runtime is None else None
        if account_slot is None and runtime is None and not refusal:
            account_slot = profiles.claude_slot(eff)
```

Then after the Job is created, set `job.refusal = refusal`. Keep the existing `runtime = f"claude:{account_slot}"` line, which now also covers profile slots.

In `_run_streaming`, as the first statement inside `try:`:

```python
        if job.refusal:
            job.error_msg = job.refusal
            job.add({"type": "error", "message": job.refusal})
            job.status = "error"
            return
```

and replace the `denied = store.get_disabled_tools(...)` line with:

```python
        denied = (profiles.tools_for(store.get_session(job.store_session_id))
                  if job.store_session_id else None)
```

`run_blocking`: add an `account_slot: "int | None" = None` keyword and pass it to `_run_env(ponytail, account_slot)`. In `handle_task`, resolve `eff = profiles.effective(session)` once and use `eff["model"]`, `eff["permission_mode"]` and `account_slot=profiles.claude_slot(eff)` in place of `session.get("model")` / `session.get("permission_mode")`. Use them in `start_turn` too. If `profiles.refusal(eff, chat_id)` is set, `send(chat_id, "⚠️ " + it)` and return (the `finally` still releases the run).

`bridge/dispatch.py:285` currently reads `session = store.ensure_session(chat_id, state.project_key(chat_id))`. Make it:

```python
    key = state.project_key(chat_id)
    session = store.ensure_session(chat_id, key, profile_id=profiles.project_default(key))
```

and import `profiles` there.

- [ ] **Step 4: Run** `python3 -m pytest tests/test_profiles_runner.py tests/test_session_run_settings.py -q`, then the full suite.
Expected: PASS. `test_session_run_settings.py` must stay green unchanged: unprofiled sessions behave as before.

- [ ] **Step 5: Commit**

```bash
git add bridge/runner.py bridge/dispatch.py tests/test_profiles_runner.py
git commit -m "feat(profiles): runs follow the bound profile; a dead slot refuses" -- bridge/runner.py bridge/dispatch.py tests/test_profiles_runner.py
```

### Task 3: Routes, briefs and the bot command

**Files:**
- Modify: `bridge/miniapp/server.py`:
  - `save_run_settings` (98-129)
  - `_session_brief` (165-196)
  - `_api_run` (538-583)
  - new GET `/api/profiles` and POST `/api/session/profile` (route table near 462-476)
- Modify: `bridge/dashboard/server.py`:
  - `_run` (1591-1637)
  - GET table (~350): `/local/profiles`
  - POST table (~1044): `/local/profiles`, `/local/session/profile`, `/local/project/profile`
- Modify: `bridge/profiles.py`: add `run_values(...)` (below)
- Modify: `bridge/dispatch.py`: `/profile` command plus a `HELP` line
- Test: `tests/test_profiles_endpoint.py`; update `tests/test_session_run_settings_endpoint.py` only where its exact response dict now has extra keys.

**Interfaces:**
- Consumes: Task 1 and Task 2.
- Produces:
  - **Session brief keys** (both servers, via `_session_brief`): `profile_id`, `agent`, `account`, `model`, `permission_mode`, `effort`, `disabled_tools`, `overrides`. Frontend tasks read these.
  - **`save_run_settings`** accepts `effort` and `pick: "effort"`. It answers `{ok, model, permission_mode, effort, overrides}`.
  - **`profiles.run_values(model, mode, effort) -> (error | None, model, mode, effort)`**: validates for Claude. Task 8 widens it to agents.
  - **Routes:**
    - `GET /local/profiles` and `GET /api/profiles` return `profiles.api_list()`.
    - `POST /local/profiles` takes `profiles.api_write(body)`.
    - `POST /local/session/profile` and `POST /api/session/profile` take `{session_id, profile_id}` and return `profiles.bind(...)`, plus `"session": _session_brief(...)` on 200.
    - `POST /local/project/profile` takes `{project, profile_id}` and returns `{"ok": True, "project_defaults": …}`.
  - **`/run` bodies** accept `profile_id`, used for a fresh session.

- [ ] **Step 1: Write the failing tests** (`tests/test_profiles_endpoint.py`, using the socket-free `Handler.__new__` pattern from `tests/test_session_run_settings_endpoint.py:21-36`):

```python
"""Both servers' profile routes, the briefs, and /run no longer pinning a
profiled session (Review Focus 5)."""
from types import SimpleNamespace

import pytest

from bridge import accounts, config, models, profiles, project_config, relevance, runner, store
from bridge.dashboard import server as dash
from bridge.miniapp import server as mini

store.init()
CHAT = 555


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(profiles, "PATH", str(tmp_path / "profiles.json"))
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "project_config.json"))
    monkeypatch.setattr(accounts, "list_accounts", lambda: [{"slot": 1, "disabled": False}])
    monkeypatch.setattr(models, "model_ids", lambda: {"claude-opus-5-5", "claude-fable-5-1"})
    monkeypatch.setattr(store, "default_disabled_tools", lambda: [])
    monkeypatch.setattr(relevance, "gate", lambda *a, **k: None)


def _handler(mod):
    h = mod.Handler.__new__(mod.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


def _p(**kw):
    return profiles.create({"name": "P", "agent": "claude", "model": "claude-fable-5-1",
                            "mode": "plan", "effort": "high", **kw})


def test_brief_of_a_bound_session_shows_effective_values_and_no_overrides():
    p = _p()
    s = store.create_session(CHAT, "/pe-brief", profile_id=p["id"])
    b = mini._session_brief(store.get_session(s["id"]))
    assert (b["profile_id"], b["model"], b["permission_mode"], b["effort"], b["overrides"]) == (
        p["id"], "claude-fable-5-1", "plan", "high", [])


def test_brief_of_a_session_whose_profile_was_deleted_still_renders():
    p = _p()
    s = store.create_session(CHAT, "/pe-gone", profile_id=p["id"])
    profiles.delete(p["id"])
    b = mini._session_brief(store.get_session(s["id"]))
    assert b["profile_id"] is None and b["model"] == "claude-fable-5-1"


def test_settings_pick_equal_to_the_profile_follows_it():
    p = _p()
    s = store.create_session(CHAT, "/pe-set", profile_id=p["id"])
    out, code = mini.save_run_settings(s, {"model": "claude-fable-5-1", "effort": "low",
                                           "pick": "effort"})
    row = store.get_session(s["id"])
    assert code == 200 and row["model"] is None and row["effort"] == "low"
    assert out["overrides"] == ["effort"]


def _run(mod, monkeypatch, body):
    def start(chat, prompt, paths, project=None, **kw):
        sess = runner._resolve_session(chat, project or config.BASE_PATH,
                                       session_id=kw.get("session_id"),
                                       permission_mode=kw.get("permission_mode"),
                                       origin="dashboard", profile_id=kw.get("profile_id"))
        return SimpleNamespace(id="j", store_session_id=sess["id"])
    monkeypatch.setattr(runner, "start_streaming_job", start)
    h, box = _handler(mod)
    (h._run if mod is dash else h._api_run)(CHAT, body)
    return box


@pytest.mark.parametrize("mod", [dash, mini])
def test_run_echoing_the_profile_does_not_pin_the_session(mod, monkeypatch):
    p = _p()
    s = store.create_session(CHAT, "/pe-run", cwd=config.BASE_PATH, profile_id=p["id"])
    box = _run(mod, monkeypatch, {"prompt": "hi", "session_id": s["id"],
                                  "model": "claude-fable-5-1", "permission_mode": "plan",
                                  "effort": "high"})
    assert box["code"] == 200
    row = store.get_session(s["id"])
    assert (row["model"], row["permission_mode"], row["effort"]) == (None, None, None)


def test_dashboard_profile_routes_round_trip():
    h, box = _handler(dash)
    h._post_profiles(CHAT, {"action": "create", "name": "X", "agent": "claude"})
    assert box["code"] == 200
    pid = box["obj"]["profile"]["id"]
    s = store.create_session(CHAT, "/pe-bind")
    h._post_session_profile(CHAT, {"session_id": s["id"], "profile_id": pid})
    assert box["code"] == 200 and box["obj"]["session"]["profile_id"] == pid
    h._post_project_profile(CHAT, {"project": "/pe-bind", "profile_id": pid})
    assert box["obj"]["project_defaults"] == {"/pe-bind": pid}


def test_session_profile_rejects_someone_elses_session():
    h, box = _handler(dash)
    s = store.create_session(999, "/pe-other")
    h._post_session_profile(CHAT, {"session_id": s["id"], "profile_id": ""})
    assert box["code"] == 404
```

Name the dashboard handler methods exactly `_post_profiles(chat, body)`, `_post_session_profile(chat, body)` and `_post_project_profile(chat, body)`. The Mini App gets `_api_profiles(chat_id)` (GET) and `_api_session_profile(chat_id, body)`. Add a Mini App test that mirrors the session-profile round trip through `_api_session_profile`.

- [ ] **Step 2: Run them; they fail.**

- [ ] **Step 3: Implement.**

`profiles.run_values` (append to `bridge/profiles.py`):

```python
def run_values(model, mode, effort) -> tuple:
    """Validate a run's or a pick's model/mode/effort for a Claude session.
    Returns (error or None, model, mode, effort); blanks become None.
    Task 8 widens this to agent sessions."""
    from bridge.miniapp.server import normalize_model_effort, normalize_permission_mode
    ok, m, e = normalize_model_effort(model, effort)
    if not ok:
        return "invalid model", None, None, None
    p = normalize_permission_mode(mode)
    if (mode or "").strip() and p is None:
        return "invalid permission_mode", None, None, None
    return None, m, p, e
```

In `save_run_settings`, keep the type checks and allow `pick in (None, "model", "permission_mode", "effort")`. Replace the validation and `store.set_run_settings` with:

```python
    err, model, mode, effort = profiles.run_values(m, p, body.get("effort"))
    if err:
        return {"error": err}, 400
    for field, value, key in (("model", model, "model"), ("permission_mode", mode, "permission_mode"),
                              ("effort", effort, "effort")):
        if key in body:
            profiles.save_pick(session, field, value)
            session = store.get_session(session["id"]) or session
    runner.apply_run_settings(session["id"],
                              model=model if pick == "model" else None,
                              permission_mode=mode if pick == "permission_mode" else None)
    b = profiles.brief(store.get_session(session["id"]) or session)
    return {"ok": True, "model": b["model"], "permission_mode": b["permission_mode"],
            "effort": b["effort"], "overrides": b["overrides"]}, 200
```

In `_session_brief`, delete the three lines emitting `model`, `permission_mode` and `disabled_tools`, and add `**profiles.brief(s),` to the returned dict.

In both `/run` handlers:
1. Replace `normalize_model_effort`/`normalize_permission_mode` with `err, model, permission_mode, effort = profiles.run_values(body.get("model"), body.get("permission_mode"), body.get("effort"))`, returning `400 {"error": err}` on error.
2. Pass `profile_id=(body.get("profile_id") or "").strip() or None` to `start_streaming_job`.
3. Replace the trailing `store.set_run_settings(...)` with:

```python
        s = store.get_session(job.store_session_id) or {"id": job.store_session_id}
        for field, value in (("model", model), ("permission_mode", permission_mode),
                             ("effort", effort)):
            profiles.save_pick(s, field, value)
            s = store.get_session(job.store_session_id) or s
```

Dashboard `_run` keeps its `ladder.resolve_agent(body.get("agent"))` for now; Task 10 trims it.

Routes. Dashboard GET (beside `/local/accounts`):

```python
        if path == "/local/profiles":
            return self._json(profiles.api_list())
```

Dashboard POST, placed before any `startswith` that would swallow these paths:

```python
        if path == "/local/profiles":
            return self._post_profiles(chat, body)
        if path == "/local/session/profile":
            return self._post_session_profile(chat, body)
        if path == "/local/project/profile":
            return self._post_project_profile(chat, body)
```

with methods:

```python
    def _post_profiles(self, chat, body):
        self._json(*profiles.api_write(body))

    def _post_session_profile(self, chat, body):
        sid = (body.get("session_id") or "").strip()
        s = store.get_session(sid) if sid else None
        if not s or s["chat_id"] != chat:
            return self._json({"error": "not found"}, 404)
        out, code = profiles.bind(s, body.get("profile_id"))
        if code == 200:
            out["session"] = _session_brief(store.get_session(sid))
        self._json(out, code)

    def _post_project_profile(self, chat, body):
        try:
            profiles.set_project_default(str(body.get("project") or ""),
                                         (body.get("profile_id") or "").strip() or None)
        except ValueError as e:
            return self._json({"error": str(e)}, 400)
        self._json({"ok": True, "project_defaults": profiles.api_list()["project_defaults"]})
```

Mini App: GET `/api/profiles` → `self._json(profiles.api_list())`. POST `/api/session/profile` → `_api_session_profile`, which is `_post_session_profile`'s body but uses `self._owned_session(chat_id, sid)` for the ownership check.

Bot (`bridge/dispatch.py`): route `cmd0 == "/profile"` near `/accounts` (line ~265) to:

```python
def handle_profile_command(chat_id: int, text: str) -> None:
    """/profile — list profiles; /profile <name> — bind this chat's session;
    /profile none — unbind (it keeps running what the profile gave it)."""
    arg = text[len("/profile"):].strip()
    s = store.latest_session(chat_id, state.project_key(chat_id))
    rows = profiles.all_profiles()
    if not arg:
        cur = (s or {}).get("profile_id")
        lines = [f"{'✅' if p['id'] == cur else '•'} {p['name']} — {p['agent']}"
                 f"{' · ' + p['model'] if p['model'] else ''}" for p in rows]
        send(chat_id, ("\n".join(lines) or "No profiles yet — make one in the dashboard.")
             + "\n\n/profile <name> binds this chat's session · /profile none unbinds")
        return
    if not s:
        send(chat_id, "No chat here yet — send a prompt first.")
        return
    pid = "" if arg.lower() == "none" else next(
        (p["id"] for p in rows if p["name"].lower() == arg.lower()), None)
    if pid is None:
        send(chat_id, f"No profile named {arg!r}. /profile lists them.")
        return
    out, code = profiles.bind(s, pid)
    send(chat_id, f"✅ {'Profile: ' + arg if pid else 'Profile removed'}" if code == 200
         else f"⚠️ {out['error']}")
```

Add to `HELP`: `/profile [name|none] — show or set this chat's run profile`.

- [ ] **Step 4: Run** the new tests, `tests/test_session_run_settings_endpoint.py` (update exact-dict assertions to include `effort`/`overrides` where needed; don't weaken them), `tests/test_fallback_commands.py`, then the full suite.

- [ ] **Step 5: Commit**

```bash
git add bridge/profiles.py bridge/miniapp/server.py bridge/dashboard/server.py bridge/dispatch.py tests/test_profiles_endpoint.py tests/test_session_run_settings_endpoint.py
git commit -m "feat(profiles): routes on both servers, briefs carry effective settings, /profile" -- bridge/profiles.py bridge/miniapp/server.py bridge/dashboard/server.py bridge/dispatch.py tests/test_profiles_endpoint.py tests/test_session_run_settings_endpoint.py
```

### Task 4: Dashboard UI for profiles

**Files:**
- Modify: `bridge/dashboard/web/src/api.ts`:
  - types near `SessionBrief` 27-51 and `RunBody` 1166-1177
  - calls near `setRunSettings` 1340
- Modify: `bridge/dashboard/web/src/lib/profiles.ts`: rewrite as server types + `describe()` + `importLegacy()`
- Modify: `bridge/dashboard/web/src/App.tsx`:
  - profiles state
  - Composer props 2238-2245
  - `send()` 1102-1155 (drop `agent`, add `profile_id` for a fresh session)
  - effort session-scoped through `pickRun` 343-351 and `runPicks` 1700-1705
  - enqueue 1133-1140 (drop `agent`)
- Modify: `bridge/dashboard/web/src/models.ts`: `runPicks` (73-80) also returns effort
- Modify: `bridge/dashboard/web/src/components/Composer.tsx`: the AGENT `Drop` (730-733, rendered 935/944) becomes a PROFILE `Drop`; props `agent/agents/onAgent` become `profile/profiles/onProfile`
- Modify: `bridge/dashboard/web/src/components/hud/SettingsModal.tsx`:
  - `ProfilesPanel` 3722-3808 becomes server-backed
  - remove the AGENT `PickCell` 4358-4363
- Modify: `bridge/dashboard/web/src/components/hud/ProjectsSettings.tsx`: a DEFAULT PROFILE select per project
- Test: `bridge/dashboard/web/src/models.check.ts`, extended for `runPicks` effort. Run it the way the existing `.check.ts` files are run; see `package.json` scripts.

**Interfaces:**
- Consumes: Task 3's brief keys and routes.
- Produces:
  - `api.profiles(): Promise<ProfilesInfo>`
  - `api.profileWrite(body)`
  - `api.setSessionProfile(sid, pid): Promise<{ok, profile_id, session}>`
  - `api.setProjectProfile(project, pid)`
  - `type Profile = {id, name, agent, account, model, mode, effort, tools: string[] | null}`

Behaviour:
1. **Loading:**
   - App loads `api.profiles()` on mount and after any profile edit.
   - On a 404 (old bridge), set `profilesAvailable=false`. That hides the PROFILE dropdown and makes the PROFILES panel say "Restart the bridge to use profiles."
2. **PROFILE dropdown:**
   - Options: `[{id: "", label: "NO PROFILE"}, ...profiles]`, each with `describe(p)` as its note.
   - Value: the open session's `profile_id`. For a fresh session it is the pending pick, else the project default from `project_defaults[projectRel]`.
3. **Picking a profile:**
   - Existing session: call `api.setSessionProfile`. On 409, toast the server's message; on 200, replace the session brief from `res.session`.
   - Fresh session: store a pending profile id and send it as `profile_id` on the first `/run`.
4. **Model, mode and effort pickers:**
   - Load the open session's `model`, `permission_mode` and `effort` from its brief, as `runPicks` does today, now with effort.
   - Picking effort calls `pickRun` with half `"effort"`.
   - A fresh session bound to a profile seeds its pickers from the profile (`p.model || settings.model`, `p.mode || settings.perm`, `p.effort || settings.effort`).
   - A knob listed in `overrides` gets a small `•` after its value, with the title "set in this session; pick the profile's value to follow it again".
5. **PROFILES panel** (SettingsModal SESSION tab), replacing the localStorage one:
   - A list of rows: name, `describe()` and EDIT/✕.
   - A form for name, agent, account, model, mode, effort, and a "Use this session's tool switches" checkbox (sends `tools: sessionTools`; unchecked sends `null`).
     - Agent: Claude only in Part 1.
     - Account: `""` = DEFAULT LOGIN, plus the enabled Claude logins from `api.accounts()`.
     - Model: from `state.models`.
     - Mode and effort: Composer's `PERMS`/`EFFORTS`.
   - SAVE/CANCEL buttons, with errors shown inline.
   - On first mount, `importLegacy()` reads `localStorage["hud-profiles"]` and POSTs `create` for each entry: `{name, agent: "claude", account: "claude:N" → "N", model, mode: perm, effort, tools: disabledTools}`. A name clash appends " (old)". After every POST settles, it deletes the key. Keep it best-effort and silent.
6. **ProjectsSettings:** a select per project row: "No default" plus profiles, saving with `api.setProjectProfile`.
7. **Cleanup:**
   - Remove the AGENT run-default `PickCell`.
   - Remove `agent` from `/run` and enqueue bodies.
   - `settings.agent` stays in `HudSettings` so old saved settings still parse, but nothing reads it any more.
   - Leave the FREE AGENTS section alone; Task 11 replaces it.

- [ ] **Step 1:** Extend `models.check.ts` with a `runPicks` case covering effort (brief effort wins, else the device default), and run it to see it fail.
- [ ] **Step 2:** Implement the api.ts types and calls, `lib/profiles.ts`, and `runPicks`.
- [ ] **Step 3:** Implement Composer, App, SettingsModal and ProjectsSettings as specified above, following the HUD idiom already in those files (`Drop`, `PickCell`, `CARD`, `btn()`). Read the **mystical-assistant-design** skill before styling.
- [ ] **Step 4: Typecheck and checks.**
Run: `cd bridge/dashboard/web && npx tsc -p tsconfig.app.json --noEmit` (expected: no errors), then the `.check.ts` runner from `package.json`.
- [ ] **Step 5: Build.** `npx vite build` must succeed. Do not copy `dist` anywhere.
- [ ] **Step 6: Commit** the changed web files by explicit path: `feat(dashboard): profile picker, server-backed PROFILES, project default profile`.

### Task 5: Mini App UI for profiles

**Files:**
- Modify: `bridge/miniapp/web/src/lib/api.ts`:
  - `SessionBrief` 53-73: add `profile_id?`, `effort?`, `overrides?`, `agent?`
  - run body 608-622: add `profile_id`
  - `setRunSettings` 698-702: effort
  - new `profiles()` and `setSessionProfile()`
- Modify: `bridge/miniapp/web/src/lib/chat.tsx`:
  - effort session-scoped like model (state 263-272, `pickRun` 330-340, brief effect 524-532)
  - profiles query
  - pending profile for a fresh session
  - `runPrompt` 573-582 sends `profile_id`
- Modify: `bridge/miniapp/web/src/components/Composer.tsx`: a PROFILE `OptionRow` (46-80) in the dropdown (312-344), above MODEL
- Test: typecheck plus a screenshot (Step 3)

**Interfaces:**
- Consumes: Task 3's `/api/profiles` and `/api/session/profile`.

Behaviour matches Task 4 points 1–4, at 390 px. Profile *editing* stays on the dashboard. A 404 hides the row.

- [ ] **Step 1:** Implement.
- [ ] **Step 2: Typecheck.** `cd bridge/miniapp/web && npx tsc -p tsconfig.app.json --noEmit`, then `npx vite build`.
- [ ] **Step 3: Screenshot.** Use the **bridge-eyes** skill: a scratch Mini App server from this worktree with a forged init-data stub and a seeded profile, opening the composer dropdown. Save the PNG under `.mystical/probe/` and report the path.
- [ ] **Step 4: Commit** by explicit path: `feat(miniapp): profile picker; effort follows the session`.

---

## Part 2: ACP agents

### Task 6: `bridge/acp_agents.py` (presets, accounts, environment, option cache)

**Files:**
- Create: `bridge/acp_agents.py`
- Test: `tests/test_acp_agents.py`

**Interfaces:**
- Produces:
  - `PRESETS: tuple[dict, ...]`, each with keys `id label cmd key_env home_env login install env key_required`
  - `preset(agent_id) -> dict | None`
  - `available() -> list[dict]`: each preset plus `installed: bool`; never includes a key
  - `argv(preset) -> list[str]`: absolute launcher path plus args
  - `accounts(agent=None) -> list[dict]`: masked
  - `account(acct_id) -> dict | None`: unmasked, server-side only
  - `add_account(agent, label, kind, key=None) -> dict`: masked
  - `remove_account(acct_id)`
  - `home_dir(acct_id) -> str`
  - `env_for(preset, acct_id) -> dict`
  - `login_hint(preset, acct_id) -> str`
  - `is_claude_model(value) -> bool`
  - `remember_options(agent, acct_id, config_options, modes)`
  - `options_for(agent, acct_id) -> {"model": [...], "mode": [...], "effort": [...]}` (each `{value, name}`)
  - `run_problem(preset, acct_id, chat_id, model) -> str | None`

- [ ] **Step 1: Write the failing tests** (`tests/test_acp_agents.py`):

```python
"""acp_agents: vetted presets, 0600 masked accounts, the scrubbed env (spec
safety rules 1-4, 6)."""
import os
import stat

import pytest

from bridge import acp_agents, config


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(acp_agents, "ACCOUNTS_FILE", str(tmp_path / "agent-accounts.json"))
    monkeypatch.setattr(acp_agents, "OPTIONS_FILE", str(tmp_path / "acp-options.json"))
    monkeypatch.setattr(acp_agents, "HOMES", str(tmp_path / "agent-homes"))
    monkeypatch.setattr(acp_agents, "_options", {})


def test_only_vetted_presets_exist():
    assert {p["id"] for p in acp_agents.PRESETS} == {"codex", "opencode", "gemini"}
    banned = ("copilot", "antigravity", "agy", "amp", "droid")
    assert not any(b in " ".join(p["cmd"]).lower() for p in acp_agents.PRESETS for b in banned)


def test_keys_are_stored_0600_and_never_returned_whole():
    a = acp_agents.add_account("codex", "work", "key", key="sk-abcdefghijklmnop")
    assert "sk-abcdefghijklmnop" not in str(a) and a["key"].endswith("mnop")
    assert stat.S_IMODE(os.stat(acp_agents.ACCOUNTS_FILE).st_mode) == 0o600
    assert "sk-abcdefghijklmnop" not in str(acp_agents.accounts())
    assert acp_agents.account(a["id"])["key"] == "sk-abcdefghijklmnop"


def test_add_account_validates(monkeypatch):
    with pytest.raises(ValueError):
        acp_agents.add_account("nope", "x", "key", key="k")
    with pytest.raises(ValueError):
        acp_agents.add_account("codex", "x", "key", key="")
    with pytest.raises(ValueError):
        acp_agents.add_account("gemini", "x", "home")    # gemini: API key only


def test_env_is_scrubbed_to_the_allow_list_plus_the_account(monkeypatch):
    for k, v in {"DASH_TOKEN": "d", "TELEGRAM_BOT_TOKEN": "t", "ANTHROPIC_API_KEY": "a",
                 "CLAUDE_CONFIG_DIR": "c", "GITHUB_TOKEN": "g", "OPENAI_API_KEY": "stray",
                 "PATH": "/usr/bin", "LC_ALL": "C.UTF-8", "XDG_CONFIG_HOME": "/x"}.items():
        monkeypatch.setenv(k, v)
    codex = acp_agents.preset("codex")
    a = acp_agents.add_account("codex", "work", "key", key="sk-mine")
    env = acp_agents.env_for(codex, a["id"])
    assert env["OPENAI_API_KEY"] == "sk-mine"
    for k in ("DASH_TOKEN", "TELEGRAM_BOT_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR",
              "GITHUB_TOKEN"):
        assert k not in env
    assert env["LC_ALL"] == "C.UTF-8" and env["XDG_CONFIG_HOME"] == "/x"
    assert "OPENAI_API_KEY" not in acp_agents.env_for(codex, "")    # machine login: no stray key


def test_a_separate_login_gets_its_own_0700_home():
    a = acp_agents.add_account("codex", "personal", "home")
    env = acp_agents.env_for(acp_agents.preset("codex"), a["id"])
    assert env["CODEX_HOME"] == acp_agents.home_dir(a["id"])
    assert stat.S_IMODE(os.stat(env["CODEX_HOME"]).st_mode) == 0o700
    assert env["CODEX_HOME"] in acp_agents.login_hint(acp_agents.preset("codex"), a["id"])


@pytest.mark.parametrize("m, hit", [
    ("claude-opus-5-5", True), ("anthropic/claude-sonnet-5", True), ("openrouter/anthropic/x", True),
    ("Opus", True), ("gpt-5.5-codex", False), ("gemini-3-flash", False), ("", False),
    ("qwen3-coder-plus", False)])
def test_claude_models_are_recognised(m, hit):
    assert acp_agents.is_claude_model(m) is hit


def test_run_problem_owner_install_account_and_model(monkeypatch):
    codex = acp_agents.preset("codex")
    monkeypatch.setattr(acp_agents, "_resolve", lambda name: "/bin/true")
    assert "owner" in acp_agents.run_problem(codex, "", config.DASH_CHAT_ID + 1, None)
    assert acp_agents.run_problem(codex, "", config.DASH_CHAT_ID, None) is None
    assert "Claude" in acp_agents.run_problem(codex, "", config.DASH_CHAT_ID, "claude-opus-5-5")
    assert "account" in acp_agents.run_problem(codex, "a_gone", config.DASH_CHAT_ID, None)
    monkeypatch.setattr(acp_agents, "_resolve", lambda name: None)
    assert "install" in acp_agents.run_problem(codex, "", config.DASH_CHAT_ID, None).lower()


def test_options_are_flattened_by_category_and_cached():
    opts = [{"id": "m", "category": "model", "type": "select", "currentValue": "a",
             "options": [{"group": "g", "name": "G", "options": [{"value": "a", "name": "A"}]},
                         {"value": "b", "name": "B"}]},
            {"id": "t", "category": "thought_level", "type": "select", "options": [
                {"value": "high", "name": "High"}]},
            {"id": "x", "category": "mode", "type": "boolean"}]
    modes = {"currentModeId": "ask", "availableModes": [{"id": "ask", "name": "Ask"}]}
    acp_agents.remember_options("codex", "", opts, modes)
    got = acp_agents.options_for("codex", "")
    assert got["model"] == [{"value": "a", "name": "A"}, {"value": "b", "name": "B"}]
    assert got["effort"] == [{"value": "high", "name": "High"}]
    assert got["mode"] == [{"value": "ask", "name": "Ask"}]       # legacy modes fill in
```

- [ ] **Step 2: Run; they fail** (no module).

- [ ] **Step 3: Write `bridge/acp_agents.py`**:

```python
"""Which non-Claude agents a session may run on, under which account, with
which environment. bridge/acp.py speaks the protocol; this module decides
what it is allowed to start.

Safety rules (spec: profiles-and-acp-agents.md) live here, in code:
  1. PRESETS is the whole list. There is no custom command anywhere. Each entry
     is a vendor's own CLI, or the ACP org's official adapter that runs it.
     Left out on purpose:
     - Copilot: its ACP mode auto-approves everything, copilot-cli#4537.
     - Antigravity: its terms §6 ban third-party access.
     - Amp: no client approvals.
     - Droid: context leaks across sessions, #46.
     - Gemini with a Google login: consumer logins are dead since 2026-06-18,
       and piggybacking on one is a ban, so the preset is API key only.
  2. No login token is ever read. A subscription login happens in the CLI's
     own flow (login_hint() shows the command). The only secrets kept are
     pasted API keys: ACCOUNTS_FILE, 0600, returned masked.
  3. env_for() builds the child env from an allow-list. The bridge's own env
     holds the Telegram bot token, the dashboard token, Rivendell/GitHub/
     tracker tokens, and maybe Anthropic credentials. None of that goes to a
     third-party CLI, and neither do other agents' keys.
  4. is_claude_model(): Claude models run only through the claude CLI.
  6. run_problem(): agent turns run only in the owner's chat, one person per
     login.

Account kinds:
  - "" (machine login): whatever the CLI is logged into here.
  - key: a pasted API key, set as the preset's key var.
  - home: a separate login in its own 0700 dir, set as the preset's home var.
    The user runs login_hint() once in a terminal.

The options cache keeps each agent's advertised config options (model, mode,
thought level) as last seen by a turn or a TEST. The pickers are built from
it, never from hard-coded ids: every agent invents its own.

Stdlib only.
"""

import glob
import json
import os
import re
import shutil
import threading
import uuid

from bridge import config

PRESETS = (
    # codex-acp runs OpenAI's own `codex app-server`; pin bumped deliberately.
    {"id": "codex", "label": "Codex", "cmd": ["npx", "-y", "@agentclientprotocol/codex-acp@2.1.1"],
     "key_env": "OPENAI_API_KEY", "home_env": "CODEX_HOME", "key_required": False,
     "login": "codex login --device-auth", "install": "npm i -g @openai/codex",
     "env": {}},
    {"id": "opencode", "label": "opencode", "cmd": ["opencode", "acp"],
     "key_env": None, "home_env": "XDG_DATA_HOME", "key_required": False,
     "login": "opencode auth login",
     "install": "curl -fsSL https://opencode.ai/install | bash",
     # opencode ships allow-all; ask for anything that writes or reaches out (rule 7).
     "env": {"OPENCODE_DISABLE_AUTOUPDATE": "1",
             "OPENCODE_PERMISSION": json.dumps({"edit": "ask", "bash": "ask", "webfetch": "ask"})}},
    {"id": "gemini", "label": "Gemini CLI", "cmd": ["gemini", "--acp"],
     "key_env": "GEMINI_API_KEY", "home_env": "GEMINI_CLI_HOME", "key_required": True,
     "login": None, "install": "npm i -g @google/gemini-cli",
     "env": {"GEMINI_CLI_NO_RELAUNCH": "true"}},
)

_ALLOW = {"PATH", "HOME", "USER", "LOGNAME", "SHELL", "LANG", "TERM", "TMPDIR",
          "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
          "http_proxy", "https_proxy", "no_proxy", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY"}
_ALLOW_PREFIX = ("LC_", "XDG_")
_FALLBACK_DIRS = ("~/.local/bin", "~/.opencode/bin", "~/.npm-global/bin")

ACCOUNTS_FILE = os.path.expanduser("~/.mystical/agent-accounts.json")
OPTIONS_FILE = os.path.expanduser("~/.mystical/acp-options.json")
HOMES = os.path.expanduser("~/.mystical/agent-homes")
_lock = threading.Lock()
_options: dict = {}

_CLAUDE_TOKENS = {"claude", "anthropic", "opus", "sonnet", "haiku", "fable"}


def preset(agent_id) -> "dict | None":
    return next((p for p in PRESETS if p["id"] == agent_id), None)


def _resolve(name: str) -> "str | None":
    """A launcher's absolute path without trusting the ambient PATH (systemd
    gives a short one): PATH, then known install dirs, then the newest nvm node."""
    found = shutil.which(name)
    if found:
        return found
    for d in _FALLBACK_DIRS:
        cand = os.path.join(os.path.expanduser(d), name)
        if os.access(cand, os.X_OK):
            return cand
    nvm = sorted(glob.glob(os.path.expanduser(f"~/.nvm/versions/node/*/bin/{name}")))
    return nvm[-1] if nvm else None


def argv(p: dict) -> list:
    exe = _resolve(p["cmd"][0])
    return [exe or p["cmd"][0], *p["cmd"][1:]]


def available() -> list:
    return [{k: v for k, v in p.items() if k != "env"} | {"installed": bool(_resolve(p["cmd"][0]))}
            for p in PRESETS]


# --- accounts ---------------------------------------------------------------

def _load() -> list:
    try:
        with open(ACCOUNTS_FILE, encoding="utf-8") as f:
            rows = json.load(f).get("accounts", [])
    except (OSError, ValueError, AttributeError):
        return []
    return [r for r in rows if isinstance(r, dict) and r.get("id")]


def _save(rows: list) -> None:
    os.makedirs(os.path.dirname(ACCOUNTS_FILE), mode=0o700, exist_ok=True)
    tmp = ACCOUNTS_FILE + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump({"accounts": rows}, f, indent=2)
    os.chmod(tmp, 0o600)
    os.replace(tmp, ACCOUNTS_FILE)


def _mask(a: dict) -> dict:
    out = {k: v for k, v in a.items() if k != "key"}
    if a.get("key"):
        k = a["key"]
        out["key"] = (k[:3] + "…" + k[-4:]) if len(k) > 10 else "…"
    return out


def accounts(agent: "str | None" = None) -> list:
    return [_mask(a) for a in _load() if agent is None or a["agent"] == agent]


def account(acct_id) -> "dict | None":
    return next((a for a in _load() if a["id"] == acct_id), None) if acct_id else None


def home_dir(acct_id: str) -> str:
    return os.path.join(HOMES, acct_id)


def add_account(agent: str, label: str, kind: str, key: "str | None" = None) -> dict:
    p = preset(agent)
    label = (label or "").strip()[:32]
    if p is None:
        raise ValueError(f"unknown agent {agent!r}")
    if not label:
        raise ValueError("label is required")
    if kind == "key":
        if not p["key_env"]:
            raise ValueError(f"{p['label']} takes no API key here; use a separate login")
        key = (key or "").strip()
        if not key:
            raise ValueError("key is required")
    elif kind == "home":
        if not p["home_env"] or p["key_required"]:
            raise ValueError(f"{p['label']} can't use a separate login here")
        key = None
    else:
        raise ValueError("kind must be key or home")
    a = {"id": "a_" + uuid.uuid4().hex[:8], "agent": agent, "label": label, "kind": kind}
    if key:
        a["key"] = key
    with _lock:
        _save(_load() + [a])
    if kind == "home":
        os.makedirs(home_dir(a["id"]), mode=0o700, exist_ok=True)
    return _mask(a)


def remove_account(acct_id: str) -> None:
    with _lock:
        rows = _load()
        if not any(a["id"] == acct_id for a in rows):
            raise KeyError(acct_id)
        _save([a for a in rows if a["id"] != acct_id])
    # ponytail: a separate login's home dir is left on disk; it holds that
    # CLI's own login, which `rm -r` (or the CLI's logout) is the honest way to end.


# --- environment --------------------------------------------------------------

def env_for(p: dict, acct_id) -> dict:
    env = {k: v for k, v in os.environ.items()
           if k in _ALLOW or k.startswith(_ALLOW_PREFIX)}
    exe = _resolve(p["cmd"][0])
    if exe:   # npx needs node beside it; the systemd PATH may lack the nvm dir
        env["PATH"] = os.path.dirname(exe) + os.pathsep + env.get("PATH", "")
    env.update(p.get("env") or {})
    a = account(acct_id)
    if a and a["agent"] == p["id"]:
        if a["kind"] == "key" and p["key_env"]:
            env[p["key_env"]] = a["key"]
        elif a["kind"] == "home" and p["home_env"]:
            os.makedirs(home_dir(a["id"]), mode=0o700, exist_ok=True)
            env[p["home_env"]] = home_dir(a["id"])
    return env


def login_hint(p: dict, acct_id) -> str:
    if not p.get("login"):
        return f"Add a {p['label']} API key under Settings ▸ Accounts ▸ Agents."
    a = account(acct_id)
    if a and a["kind"] == "home":
        return f"Run once in a terminal: {p['home_env']}={home_dir(a['id'])} {p['login']}"
    return f"Run once in a terminal: {p['login']}"


def is_claude_model(value) -> bool:
    toks = re.split(r"[^a-z0-9]+", str(value or "").lower())
    return any(t in _CLAUDE_TOKENS for t in toks)


def run_problem(p: "dict | None", acct_id, chat_id, model) -> "str | None":
    """Why this agent turn may not start, or None."""
    if p is None:
        return "That agent is no longer offered."
    if chat_id != config.DASH_CHAT_ID:
        return "Agent profiles run only in the bridge owner's chat (one person per login)."
    if model and is_claude_model(model):
        return "Claude models run in a Claude profile, not through another agent."
    if acct_id and (account(acct_id) or {}).get("agent") != p["id"]:
        return f"The {p['label']} account in this profile is gone. Edit the profile."
    if p["key_required"] and not acct_id:
        return f"{p['label']} needs an API key account. {login_hint(p, acct_id)}"
    if not _resolve(p["cmd"][0]):
        return f"{p['label']} isn't installed here. Install: {p['install']}"
    return None


# --- options cache --------------------------------------------------------------

_CATEGORY = {"model": "model", "mode": "mode", "thought_level": "effort"}


def _flat(opts) -> list:
    out = []
    for o in opts or []:
        if isinstance(o, dict) and "options" in o and "value" not in o:
            out += _flat(o["options"])            # a group
        elif isinstance(o, dict) and "value" in o:
            out.append({"value": str(o["value"]), "name": str(o.get("name") or o["value"])})
    return out


def _shape(config_options, modes) -> dict:
    got = {"model": [], "mode": [], "effort": []}
    for o in config_options or []:
        cat = _CATEGORY.get((o or {}).get("category"))
        if cat and o.get("type", "select") == "select":
            got[cat] = _flat(o.get("options"))
    if not got["mode"] and isinstance(modes, dict):
        got["mode"] = [{"value": str(m.get("id")), "name": str(m.get("name") or m.get("id"))}
                       for m in modes.get("availableModes") or [] if isinstance(m, dict)]
    return got


def _key(agent, acct_id) -> str:
    return f"{agent}|{acct_id or ''}"


def _load_options() -> None:
    """Fill the in-memory cache from disk once. Caller holds _lock."""
    if _options:
        return
    try:
        with open(OPTIONS_FILE, encoding="utf-8") as f:
            data = json.load(f)
        if isinstance(data, dict):
            _options.update(data)
    except (OSError, ValueError):
        pass


def remember_options(agent: str, acct_id, config_options, modes) -> None:
    shaped = _shape(config_options, modes)
    with _lock:
        _load_options()
        _options[_key(agent, acct_id)] = shaped
        os.makedirs(os.path.dirname(OPTIONS_FILE), exist_ok=True)
        with open(OPTIONS_FILE + ".tmp", "w", encoding="utf-8") as f:
            json.dump(_options, f)
        os.replace(OPTIONS_FILE + ".tmp", OPTIONS_FILE)


def options_for(agent: str, acct_id) -> dict:
    with _lock:
        _load_options()
        return _options.get(_key(agent, acct_id)) or {"model": [], "mode": [], "effort": []}


def api_info() -> dict:
    """GET /local/agents: what the AGENTS section and the profile editor show."""
    with _lock:
        _load_options()
        opts = dict(_options)
    return {"presets": available(), "accounts": accounts(), "options": opts}
```

- [ ] **Step 4: Run** `python3 -m pytest tests/test_acp_agents.py -q`, then the full suite. Expected: PASS.
- [ ] **Step 5: Commit** `feat(acp): vetted agent presets, 0600 masked accounts, scrubbed child env` (explicit paths).

### Task 7: `bridge/acp.py`, the client, plus a fake agent

**Files:**
- Create: `bridge/acp.py`
- Create: `tests/fake_acp_agent.py` (a stdlib script, not a test module; pytest collects only `test_*.py`)
- Test: `tests/test_acp.py`

**Interfaces:**
- Consumes: nothing from runner. Everything goes through a job-like object with:
  - `add(ev)`, `add_pending(entry)`, `clear_pending()`, `pending: list`, `awaiting(kind)`
  - `texts: list`, `todos`, `ctx_tokens`, `cost`, `status`, `result`, `error_msg`, `elapsed`, `started`, `last_at`, `boot`
  - `interrupted`, `timed_out`, `agent_session_id`, `conn`, `turn`, `_interrupt_timer`, `model`
- Produces:
  - `acp.run_turn(job, *, argv, env, cwd, label, login_hint, text, agent_session_id, opts, on_spawn=None, on_session=None, cache=None) -> None` (never raises)
  - `acp.answer(job, request_id, allow: bool) -> bool`
  - `acp.cancel(job, grace: float) -> bool`
  - `acp.set_options(job, model=None, mode=None, effort=None) -> bool`
  - `acp.probe(*, argv, env, label, login_hint, timeout=120) -> {"ok", "error"?, "options", "modes"}`
  - `acp.pick_option(options, allow) -> str | None`
  - `acp.Conn` with `poll()`/`kill()`, so `runner._watchdog` can drive it

- [ ] **Step 1: Write the fake agent** `tests/fake_acp_agent.py`. It reads newline-delimited JSON-RPC on stdin and is scripted by the JSON in env `FAKE_ACP`:
  - `caps`: agentCapabilities (default `{"loadSession": true}`)
  - `new_error`: an error object for session/new
  - `prompt_error`: an error object for session/prompt
  - `options`: configOptions returned by new/load/resume and set_config_option
  - `modes`
  - `replay`: updates to send during session/load
  - `turn`: a list of steps, each one of:
    - `{"update": {...}}`: notify `session/update` `{sessionId, update}`
    - `{"permission": {"toolCall": {...}, "options": [...]}}`: send a `session/request_permission` request and block until its response
    - `{"vendor": "cursor/ask_question"}`: send that request and block for the reply
    - `{"stdout": "junk"}`: write a raw non-JSON line
    - `{"wait_cancel": true}`: block until a `session/cancel` notification arrives
    - `{"sleep": s}`
    - `{"exit": code}`: die mid-turn
  - `stop`: the stopReason (default `end_turn`)
  - `ignore_cancel`: true means never end on cancel

Every message it receives, and every response it gets to its own requests, is appended as JSON lines to the file in env `FAKE_ACP_LOG`. It also writes its own `os.environ` to `FAKE_ACP_LOG + ".env"` at startup. Keep it under 150 lines and stdlib only.

- [ ] **Step 2: Write the failing tests** (`tests/test_acp.py`):

```python
"""acp.py against tests/fake_acp_agent.py: mapping, cards, Stop, resume vs
load, -32601, -32000, junk stdout, crashes (Review Focus 3 and 4)."""
import json
import os
import sys
import threading
import time

import pytest

from bridge import acp

FAKE = os.path.join(os.path.dirname(__file__), "fake_acp_agent.py")


class FakeJob:
    def __init__(self):
        self.events, self.pending, self.texts, self.todos = [], [], [], []
        self.ctx_tokens = self.cost = self.result = self.error_msg = self.elapsed = None
        self.status, self.boot, self.model = "running", "starting", None
        self.started = self.last_at = time.time()
        self.interrupted = self.timed_out = False
        self.agent_session_id = self.conn = self.turn = self._interrupt_timer = None
        self.awaited = []
    def add(self, ev): self.events.append(ev); self.last_at = time.time()
    def add_pending(self, e): self.pending.append(e)
    def clear_pending(self): self.pending = []
    def awaiting(self, kind): self.awaited.append(kind)
    def types(self): return [e["type"] for e in self.events]


def _run(tmp_path, script, *, sid=None, opts=None, job=None, background=False):
    log = tmp_path / "log.jsonl"
    env = {**os.environ, "FAKE_ACP": json.dumps(script), "FAKE_ACP_LOG": str(log)}
    job = job or FakeJob()
    kw = dict(argv=[sys.executable, FAKE], env=env, cwd=str(tmp_path), label="Fake",
              login_hint="run fake login", text="hello", agent_session_id=sid,
              opts=opts or {}, on_session=lambda s: job.__dict__.setdefault("saved", s))
    if background:
        t = threading.Thread(target=acp.run_turn, args=(job,), kwargs=kw, daemon=True)
        t.start()
        return job, log, t
    acp.run_turn(job, **kw)
    return job, log


def _sent(log):
    return [json.loads(l) for l in open(log)] if os.path.exists(log) else []


def _wait(cond, t=5):
    end = time.time() + t
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.02)
    return False


def test_a_turn_maps_chunks_tools_plans_and_usage(tmp_path):
    job, log = _run(tmp_path, {"turn": [
        {"update": {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "hmm"}}},
        {"update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Hel"}}},
        {"update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "lo."}}},
        {"update": {"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Edit a.py",
                    "kind": "edit", "status": "pending", "locations": [{"path": "a.py"}]}},
        {"update": {"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed",
                    "content": [{"type": "diff", "path": "a.py", "oldText": "x\n", "newText": "y\n"}]}},
        {"update": {"sessionUpdate": "plan", "entries": [{"content": "Do it", "status": "pending",
                                                          "priority": "high"}]}},
        {"update": {"sessionUpdate": "usage_update", "used": 1234, "size": 200000,
                    "cost": {"amount": 0.02, "currency": "USD"}}},
        {"update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Done"}}},
        {"update": {"sessionUpdate": "brand_new_kind"}},
    ]})
    assert job.status == "done" and job.agent_session_id == job.saved
    assert job.types() == ["thinking", "text", "tool", "tool_done", "text", "result"]
    done = job.events[3]
    assert done["id"] == "t1" and "-x" in done["patch"] and "+y" in done["patch"]
    assert job.texts == ["Hello.", "Done"] and job.result == "Done"
    assert job.todos[0]["content"] == "Do it" and job.ctx_tokens == 1234 and job.cost == 0.02
    sent = _sent(log)
    assert sent[0]["method"] == "initialize" and sent[0]["params"]["protocolVersion"] == 1
    assert sent[0]["params"]["clientCapabilities"]["terminal"] is False


def test_permission_card_round_trip_sends_the_agents_own_option_id(tmp_path):
    job, log, t = _run(tmp_path, {"turn": [{"permission": {
        "toolCall": {"toolCallId": "t9", "title": "Run npm test", "rawInput": {"command": "npm test"}},
        "options": [{"optionId": "yes-1", "name": "Allow", "kind": "allow_once"},
                    {"optionId": "no-1", "name": "Deny", "kind": "reject_once"}]}}]},
        background=True)
    assert _wait(lambda: job.pending)
    card = job.pending[0]
    assert card["kind"] == "permission" and card["tool_name"] == "Run npm test"
    assert job.awaited == ["permission"]
    assert acp.answer(job, card["request_id"], True)
    t.join(5)
    replies = [m for m in _sent(log) if m.get("result", {}).get("outcome")]
    assert replies[0]["result"]["outcome"] == {"outcome": "selected", "optionId": "yes-1"}
    assert job.status == "done"


def test_stop_with_a_waiting_card_answers_cancelled_and_ends_stopped(tmp_path):
    job, log, t = _run(tmp_path, {"turn": [{"permission": {
        "toolCall": {"toolCallId": "t1", "title": "rm -rf"},
        "options": [{"optionId": "y", "kind": "allow_once"}]}}, {"wait_cancel": True}],
        "stop": "cancelled"}, background=True)
    assert _wait(lambda: job.pending)
    assert acp.cancel(job, grace=2.0)
    t.join(5)
    assert not t.is_alive() and job.types()[-1] == "stopped" and job.pending == []
    outcomes = [m["result"]["outcome"] for m in _sent(log) if "result" in m and "outcome" in m["result"]]
    assert {"outcome": "cancelled"} in outcomes
    assert any(m.get("method") == "session/cancel" for m in _sent(log))


def test_an_agent_that_ignores_cancel_is_killed_after_grace(tmp_path):
    job, _, t = _run(tmp_path, {"turn": [{"sleep": 30}], "ignore_cancel": True}, background=True)
    assert _wait(lambda: job.conn is not None and job.agent_session_id)
    acp.cancel(job, grace=0.3)
    t.join(5)
    assert not t.is_alive() and job.types()[-1] == "stopped"
    assert job.conn.poll() is not None


def test_resume_is_preferred_and_load_replay_is_dropped(tmp_path):
    replay = [{"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "OLD"}}]
    job, log = _run(tmp_path, {"caps": {"loadSession": True}, "replay": replay,
                               "turn": [{"update": {"sessionUpdate": "agent_message_chunk",
                                                    "content": {"type": "text", "text": "new"}}}]},
                    sid="s-old")
    assert job.texts == ["new"]
    assert "session/load" in [m.get("method") for m in _sent(log)]
    job2, log2 = _run(tmp_path, {"caps": {"loadSession": True, "sessionCapabilities": {"resume": {}}},
                                 "turn": []}, sid="s-old")
    methods = [m.get("method") for m in _sent(log2)]
    assert "session/resume" in methods and "session/load" not in methods


def test_options_are_applied_by_category_and_unknown_values_logged(tmp_path):
    opts = [{"id": "model", "category": "model", "type": "select", "currentValue": "a",
             "options": [{"value": "a", "name": "A"}, {"value": "b", "name": "B"}]}]
    job, log = _run(tmp_path, {"options": opts, "turn": []},
                    opts={"model": "b", "permission_mode": "nope"})
    sets = [m for m in _sent(log) if m.get("method") == "session/set_config_option"]
    assert sets and sets[0]["params"] == {"sessionId": job.agent_session_id,
                                          "configId": "model", "value": "b"}
    assert any(e["type"] == "log" and "nope" in e["text"] for e in job.events)


def test_unknown_agent_requests_get_method_not_found(tmp_path):
    job, log = _run(tmp_path, {"turn": [{"vendor": "cursor/ask_question"}]})
    errs = [m for m in _sent(log) if "error" in m]
    assert errs and errs[0]["error"]["code"] == -32601 and job.status == "done"


def test_auth_required_names_the_login(tmp_path):
    job, _ = _run(tmp_path, {"new_error": {"code": -32000, "message": "Authentication required"}})
    assert job.status == "error" and "run fake login" in job.error_msg


def test_junk_on_stdout_is_skipped(tmp_path):
    job, _ = _run(tmp_path, {"turn": [{"stdout": "Loading config…"},
                                      {"update": {"sessionUpdate": "agent_message_chunk",
                                                  "content": {"type": "text", "text": "ok"}}}]})
    assert job.status == "done" and job.texts == ["ok"]


def test_a_crash_mid_turn_ends_in_error_with_the_stderr_tail(tmp_path):
    job, _ = _run(tmp_path, {"turn": [{"exit": 3}]})
    assert job.status == "error" and job.conn.poll() is not None


def test_a_prompt_error_ends_in_error(tmp_path):
    job, _ = _run(tmp_path, {"prompt_error": {"code": 429, "message": "Quota exhausted"}})
    assert job.status == "error" and "Quota exhausted" in job.error_msg


def test_a_binary_that_does_not_exist_fails_cleanly(tmp_path):
    job = FakeJob()
    acp.run_turn(job, argv=[str(tmp_path / "nope")], env=dict(os.environ), cwd=str(tmp_path),
                 label="Fake", login_hint="", text="x", agent_session_id=None, opts={})
    assert job.status == "error" and "could not start" in job.error_msg


def test_probe_reports_options_and_cleans_up(tmp_path):
    opts = [{"id": "m", "category": "model", "type": "select", "options": [{"value": "a", "name": "A"}]}]
    env = {**os.environ, "FAKE_ACP": json.dumps({"options": opts,
                                                  "caps": {"sessionCapabilities": {"delete": {}}}}),
           "FAKE_ACP_LOG": str(tmp_path / "p.jsonl")}
    out = acp.probe(argv=[sys.executable, FAKE], env=env, label="Fake", login_hint="")
    assert out["ok"] and out["options"] == opts
    assert "session/delete" in [m.get("method") for m in _sent(tmp_path / "p.jsonl")]
```

- [ ] **Step 3: Run; they fail** (no `bridge.acp`).

- [ ] **Step 4: Write `bridge/acp.py`.** The structure is fixed below. Fill in exactly this behaviour:

```python
"""One stdlib ACP (Agent Client Protocol v1) client. It runs one turn of a
non-Claude agent and maps it onto the bridge's own transcript events.

Why hand-rolled: the official Python SDK needs pydantic and asyncio, and the
bridge is stdlib and threads. The subset a bridge needs is small: cc-connect's
Go transport is 236 lines (research: .mystical/docs/research_notes/
Multi-provider support/agent-runtimes.md, Q2).

Deliberately not done:
- fs or terminal client capabilities: the agent uses its own tools.
- elicitation, terminal auth, session/fork, v2.
It pins protocolVersion 1 and ignores update kinds it doesn't know, because
the schema ships a minor version every week or two.

One process per turn, like `claude -p`: spawn, initialize, new/resume/load,
prompt, close. ponytail: a cold start costs 2-13 s per turn and session/load
replays history. Keep one process per session alive if that ever hurts.

Every agent→client request gets an answer, unknown ones -32601, or the turn
hangs (Cursor's blocking cursor/ask_question). Permission requests are the one
kind answered later: each becomes the same pending card a Claude turn shows,
and answer() replies with the option id the agent itself offered.

Frames are split on b"\\n" only (never str.splitlines(): U+2028 inside JSON
broke two other products). Non-JSON stdout lines are skipped.
"""
```

Components and their contracts. Keep each function short:

1. **`AcpError(code, message)`, `AcpClosed`, `DEFER = object()`.**

2. **`Conn(argv, *, env, cwd, on_notify, on_request)`.**
   - Spawns with `Popen(argv, cwd=cwd, env=env, stdin=PIPE, stdout=PIPE, stderr=PIPE, start_new_session=True)` in binary mode.
   - Runs a reader thread and a stderr drain thread (`stderr_tail = deque(maxlen=40)` of decoded lines).
   - A `_wlock` guards writes. `_pending: {id: [Event, result, error]}` is guarded by `_plock`.
   - `request(method, params, timeout)`:
     - On timeout it raises `AcpError(-32603, "<method>: no answer in Ns")`.
     - If the process closed first it raises `AcpClosed`.
     - A JSON-RPC error raises `AcpError(code, message)`.
   - `notify(method, params)` and `reply(rid, result=None, error=None)` swallow `AcpClosed`.
   - The reader's `_dispatch` routes three message kinds:
     - a response, matched by `id` with no `method`;
     - a notification: `on_notify(method, params)`, with exceptions printed to stderr, never raised;
     - an agent request: `on_request(rid, method, params)`. Its result is replied unless it is `DEFER`. `AcpError` becomes the error reply, and any other exception becomes `-32603`.
   - On EOF every pending slot is marked closed.
   - `poll()` returns `proc.poll()`.
   - `kill()` sends `os.killpg(pid, SIGTERM)`, waits 2 s, then sends SIGKILL. It ignores `ProcessLookupError`/`PermissionError`.
   - `close(grace=2.0)` closes stdin, waits `grace`, then calls `kill()`.

3. **`Turn(job, label)`.** The mapping.
   - Buffers: `text`, `thought` and `think_t0`. `tools: {toolCallId: (name, t0, kind)}`.
   - State: `replaying`, `sid`, `options`, `modes`.
   - `flush()` emits the buffered thought as `{"type":"thinking","ms":…, "text":…}`. Then it emits the buffered text as `{"type":"text","text":…}` and appends it to `job.texts`. A message chunk first flushes any buffered thought.
   - `on_notify("session/update", {update})` does nothing while `replaying`. Otherwise it sets `job.boot = None` and `job.last_at = now`, then dispatches on `update["sessionUpdate"]`:
     - `agent_message_chunk` and `agent_thought_chunk`: buffer the text. Only `content.type == "text"` contributes.
     - `tool_call`: `flush()`, then `add({"type":"tool","name": title or kind or "tool","id": toolCallId,"summary": _summary(u)})`. If its status is already completed or failed, call `_done`.
     - `tool_call_update` with status completed or failed: `_done(id, u)`.
       - `_done` emits `{"type":"tool_done","id","ms"?,"is_error"?}`.
       - Add `patch` from the diff content via `difflib.unified_diff(old.splitlines(), new.splitlines(), lineterm="", n=3)`, minus the `---`/`+++` headers, capped at 400 lines plus `"…"`.
       - For an `execute`-kind tool, add `output` from the text content, last 4000 chars.
       - Otherwise add `stat` = `"N lines"` of the text content when non-empty.
     - `plan`: `job.todos = [{"content", "status", "activeForm": content}]`.
     - `usage_update`: `job.ctx_tokens = used` if it is an int. Set `job.cost = amount` when the currency is `USD`.
     - `config_option_update`: `self.options = u["configOptions"]`.
     - Anything else: ignored.
   - `on_request(rid, "session/request_permission", params)`:
     1. `flush()`.
     2. Take the name from `toolCall.title`, else from the tool already seen with that id, else `"tool"`.
     3. Create the card with `key = f"acp-{rid}"`, `job.add_pending({"request_id": key, "kind": "permission", "tool_name": name, "summary": _summary(toolCall), "input": rawInput or {}, "acp_rpc_id": rid, "options": options, "at": time.time()})`.
     4. `job.add({"type": "permission", "request_id": key, "tool_name": name, "summary": …})` and `job.awaiting("permission")`.
     5. Return `DEFER`.

     Any other method raises `AcpError(-32601, f"not supported: {method}")`.
   - `_summary(u)`: `rawInput.command` (a list is joined) or `rawInput.cmd`, else the first three `locations[].path` joined, else the title. It is `str()` capped at 200 chars.

4. **`run_turn(...)`.**
   1. Sets `job.turn` and `job.conn`, then calls `on_spawn(conn)`.
   2. Sends `initialize`: `{protocolVersion: 1, clientCapabilities: {fs: {readTextFile: False, writeTextFile: False}, terminal: False}, clientInfo: {name: "mystical-assistant", title: "Mystical Assistant", version: "1"}}`, timeout 120.
   3. Opens the session:
      - With `agent_session_id`:
        - `session/resume` when `agentCapabilities.sessionCapabilities.resume` is present (the value may be `{}`; check `is not None`);
        - else `session/load` with `turn.replaying = True` around it;
        - else it fails with "<label> can't resume a session, so this one can't continue. Start a new session."
      - Without it: `session/new {cwd, mcpServers: []}`. It calls `on_session(sid)` before prompting, so the id survives a crash.
   4. Stores `job.agent_session_id`, `turn.options/modes` and `cache(options, modes)`.
   5. Applies `opts` (`model` → category `model`, `permission_mode` → `mode`, `effort` → `thought_level`) through `_apply`:
      - `session/set_config_option {sessionId, configId, value}` when an option of that category lists that value;
      - else, for mode only, `session/set_mode {sessionId, modeId}` when `modes.availableModes` has it;
      - else `job.add({"type":"log","src":"acp","text": f"{label} doesn't offer {knob} {value!r}; using its default"})`.
      - A refused `set_config_option` is logged the same way.
   6. Calls `session/prompt` with `[{type: "text", text}]` and `timeout=None`. The watchdog owns hangs.
   7. Ends the turn:
      - `flush()`, then set `job.result = job.texts[-1] if job.texts else ""`.
      - If `job.interrupted` or the stopReason is `cancelled`: `status = "done"` and add `{"type": "stopped"}`.
      - If the stopReason is `refusal`: error "<label> refused this request."
      - Otherwise: `status = "done"`, `elapsed`, and add `{"type":"result","result","cost","elapsed","is_error": False}`. Before the result, add a `log` row for `max_tokens` and `max_turn_requests`.

   Error handling:
   - `AcpError` with code `-32000`: error `f"{label} needs a login. {login_hint}"`.
   - Any other `AcpError`: `f"{label}: {e}"`.
   - `AcpClosed`:
     - "stopped" if `job.interrupted`;
     - else, if `job.timed_out`: "⏱️ No output for N min — killed as hung." (`config.RUN_TIMEOUT`);
     - else `f"{label} exited"` plus the last five stderr lines.
   - `OSError` when spawning: `f"{label} could not start: {e}"`.

   `finally`:
   - answer every pending card with `cancelled`, then `clear_pending()`;
   - `conn.close()`;
   - if the job has an `_interrupt_timer`, cancel it.

5. **`answer(job, request_id, allow)`.**
   - Pops the pending entry.
   - Gets `oid = pick_option(entry["options"], allow)`. `pick_option` takes the first option of kind `allow_once`, then `allow_always` (for reject: `reject_once`, then `reject_always`). It returns None if there is none.
   - Replies `{"outcome": {"outcome": "selected", "optionId": oid}}`, or `{"outcome": {"outcome": "cancelled"}}` when there is no id.
   - Adds `{"type":"permission_resolved","request_id","behavior": "allow" if allow and oid else "deny"}`.
   - Returns False for an unknown id.

6. **`cancel(job, grace)`.**
   - Returns False if there is no live conn.
   - Sets `job.interrupted = True` and notifies `session/cancel {sessionId}`.
   - Answers every pending card `cancelled`, adds `permission_resolved` deny for each, and calls `clear_pending()`.
   - Starts `job._interrupt_timer = threading.Timer(grace, conn.kill)` (daemon) and returns True.

7. **`set_options(job, model, mode, effort)`.**
   - Returns False unless `job.conn` is alive and `job.turn.sid` is set.
   - Applies each given value via `_apply` with a 10 s request timeout. It runs from an HTTP thread, never from the reader.
   - Sets `job.model` on a model switch. Returns whether anything was sent.

8. **`probe(...)`.**
   1. Creates a temp dir (`tempfile.mkdtemp(prefix="mystical-acp-probe-")`) and opens a `Conn` with a no-op notify and an on_request that raises -32601.
   2. Sends `initialize`, then `session/new` in that dir.
   3. Cleans up the scratch session: `session/delete` if `sessionCapabilities.delete` is present, else `session/close` if `close` is present. Errors are ignored.
   4. Returns `{"ok": True, "options", "modes", "agent": init.get("agentInfo")}`. On `-32000` it returns `{"ok": False, "error": f"{label} needs a login. {login_hint}"}`; other failures return `{"ok": False, "error": …}` with the stderr tail.
   5. `finally`: `conn.close()` and `shutil.rmtree(tmp)`.

- [ ] **Step 5: Run** `python3 -m pytest tests/test_acp.py -q` until green, then the full suite. Each test must finish in under 5 s; nothing may leave a child running. Check with `pgrep -f fake_acp_agent` after the run, which should print nothing.
- [ ] **Step 6: Commit** `feat(acp): stdlib ACP v1 client — streaming map, cards, Stop, resume/load, probe` (explicit paths: `bridge/acp.py tests/fake_acp_agent.py tests/test_acp.py`).

### Task 8: Runner integration, plus profiles accepting agents

**Files:**
- Modify: `bridge/store.py`: `agent_session_id TEXT` column (schema + migration), and add it to `_SESSION_FIELDS`
- Modify: `bridge/runner.py`:
  - new `class AcpJob(Job)`
  - `start_streaming_job`: agent runtime from the profile, `AcpJob` creation, skip `_claim_session_id` for agents
  - `_run_streaming`: an `acp:` branch calling `_consume_acp`
  - new `_consume_acp`
  - `steer()` refuses `AcpJob`
  - `_maybe_auto_resume` returns False for `acp:` runtimes
  - `handle_task` refuses agent sessions
- Modify: `bridge/profiles.py`:
  - `_check_agent` validates against `acp_agents`
  - `refusal` covers agents via `acp_agents.run_problem`
  - `run_values` gains an `agent` parameter
  - the `bind` cross-agent rule is now testable
- Modify: `bridge/miniapp/server.py` and `bridge/dashboard/server.py`: `/run` and `save_run_settings` pass the target session's agent to `run_values`
- Test: `tests/test_acp_runner.py`; extend `tests/test_profiles.py` with agent validation and the 409 bind

**Interfaces:**
- Consumes: Tasks 1, 2, 6 and 7.
- Produces:
  - `AcpJob` attributes `acp_account`, `agent_session_id`, `conn`, `turn`.
  - `profiles.run_values(model, mode, effort, agent="claude")`. For an agent it returns `(err, model, mode, effort)`:
    - model: `"Claude models run in a Claude profile"` when `acp_agents.is_claude_model`, else the stripped string or None;
    - mode and effort: stripped strings of at most 64 chars, or None;
    - never Claude-mode validation.

`_check_agent(agent, account, model, mode, effort)` raises ValueError when:
- `acp_agents.preset(agent)` is None;
- the account is set and `acp_agents.account(account)` is missing or belongs to another agent;
- `acp_agents.is_claude_model(model)` holds;
- the mode or effort is longer than 64 chars.

`profiles.refusal(eff, chat_id)` keeps its Claude check, and for `eff["agent"] != "claude"` returns `acp_agents.run_problem(acp_agents.preset(eff["agent"]), eff["account"], chat_id, eff["model"])`.

`start_streaming_job`. After computing `eff` and the refusal:

```python
        if runtime is None and account_slot is None and eff["agent"] != profiles.CLAUDE:
            runtime = f"acp:{eff['agent']}"
        is_acp = (runtime or "").startswith("acp:")
        job = (AcpJob if is_acp else Job)(job_id or uuid.uuid4().hex, chat_id, session["id"])
        if is_acp:
            job.acp_account = eff["account"]
            job.resume_id, job.new_session, job.fork = None, False, False   # never mint a claude id
        else:
            job.resume_id, job.new_session, job.fork = _claim_session_id(...)
```

Keep every existing line for the Claude path. The "if runtime is None and account_slot … claude:<slot>" stays Claude-only.

`AcpJob(Job)`:

```python
class AcpJob(Job):
    """A turn run by a non-Claude agent over ACP (bridge/acp.py). Same events,
    cards and Stop as a Claude job; the control channel is JSON-RPC, so every
    stream-json write path is closed off."""
    def __init__(self, *a, **kw):
        super().__init__(*a, **kw)
        self.acp_account = ""
        self.agent_session_id = None
        self.conn = None
        self.turn = None

    def _write_stdin(self, obj):            # no stream-json stdin here
        return False

    def awaiting(self, kind):
        notify_awaiting(self.chat_id, self.store_session_id, kind)

    def interrupt(self):
        from bridge import acp
        return acp.cancel(self, INTERRUPT_GRACE)

    def respond(self, request_id, *, behavior="allow", message=None, answers=None):
        from bridge import acp
        return acp.answer(self, request_id, behavior == "allow")

    def set_run_settings(self, model=None, permission_mode=None):
        from bridge import acp
        return acp.set_options(self, model=model, mode=permission_mode)

    def release_held(self):
        return None
```

`_consume_acp(job, prompt, image_paths, cwd, model, effort, permission_mode)`:

```python
def _consume_acp(job, prompt, image_paths, cwd, model, effort, permission_mode):
    """Run this turn on its ACP agent. Preconditions (owner, install, account,
    no Claude model) end it with the reason before anything starts."""
    from bridge import acp, acp_agents
    agent = job.runtime.split(":", 1)[1]
    p = acp_agents.preset(agent)
    problem = acp_agents.run_problem(p, job.acp_account, job.chat_id, model)
    if problem:
        job.error_msg = problem
        job.add({"type": "error", "message": problem})
        job.status = "error"
        return
    sess = store.get_session(job.store_session_id) if job.store_session_id else None
    job.boot = f"starting {p['label']}"
    acp.run_turn(
        job, argv=acp_agents.argv(p), env=acp_agents.env_for(p, job.acp_account), cwd=cwd,
        label=p["label"], login_hint=acp_agents.login_hint(p, job.acp_account),
        text=_with_images(prompt, image_paths),
        agent_session_id=(sess or {}).get("agent_session_id"),
        opts={"model": model, "permission_mode": permission_mode, "effort": effort},
        on_spawn=lambda conn: threading.Thread(target=_watchdog, args=(job, conn),
                                               daemon=True).start(),
        on_session=lambda sid: job.store_session_id and store.set_session_field(
            job.store_session_id, "agent_session_id", sid),
        cache=lambda opts, modes: acp_agents.remember_options(agent, job.acp_account, opts, modes))
```

In `_run_streaming`, after the refusal check, add `if (job.runtime or "").startswith("acp:"): _consume_acp(job, prompt, image_paths, cwd, model, effort, permission_mode); return`. This branch replaces nothing yet: the opencode branch is removed in Task 10.

`steer()`: `if job is None or job.proc is None or isinstance(job, AcpJob): return False`. Check what the dashboard does on a False steer. If it shows an error rather than queueing, leave the server as is and note it for Task 11, which makes the composer queue for agent sessions.

`_maybe_auto_resume`: first line `if (job.runtime or "").startswith("acp:"): return False`.

`handle_task`: if `eff["agent"] != profiles.CLAUDE`, `send(chat_id, "This session runs on another agent — continue it in the Mini App or the dashboard.")` and return.

Routes: `/run` (both servers) and `save_run_settings` find the target agent and pass it to `run_values`:
- for an existing session: `profiles.effective(session)["agent"]`;
- for a fresh one: the body's `profile_id`, else the project default's profile agent, else `"claude"`.

Write `profiles.agent_for(session, profile_id, project) -> str` for this and use it in both servers.

- [ ] **Step 1: Write the failing tests** (`tests/test_acp_runner.py`):
  - **Setup:** monkeypatch `acp_agents.PRESETS` to `({"id": "fake", "label": "Fake", "cmd": [sys.executable, FAKE], "key_env": None, "home_env": None, "key_required": False, "login": "fake login", "install": "n/a", "env": {}},)`. Monkeypatch `acp_agents._resolve` to `lambda name: name`. Point `ACCOUNTS_FILE`, `OPTIONS_FILE` and `HOMES` at tmp. Create a profile `{"agent": "fake", "name": "F"}` and a session bound to it.
  - **test_an_agent_turn_runs_end_to_end:**
    - Run `start_streaming_job(config.DASH_CHAT_ID, "hi", [], project=config.BASE_PATH, session_id=sid)` with env `FAKE_ACP` scripting one message chunk.
    - Wait on `job.exited` for up to 10 s.
    - Assert `job.runtime == "acp:fake"`, `isinstance(job, runner.AcpJob)`, the turn in `store.transcript(sid)` is `done` with runtime `acp:fake`, the journaled events include `text`, and `sessions.agent_session_id` is set while `claude_session_id` stays None.
    - FAKE_ACP must reach the child even though `env_for` scrubs: use `monkeypatch.setitem(acp_agents.PRESETS[0]["env"], "FAKE_ACP", json.dumps(script))` on the patched preset.
  - **test_a_second_turn_resumes_the_same_agent_session:** the second turn's FAKE log shows `session/load` (or `resume`) with the first turn's id.
  - **test_a_non_owner_chat_is_refused:** start as chat `config.DASH_CHAT_ID + 7` → turn `error`, message mentions "owner", and no process is spawned (monkeypatch `subprocess.Popen` to fail if called).
  - **test_stop_ends_the_turn_and_releases_the_slot:** script `[{"wait_cancel": true}]` with stop `cancelled` → `runner.get_job(job.id).interrupt()` → `job.exited` is set within 10 s, `state.acquire_run(sid, chat)` succeeds afterwards (release it again), and the last event is `stopped`.
  - **test_steer_and_auto_resume_skip_agent_jobs:** `runner.steer(sid, "x")` is False while the job runs. A job ending `error` returns `_maybe_auto_resume(job, cwd, None, None) is False` with no new job started.
  - **test_profiles_accept_agents_and_refuse_claude_models** (in `tests/test_profiles.py`): create `{"agent": "fake", "model": "claude-opus-5-5"}` → ValueError "Claude". `{"agent": "fake", "account": "a_nope"}` → ValueError "account". `{"agent": "fake", "mode": "read-only"}` → ok.
  - **test_bind_across_agents_after_a_turn_is_409:** session bound to a Claude profile with one turn row (`store.start_turn`), bind to the fake profile → 409. With no turns → 200.
- [ ] **Step 2: Run; they fail.**
- [ ] **Step 3: Implement** as specified above.
- [ ] **Step 4: Run** the new tests, then the full suite. Nothing may leave a `fake_acp_agent` process behind.
- [ ] **Step 5: Commit** `feat(acp): agent profiles run through AcpJob; agent session ids kept apart from claude's`.

### Task 9: Agent routes (presets, accounts, TEST)

**Files:**
- Modify: `bridge/dashboard/server.py`:
  - GET `/local/agents` → `acp_agents.api_info()`
  - POST `/local/agents/accounts` → `{action: create|delete, agent, label, kind, key?, id?}`
  - POST `/local/agents/test` → `{agent, account}`
- Modify: `bridge/acp_agents.py`: `api_account(body) -> (json, status)` and `api_test(body) -> (json, status)`. The latter runs `acp.probe(argv=argv(p), env=env_for(p, acct), label=…, login_hint=…)`; on ok it calls `remember_options` and returns `{"ok", "options": options_for(agent, acct)}`. It refuses unknown agents with 404.
- Test: `tests/test_acp_endpoint.py`

The Mini App gets no agent routes: agent setup is a desk task, and profiles already list agent profiles.

- [ ] **Step 1: Write the failing tests:**
  - `create` key account → 200, masked.
  - `delete` unknown → 404.
  - `create` with a bad kind → 400.
  - `/local/agents` lists the three presets with `installed` and never a raw key.
  - `test` against the fake preset → ok plus options.
  - `test` for an unknown agent → 404.
  - Every POST goes through the dashboard's existing Host/Origin/X-Dash-Token gate; call the handler methods directly, as Task 3 does.
- [ ] **Step 2: Run; they fail.**
- [ ] **Step 3: Implement.** `/local/agents/test` blocks for up to 120 s. That is acceptable on the threaded dashboard server; confirm it is a `ThreadingHTTPServer` by grepping `server.py`.
- [ ] **Step 4: Run** them and the full suite.
- [ ] **Step 5: Commit** `feat(acp): agent accounts + TEST routes on the dashboard`.

### Task 10: Remove the opencode one-shot fallback

**Files:**
- Delete: `bridge/freeagent.py`, `tests/test_freeagent.py`
- Modify:
  - `bridge/runner.py`: `_consume_free_agent`, the `opencode:` branch at the top of `_run_streaming`, the `opencode:` check in `Job.set_run_settings` (~824), and the `runtime` comment in `Job.__init__`
  - `bridge/ladder.py`: drop `_free_providers`, the free rungs in `rungs()`, the `opencode` branch of `resolve_agent`, and any free-agent handoff/briefing code; update the module docstring's ladder list
  - `bridge/nextup.py` (~316-330): drop the free-agent scout path, keeping the Claude one-shot
  - `bridge/dashboard/server.py`: `_free_agents()` (129-137), the `free_agents` key in GET `/local/accounts`, and POST `/local/freeagents` (1012-1019)
  - `bridge/agentconfig.py`: it imports freeagent for opencode paths; inline the one thing it needs or use `acp_agents._resolve("opencode")`
  - `bridge/store.py`: the one reference
  - `tests/conftest.py` (2 refs), `tests/test_ladder.py`, `tests/test_nextup.py`, `tests/test_fallback_endpoints.py`, `tests/test_fallback_commands.py`, `tests/test_permission_modes.py`, `tests/test_session_run_settings.py`, `tests/test_agentconfig.py`: delete tests of the removed behaviour, keep everything else

**Interfaces:** `ladder.resolve_agent("opencode:x")` now raises `ValueError("unknown agent …")`. The queue's `_default_run_fn` already turns that into "no account".

- [ ] **Step 1:** Run `grep -rn "freeagent\|free_agent\|_free_providers\|opencode:" bridge tests | grep "\.py:"` and keep the list.
- [ ] **Step 2:** Remove each reference. Tests that assert the removed behaviour get deleted; tests that assert remaining behaviour get their free-agent fixtures dropped.
- [ ] **Step 3:** Run the full suite. Expected: green. Run the grep from Step 1 again; it must print only lines in this plan and the spec.
- [ ] **Step 4: Commit** `refactor: drop the opencode one-shot fallback (0 turns ever); ACP replaces it` with every touched path listed explicitly, including deletions (`git rm` the two files).

### Task 11: Dashboard UI for agents

**Files:**
- Modify: `bridge/dashboard/web/src/api.ts`:
  - `AgentsInfo` / `AgentPreset` / `AgentAccount` types
  - `agents()`, `agentAccount(body)`, `agentTest(agent, account)`
  - remove `FreeAgentInfo`/`FreeAgents`/`setFreeAgent` and the `free_agents` key of `AccountsInfo`
- Modify: `bridge/dashboard/web/src/components/hud/SettingsModal.tsx`:
  - the ACCOUNTS tab's FREE AGENTS section (3486-3517) and `FreeAgentRow` (3611-3677) become an AGENTS section
  - `ProfilesPanel`'s agent/account/model/mode/effort fields learn agents
- Modify: `bridge/dashboard/web/src/components/Composer.tsx`:
  - remove `FREE_PERMS`/`freeLabel`/free special-cases (42-45, 258-300, 945-966, 1103-1107)
  - for an agent session, model/mode/effort options come from props built by App (the agent's cached options; empty → hide that picker)
- Modify: `bridge/dashboard/web/src/App.tsx`: `freeAgents` state (238-241, 1017-1033) and the `agentOpts` free branch (1711-1730) are removed; composer options for agent sessions come from `api.agents().options["<agent>|<account>"]`
- Modify: `bridge/dashboard/web/src/components/Transcript.tsx` `RuntimeBadge` (54-76): `acp:<id>` renders `◇ <LABEL>` (label from the agents info, else the id upper-cased); drop the free-agent case
- Modify: `bridge/dashboard/web/src/components/hud/StatusBar.tsx` (36, 125-128, 211-214): the "NO CLAUDE QUOTA" free-agent logic becomes "show the agent label when the open session's agent isn't Claude"
- Modify: `bridge/dashboard/web/src/chat.ts` (25-27, 87-100): only if it special-cases `opencode:`

Behaviour:
1. **AGENTS section, one row per preset:**
   - label;
   - INSTALLED, or NOT INSTALLED plus the install command with a copy button;
   - its accounts (label, kind, masked key, ✕);
   - "+ API KEY" (label + key inputs; only when `key_env` is set);
   - "+ SEPARATE LOGIN" (label; on success it shows `login_hint` with a copy button; only when `home_env` is set and not `key_required`);
   - TEST per account and for the machine login, showing ✓ with N models or ✕ with the server's error.
   - A one-line note under the section: "Only vetted agents are offered. Logins happen in each CLI's own sign-in; the bridge stores only API keys you paste here."
2. **ProfilesPanel:**
   - The agent select offers Claude plus the installed presets.
   - The account select switches between Claude logins and that agent's accounts ("MACHINE LOGIN" = `""`).
   - Model/mode/effort selects come from the cached options for agent+account, with "AGENT DEFAULT" (`""`) first. When there are no cached options, show a TEST button inline.
   - Tools (the deny list) is Claude-only, so hide it for agents.
3. **Composer, agent sessions:**
   - The pickers show the agent's own options.
   - Effort hides when the agent has no `thought_level`.
   - Sending while a turn runs queues (`steer` refuses agents).
   - A small `◇ CODEX` chip sits beside PROFILE.
4. Every new call tolerates a 404, as before.
5. **Mini App**, for a session whose brief has `agent !== "claude"`:
   - hide the MODEL, REASONING EFFORT and OPERATING MODE rows;
   - send no `model`/`permission_mode`/`effort` on `/run` or `setRunSettings`;
   - otherwise the server would refuse a Claude model for an agent (rule 4).

   Files: `bridge/miniapp/web/src/lib/chat.tsx` (`runPrompt` 573-582, `pickRun` 330-340) and `bridge/miniapp/web/src/components/Composer.tsx` (312-344). Typecheck and build it too.

- [ ] **Step 1:** Implement.
- [ ] **Step 2:** `npx tsc -p tsconfig.app.json --noEmit`, the `.check.ts` runner and `npx vite build` all pass.
- [ ] **Step 3: Screenshots** with the **bridge-eyes** skill, from a scratch dashboard server in this worktree on a scratch `BRIDGE_DB` (never the live one), with profiles and an agent account seeded. Capture:
  - Settings ▸ Accounts ▸ AGENTS;
  - the profile editor with an agent selected;
  - the composer showing an agent profile.

  Save the PNGs under `.mystical/probe/` and report their paths.
- [ ] **Step 4: Commit** `feat(dashboard): AGENTS settings, agent-aware profile editor and composer` (explicit paths).

### Task 12: Live verification against real CLIs

**Files:**
- Create: `tests/fixtures/acp/opencode-probe.json` (recorded probe result, trimmed)
- Create: `tests/test_acp_fixture.py`: it asserts that `acp_agents._shape()` of the recorded options yields non-empty model and mode lists. This is the drift guard: a re-record after an opencode upgrade that breaks it fails here.
- Modify: `bridge/acp_agents.py`, only if verification shows a preset's command or env is wrong, with a comment citing what was checked.

Steps:
- [ ] **Step 1: Check opencode.**
  - `opencode --version`, then run `acp.probe` for the opencode preset from a scratch script (`BRIDGE_DB=/tmp/wt-acp.db python3 - <<'EOF' … EOF`).
  - Record the result, then run one real prompt through `acp.run_turn` with a FakeJob-like recorder in a scratch git dir (`mktemp -d`; `git init`), prompt "Create hello.txt containing hi".
  - Expected:
    - a permission card appears, because `OPENCODE_PERMISSION` asks for edits;
    - answering allow creates the file;
    - the turn ends `done`.
  - If opencode has no usable model provider configured, report that and stop after the probe; don't configure providers yourself.
  - Verify `OPENCODE_PERMISSION` is honoured. If it isn't, find the right mechanism in opencode's docs or source and fix the preset.
- [ ] **Step 2: Check the Codex adapter.**
  - `npm view @agentclientprotocol/codex-acp@2.1.1 bin dependencies` and its README.
  - Confirm whether it needs `codex` on PATH or bundles OpenAI's binary, and set `install`/`login` to match.
  - Do not log in to anything.
- [ ] **Step 3: Check Gemini.** Confirm from the docs that the ACP flag is `--acp` in the current release (research says 0.63.0). Gemini isn't installed; don't install it.
- [ ] **Step 4:** Save the fixture and the test, run the full suite, and commit `test(acp): recorded opencode probe as a drift guard; presets verified against the real CLIs`.

### Final: Whole-branch review

- [ ] Full suite green, both web apps typecheck and build.
- [ ] `grep -rn "freeagent" bridge tests` is empty; `pgrep -f fake_acp_agent` is empty after the suite.
- [ ] Dispatch a final code reviewer over `git diff master...feat/agent-profiles`, using the spec, this plan's Global Constraints and Review Focus as the checklist.
- [ ] Report to the user:
  - what was built and the screenshots (via `mcp__verify__Attach`);
  - what is live: nothing until merge + rebuild + restart, per the **bridge-ship** skill;
  - what needs their decision: merge into master locally, and when to restart.
