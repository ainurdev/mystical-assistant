"""skills: catalog install/remove into project + system scopes, and scanning."""

from bridge import skills
from bridge.skills_catalog import CATALOG, CATEGORIES


def test_catalog_shape():
    ids = [e["id"] for e in CATALOG]
    assert len(ids) == len(set(ids)) == 30
    assert {e["category"] for e in CATALOG} <= set(CATEGORIES)
    assert all(e["description"] and e["steps"] for e in CATALOG)


def test_install_scan_remove_project(tmp_path):
    proj = str(tmp_path)
    assert skills.installed(proj)["project"] == []

    ok, err = skills.install("readme", "project", proj)
    assert ok and not err
    md = tmp_path / ".claude" / "skills" / "readme" / "SKILL.md"
    assert md.read_text().startswith("---\nname: readme\n")

    found = skills.installed(proj)["project"]
    assert [(s["id"], s["category"], s["from_catalog"]) for s in found] == [
        ("readme", "writing", True)]
    assert found[0]["description"]  # parsed back out of the front matter

    assert skills.remove("readme", "project", proj) == (True, "")
    assert skills.installed(proj)["project"] == []


def test_system_scope_uses_system_root(tmp_path, monkeypatch):
    monkeypatch.setattr(skills, "SYSTEM_ROOT", str(tmp_path / "sys"))
    assert skills.install("adr", "system") == (True, "")
    assert [s["id"] for s in skills.installed()["system"]] == ["adr"]
    assert skills.remove("adr", "system") == (True, "")


def test_remove_refuses_what_we_did_not_write(tmp_path):
    proj = str(tmp_path)
    d = tmp_path / ".claude" / "skills"
    # hand-written skill: not in the catalog → never deleted from the UI
    (d / "my-own").mkdir(parents=True)
    (d / "my-own" / "SKILL.md").write_text("---\nname: my-own\n---\n")
    assert skills.remove("my-own", "project", proj)[0] is False
    assert (d / "my-own" / "SKILL.md").exists()

    # catalog id, but edited into a multi-file skill → also refused
    skills.install("readme", "project", proj)
    (d / "readme" / "notes.md").write_text("mine")
    assert skills.remove("readme", "project", proj)[0] is False
    assert (d / "readme" / "SKILL.md").exists()


def test_scan_lists_hand_written_skills(tmp_path):
    d = tmp_path / ".claude" / "skills" / "custom"
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text('---\nname: custom\ndescription: "does a thing"\n---\n')
    got = skills.installed(str(tmp_path))["project"][0]
    assert got == {"id": "custom", "name": "custom", "description": "does a thing",
                   "scope": "project", "category": "other", "from_catalog": False}


def test_bad_scope_and_unknown_id(tmp_path):
    assert skills.install("readme", "nope", str(tmp_path))[0] is False
    assert skills.install("no-such-skill", "project", str(tmp_path))[0] is False
    assert skills.install("readme", "project", None)[0] is False
