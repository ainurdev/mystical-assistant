"""The design pack (bridge/skills/mystical-design) behind DESIGN PACK: the gate, what it
changes while open (plugin dir, the design step's command, the routing text, the / list),
and the pack's own files. Run: python3 -m pytest tests/test_design_pack.py -q"""

import json
import os
import re
import subprocess

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


# --- Seam 1: BOLD, the prompt box's Bold run -----------------------------------

NOTE = "Bold run: you lit BOLD."


def test_bold_goes_with_design_alone(switches):
    assert paths.flow_refusal("design", "you", "x", "claude", bold=True) == ""
    assert paths.flow_refusal("build", "you", "x", "claude", bold=True)
    assert paths.flow_refusal("", "you", "x", "claude", bold=True)


@pytest.mark.parametrize("extra", [{"flow": "build", "by": "you"}, {}])
def test_the_send_refuses_bold_off_design(switches, monkeypatch, extra):
    from bridge.dashboard import server as dash
    monkeypatch.setattr(dash, "_chat", lambda: 1)
    monkeypatch.setattr(runner, "start_streaming_job", lambda *a, **k: pytest.fail("bold off DESIGN ran"))
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)   # noqa: SLF001
    h._post_api("/local/run", {"prompt": "a calmer header", "bold": True, **extra})  # noqa: SLF001
    assert box["code"] == 400 and "DESIGN" in box["obj"]["error"]


def test_bold_at_the_send_carries_the_note_after_the_command(switches):
    flowsettings.change({"flow": "design", "key": "step", "step": "grill", "value": False})
    sid, _ = _session()
    sent = paths.start_flow(sid, "design", "you", "a calmer header", bold=True)
    assert sent.startswith(f"/design-first {NOTE}\na calmer header")
    assert paths.get(sid)["bold"] is True


def test_bold_lit_before_a_grill_reaches_the_queued_design_step(switches, fake_queue):  # noqa: F811
    switches.add("designpack")
    sid, _ = _session()
    paths.start_flow(sid, "design", "you", "a calmer header", bold=True)   # the grill first
    paths.step_done(sid, "t1")
    paths.continue_after_turn(_job(sid, "t1"))
    assert fake_queue.items[-1]["prompt"].startswith(f"/mystical-design:design-first {NOTE}\n")


def test_bold_lit_while_answering_the_grill_still_counts(switches, fake_queue):  # noqa: F811
    sid, _ = _session()
    paths.start_flow(sid, "design", "you", "a calmer header")
    paths.start_flow(sid, "design", "you", "the answer", bold=True)       # the running flow keeps it
    paths.step_done(sid, "t1")
    paths.continue_after_turn(_job(sid, "t1"))
    assert fake_queue.items[-1]["prompt"].startswith(f"/design-first {NOTE}\n")


def test_bold_holds_for_one_send(switches, fake_queue):  # noqa: F811
    sid, _ = _session()
    paths.start_flow(sid, "design", "you", "first", bold=True)
    paths.set_path(sid, "design", "a new screen", "claude")             # the next flow, no BOLD
    assert not paths.get(sid)["bold"]
    paths.step_done(sid, "t1")
    paths.continue_after_turn(_job(sid, "t1"))
    assert NOTE not in fake_queue.items[-1]["prompt"]


def test_a_queued_send_keeps_bold(monkeypatch):
    from bridge import queue_manager
    got = {}
    monkeypatch.setattr(runner, "start_streaming_job", lambda **k: got.update(k))
    item = queue_manager.QueueItem(id="q", session_id="s", chat_id=1, project=None, text="x", prompt="x",
                                   images=[], model=None, effort=None, permission_mode=None, width=0, sel=[],
                                   surface="dashboard", flow="design", flow_by="you", bold=True)
    queue_manager._default_run_fn(item)
    assert got["bold"] is True


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


# shortcut: design-first names /mystical-design:polish, which ticket 09 adds; drop this when it lands.
_DUE = {"polish"}


def test_every_pack_name_a_skill_mentions_is_in_the_pack():
    assert not _DUE & set(_skills()), "a due skill landed: empty _DUE"
    for md in _skills().values():
        for name in re.findall(r"/?mystical-design:([\w-]+)", open(md, encoding="utf-8").read()):
            assert name in _skills() or name in _DUE, (md, name)


def test_design_first_names_each_skill_it_loads_by_its_pack_name():
    text = open(_skills()["design-first"], encoding="utf-8").read()
    steps = re.findall(r"^## (\d+)\. ", text, re.M)
    assert steps == [str(n) for n in range(1, 12)]
    for name in ("create-design-md", "frontend-design", "expo-native-ui", "expo-design-system",
                 "shadcn", "expo-animation", "polish"):
        assert f"/mystical-design:{name}" in text, name
    assert os.path.isfile(os.path.join(PACK, "references", "judgement-pass.md"))
    assert "judgement-pass.md" in text and "critique_design" in text and "inspect_ui" in text


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


def _bold_section(text):
    """design-first's Bold-run section: from its heading to the next ## heading."""
    m = re.search(r"^## Bold runs\n.*?(?=^## )", text, re.M | re.S)
    assert m, "no Bold runs section"
    return m.group(0)


def test_design_first_reads_the_bold_note_ticket_07_sends():
    text = open(_skills()["design-first"], encoding="utf-8").read()
    note = getattr(paths, "BOLD_NOTE", "Bold run: you lit BOLD.")   # ticket 07's line, once it lands
    assert f"`{note}`" in _bold_section(text)


def test_the_bold_section_stands_alone():
    """Taking it out leaves design-first's eleven steps whole, with nothing naming it."""
    text = open(_skills()["design-first"], encoding="utf-8").read()
    bold = _bold_section(text)
    for part in ("fifteen", "critique_design", "bold: true", "Go bold", "OFF-SYSTEM"):
        assert part in bold, part
    rest = text.replace(bold, "")
    assert re.findall(r"^## (\d+)\. ", rest, re.M) == [str(n) for n in range(1, 12)]
    assert not re.search(r"bold run|go bold|Bold runs", rest, re.I)


# --- Seam 1: the approved drafts reach every build -----------------------------

from test_paths import _end, _git, _turn, repo_session  # noqa: E402,F401 — fixtures
from test_tickets import make_set  # noqa: E402,F401 — fixture

DRAFT = os.path.join(".mystical", "design-drafts", "calm-header")


def _write_drafts(sid, t, root):
    """The design step's writes: a Direction's page and SPEC.md, and the repo's first DESIGN.md."""
    os.makedirs(os.path.join(root, DRAFT), exist_ok=True)
    with open(os.path.join(root, ".mystical", ".gitignore"), "w") as f:
        f.write("*\n")
    for p in (os.path.join(root, DRAFT, "a.html"), os.path.join(root, DRAFT, "SPEC.md"), os.path.join(root, "DESIGN.md")):
        with open(p, "w") as f:
            f.write("flow\n")
        store.append_event(sid, t, {"type": "tool", "name": "Write", "summary": p})


def _clean(co):
    return _git(co, "status", "--porcelain", "-uall") == ""


def _here_build(sid, main, fake_queue, path="design-here"):  # noqa: F811
    design = path == "design-here"
    paths.set_path(sid, path, "a calmer header", "claude", done=["grill"] if design else None)
    t = _turn(sid, "/mystical-design:design-first a calmer header" if design else "/mattpocock-skills:grill-with-docs x")
    if design:
        _write_drafts(sid, t, main)
    paths.step_done(sid, t)
    assert paths.continue_after_turn(_end(sid, t)) is True
    return store.get_session(sid)["cwd"], fake_queue.items[-1]["prompt"]


def test_a_designed_here_build_gets_the_drafts_and_the_polish_pass(switches, repo_session, fake_queue):  # noqa: F811
    switches.add("designpack")
    sid, main = repo_session
    co, prompt = _here_build(sid, main, fake_queue)
    for root in (co, main):                                   # copied, never moved
        assert os.path.isfile(os.path.join(root, DRAFT, "SPEC.md")) and _clean(root)
    assert prompt == (f"/mattpocock-skills:implement Work in {co} on branch feat/my-feature, and commit there. "
                      f"The approved design is in {DRAFT}: the approved Direction there is the source of truth, "
                      "and SPEC.md's Build section says which skills to load. When the build is done, run "
                      "/mystical-design:polish (the skill mystical-design:polish).")
    assert _git(co, "show", "feat/my-feature:DESIGN.md") == "flow"      # DESIGN.md rode with the build
    assert subprocess.run(["git", "-C", main, "cat-file", "-e", "master:DESIGN.md"]).returncode != 0


@pytest.mark.parametrize("path", ["design-here", "build-here"])
def test_a_closed_gate_or_a_build_flow_gets_none_of_it(switches, repo_session, fake_queue, path):  # noqa: F811
    if path == "build-here":
        switches.add("designpack")                            # open, but the flow wrote no drafts
    sid, main = repo_session
    co, prompt = _here_build(sid, main, fake_queue, path)
    assert prompt == f"/mattpocock-skills:implement Work in {co} on branch feat/my-feature, and commit there."
    assert not os.path.exists(os.path.join(co, DRAFT))


@pytest.mark.parametrize("gate", [True, False])
def test_a_designed_sets_tickets_and_merge_get_the_drafts(make_set, gate):  # noqa: F811
    s = make_set({"01": None}, build=False)              # its flow's path is the set's
    paths.set_option(s.flow, "designpack", gate)
    t = _turn(s.flow, "/mystical-design:design-first a calmer header")
    _write_drafts(s.flow, t, s.main)
    assert s.build() == ""
    wt, merge = s.state["tickets"]["01"]["worktree"], s.state["feature_checkout"]
    first = s.starts[-1]["prompt"]
    s.finish("01")
    (m,) = [x for x in s.starts if x["origin"] == "ticket-merge"]
    assert os.path.isdir(os.path.join(s.main, DRAFT)) and _clean(s.main)
    for root in (wt, merge):
        assert os.path.isdir(os.path.join(root, DRAFT)) is gate and _clean(root)
    assert (f"The approved design is in {DRAFT}: build to it." in first) is gate
    assert (f"run /mystical-design:polish (the skill mystical-design:polish) against the approved design in {DRAFT}. "
            "Then call StepDone." in m["prompt"]) is gate
