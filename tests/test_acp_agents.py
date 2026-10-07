"""acp_agents: vetted presets, 0600 masked accounts, the scrubbed env (spec
safety rules 1-4, 6)."""
import os
import stat

import pytest

from bridge import acp_agents, config


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(acp_agents, "ACCOUNTS_FILE", str(tmp_path / "agent-accounts.json"))
    monkeypatch.setattr(acp_agents, "OPTIONS_FILE", str(tmp_path / "acp-options.json"))
    monkeypatch.setattr(acp_agents, "HOMES", str(tmp_path / "agent-homes"))
    monkeypatch.setattr(acp_agents, "_options", {})


def test_only_vetted_presets_exist():
    assert {p["id"] for p in acp_agents.PRESETS} == {"codex", "opencode", "gemini"}
    banned = ("copilot", "antigravity", "agy", "amp", "droid")
    assert not any(b in " ".join(p["cmd"]).lower() for p in acp_agents.PRESETS for b in banned)


def test_keys_are_stored_0600_and_never_returned_whole():
    a = acp_agents.add_account("codex", "work", "key", key="sk-abcdefghijklmnop")
    assert "sk-abcdefghijklmnop" not in str(a) and a["key"].endswith("mnop")
    assert stat.S_IMODE(os.stat(acp_agents.ACCOUNTS_FILE).st_mode) == 0o600
    assert "sk-abcdefghijklmnop" not in str(acp_agents.accounts())
    assert acp_agents.account(a["id"])["key"] == "sk-abcdefghijklmnop"


def test_add_account_validates(monkeypatch):
    with pytest.raises(ValueError):
        acp_agents.add_account("nope", "x", "key", key="k")
    with pytest.raises(ValueError):
        acp_agents.add_account("codex", "x", "key", key="")
    with pytest.raises(ValueError):
        acp_agents.add_account("gemini", "x", "home")    # gemini: API key only


def test_env_is_scrubbed_to_the_allow_list_plus_the_account(monkeypatch):
    for k, v in {"DASH_TOKEN": "d", "TELEGRAM_BOT_TOKEN": "t", "ANTHROPIC_API_KEY": "a",
                 "CLAUDE_CONFIG_DIR": "c", "GITHUB_TOKEN": "g", "OPENAI_API_KEY": "stray",
                 "PATH": "/usr/bin", "LC_ALL": "C.UTF-8", "XDG_CONFIG_HOME": "/x"}.items():
        monkeypatch.setenv(k, v)
    codex = acp_agents.preset("codex")
    a = acp_agents.add_account("codex", "work", "key", key="sk-mine")
    env = acp_agents.env_for(codex, a["id"])
    assert env["OPENAI_API_KEY"] == "sk-mine"
    for k in ("DASH_TOKEN", "TELEGRAM_BOT_TOKEN", "ANTHROPIC_API_KEY", "CLAUDE_CONFIG_DIR",
              "GITHUB_TOKEN"):
        assert k not in env
    assert env["LC_ALL"] == "C.UTF-8" and env["XDG_CONFIG_HOME"] == "/x"
    assert "OPENAI_API_KEY" not in acp_agents.env_for(codex, "")    # machine login: no stray key


def test_a_separate_login_gets_its_own_0700_home():
    a = acp_agents.add_account("codex", "personal", "home")
    env = acp_agents.env_for(acp_agents.preset("codex"), a["id"])
    assert env["CODEX_HOME"] == acp_agents.home_dir(a["id"])
    assert stat.S_IMODE(os.stat(env["CODEX_HOME"]).st_mode) == 0o700
    assert env["CODEX_HOME"] in acp_agents.login_hint(acp_agents.preset("codex"), a["id"])


@pytest.mark.parametrize("m, hit", [
    ("claude-opus-5-5", True), ("anthropic/claude-sonnet-5", True), ("openrouter/anthropic/x", True),
    ("Opus", True), ("gpt-5.5-codex", False), ("gemini-3-flash", False), ("", False),
    ("qwen3-coder-plus", False)])
def test_claude_models_are_recognised(m, hit):
    assert acp_agents.is_claude_model(m) is hit


def test_run_problem_owner_install_account_and_model(monkeypatch):
    codex = acp_agents.preset("codex")
    monkeypatch.setattr(acp_agents, "_resolve", lambda name: "/bin/true")
    assert "owner" in acp_agents.run_problem(codex, "", config.DASH_CHAT_ID + 1, None)
    assert acp_agents.run_problem(codex, "", config.DASH_CHAT_ID, None) is None
    assert "Claude" in acp_agents.run_problem(codex, "", config.DASH_CHAT_ID, "claude-opus-5-5")
    assert "account" in acp_agents.run_problem(codex, "a_gone", config.DASH_CHAT_ID, None)
    monkeypatch.setattr(acp_agents, "_resolve", lambda name: None)
    assert "install" in acp_agents.run_problem(codex, "", config.DASH_CHAT_ID, None).lower()


def test_options_are_flattened_by_category_and_cached():
    opts = [{"id": "m", "category": "model", "type": "select", "currentValue": "a",
             "options": [{"group": "g", "name": "G", "options": [{"value": "a", "name": "A"}]},
                         {"value": "b", "name": "B"}]},
            {"id": "t", "category": "thought_level", "type": "select", "options": [
                {"value": "high", "name": "High"}]},
            {"id": "x", "category": "mode", "type": "boolean"}]
    modes = {"currentModeId": "ask", "availableModes": [{"id": "ask", "name": "Ask"}]}
    acp_agents.remember_options("codex", "", opts, modes)
    got = acp_agents.options_for("codex", "")
    assert got["model"] == [{"value": "a", "name": "A"}, {"value": "b", "name": "B"}]
    assert got["effort"] == [{"value": "high", "name": "High"}]
    assert got["mode"] == [{"value": "ask", "name": "Ask"}]       # legacy modes fill in
