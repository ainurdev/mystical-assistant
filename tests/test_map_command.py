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
