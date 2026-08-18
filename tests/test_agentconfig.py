"""bridge.agentconfig — each AI tool's own global config, read and written raw.

What matters: that only registry ids resolve to a path (this writes files under
$HOME), that a broken settings.json is refused before it lands rather than
after, and that a save follows a symlink instead of replacing it — account slots
symlink to ~/.claude/CLAUDE.md, and clobbering the link would silently unshare
every slot.
Run: python -m pytest tests/test_agentconfig.py -v
"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import accounts, agentconfig  # noqa: E402


@pytest.fixture(autouse=True)
def _homes(tmp_path, monkeypatch):
    """Both roots into tmp — a test that wrote to the developer's real
    ~/.claude/CLAUDE.md would edit the machine running it."""
    claude = tmp_path / "claude"
    claude.mkdir()
    monkeypatch.setattr(accounts, "CLAUDE_HOME", str(claude))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(tmp_path / "config"))
    return claude


def test_unknown_id_never_becomes_a_path():
    with pytest.raises(ValueError):
        agentconfig.path_of("../../etc/passwd")
    with pytest.raises(ValueError):
        agentconfig.write("claude.memory/../../x", "hi")


def test_state_reads_the_file_that_is_there(_homes):
    (_homes / "CLAUDE.md").write_text("be lazy\n", encoding="utf-8")
    claude = agentconfig.state()["tools"][0]
    assert claude["id"] == "claude" and claude["installed"]
    memory = next(f for f in claude["files"] if f["id"] == "claude.memory")
    assert memory["content"] == "be lazy\n" and memory["exists"]
    settings = next(f for f in claude["files"] if f["id"] == "claude.settings")
    assert settings["content"] == "" and not settings["exists"]   # not written yet


def test_a_save_round_trips(_homes):
    agentconfig.write("claude.memory", "# rules\n")
    assert (_homes / "CLAUDE.md").read_text(encoding="utf-8") == "# rules\n"
    memory = next(f for f in agentconfig.state()["tools"][0]["files"] if f["id"] == "claude.memory")
    assert memory["content"] == "# rules\n"


def test_broken_json_is_refused_and_the_old_file_survives(_homes):
    (_homes / "settings.json").write_text('{"model": "opus"}', encoding="utf-8")
    with pytest.raises(ValueError):
        agentconfig.write("claude.settings", '{"model": "opus",}')
    assert (_homes / "settings.json").read_text(encoding="utf-8") == '{"model": "opus"}'


def test_a_save_writes_through_a_symlink(tmp_path, _homes):
    real = tmp_path / "dotfiles" / "CLAUDE.md"
    real.parent.mkdir()
    real.write_text("old\n", encoding="utf-8")
    (_homes / "CLAUDE.md").symlink_to(real)

    agentconfig.write("claude.memory", "new\n")

    assert (_homes / "CLAUDE.md").is_symlink()            # the link is still a link
    assert real.read_text(encoding="utf-8") == "new\n"    # and the target took the write


def test_opencode_is_listed_only_when_it_is_installed(monkeypatch):
    monkeypatch.setattr(agentconfig.freeagent, "opencode_bin", lambda: None)
    opencode = agentconfig.state()["tools"][1]
    assert not opencode["installed"] and opencode["files"] == []

    monkeypatch.setattr(agentconfig.freeagent, "opencode_bin", lambda: "/usr/bin/opencode")
    opencode = agentconfig.state()["tools"][1]
    assert opencode["installed"] and len(opencode["files"]) == 2
