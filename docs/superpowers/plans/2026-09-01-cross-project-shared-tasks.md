# Cross-project shared tasks — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When work in one repo requires a change in another, the model starts a
session in that other repo itself, and the two sessions read and write one shared
task.

**Architecture:** A `tasks` table plus a `sessions.task_id` column make the link.
`bridge/tasks.py` holds the rules with no transport in them. `bridge/task_mcp.py`
is a stdio MCP server shipped into every session alongside `goals` and `verify`;
its `Delegate` tool POSTs `/local/tasks/delegate` on the dashboard because run
slots and the Telegram notifier only exist in the bridge process. Turn ends nudge
the sibling session through the existing per-session queue, under a per-task
budget so the two cannot wake each other forever.

**Tech Stack:** Python 3 standard library only (no framework, no ORM, no async).
SQLite through `bridge/store.py`. React + TypeScript for the two frontends.
pytest for tests.

**Spec:** `docs/superpowers/specs/2026-09-01-cross-project-shared-tasks-design.md`

## Global Constraints

- **Python stdlib only** on the backend. No new dependency, in any task.
- **Work in a worktree.** This adds a table; follow the `bridge-worktree` skill so
  the new schema never lands in the live `~/.bridge_state` DB while the running
  bridge holds an older code snapshot.
- **Never restart the bridge from inside a bridge session** — you share its
  systemd cgroup and would kill your own turn. Nothing in this plan is live until
  a restart done the `bridge-ship` way; do not claim otherwise.
- **Tests:** `python3 -m pytest tests/ -q` — 1007+ passing, fully green. Anything
  red is your change. Never add env setup to a test module's preamble; it goes in
  `tests/conftest.py`, above the first bridge import.
- **Module docstrings carry the design rationale** (the *why not* as much as the
  what). Write one for each new module.
- **`ponytail:` comments** mark a deliberate shortcut and name its ceiling.
- `MAX_POKES = 6`, `store.MAX_NOTES = 50`, note text capped at 500 chars, task
  title capped at 60 chars — exact values, used verbatim across tasks.
- Do not touch the working tree's existing uncommitted changes (DOCS tab rename,
  `SessionsPanel.tsx`, `theme.ts`). If they are still uncommitted when Task 7
  starts, rebase onto them rather than reverting them.

---

### Task 1: The task row and its store functions

**Files:**
- Modify: `bridge/store.py` (schema ~line 100, migration in `init()` ~line 152, new functions after `set_goal` ~line 641)
- Test: `tests/test_tasks.py` (create)

**Interfaces:**
- Consumes: nothing.
- Produces: `store.create_task(title) -> dict`, `store.get_task(id) -> dict | None`
  (with `notes` already parsed to a list), `store.task_members(id) -> list[dict]`,
  `store.join_task(session_id, task_id) -> None`,
  `store.add_note(task_id, note: dict) -> None`,
  `store.spend_poke(task_id, cap: int) -> bool`, `store.MAX_NOTES = 50`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_tasks.py`:

```python
"""Cross-project shared tasks: the store row, the rules, the poke budget."""

import json

from bridge import store

store.init()


def _session(project="/one"):
    return store.create_session(555, project, origin="dashboard")["id"]


def test_task_roundtrip_and_membership():
    a, b = _session("/one"), _session("/two")
    t = store.create_task("rename the field")
    store.join_task(a, t["id"])
    store.join_task(b, t["id"])
    got = store.get_task(t["id"])
    assert got["title"] == "rename the field"
    assert got["notes"] == [] and got["pokes"] == 0
    assert {m["id"] for m in store.task_members(t["id"])} == {a, b}
    assert store.get_session(a)["task_id"] == t["id"]


def test_get_task_missing_is_none():
    assert store.get_task("nope") is None


def test_notes_append_from_both_sides_and_cap():
    a, b = _session("/one"), _session("/two")
    t = store.create_task("two writers")
    store.join_task(a, t["id"])
    store.join_task(b, t["id"])
    store.add_note(t["id"], {"session": a, "project": "/one", "ts": 1, "text": "from a"})
    store.add_note(t["id"], {"session": b, "project": "/two", "ts": 2, "text": "from b"})
    notes = store.get_task(t["id"])["notes"]
    assert [n["text"] for n in notes] == ["from a", "from b"]
    for i in range(store.MAX_NOTES + 5):
        store.add_note(t["id"], {"session": a, "project": "/one", "ts": i, "text": f"n{i}"})
    notes = store.get_task(t["id"])["notes"]
    assert len(notes) == store.MAX_NOTES
    assert notes[-1]["text"] == f"n{store.MAX_NOTES + 4}"   # newest kept


def test_add_note_on_missing_task_is_a_noop():
    store.add_note("nope", {"session": "x", "project": "/one", "ts": 1, "text": "hi"})


def test_poke_budget_runs_out():
    t = store.create_task("budget")
    assert [store.spend_poke(t["id"], 3) for _ in range(4)] == [True, True, True, False]
    assert store.get_task(t["id"])["pokes"] == 3
    assert store.spend_poke("nope", 3) is False
```

- [ ] **Step 2: Run it and watch it fail**

Run: `python3 -m pytest tests/test_tasks.py -q`
Expected: FAIL — `AttributeError: module 'bridge.store' has no attribute 'create_task'`.

- [ ] **Step 3: Add the table to `_SCHEMA`**

In `bridge/store.py`, append to the `_SCHEMA` string (after the `events` table,
before the closing `"""`):

```sql
-- One piece of work spanning two repos (bridge/tasks.py). Membership is the
-- sessions.task_id column, not a join table: a session belongs to at most one.
CREATE TABLE IF NOT EXISTS tasks (
  id      TEXT PRIMARY KEY,
  title   TEXT NOT NULL,
  created REAL NOT NULL,
  notes   TEXT NOT NULL DEFAULT '[]',
  pokes   INTEGER NOT NULL DEFAULT 0
);
```

- [ ] **Step 4: Add the column migration**

In `init()`, after the `autocompact` block and before the `work_cwd` one, add:

```python
        # The shared task this session is part of (bridge/tasks.py); NULL = none.
        # Deliberately migration-only rather than also in _SCHEMA: the index below
        # would then run against a column an old DB has not gained yet.
        if "task_id" not in scols:
            c.execute("ALTER TABLE sessions ADD COLUMN task_id TEXT")
        c.execute("CREATE INDEX IF NOT EXISTS ix_sessions_task ON sessions(task_id)")
```

- [ ] **Step 5: Add the store functions**

In `bridge/store.py`, after `set_goal` (~line 641):

```python
MAX_NOTES = 50          # the scratchpad is a working surface, not an archive


def create_task(title: str) -> dict:
    """A shared task: one piece of work, two sessions, two repos."""
    tid = "t" + uuid.uuid4().hex[:10]
    now = time.time()
    with closing(_connect()) as c:
        c.execute("INSERT INTO tasks (id, title, created) VALUES (?,?,?)",
                  (tid, title, now))
    return {"id": tid, "title": title, "created": now, "notes": [], "pokes": 0}


def get_task(task_id: str) -> dict | None:
    """The task with its notes already parsed, or None."""
    with closing(_connect()) as c:
        row = _row(c.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone())
    if row is not None:
        try:
            row["notes"] = json.loads(row["notes"] or "[]")
        except ValueError:
            row["notes"] = []
    return row


def task_members(task_id: str) -> list[dict]:
    """Every session on this task, oldest first (the delegator leads)."""
    with closing(_connect()) as c:
        return [_row(r) for r in c.execute(
            "SELECT * FROM sessions WHERE task_id=? ORDER BY created", (task_id,))]


def join_task(session_id: str, task_id: str | None) -> None:
    with closing(_connect()) as c:
        c.execute("UPDATE sessions SET task_id=? WHERE id=?", (task_id, session_id))


def add_note(task_id: str, note: dict) -> None:
    """Append to the shared scratchpad, keeping the newest MAX_NOTES.

    BEGIN IMMEDIATE because this is a read-modify-write of one JSON column and
    the two sessions on a task write to it concurrently by design — the same
    reason event-sequence allocation takes the write lock up front."""
    with closing(_connect()) as c:
        c.execute("BEGIN IMMEDIATE")
        try:
            row = c.execute("SELECT notes FROM tasks WHERE id=?",
                            (task_id,)).fetchone()
            if row is None:
                c.execute("ROLLBACK")
                return
            try:
                notes = json.loads(row["notes"] or "[]")
            except ValueError:
                notes = []
            notes = (notes + [note])[-MAX_NOTES:]
            c.execute("UPDATE tasks SET notes=? WHERE id=?",
                      (json.dumps(notes), task_id))
            c.execute("COMMIT")
        except Exception:
            c.execute("ROLLBACK")
            raise


def spend_poke(task_id: str, cap: int) -> bool:
    """Claim one nudge from the task's budget. False once it is spent — the cap
    is passed in so this module never imports the rules module back."""
    with closing(_connect()) as c:
        c.execute("BEGIN IMMEDIATE")
        row = c.execute("SELECT pokes FROM tasks WHERE id=?", (task_id,)).fetchone()
        if row is None or row["pokes"] >= cap:
            c.execute("ROLLBACK")
            return False
        c.execute("UPDATE tasks SET pokes=pokes+1 WHERE id=?", (task_id,))
        c.execute("COMMIT")
        return True
```

- [ ] **Step 6: Run the tests**

Run: `python3 -m pytest tests/test_tasks.py -q`
Expected: 5 passed.

- [ ] **Step 7: Run the whole suite — the schema change touches every session row**

Run: `python3 -m pytest tests/ -q`
Expected: everything that passed before still passes.

- [ ] **Step 8: Commit**

```bash
git add bridge/store.py tests/test_tasks.py
git commit -m "feat(tasks): a task row two sessions can share"
```

---

### Task 2: `bridge/tasks.py` — the rules

**Files:**
- Create: `bridge/tasks.py`
- Test: `tests/test_tasks.py` (append)

**Interfaces:**
- Consumes: every `store` function from Task 1.
- Produces: `tasks.MAX_POKES = 6`, `tasks.HANDOFF` (format string with
  `{title} {project} {sid} {prompt}`), `tasks.POKE` (format string with
  `{project} {title} {note}`), `tasks.resolve_project(name) -> str | list[str]`,
  `tasks.task_of(session_id) -> dict | None`,
  `tasks.ensure_task(session_id, title) -> dict`,
  `tasks.note(session_id, text) -> bool`,
  `tasks.view(task_id, session_id="") -> dict | None`,
  `tasks.status(session_id) -> dict | None`,
  `tasks.brief(task_id) -> dict | None`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_tasks.py`:

```python
from bridge import config, tasks   # noqa: E402  (after store.init above)


def test_resolve_project_prefers_exact_then_basename_then_substring(monkeypatch):
    monkeypatch.setattr(tasks.browser, "list_projects",
                        lambda: ["/apex", "/apex-web", "/work/apex"])
    assert tasks.resolve_project("/apex") == "/apex"          # exact rel wins
    assert tasks.resolve_project("apex-web") == "/apex-web"   # exact basename
    assert tasks.resolve_project("apex") == ["/apex", "/work/apex"]  # ambiguous
    assert tasks.resolve_project("nothing") == []
    assert tasks.resolve_project("") == []


def test_resolve_project_substring_only_when_unique(monkeypatch):
    monkeypatch.setattr(tasks.browser, "list_projects", lambda: ["/mystical", "/other"])
    assert tasks.resolve_project("myst") == "/mystical"


def test_ensure_task_is_idempotent_per_session():
    a = _session("/one")
    t1 = tasks.ensure_task(a, "one task")
    t2 = tasks.ensure_task(a, "a different title")
    assert t1["id"] == t2["id"]            # already in one, keep it
    assert t2["title"] == "one task"


def test_note_writes_only_for_a_session_in_a_task():
    a, b = _session("/one"), _session("/two")
    assert tasks.note(a, "before there is a task") is False
    t = tasks.ensure_task(a, "shared")
    store.join_task(b, t["id"])
    assert tasks.note(a, "  api returns a list now  ") is True
    assert tasks.note(b, "") is False       # empty text writes nothing
    notes = store.get_task(t["id"])["notes"]
    assert len(notes) == 1
    assert notes[0]["text"] == "api returns a list now"
    assert notes[0]["session"] == a and notes[0]["project"] == "/one"


def test_status_shows_both_members_and_marks_self():
    a, b = _session("/one"), _session("/two")
    t = tasks.ensure_task(a, "shared")
    store.join_task(b, t["id"])
    st = tasks.status(a)
    assert st["title"] == "shared" and st["max_pokes"] == tasks.MAX_POKES
    assert [m["self"] for m in st["members"]] == [True, False]
    assert {m["project"] for m in st["members"]} == {"/one", "/two"}
    assert tasks.status(_session("/three")) is None


def test_brief_is_the_row_payload():
    a, b = _session("/one"), _session("/two")
    t = tasks.ensure_task(a, "shared")
    store.join_task(b, t["id"])
    br = tasks.brief(t["id"])
    assert br["title"] == "shared"
    assert [m["project"] for m in br["members"]] == ["/one", "/two"]
    assert tasks.brief("nope") is None
```

- [ ] **Step 2: Run them and watch them fail**

Run: `python3 -m pytest tests/test_tasks.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'bridge.tasks'`.

- [ ] **Step 3: Write the module**

Create `bridge/tasks.py`:

```python
"""Cross-project shared tasks: one piece of work, two repos, two sessions.

The rules live here with no HTTP and no MCP in them, so they are testable
directly -- the split goals.py / goal_mcp.py already uses. The tool surface is
bridge/task_mcp.py; the half that needs the bridge process (a run slot, the
Telegram notifier) is the dashboard's /local/tasks/delegate, because an MCP
server is a separate process and neither of those exists inside it.

Ambiguity is never resolved by guessing. A wrong project match starts a session
in the wrong repo and spends real money there, so resolve_project returns the
candidates and lets the model choose.

MAX_POKES is the brake. The two sessions nudge each other when a turn ends;
without a cap that is a loop with no human in it, so a task gets six nudges in
total and then goes quiet while staying fully readable -- the shape, and the
reason, of goals.MAX_ITER.
"""

import time

from bridge import browser, state, store

MAX_POKES = 6
NOTE_MAX = 500           # a note is a hint to the other side, not a report

HANDOFF = (
    "[shared task: {title}]\n"
    "Started from {project}, session {sid}. Call TaskStatus() to see the other "
    "side's progress, and TaskNote(...) when you learn something it needs.\n\n"
    "{prompt}"
)

POKE = (
    "[task] {project} finished a turn on the shared task \"{title}\".{note}\n"
    "Call TaskStatus() to see where it got to before you continue."
)


def resolve_project(name: str) -> "str | list[str]":
    """A project rel path for `name`, or every candidate when it is ambiguous.

    Exact rel, then exact basename, then case-insensitive substring; the first
    stage with exactly one hit wins. An empty list means nothing matched."""
    name = (name or "").strip()
    if not name:
        return []
    projects = browser.list_projects()
    if name in projects:
        return name
    bare = name.strip("/").lower()
    exact = [p for p in projects if p.rsplit("/", 1)[-1].lower() == bare]
    if len(exact) == 1:
        return exact[0]
    if exact:
        return exact
    part = [p for p in projects if bare in p.lower()]
    return part[0] if len(part) == 1 else part


def task_of(session_id: str) -> "dict | None":
    """The task this session belongs to, or None."""
    s = store.get_session(session_id) if session_id else None
    tid = (s or {}).get("task_id")
    return store.get_task(tid) if tid else None


def ensure_task(session_id: str, title: str) -> dict:
    """This session's task, creating and joining one when it has none. A session
    already in a task keeps it: delegating twice widens one task rather than
    starting a second one nobody can see the whole of."""
    t = task_of(session_id)
    if t:
        return t
    t = store.create_task(" ".join((title or "shared task").split())[:60])
    store.join_task(session_id, t["id"])
    return t


def note(session_id: str, text: str) -> bool:
    """Append a note the other sessions will read. False = nothing written."""
    text = " ".join((text or "").split())[:NOTE_MAX]
    t = task_of(session_id)
    if not t or not text:
        return False
    s = store.get_session(session_id) or {}
    store.add_note(t["id"], {"session": session_id, "project": s.get("project", ""),
                             "ts": time.time(), "text": text})
    return True


def view(task_id: str, session_id: str = "") -> "dict | None":
    """The whole task: members with their live run state, and the scratchpad."""
    t = store.get_task(task_id)
    if not t:
        return None
    return {
        "id": t["id"], "title": t["title"], "created": t["created"],
        "notes": t["notes"], "pokes": t["pokes"], "max_pokes": MAX_POKES,
        "members": [{"id": m["id"], "project": m["project"],
                     "title": m.get("title") or "",
                     "running": state.is_running(m["id"]),
                     "self": m["id"] == session_id}
                    for m in store.task_members(task_id)],
    }


def status(session_id: str) -> "dict | None":
    """view() for the caller's own task."""
    t = task_of(session_id)
    return view(t["id"], session_id) if t else None


def brief(task_id: str) -> "dict | None":
    """What a session row shows: the task and who else is in it."""
    t = store.get_task(task_id)
    if not t:
        return None
    return {"id": t["id"], "title": t["title"],
            "members": [{"id": m["id"], "project": m["project"]}
                        for m in store.task_members(task_id)]}
```

- [ ] **Step 4: Run the tests**

Run: `python3 -m pytest tests/test_tasks.py -q`
Expected: all pass (11 tests).

- [ ] **Step 5: Commit**

```bash
git add bridge/tasks.py tests/test_tasks.py
git commit -m "feat(tasks): resolve, join, note, and read a shared task"
```

---

### Task 3: The delegate endpoint and the ⇄ ping

**Files:**
- Modify: `bridge/runner.py` (add `notify_delegated` after `notify_turn_done`, ~line 1040)
- Modify: `bridge/dashboard/server.py` (import `tasks`; `POST /local/tasks/delegate` next to `/local/run` ~line 690; `GET /local/tasks/<id>` next to the other GETs ~line 340; new `_delegate` method next to `_run` ~line 1361)
- Test: `tests/test_task_delegate.py` (create)

**Interfaces:**
- Consumes: `tasks.resolve_project`, `tasks.ensure_task`, `tasks.HANDOFF`,
  `tasks.view`, `store.create_session`, `store.join_task`.
- Produces: `POST /local/tasks/delegate {from_session, project, task, prompt}` →
  `{task: {id, title}, session: <brief>, started: bool}` or
  `{error, candidates?}`; `GET /local/tasks/<id>` → `tasks.view(id)`;
  `runner.notify_delegated(chat_id, session_id, project, title)`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_task_delegate.py`:

```python
"""The delegate endpoint: one session asks for a linked session in another repo."""

import os

from bridge import config, runner, store, tasks
from bridge.dashboard import server as dash

store.init()


class _Handler:
    """Just enough of the request handler to call the method under test."""

    def __init__(self):
        self.sent = None

    def _json(self, payload, code=200):
        self.sent = (code, payload)
        return payload


def _project(name):
    """A real directory under BASE_PATH, so _abs_project resolves it."""
    p = os.path.join(config.BASE_PATH, name)
    os.makedirs(p, exist_ok=True)
    return "/" + name


def _setup(monkeypatch, projects):
    monkeypatch.setattr(tasks.browser, "list_projects", lambda: projects)
    started = []
    monkeypatch.setattr(runner, "start_streaming_job",
                        lambda *a, **k: started.append(k) or type("J", (), {"id": "j1"})())
    monkeypatch.setattr(runner, "notify_delegated",
                        lambda *a: started.append(("notified", a)))
    return started


def test_delegate_creates_a_linked_session_in_the_other_project(monkeypatch):
    one, two = _project("one"), _project("two")
    started = _setup(monkeypatch, [one, two])
    src = store.create_session(555, one, origin="dashboard")
    out = dash.Handler._delegate(_Handler(), 555, {
        "from_session": src["id"], "project": "two",
        "task": "rename the field", "prompt": "the API returns a list now"})
    assert out["task"]["title"] == "rename the field"
    assert out["session"]["project"] == two
    assert out["started"] is True
    # Both sessions are on one task.
    tid = store.get_session(src["id"])["task_id"]
    assert tid and store.get_session(out["session"]["id"])["task_id"] == tid
    # The handoff prompt carries the shared context the other side cannot see.
    prompt = started[0]["prompt"] if isinstance(started[0], dict) else ""
    assert "[shared task: rename the field]" in prompt
    assert "TaskStatus()" in prompt and "the API returns a list now" in prompt
    assert any(isinstance(s, tuple) and s[0] == "notified" for s in started)


def test_ambiguous_project_creates_nothing(monkeypatch):
    one = _project("one")
    _project("apex")
    _project("apex-two")
    started = _setup(monkeypatch, [one, "/apex", "/apex-two"])
    src = store.create_session(555, one, origin="dashboard")
    h = _Handler()
    dash.Handler._delegate(h, 555, {"from_session": src["id"], "project": "apex",
                                    "task": "t", "prompt": "p"})
    code, payload = h.sent
    assert code == 400 and payload["candidates"] == ["/apex", "/apex-two"]
    assert started == []
    assert store.get_session(src["id"])["task_id"] is None


def test_unknown_project_and_missing_fields_create_nothing(monkeypatch):
    one = _project("one")
    started = _setup(monkeypatch, [one])
    src = store.create_session(555, one, origin="dashboard")
    for body in ({"from_session": src["id"], "project": "ghost", "task": "t", "prompt": "p"},
                 {"from_session": src["id"], "project": "one", "task": "", "prompt": "p"},
                 {"from_session": src["id"], "project": "one", "task": "t", "prompt": ""},
                 {"from_session": "nope", "project": "one", "task": "t", "prompt": "p"}):
        h = _Handler()
        dash.Handler._delegate(h, 555, body)
        assert h.sent[0] in (400, 404), body
    assert started == []


def test_delegating_into_the_same_project_is_refused(monkeypatch):
    one = _project("one")
    started = _setup(monkeypatch, [one])
    src = store.create_session(555, one, origin="dashboard")
    h = _Handler()
    dash.Handler._delegate(h, 555, {"from_session": src["id"], "project": "one",
                                    "task": "t", "prompt": "p"})
    assert h.sent[0] == 400 and started == []


def test_a_session_from_another_chat_is_not_delegable(monkeypatch):
    one, two = _project("one"), _project("two")
    _setup(monkeypatch, [one, two])
    src = store.create_session(999, one, origin="dashboard")
    h = _Handler()
    dash.Handler._delegate(h, 555, {"from_session": src["id"], "project": "two",
                                    "task": "t", "prompt": "p"})
    assert h.sent[0] == 404
```

- [ ] **Step 2: Run it and watch it fail**

Run: `python3 -m pytest tests/test_task_delegate.py -q`
Expected: FAIL — `AttributeError: type object 'Handler' has no attribute '_delegate'`.

- [ ] **Step 3: Add the notification**

In `bridge/runner.py`, immediately after `notify_turn_done`:

```python
def notify_delegated(chat_id: int | None, session_id: str | None, project: str,
                     title: str) -> None:
    """Ping when a session appears in a repo you did not open yourself. The whole
    point of delegating automatically is that you are not watching, so the start
    is announced even though nothing has gone wrong."""
    _notify(chat_id, f"⇄ {project} — {title} — linked session started",
            _session_kb(chat_id, session_id, "🛠 Open session"))
```

- [ ] **Step 4: Add the endpoint**

In `bridge/dashboard/server.py`, add `tasks` to the `from bridge import ...` list
at the top. Then in the POST router, next to `/local/run`:

```python
        if path == "/local/tasks/delegate":
            return self._delegate(chat, body)
```

In the GET router, next to the other `/local/...` GETs:

```python
        if path.startswith("/local/tasks/"):
            view = tasks.view(path[len("/local/tasks/"):])
            return self._json(view or {"error": "not found"}, 200 if view else 404)
```

And the method, next to `_run`:

```python
    def _delegate(self, chat, body):
        """A session asks for a linked session in another repo.

        Everything that needs the bridge process lives on this side — the run
        slot, the notifier — so bridge/task_mcp.py only relays. Nothing is
        created unless the project resolves to exactly one repo: a wrong guess
        starts work in the wrong codebase."""
        src = store.get_session((body.get("from_session") or "").strip())
        if not src or src["chat_id"] != chat:
            return self._json({"error": "unknown session"}, 404)
        title = " ".join((body.get("task") or "").split())[:60]
        prompt = (body.get("prompt") or "").strip()
        if not title or not prompt:
            return self._json({"error": "task and prompt are both required"}, 400)
        hit = tasks.resolve_project(body.get("project") or "")
        if isinstance(hit, list):
            return self._json({"error": "no single project matches",
                               "candidates": hit[:8]}, 400)
        if hit == src["project"]:
            return self._json({"error": "that is this session's own project"}, 400)
        abs_p = _abs_project(hit)
        if abs_p is None:
            return self._json({"error": "invalid project"}, 400)
        task = tasks.ensure_task(src["id"], title)
        s = store.create_session(chat, hit, origin="delegate", cwd=abs_p,
                                 permission_mode=src.get("permission_mode")
                                 or config.NEW_SESSION_PERMISSION_MODE)
        store.join_task(s["id"], task["id"])
        s = _pre_title(s, title)
        job = runner.start_streaming_job(
            chat, tasks.HANDOFF.format(title=task["title"], project=src["project"],
                                       sid=src["id"], prompt=prompt),
            [], abs_p, session_id=s["id"], origin="delegate")
        runner.notify_delegated(chat, s["id"], hit, task["title"])
        return self._json({"task": {"id": task["id"], "title": task["title"]},
                           "session": _session_brief(store.get_session(s["id"])),
                           "started": job is not None})
```

The delegated session inherits the caller's permission mode: a session you
trusted to edit code should not spawn one that stops for every approval, and it
must not spawn one *more* trusted than itself either.

- [ ] **Step 5: Run the tests**

Run: `python3 -m pytest tests/test_task_delegate.py -q`
Expected: 5 passed.

- [ ] **Step 6: Run the whole suite**

Run: `python3 -m pytest tests/ -q`
Expected: green.

- [ ] **Step 7: Commit**

```bash
git add bridge/runner.py bridge/dashboard/server.py tests/test_task_delegate.py
git commit -m "feat(tasks): /local/tasks/delegate starts the linked session"
```

---

### Task 4: The MCP tools

**Files:**
- Create: `bridge/task_mcp.py`
- Modify: `bridge/runner.py:218-222` (register the server in `_mcp_config`)
- Test: `tests/test_task_mcp.py` (create)

**Interfaces:**
- Consumes: `tasks.status`, `tasks.note`, `tasks.MAX_POKES`; the endpoint from
  Task 3.
- Produces: `task_mcp._TOOLS` (three entries: `Delegate`, `TaskStatus`,
  `TaskNote`), `task_mcp._call(name, args) -> str`, `task_mcp._handle(req)`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_task_mcp.py`:

```python
"""The task tools: what the model can call, and what it is told back."""

import json
import os
import urllib.request

from bridge import store, task_mcp, tasks

store.init()


class _Resp:
    def __init__(self, payload, code=200):
        self._b = json.dumps(payload).encode()
        self.status = code

    def read(self, *a):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def _bind(session_id, monkeypatch):
    """Point the server at a session the way the runner's env does."""
    s = store.get_session(session_id)
    store.set_claude_session_id(session_id, "csid-" + session_id)
    monkeypatch.setenv("MYSTICAL_CLAUDE_SESSION_ID", "csid-" + session_id)
    return s


def test_tools_are_the_three_we_ship():
    assert [t["name"] for t in task_mcp._TOOLS] == ["Delegate", "TaskStatus", "TaskNote"]
    # The description is where the automatic behaviour lives.
    assert "another repo" in task_mcp._TOOLS[0]["description"]


def test_delegate_posts_to_the_dashboard(monkeypatch):
    src = store.create_session(555, "/one", origin="dashboard")
    _bind(src["id"], monkeypatch)
    monkeypatch.setenv("MYSTICAL_DASH", "http://127.0.0.1:8790")
    monkeypatch.setenv("MYSTICAL_DASH_TOKEN", "sekrit")
    seen = {}

    def fake_urlopen(req, timeout=None):
        seen["url"] = req.full_url
        seen["body"] = json.loads(req.data)
        seen["token"] = req.get_header("X-dash-token")
        return _Resp({"task": {"id": "t1", "title": "rename"},
                      "session": {"id": "s2", "project": "/two"}, "started": True})

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    out = task_mcp._call("Delegate", {"project": "two", "task": "rename",
                                      "prompt": "update the client"})
    assert seen["url"] == "http://127.0.0.1:8790/local/tasks/delegate"
    assert seen["token"] == "sekrit"
    assert seen["body"] == {"from_session": src["id"], "project": "two",
                            "task": "rename", "prompt": "update the client"}
    assert "/two" in out and "rename" in out


def test_delegate_relays_the_candidates_without_creating_anything(monkeypatch):
    src = store.create_session(555, "/one", origin="dashboard")
    _bind(src["id"], monkeypatch)
    monkeypatch.setenv("MYSTICAL_DASH", "http://127.0.0.1:8790")

    def fake_urlopen(req, timeout=None):
        return _Resp({"error": "no single project matches",
                      "candidates": ["/apex", "/apex-two"]}, 400)

    monkeypatch.setattr(urllib.request, "urlopen", fake_urlopen)
    out = task_mcp._call("Delegate", {"project": "apex", "task": "t", "prompt": "p"})
    assert "/apex" in out and "/apex-two" in out
    assert store.get_session(src["id"])["task_id"] is None


def test_delegate_without_a_dashboard_says_so(monkeypatch):
    src = store.create_session(555, "/one", origin="dashboard")
    _bind(src["id"], monkeypatch)
    monkeypatch.delenv("MYSTICAL_DASH", raising=False)
    out = task_mcp._call("Delegate", {"project": "two", "task": "t", "prompt": "p"})
    assert "dashboard" in out.lower()


def test_status_and_note_go_straight_to_the_store(monkeypatch):
    a = store.create_session(555, "/one", origin="dashboard")
    b = store.create_session(555, "/two", origin="dashboard")
    _bind(a["id"], monkeypatch)
    assert "not part of a shared task" in task_mcp._call("TaskStatus", {})
    t = tasks.ensure_task(a["id"], "shared")
    store.join_task(b["id"], t["id"])
    assert task_mcp._call("TaskNote", {"text": "api returns a list"}).startswith("Noted")
    out = task_mcp._call("TaskStatus", {})
    assert "shared" in out and "/two" in out and "api returns a list" in out


def test_an_unbound_server_refuses_every_tool(monkeypatch):
    monkeypatch.setenv("MYSTICAL_CLAUDE_SESSION_ID", "")
    for name in ("Delegate", "TaskStatus", "TaskNote"):
        assert "No session" in task_mcp._call(name, {"project": "x", "task": "t",
                                                     "prompt": "p", "text": "n"})


def test_handle_speaks_jsonrpc():
    out = task_mcp._handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    assert [t["name"] for t in out["result"]["tools"]] == ["Delegate", "TaskStatus",
                                                           "TaskNote"]
    assert task_mcp._handle({"jsonrpc": "2.0", "method": "initialized"}) is None
```

- [ ] **Step 2: Run it and watch it fail**

Run: `python3 -m pytest tests/test_task_mcp.py -q`
Expected: FAIL — `ModuleNotFoundError: No module named 'bridge.task_mcp'`.

- [ ] **Step 3: Write the server**

Create `bridge/task_mcp.py`:

```python
"""Stdio MCP server exposing the shared-task tools to the `claude` child process.

Spawned per interactive run via --mcp-config, next to goals and verify, and bound
to its session the same way: MYSTICAL_CLAUDE_SESSION_ID resolves through the
index on that column.

TaskStatus and TaskNote read and write the store directly, as goal_mcp.py does.
Delegate cannot: starting a turn needs a run slot and the Telegram notifier, both
of which live in the bridge process, so it POSTs the dashboard's own localhost
API with the token every browser tab uses -- the callback verify_mcp.py's Run
tool already makes. Without a dashboard there is no delegation, and the tool says
so rather than half-creating a session that will never run.

Stdlib only, line-delimited JSON-RPC 2.0. Nothing is logged to stdout -- that
channel is the protocol.
"""

import json
import os
import sys
import urllib.error
import urllib.request

from bridge import store, tasks

PROTOCOL = "2024-11-05"
TIMEOUT = 30

_TOOLS = [
    {
        "name": "Delegate",
        "description": (
            "Start a linked Claude session in another repo on this machine. Call "
            "this the moment you realise a change here requires a change in "
            "another repo — do not ask the user to open that project themselves. "
            "The new session starts working immediately and shares a task with "
            "this one: both sides can read each other with TaskStatus and leave "
            "notes with TaskNote."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "project": {
                    "type": "string",
                    "description": "The other repo: a path like /apex or just its "
                                   "folder name. Ambiguous names are refused with "
                                   "the candidates listed.",
                },
                "task": {
                    "type": "string",
                    "description": "The one piece of work both sessions serve, in "
                                   "a few words. Shown on both session rows.",
                },
                "prompt": {
                    "type": "string",
                    "description": "The instruction for the other session. Write "
                                   "everything it needs — it cannot see this "
                                   "conversation.",
                },
            },
            "required": ["project", "task", "prompt"],
        },
    },
    {
        "name": "TaskStatus",
        "description": ("Read the shared task: the other sessions on it, whether "
                        "they are running, and every note either side has left."),
        "inputSchema": {"type": "object", "properties": {}},
    },
    {
        "name": "TaskNote",
        "description": ("Leave a note for the other sessions on this task. Use it "
                        "when you learn something the other side needs — a shape "
                        "you chose, a name you changed, something that blocks it."),
        "inputSchema": {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        },
    },
]


def _session_id() -> str:
    """Store session id for the run that spawned us, via the claude session id."""
    csid = os.environ.get("MYSTICAL_CLAUDE_SESSION_ID", "")
    if not csid:
        return ""
    row = store.get_by_claude_session_id(csid)
    return (row or {}).get("id") or ""


def _delegate(sid: str, args: dict) -> str:
    base = os.environ.get("MYSTICAL_DASH")
    if not base:
        return ("The dashboard is not running, so the bridge cannot start a "
                "session elsewhere. Tell the human what needs doing in the other "
                "repo instead.")
    body = json.dumps({"from_session": sid,
                       "project": (args.get("project") or "").strip(),
                       "task": (args.get("task") or "").strip(),
                       "prompt": (args.get("prompt") or "").strip()}).encode()
    req = urllib.request.Request(
        base.rstrip("/") + "/local/tasks/delegate", data=body, method="POST",
        headers={"Content-Type": "application/json",
                 "X-Dash-Token": os.environ.get("MYSTICAL_DASH_TOKEN", "")})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            data = json.load(r)
    except urllib.error.HTTPError as e:                 # 400/404 carry a body
        try:
            data = json.load(e)
        except ValueError:
            return f"The bridge refused the delegation: {e}"
    except (urllib.error.URLError, OSError, ValueError) as e:  # noqa: BLE001
        return f"Could not reach the bridge to delegate: {e}"
    if data.get("candidates"):
        return ("No single project matches. Call Delegate again with one of: "
                + ", ".join(data["candidates"]))
    if data.get("error"):
        return f"Delegation refused: {data['error']}"
    s, t = data.get("session") or {}, data.get("task") or {}
    return (f"Started a linked session in {s.get('project')} on the shared task "
            f"\"{t.get('title')}\". It is working now — call TaskStatus() to see "
            f"how it is doing, and TaskNote(...) to tell it what you learn.")


def _status(sid: str) -> str:
    st = tasks.status(sid)
    if not st:
        return ("This session is not part of a shared task. Delegate(...) starts "
                "one when work here needs a change in another repo.")
    lines = [f"Task: {st['title']}"]
    for m in st["members"]:
        who = "this session" if m["self"] else m["project"]
        lines.append(f"  - {who}: {'running' if m['running'] else 'idle'}"
                     f"{'' if m['self'] else ' — ' + (m['title'] or 'untitled')}")
    if st["notes"]:
        lines.append("Notes:")
        lines += [f"  [{n['project']}] {n['text']}" for n in st["notes"]]
    else:
        lines.append("No notes yet.")
    lines.append(f"Nudges used: {st['pokes']}/{st['max_pokes']}")
    return "\n".join(lines)


def _call(name: str, args: dict) -> str:
    sid = _session_id()
    if not sid:
        return "No session bound to this server; shared tasks are unavailable."
    if name == "Delegate":
        if not (args.get("project") or "").strip():
            return "project is required."
        if not (args.get("prompt") or "").strip() or not (args.get("task") or "").strip():
            return "task and prompt are both required."
        return _delegate(sid, args)
    if name == "TaskStatus":
        return _status(sid)
    if name == "TaskNote":
        if not tasks.note(sid, args.get("text") or ""):
            return ("Nothing written: this session has no shared task, or the "
                    "note was empty.")
        return "Noted — the other sessions on this task will read it."
    return f"Unknown tool: {name}"


def _handle(req: dict) -> "dict | None":
    """One JSON-RPC request in, one response out. None for notifications."""
    method, rid = req.get("method"), req.get("id")
    if method == "initialize":
        result = {"protocolVersion": PROTOCOL,
                  "capabilities": {"tools": {}},
                  "serverInfo": {"name": "mystical-tasks", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": _TOOLS}
    elif method == "tools/call":
        params = req.get("params") or {}
        text = _call(params.get("name") or "", params.get("arguments") or {})
        result = {"content": [{"type": "text", "text": text}]}
    elif rid is None:
        return None                     # notification (e.g. initialized)
    else:
        return {"jsonrpc": "2.0", "id": rid,
                "error": {"code": -32601, "message": f"no method {method}"}}
    return {"jsonrpc": "2.0", "id": rid, "result": result}


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            resp = _handle(json.loads(line))
        except Exception as e:  # noqa: BLE001 — a bad frame must not kill the server
            print(f"[task_mcp] {e}", file=sys.stderr)
            continue
        if resp is not None:
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
```

- [ ] **Step 4: Ship it into every session**

In `bridge/runner.py`'s `_mcp_config`, add a third entry after `verify`:

```python
        "tasks": {"command": sys.executable,
                  "args": ["-m", "bridge.task_mcp"], "env": env},
```

- [ ] **Step 5: Run the tests**

Run: `python3 -m pytest tests/test_task_mcp.py -q`
Expected: 7 passed.

- [ ] **Step 6: Prove the server actually speaks the protocol**

Run:
```bash
printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | PYTHONPATH=. python3 -m bridge.task_mcp
```
Expected: one JSON line listing Delegate, TaskStatus, TaskNote. Nothing else on
stdout.

- [ ] **Step 7: Run the whole suite, then commit**

Run: `python3 -m pytest tests/ -q`

```bash
git add bridge/task_mcp.py bridge/runner.py tests/test_task_mcp.py
git commit -m "feat(tasks): Delegate, TaskStatus and TaskNote"
```

---

### Task 5: The poke when a turn ends

**Files:**
- Modify: `bridge/tasks.py` (add `poke_siblings`)
- Modify: `bridge/tailstate.py:146-148` (`kick` dispatches through a wrapper)
- Test: `tests/test_tasks.py` (append)

**Interfaces:**
- Consumes: `tasks.task_of`, `store.task_members`, `store.spend_poke`,
  `queue_manager.enqueue`.
- Produces: `tasks.poke_siblings(session_id, chat_id) -> int` (how many were
  nudged), `tailstate._run_and_poke(job, cwd)`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/test_tasks.py`:

```python
def test_poke_nudges_the_sibling_not_the_finisher(monkeypatch):
    a, b = _session("/one"), _session("/two")
    t = tasks.ensure_task(a, "shared")
    store.join_task(b, t["id"])
    tasks.note(b, "client already updated")
    sent = []
    monkeypatch.setattr(tasks, "_enqueue", lambda sid, **kw: sent.append((sid, kw)))
    assert tasks.poke_siblings(a, 555) == 1
    assert [sid for sid, _ in sent] == [b]
    text = sent[0][1]["prompt"]
    assert "/one finished a turn" in text and "shared" in text
    assert "client already updated" in text     # the newest note travels with it
    assert "TaskStatus()" in text


def test_poke_is_a_noop_without_a_task_or_a_sibling(monkeypatch):
    sent = []
    monkeypatch.setattr(tasks, "_enqueue", lambda sid, **kw: sent.append(sid))
    lonely = _session("/one")
    assert tasks.poke_siblings(lonely, 555) == 0        # no task
    tasks.ensure_task(lonely, "solo")
    assert tasks.poke_siblings(lonely, 555) == 0        # task of one
    assert tasks.poke_siblings("", 555) == 0
    assert sent == []


def test_poke_stops_at_the_budget(monkeypatch):
    a, b = _session("/one"), _session("/two")
    t = tasks.ensure_task(a, "ping pong")
    store.join_task(b, t["id"])
    sent = []
    monkeypatch.setattr(tasks, "_enqueue", lambda sid, **kw: sent.append(sid))
    # Two sessions waking each other, turn after turn.
    fired = [tasks.poke_siblings(a if i % 2 == 0 else b, 555)
             for i in range(tasks.MAX_POKES + 4)]
    assert sum(fired) == tasks.MAX_POKES
    assert len(sent) == tasks.MAX_POKES
```

- [ ] **Step 2: Run them and watch them fail**

Run: `python3 -m pytest tests/test_tasks.py -q`
Expected: FAIL — `AttributeError: module 'bridge.tasks' has no attribute '_enqueue'`.

- [ ] **Step 3: Add the poke**

Append to `bridge/tasks.py`:

```python
def _enqueue(session_id: str, **kw) -> None:
    """Indirection so a test can watch the nudge without a queue (and so tasks.py
    does not import queue_manager at module scope, which would pull the runner
    into the MCP subprocess)."""
    from bridge import queue_manager
    queue_manager.enqueue(session_id, **kw)


def poke_siblings(session_id: str, chat_id: int) -> int:
    """Nudge the other sessions on this task that a turn just ended. Returns how
    many were nudged; 0 whenever there is no task, no sibling, or no budget left.

    Enqueued rather than started: a sibling mid-turn must not be interrupted, and
    the queue already owns 'run it when the session frees up', along with pause,
    reorder and retry -- the argument goals.py makes for putting its own nudge
    there instead of growing a second scheduler."""
    t = task_of(session_id)
    if not t:
        return 0
    others = [m for m in store.task_members(t["id"]) if m["id"] != session_id]
    if not others:
        return 0
    if not store.spend_poke(t["id"], MAX_POKES):
        return 0
    src = store.get_session(session_id) or {}
    last = t["notes"][-1]["text"] if t["notes"] else ""
    text = POKE.format(project=src.get("project", ""), title=t["title"],
                       note=f" Its last note: {last}" if last else "")
    for m in others:
        _enqueue(m["id"], text=text, prompt=text, images=[], model=None, effort=None,
                 permission_mode=m.get("permission_mode"), width=0, sel=[],
                 surface="task", chat_id=chat_id, project=m.get("cwd") or None)
    return len(others)
```

- [ ] **Step 4: Fire it at every turn end**

In `bridge/tailstate.py`, change `kick` to dispatch through a wrapper and add it
below (leaving `_run` untouched — its early `return` on the needs-you path makes
an inline edit easy to get wrong):

```python
def kick(job, cwd: "str | None" = None) -> None:
    """Classify a finished turn's closing, then ping — in the background, so a
    model call can't hold up the run loop's teardown. Fire-and-forget, like
    bridge/titler.py: it owns the notification either way."""
    threading.Thread(target=_run_and_poke, args=(job, cwd), daemon=True).start()


def _run_and_poke(job, cwd: "str | None") -> None:
    """Notify, then wake this session's shared-task siblings. In a finally so a
    session on a task is nudged even when the closing classifier blew up, and
    guarded so a task problem can never swallow the notification that already
    happened."""
    try:
        _run(job, cwd)
    finally:
        try:
            from bridge import tasks
            tasks.poke_siblings(job.store_session_id, job.chat_id)
        except Exception as e:  # noqa: BLE001 — never raise out of a daemon thread
            print(f"[tailstate] task poke failed: {e}", file=sys.stderr)
```

Add a `ponytail:` note above `poke_siblings` in `tasks.py`:

```python
# ponytail: one nudge per turn end, on the plain end path. A turn that ended
# *asking the user something* also ends here (tailstate._run returns early, the
# finally still fires), so the sibling learns of it. If that ever proves noisy,
# the upgrade is to skip the poke when job.tail_needs is set.
```

- [ ] **Step 5: Run the tests**

Run: `python3 -m pytest tests/test_tasks.py -q`
Expected: 14 passed.

- [ ] **Step 6: Run the whole suite, then commit**

Run: `python3 -m pytest tests/ -q`

```bash
git add bridge/tasks.py bridge/tailstate.py tests/test_tasks.py
git commit -m "feat(tasks): a finished turn wakes the other side, six times at most"
```

---

### Task 6: The task on the session row payload

**Files:**
- Modify: `bridge/miniapp/server.py:141-154` (`_session_brief`)
- Test: `tests/test_tasks.py` (append)

**Interfaces:**
- Consumes: `tasks.brief`.
- Produces: `_session_brief(s)["task"]` — `{id, title, members: [{id, project}]}`
  or `None`. Both frontends read this; the dashboard imports the same function
  (`bridge/dashboard/server.py:40`).

- [ ] **Step 1: Write the failing test**

Append to `tests/test_tasks.py`:

```python
def test_session_brief_carries_the_task():
    from bridge.miniapp.server import _session_brief
    a, b = _session("/one"), _session("/two")
    assert _session_brief(store.get_session(a))["task"] is None
    t = tasks.ensure_task(a, "shared")
    store.join_task(b, t["id"])
    br = _session_brief(store.get_session(a))["task"]
    assert br["id"] == t["id"] and br["title"] == "shared"
    assert [m["project"] for m in br["members"]] == ["/one", "/two"]
```

- [ ] **Step 2: Run it and watch it fail**

Run: `python3 -m pytest tests/test_tasks.py::test_session_brief_carries_the_task -q`
Expected: FAIL — `KeyError: 'task'`.

- [ ] **Step 3: Add the field**

In `bridge/miniapp/server.py`, add `tasks` to the bridge imports and one line to
the returned dict, next to `"goal"`:

```python
            # ponytail: one extra indexed read, and only for a row that is
            # actually linked — linked rows are rare. If a list of hundreds ever
            # shows a lag, fold it into the list query as a join.
            "task": tasks.brief(s["task_id"]) if s.get("task_id") else None,
```

- [ ] **Step 4: Run the tests, then commit**

Run: `python3 -m pytest tests/ -q`

```bash
git add bridge/miniapp/server.py tests/test_tasks.py
git commit -m "feat(tasks): session rows carry their shared task"
```

---

### Task 7: The ⇄ chip in the dashboard

**Files:**
- Modify: `bridge/dashboard/web/src/api.ts` (the `Session` type)
- Modify: `bridge/dashboard/web/src/components/hud/SessionsPanel.tsx` (row meta line ~line 204-232; list filtering)

**Interfaces:**
- Consumes: `session.task` from Task 6.
- Produces: nothing other tasks read.

- [ ] **Step 1: Type the field**

In `bridge/dashboard/web/src/api.ts`, add to the `Session` type, next to `goal`:

```ts
  task?: { id: string; title: string; members: { id: string; project: string }[] } | null;
```

- [ ] **Step 2: Render the chip**

In `SessionsPanel.tsx`'s row, inside the meta line and after the `s.goal` chip,
add (matching the neighbouring chips' style exactly — flex none, `var(--t9)`):

```tsx
            {s.task && (
              <span
                title={`shared task: ${s.task.title} — ${s.task.members
                  .map((m) => projectName(m.project)).join(" ⇄ ")}`}
                onClick={(e) => { e.stopPropagation(); onTask?.(s.task!.id); }}
                style={{ flex: "none", fontSize: "var(--t9)", cursor: "pointer",
                         color: "var(--purple)" }}
              >
                ⇄ {s.task.members.filter((m) => m.id !== s.id)
                    .map((m) => projectName(m.project)).join(" ")}
              </span>
            )}
```

Add `onTask?: (taskId: string) => void;` to the row component's props and thread
it from the panel, next to the existing `onPin` / `onAttach` props. Include
`!!s.task` in the `metaShow` condition so a row whose only meta is the task still
renders the line.

- [ ] **Step 3: Filter to the task when the chip is tapped**

In the panel body, next to the other filter state:

```tsx
  const [taskFilter, setTaskFilter] = useState("");
```

Apply it where rows are filtered, and clear it when the mode/project changes:

```tsx
  const shown = taskFilter ? rows.filter((s) => s.task?.id === taskFilter) : rows;
```

Above the list, when `taskFilter` is set, render one clear-it line in the same
voice as the panel's other headers:

```tsx
  {taskFilter && (
    <button onClick={() => setTaskFilter("")}
            style={{ background: "none", border: "none", cursor: "pointer",
                     font: "inherit", fontSize: "var(--t95)", color: "var(--purple)",
                     padding: "4px 8px", textAlign: "left" }}>
      ⇄ shared task — showing both sides · tap to clear
    </button>
  )}
```

Pass `onTask={setTaskFilter}` down to the row.

- [ ] **Step 4: Typecheck and build**

Run from `bridge/dashboard/web`:
```bash
npx tsc -p tsconfig.app.json --noEmit && npm run build
```
Expected: no errors. (`tsc -p .` checks nothing here — use `tsconfig.app.json`.)

- [ ] **Step 5: Look at it**

Use the **bridge-eyes** skill to screenshot the sessions panel with a linked pair
in the DB, and **send the screenshot to the user** — do not just view it yourself.
Expected: the ⇄ chip sits on the meta line with the project name after it, and
tapping it narrows the list to the two linked rows.

- [ ] **Step 6: Commit**

```bash
git add bridge/dashboard/web/src
git commit -m "feat(tasks): a linked row says which repo it is linked to"
```

---

### Task 8: The chip in the Mini App

**Files:**
- Modify: `bridge/miniapp/web/src/` — the session list row and its `Session` type (find with `grep -rn "goal" bridge/miniapp/web/src --include=*.tsx`)

**Interfaces:**
- Consumes: `session.task` from Task 6.
- Produces: nothing.

- [ ] **Step 1: Type the field**

Add the same `task?: {...} | null` field to the Mini App's `Session` type.

- [ ] **Step 2: Render the chip, no filter**

Next to whatever the Mini App row shows for `goal`, add the read-only twin — the
list is short enough that filtering it buys nothing:

```tsx
{s.task && (
  <span title={`shared task: ${s.task.title}`} style={{ color: "var(--purple)" }}>
    ⇄ {s.task.members.filter((m) => m.id !== s.id)
        .map((m) => m.project.split("/").pop()).join(" ")}
  </span>
)}
```

- [ ] **Step 3: Build**

Run from `bridge/miniapp/web`: `npx tsc -p tsconfig.app.json --noEmit && npm run build`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add bridge/miniapp/web/src
git commit -m "feat(tasks): the Mini App shows the link too"
```

---

### Task 9: Make it live and prove it end to end

**Files:** none — this task changes no code.

- [ ] **Step 1: Full suite**

Run: `python3 -m pytest tests/ -q`
Expected: green, with the ~26 new tests included. Report the actual number.

- [ ] **Step 2: Ship it**

Use the **bridge-ship** skill: build the dashboard bundle into the bridge's launch
checkout, then restart the bridge *the way that skill prescribes* (`setsid`, from
outside your own cgroup). A restart from inside a bridge session kills your turn.

- [ ] **Step 3: The real thing, once**

From a session in this repo, ask the model to make a change that needs a second
repo, and confirm, in this order:

1. A Telegram `⇄ <project> — <task> — linked session started` message arrives.
2. The new session exists in the other project, pre-titled with the task, and its
   first turn is running.
3. Both rows show the ⇄ chip; tapping it in the dashboard shows exactly the two.
4. `TaskNote` from one side, then `TaskStatus` from the other, shows the note.
5. When the delegated turn ends, the first session gets a queued `[task]` nudge.

- [ ] **Step 4: Say what is true**

Report what you actually observed, including anything that did not work. Do not
report the feature as working on the strength of the tests alone — the bridge
runs a code snapshot, and until step 2 succeeded none of this was live.

---

## Self-review notes

**Spec coverage:** §1 data → Task 1. §2 rules module → Task 2. §3 tools →
Task 4, with the endpoint they call in Task 3. §4 poke + brake → Task 5.
§5 notification → Task 3 (`notify_delegated`). §6 surfaces → Tasks 6/7/8; the
bot needs nothing beyond §5, per the spec's own correction. §7 testing → the test
files in Tasks 1-6, plus the end-to-end pass in Task 9.

**Names used consistently across tasks:** `store.create_task`, `store.get_task`,
`store.task_members`, `store.join_task`, `store.add_note`, `store.spend_poke`,
`store.MAX_NOTES`, `tasks.MAX_POKES`, `tasks.resolve_project`, `tasks.task_of`,
`tasks.ensure_task`, `tasks.note`, `tasks.view`, `tasks.status`, `tasks.brief`,
`tasks.poke_siblings`, `tasks._enqueue`, `tasks.HANDOFF`, `tasks.POKE`,
`runner.notify_delegated`, `tailstate._run_and_poke`, `_session_brief(...)["task"]`.

**Known soft spot, called out rather than hidden:** the exact prop-threading in
`SessionsPanel.tsx` (Task 7) depends on that file's current shape, which has
uncommitted changes in the working tree. Every other name in this plan was read
out of the source, not remembered.
