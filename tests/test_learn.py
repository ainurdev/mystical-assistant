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

from bridge import aifeatures, learn, runner, store  # noqa: E402

store.init()

LESSON = ("# Streaming Turns Over SSE\n\n**What changed** — added bridge/x.py.\n\n"
          "**The idea** — server-sent events are one-way and text-framed.\n")


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


if __name__ == "__main__":
    sys.exit(pytest.main([__file__, "-q"]))
