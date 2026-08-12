"""Ponytail intensity plumbing: validation + PONYTAIL_DEFAULT_MODE env.
Run: python -m pytest tests/test_ponytail_runner.py -v"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

from bridge import aifeatures, runner  # noqa: E402


@pytest.fixture(autouse=True)
def _ponytail_on(monkeypatch):
    """These are about the level plumbing, not the AI-tab switch — pin it on so
    a bridge with ponytail switched off doesn't turn the suite red."""
    monkeypatch.setattr(aifeatures, "enabled", lambda k: True)


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


# --- multi-account: the same seam carries CLAUDE_CONFIG_DIR -------------------

def test_run_env_inherits_for_the_default_account():
    """Slot 1 is the ambient ~/.claude login — nothing to override."""
    assert runner._run_env(None, account_slot=1) is None


def test_run_env_points_claude_at_a_chosen_account():
    from bridge import accounts
    env = runner._run_env(None, account_slot=2)
    assert env["CLAUDE_CONFIG_DIR"] == accounts.profile_dir(2)
    assert env["PATH"] == os.environ["PATH"]       # still the full inherited env


def test_run_env_combines_an_account_with_a_ponytail_mode():
    env = runner._run_env("ultra", account_slot=3)
    assert env["PONYTAIL_DEFAULT_MODE"] == "ultra"
    assert "CLAUDE_CONFIG_DIR" in env


def test_switched_off_forces_the_plugin_off(monkeypatch):
    """Absent means the plugin's own default (full), so off has to be said out
    loud — and it beats whatever level the run asked for."""
    monkeypatch.setattr(aifeatures, "enabled", lambda k: k != "ponytail")
    assert runner._run_env(None)["PONYTAIL_DEFAULT_MODE"] == "off"
    assert runner._run_env("ultra")["PONYTAIL_DEFAULT_MODE"] == "off"


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
    monkeypatch.setattr(runner, "_graph_pack_for", lambda *a, **k: "", raising=False)
    monkeypatch.setattr(runner.state, "project_dir", lambda _c: os.getcwd())
    runner.run_blocking(555, "hi", ponytail="ultra")
    assert captured["env"]["PONYTAIL_DEFAULT_MODE"] == "ultra"
    runner.run_blocking(555, "hi")
    assert captured["env"] is None
