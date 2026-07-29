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
         "scope": "project", "category": "other", "from_catalog": False}]


def test_bad_scope_and_unknown_id(tmp_path):
    assert skills.install("readme", "nope", str(tmp_path))[0] is False
    assert skills.install("no-such-skill", "project", str(tmp_path))[0] is False
    assert skills.install("readme", "project", None)[0] is False
