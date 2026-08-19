"""commands: the `/name` list the composers autocomplete from — project and
user skills + custom commands, enabled plugins' skills + commands, and the
CLI's bundled ones. Plus the two routes that serve it.
Run: python -m pytest tests/test_commands.py -v"""

import json
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import commands, state  # noqa: E402
from bridge.dashboard import server as dash  # noqa: E402


def _skill(root, name, desc="", fm_name=None):
    d = os.path.join(root, "skills", name)
    os.makedirs(d, exist_ok=True)
    head = "---\n" + (f"name: {fm_name}\n" if fm_name else "") + f"description: {desc}\n---\n"
    with open(os.path.join(d, "SKILL.md"), "w") as f:
        f.write(head + "body\n")


def _command(root, rel, body):
    p = os.path.join(root, "commands", rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as f:
        f.write(body)


@pytest.fixture
def home(tmp_path, monkeypatch):
    """A fake ~/.claude with nothing in it; tests add what they need."""
    h = tmp_path / "home"
    h.mkdir()
    monkeypatch.setattr(commands, "USER_DIR", str(h))
    return str(h)


def _names(cmds):
    return [c["name"] for c in cmds]


def test_project_and_user_skills_and_commands(home, tmp_path):
    proj = str(tmp_path / "proj")
    _skill(os.path.join(proj, ".claude"), "bridge-ship", "build, restart, verify")
    _skill(home, "stop-slop", "remove AI tells")
    # commands: front-matter description, else the first line of the prompt;
    # a subdirectory is organisation only, the name is the file's.
    _command(os.path.join(proj, ".claude"), "review.md", "---\ndescription: review the diff\n---\nLook at…")
    _command(home, "git/commit.md", "\nWrite a commit for the staged changes.\nMore.\n")

    got = commands.available(proj)
    by = {c["name"]: c for c in got}

    assert by["bridge-ship"] == {"name": "bridge-ship", "description": "build, restart, verify", "scope": "project"}
    assert by["stop-slop"]["scope"] == "user"
    assert by["review"]["description"] == "review the diff"
    assert by["commit"] == {"name": "commit", "description": "Write a commit for the staged changes.", "scope": "user"}


def test_project_wins_a_name_over_user_and_each_name_appears_once(home, tmp_path):
    proj = str(tmp_path / "proj")
    _skill(os.path.join(proj, ".claude"), "brainstorming", "project flavour")
    _skill(home, "brainstorming", "user flavour")

    got = commands.available(proj)

    assert _names(got).count("brainstorming") == 1
    assert next(c for c in got if c["name"] == "brainstorming")["scope"] == "project"
    assert len(_names(got)) == len(set(_names(got)))


def test_front_matter_name_beats_the_directory(home):
    _skill(home, "dir-name", "x", fm_name="real-name")
    assert "real-name" in _names(commands.available(None))
    assert "dir-name" not in _names(commands.available(None))


def _plugin(home, pid, enabled=True, skills=(), cmds=()):
    short = pid.split("@")[0]
    root = os.path.join(home, "plugins", "cache", short)
    for s in skills:
        _skill(root, s, f"{s} from {short}")
    for c in cmds:
        _command(root, c, f"prompt of {c}")
    reg = os.path.join(home, "plugins", "installed_plugins.json")
    data = json.load(open(reg)) if os.path.exists(reg) else {"version": 2, "plugins": {}}
    data["plugins"][pid] = [{"scope": "user", "installPath": root}]
    os.makedirs(os.path.dirname(reg), exist_ok=True)
    json.dump(data, open(reg, "w"))
    sp = os.path.join(home, "settings.json")
    s = json.load(open(sp)) if os.path.exists(sp) else {}
    s.setdefault("enabledPlugins", {})[pid] = enabled
    json.dump(s, open(sp, "w"))


def test_enabled_plugins_contribute_namespaced_skills_and_commands(home):
    _plugin(home, "superpowers@claude-plugins-official", skills=["brainstorming"])
    _plugin(home, "ponytail@ponytail", skills=["ponytail"], cmds=["ponytail-review.md", "ponytail.toml"])
    _plugin(home, "dead@claude-plugins-official", enabled=False, skills=["gone"])

    got = commands.available(None)
    by = {c["name"]: c for c in got}

    assert by["superpowers:brainstorming"]["scope"] == "plugin"
    assert by["superpowers:brainstorming"]["description"] == "brainstorming from superpowers"
    assert "ponytail:ponytail" in by and "ponytail:ponytail-review" in by
    assert "ponytail:ponytail.toml" not in by           # only .md is a command
    assert not [n for n in by if n.startswith("dead:")]  # disabled = not offered


def test_project_settings_can_enable_a_plugin_the_user_settings_do_not(home, tmp_path):
    _plugin(home, "cf@cloudflare", enabled=False, skills=["wrangler"])
    proj = str(tmp_path / "proj")
    os.makedirs(os.path.join(proj, ".claude"))
    json.dump({"enabledPlugins": {"cf@cloudflare": True}}, open(os.path.join(proj, ".claude", "settings.json"), "w"))

    assert "cf:wrangler" in _names(commands.available(proj))
    assert "cf:wrangler" not in _names(commands.available(None))


def test_bundled_commands_are_always_offered_and_never_shadow_disk(home):
    _skill(home, "compact", "my own compact")
    got = commands.available(None)
    by = {c["name"]: c for c in got}
    assert by["compact"]["scope"] == "user"             # disk wins over the static list
    assert by["init"]["scope"] == "builtin"
    assert by["code-review"]["scope"] == "builtin"


def test_garbage_on_disk_never_raises(home, tmp_path):
    os.makedirs(os.path.join(home, "plugins"))
    with open(os.path.join(home, "plugins", "installed_plugins.json"), "w") as f:
        f.write("{not json")
    with open(os.path.join(home, "settings.json"), "w") as f:
        f.write("[]")                                     # a list, not the dict we expect
    _skill(home, "ok", "fine")
    # a "commands" entry that is a file, not a directory
    with open(os.path.join(home, "commands"), "w") as f:
        f.write("x")
    got = commands.available(str(tmp_path / "nope"))    # project dir doesn't exist either
    assert "ok" in _names(got) and "compact" in _names(got)


# --- routes -------------------------------------------------------------------

def _dash():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


def test_dashboard_route_serves_the_list(home, monkeypatch):
    _skill(home, "only-here", "seen")
    h, box = _dash()
    h._get_api("/local/commands", {})
    assert box["code"] == 200
    assert "only-here" in _names(box["obj"]["commands"])


def test_miniapp_route_serves_the_active_projects_list(home, tmp_path, monkeypatch):
    from bridge.miniapp import server as mini
    proj = str(tmp_path / "proj")
    _skill(os.path.join(proj, ".claude"), "proj-only", "seen")
    monkeypatch.setattr(state, "project_dir", lambda chat_id: proj)
    h = mini.Handler.__new__(mini.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    h._api_commands(1)
    assert box["code"] == 200
    assert "proj-only" in _names(box["obj"]["commands"])
