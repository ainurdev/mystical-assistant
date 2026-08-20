"""HTTP surface for MCP server management. Driven without sockets via
Handler.__new__ (mirrors test_toolset_endpoints.py). `claude mcp` is stubbed
throughout — no test shells out to the real CLI."""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("ACCOUNTS_DIR", os.path.join(tempfile.mkdtemp(), "accounts"))

import pytest  # noqa: E402

from bridge import mcp, toolsets  # noqa: E402
from bridge.dashboard import server as dash  # noqa: E402

SERVERS = [{"name": "attio", "rule": "mcp__attio", "ok": False,
            "status": "! Needs authentication", "target": "https://mcp.attio.com/mcp (HTTP)"}]


def _handler():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


@pytest.fixture
def cli(monkeypatch):
    calls, rc, err = [], [0], [""]
    monkeypatch.setattr(mcp, "_run", lambda *a: (calls.append(a), (rc[0], "", err[0]))[1])
    monkeypatch.setattr(toolsets, "servers", lambda refresh=False: SERVERS)
    monkeypatch.setattr(toolsets, "invalidate", lambda: None)
    return calls, rc, err


def test_the_panel_gets_servers_and_what_it_may_offer(cli):
    h, box = _handler()
    h._get_api("/local/mcp", {})
    assert box["code"] == 200
    assert box["obj"]["servers"] == SERVERS
    assert box["obj"]["pending"] is None
    assert "user" in box["obj"]["scopes"] and "stdio" in box["obj"]["transports"]


def test_refresh_forces_the_health_check(cli, monkeypatch):
    asked = []
    monkeypatch.setattr(toolsets, "servers",
                        lambda refresh=False: asked.append(refresh) or SERVERS)
    h, _ = _handler()
    h._get_api("/local/mcp", {})
    h._get_api("/local/mcp", {"refresh": ["1"]})
    assert asked == [False, True]


def test_adding_a_server_shells_out_and_returns_the_fresh_list(cli):
    calls, _, _ = cli
    h, box = _handler()
    h._post_api("/local/mcp", {"action": "add", "name": "attio",
                               "target": "https://mcp.attio.com/mcp",
                               "transport": "http", "scope": "user"})
    assert box["code"] == 200 and box["obj"]["ok"] is True
    assert calls[0] == ("add", "--transport", "http", "--scope", "user",
                        "attio", "https://mcp.attio.com/mcp")
    assert box["obj"]["servers"] == SERVERS


def test_a_cli_failure_is_a_400_carrying_its_own_words(cli):
    _, rc, err = cli
    rc[0], err[0] = 1, "No MCP server found with name: nope"
    h, box = _handler()
    h._post_api("/local/mcp", {"action": "remove", "name": "nope"})
    assert box["code"] == 400
    assert box["obj"]["error"] == "No MCP server found with name: nope"


def test_removing_and_logging_out_reach_the_right_subcommand(cli):
    calls, _, _ = cli
    h, _ = _handler()
    h._post_api("/local/mcp", {"action": "remove", "name": "attio"})
    h._post_api("/local/mcp", {"action": "logout", "name": "attio"})
    assert calls == [("remove", "attio"), ("logout", "attio")]


def test_an_unknown_action_is_a_400_not_a_call(cli):
    calls, _, _ = cli
    h, box = _handler()
    h._post_api("/local/mcp", {"action": "explode", "name": "attio"})
    assert box["code"] == 400 and "explode" in box["obj"]["error"]
    assert calls == []


def test_login_begin_surfaces_its_error_as_a_400(cli, monkeypatch):
    monkeypatch.setattr(mcp, "begin_login", lambda name: {"error": "no such server"})
    h, box = _handler()
    h._post_api("/local/mcp", {"action": "login_begin", "name": "nope"})
    assert box["code"] == 400 and box["obj"]["error"] == "no such server"


def test_login_begin_hands_back_the_url_to_open(cli, monkeypatch):
    monkeypatch.setattr(mcp, "begin_login",
                        lambda name: {"name": name, "url": "https://auth.example/x"})
    h, box = _handler()
    h._post_api("/local/mcp", {"action": "login_begin", "name": "attio"})
    assert box["obj"] == {"ok": True, "name": "attio", "url": "https://auth.example/x"}


def test_a_pasted_redirect_url_goes_to_the_waiting_login(cli, monkeypatch):
    got = []
    monkeypatch.setattr(mcp, "submit_login", lambda url: (got.append(url), (True, ""))[1])
    h, box = _handler()
    h._post_api("/local/mcp", {"action": "login_submit", "url": "https://cb/?code=1"})
    assert got == ["https://cb/?code=1"]
    assert box["code"] == 200 and box["obj"]["servers"] == SERVERS


def test_cancelling_tears_the_login_down(cli, monkeypatch):
    killed = []
    monkeypatch.setattr(mcp, "cancel_login", lambda: killed.append(True))
    h, box = _handler()
    h._post_api("/local/mcp", {"action": "login_cancel"})
    assert killed == [True] and box["obj"] == {"ok": True}
