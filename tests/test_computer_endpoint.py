"""The dashboard's computer-use routes: GET/POST /local/sessions/<sid>/computer
(the Tools row and STOP), POST /local/computer/call (the MCP relay) and POST
/local/computer/app (Mystical.app's pull). Logic is tests/test_computer.py."""
import json
import subprocess
import sys

import pytest

from bridge import computer, config, store
from bridge.dashboard import server as dash

store.init()
CHAT = config.DASH_CHAT_ID


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    computer._reset_for_tests()
    monkeypatch.setattr(computer, "available", lambda: True)
    monkeypatch.setattr(computer, "PULL_WAIT", 0.05)
    yield
    computer._reset_for_tests()


def _h():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


def test_the_switch_reads_and_flips_per_chat():
    sid = store.create_session(CHAT, "/proj", cwd="/tmp")["id"]
    h, box = _h()
    h._get_api(f"/local/sessions/{sid}/computer", {})
    assert box["obj"]["on"] is False and box["obj"]["available"] is True
    h._post_api(f"/local/sessions/{sid}/computer", {"on": True})
    assert box["obj"]["on"] is True and computer.enabled(sid)
    h._post_api(f"/local/sessions/{sid}/computer", {"stop": True})
    assert box["code"] == 200
    h._post_api(f"/local/sessions/{sid}/computer", {"on": False})
    assert box["obj"]["on"] is False


def test_switching_on_is_refused_off_a_mac(monkeypatch):
    monkeypatch.setattr(computer, "available", lambda: False)
    sid = store.create_session(CHAT, "/proj", cwd="/tmp")["id"]
    h, box = _h()
    h._post_api(f"/local/sessions/{sid}/computer", {"on": True})
    assert box["code"] == 409 and not computer.enabled(sid)


def test_another_chats_switch_is_not_found():
    h, box = _h()
    h._get_api("/local/sessions/nope/computer", {})
    assert box["code"] == 404


def test_the_relay_and_the_app_reach_the_module():
    h, box = _h()
    h._post_api("/local/computer/call", {"claude_session_id": "nobody", "name": "screenshot"})
    assert box["obj"]["isError"]
    h._post_api("/local/computer/app", {"perms": {"screen": True, "accessibility": False, "signed": "Mystical Local"}})
    assert box["obj"] == {"orders": [], "driving": False}
    assert computer.app_online()


def test_the_relay_lists_claudes_tool_names_and_forwards_calls():
    """computer_mcp over real stdio: the names Claude knows, no switch_display."""
    p = subprocess.run([sys.executable, "-m", "bridge.computer_mcp"], capture_output=True, text=True, timeout=20,
                       input="\n".join(json.dumps(m) for m in (
                           {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}},
                           {"jsonrpc": "2.0", "id": 2, "method": "tools/list"},
                           {"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {"name": "screenshot"}})),
                       env={"PYTHONPATH": ".", "MYSTICAL_DASH": "http://127.0.0.1:9"})
    out = [json.loads(line) for line in p.stdout.splitlines()]
    names = {t["name"] for t in out[1]["result"]["tools"]}
    assert {"request_access", "screenshot", "left_click", "type", "key", "computer_batch"} <= names
    assert "switch_display" not in names and len(names) == 23
    assert out[2]["result"]["isError"] and "Could not reach the bridge" in out[2]["result"]["content"][0]["text"]
