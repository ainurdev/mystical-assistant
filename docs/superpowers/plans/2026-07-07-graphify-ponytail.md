# Graphify Map + Ponytail Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every surface a queryable visual map of the active project (graphify) and a per-run code-minimalism dial (ponytail): dashboard MAP tab, Mini App map route, `/map` bot command, ponytail intensity picker, and a graph-structure pack in the system prompt.

**Architecture:** One new best-effort module, `bridge/graphmap.py`, shells out to the `graphify` CLI and parses its `graphify-out/` artifacts. Everything else hangs off existing seams: `runner.py` subprocess construction (env var + `--append-system-prompt`), the two HTTP servers' route tables, `dispatch.py`, and the two React composers. Spec: `docs/superpowers/specs/2026-07-07-graphify-ponytail-features-design.md`.

**Tech Stack:** Python 3 stdlib only (no new deps), pytest, React+TS (vite), graphify CLI 0.9.x (pipx), ponytail 4.8.4 (Claude Code plugin).

## Global Constraints

- **No new Python dependencies.** stdlib + existing bridge modules only.
- **Best-effort posture everywhere** (mirrors `bridge/memory.py`): missing binary, no git, parse/subprocess failures → empty strings / friendly dict fields / plain error messages. Nothing raises into a turn; nothing blocks a run.
- **Prompt-cache discipline:** the graph pack contains NO commit hashes or timestamps — structure only — and must be byte-identical across calls until `graph.json` changes on disk. Budget ≤ 400 estimated tokens (`(len+3)//4`).
- **Ponytail seam is exactly one env var**: `PONYTAIL_DEFAULT_MODE` on the `claude` subprocess, only when a run picked a level. Valid levels: `off`, `lite`, `full`, `ultra`. Absent = plugin default (`full`).
- **First graph build is always explicit** (BUILD button / `/map build`). Post-turn auto-refresh only when `graphify-out/graph.json` already exists.
- On a project's **first successful build**, append `graphify-out/` to `.git/info/exclude` (never commit to user repos).
- Tests must not read the developer's real env/DB: conftest.py already pins `BASE_PATH`, `BRIDGE_DB`, tokens. Build test fixtures under `config.BASE_PATH`.
- Backend loads only on bridge restart. Do NOT restart the bridge yourself — the session dies with it (bridge-hosted). Commit after every task.
- Execution happens on branch `feat/graphify-ponytail` in a worktree (create via superpowers:using-git-worktrees at execution start). Frontend `npm run build` needs `node_modules` — run `npm --prefix <webdir> ci` in the worktree if missing, or run builds from the main checkout after merge.

---

### Task 1: graphmap core — binary resolution, graph state, explain

**Files:**
- Create: `bridge/graphmap.py`
- Create: `tests/test_graphmap.py`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces (used by every later task):
  - `graphify_bin() -> str | None`
  - `has_graph(cwd: str) -> bool`
  - `graph_state(cwd: str) -> dict` with keys `available, exists, built_commit, head, stale, building` (bools + `str|None`)
  - `explain(cwd: str, query: str) -> str`
  - module constants `OUT_DIR = "graphify-out"`, `EXPLAIN_MAX_CHARS = 3500`

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_graphmap.py
"""Unit tests for bridge/graphmap.py — graphify CLI integration.
Run: python -m pytest tests/test_graphmap.py -v"""

import json
import os
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import config, graphmap  # noqa: E402


def _git(cwd, *args):
    subprocess.run(["git", "-C", cwd, *args], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _mkrepo(tmp_path, name="proj"):
    """A real git repo under BASE_PATH with one commit; returns its abs path."""
    d = os.path.join(config.BASE_PATH, f"{name}_{os.path.basename(str(tmp_path))}")
    os.makedirs(d, exist_ok=True)
    subprocess.run(["git", "init", "-q", d], check=True)
    _git(d, "config", "user.email", "t@example.com")
    _git(d, "config", "user.name", "Tester")
    with open(os.path.join(d, "a.py"), "w") as f:
        f.write("x = 1\n")
    _git(d, "add", "-A")
    _git(d, "commit", "-qm", "init")
    return d


def _head8(d):
    return subprocess.run(["git", "rev-parse", "--short=8", "HEAD"], cwd=d,
                          capture_output=True, text=True).stdout.strip()


def _write_graph(d, built_commit):
    out = os.path.join(d, graphmap.OUT_DIR)
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "graph.json"), "w") as f:
        json.dump({"built_at_commit": built_commit, "nodes": [], "links": []}, f)


# --- graphify_bin ------------------------------------------------------------

def test_bin_resolution_prefers_path(monkeypatch):
    monkeypatch.setattr(graphmap.shutil, "which", lambda _: "/usr/bin/graphify")
    monkeypatch.setattr(graphmap, "_graphify_bin", None)
    assert graphmap.graphify_bin() == "/usr/bin/graphify"


def test_bin_resolution_none_when_absent(monkeypatch):
    monkeypatch.setattr(graphmap.shutil, "which", lambda _: None)
    monkeypatch.setattr(graphmap.os, "access", lambda *_a, **_k: False)
    monkeypatch.setattr(graphmap, "_graphify_bin", None)
    assert graphmap.graphify_bin() is None


# --- graph_state -------------------------------------------------------------

def test_state_no_graph(tmp_path, monkeypatch):
    monkeypatch.setattr(graphmap, "graphify_bin", lambda: "/usr/bin/graphify")
    d = _mkrepo(tmp_path)
    st = graphmap.graph_state(d)
    assert st["exists"] is False and st["built_commit"] is None
    assert st["available"] is True and st["building"] is False


def test_state_fresh_graph_not_stale(tmp_path, monkeypatch):
    monkeypatch.setattr(graphmap, "graphify_bin", lambda: "/usr/bin/graphify")
    d = _mkrepo(tmp_path)
    _write_graph(d, _head8(d))
    st = graphmap.graph_state(d)
    assert st["exists"] is True and st["stale"] is False
    assert st["built_commit"] == _head8(d)


def test_state_stale_after_new_commit(tmp_path, monkeypatch):
    monkeypatch.setattr(graphmap, "graphify_bin", lambda: "/usr/bin/graphify")
    d = _mkrepo(tmp_path)
    _write_graph(d, _head8(d))
    with open(os.path.join(d, "b.py"), "w") as f:
        f.write("y = 2\n")
    _git(d, "add", "-A")
    _git(d, "commit", "-qm", "more")
    assert graphmap.graph_state(d)["stale"] is True


def test_state_no_git_is_harmless(tmp_path, monkeypatch):
    monkeypatch.setattr(graphmap, "graphify_bin", lambda: None)
    d = os.path.join(config.BASE_PATH, f"nogit_{os.path.basename(str(tmp_path))}")
    os.makedirs(d, exist_ok=True)
    st = graphmap.graph_state(d)
    assert st == {"available": False, "exists": False, "built_commit": None,
                  "head": None, "stale": False, "building": False}


# --- explain -----------------------------------------------------------------

def test_explain_no_binary(monkeypatch, tmp_path):
    monkeypatch.setattr(graphmap, "graphify_bin", lambda: None)
    assert "not installed" in graphmap.explain(str(tmp_path), "x")


def test_explain_no_graph(monkeypatch, tmp_path):
    monkeypatch.setattr(graphmap, "graphify_bin", lambda: "/usr/bin/graphify")
    d = _mkrepo(tmp_path)
    assert "No graph yet" in graphmap.explain(d, "x")


def test_explain_truncates(monkeypatch, tmp_path):
    monkeypatch.setattr(graphmap, "graphify_bin", lambda: "/usr/bin/graphify")
    d = _mkrepo(tmp_path)
    _write_graph(d, _head8(d))

    class FakeProc:
        returncode = 0
        stdout = "A" * 5000
        stderr = ""
    monkeypatch.setattr(graphmap.subprocess, "run", lambda *a, **k: FakeProc())
    out = graphmap.explain(d, "x")
    assert len(out) < 4000 and out.endswith("…(truncated)")
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_graphmap.py -v`
Expected: FAIL / ERROR with `ModuleNotFoundError: No module named 'bridge.graphmap'` (collection error is fine).

- [ ] **Step 3: Write the implementation**

```python
# bridge/graphmap.py
"""Graphify integration: per-project code knowledge graphs (graphify-out/).

Shells out to the graphify CLI (pipx `graphifyy`; tree-sitter AST, no LLM for
code) and serves/parses its artifacts. Postures mirror the rest of the bridge:
binary resolution like runner.claude_bin(), best-effort like memory.py —
failures yield empty/friendly values and never block a turn.
See docs/superpowers/specs/2026-07-07-graphify-ponytail-features-design.md
"""

import json
import logging
import os
import shutil
import subprocess
import threading

log = logging.getLogger("bridge.graphmap")

OUT_DIR = "graphify-out"
BUILD_TIMEOUT = 300     # explicit build/refresh (first build = full AST pass)
REFRESH_TIMEOUT = 120   # post-turn refresh (warm cache)
EXPLAIN_TIMEOUT = 30
EXPLAIN_MAX_CHARS = 3500

_GRAPHIFY_FALLBACKS = ("~/.local/bin/graphify",)   # pipx/uv tool bin dir
_graphify_bin: "str | None" = None


def graphify_bin() -> "str | None":
    """Absolute path to graphify, or None when not installed. Re-resolves when
    the cached path disappears; keeps returning None until installed (cheap)."""
    global _graphify_bin
    if _graphify_bin and os.path.exists(_graphify_bin):
        return _graphify_bin
    found = shutil.which("graphify")
    if not found:
        for cand in _GRAPHIFY_FALLBACKS:
            cand = os.path.expanduser(cand)
            if os.access(cand, os.X_OK):
                found = cand
                break
    _graphify_bin = found
    return _graphify_bin


def _graph_json(cwd: str) -> str:
    return os.path.join(cwd, OUT_DIR, "graph.json")


def has_graph(cwd: str) -> bool:
    return os.path.isfile(_graph_json(cwd))


def _built_commit(cwd: str) -> "str | None":
    try:
        with open(_graph_json(cwd), encoding="utf-8") as f:
            v = json.load(f).get("built_at_commit")
        return str(v) if v else None
    except (OSError, ValueError):
        return None


def _head_commit(cwd: str) -> "str | None":
    try:
        proc = subprocess.run(["git", "rev-parse", "--short=8", "HEAD"], cwd=cwd,
                              capture_output=True, text=True, timeout=10)
    except (OSError, subprocess.SubprocessError):
        return None
    return (proc.stdout.strip() or None) if proc.returncode == 0 else None


# One build at a time per project; `_building` backs the UI's polling flag.
_build_locks: "dict[str, threading.Lock]" = {}
_locks_guard = threading.Lock()
_building: "set[str]" = set()


def _lock_for(cwd: str) -> threading.Lock:
    with _locks_guard:
        return _build_locks.setdefault(os.path.realpath(cwd), threading.Lock())


def graph_state(cwd: str) -> dict:
    built = _built_commit(cwd)
    head = _head_commit(cwd)
    return {
        "available": graphify_bin() is not None,
        "exists": has_graph(cwd),
        "built_commit": built,
        "head": head,
        # short-sha lengths may drift between tools; prefix-compare both ways
        "stale": bool(built and head
                      and not (head.startswith(built) or built.startswith(head))),
        "building": os.path.realpath(cwd) in _building,
    }


def explain(cwd: str, query: str) -> str:
    """`graphify explain "<query>"` in the project root, truncated for chat."""
    bin_ = graphify_bin()
    if not bin_:
        return "graphify is not installed (pipx install graphifyy)."
    if not has_graph(cwd):
        return "No graph yet — build one first (MAP tab / /map build)."
    try:
        proc = subprocess.run([bin_, "explain", query], cwd=cwd,
                              capture_output=True, text=True,
                              timeout=EXPLAIN_TIMEOUT)
    except subprocess.TimeoutExpired:
        return "graphify explain timed out."
    except OSError as e:
        return f"graphify explain failed: {e}"
    out = (proc.stdout or proc.stderr or "").strip()
    if len(out) > EXPLAIN_MAX_CHARS:
        out = out[:EXPLAIN_MAX_CHARS] + "\n…(truncated)"
    return out or "(no output)"
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_graphmap.py -v`
Expected: 9 passed.

- [ ] **Step 5: Commit**

```bash
git add bridge/graphmap.py tests/test_graphmap.py
git commit -m "feat(graphmap): graphify binary resolution, graph state, explain"
```

---

### Task 2: graphmap build — update, per-project lock, exclude, async refresh

**Files:**
- Modify: `bridge/graphmap.py` (append after `graph_state`)
- Modify: `tests/test_graphmap.py` (append)

**Interfaces:**
- Consumes: Task 1's `graphify_bin`, `has_graph`, `_lock_for`, `_building`.
- Produces:
  - `update(cwd: str, timeout: int = BUILD_TIMEOUT) -> tuple[bool, str]` (blocking)
  - `update_async(cwd: str, timeout: int = BUILD_TIMEOUT) -> dict` (fire thread, return `graph_state(cwd)`)
  - `refresh_async(cwd: str | None) -> None` (no-op unless a graph already exists)

- [ ] **Step 1: Write the failing tests** (append to `tests/test_graphmap.py`)

```python
# --- update / exclude / refresh ---------------------------------------------

def _fake_update_ok(d):
    """A subprocess.run stub that fabricates graphify's output artifact."""
    def run(cmd, cwd=None, **k):
        _write_graph(cwd, _head8(cwd))

        class P:
            returncode = 0
            stdout = "Code graph updated."
            stderr = ""
        return P()
    return run


def test_update_builds_and_excludes(tmp_path, monkeypatch):
    d = _mkrepo(tmp_path)
    monkeypatch.setattr(graphmap, "graphify_bin", lambda: "/usr/bin/graphify")
    monkeypatch.setattr(graphmap.subprocess, "run", _fake_update_ok(d))
    ok, msg = graphmap.update(d)
    assert ok is True
    with open(os.path.join(d, ".git", "info", "exclude")) as f:
        assert "graphify-out/" in f.read()


def test_update_exclude_not_duplicated(tmp_path, monkeypatch):
    d = _mkrepo(tmp_path)
    monkeypatch.setattr(graphmap, "graphify_bin", lambda: "/usr/bin/graphify")
    monkeypatch.setattr(graphmap.subprocess, "run", _fake_update_ok(d))
    graphmap.update(d)
    os.remove(os.path.join(d, graphmap.OUT_DIR, "graph.json"))  # force "first build" again
    graphmap.update(d)
    with open(os.path.join(d, ".git", "info", "exclude")) as f:
        assert f.read().count("graphify-out/") == 1


def test_update_no_binary(tmp_path, monkeypatch):
    monkeypatch.setattr(graphmap, "graphify_bin", lambda: None)
    ok, msg = graphmap.update(str(tmp_path))
    assert ok is False and "not installed" in msg


def test_update_second_caller_skips(tmp_path, monkeypatch):
    d = _mkrepo(tmp_path)
    monkeypatch.setattr(graphmap, "graphify_bin", lambda: "/usr/bin/graphify")
    lock = graphmap._lock_for(d)
    lock.acquire()          # simulate an in-flight build
    try:
        ok, msg = graphmap.update(d)
        assert ok is False and msg == "already building"
    finally:
        lock.release()


def test_update_failure_message(tmp_path, monkeypatch):
    d = _mkrepo(tmp_path)
    monkeypatch.setattr(graphmap, "graphify_bin", lambda: "/usr/bin/graphify")

    class P:
        returncode = 2
        stdout = ""
        stderr = "boom"
    monkeypatch.setattr(graphmap.subprocess, "run", lambda *a, **k: P())
    ok, msg = graphmap.update(d)
    assert ok is False and "boom" in msg


def test_refresh_async_noop_without_graph(tmp_path, monkeypatch):
    d = _mkrepo(tmp_path)
    monkeypatch.setattr(graphmap, "graphify_bin", lambda: "/usr/bin/graphify")
    called = []
    monkeypatch.setattr(graphmap.threading, "Thread",
                        lambda *a, **k: called.append(1) or _NopThread())
    graphmap.refresh_async(d)          # no graph yet -> must not spawn
    assert called == []
    graphmap.refresh_async(None)       # no cwd -> must not spawn
    assert called == []


class _NopThread:
    def start(self):
        pass


def test_refresh_async_spawns_with_graph(tmp_path, monkeypatch):
    d = _mkrepo(tmp_path)
    _write_graph(d, _head8(d))
    monkeypatch.setattr(graphmap, "graphify_bin", lambda: "/usr/bin/graphify")
    spawned = {}

    class FakeThread:
        def __init__(self, target=None, args=(), daemon=None):
            spawned["args"] = args
        def start(self):
            spawned["started"] = True
    monkeypatch.setattr(graphmap.threading, "Thread", FakeThread)
    graphmap.refresh_async(d)
    assert spawned.get("started") and spawned["args"] == (d, graphmap.REFRESH_TIMEOUT)
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_graphmap.py -v -k "update or refresh"`
Expected: FAIL with `AttributeError: module 'bridge.graphmap' has no attribute 'update'`.

- [ ] **Step 3: Write the implementation** (append to `bridge/graphmap.py`)

```python
def _exclude_artifacts(cwd: str) -> None:
    """Keep artifacts out of the user's repo: append graphify-out/ to
    .git/info/exclude (repo-local, never committed). Best-effort."""
    try:
        info = os.path.join(cwd, ".git", "info")
        if not os.path.isdir(info):
            return
        path = os.path.join(info, "exclude")
        try:
            with open(path, encoding="utf-8") as f:
                if "graphify-out/" in f.read():
                    return
        except OSError:
            pass
        with open(path, "a", encoding="utf-8") as f:
            f.write("\ngraphify-out/\n")
    except OSError:
        pass


def update(cwd: str, timeout: int = BUILD_TIMEOUT) -> "tuple[bool, str]":
    """Build or refresh a project's graph (`graphify update .`). Serialized per
    project; a concurrent caller returns immediately instead of stacking."""
    bin_ = graphify_bin()
    if not bin_:
        return False, "graphify is not installed (pipx install graphifyy)."
    lock = _lock_for(cwd)
    if not lock.acquire(blocking=False):
        return False, "already building"
    key = os.path.realpath(cwd)
    _building.add(key)
    try:
        first = not has_graph(cwd)
        proc = subprocess.run([bin_, "update", "."], cwd=cwd,
                              capture_output=True, text=True, timeout=timeout)
        if proc.returncode != 0:
            tail = (proc.stderr or proc.stdout or "").strip()[-500:]
            return False, f"graphify update failed: {tail or proc.returncode}"
        if first:
            _exclude_artifacts(cwd)
        return True, "graph updated"
    except subprocess.TimeoutExpired:
        return False, f"graphify update timed out after {timeout}s"
    except OSError as e:
        return False, f"graphify update failed: {e}"
    finally:
        _building.discard(key)
        lock.release()


def update_async(cwd: str, timeout: int = BUILD_TIMEOUT) -> dict:
    """Kick off a build/refresh in a daemon thread and return the current state.
    HTTP handlers use this so long builds never hold a request (tunnel-safe);
    clients poll graph_state's `building` flag."""
    threading.Thread(target=update, args=(cwd, timeout), daemon=True).start()
    return graph_state(cwd)


def refresh_async(cwd: "str | None") -> None:
    """Post-turn refresh for projects that already have a graph. Fire-and-forget;
    the per-project lock drops overlapping refreshes. Never blocks a turn."""
    if not cwd or not has_graph(cwd) or not graphify_bin():
        return
    threading.Thread(target=update, args=(cwd, REFRESH_TIMEOUT),
                     daemon=True).start()
```

- [ ] **Step 4: Run the whole module's tests**

Run: `python3 -m pytest tests/test_graphmap.py -v`
Expected: 16 passed.

- [ ] **Step 5: Commit**

```bash
git add bridge/graphmap.py tests/test_graphmap.py
git commit -m "feat(graphmap): update/lock/exclude, async build + post-turn refresh"
```

---

### Task 3: graphmap — the graph pack (system-prompt structure summary)

**Files:**
- Modify: `bridge/graphmap.py` (append)
- Modify: `tests/test_graphmap.py` (append)

**Interfaces:**
- Consumes: Task 1's `_graph_json`, `OUT_DIR`.
- Produces: `graph_pack(cwd: str | None) -> str` — "" when no graph/cwd; otherwise a `# Project map` block, ≤400 estimated tokens, **no commit hashes or timestamps**, memoized by `graph.json` mtime.

- [ ] **Step 1: Write the failing tests** (append to `tests/test_graphmap.py`)

```python
# --- graph_pack ----------------------------------------------------------------

def _write_rich_graph(d):
    """Two communities; file `big.py` has the highest degree (3 links)."""
    out = os.path.join(d, graphmap.OUT_DIR)
    os.makedirs(out, exist_ok=True)
    nodes = [
        {"id": "big", "label": "big.py", "community": 0,
         "metadata": {"kind": "file"}},
        {"id": "fn1", "label": "fn1()", "community": 0, "metadata": {"kind": "function"}},
        {"id": "fn2", "label": "fn2()", "community": 0, "metadata": {"kind": "function"}},
        {"id": "small", "label": "small.py", "community": 1,
         "metadata": {"kind": "file"}},
    ]
    links = [
        {"source": "big", "target": "fn1", "relation": "contains"},
        {"source": "big", "target": "fn2", "relation": "contains"},
        {"source": "small", "target": "big", "relation": "imports_from"},
    ]
    with open(os.path.join(out, "graph.json"), "w") as f:
        json.dump({"built_at_commit": "deadbeef", "nodes": nodes, "links": links}, f)
    with open(os.path.join(out, ".graphify_labels.json"), "w") as f:
        json.dump({"0": "core engine", "1": "helpers"}, f)


def test_pack_empty_without_graph(tmp_path):
    assert graphmap.graph_pack(str(tmp_path)) == ""
    assert graphmap.graph_pack(None) == ""


def test_pack_content_and_no_volatile_fields(tmp_path):
    d = _mkrepo(tmp_path)
    _write_rich_graph(d)
    pack = graphmap.graph_pack(d)
    assert pack.startswith("# Project map")
    assert "core engine" in pack and "big.py" in pack
    assert "deadbeef" not in pack          # no commit hashes in the prompt


def test_pack_byte_stable_and_memoized(tmp_path):
    d = _mkrepo(tmp_path)
    _write_rich_graph(d)
    a = graphmap.graph_pack(d)
    b = graphmap.graph_pack(d)
    assert a == b and a is b               # identical object => cache hit


def test_pack_respects_budget(tmp_path):
    d = _mkrepo(tmp_path)
    out = os.path.join(d, graphmap.OUT_DIR)
    os.makedirs(out, exist_ok=True)
    nodes = [{"id": f"n{i}", "label": "x" * 80, "community": i,
              "metadata": {"kind": "file"}} for i in range(60)]
    with open(os.path.join(out, "graph.json"), "w") as f:
        json.dump({"built_at_commit": "c", "nodes": nodes, "links": []}, f)
    pack = graphmap.graph_pack(d)
    assert (len(pack) + 3) // 4 <= graphmap.PACK_TOKEN_BUDGET


def test_pack_corrupt_json_is_empty(tmp_path):
    d = _mkrepo(tmp_path)
    out = os.path.join(d, graphmap.OUT_DIR)
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "graph.json"), "w") as f:
        f.write("{nope")
    assert graphmap.graph_pack(d) == ""
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_graphmap.py -v -k pack`
Expected: FAIL with `AttributeError: ... no attribute 'graph_pack'`.

- [ ] **Step 3: Write the implementation** (append to `bridge/graphmap.py`)

```python
# --- graph pack (system-prompt structure summary) ----------------------------
# Injected by runner._compose_system_prompt. MUST stay byte-identical across
# turns until graph.json changes on disk (Claude Code prompt cache), so it
# contains no commit hashes or timestamps — structure only.

PACK_TOKEN_BUDGET = 400
PACK_COMMUNITIES = 8
PACK_HUBS = 6

_pack_cache: "dict[str, tuple[float, str]]" = {}


def _estimate_tokens(text: str) -> int:
    """Same deterministic ~4-chars/token estimate as bridge.memory."""
    return (len(text) + 3) // 4


def _render_pack(data: dict, labels: dict) -> str:
    nodes = data.get("nodes") or []
    links = data.get("links") or []
    if not nodes:
        return ""
    degree: dict = {}
    for e in links:
        for end in ("source", "target"):
            nid = e.get(end)
            if nid is not None:
                degree[nid] = degree.get(nid, 0) + 1
    by_comm: dict = {}
    for n in nodes:
        by_comm.setdefault(n.get("community"), []).append(n)
    ranked = sorted(by_comm.items(), key=lambda kv: -len(kv[1]))
    comm_lines = []
    for cid, members in ranked[:PACK_COMMUNITIES]:
        label = labels.get(str(cid)) or f"community {cid}"
        hubs = sorted(members, key=lambda n: -degree.get(n.get("id"), 0))[:3]
        names = ", ".join(str(h.get("label", "?")) for h in hubs)
        comm_lines.append(f"- {label} ({len(members)} nodes): {names}")
    files = [n for n in nodes if (n.get("metadata") or {}).get("kind") == "file"]
    top = sorted(files, key=lambda n: -degree.get(n.get("id"), 0))[:PACK_HUBS]
    hub_line = ", ".join(str(n.get("label")) for n in top)

    head = ["# Project map (graphify; auto-generated structure)", "Subsystems:"]
    tail = ["Structure questions: run `graphify explain \"<thing>\"` in the "
            "project root (or use the dashboard MAP tab)."]
    lines = comm_lines + ([f"Hub files: {hub_line}"] if hub_line else [])
    while lines:
        text = "\n".join(head + lines + tail)
        if _estimate_tokens(text) <= PACK_TOKEN_BUDGET:
            return text
        lines.pop()
    return ""


def graph_pack(cwd: "str | None") -> str:
    """≤~400-token structure summary for the system prompt; "" when the project
    has no graph. Memoized by graph.json mtime so repeat turns get the exact
    same string (cache-eligible) without re-parsing megabytes of JSON."""
    if not cwd:
        return ""
    path = _graph_json(cwd)
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return ""
    key = os.path.realpath(cwd)
    cached = _pack_cache.get(key)
    if cached and cached[0] == mtime:
        return cached[1]
    labels: dict = {}
    try:
        with open(path, encoding="utf-8") as f:
            data = json.load(f)
        try:
            with open(os.path.join(cwd, OUT_DIR, ".graphify_labels.json"),
                      encoding="utf-8") as f:
                loaded = json.load(f)
            if isinstance(loaded, dict):
                labels = loaded
        except (OSError, ValueError):
            pass
        text = _render_pack(data, labels)
    except (OSError, ValueError):
        return ""
    _pack_cache[key] = (mtime, text)
    return text
```

- [ ] **Step 4: Run all graphmap tests**

Run: `python3 -m pytest tests/test_graphmap.py -v`
Expected: 21 passed.

- [ ] **Step 5: Commit**

```bash
git add bridge/graphmap.py tests/test_graphmap.py
git commit -m "feat(graphmap): budgeted, byte-stable graph pack for the system prompt"
```

---

### Task 4: runner — ponytail level → subprocess env

**Files:**
- Modify: `bridge/runner.py` (near `_base_cmd` ~line 166, `run_blocking` ~line 210, `_run_streaming` ~line 706, `start_streaming_job` ~line 911)
- Create: `tests/test_ponytail_runner.py`

**Interfaces:**
- Consumes: nothing new.
- Produces (used by Tasks 8, 9, 10, 13):
  - `runner.normalize_ponytail(level) -> str | None` (valid: `off|lite|full|ultra`, else None)
  - `runner._run_env(ponytail: str | None) -> dict | None` (None = inherit)
  - `run_blocking(..., ponytail: str | None = None)` keyword
  - `_run_streaming(job, prompt, image_paths, cwd, model=None, effort=None, permission_mode=None, ponytail=None)`
  - `start_streaming_job(..., ponytail: str | None = None)` keyword

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_ponytail_runner.py
"""Ponytail intensity plumbing: validation + PONYTAIL_DEFAULT_MODE env.
Run: python -m pytest tests/test_ponytail_runner.py -v"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import runner  # noqa: E402


def test_normalize_valid_levels():
    for lv in ("off", "lite", "full", "ultra"):
        assert runner.normalize_ponytail(lv) == lv
    assert runner.normalize_ponytail(" FULL ") == "full"


def test_normalize_invalid_levels():
    for bad in (None, "", "mega", 3, "review"):
        assert runner.normalize_ponytail(bad) is None


def test_run_env_inherits_when_unset():
    assert runner._run_env(None) is None


def test_run_env_sets_mode():
    env = runner._run_env("lite")
    assert env["PONYTAIL_DEFAULT_MODE"] == "lite"
    assert env["PATH"] == os.environ["PATH"]       # full inherited env + override


def test_run_blocking_passes_env(monkeypatch):
    captured = {}

    class P:
        returncode = 0
        stdout = '{"result": "ok", "session_id": "s"}'
        stderr = ""

    def fake_run(cmd, **kw):
        captured.update(kw)
        return P()
    monkeypatch.setattr(runner.subprocess, "run", fake_run)
    monkeypatch.setattr(runner, "_memory_pack_for", lambda *a, **k: "")
    monkeypatch.setattr(runner, "_graph_pack_for", lambda *a, **k: "", raising=False)
    monkeypatch.setattr(runner.state, "project_dir", lambda _c: os.getcwd())
    runner.run_blocking(555, "hi", ponytail="ultra")
    assert captured["env"]["PONYTAIL_DEFAULT_MODE"] == "ultra"
    runner.run_blocking(555, "hi")
    assert captured["env"] is None
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_ponytail_runner.py -v`
Expected: FAIL with `AttributeError: ... no attribute 'normalize_ponytail'`.

- [ ] **Step 3: Implement**

3a. Add near the top of `bridge/runner.py`, right before the `claude_bin` section comment (~line 127):

```python
# --- ponytail (per-run code-minimalism intensity) ----------------------------
# The ponytail plugin's SessionStart hook reads PONYTAIL_DEFAULT_MODE from the
# child's env; absent means the plugin's own default (full). One env var is the
# whole integration — no tokens, no config writes, native sessions untouched.

_PONYTAIL_LEVELS = ("off", "lite", "full", "ultra")


def normalize_ponytail(level) -> "str | None":
    lv = str(level or "").strip().lower()
    return lv if lv in _PONYTAIL_LEVELS else None


def _run_env(ponytail: "str | None") -> "dict | None":
    """Env for the claude subprocess: None (inherit) unless a run picked a
    ponytail intensity."""
    if not ponytail:
        return None
    return {**os.environ, "PONYTAIL_DEFAULT_MODE": ponytail}
```

3b. `run_blocking` (~line 210): add the keyword and pass env.

```python
def run_blocking(chat_id: int, prompt: str, resume_id: str | None = None,
                 cwd: str | None = None, timeout: int | None = None, *,
                 model: str | None = None, skip_pack: bool = False,
                 ponytail: str | None = None):
    cmd = _base_cmd(prompt, chat_id, stream=False, claude_session_id=resume_id,
                    cwd=cwd, model=model, skip_pack=skip_pack)
    timeout = timeout or config.RUN_TIMEOUT
    try:
        proc = subprocess.run(cmd, cwd=cwd or state.project_dir(chat_id), capture_output=True,
                              text=True, timeout=timeout, env=_run_env(ponytail))
```

3c. `_run_streaming` (~line 706): add `ponytail: str | None = None` as the last parameter and change the Popen call:

```python
            proc = subprocess.Popen(cmd, cwd=cwd, stdin=subprocess.PIPE,
                                    stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    text=True, bufsize=1, env=_run_env(ponytail))
```

3d. `start_streaming_job` (~line 911): add `ponytail: str | None = None` to the signature (after `origin`) and extend the thread args:

```python
        threading.Thread(target=_run_streaming,
                         args=(job, prompt, image_paths, cwd, model, effort, perm,
                               ponytail),
                         daemon=True).start()
```

Note: `_graph_pack_for` doesn't exist until Task 5 — the test monkeypatches it with `raising=False`, so this task is independent.

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_ponytail_runner.py tests/test_memory_runner.py -v`
Expected: all pass (the memory-runner suite guards the `run_blocking` signature change).

- [ ] **Step 5: Commit**

```bash
git add bridge/runner.py tests/test_ponytail_runner.py
git commit -m "feat(runner): per-run ponytail intensity via PONYTAIL_DEFAULT_MODE env"
```

---

### Task 5: runner — graph pack in the system prompt

**Files:**
- Modify: `bridge/runner.py` (`_compose_system_prompt` ~line 99, `_base_cmd` ~line 199)
- Create: `tests/test_graph_inject.py`

**Interfaces:**
- Consumes: `graphmap.graph_pack(cwd)` (Task 3).
- Produces: `_graph_pack_for(chat_id, cwd) -> str`; `_compose_system_prompt(pack="", graph="")`.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_graph_inject.py
"""Graph pack rides --append-system-prompt after the memory pack.
Run: python -m pytest tests/test_graph_inject.py -v"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import runner  # noqa: E402


def _sysprompt(cmd: list) -> str:
    return cmd[cmd.index("--append-system-prompt") + 1]


def test_compose_orders_memory_then_graph():
    out = runner._compose_system_prompt("MEMPACK", "GRAPHPACK")
    assert out.index("MEMPACK") < out.index("GRAPHPACK")


def test_compose_without_graph_unchanged():
    assert runner._compose_system_prompt("MEMPACK") == \
        runner._compose_system_prompt("MEMPACK", "")


def test_base_cmd_includes_graph_pack(monkeypatch):
    monkeypatch.setattr(runner, "_memory_pack_for", lambda *a: "MEM")
    monkeypatch.setattr(runner, "_graph_pack_for", lambda *a: "# Project map\nX")
    cmd = runner._base_cmd("hi", 555, stream=False)
    assert "# Project map" in _sysprompt(cmd)


def test_skip_pack_skips_graph_too(monkeypatch):
    monkeypatch.setattr(runner, "_memory_pack_for", lambda *a: "MEM")
    monkeypatch.setattr(runner, "_graph_pack_for", lambda *a: "# Project map\nX")
    cmd = runner._base_cmd("hi", 555, stream=False, skip_pack=True)
    assert "# Project map" not in _sysprompt(cmd)
    assert "MEM" not in _sysprompt(cmd)


def test_graph_pack_for_swallows_errors(monkeypatch):
    from bridge import graphmap
    monkeypatch.setattr(graphmap, "graph_pack",
                        lambda _cwd: (_ for _ in ()).throw(RuntimeError("boom")))
    assert runner._graph_pack_for(555, "/tmp") == ""
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_graph_inject.py -v`
Expected: FAIL (`_compose_system_prompt() takes from 0 to 1 positional arguments` / missing `_graph_pack_for`).

- [ ] **Step 3: Implement** in `bridge/runner.py`

3a. After `_memory_pack_for` (~line 96):

```python
def _graph_pack_for(chat_id: int, cwd: "str | None") -> str:
    """Graphify structure pack for injection. Best-effort like the memory pack:
    no graph, no module, any failure — empty string, never blocks a turn."""
    try:
        from bridge import graphmap
        return graphmap.graph_pack(cwd or state.project_dir(chat_id))
    except Exception:  # noqa: BLE001
        return ""
```

3b. Replace `_compose_system_prompt` (~line 99):

```python
def _compose_system_prompt(pack: str = "", graph: str = "") -> str:
    """Stable content first (ASK prompt + dev-log note), then the memory pack,
    then the graph pack — each byte-stable within a session, so the prefix
    stays cache-eligible."""
    parts = [p for p in (config.ASK_SYSTEM_PROMPT.strip(), _LOG_NOTE,
                         pack.strip(), graph.strip()) if p]
    return "\n\n".join(parts)
```

3c. In `_base_cmd` (~line 199) replace the two pack lines:

```python
    pack = "" if skip_pack else _memory_pack_for(chat_id, cwd)
    graph = "" if skip_pack else _graph_pack_for(chat_id, cwd)
    cmd += ["--append-system-prompt", _compose_system_prompt(pack, graph)]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_graph_inject.py tests/test_memory_inject.py tests/test_memory_runner.py -v`
Expected: all pass (memory suites guard the compose seam).

- [ ] **Step 5: Commit**

```bash
git add bridge/runner.py tests/test_graph_inject.py
git commit -m "feat(runner): inject graphify structure pack into the system prompt"
```

---

### Task 6: runner — post-turn graph refresh

**Files:**
- Modify: `bridge/runner.py` (`handle_task` ~line 256, `_run_streaming` finally block ~line 826)
- Modify: `tests/test_graph_inject.py` (append)

**Interfaces:**
- Consumes: `graphmap.refresh_async(cwd)` (Task 2).
- Produces: nothing new — behavior only.

- [ ] **Step 1: Write the failing tests** (append to `tests/test_graph_inject.py`)

```python
def test_refresh_after_turn_helper(monkeypatch):
    from bridge import graphmap
    calls = []
    monkeypatch.setattr(graphmap, "refresh_async", lambda cwd: calls.append(cwd))
    monkeypatch.setattr(runner.state, "project_dir", lambda _c: "/proj")
    runner._graph_refresh_after_turn(555, None)
    assert calls == ["/proj"]
    runner._graph_refresh_after_turn(555, "/explicit")
    assert calls == ["/proj", "/explicit"]


def test_refresh_after_turn_swallows_errors(monkeypatch):
    from bridge import graphmap
    monkeypatch.setattr(graphmap, "refresh_async",
                        lambda _cwd: (_ for _ in ()).throw(RuntimeError("x")))
    monkeypatch.setattr(runner.state, "project_dir", lambda _c: "/proj")
    runner._graph_refresh_after_turn(555, None)   # must not raise
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_graph_inject.py -v -k refresh`
Expected: FAIL with `AttributeError: ... no attribute '_graph_refresh_after_turn'`.

- [ ] **Step 3: Implement** in `bridge/runner.py`

3a. Right after `_graph_pack_for`:

```python
def _graph_refresh_after_turn(chat_id: int, cwd: "str | None") -> None:
    """Keep an existing graph fresh after a successful turn (fire-and-forget;
    refresh_async no-ops for projects that were never mapped)."""
    try:
        from bridge import graphmap
        graphmap.refresh_async(cwd or state.project_dir(chat_id))
    except Exception:  # noqa: BLE001
        pass
```

3b. In `handle_task`, directly after the `_capture_async(...)` call inside `if not is_error:` (~line 257):

```python
        if not is_error:
            _capture_async(chat_id, session["id"], job_id, None, result, [])
            _graph_refresh_after_turn(chat_id, None)
```

3c. In `_run_streaming`'s `finally` block, directly after the `_capture_async(...)` call (~line 826-827):

```python
        if not job.interrupted and job.status == "done" and job.store_session_id:
            _capture_async(job.chat_id, job.store_session_id, job.id, cwd,
                           "\n\n".join(job.texts), list(job.edited))
            _graph_refresh_after_turn(job.chat_id, cwd)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_graph_inject.py -v`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add bridge/runner.py tests/test_graph_inject.py
git commit -m "feat(runner): refresh existing project graphs after successful turns"
```

---

### Task 7: `/map` bot command

**Files:**
- Modify: `bridge/dispatch.py` (HELP ~line 15, `on_message` command chain ~line 89, new handler at module level)
- Create: `tests/test_map_command.py`

**Interfaces:**
- Consumes: `graphmap.graph_state`, `update`, `explain`, `graph_pack` (Tasks 1-3).
- Produces: `/map`, `/map build`, `/map <query>` in the Telegram bot.

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_map_command.py
"""/map bot command: summary, build, explain.
Run: python -m pytest tests/test_map_command.py -v"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import dispatch, graphmap  # noqa: E402


def _msgs(monkeypatch):
    sent = []
    monkeypatch.setattr(dispatch, "send", lambda _chat, text, **k: sent.append(text))
    monkeypatch.setattr(dispatch.state, "project_dir", lambda _c: "/proj")
    return sent


def test_map_no_graph_hints_build(monkeypatch):
    sent = _msgs(monkeypatch)
    monkeypatch.setattr(graphmap, "graph_state", lambda _c: {
        "available": True, "exists": False, "built_commit": None,
        "head": "abc", "stale": False, "building": False})
    dispatch._handle_map(555, "")
    assert "/map build" in sent[0]


def test_map_not_installed(monkeypatch):
    sent = _msgs(monkeypatch)
    monkeypatch.setattr(graphmap, "graph_state", lambda _c: {
        "available": False, "exists": False, "built_commit": None,
        "head": None, "stale": False, "building": False})
    dispatch._handle_map(555, "")
    assert "not installed" in sent[0]


def test_map_summary(monkeypatch):
    sent = _msgs(monkeypatch)
    monkeypatch.setattr(graphmap, "graph_state", lambda _c: {
        "available": True, "exists": True, "built_commit": "abcd1234",
        "head": "abcd1234", "stale": False, "building": False})
    monkeypatch.setattr(graphmap, "graph_pack", lambda _c: "# Project map\n- core")
    dispatch._handle_map(555, "")
    assert "abcd1234" in sent[0] and "- core" in sent[0]


def test_map_build(monkeypatch):
    sent = _msgs(monkeypatch)
    monkeypatch.setattr(graphmap, "update", lambda _c: (True, "graph updated"))
    monkeypatch.setattr(graphmap, "graph_state", lambda _c: {
        "available": True, "exists": True, "built_commit": "abcd1234",
        "head": "abcd1234", "stale": False, "building": False})
    dispatch._handle_map(555, "build")
    assert any("graph updated" in m for m in sent)


def test_map_explain(monkeypatch):
    sent = _msgs(monkeypatch)
    monkeypatch.setattr(graphmap, "graph_state", lambda _c: {
        "available": True, "exists": True, "built_commit": "a",
        "head": "a", "stale": False, "building": False})
    monkeypatch.setattr(graphmap, "explain", lambda _c, q: f"NODE {q}")
    dispatch._handle_map(555, "queue_manager")
    assert sent == ["NODE queue_manager"]


def test_help_mentions_map():
    assert "/map" in dispatch.HELP
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_map_command.py -v`
Expected: FAIL with `AttributeError: ... no attribute '_handle_map'`.

- [ ] **Step 3: Implement** in `bridge/dispatch.py`

3a. Add the import at the top with the other bridge imports:

```python
from bridge import config, graphmap, state, store
```

3b. Add to `HELP` after the `/preview` line:

```python
    "/map [query] — project map: summary · /map build · /map <thing>\n"
```

3c. Add the handler at module level (after `_open_app`):

```python
def _handle_map(chat_id: int, arg: str):
    """Runs in a thread — graphify build/explain shell out for seconds."""
    cwd = state.project_dir(chat_id)
    if arg == "build":
        send(chat_id, "🗺 Building the project map…")
        ok, msg = graphmap.update(cwd)
        st = graphmap.graph_state(cwd)
        tag = f" (commit {st['built_commit']})" if ok and st["built_commit"] else ""
        send(chat_id, ("✅ " if ok else "⚠️ ") + msg + tag)
        return
    st = graphmap.graph_state(cwd)
    if not st["available"]:
        send(chat_id, "graphify is not installed (pipx install graphifyy).")
        return
    if not st["exists"]:
        send(chat_id, "No project map yet — /map build to create one.")
        return
    if arg:
        send(chat_id, graphmap.explain(cwd, arg))
        return
    stale = " · stale (repo has moved on)" if st["stale"] else ""
    send(chat_id, f"🗺 Map built @{st['built_commit']}{stale}\n\n"
                  f"{graphmap.graph_pack(cwd)}\n\n"
                  "/map <thing> to explain it · /map build to refresh")
```

3d. In `on_message`, add the command branch after the `/status` block (~line 100), before the plain-text fallthrough:

```python
    if cmd0 == "/map":
        threading.Thread(target=_handle_map,
                         args=(chat_id, text[len("/map"):].strip()),
                         daemon=True).start()
        return
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_map_command.py tests/test_bridge.py -v`
Expected: all pass (test_bridge guards dispatch's existing behavior).

- [ ] **Step 5: Commit**

```bash
git add bridge/dispatch.py tests/test_map_command.py
git commit -m "feat(bot): /map command — summary, build, explain via graphify"
```

---

### Task 8: dashboard server — graph endpoints + ponytail run param

**Files:**
- Modify: `bridge/dashboard/server.py` (imports ~line 24-36, `_get_api` after `/local/memory/items` ~line 410, `_post_api` after `/local/run` block ~line 423, `_run` ~line 721)
- Create: `tests/test_graph_endpoints.py`

**Interfaces:**
- Consumes: `graphmap` (Tasks 1-3), `runner.normalize_ponytail` (Task 4), existing `_abs_project`, `_send`, `_json`.
- Produces (consumed by Task 10's frontend):
  - `GET /local/graph/state?project=` → graph_state dict
  - `GET /local/graph/html?project=` → text/html bytes (404 `{"error":"no graph"}` when absent)
  - `GET /local/graph/explain?project=&q=` → `{"text": str}`
  - `POST /local/graph/update {project}` → graph_state dict (build kicked off async)
  - `POST /local/run` accepts `"ponytail"` in the body

- [ ] **Step 1: Write the failing tests**

```python
# tests/test_graph_endpoints.py
"""Dashboard + miniapp graph endpoints, driven without sockets via the
Handler.__new__ trick (mirrors test_files_endpoints.py).
Run: python -m pytest tests/test_graph_endpoints.py -v"""

import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import config, graphmap  # noqa: E402
from bridge.dashboard import server as dash  # noqa: E402


def _mkproject(name):
    d = os.path.join(config.BASE_PATH, name)
    os.makedirs(d, exist_ok=True)
    subprocess.run(["git", "init", "-q", d], check=True)
    return name, d


def _handler():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    h._send = lambda data, code, ctype, cache="no-cache": box.update(
        data=data, code=code, ctype=ctype)
    return h, box


def test_graph_state_endpoint(monkeypatch):
    name, d = _mkproject("proj_gstate")
    h, box = _handler()
    monkeypatch.setattr(graphmap, "graph_state", lambda _c: {"exists": False,
        "available": True, "built_commit": None, "head": None,
        "stale": False, "building": False})
    h._get_api("/local/graph/state", {"project": [name]})
    assert box["code"] == 200 and box["obj"]["exists"] is False


def test_graph_state_invalid_project():
    h, box = _handler()
    h._get_api("/local/graph/state", {"project": ["../../etc"]})
    assert box["code"] == 400


def test_graph_html_serves_file():
    name, d = _mkproject("proj_ghtml")
    os.makedirs(os.path.join(d, graphmap.OUT_DIR), exist_ok=True)
    with open(os.path.join(d, graphmap.OUT_DIR, "graph.html"), "w") as f:
        f.write("<html>MAP</html>")
    h, box = _handler()
    h._get_api("/local/graph/html", {"project": [name]})
    assert box["code"] == 200 and b"MAP" in box["data"]
    assert box["ctype"].startswith("text/html")


def test_graph_html_404_when_missing():
    name, _d = _mkproject("proj_gnone")
    h, box = _handler()
    h._get_api("/local/graph/html", {"project": [name]})
    assert box["code"] == 404


def test_graph_explain_endpoint(monkeypatch):
    name, _d = _mkproject("proj_gexp")
    monkeypatch.setattr(graphmap, "explain", lambda _c, q: f"ANSWER {q}")
    h, box = _handler()
    h._get_api("/local/graph/explain", {"project": [name], "q": ["thing"]})
    assert box["obj"] == {"text": "ANSWER thing"}


def test_graph_update_endpoint(monkeypatch):
    name, _d = _mkproject("proj_gupd")
    monkeypatch.setattr(graphmap, "update_async", lambda _c: {"building": True,
        "available": True, "exists": False, "built_commit": None,
        "head": None, "stale": False})
    h, box = _handler()
    h._post_api("/local/graph/update", {"project": name})
    assert box["code"] == 200 and box["obj"]["building"] is True
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_graph_endpoints.py -v`
Expected: FAIL — the GET paths fall through to 404 / missing-route behavior.

- [ ] **Step 3: Implement** in `bridge/dashboard/server.py`

3a. Add `graphmap` to the existing `from bridge import ...` import list.

3b. In `_get_api`, after the `/local/memory/items` block (~line 410):

```python
        if path == "/local/graph/state":
            abs_p = _abs_project(qs.get("project", [None])[0])
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            return self._json(graphmap.graph_state(abs_p))
        if path == "/local/graph/html":
            abs_p = _abs_project(qs.get("project", [None])[0])
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            fp = os.path.join(abs_p, graphmap.OUT_DIR, "graph.html")
            if not os.path.isfile(fp):
                return self._json({"error": "no graph"}, 404)
            with open(fp, "rb") as f:
                return self._send(f.read(), 200, "text/html; charset=utf-8")
        if path == "/local/graph/explain":
            abs_p = _abs_project(qs.get("project", [None])[0])
            q = (qs.get("q", [""])[0] or "").strip()
            if abs_p is None or not q:
                return self._json({"error": "invalid project or query"}, 400)
            return self._json({"text": graphmap.explain(abs_p, q)})
```

3c. In `_post_api`, after the `/local/run/...` interrupt block (~line 429):

```python
        if path == "/local/graph/update":
            abs_p = _abs_project(body.get("project"))
            if abs_p is None:
                return self._json({"error": "invalid project"}, 400)
            return self._json(graphmap.update_async(abs_p))
```

3d. In `_run` (~line 721), after the `permission_mode = ...` line add, and thread through:

```python
        permission_mode = normalize_permission_mode(body.get("permission_mode"))
        ponytail = runner.normalize_ponytail(body.get("ponytail"))
```

and extend the `start_streaming_job` call:

```python
        job = runner.start_streaming_job(chat, prompt, paths, project_path, job_id=job_id,
                                         model=model, effort=effort,
                                         permission_mode=permission_mode,
                                         session_id=session_id, origin="dashboard",
                                         ponytail=ponytail)
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_graph_endpoints.py tests/test_files_endpoints.py -v`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add bridge/dashboard/server.py tests/test_graph_endpoints.py
git commit -m "feat(dashboard): graph state/html/explain/update endpoints + ponytail run param"
```

---

### Task 9: miniapp server — graph endpoints + ponytail run param

**Files:**
- Modify: `bridge/miniapp/server.py` (imports ~line 22, `do_GET` routing ~line 218, `do_POST` routing ~line 253, `_api_run` ~line 360-376)
- Modify: `tests/test_graph_endpoints.py` (append)

**Interfaces:**
- Consumes: `graphmap`, `runner.normalize_ponytail`; the miniapp's existing initData auth happens in `do_GET`/`do_POST` before dispatch, so handlers need no extra auth.
- Produces (consumed by Tasks 12-13): `GET /api/graph/state|html|explain`, `POST /api/graph/update`, `POST /api/run` accepts `"ponytail"`.

- [ ] **Step 1: Write the failing tests** (append to `tests/test_graph_endpoints.py`)

```python
# --- miniapp ------------------------------------------------------------------

from bridge.miniapp import server as mini  # noqa: E402


def _mini_handler():
    h = mini.Handler.__new__(mini.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    h._send_bytes = lambda data, code, ctype, cache="no-cache": box.update(
        data=data, code=code, ctype=ctype)
    return h, box


def test_mini_graph_state(monkeypatch):
    name, _d = _mkproject("proj_mstate")
    monkeypatch.setattr(graphmap, "graph_state", lambda _c: {"exists": True,
        "available": True, "built_commit": "a", "head": "a",
        "stale": False, "building": False})
    h, box = _mini_handler()
    h._api_graph(555, "state", {"project": [name]}, None)
    assert box["obj"]["exists"] is True


def test_mini_graph_html(monkeypatch):
    name, d = _mkproject("proj_mhtml")
    os.makedirs(os.path.join(d, graphmap.OUT_DIR), exist_ok=True)
    with open(os.path.join(d, graphmap.OUT_DIR, "graph.html"), "w") as f:
        f.write("<html>M</html>")
    h, box = _mini_handler()
    h._api_graph(555, "html", {"project": [name]}, None)
    assert box["code"] == 200 and b"M" in box["data"]


def test_mini_graph_update(monkeypatch):
    name, _d = _mkproject("proj_mupd")
    monkeypatch.setattr(graphmap, "update_async", lambda _c: {"building": True})
    h, box = _mini_handler()
    h._api_graph(555, "update", {}, {"project": name})
    assert box["obj"]["building"] is True


def test_mini_graph_defaults_to_active_project(monkeypatch):
    _name, d = _mkproject("proj_mdflt")
    monkeypatch.setattr(mini.state, "project_dir", lambda _c: d)
    monkeypatch.setattr(graphmap, "graph_state", lambda cwd: {"cwd": cwd})
    h, box = _mini_handler()
    h._api_graph(555, "state", {}, None)
    assert box["obj"]["cwd"] == d
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `python3 -m pytest tests/test_graph_endpoints.py -v -k mini`
Expected: FAIL with `AttributeError: ... no attribute '_api_graph'`.

- [ ] **Step 3: Implement** in `bridge/miniapp/server.py`

3a. Add `graphmap` to the `from bridge import ...` list (~line 22).

3b. One handler for all four graph routes (place near `_api_project_settings`):

```python
    def _api_graph(self, chat_id: int, action: str, qs: dict, body: "dict | None"):
        """Graph endpoints share one resolver: explicit ?project= (validated
        under BASE_PATH) else the chat's active project."""
        src = (body or {}).get("project") if body is not None else \
            (qs.get("project", [None])[0])
        cwd = None
        if src:
            cand = os.path.realpath(os.path.join(config.BASE_PATH, str(src).lstrip("/")))
            if browser.within_base(cand) and os.path.isdir(cand):
                cwd = cand
            else:
                return self._json({"error": "invalid project"}, 400)
        cwd = cwd or state.project_dir(chat_id)
        if action == "state":
            return self._json(graphmap.graph_state(cwd))
        if action == "html":
            fp = os.path.join(cwd, graphmap.OUT_DIR, "graph.html")
            if not os.path.isfile(fp):
                return self._json({"error": "no graph"}, 404)
            with open(fp, "rb") as f:
                return self._send_bytes(f.read(), 200, "text/html; charset=utf-8")
        if action == "explain":
            q = (qs.get("q", [""])[0] or "").strip()
            if not q:
                return self._json({"error": "empty query"}, 400)
            return self._json({"text": graphmap.explain(cwd, q)})
        if action == "update":
            return self._json(graphmap.update_async(cwd))
        return self._json({"error": "not found"}, 404)
```

3c. Wire routing — in `do_GET` before the final `return self._json({"error": "not found"}, 404)` (~line 220):

```python
                if path == "/api/graph/state":
                    return self._api_graph(chat_id, "state", qs, None)
                if path == "/api/graph/html":
                    return self._api_graph(chat_id, "html", qs, None)
                if path == "/api/graph/explain":
                    return self._api_graph(chat_id, "explain", qs, None)
```

and in `do_POST` after the `/api/server` line (~line 256):

```python
            if path == "/api/graph/update":
                return self._api_graph(chat_id, "update", {}, body)
```

3d. In `_api_run` (~line 363), mirror Task 8's dashboard change:

```python
        permission_mode = normalize_permission_mode(body.get("permission_mode"))
        ponytail = runner.normalize_ponytail(body.get("ponytail"))
```

and extend the `start_streaming_job` call with `ponytail=ponytail` (after `origin="miniapp"`).

- [ ] **Step 4: Run tests to verify they pass**

Run: `python3 -m pytest tests/test_graph_endpoints.py -v`
Expected: all pass (dashboard + miniapp).

- [ ] **Step 5: Commit**

```bash
git add bridge/miniapp/server.py tests/test_graph_endpoints.py
git commit -m "feat(miniapp): graph endpoints + ponytail run param"
```

---

### Task 10: dashboard web — MAP tab in the PROJECT ANALYSIS modal

**Files:**
- Modify: `bridge/dashboard/web/src/api.ts` (add `GraphState` type + 4 methods on the `api` object ~line 491)
- Create: `bridge/dashboard/web/src/components/hud/MapTab.tsx`
- Modify: `bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx` (Tab union ~line 23, `tabs` array ~line 142, body branches ~line 230, import block)

**Interfaces:**
- Consumes: Task 8's endpoints. `req<T>(path, opts)` is the file-local fetch helper in `api.ts` — copy the call style of the neighboring `api` methods exactly (GETs take a path; POSTs pass `{ method: "POST", body }`).
- Produces: `api.graphState/graphExplain/graphUpdate/graphHtmlUrl`, `<MapTab project={rel} />`.

- [ ] **Step 1: Add the API surface** in `api.ts`

Type, next to the other exported interfaces:

```ts
export interface GraphState {
  available: boolean;
  exists: boolean;
  built_commit: string | null;
  head: string | null;
  stale: boolean;
  building: boolean;
}
```

Methods, inside the `export const api = { ... }` object (match neighbors' style):

```ts
  graphState: (project: string) =>
    req<GraphState>(`/local/graph/state?project=${encodeURIComponent(project)}`),
  graphExplain: (project: string, q: string) =>
    req<{ text: string }>(
      `/local/graph/explain?project=${encodeURIComponent(project)}&q=${encodeURIComponent(q)}`),
  graphUpdate: (project: string) =>
    req<GraphState>("/local/graph/update", { method: "POST", body: { project } }),
  graphHtmlUrl: (project: string) =>
    `/local/graph/html?project=${encodeURIComponent(project)}`,
```

(If `req`'s POST signature differs — check how `api.run` posts — mirror it exactly.)

- [ ] **Step 2: Create `MapTab.tsx`**

```tsx
import { useCallback, useEffect, useRef, useState } from "react";
import { api, type GraphState } from "../../api";

/* MAP tab — the project's graphify knowledge graph (graph.html) inline, with
   staleness header, build/refresh, and a one-line explain query. */

const mono: React.CSSProperties = {
  fontFamily: "'JetBrains Mono',monospace", fontSize: 11, whiteSpace: "pre-wrap",
};

export function MapTab({ project }: { project: string }) {
  const [st, setSt] = useState<GraphState | null>(null);
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState("");
  const [asking, setAsking] = useState(false);
  const [gen, setGen] = useState(0); // bump to reload the iframe after a rebuild
  const timer = useRef<number | null>(null);

  const load = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    api.graphState(project).then((s) => {
      setSt((prev) => {
        if (prev?.building && !s.building) setGen((g) => g + 1);
        return s;
      });
      if (s.building) timer.current = window.setTimeout(load, 1500);
    }).catch(() => setSt(null));
  }, [project]);

  useEffect(() => {
    load();
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [load]);

  const build = () => { api.graphUpdate(project).then(() => load()); };
  const ask = () => {
    const q = query.trim();
    if (!q || asking) return;
    setAsking(true);
    api.graphExplain(project, q)
      .then((r) => setAnswer(r.text))
      .catch((e) => setAnswer(String(e)))
      .finally(() => setAsking(false));
  };

  if (!st) return <div style={{ ...mono, color: "var(--txd)" }}>loading…</div>;
  if (!st.available) {
    return <div style={{ ...mono, color: "var(--txm)" }}>
      graphify is not installed on the bridge machine.{"\n"}pipx install graphifyy
    </div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10, height: "100%" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, flex: "none" }}>
        <span style={{ ...mono, color: "var(--txm)" }}>
          {st.exists ? `BUILT @${st.built_commit ?? "?"}` : "NO MAP YET"}
        </span>
        {st.stale && <span style={{ ...mono, color: "var(--warn, orange)" }}>STALE</span>}
        {st.building && <span style={{ ...mono, color: "var(--acc)" }}>BUILDING…</span>}
        <span style={{ flex: 1 }} />
        <button onClick={build} disabled={st.building}
          style={{ appearance: "none", cursor: st.building ? "default" : "pointer",
            border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)",
            background: "transparent", color: "var(--txm)", fontFamily: "inherit",
            fontSize: 9.5, letterSpacing: 1.5, padding: "4px 10px",
            opacity: st.building ? 0.5 : 1 }}>
          {st.exists ? "REFRESH" : "BUILD MAP"}
        </button>
      </div>
      <div style={{ display: "flex", gap: 8, flex: "none" }}>
        <input value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask()}
          placeholder="explain a file / class / concept…"
          style={{ ...mono, flex: 1, background: "transparent", color: "var(--txb)",
            border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)",
            padding: "5px 8px", outline: "none" }} />
        <button onClick={ask} disabled={asking || !st.exists}
          style={{ appearance: "none", cursor: "pointer", border:
            "1px solid color-mix(in srgb, var(--acc) 25%, transparent)",
            background: "transparent", color: "var(--txm)", fontFamily: "inherit",
            fontSize: 9.5, letterSpacing: 1.5, padding: "4px 10px" }}>
          {asking ? "…" : "EXPLAIN"}
        </button>
      </div>
      {answer && (
        <div className="mscroll" style={{ ...mono, color: "var(--txl)", flex: "none",
          maxHeight: 160, overflowY: "auto", border:
          "1px solid color-mix(in srgb, var(--acc) 12%, transparent)", padding: 8 }}>
          {answer}
        </div>
      )}
      {st.exists ? (
        <iframe key={gen} src={api.graphHtmlUrl(project)} title="project map"
          style={{ flex: 1, minHeight: 340, width: "100%", border:
            "1px solid color-mix(in srgb, var(--acc) 12%, transparent)",
            background: "#0a0a0a" }} />
      ) : (
        <div style={{ ...mono, color: "var(--txd)" }}>
          Build the map to explore this project as an interactive graph.
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Wire it into `AnalyzeModal.tsx`**

Import (with the other hud imports):

```tsx
import { MapTab } from "./MapTab";
```

Extend the Tab union (line 23):

```tsx
type Tab = "overview" | "changes" | "worktrees" | "editor" | "terminal" | "skills" | "issues" | "map";
```

Add to the `tabs` array (line ~142), after `skills`:

```tsx
    { k: "map", l: "MAP" },
```

Add a body branch next to the `skills` one (~line 230):

```tsx
          {tab === "map" && <MapTab project={project} />}
```

- [ ] **Step 4: Verify the build**

Run: `npm --prefix bridge/dashboard/web run build`
Expected: `tsc -b && vite build` completes with no errors.

- [ ] **Step 5: Commit**

```bash
git add bridge/dashboard/web/src/api.ts bridge/dashboard/web/src/components/hud/MapTab.tsx bridge/dashboard/web/src/components/hud/AnalyzeModal.tsx
git commit -m "feat(dashboard/web): MAP tab — graph.html viewer, staleness, build/refresh, explain"
```

---

### Task 11: dashboard web — ponytail picker + quick actions

**Files:**
- Modify: `bridge/dashboard/web/src/components/Composer.tsx` (props ~line 91-99, dropdowns row ~line 238-246)
- Modify: `bridge/dashboard/web/src/App.tsx` (state ~line 68-69, Composer props, run body)

**Interfaces:**
- Consumes: Task 8's `"ponytail"` body param.
- Produces: a `PONYTAIL` dropdown (DEFAULT/OFF/LITE/FULL/ULTRA) + `PT REVIEW` / `PT AUDIT` quick actions.

- [ ] **Step 1: Composer changes**

Add near the `EFFORTS` constant (top of file):

```tsx
const PONYTAILS: { id: string; label: string }[] = [
  { id: "", label: "Default" },
  { id: "off", label: "Off" },
  { id: "lite", label: "Lite" },
  { id: "full", label: "Full" },
  { id: "ultra", label: "Ultra" },
];
```

Add to the Composer props interface (next to `effort`):

```tsx
  ponytail: string;
  onPonytail: (v: string) => void;
```

(and destructure `ponytail, onPonytail` in the component signature next to `effort`.)

Widen the dropdown-state union (line ~118):

```tsx
  const [openDrop, setOpenDrop] = useState<"" | "model" | "effort" | "mode" | "pony">("");
```

Add a `Drop` next to the EFFORT one (~line 244), copying its exact prop pattern:

```tsx
        <Drop label="PONYTAIL" value={ponytail} options={PONYTAILS} open={openDrop === "pony"}
          onToggle={() => setOpenDrop((d) => (d === "pony" ? "" : "pony"))}
          onPick={(v) => { onPonytail(v); setOpenDrop(""); }} />
```

(`Drop` is the file-local dropdown used by MODEL/EFFORT — match its actual prop names; if it renders `options.find(o => o.id === value)?.label`, empty-string id shows "Default".)

- [ ] **Step 2: App.tsx changes**

State, next to model/effort (line 68-69):

```tsx
  const [ponytail, setPonytail] = useState<string>("");
```

Pass to `<Composer …>` alongside `effort`:

```tsx
        ponytail={ponytail} onPonytail={setPonytail}
```

Find where the run request body is built (grep `permission_mode` in `App.tsx` / the submit handler that calls `api.run`) and add:

```tsx
        ponytail: ponytail || undefined,
```

- [ ] **Step 3: Quick actions**

In `Composer.tsx`, next to the dropdowns row, add two buttons that submit fixed prompts through the same path the composer's send uses (the component has a submit callback — reuse it exactly as the send button does):

```tsx
        <button onClick={() => submitText("/ponytail-review")} title="ponytail review of the working tree"
          style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)", background: "transparent", color: "var(--txd)", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "3px 8px" }}>
          PT REVIEW
        </button>
        <button onClick={() => submitText("/ponytail-audit")} title="ponytail repo audit"
          style={{ appearance: "none", cursor: "pointer", border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)", background: "transparent", color: "var(--txd)", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "3px 8px" }}>
          PT AUDIT
        </button>
```

where `submitText(text)` is whatever function the send button invokes with the textarea value — pass the fixed string instead. If no such single-arg path exists, set the textarea value and trigger the existing submit.

- [ ] **Step 4: Verify the build**

Run: `npm --prefix bridge/dashboard/web run build`
Expected: no TS errors.

- [ ] **Step 5: Commit**

```bash
git add bridge/dashboard/web/src/components/Composer.tsx bridge/dashboard/web/src/App.tsx
git commit -m "feat(dashboard/web): ponytail intensity picker + review/audit quick actions"
```

---

### Task 12: miniapp web — map route

**Files:**
- Modify: `bridge/miniapp/web/src/lib/api.ts` (add `GraphState` type + 4 methods on `api`; note the raw-HTML fetch)
- Create: `bridge/miniapp/web/src/routes/map.tsx`
- Modify: `bridge/miniapp/web/src/router.tsx` (import + `routeTree`)
- Modify: `bridge/miniapp/web/src/routes/root.tsx` (nav — add a Map entry wherever the memory/server routes are listed; grep `memory` in root.tsx and mirror its nav item exactly)

**Interfaces:**
- Consumes: Task 9's `/api/graph/*`; `request<T>` and `getInitData()` from `lib/api.ts`.
- Produces: `mapRoute` at path `/map`.

- [ ] **Step 1: API surface** in `lib/api.ts`

```ts
export interface GraphState {
  available: boolean;
  exists: boolean;
  built_commit: string | null;
  head: string | null;
  stale: boolean;
  building: boolean;
}
```

Inside the `api` object (mirror `run`'s style):

```ts
  graphState: () => request<GraphState>("/api/graph/state"),
  graphExplain: (q: string) =>
    request<{ text: string }>(`/api/graph/explain?q=${encodeURIComponent(q)}`),
  graphUpdate: () =>
    request<GraphState>("/api/graph/update", { method: "POST", body: {} }),
  /** graph.html as text — needs the initData header, so no plain iframe src. */
  graphHtml: async (): Promise<string> => {
    const res = await fetch("/api/graph/html", {
      headers: { "X-Telegram-Init-Data": getInitData() },
    });
    if (!res.ok) throw new Error(`graph.html ${res.status}`);
    return res.text();
  },
```

(No `?project=` — the miniapp operates on the chat's active project, same as its other routes. If `getInitData` isn't exported, export it or inline the same lookup the `request` helper uses.)

- [ ] **Step 2: Create `routes/map.tsx`**

```tsx
import { useEffect, useRef, useState } from "react";
import { createRoute } from "@tanstack/react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Map as MapIcon, RefreshCw } from "lucide-react";
import { rootRoute } from "./root";
import { api } from "../lib/api";
import { Button } from "../components/ui";

function MapPage() {
  const qc = useQueryClient();
  const st = useQuery({
    queryKey: ["graphState"],
    queryFn: () => api.graphState(),
    refetchInterval: (q) => (q.state.data?.building ? 1500 : false),
  });
  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [answer, setAnswer] = useState("");
  const lastBuilt = useRef<string | null>(null);

  const s = st.data;
  useEffect(() => {
    if (!s?.exists || s.building) return;
    if (blobUrl && lastBuilt.current === s.built_commit) return;
    lastBuilt.current = s.built_commit;
    api.graphHtml().then((html) => {
      setBlobUrl((old) => {
        if (old) URL.revokeObjectURL(old);
        return URL.createObjectURL(new Blob([html], { type: "text/html" }));
      });
    }).catch(() => setBlobUrl(null));
  }, [s?.exists, s?.building, s?.built_commit]);

  const build = () =>
    api.graphUpdate().then(() => qc.invalidateQueries({ queryKey: ["graphState"] }));
  const ask = () => {
    const q = query.trim();
    if (!q) return;
    api.graphExplain(q).then((r) => setAnswer(r.text)).catch((e) => setAnswer(String(e)));
  };

  if (!s) return <div className="p-4 text-sm opacity-60">Loading…</div>;
  if (!s.available) {
    return <div className="p-4 text-sm">graphify is not installed on the bridge machine
      (<code>pipx install graphifyy</code>).</div>;
  }
  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="flex items-center gap-2 text-xs">
        <MapIcon className="h-4 w-4" />
        <span>{s.exists ? `Built @${s.built_commit ?? "?"}` : "No map yet"}</span>
        {s.stale && <span className="text-amber-500">stale</span>}
        {s.building && <span className="animate-pulse">building…</span>}
        <span className="flex-1" />
        <Button size="sm" variant="outline" disabled={s.building} onClick={build}>
          <RefreshCw className="mr-1 h-3 w-3" />
          {s.exists ? "Refresh" : "Build map"}
        </Button>
      </div>
      <div className="flex gap-2">
        <input value={query} onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && ask()}
          placeholder="explain a file / class / concept…"
          className="flex-1 rounded border bg-transparent px-2 py-1 text-sm" />
        <Button size="sm" variant="outline" disabled={!s.exists} onClick={ask}>Explain</Button>
      </div>
      {answer && (
        <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap rounded border p-2 text-xs">
          {answer}
        </pre>
      )}
      {s.exists && blobUrl ? (
        <iframe src={blobUrl} title="project map" className="min-h-72 w-full flex-1 rounded border" />
      ) : (
        <div className="text-xs opacity-60">Build the map to explore the project as a graph.</div>
      )}
    </div>
  );
}

export const mapRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/map",
  component: MapPage,
});
```

(If `Button` isn't exported from `../components/ui`, use the same primitive the memory route uses for its actions.)

- [ ] **Step 3: Register the route**

In `router.tsx`: `import { mapRoute } from "./routes/map";` and add `mapRoute,` to `rootRoute.addChildren([...])` after `memoryRoute`. In `routes/root.tsx`, add a Map nav entry mirroring the memory route's nav item (same component, `to: "/map"`, `MapIcon`).

- [ ] **Step 4: Verify the build**

Run: `npm --prefix bridge/miniapp/web run build`
Expected: no TS errors.

- [ ] **Step 5: Commit**

```bash
git add bridge/miniapp/web/src/lib/api.ts bridge/miniapp/web/src/routes/map.tsx bridge/miniapp/web/src/router.tsx bridge/miniapp/web/src/routes/root.tsx
git commit -m "feat(miniapp/web): map route — graph viewer, build/refresh, explain"
```

---

### Task 13: miniapp web — ponytail picker + quick actions

**Files:**
- Modify: `bridge/miniapp/web/src/components/Composer.tsx` (clone the EFFORT DropdownMenu block ~lines 100-120)
- Modify: `bridge/miniapp/web/src/lib/api.ts` (`run` signature ~line 412)
- Modify: `bridge/miniapp/web/src/routes/run.tsx` (thread the value into the composer + the `api.run` call, persisted the same way model/effort are)

**Interfaces:**
- Consumes: Task 9's `"ponytail"` body param.
- Produces: Ponytail selector in the Mini App composer toolbar + two quick actions.

- [ ] **Step 1: `api.run` gains the param**

```ts
  run: (
    prompt: string,
    images: string[],
    project: string | undefined,
    sessionId: string,
    model?: string,
    effort?: string,
    permission?: string,
    ponytail?: string,
  ) =>
    request<RunStartResponse>("/api/run", {
      method: "POST",
      body: { prompt, images, project, session_id: sessionId, model, effort,
              permission_mode: permission || undefined,
              ponytail: ponytail || undefined },
    }),
```

Update every caller of `api.run` (grep `api.run(`) to pass the new final argument.

- [ ] **Step 2: Composer selector**

In `components/Composer.tsx`, add next to the `EFFORTS` constant:

```tsx
const PONYTAILS: { id: string; label: string }[] = [
  { id: "", label: "Default" },
  { id: "off", label: "Off" },
  { id: "lite", label: "Lite" },
  { id: "full", label: "Full" },
  { id: "ultra", label: "Ultra" },
];
```

Add `ponytail: string` + `onPonytail: (v: string) => void` to the composer's props (next to `effort`), and clone the entire Effort `DropdownMenu` block (trigger label `Ponytail: {label}`, a `DropdownMenuRadioGroup` over `PONYTAILS`, `value={ponytail || ""}`, calling `onPonytail`). Keep shadcn components identical to the effort block.

- [ ] **Step 3: Wire in `routes/run.tsx`**

Hold the value exactly the way `model`/`effort` are held (same `useState`/persistent-state helper — grep `effort` in run.tsx and copy its storage pattern), pass `ponytail`/`onPonytail` into `<Composer …>`, and pass the value as the new last argument of the `api.run(...)` call.

Quick actions: next to where the composer is rendered (or in the composer toolbar), two small buttons that send fixed prompts through the exact function the send button uses:

```tsx
  <Button size="sm" variant="ghost" onClick={() => sendPrompt("/ponytail-review")}>PT review</Button>
  <Button size="sm" variant="ghost" onClick={() => sendPrompt("/ponytail-audit")}>PT audit</Button>
```

where `sendPrompt(text)` is the run route's existing submit path invoked with a fixed string.

- [ ] **Step 4: Verify the build**

Run: `npm --prefix bridge/miniapp/web run build`
Expected: no TS errors.

- [ ] **Step 5: Commit**

```bash
git add bridge/miniapp/web/src/components/Composer.tsx bridge/miniapp/web/src/lib/api.ts bridge/miniapp/web/src/routes/run.tsx
git commit -m "feat(miniapp/web): ponytail picker + review/audit quick actions"
```

---

### Task 14: hygiene, slash-command verification, dists, full suite

**Files:**
- Modify: `.gitignore` (repo root — create if missing)
- Modify: `README.md` (Features list)
- Modify: `bridge/dashboard/web/dist/*`, `bridge/miniapp/web/dist/*` (rebuild artifacts)

- [ ] **Step 1: gitignore this repo's own graph artifacts**

Append `graphify-out/` to the repo-root `.gitignore`. Run `git status --short | grep graphify` — expected: no `graphify-out/` in untracked output.

- [ ] **Step 2: Verify plugin slash commands expand under `-p`** (quick-action assumption)

Run: `claude -p "/ponytail-help" --model haiku --output-format json 2>&1 | head -c 600`
Expected: JSON whose `result` describes ponytail (modes/commands) — proves plugin commands expand in print mode.
If instead it answers as if "/ponytail-help" were literal prose: change the two quick-action strings in Tasks 11 & 13 to `"Use the ponytail-review skill on the current working-tree diff."` and `"Use the ponytail-audit skill on this repository."` and note it in the commit message.

- [ ] **Step 3: README feature bullets**

In `README.md`'s Features list, after the **Dev server + preview** bullet, add:

```markdown
- **Project map.** Build a tree-sitter knowledge graph of the active repo
  (graphify, zero tokens) and explore it as an interactive graph — MAP tab in
  the dashboard's project analysis, a map view in the Mini App, `/map` in the
  bot. Fresh graphs auto-refresh after turns; a compact structure summary is
  injected into every turn's system prompt.
- **Ponytail dial.** Per-run code-minimalism intensity (off/lite/full/ultra)
  next to the model/effort pickers, plus one-tap `/ponytail-review` and
  `/ponytail-audit` quick actions.
```

- [ ] **Step 4: Rebuild both dists**

Run: `npm --prefix bridge/dashboard/web run build && npm --prefix bridge/miniapp/web run build`
Expected: both succeed; `git status` shows dist changes.

- [ ] **Step 5: Full backend suite**

Run: `python3 -m pytest tests/ -q`
Expected: everything added by this plan passes. Known pre-existing flakes: the suite historically has 2-6 env-leak/test-isolation failures unrelated to this work — re-run any suspect **in isolation** (`python3 -m pytest tests/test_x.py -v`) before treating it as a regression.

- [ ] **Step 6: Commit**

```bash
git add .gitignore README.md bridge/dashboard/web/dist bridge/miniapp/web/dist
git commit -m "build(web): rebuild dists; docs + gitignore for graphify/ponytail features"
```

- [ ] **Step 7: Hand off**

Merge/PR decision via superpowers:finishing-a-development-branch. The bridge must be **restarted by the user** to load the backend (restart kills bridge-hosted sessions — coordinate first). After restart: `/map build` in Telegram, open the dashboard MAP tab, pick a ponytail level, and send one run to see `PONYTAIL_DEFAULT_MODE` take effect.
