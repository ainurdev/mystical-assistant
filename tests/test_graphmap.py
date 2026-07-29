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
                  "built_at": None, "head": None, "stale": False, "building": False}


def test_state_wrong_shape_json_is_harmless(tmp_path, monkeypatch):
    monkeypatch.setattr(graphmap, "graphify_bin", lambda: None)
    d = _mkrepo(tmp_path)
    out = os.path.join(d, graphmap.OUT_DIR)
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "graph.json"), "w") as f:
        json.dump([], f)
    st = graphmap.graph_state(d)
    assert st["built_commit"] is None
    assert st["exists"] is True


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


# --- update / exclude / refresh ---------------------------------------------

_real_subprocess_run = subprocess.run  # Save before any monkeypatching


def _fake_update_ok(d):
    """A subprocess.run stub that fabricates graphify's output artifact."""
    def run(cmd, cwd=None, **k):
        # Only intercept graphify commands; let git commands through to the real subprocess
        if cmd and "graphify" in str(cmd[0]):
            _write_graph(cwd, _head8(cwd))
            class P:
                returncode = 0
                stdout = "Code graph updated."
                stderr = ""
            return P()
        # For non-graphify commands (e.g., git), use the real subprocess
        return _real_subprocess_run(cmd, cwd=cwd, **k)
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


def test_refresh_async_noop_without_repo(tmp_path, monkeypatch):
    d = str(tmp_path / "plain")
    os.makedirs(d)
    monkeypatch.setattr(graphmap, "graphify_bin", lambda: "/usr/bin/graphify")
    called = []
    monkeypatch.setattr(graphmap.threading, "Thread",
                        lambda *a, **k: called.append(1) or _NopThread())
    graphmap.refresh_async(d)          # not a repo, no graph -> must not spawn
    assert called == []
    graphmap.refresh_async(None)       # no cwd -> must not spawn
    assert called == []


def test_refresh_async_builds_first_map_in_a_repo(tmp_path, monkeypatch):
    """First turn in a mapped-never project builds the graph (full-build timeout)."""
    d = _mkrepo(tmp_path)
    monkeypatch.setattr(graphmap, "graphify_bin", lambda: "/usr/bin/graphify")
    spawned = {}

    class FakeThread:
        def __init__(self, target=None, args=(), daemon=None):
            spawned["args"] = args
        def start(self):
            spawned["started"] = True
    monkeypatch.setattr(graphmap.threading, "Thread", FakeThread)
    graphmap.refresh_async(d)
    assert spawned.get("started") and spawned["args"] == (d, graphmap.BUILD_TIMEOUT)


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


def test_update_async_fires_thread_and_returns_state(tmp_path, monkeypatch):
    d = _mkrepo(tmp_path)
    monkeypatch.setattr(graphmap, "graphify_bin", lambda: "/usr/bin/graphify")
    spawned = {}

    class FakeThread:
        def __init__(self, target=None, args=(), daemon=None):
            spawned["target"] = target
            spawned["args"] = args

        def start(self):
            spawned["started"] = True

    monkeypatch.setattr(graphmap.threading, "Thread", FakeThread)
    st = graphmap.update_async(d, 42)
    assert spawned["target"] is graphmap.update
    assert spawned["args"] == (d, 42)
    assert spawned.get("started") is True
    assert set(st) == {"available", "exists", "built_commit", "built_at", "head",
                       "stale", "building"}
    assert st["building"] is True   # forced True so a poller doesn't render stale graph


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
    nodes = [{"id": f"n{i}", "label": "x" * 200, "community": i,
              "metadata": {"kind": "file"}} for i in range(60)]
    with open(os.path.join(out, "graph.json"), "w") as f:
        json.dump({"built_at_commit": "c", "nodes": nodes, "links": []}, f)
    pack = graphmap.graph_pack(d)
    assert pack != ""
    assert (len(pack) + 3) // 4 <= graphmap.PACK_TOKEN_BUDGET


def test_pack_corrupt_json_is_empty(tmp_path):
    d = _mkrepo(tmp_path)
    out = os.path.join(d, graphmap.OUT_DIR)
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "graph.json"), "w") as f:
        f.write("{nope")
    assert graphmap.graph_pack(d) == ""


def test_pack_wrong_shape_json_is_empty(tmp_path):
    d = _mkrepo(tmp_path)
    out = os.path.join(d, graphmap.OUT_DIR)
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "graph.json"), "w") as f:
        json.dump([], f)
    assert graphmap.graph_pack(d) == ""


def test_pack_malformed_node_metadata_is_empty(tmp_path):
    d = _mkrepo(tmp_path)
    out = os.path.join(d, graphmap.OUT_DIR)
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "graph.json"), "w") as f:
        json.dump({"nodes": [{"id": "a", "community": 0, "metadata": "oops"}],
                   "links": []}, f)
    assert graphmap.graph_pack(d) == ""
    assert graphmap.graph_pack(d) == ""          # repeat: served from cache


def test_pack_string_node_is_empty(tmp_path):
    d = _mkrepo(tmp_path)
    out = os.path.join(d, graphmap.OUT_DIR)
    os.makedirs(out, exist_ok=True)
    with open(os.path.join(out, "graph.json"), "w") as f:
        json.dump({"nodes": ["just-a-string"], "links": []}, f)
    assert graphmap.graph_pack(d) == ""
