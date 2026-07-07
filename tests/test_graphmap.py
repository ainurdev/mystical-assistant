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
