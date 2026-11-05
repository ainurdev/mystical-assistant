"""The vendored Matt Pocock skill pack under bridge/skills/mattpocock/: the
manifest's 27 skills are all present, four are unlocked for the model, twelve
stay user-only, and the licence is MIT. Run: python3 -m pytest tests/test_vendored_pack.py -q"""

import glob
import json
import os

import bridge

PACK = os.path.join(os.path.dirname(bridge.__file__), "skills", "mattpocock")
UNLOCKED = {"grill-with-docs", "grill-me", "improve-codebase-architecture", "teach"}
USER_ONLY = {"ask-matt", "implement", "implement-spec", "retro", "setup-matt-pocock-skills", "to-spec",
             "to-tickets", "triage", "wayfinder", "handoff", "to-questionnaire", "wait-what"}


def _skill_md(name):
    hits = glob.glob(os.path.join(PACK, "skills", "*", name, "SKILL.md"))
    assert len(hits) == 1, (name, hits)
    return hits[0]


def test_manifest_lists_27_existing_skills():
    m = json.load(open(os.path.join(PACK, ".claude-plugin", "plugin.json")))
    assert m["name"] == "mattpocock-skills" and len(m["skills"]) == 27
    for rel in m["skills"]:
        assert os.path.isfile(os.path.join(PACK, rel, "SKILL.md"))


def test_unlocked_and_user_only_flags():
    for name, flagged in [(n, False) for n in UNLOCKED] + [(n, True) for n in USER_ONLY]:
        text = open(_skill_md(name)).read()
        assert ("disable-model-invocation: true" in text) is flagged, name


def test_licence_is_mit():
    assert "MIT License" in open(os.path.join(PACK, "LICENSE")).read()


def test_spec_and_tickets_go_to_the_mystical_tickets_folder():
    """Two edits from upstream (README): BUILD reads what these two skills write, so the
    skills, PACK_TEXT and bridge/tickets.py must name one place."""
    tk = open(_skill_md("to-tickets")).read()
    assert "write one file per ticket under `.mystical/tickets/<feature-slug>/<NN>-<slug>.md`" in tk
    assert ".scratch" not in tk
    assert "(local files: `.mystical/tickets/<feature-slug>/SPEC.md`)" in open(_skill_md("to-spec")).read()
    from bridge import paths
    assert ".mystical/tickets/<feature-slug>/SPEC.md" in paths.PACK_TEXT
    assert "<NN>-<slug>.md" in paths.PACK_TEXT
