"""skills: catalog install/remove into project + system scopes, and scanning."""

import pytest

from bridge import skills
from bridge.skills_catalog import CATALOG, CATEGORIES, skill_md


@pytest.fixture(autouse=True)
def _no_network(monkeypatch):
    """Downloads are stubbed suite-wide — no test may reach GitHub."""
    monkeypatch.setattr(skills, "_fetch", lambda url: (f"---\nname: x\n---\nfrom {url}\n", ""))


def test_catalog_shape():
    ids = [e["id"] for e in CATALOG]
    assert len(ids) == len(set(ids)) == 62
    assert {e["category"] for e in CATALOG} == set(CATEGORIES)
    # every entry renders locally or downloads — never neither, never both
    assert all(bool(e.get("steps")) != bool(e.get("url")) for e in CATALOG)
    assert all(e["name"] and e["description"] for e in CATALOG)
    # a downloaded entry credits where it came from
    assert all(e.get("repo") for e in CATALOG if e.get("url"))


def test_install_scan_remove_project(tmp_path):
    proj = str(tmp_path)
    assert skills.installed(proj)["project"] == []

    assert skills.install("readme", "project", proj) == (True, "")
    md = tmp_path / ".claude" / "skills" / "readme" / "SKILL.md"
    assert md.read_text() == skill_md(next(e for e in CATALOG if e["id"] == "readme"))

    found = skills.installed(proj)["project"]
    assert [(s["id"], s["category"], s["from_catalog"]) for s in found] == [
        ("readme", "writing", True)]
    assert found[0]["description"]  # parsed back out of the front matter

    assert skills.remove("readme", "project", proj) == (True, "")
    assert skills.installed(proj)["project"] == []


def test_description_survives_the_round_trip(tmp_path):
    """Most catalog descriptions carry an em-dash; it must reach the panel as
    one, not as a literal \\u2014."""
    proj = str(tmp_path)
    entry = next(e for e in CATALOG if e["id"] == "api-design")
    assert "—" in entry["description"]
    skills.install("api-design", "project", proj)
    assert skills.installed(proj)["project"][0]["description"] == entry["description"]


def test_community_entry_installs_the_upstream_file(tmp_path):
    proj = str(tmp_path)
    assert skills.install("brainstorming", "project", proj) == (True, "")
    d = tmp_path / ".claude" / "skills" / "brainstorming"
    assert "raw.githubusercontent.com" in (d / "SKILL.md").read_text()
    assert "obra/superpowers" in (d / skills.MARKER).read_text()


def test_download_failure_leaves_nothing_behind(tmp_path, monkeypatch):
    monkeypatch.setattr(skills, "_fetch", lambda url: ("", "download failed: URLError"))
    ok, err = skills.install("brainstorming", "project", str(tmp_path))
    assert (ok, err) == (False, "download failed: URLError")
    assert not (tmp_path / ".claude" / "skills" / "brainstorming").exists()


def test_check_updates_spots_an_upstream_change(tmp_path, monkeypatch):
    proj = str(tmp_path)
    monkeypatch.setattr(skills, "SYSTEM_ROOT", str(tmp_path / "sys"))
    skills.install("brainstorming", "project", proj)   # downloaded entry
    skills.install("readme", "system")                 # locally rendered entry
    assert skills.check_updates(proj) == {"outdated": [], "checked": 2, "unreachable": 0}

    # upstream moves on
    monkeypatch.setattr(skills, "_fetch", lambda url: ("---\nname: x\n---\nrewritten\n", ""))
    r = skills.check_updates(proj)
    assert r["outdated"] == [{"id": "brainstorming", "scope": "project"}]
    assert (r["checked"], r["unreachable"]) == (2, 0)

    # re-installing IS the update
    assert skills.install("brainstorming", "project", proj) == (True, "")
    assert skills.check_updates(proj)["outdated"] == []


def test_check_updates_leaves_your_edits_alone(tmp_path, monkeypatch):
    """Editing an installed skill opts it out of updates — one click on UPDATE
    ALL must never throw the edit away."""
    proj = str(tmp_path)
    monkeypatch.setattr(skills, "SYSTEM_ROOT", str(tmp_path / "sys"))
    skills.install("brainstorming", "project", proj)
    md = tmp_path / ".claude" / "skills" / "brainstorming" / "SKILL.md"
    md.write_text(md.read_text() + "\nmy own note\n")

    monkeypatch.setattr(skills, "_fetch", lambda url: ("---\nname: x\n---\nrewritten\n", ""))
    assert skills.check_updates(proj) == {"outdated": [], "checked": 1, "unreachable": 1}
    assert "my own note" in md.read_text()


def test_check_updates_treats_offline_as_not_outdated(tmp_path, monkeypatch):
    proj = str(tmp_path)
    monkeypatch.setattr(skills, "SYSTEM_ROOT", str(tmp_path / "sys"))
    skills.install("brainstorming", "project", proj)
    monkeypatch.setattr(skills, "_fetch", lambda url: ("", "download failed: URLError"))
    assert skills.check_updates(proj) == {"outdated": [], "checked": 1, "unreachable": 1}


def test_check_updates_ignores_skills_of_your_own(tmp_path, monkeypatch):
    proj = str(tmp_path)
    monkeypatch.setattr(skills, "SYSTEM_ROOT", str(tmp_path / "sys"))
    d = tmp_path / ".claude" / "skills" / "stop-slop"   # a catalog name, but yours
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text("---\nname: stop-slop\n---\nmine\n")
    assert skills.check_updates(proj) == {"outdated": [], "checked": 0, "unreachable": 0}


def test_system_scope_uses_system_root(tmp_path, monkeypatch):
    monkeypatch.setattr(skills, "SYSTEM_ROOT", str(tmp_path / "sys"))
    assert skills.install("adr", "system") == (True, "")
    assert [s["id"] for s in skills.installed()["system"]] == ["adr"]
    assert skills.remove("adr", "system") == (True, "")


def test_never_clobbers_a_skill_of_your_own(tmp_path):
    """The catalog shares names with real skills (stop-slop, frontend-design…),
    so a same-named hand-written skill must survive install AND remove."""
    proj = str(tmp_path)
    d = tmp_path / ".claude" / "skills" / "stop-slop"
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text("---\nname: stop-slop\n---\nmine, hand-written\n")

    assert skills.install("stop-slop", "project", proj) == (
        False, "a skill of your own already has that name here")
    assert skills.remove("stop-slop", "project", proj)[0] is False
    assert (d / "SKILL.md").read_text().endswith("mine, hand-written\n")

    # and it is reported as the user's own, not as a catalog skill
    got = skills.installed(proj)["project"][0]
    assert got["from_catalog"] is False and got["category"] == "other"


def test_remove_refuses_when_files_were_added(tmp_path):
    proj = str(tmp_path)
    skills.install("readme", "project", proj)
    (tmp_path / ".claude" / "skills" / "readme" / "notes.md").write_text("mine")
    assert skills.remove("readme", "project", proj) == (False, "directory has other files")
    assert (tmp_path / ".claude" / "skills" / "readme" / "SKILL.md").exists()


def test_scan_lists_hand_written_skills(tmp_path):
    d = tmp_path / ".claude" / "skills" / "custom"
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text('---\nname: custom\ndescription: "does a thing"\n---\n')
    assert skills.installed(str(tmp_path))["project"] == [
        {"id": "custom", "name": "custom", "description": "does a thing",
         "scope": "project", "category": "other", "from_catalog": False,
         "from_design": False, "design_project": None}]


def test_bad_scope_and_unknown_id(tmp_path):
    assert skills.install("readme", "nope", str(tmp_path))[0] is False
    assert skills.install("no-such-skill", "project", str(tmp_path))[0] is False
    assert skills.install("readme", "project", None)[0] is False


def test_a_design_sourced_skill_is_labelled_as_one(tmp_path):
    d = tmp_path / "mystical-assistant-design-system"
    d.mkdir()
    (d / "SKILL.md").write_text(
        "---\nname: mystical-assistant-design\ndescription: phosphor CRT HUD\n---\nbody\n")
    (d / skills.DESIGN_MARKER).write_text("24409d88-c74d-4d26-becb-69672612173f\ntokens/colors.css\n")
    found = skills._scan(str(tmp_path), "project")
    assert len(found) == 1
    assert found[0]["from_design"] is True
    assert found[0]["design_project"] == "24409d88-c74d-4d26-becb-69672612173f"
    assert found[0]["from_catalog"] is False


def test_a_hand_written_skill_is_neither(tmp_path):
    d = tmp_path / "mine"
    d.mkdir()
    (d / "SKILL.md").write_text("---\nname: mine\ndescription: mine\n---\n")
    found = skills._scan(str(tmp_path), "project")
    assert found[0]["from_design"] is False
    assert found[0]["design_project"] is None
    assert found[0]["from_catalog"] is False


def test_a_design_marker_with_no_id_does_not_crash(tmp_path):
    """A truncated write, or a marker someone emptied by hand."""
    d = tmp_path / "ds"
    d.mkdir()
    (d / "SKILL.md").write_text("---\nname: ds\ndescription: d\n---\n")
    (d / skills.DESIGN_MARKER).write_text("")
    found = skills._scan(str(tmp_path), "project")
    assert found[0]["from_design"] is True
    assert found[0]["design_project"] is None


def test_remove_accepts_a_design_sourced_skill(tmp_path):
    """Provenance is the whole point of the marker: bridge-installed directories
    may be removed from the UI, hand-written ones may not."""
    d = tmp_path / ".claude" / "skills" / "ds"
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text("---\nname: ds\ndescription: d\n---\n")
    (d / skills.DESIGN_MARKER).write_text("aaaa-1\n")
    assert skills.remove("ds", "project", str(tmp_path))[0] is True
    assert not d.exists()


def test_remove_still_refuses_a_hand_written_skill_with_neither_marker(tmp_path):
    """Widening remove() to also accept DESIGN_MARKER must not loosen the
    refusal for a plain hand-written skill carrying no marker at all."""
    d = tmp_path / ".claude" / "skills" / "mine"
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text("---\nname: mine\ndescription: mine\n---\n")
    assert skills.remove("mine", "project", str(tmp_path))[0] is False
    assert (d / "SKILL.md").exists()


def test_remove_deletes_a_design_sourced_skill_with_nested_content(tmp_path):
    """A real pull is more than two files — tokens/, guidelines/, and friends.
    remove() must walk the tree, not require an exact SKILL.md+marker match."""
    d = tmp_path / ".claude" / "skills" / "ds"
    (d / "tokens").mkdir(parents=True)
    (d / "guidelines").mkdir()
    (d / "SKILL.md").write_text("---\nname: ds\ndescription: d\n---\n")
    (d / "tokens" / "colors.css").write_text(":root { --a: #000; }\n")
    (d / "guidelines" / "type.html").write_text("<p>type</p>\n")
    (d / skills.DESIGN_MARKER).write_text(
        "aaaa-1\ntokens/colors.css\nguidelines/type.html\n")
    assert skills.remove("ds", "project", str(tmp_path)) == (True, "")
    assert not d.exists()


def test_remove_refuses_a_design_sourced_skill_with_an_unrecorded_file(tmp_path):
    """Anything on disk the marker didn't record pulling is a file the user
    added since — remove() must refuse the whole directory, and touch nothing
    in it, rather than delete around the extra file."""
    d = tmp_path / ".claude" / "skills" / "ds"
    (d / "tokens").mkdir(parents=True)
    (d / "guidelines").mkdir()
    (d / "SKILL.md").write_text("---\nname: ds\ndescription: d\n---\n")
    (d / "tokens" / "colors.css").write_text(":root { --a: #000; }\n")
    (d / "guidelines" / "type.html").write_text("<p>type</p>\n")
    (d / "guidelines" / "notes.md").write_text("mine, not part of the pull\n")
    (d / skills.DESIGN_MARKER).write_text(
        "aaaa-1\ntokens/colors.css\nguidelines/type.html\n")
    assert skills.remove("ds", "project", str(tmp_path)) == (False, "directory has other files")
    assert d.exists()
    assert (d / "SKILL.md").exists()
    assert (d / "tokens" / "colors.css").exists()
    assert (d / "guidelines" / "type.html").exists()
    assert (d / "guidelines" / "notes.md").exists()
    assert (d / skills.DESIGN_MARKER).exists()


def test_remove_refuses_a_design_sourced_skill_with_a_truncated_marker(tmp_path):
    """A truncated write or a hand-emptied marker carries no trustworthy
    delete list — remove() must refuse rather than guess, and never raise."""
    d = tmp_path / ".claude" / "skills" / "ds"
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text("---\nname: ds\ndescription: d\n---\n")
    (d / skills.DESIGN_MARKER).write_text("")
    ok, err = skills.remove("ds", "project", str(tmp_path))
    assert ok is False
    assert err
    assert (d / "SKILL.md").exists()
    assert (d / skills.DESIGN_MARKER).exists()


def test_remove_leaves_identity_intact_when_a_content_delete_fails(tmp_path, monkeypatch):
    """Deletion order must be content-first, identity-last: when a delete
    fails partway through the content sweep, SKILL.md and the marker must
    still be on disk afterwards, so the directory still reads as
    design-sourced and the exact same remove() call can just be retried.
    Nothing here depends on hash/set order — a counter forces the failure
    onto whichever content file the implementation happens to process
    second, so this is deterministic regardless of iteration order."""
    d = tmp_path / ".claude" / "skills" / "ds"
    (d / "tokens").mkdir(parents=True)
    (d / "guidelines").mkdir()
    (d / "SKILL.md").write_text("---\nname: ds\ndescription: d\n---\n")
    (d / "tokens" / "colors.css").write_text(":root { --a: #000; }\n")
    (d / "guidelines" / "type.html").write_text("<p>type</p>\n")
    (d / skills.DESIGN_MARKER).write_text(
        "aaaa-1\ntokens/colors.css\nguidelines/type.html\n")

    real_remove = skills.os.remove
    calls = []

    def flaky_remove(path, *a, **kw):
        calls.append(path)
        if len(calls) == 2:  # let the first content delete succeed, fail the second
            raise PermissionError(13, "Permission denied")
        real_remove(path, *a, **kw)

    monkeypatch.setattr(skills.os, "remove", flaky_remove)

    ok, err = skills.remove("ds", "project", str(tmp_path))

    assert ok is False
    assert err
    # identity survives: still design-sourced, still retryable
    assert (d / "SKILL.md").exists()
    assert (d / skills.DESIGN_MARKER).exists()
    # exactly one content file got removed before the failure — proves this
    # is a partial sweep, not an all-or-nothing loop
    remaining = [(d / "tokens" / "colors.css").exists(),
                 (d / "guidelines" / "type.html").exists()]
    assert remaining.count(True) == 1


def test_remove_refuses_a_design_sourced_skill_with_a_non_utf8_marker(tmp_path):
    """Invalid bytes in the marker must never raise UnicodeDecodeError out of
    remove() — errors="replace" keeps this on the same fail-open path as
    every other malformed-marker case. The corrupted marker no longer
    matches what is really on disk, so it refuses rather than mis-deletes."""
    d = tmp_path / ".claude" / "skills" / "ds"
    (d / "tokens").mkdir(parents=True)
    (d / "SKILL.md").write_text("---\nname: ds\ndescription: d\n---\n")
    (d / "tokens" / "colors.css").write_text(":root { --a: #000; }\n")
    (d / skills.DESIGN_MARKER).write_bytes(b"\xff\xfe\xfa\xfb")

    ok, err = skills.remove("ds", "project", str(tmp_path))

    assert ok is False
    assert err
    assert (d / "SKILL.md").exists()
    assert (d / "tokens" / "colors.css").exists()
    assert (d / skills.DESIGN_MARKER).exists()


def test_design_id_tolerates_a_non_utf8_marker(tmp_path):
    """_design_id gates a display label, not a delete, but the same
    UnicodeDecodeError gap applies — it must return, never raise."""
    d = tmp_path / "ds"
    d.mkdir()
    (d / skills.DESIGN_MARKER).write_bytes(b"\xff\xfe not valid utf-8\n")
    is_design, _design_id = skills._design_id(str(d))
    assert is_design is True
