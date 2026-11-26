"""The design pack (bridge/skills/mystical-design) behind DESIGN PACK: the gate, what it
changes while open (plugin dir, the design step's command, the routing text, the / list),
and the pack's own files. Run: python3 -m pytest tests/test_design_pack.py -q"""

import json
import os
import re

import pytest

from bridge import aifeatures, commands, config, flowsettings, paths, runner, store
from test_paths import _job, fake_queue, state_dir  # noqa: F401 — fixtures

store.init()
PACK = paths.DESIGN_DIR


@pytest.fixture
def switches(monkeypatch, state_dir):  # noqa: F811
    """SKILL PATHS and AUTO NEXT STEPS on; DESIGN PACK as `on` says. Each test flips it."""
    on = {"router", "nextstep"}
    monkeypatch.setattr(aifeatures, "enabled", lambda key: key in on)
    paths._pack_ok.clear()
    return on


def _session(origin="", cid=None):
    s = store.create_session(1, "p", origin=origin)
    store.set_claude_session_id(s["id"], cid or s["id"])
    return s["id"], cid or s["id"]


def _cmd(cid):
    return runner._base_cmd("hi", 1, stream=True, interactive=True, claude_session_id=cid)  # noqa: SLF001


def _plugin_dirs(cid):
    cmd = _cmd(cid)
    return [cmd[i + 1] for i, a in enumerate(cmd) if a == "--plugin-dir"]


def _design_step(sid, fake_queue):  # noqa: F811
    """The design step's two sends: at the send (grill off) and queued after a grill."""
    flowsettings.change({"flow": "design", "key": "step", "step": "grill", "value": False})
    at_send = paths.start_flow(sid, "design", "you", "a calmer header").split(" ", 1)[0]
    flowsettings.change({"flow": "design", "key": "step", "step": "grill", "value": True})
    paths.set_path(sid, "design", "a new screen", "claude")
    paths.step_done(sid, "t1")
    paths.continue_after_turn(_job(sid, "t1"))
    return at_send, fake_queue.items[-1]["prompt"].split(" ", 1)[0]


def test_switch_off_sends_design_first_and_loads_no_pack(switches, fake_queue):  # noqa: F811
    sid, cid = _session()
    assert _design_step(sid, fake_queue) == ("/design-first", "/design-first")
    assert _plugin_dirs(cid) == [paths.PACK_DIR]


def test_switch_on_sends_the_packs_design_first_and_loads_it(switches, fake_queue):  # noqa: F811
    switches.add("designpack")
    sid, cid = _session()
    assert _design_step(sid, fake_queue) == ("/mystical-design:design-first",) * 2
    assert _plugin_dirs(cid) == [paths.PACK_DIR, PACK]        # beside Matt's


def test_the_pack_loads_without_skill_paths(switches):
    switches.discard("router")
    switches.add("designpack")
    assert _plugin_dirs(_session()[1]) == [PACK]


@pytest.mark.parametrize("origin", ["rivendell:job", "device-run:abc"])
def test_unattended_sessions_never_get_the_pack(switches, origin):
    switches.add("designpack")
    sid, cid = _session(origin)
    assert PACK not in _plugin_dirs(cid) and not paths.design_pack(sid)


def test_an_override_opens_the_gate_for_its_session_only(switches):
    mine, cmine = _session()
    other, cother = _session()
    paths.set_path(mine, "design", "x", "claude")
    paths.set_option(mine, "designpack", True)
    assert PACK in _plugin_dirs(cmine) and PACK not in _plugin_dirs(cother)
    switches.add("designpack")
    paths.set_option(mine, "designpack", False)                # and closes it, switch or not
    assert PACK not in _plugin_dirs(cmine) and PACK in _plugin_dirs(cother)
    paths.set_option(mine, "autopick", False)
    paths.reset(mine)                                          # the FLOW chip's Reset keeps it
    assert paths.get(mine)["overrides"] == {"designpack": False}


def test_flipping_the_switch_applies_from_the_next_turn(switches):
    cid = _session()[1]
    assert PACK not in _plugin_dirs(cid)
    switches.add("designpack")
    assert PACK in _plugin_dirs(cid)
    switches.discard("designpack")
    assert PACK not in _plugin_dirs(cid)


def test_the_routing_text_and_the_slash_list_follow_the_gate(switches):
    flowsettings.change({"flow": "design", "key": "step", "step": "grill", "value": False})
    cid = _session()[1]
    names = lambda: {c["name"] for c in commands.available(None)}   # noqa: E731
    assert "/mystical-design:design-first" not in paths.pack_for(cid)
    assert not any(n.startswith("mystical-design:") for n in names())
    switches.add("designpack")
    assert "/mystical-design:design-first" in paths.pack_for(cid)
    assert {"mystical-design:design-first", "mystical-design:design-implement"} <= names()


# --- Seam 3: the pack's own files ----------------------------------------------

def _manifest():
    with open(os.path.join(PACK, ".claude-plugin", "plugin.json"), encoding="utf-8") as f:
        return json.load(f)


def _skills():
    return {os.path.basename(rel.rstrip("/")): os.path.join(PACK, rel, "SKILL.md") for rel in _manifest()["skills"]}


def test_the_manifest_lists_every_skill_and_each_exists():
    assert _manifest()["name"] == "mystical-design"
    on_disk = {os.path.basename(os.path.dirname(p)) for p in
               (os.path.join(r, "SKILL.md") for r, _d, fs in os.walk(os.path.join(PACK, "skills")) if "SKILL.md" in fs)}
    assert set(_skills()) == on_disk and {"design-first", "design-implement"} <= on_disk
    for name, md in _skills().items():
        text = open(md, encoding="utf-8").read()
        assert f"name: {name}\n" in text and "disable-model-invocation: true" not in text, name


def test_every_listed_source_has_its_licence_file():
    readme = open(os.path.join(PACK, "README.md"), encoding="utf-8").read()
    rows = [r for r in readme.splitlines() if r.startswith("|") and "`" in r]
    assert rows
    for row in rows:
        lic = re.findall(r"`([^`]+)`", row.split("|")[-2])
        assert lic and all(os.path.isfile(os.path.join(PACK, p)) for p in lic), row


def test_every_pack_name_a_skill_mentions_is_in_the_pack():
    for md in _skills().values():
        for name in re.findall(r"/?mystical-design:([\w-]+)", open(md, encoding="utf-8").read()):
            assert name in _skills(), (md, name)


def test_design_pack_is_an_ai_feature_off_by_default():
    f = next(f for f in aifeatures.FEATURES if f["key"] == "designpack")
    assert f["label"] == "DESIGN PACK" and not f.get("parent")
    with open(config.__file__, encoding="utf-8") as src:
        assert f'os.environ.get("{f["env"]}", "0")' in src.read()


OUTSIDE = ["frontend-design", "web-design-guidelines", "break-ui", "shadcn",
           "expo-native-ui", "expo-design-system", "expo-animation", "create-design-md"]


def test_the_eight_outside_skills_are_in_the_pack_and_the_slash_list(switches):
    assert set(OUTSIDE) <= set(_skills())
    switches.add("designpack")
    names = {c["name"] for c in commands.available(None)}
    assert {f"mystical-design:{n}" for n in OUTSIDE} <= names


def test_the_readme_gives_each_outside_skills_source_version_and_licence():
    readme = open(os.path.join(PACK, "README.md"), encoding="utf-8").read()
    for name in OUTSIDE:
        row = next(r for r in readme.splitlines() if r.startswith(f"| {name} |"))
        _, _skill, source, version, licence, _file, _ = row.split("|")
        assert "github.com/" in source and re.search(r"\b[0-9a-f]{7}\b", version) and licence.strip(), row
    assert "Impeccable" in readme and "Upstream edits" in readme


def test_no_pack_file_names_an_outside_skill_by_its_bare_name():
    """A cross-reference to a vendored skill uses /mystical-design:<name>; only its own
    folder may name it bare."""
    for name in OUTSIDE:
        for root, _d, files in os.walk(os.path.join(PACK, "skills")):
            if os.path.relpath(root, os.path.join(PACK, "skills")).split(os.sep)[0] == name:
                continue
            for fn in (f for f in files if f.endswith(".md")):
                text = open(os.path.join(root, fn), encoding="utf-8").read()
                assert not re.search(rf"(?<![/\w:-]){re.escape(name)}(?![\w-])", text), (fn, name)


def test_web_design_guidelines_reads_its_bundled_rules_and_fetches_nothing():
    import hashlib
    skill = os.path.join(PACK, "skills", "web-design-guidelines")
    md = open(os.path.join(skill, "SKILL.md"), encoding="utf-8").read()
    rules = open(os.path.join(skill, "references", "command.md"), "rb").read()
    assert 'version: "1.1.0"' in md and "Do not fetch rules from the network" in md
    assert hashlib.sha256(rules).hexdigest() in md                 # the pinned snapshot, unedited
    assert "WebFetch" not in md and "raw.githubusercontent" not in rules.decode()


def test_the_judgement_pass_is_one_shared_reference_with_its_three_parts():
    text = open(os.path.join(PACK, "references", "judgement-pass.md"), encoding="utf-8").read()
    for part in ("Keyboard, focus, labels and announced state", "Empty, loading and error states", "Long content"):
        assert re.search(rf"^## \d\. {part}$", text, re.M), part
    for name in re.findall(r"/?mystical-design:([\w-]+)", text):
        assert name in _skills(), name


def test_the_polish_pass_names_its_steps_and_its_limits():
    md = open(_skills()["polish"], encoding="utf-8").read()
    assert "user-invocable: true" in md
    for step in ("compare_images", "at 2x", "inspect_ui", "references/judgement-pass.md",
                 "/mystical-design:web-design-guidelines", "/mystical-design:break-ui",
                 "at most two rounds", "Never commit the drafts", "Run tool", "Native-only behaviour wasn't checked"):
        assert step in md, step
