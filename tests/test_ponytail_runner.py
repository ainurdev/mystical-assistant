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
