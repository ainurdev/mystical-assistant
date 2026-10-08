"""Task 9: the dashboard's ACP agent routes — GET /local/acp/agents
(acp_agents.api_info) and POST /local/acp/accounts, /local/acp/test
(acp_agents.api_account/api_test). The TEST route runs against
tests/fake_acp_agent.py, as tests/test_acp_runner.py does. Spec safety rule 2:
no response ever carries a raw key.

Renamed off the brief's /local/agents* paths on purpose: those already serve
the Claude subagent viewer (bridge/dashboard/server.py ~672-688, a different
feature). test_existing_subagent_route_is_not_shadowed guards the two don't
collide.
"""
import json
import os
import sys

import pytest

from bridge import acp_agents, config, store
from bridge.dashboard import server as dash

store.init()
FAKE = os.path.join(os.path.dirname(__file__), "fake_acp_agent.py")
KEY = "sk-abcdefghijklmnopqrstuvwxyz"


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(acp_agents, "ACCOUNTS_FILE", str(tmp_path / "agent-accounts.json"))
    monkeypatch.setattr(acp_agents, "OPTIONS_FILE", str(tmp_path / "acp-options.json"))
    monkeypatch.setattr(acp_agents, "HOMES", str(tmp_path / "agent-homes"))
    monkeypatch.setattr(acp_agents, "_options", {})


def _handler():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


def test_create_key_account_is_masked_with_no_raw_key():
    h, box = _handler()
    h._post_api("/local/acp/accounts",
               {"action": "create", "agent": "codex", "label": "work",
                "kind": "key", "key": KEY})
    assert box["code"] == 200
    assert box["obj"]["account"]["agent"] == "codex"
    assert KEY not in json.dumps(box["obj"])


def test_create_home_account_says_how_to_sign_it_in():
    h, box = _handler()
    h._post_api("/local/acp/accounts",
               {"action": "create", "agent": "codex", "label": "alt", "kind": "home"})
    a = box["obj"]["account"]
    assert box["code"] == 200
    assert box["obj"]["login_hint"].endswith(f"CODEX_HOME={acp_agents.home_dir(a['id'])} codex login --device-auth")


def test_delete_unknown_account_is_404():
    h, box = _handler()
    h._post_api("/local/acp/accounts", {"action": "delete", "id": "a_nope"})
    assert box["code"] == 404 and box["obj"]["error"] == "no such account"


def test_create_with_a_bad_kind_is_400():
    h, box = _handler()
    h._post_api("/local/acp/accounts",
               {"action": "create", "agent": "codex", "label": "work", "kind": "nope"})
    assert box["code"] == 400


def test_get_listing_has_three_presets_and_no_raw_key():
    acp_agents.add_account("codex", "work", "key", key=KEY)
    h, box = _handler()
    h._get_api("/local/acp/agents", {})
    assert box["code"] == 200
    assert len(box["obj"]["presets"]) == 3
    assert all("installed" in p for p in box["obj"]["presets"])
    assert KEY not in json.dumps(box["obj"])


def test_test_route_against_the_fake_preset_fills_the_options_cache(monkeypatch):
    opts = [{"id": "m", "category": "model", "type": "select",
             "options": [{"value": "a", "name": "A"}]}]
    monkeypatch.setattr(acp_agents, "PRESETS", (
        {"id": "fake", "label": "Fake", "cmd": [sys.executable, FAKE], "key_env": None,
         "home_env": None, "key_required": False, "login": "fake login", "install": "n/a",
         "env": {"FAKE_ACP": json.dumps({"options": opts})}},))
    monkeypatch.setattr(acp_agents, "_resolve", lambda name: name)
    h, box = _handler()
    h._post_api("/local/acp/test", {"agent": "fake", "account": ""})
    assert box["code"] == 200 and box["obj"]["ok"] is True
    assert box["obj"]["options"]["model"] == [{"value": "a", "name": "A"}]
    assert acp_agents.options_for("fake", "")["model"] == [{"value": "a", "name": "A"}]


def test_test_route_for_an_unknown_agent_is_404():
    h, box = _handler()
    h._post_api("/local/acp/test", {"agent": "does-not-exist", "account": ""})
    assert box["code"] == 404 and "unknown agent" in box["obj"]["error"]


def test_existing_subagent_route_is_not_shadowed():
    """Regression guard, not a RED/GREEN case: /local/agents (the Claude
    subagent viewer) must keep answering once /local/acp/* exists."""
    sid = store.create_session(config.DASH_CHAT_ID, "/acp-ep")["id"]
    h, box = _handler()
    h._get_api("/local/agents", {"session": [sid]})
    assert box["code"] == 200
