"""HTTP surface for per-session tool switches and the API inspector. Driven
without sockets via Handler.__new__ (mirrors test_fallback_endpoints.py)."""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("ACCOUNTS_DIR", os.path.join(tempfile.mkdtemp(), "accounts"))

from bridge import inspector, store, toolsets  # noqa: E402
from bridge.dashboard import server as dash  # noqa: E402

store.init()
CHAT = 555


def _handler():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


def _no_mcp(monkeypatch):
    """Don't shell out to `claude mcp list` from a test."""
    monkeypatch.setattr(toolsets, "servers", lambda *a, **k: [{"rule": "mcp__github",
                                                              "name": "github",
                                                              "ok": True, "status": "✔"}])


def test_toolsets_endpoint_lists_what_can_be_switched(monkeypatch):
    _no_mcp(monkeypatch)
    h, box = _handler()
    h._get_api("/local/toolsets", {})
    assert box["code"] == 200
    assert {b["rule"] for b in box["obj"]["builtins"]} >= {"Bash", "WebSearch"}
    assert box["obj"]["servers"][0]["rule"] == "mcp__github"


def test_setting_a_sessions_tools_persists_and_reaches_the_next_run(monkeypatch):
    _no_mcp(monkeypatch)
    s = store.create_session(CHAT, "/tools1")
    h, box = _handler()
    h._post_api(f"/local/sessions/{s['id']}/tools",
                {"disabled_tools": ["Bash", "mcp__github"]})
    assert box["code"] == 200
    assert store.get_disabled_tools(s["id"]) == ["Bash", "mcp__github"]


def test_unknown_rules_never_reach_the_command_line(monkeypatch):
    _no_mcp(monkeypatch)
    s = store.create_session(CHAT, "/tools2")
    h, box = _handler()
    h._post_api(f"/local/sessions/{s['id']}/tools",
                {"disabled_tools": ["Bash", "--dangerously-skip-permissions"]})
    assert box["obj"]["disabled_tools"] == ["Bash"]
    assert store.get_disabled_tools(s["id"]) == ["Bash"]


def test_a_foreign_session_is_404_not_a_write(monkeypatch):
    _no_mcp(monkeypatch)
    s = store.create_session(999, "/tools3")
    h, box = _handler()
    h._post_api(f"/local/sessions/{s['id']}/tools", {"disabled_tools": ["Bash"]})
    assert box["code"] == 404
    assert store.get_disabled_tools(s["id"]) == []


def test_inspector_endpoint_starts_and_stops_the_proxy():
    h, box = _handler()
    h._get_api("/local/inspector", {})
    assert box["obj"]["on"] is False and box["obj"]["base_url"] is None
    try:
        h._post_api("/local/inspector", {"action": "on"})
        assert box["obj"]["on"] is True
        assert box["obj"]["base_url"].startswith("http://127.0.0.1:")
        h._get_api("/local/inspector", {})
        assert box["obj"]["on"] is True and box["obj"]["entries"] == []
    finally:
        h._post_api("/local/inspector", {"action": "off"})
    assert box["obj"]["on"] is False
    assert inspector.base_url() is None


def test_inspector_rejects_an_unknown_action():
    h, box = _handler()
    h._post_api("/local/inspector", {"action": "explode"})
    assert box["code"] == 400
    assert not inspector.running()
