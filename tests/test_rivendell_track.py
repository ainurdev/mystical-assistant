"""A session in a repo on a Rivendell board finds or files the task for its work
(docs/superpowers/specs/rivendell-unplanned-tasks.md): the goals MCP's two
Rivendell tools here, and the runner's note. What matters is reach. The tools
and the note go only where they can work: Rivendell connected, the RIVENDELL
TASKS switch on, and never one of Rivendell's own unattended runs, which have
nobody to answer the card.
Run: python -m pytest tests/test_rivendell_track.py -v"""

import json
import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import aifeatures, goal_mcp, integrations, rivendell, rivendell_instances, runner, store  # noqa: E402

store.init()

RV_TOOLS = {"ListRivendellTasks", "CreateRivendellTask"}


def _names():
    out = goal_mcp._handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})  # noqa: SLF001
    return {t["name"] for t in out["result"]["tools"]}


def test_rivendell_tools_are_listed_only_where_they_can_work(monkeypatch):
    monkeypatch.setattr(goal_mcp, "_rivendell_on", lambda: True)
    assert RV_TOOLS <= _names()
    monkeypatch.setattr(goal_mcp, "_rivendell_on", lambda: False)
    assert not RV_TOOLS & _names()


@pytest.fixture
def connected(monkeypatch):
    """Rivendell installed with one enabled connection, the switch on, and the
    tool server bound to an ordinary dashboard session."""
    monkeypatch.setattr(integrations, "installed", lambda pid: pid == "rivendell")
    monkeypatch.setattr(rivendell_instances, "instances", lambda: [{"id": "a", "enable": True}])
    monkeypatch.setattr(aifeatures, "enabled", lambda key: key == "rvtrack")
    s = store.create_session(555, "/app")
    store.set_claude_session_id(s["id"], "csid-" + s["id"])
    monkeypatch.setenv("MYSTICAL_CLAUDE_SESSION_ID", "csid-" + s["id"])
    return s


@pytest.mark.parametrize("missing", ["installed", "connection", "switch", "user session", "binding"])
def test_rivendell_on_needs_install_connection_switch_and_a_user_session(connected, monkeypatch, missing):
    assert goal_mcp._rivendell_on() is True                       # noqa: SLF001
    if missing == "installed":
        monkeypatch.setattr(integrations, "installed", lambda pid: False)
    elif missing == "connection":
        monkeypatch.setattr(rivendell_instances, "instances", lambda: [{"id": "a", "enable": False}])
    elif missing == "switch":
        monkeypatch.setattr(aifeatures, "enabled", lambda key: False)
    elif missing == "user session":
        store.set_origin(connected["id"], "rivendell:a")
    else:
        monkeypatch.delenv("MYSTICAL_CLAUDE_SESSION_ID")
    assert goal_mcp._rivendell_on() is False                      # noqa: SLF001


def test_the_rivendell_tools_post_to_the_bridge(monkeypatch):
    seen = []

    class R:
        def __enter__(self): return self
        def __exit__(self, *a): return False
        def read(self): return b'{"text": "Created NRA-74"}'

    def fake_open(req, timeout=0):
        seen.append((req.full_url, json.loads(req.data), req.get_header("X-dash-token")))
        return R()
    monkeypatch.setattr(goal_mcp.urllib.request, "urlopen", fake_open)
    monkeypatch.setenv("MYSTICAL_DASH", "http://127.0.0.1:1")
    monkeypatch.setenv("MYSTICAL_DASH_TOKEN", "tok")
    monkeypatch.setenv("MYSTICAL_CLAUDE_SESSION_ID", "csid-x")
    assert goal_mcp._rivendell("CreateRivendellTask", {"title": "T", "action": "list"}) == "Created NRA-74"  # noqa: SLF001
    goal_mcp._rivendell("ListRivendellTasks", {"repo": "apex"})  # noqa: SLF001
    assert seen == [
        ("http://127.0.0.1:1/local/rivendell/work",
         {"action": "create", "title": "T", "claude_session_id": "csid-x"}, "tok"),
        ("http://127.0.0.1:1/local/rivendell/work",
         {"action": "list", "repo": "apex", "claude_session_id": "csid-x"}, "tok")]


# --- the runner's note -----------------------------------------------------------

@pytest.fixture
def note(monkeypatch):
    """The RIVENDELL TASKS switch on, a fresh per-session memo, and on_board
    answering state["on"] while counting its calls."""
    state = {"switch": True, "on": True, "calls": 0}
    monkeypatch.setattr(aifeatures, "enabled", lambda key: key == "rvtrack" and state["switch"])

    def on_board(path, wait=2.0):
        state["calls"] += 1
        return state["on"]
    monkeypatch.setattr(rivendell, "on_board", on_board)
    monkeypatch.setattr(runner, "_rivendell_notes", {})
    return state


def _appended(csid, **kw):
    """The appended system prompt an interactive run of session `csid` gets."""
    kw = {"interactive": True, "claude_session_id": csid, **kw}
    with tempfile.TemporaryDirectory() as d:
        cmd = runner._base_cmd("hi", 555, stream=True, cwd=d, **kw)
    return cmd[cmd.index("--append-system-prompt") + 1]


def test_a_session_in_a_repo_on_a_board_gets_the_note(note):
    assert runner._RIVENDELL_NOTE in _appended("c-1")


def test_no_note_without_a_board(note):
    note["on"] = False
    assert runner._RIVENDELL_NOTE not in _appended("c-1")


def test_no_note_for_rivendells_own_runs(note):
    s = store.create_session(555, "/app", origin="rivendell:a")
    store.set_claude_session_id(s["id"], "c-rv")
    assert runner._RIVENDELL_NOTE not in _appended("c-rv")
    assert note["calls"] == 0


def test_no_note_while_the_switch_is_off(note):
    note["switch"] = False
    assert runner._RIVENDELL_NOTE not in _appended("c-1")
    assert note["calls"] == 0


def test_the_note_is_decided_once_per_session(note):
    assert runner._RIVENDELL_NOTE in _appended("c-1")
    note["on"] = False                  # a board unlinked, or Rivendell down, mid-session
    assert runner._RIVENDELL_NOTE in _appended("c-1")
    assert note["calls"] == 1
    assert runner._RIVENDELL_NOTE not in _appended("c-2")


def test_switching_off_mid_session_drops_the_note_next_turn(note):
    assert runner._RIVENDELL_NOTE in _appended("c-1")
    note["switch"] = False
    assert runner._RIVENDELL_NOTE not in _appended("c-1")
    note["switch"] = True
    assert runner._RIVENDELL_NOTE in _appended("c-1")
    assert note["calls"] == 1


def test_one_shots_and_bot_runs_never_get_the_note(note):
    assert runner._RIVENDELL_NOTE not in _appended("c-1", skip_pack=True)
    assert runner._RIVENDELL_NOTE not in _appended("c-1", interactive=False)
    assert note["calls"] == 0
