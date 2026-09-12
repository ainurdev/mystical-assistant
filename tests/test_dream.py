"""The nightly pass: when it is due, what it writes, and what a session carries.

The model call itself is stubbed — what is worth testing is the schedule (a
laptop asleep at 04:00 must still dream), the cleaning (ten bullets, no
narration), and the two switches that make this cost nothing when it is off.
Run: python -m pytest tests/test_dream.py -v
"""

import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import aifeatures, docs, dream  # noqa: E402

NOON = time.mktime((2026, 9, 12, 12, 0, 0, 0, 0, -1))
FOUR_AM = time.mktime((2026, 9, 12, 4, 0, 0, 0, 0, -1))


def _on(monkeypatch, value=True):
    monkeypatch.setattr(aifeatures, "enabled", lambda k: value if k == "dream" else False)


# --- when it runs ------------------------------------------------------------

def test_first_ever_pass_is_due():
    assert dream.due(NOON, None) == FOUR_AM


def test_not_due_twice_for_the_same_night():
    assert dream.due(NOON, FOUR_AM) is None


def test_due_again_the_next_day():
    assert dream.due(NOON + 86400, FOUR_AM) is not None


def test_a_night_with_the_laptop_shut_runs_at_the_next_start():
    """Due-ness is a function of (now, marker), not of a timer having fired —
    booting at noon still owes this morning's pass."""
    assert dream.due(NOON, FOUR_AM - 86400) == FOUR_AM


def test_before_four_am_the_slot_is_yesterdays():
    two_am = time.mktime((2026, 9, 12, 2, 0, 0, 0, 0, -1))
    assert dream.due(two_am, None) == FOUR_AM - 86400


# --- what it keeps -----------------------------------------------------------

def test_only_bullets_survive_the_clean():
    raw = ("Sure! Here is what I found:\n\n"
           "- the store is the single source of truth\n"
           "* events are append-only\n\n"
           "Let me know if you want more.")
    assert dream._clean(raw) == ("- the store is the single source of truth\n"
                                 "- events are append-only")


def test_a_fenced_reply_is_unwrapped():
    assert dream._clean("```markdown\n- one thing\n```") == "- one thing"


def test_prose_with_no_bullets_writes_nothing():
    """The prompt offers an empty reply when there is no durable lesson; a model
    that narrates instead must not leave narration in every future prompt."""
    assert dream._clean("There were no notable lessons this period.") == ""


def test_the_digest_is_capped():
    raw = "\n".join(f"- lesson {i}" for i in range(40))
    assert len(dream._clean(raw).splitlines()) == dream._MAX_LINES


# --- what a session carries --------------------------------------------------

def test_pack_is_empty_while_the_switch_is_off(monkeypatch):
    with tempfile.TemporaryDirectory() as d:
        os.makedirs(os.path.join(d, ".mystical", "docs"))
        with open(os.path.join(d, ".mystical", "docs", "dream.md"), "w") as f:
            f.write("- something the repo taught us")
        _on(monkeypatch, False)
        assert dream.pack(d) == ""
        _on(monkeypatch, True)
        assert "something the repo taught us" in dream.pack(d)


def test_pack_of_a_repo_that_never_dreamt_is_empty(monkeypatch):
    _on(monkeypatch)
    with tempfile.TemporaryDirectory() as d:
        assert dream.pack(d) == ""


def test_pack_is_truncated_rather_than_allowed_to_flood_the_prompt(monkeypatch):
    _on(monkeypatch)
    with tempfile.TemporaryDirectory() as d:
        os.makedirs(os.path.join(d, ".mystical", "docs"))
        with open(os.path.join(d, ".mystical", "docs", "dream.md"), "w") as f:
            f.write("\n".join(f"- a fairly wordy lesson number {i}" for i in range(300)))
        assert len(dream.pack(d)) < dream._MAX_CHARS + 400


# --- the switch takes its UI with it -----------------------------------------

def test_the_digest_leaves_the_docs_tab_when_the_switch_is_off(monkeypatch):
    with tempfile.TemporaryDirectory() as d:
        os.makedirs(os.path.join(d, ".mystical", "docs"))
        with open(os.path.join(d, ".mystical", "docs", "dream.md"), "w") as f:
            f.write("# What this repo has taught you\n\n- one thing\n")
        with open(os.path.join(d, "README.md"), "w") as f:
            f.write("# readme\n\nwords\n")
        _on(monkeypatch, False)
        paths = {doc["path"] for doc in docs.docs(d)}
        assert ".mystical/docs/dream.md" not in paths
        assert "README.md" in paths            # the rest of the tab is untouched
        _on(monkeypatch, True)
        assert ".mystical/docs/dream.md" in {doc["path"] for doc in docs.docs(d)}


# --- the pass itself ---------------------------------------------------------

def test_a_repo_with_nothing_new_is_not_asked(monkeypatch):
    """No lessons, no failures — no call. A quiet repo costs nothing."""
    monkeypatch.setattr(dream, "_material", lambda *a: ([], []))
    called = []
    monkeypatch.setattr(dream, "_ask", lambda *a: called.append(a) or "- x")
    with tempfile.TemporaryDirectory() as d:
        assert dream.dream_repo("/p", d, 0) is False
    assert not called


def test_a_written_digest_replaces_the_previous_one(monkeypatch):
    monkeypatch.setattr(dream, "_material",
                        lambda *a: ([{"title": "t", "concept": "c", "at": 1}], []))
    monkeypatch.setattr(dream, "_ask", lambda *a: "- the new lesson")
    with tempfile.TemporaryDirectory() as d:
        os.makedirs(os.path.join(d, ".mystical", "docs"))
        with open(os.path.join(d, ".mystical", "docs", "dream.md"), "w") as f:
            f.write("- the old lesson\n")
        assert dream.dream_repo("/p", d, 0) is True
        body = dream.read(d)
    assert "the new lesson" in body
    assert "the old lesson" not in body        # replaced, never appended


def test_a_declining_model_leaves_the_previous_digest_alone(monkeypatch):
    monkeypatch.setattr(dream, "_material",
                        lambda *a: ([{"title": "t", "concept": "c", "at": 1}], []))
    monkeypatch.setattr(dream, "_ask", lambda *a: "")
    with tempfile.TemporaryDirectory() as d:
        os.makedirs(os.path.join(d, ".mystical", "docs"))
        with open(os.path.join(d, ".mystical", "docs", "dream.md"), "w") as f:
            f.write("- yesterday's memory\n")
        assert dream.dream_repo("/p", d, 0) is False
        assert "yesterday's memory" in dream.read(d)


def test_failures_reach_the_prompt():
    p = dream._prompt("/repo", [], [("API OVERLOADED", 7), ("NO ANSWER", 2)])
    assert "7× API OVERLOADED" in p and "2× NO ANSWER" in p


# --- the one integration point ------------------------------------------------

def test_the_digest_reaches_the_system_prompt(monkeypatch):
    """The whole feature is this line. A digest that is written, read and shown
    but never injected is a diary, not a memory."""
    from bridge import runner
    _on(monkeypatch)
    with tempfile.TemporaryDirectory() as d:
        os.makedirs(os.path.join(d, ".mystical", "docs"))
        with open(os.path.join(d, ".mystical", "docs", "dream.md"), "w") as f:
            f.write("- the store is the single source of truth\n")
        cmd = runner._base_cmd("hi", 555, stream=False, cwd=d)
    appended = cmd[cmd.index("--append-system-prompt") + 1]
    assert "the store is the single source of truth" in appended


def test_nothing_is_injected_while_the_switch_is_off(monkeypatch):
    from bridge import runner
    _on(monkeypatch, False)
    with tempfile.TemporaryDirectory() as d:
        os.makedirs(os.path.join(d, ".mystical", "docs"))
        with open(os.path.join(d, ".mystical", "docs", "dream.md"), "w") as f:
            f.write("- a lesson nobody asked for\n")
        cmd = runner._base_cmd("hi", 555, stream=False, cwd=d)
    appended = cmd[cmd.index("--append-system-prompt") + 1]
    assert "a lesson nobody asked for" not in appended
