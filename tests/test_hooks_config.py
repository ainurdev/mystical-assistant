"""Your own hooks in each agent's config (bridge/hooks_config.py)."""
import json
import tomllib

import pytest

from bridge import hooks_config as hc, rules


@pytest.fixture(autouse=True)
def homes(monkeypatch, tmp_path):
    monkeypatch.setenv("CLAUDE_SETTINGS_FILE", str(tmp_path / "claude" / "settings.json"))
    monkeypatch.setenv("KIMI_CODE_HOME", str(tmp_path / "kimi"))
    (tmp_path / "kimi").mkdir()
    (tmp_path / "kimi" / "config.toml").write_text('default_model = "x"\n\n[thinking]\nenabled = true\n')
    (tmp_path / "claude").mkdir()
    (tmp_path / "claude" / "settings.json").write_text(json.dumps({"theme": "dark", "permissions": {"allow": ["Bash"]}}))


def test_add_list_edit_remove_on_claude_leaves_the_rest(tmp_path):
    hc.add("claude", "user", "PreToolUse", "Bash", "echo hi", None)
    rows = hc.listing(None)["hooks"]
    assert len(rows) == 1 and rows[0]["matcher"] == "Bash" and rows[0]["can_block"] is True
    hc.edit(rows[0]["id"], "PostToolUse", "Edit", "echo there", None)
    rows = hc.listing(None)["hooks"]
    assert rows[0]["event"] == "PostToolUse" and rows[0]["command"] == "echo there" and rows[0]["can_block"] is False
    hc.remove(rows[0]["id"], None)
    data = json.loads((tmp_path / "claude" / "settings.json").read_text())
    assert data == {"theme": "dark", "permissions": {"allow": ["Bash"]}}


def test_project_scope_goes_in_the_project(tmp_path):
    p = tmp_path / "proj"
    p.mkdir()
    hc.add("claude", "project", "Stop", "", "make lint", str(p))
    assert "make lint" in (p / ".claude" / "settings.json").read_text()
    with pytest.raises(ValueError):
        hc.add("claude", "project", "Stop", "", "x", None)
    with pytest.raises(ValueError):
        hc.add("kimi", "project", "Stop", "", "x", str(p))


def test_kimi_round_trip_and_no_extra_fields(tmp_path):
    cfg = tmp_path / "kimi" / "config.toml"
    hc.add("kimi", "user", "PreToolUse", "Bash", 'say "hi"', None, 30)
    got = tomllib.loads(cfg.read_text())
    assert got["default_model"] == "x" and got["hooks"][0] == {"event": "PreToolUse", "command": 'say "hi"', "matcher": "Bash", "timeout": 30}
    row = hc.listing(None)["hooks"][0]
    hc.remove(row["id"], None)
    assert tomllib.loads(cfg.read_text()) == {"default_model": "x", "thinking": {"enabled": True}}


def test_mystical_block_stays_whole_and_isnt_listed(tmp_path):
    cfg = tmp_path / "kimi" / "config.toml"
    rules.write_kimi_block(str(cfg), rules.kimi_block(["Stop"]))
    hc.add("kimi", "user", "PreToolUse", "", "echo mine", None)
    text = cfg.read_text()
    assert text.index("echo mine") < text.index(rules.KIMI_BEGIN) and rules.KIMI_END in text
    assert [r["command"] for r in hc.listing(None)["hooks"]] == ["echo mine"]
    hc.remove(hc.listing(None)["hooks"][0]["id"], None)
    assert "echo mine" not in cfg.read_text() and rules.KIMI_BEGIN in cfg.read_text()
    tomllib.loads(cfg.read_text())
    rules.write_kimi_block(str(cfg), "")
    assert rules.KIMI_BEGIN not in cfg.read_text()


def test_refusals_change_nothing(tmp_path):
    before = (tmp_path / "kimi" / "config.toml").read_text()
    for bad in (("kimi", "user", "NotAnEvent", "", "x"), ("kimi", "user", "Stop", "", ""), ("kimi", "user", "Stop", "", "a\nb"),
                ("codex", "user", "Stop", "", "x")):
        with pytest.raises(ValueError):
            hc.add(*bad, None)
    assert (tmp_path / "kimi" / "config.toml").read_text() == before
    (tmp_path / "kimi" / "config.toml").write_text("broken = = [\n")
    with pytest.raises(ValueError):
        hc.add("kimi", "user", "Stop", "", "x", None)
    assert (tmp_path / "kimi" / "config.toml").read_text() == "broken = = [\n"


def test_a_bad_edit_keeps_the_old_one():
    hc.add("claude", "user", "Stop", "", "keep me", None)
    row = hc.listing(None)["hooks"][0]
    with pytest.raises(ValueError):
        hc.edit(row["id"], "Nope", "", "x", None)
    assert hc.listing(None)["hooks"][0]["command"] == "keep me"


def test_copy_across_only_for_events_both_have():
    hc.add("claude", "user", "PreToolUse", "Bash", "guard", None)
    row = hc.listing(None)["hooks"][0]
    hc.copy_to(row["id"], "kimi", None)
    assert {r["agent"] for r in hc.listing(None)["hooks"]} == {"claude", "kimi"}
    hc.add("claude", "user", "PostToolBatch", "", "b", None)
    row = next(r for r in hc.listing(None)["hooks"] if r["event"] == "PostToolBatch")
    with pytest.raises(ValueError):
        hc.copy_to(row["id"], "kimi", None)
