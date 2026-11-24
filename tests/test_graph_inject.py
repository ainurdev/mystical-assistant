"""Graph pack rides --append-system-prompt.
Run: python -m pytest tests/test_graph_inject.py -v"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import runner  # noqa: E402


def _sysprompt(cmd: list) -> str:
    return cmd[cmd.index("--append-system-prompt") + 1]


def test_appended_prompt_has_no_graph_pack(monkeypatch):
    """Every step of a turn re-read it and sessions never used it; the nightly
    digest still rides along."""
    monkeypatch.setattr(runner, "_graph_pack_for", lambda *a: "# Project map\nX")
    monkeypatch.setattr(runner, "_dream_pack_for", lambda *a: "# Nightly digest\nY")
    for kw in ({}, {"interactive": True, "claude_session_id": "33333333-2222-3333-4444-555555555555"}):
        prompt = _sysprompt(runner._base_cmd("hi", 555, stream=bool(kw), **kw))
        assert "# Project map" not in prompt
        assert "# Nightly digest" in prompt


def test_skip_pack_skips_graph_too(monkeypatch):
    monkeypatch.setattr(runner, "_graph_pack_for", lambda *a: "# Project map\nX")
    cmd = runner._base_cmd("hi", 555, stream=False, skip_pack=True)
    assert "# Project map" not in _sysprompt(cmd)


def test_graph_pack_for_swallows_errors(monkeypatch):
    from bridge import graphmap
    monkeypatch.setattr(graphmap, "graph_pack",
                        lambda _cwd: (_ for _ in ()).throw(RuntimeError("boom")))
    assert runner._graph_pack_for(555, "/tmp") == ""


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
