"""Unit tests for bridge.learn — per-turn lessons written into a repo's
.mystical/learn/. runner.run_blocking (which spawns `claude`) is stubbed;
everything else is real store / filesystem code.
Run: `python tests/test_learn.py`
"""

import os
import sys
import tempfile

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ.setdefault("BASE_PATH", "/tmp")
os.environ["BRIDGE_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")

from bridge import aifeatures, browser, config, learn, runner, store  # noqa: E402

store.init()

LESSON = ("# Streaming Turns Over SSE\n\n**What changed** — added bridge/x.py.\n\n"
          "**The idea** — server-sent events are one-way and text-framed.\n")

CONCEPT_LESSON = ("# Streaming Turns Over SSE\n> concept: protocols & apis\n\n"
                  "**What changed** — added bridge/x.py.\n")


@pytest.fixture(autouse=True)
def _lessons_on(monkeypatch):
    """Lessons ship OFF (bridge/aifeatures.py); these tests are about what they
    do once switched on."""
    monkeypatch.setattr(aifeatures, "enabled", lambda k: k == "learn")


@pytest.fixture(autouse=True)
def _restore_run_blocking():
    orig = runner.run_blocking
    try:
        yield
    finally:
        runner.run_blocking = orig


@pytest.fixture()
def repo():
    return tempfile.mkdtemp()


def _session_with_turn(cwd, prompt="add SSE streaming", reply="Done — added bridge/x.py."):
    s = store.create_session(1, "/proj", cwd=cwd)
    tid = "turn-" + os.urandom(4).hex()
    store.start_turn(s["id"], tid, prompt, [])
    store.append_event(s["id"], tid, {"type": "tool", "name": "Write", "summary": "bridge/x.py"})
    store.append_event(s["id"], tid, {"type": "text", "text": reply})
    store.finish_turn(tid, "done", 0.0, 1)
    return store.get_session(s["id"]), tid


def _stub(text):
    runner.run_blocking = lambda *a, **k: (text, None, 0.0, False)


def test_writes_a_numbered_lesson(repo):
    sess, tid = _session_with_turn(repo)
    _stub(LESSON)
    learn.generate_after_turn(1, sess, tid)

    got = learn.lessons(repo)
    assert len(got) == 1
    assert got[0]["file"] == "0001-streaming-turns-over-sse.md"
    assert got[0]["title"] == "Streaming Turns Over SSE"
    assert "server-sent events" in learn.read(repo, got[0]["file"])


def test_numbering_increments_and_lists_newest_first(repo):
    for n in (1, 2):
        sess, tid = _session_with_turn(repo)
        _stub(LESSON.replace("Streaming Turns Over SSE", f"Lesson Number {n}"))
        learn.generate_after_turn(1, sess, tid)

    files = [ls["file"] for ls in learn.lessons(repo)]
    assert files == ["0002-lesson-number-2.md", "0001-lesson-number-1.md"]


def test_skip_writes_nothing(repo):
    sess, tid = _session_with_turn(repo, prompt="what does this file do?")
    _stub("SKIP")
    learn.generate_after_turn(1, sess, tid)
    assert learn.lessons(repo) == []


def test_reply_without_a_heading_is_dropped(repo):
    """No '# ' line means the model lost the format — there is nothing to name
    the file after, so nothing is written."""
    sess, tid = _session_with_turn(repo)
    _stub("Sure! Here is what I think you should learn about SSE today.")
    learn.generate_after_turn(1, sess, tid)
    assert learn.lessons(repo) == []


def test_fenced_reply_is_unwrapped(repo):
    sess, tid = _session_with_turn(repo)
    _stub(f"```markdown\n{LESSON}```")
    learn.generate_after_turn(1, sess, tid)
    body = learn.read(repo, learn.lessons(repo)[0]["file"])
    assert body.startswith("# Streaming Turns Over SSE")
    assert "```markdown" not in body


def test_off_globally_writes_nothing(repo, monkeypatch):
    monkeypatch.setattr(aifeatures, "enabled", lambda k: False)
    sess, tid = _session_with_turn(repo)
    _stub(LESSON)
    learn.generate_after_turn(1, sess, tid)
    assert learn.lessons(repo) == []


def test_off_for_one_repo_writes_nothing(repo, monkeypatch):
    monkeypatch.setattr(learn, "repo_enabled", lambda p: False)
    sess, tid = _session_with_turn(repo)
    _stub(LESSON)
    learn.generate_after_turn(1, sess, tid)
    assert learn.lessons(repo) == []


def test_read_rejects_a_path_outside_the_lesson_dir(repo):
    """`file` comes from the browser: only names actually listed are readable."""
    sess, tid = _session_with_turn(repo)
    _stub(LESSON)
    learn.generate_after_turn(1, sess, tid)
    assert learn.read(repo, "../../../etc/passwd") is None
    assert learn.read(repo, "../.gitignore") is None
    assert learn.read(repo, "nope.md") is None


def test_a_failed_model_call_never_raises(repo):
    sess, tid = _session_with_turn(repo)

    def boom(*a, **k):
        raise RuntimeError("claude is not installed")

    runner.run_blocking = boom
    learn.generate_after_turn(1, sess, tid)      # must not raise
    assert learn.lessons(repo) == []


def test_a_repo_without_lessons_is_not_littered(repo):
    """Listing must not create .mystical/ in every repo the tab is opened on."""
    assert learn.lessons(repo) == []
    assert not os.path.exists(os.path.join(repo, ".mystical"))


# --- concepts: the shelf the LEARN tab groups a lesson onto -----------------

def test_a_concept_line_is_shelved_with_the_lesson(repo):
    sess, tid = _session_with_turn(repo)
    _stub(CONCEPT_LESSON)
    learn.generate_after_turn(1, sess, tid)

    got = learn.lessons(repo)[0]
    assert got["concept"] == "protocols & apis"
    assert got["title"] == "Streaming Turns Over SSE"   # the tag is not the title


def test_a_concept_off_the_list_is_dropped(repo):
    """An invented shelf fragments the grouping into near-synonyms — better
    unsorted than wrong."""
    sess, tid = _session_with_turn(repo)
    _stub("# A Title\n> concept: vibes\n\n**What changed** — x.\n")
    learn.generate_after_turn(1, sess, tid)

    assert learn.lessons(repo)[0]["concept"] == ""


def test_a_lesson_written_before_concepts_is_unshelved(repo):
    sess, tid = _session_with_turn(repo)
    _stub(LESSON)                       # no concept line, like the ones on disk
    learn.generate_after_turn(1, sess, tid)

    assert learn.lessons(repo)[0]["concept"] == ""


def test_all_lessons_span_repos_newest_first(repo, monkeypatch):
    """The ALL scope: one list across repos, each lesson naming its own, so the
    active session's repo can't carry a lesson off the screen."""
    other = tempfile.mkdtemp()
    for cwd, text, when in ((repo, LESSON, 1000), (other, CONCEPT_LESSON, 2000)):
        sess, tid = _session_with_turn(cwd)
        _stub(text)
        learn.generate_after_turn(1, sess, tid)
        d = os.path.join(cwd, ".mystical", "learn")
        for n in os.listdir(d):         # pinned, or the two tie on a coarse fs
            os.utime(os.path.join(d, n), (when, when))

    names = [os.path.basename(repo), os.path.basename(other)]
    monkeypatch.setattr(config, "BASE_PATH", os.path.dirname(repo))
    monkeypatch.setattr(browser, "list_projects", lambda *a, **k: ["/" + n for n in names])

    got = learn.all_lessons()
    assert [ls["project"] for ls in got] == ["/" + names[1], "/" + names[0]]
    assert [ls["concept"] for ls in got] == ["protocols & apis", ""]


def test_all_lessons_skips_repos_that_never_had_one(repo, monkeypatch):
    monkeypatch.setattr(config, "BASE_PATH", os.path.dirname(repo))
    monkeypatch.setattr(browser, "list_projects", lambda *a, **k: ["/" + os.path.basename(repo)])
    assert learn.all_lessons() == []


# --- topics: the free grouping inside a concept shelf ------------------------

TOPIC_LESSON = ("# Streaming Turns Over SSE\n> concept: protocols & apis\n"
                "> topic: server push\n\n**The idea** — one-way text frames.\n")


def test_a_topic_line_rides_with_the_lesson(repo):
    sess, tid = _session_with_turn(repo)
    _stub(TOPIC_LESSON)
    learn.generate_after_turn(1, sess, tid)

    got = learn.lessons(repo)[0]
    assert got["topic"] == "server push"
    assert got["concept"] == "protocols & apis"    # both header lines parse


def test_a_topic_without_a_concept_still_parses(repo):
    sess, tid = _session_with_turn(repo)
    _stub("# A Title\n> topic: server push\n\n**The idea** — x.\n")
    learn.generate_after_turn(1, sess, tid)

    got = learn.lessons(repo)[0]
    assert got["topic"] == "server push"
    assert got["concept"] == ""


def test_prompt_asks_for_a_topic_and_feeds_prior_ones(repo):
    sess, tid = _session_with_turn(repo)
    _stub(TOPIC_LESSON)
    learn.generate_after_turn(1, sess, tid)

    captured = {}

    def cap(chat, prompt, **k):
        captured["p"] = prompt
        return ("SKIP", None, 0.0, False)

    runner.run_blocking = cap
    sess, tid = _session_with_turn(repo)
    learn.generate_after_turn(1, sess, tid)

    assert "> topic:" in captured["p"]              # the format asks for one
    assert "server push" in captured["p"]           # prior topics are fed back


# --- backfill: tagging the lessons written before topics existed -------------

def test_backfill_tags_untagged_lessons_once(repo):
    sess, tid = _session_with_turn(repo)
    _stub(LESSON)                                   # no concept, no topic
    learn.generate_after_turn(1, sess, tid)

    _stub("> concept: protocols & apis\n> topic: server push")
    assert learn.backfill(1, repo) == 1
    got = learn.lessons(repo)[0]
    assert got["concept"] == "protocols & apis"
    assert got["topic"] == "server push"
    body = learn.read(repo, got["file"])
    assert body.startswith("# Streaming Turns Over SSE\n> concept:")

    calls = []

    def count(*a, **k):
        calls.append(1)
        return ("> topic: x", None, 0.0, False)

    runner.run_blocking = count
    assert learn.backfill(1, repo) == 0             # second run is a no-op
    assert calls == []                              # and never reached the model


def test_backfill_keeps_an_existing_concept(repo):
    sess, tid = _session_with_turn(repo)
    _stub(CONCEPT_LESSON)                           # concept present, no topic
    learn.generate_after_turn(1, sess, tid)

    _stub("> concept: testing\n> topic: server push")   # tries to flip the shelf
    learn.backfill(1, repo)
    got = learn.lessons(repo)[0]
    assert got["concept"] == "protocols & apis"     # the original survives
    assert got["topic"] == "server push"


def test_backfill_ignores_a_malformed_reply(repo):
    sess, tid = _session_with_turn(repo)
    _stub(LESSON)
    learn.generate_after_turn(1, sess, tid)

    _stub("Sure! I think the concept is probably vibes.")
    assert learn.backfill(1, repo) == 0
    assert learn.lessons(repo)[0]["topic"] == ""    # file untouched


def test_backfill_rejects_a_concept_off_the_list(repo):
    """An invented shelf would fragment the grouping — the topic still lands."""
    sess, tid = _session_with_turn(repo)
    _stub(LESSON)
    learn.generate_after_turn(1, sess, tid)

    _stub("> concept: vibes\n> topic: server push")
    assert learn.backfill(1, repo) == 1
    got = learn.lessons(repo)[0]
    assert got["concept"] == ""                     # the invented one is dropped
    assert got["topic"] == "server push"


def test_backfill_feeds_a_coined_topic_to_the_next_file(repo):
    """One run, two files: the topic coined for the first is offered to the
    second, so a run does not invent two names for one thing."""
    for _ in range(2):
        sess, tid = _session_with_turn(repo)
        _stub(LESSON)
        learn.generate_after_turn(1, sess, tid)

    seen = []

    def cap(chat, prompt, **k):
        seen.append(prompt)
        return ("> concept: testing\n> topic: drift guards", None, 0.0, False)

    runner.run_blocking = cap
    assert learn.backfill(1, repo) == 2
    assert "none yet" in seen[0]                    # nothing known on the first
    assert "drift guards" in seen[1]                # coined, then offered


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
