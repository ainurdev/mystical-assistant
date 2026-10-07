"""profiles.py: CRUD validation, effective() precedence, save_pick, bind, delete.
Spec: docs/superpowers/specs/profiles-and-acp-agents.md (Part 1)."""
import json

import pytest

from bridge import accounts, acp_agents, config, models, profiles, project_config, store

store.init()
CHAT = 555


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(profiles, "PATH", str(tmp_path / "profiles.json"))
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "project_config.json"))
    monkeypatch.setattr(accounts, "list_accounts", lambda: [
        {"slot": 1, "disabled": False}, {"slot": 2, "disabled": False},
        {"slot": 3, "disabled": True}])
    monkeypatch.setattr(models, "model_ids", lambda: {"claude-opus-5-5", "claude-fable-5-1"})
    monkeypatch.setattr(store, "default_disabled_tools", lambda: ["mcp__x"])


def _mk(**kw):
    return profiles.create({"name": "Work", "agent": "claude", "account": "2",
                            "model": "claude-opus-5-5", "mode": "bypassPermissions",
                            "effort": "high", "tools": None, **kw})


def test_create_assigns_an_id_and_keeps_the_fields():
    p = _mk()
    assert p["id"].startswith("p_") and profiles.get(p["id"]) == p
    assert (p["account"], p["model"], p["mode"], p["effort"]) == (
        "2", "claude-opus-5-5", "bypassPermissions", "high")


@pytest.mark.parametrize("bad, msg", [
    ({"name": ""}, "name"), ({"name": "x" * 33}, "name"),
    ({"account": "3"}, "account"), ({"account": "9"}, "account"),
    ({"model": "gpt-9"}, "model"), ({"mode": "yolo"}, "mode"),
    ({"effort": "extreme"}, "effort"), ({"agent": "nope"}, "agent"),
    ({"tools": "Bash"}, "tools"),
])
def test_create_rejects(bad, msg):
    with pytest.raises(ValueError, match=msg):
        _mk(**bad)


def test_names_are_unique_but_an_update_may_keep_its_own():
    p = _mk()
    with pytest.raises(ValueError, match="already exists"):
        _mk()
    assert profiles.update(p["id"], {"effort": "low"})["effort"] == "low"


def test_effective_precedence_session_then_profile_then_none():
    p = _mk(tools=["Bash"])
    s = store.create_session(CHAT, "/pf-eff", profile_id=p["id"])
    e = profiles.effective(s)
    assert (e["agent"], e["account"], e["model"], e["permission_mode"], e["effort"]) == (
        "claude", "2", "claude-opus-5-5", "bypassPermissions", "high")
    assert e["disabled_tools"] == ["Bash"] and e["overrides"] == []
    store.set_session_field(s["id"], "model", "claude-fable-5-1")
    store.set_disabled_tools(s["id"], [])            # "[]" = everything on, a real choice
    e = profiles.effective(store.get_session(s["id"]))
    assert e["model"] == "claude-fable-5-1" and e["disabled_tools"] == []
    assert set(e["overrides"]) == {"model", "disabled_tools"}


def test_an_unprofiled_session_reads_exactly_its_own_columns():
    s = store.create_session(CHAT, "/pf-plain", permission_mode="default")
    e = profiles.effective(s)
    assert (e["profile_id"], e["agent"], e["model"], e["permission_mode"]) == (
        None, "claude", None, "default")
    assert e["disabled_tools"] is None and profiles.tools_for(s) == ["mcp__x"]


def test_save_pick_follows_overrides_and_resets():
    p = _mk()
    s = store.create_session(CHAT, "/pf-pick", profile_id=p["id"])
    profiles.save_pick(s, "model", "claude-opus-5-5")         # echo of the profile
    assert store.get_session(s["id"])["model"] is None
    profiles.save_pick(s, "model", "claude-fable-5-1")        # a real pick
    assert store.get_session(s["id"])["model"] == "claude-fable-5-1"
    profiles.save_pick(store.get_session(s["id"]), "model", "claude-opus-5-5")  # reset
    assert store.get_session(s["id"])["model"] is None


def test_save_pick_on_an_unprofiled_session_stores_and_ignores_blank():
    s = store.create_session(CHAT, "/pf-pick2")
    profiles.save_pick(s, "model", "claude-fable-5-1")
    profiles.save_pick(store.get_session(s["id"]), "model", None)
    assert store.get_session(s["id"])["model"] == "claude-fable-5-1"


def test_a_blank_effort_on_an_unprofiled_session_is_auto_and_clears_it():
    s = store.create_session(CHAT, "/pf-pick3")
    profiles.save_pick(s, "effort", "high")
    assert store.get_session(s["id"])["effort"] == "high"
    profiles.save_pick(store.get_session(s["id"]), "effort", None)
    assert store.get_session(s["id"])["effort"] is None


def test_bind_clears_overrides_and_unbind_freezes_the_effective_values():
    a, b = _mk(), _mk(name="Fable", model="claude-fable-5-1", account="")
    s = store.create_session(CHAT, "/pf-bind", profile_id=a["id"])
    store.set_session_field(s["id"], "effort", "low")
    assert profiles.bind(store.get_session(s["id"]), b["id"]) == (
        {"ok": True, "profile_id": b["id"]}, 200)
    row = store.get_session(s["id"])
    assert row["profile_id"] == b["id"] and row["effort"] is None
    profiles.bind(row, "")
    row = store.get_session(s["id"])
    assert row["profile_id"] is None
    assert (row["model"], row["permission_mode"], row["effort"]) == (
        "claude-fable-5-1", "bypassPermissions", "high")


def test_bind_to_a_missing_profile_is_404():
    s = store.create_session(CHAT, "/pf-bind404")
    assert profiles.bind(s, "p_gone")[1] == 404


def test_delete_unbinds_freezes_and_clears_project_defaults():
    p = _mk(tools=["Bash"])
    s = store.create_session(CHAT, "/pf-del", profile_id=p["id"])
    profiles.set_project_default("/pf-del", p["id"])
    profiles.delete(p["id"])
    row = store.get_session(s["id"])
    assert row["profile_id"] is None and row["model"] == "claude-opus-5-5"
    assert json.loads(row["disabled_tools"]) == ["Bash"]
    assert profiles.project_default("/pf-del") is None
    assert profiles.api_list()["project_defaults"] == {}


def test_project_default_ignores_a_profile_that_is_gone(tmp_path):
    project_config.set_profile("/pf-stale", "p_gone")
    assert profiles.project_default("/pf-stale") is None


def test_api_write_reports_errors_as_statuses():
    assert profiles.api_write({"action": "zap"})[1] == 400
    assert profiles.api_write({"action": "update", "id": "p_nope", "name": "x"})[1] == 404
    assert profiles.api_write({"action": "create", "name": ""})[1] == 400
    j, code = profiles.api_write({"action": "create", "name": "Ok", "agent": "claude"})
    assert code == 200 and j["profile"]["name"] == "Ok"


def test_brief_fills_defaults_the_composer_needs():
    p = _mk(mode="", effort="")
    s = store.create_session(CHAT, "/pf-brief", profile_id=p["id"])
    b = profiles.brief(s)
    assert b["permission_mode"] == config.MINIAPP_PERMISSION_MODE
    assert b["disabled_tools"] == ["mcp__x"] and b["profile_id"] == p["id"]


def test_refusal_names_a_dead_claude_slot(monkeypatch):
    p = _mk()
    s = store.create_session(CHAT, "/pf-dead", profile_id=p["id"])
    monkeypatch.setattr(accounts, "list_accounts",          # slot 2 removed since
                        lambda: [{"slot": 1, "disabled": False}])
    msg = profiles.refusal(profiles.effective(s), CHAT)
    assert msg and "Work" in msg and "2" in msg


# Part 2: profiles on a non-Claude agent (acp_agents presets).

@pytest.fixture
def fake_agent(monkeypatch, tmp_path):
    monkeypatch.setattr(acp_agents, "PRESETS", (
        {"id": "fake", "label": "Fake", "cmd": ["fake-acp-not-installed"], "key_env": None,
         "home_env": None, "key_required": False, "login": "fake login", "install": "n/a",
         "env": {}},))
    monkeypatch.setattr(acp_agents, "ACCOUNTS_FILE", str(tmp_path / "agent-accounts.json"))


def test_profiles_accept_agents_and_refuse_claude_models(fake_agent):
    with pytest.raises(ValueError, match="Claude"):
        profiles.create({"name": "F1", "agent": "fake", "model": "claude-opus-5-5"})
    with pytest.raises(ValueError, match="account"):
        profiles.create({"name": "F2", "agent": "fake", "account": "a_nope"})
    acp_agents._save([{"id": "a_cx", "agent": "codex", "label": "cx", "kind": "key", "key": "k"}])
    with pytest.raises(ValueError, match="account"):          # another agent's account
        profiles.create({"name": "F3", "agent": "fake", "account": "a_cx"})
    with pytest.raises(ValueError, match="64"):
        profiles.create({"name": "F4", "agent": "fake", "effort": "x" * 65})
    p = profiles.create({"name": "F5", "agent": "fake", "mode": "read-only"})
    assert (p["agent"], p["mode"]) == ("fake", "read-only")


def test_bind_across_agents_after_a_turn_is_409(fake_agent):
    claude, fake = _mk(), profiles.create({"name": "F", "agent": "fake"})
    s = store.create_session(CHAT, "/pf-x-agent", profile_id=claude["id"])
    store.start_turn(s["id"], "t-pf-x-agent", "hi", [])
    assert profiles.bind(store.get_session(s["id"]), fake["id"])[1] == 409
    fresh = store.create_session(CHAT, "/pf-x-agent-fresh", profile_id=claude["id"])
    assert profiles.bind(fresh, fake["id"])[1] == 200


def test_an_agent_run_takes_its_own_ids_and_never_a_claude_model(fake_agent):
    assert profiles.run_values("gpt-5.1", " read-only ", "", "fake") == (
        None, "gpt-5.1", "read-only", None)
    assert profiles.run_values("claude-opus-5-5", None, None, "fake")[0] == (
        "Claude models run in a Claude profile")
    assert profiles.run_values(None, "x" * 65, None, "fake")[0]
    assert profiles.run_values("gpt-5.1", None, None)[0] == "invalid model"   # Claude's rules


def test_agent_for_is_the_sessions_else_what_a_fresh_one_would_bind(fake_agent):
    fake = profiles.create({"name": "F", "agent": "fake"})
    s = store.create_session(CHAT, "/pf-af", profile_id=fake["id"])
    assert profiles.agent_for(s) == "fake"
    assert profiles.agent_for(None, fake["id"], "/pf-af-none") == "fake"
    assert profiles.agent_for(None, None, "/pf-af-none") == "claude"
    profiles.set_project_default("/pf-af-default", fake["id"])
    assert profiles.agent_for(None, None, "/pf-af-default") == "fake"


def test_refusal_covers_agent_profiles(fake_agent):
    p = profiles.create({"name": "F", "agent": "fake"})
    eff = profiles.effective(store.create_session(CHAT, "/pf-agent-refuse", profile_id=p["id"]))
    assert "owner" in profiles.refusal(eff, config.DASH_CHAT_ID + 7)
    assert "isn't installed" in profiles.refusal(eff, config.DASH_CHAT_ID)


def test_a_profiles_agent_cannot_change(fake_agent):
    """Else every bound session would switch agents at once, past bind()'s 409."""
    p = _mk()
    j, code = profiles.api_write({"action": "update", "id": p["id"], "agent": "fake",
                                  "account": "", "model": ""})
    assert code == 400 and j["error"] == "A profile's agent can't change; make a new profile"
    assert profiles.get(p["id"]) == p
    assert profiles.update(p["id"], {"agent": "claude", "effort": "low"})["effort"] == "low"


def _agent_profile():
    return profiles.create({"name": "F", "agent": "fake", "model": "gpt-5.1",
                            "mode": "read-only", "effort": "high"})


def _knobs(sid):
    row = store.get_session(sid)
    return row["profile_id"], row["model"], row["permission_mode"], row["effort"]


def test_unbinding_an_agent_profile_drops_its_ids_instead_of_freezing_them(fake_agent):
    s = store.create_session(CHAT, "/pf-leave", profile_id=_agent_profile()["id"])
    store.set_session_field(s["id"], "model", "gpt-5.1-mini")           # hand-set
    assert profiles.bind(store.get_session(s["id"]), "")[1] == 200
    assert _knobs(s["id"]) == (None, None, None, None)


def test_deleting_an_agent_profile_drops_its_ids_hand_set_ones_too(fake_agent):
    p = _agent_profile()
    s = store.create_session(CHAT, "/pf-leave-del", profile_id=p["id"])
    store.set_session_field(s["id"], "effort", "low")                  # hand-set
    profiles.delete(p["id"])
    assert _knobs(s["id"]) == (None, None, None, None)


def test_a_duplicate_keeps_its_profile_but_never_the_agents_session_id(fake_agent):
    p = _agent_profile()
    s = store.create_session(CHAT, "/pf-dup", profile_id=p["id"])
    store.set_session_field(s["id"], "agent_session_id", "s-agent-1")
    copy = store.duplicate(s["id"])
    assert copy["profile_id"] == p["id"]
    assert copy["agent_session_id"] is None and copy["fork_from"] is None
