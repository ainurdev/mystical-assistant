"""The vendored Matt Pocock skill pack under bridge/skills/mattpocock/: the
manifest's 27 skills are all present, four are unlocked for the model, twelve
stay user-only, and the licence is MIT. Run: python3 -m pytest tests/test_vendored_pack.py -q"""

import glob
import json
import os
import subprocess
import sys

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
    skills, pack_text() and bridge/tickets.py must name one place."""
    tk = open(_skill_md("to-tickets")).read()
    assert "write one file per ticket under `.mystical/tickets/<feature-slug>/<NN>-<slug>.md`" in tk
    assert ".scratch" not in tk
    assert "(local files: `.mystical/tickets/<feature-slug>/SPEC.md`)" in open(_skill_md("to-spec")).read()
    from bridge import paths
    assert ".mystical/tickets" not in paths.pack_text()   # the skills name the place; the pack must not write the spec itself


def test_a_review_and_ask_matt_look_where_the_spec_and_tickets_were_written():
    """Two more edits from upstream (README): code-review finds its spec, and ask-matt
    points at the tickets, in the folder to-spec and to-tickets write to."""
    cr, am = open(_skill_md("code-review")).read(), open(_skill_md("ask-matt")).read()
    assert "A spec file under `docs/`, `specs/`, or `.mystical/tickets/` matching the branch name or feature." in cr
    assert "one file per ticket under `.mystical/tickets/<feature-slug>/`, worked blockers-first by hand" in am
    assert ".scratch" not in cr + am


def test_the_retro_scan_counts_a_transcripts_calls(tmp_path):
    """One local file (README): retro's step 2 names scan.py, which reads a transcript.
    Lines without a timestamp repeat the calls (api-request-blob) and are skipped."""
    retro = _skill_md("retro")
    assert "`scan.py` in this skill's folder" in open(retro).read()
    t = tmp_path / "s.jsonl"
    t.write_text("\n".join(json.dumps(r) for r in [
        {"timestamp": "2026-11-12T10:00:00Z", "message": {"role": "assistant", "content": [
            {"type": "tool_use", "id": "a", "name": "Bash", "input": {"command": "ls"}}]}},
        {"timestamp": "2026-11-12T10:00:02Z", "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": "a", "content": "no such file", "is_error": True}]}},
        {"type": "api-request-blob", "message": {"role": "assistant", "content": [
            {"type": "tool_use", "id": "a", "name": "Bash", "input": {"command": "ls"}}]}},
    ]))
    out = subprocess.run([sys.executable, os.path.join(os.path.dirname(retro), "scan.py"), str(t), "stats"],
                         capture_output=True, text=True, check=True).stdout
    assert "1 tool calls, 1 errors" in out and "wait=     2s" in out
