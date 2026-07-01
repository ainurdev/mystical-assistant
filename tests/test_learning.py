"""Unit tests for capture extraction parsing, gating, and teaching prompts."""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ.setdefault("BASE_PATH", "/tmp")
os.environ.setdefault("BRIDGE_DB", os.path.join(tempfile.mkdtemp(), "t.db"))

from bridge import config, learning, runner, store  # noqa: E402

store.init()


def _fake_run(result):
    """Return a run_blocking stand-in yielding `result` as the text field."""
    def _f(chat_id, prompt, resume_id=None, cwd=None, timeout=None, model=None):
        _f.last_prompt = prompt
        _f.last_model = model
        return (result, None, None, False)
    return _f


def test_parse_candidates_valid_and_capped():
    raw = ('[{"title":"A","snippet":"a()","why_it_matters":"x"},'
           '{"title":"B","snippet":"","why_it_matters":"y"},'
           '{"title":"C","snippet":"","why_it_matters":"z"}]')
    out = learning._parse_candidates(raw)
    assert [c["title"] for c in out] == ["A", "B"]   # capped at 2


def test_parse_candidates_strips_fences():
    raw = "```json\n[{\"title\":\"A\",\"why_it_matters\":\"x\"}]\n```"
    out = learning._parse_candidates(raw)
    assert out and out[0]["title"] == "A"
    assert out[0]["snippet"] == ""            # missing key → default ""


def test_parse_candidates_malformed_returns_empty():
    assert learning._parse_candidates("not json at all") == []
    assert learning._parse_candidates('{"title":"x"}') == []   # object, not list
    assert learning._parse_candidates('[{"snippet":"a"}]') == []  # no title


def test_propose_gated_off_by_flag():
    had_attr = hasattr(config, "LEARNING_ENABLE")
    orig = getattr(config, "LEARNING_ENABLE", True) if had_attr else None
    config.LEARNING_ENABLE = False
    try:
        assert learning.propose_review_items(555, "/p", "wrote code", "", edited=True) == []
    finally:
        if had_attr:
            config.LEARNING_ENABLE = orig
        else:
            delattr(config, "LEARNING_ENABLE")


def test_propose_returns_parsed():
    orig = runner.run_blocking
    runner.run_blocking = _fake_run('[{"title":"T","snippet":"s","why_it_matters":"w"}]')
    try:
        out = learning.propose_review_items(555, "/p", "assistant text", "Edit file.py",
                                            edited=True)
        assert out == [{"title": "T", "snippet": "s", "why_it_matters": "w"}]
        assert runner.run_blocking.last_model == "haiku"
    finally:
        runner.run_blocking = orig


def test_teach_builds_mode_prompt_and_returns_text():
    orig = runner.run_blocking
    runner.run_blocking = _fake_run("Here is the explanation.")
    try:
        item = {"owner_id": 555, "project_path": "/p", "title": "closures",
                "code_snippet": "() => x", "why_it_matters": "captures x"}
        out = learning.teach(item, "explain")
        assert out == "Here is the explanation."
        assert "closures" in runner.run_blocking.last_prompt
        # grade mode threads the user answer into the prompt
        learning.teach(item, "grade", user_answer="it remembers variables")
        assert "it remembers variables" in runner.run_blocking.last_prompt
        assert learning.teach(item, "bogus") == ""    # unknown mode
    finally:
        runner.run_blocking = orig


def test_capture_streaming_creates_item_and_event():
    orig = learning.propose_review_items
    learning.propose_review_items = lambda *a, **k: [
        {"title": "closures", "snippet": "() => x", "why_it_matters": "captures x"}]
    try:
        sess = store.create_session(4242, "/capproj")
        store.start_turn(sess["id"], "turn1", "do the thing", [])
        store.append_event(sess["id"], "turn1", {"type": "text", "text": "I edited it."})
        store.append_event(sess["id"], "turn1", {"type": "tool", "name": "Edit",
                                                 "summary": "file.py"})
        learning.capture_after_turn(4242, sess, "turn1", tool_visibility=True)
        items = store.list_learning_items(4242, "/capproj", status="candidate")
        assert len(items) == 1 and items[0]["title"] == "closures"
        evs = [e for e in store.transcript(sess["id"])["events"]
               if e.get("type") == "review_candidate"]
        assert len(evs) == 1 and evs[0]["title"] == "closures"
    finally:
        learning.propose_review_items = orig


def test_capture_streaming_skips_when_no_edit_tool():
    called = {"n": 0}
    orig = learning.propose_review_items
    def _spy(*a, **k):
        called["n"] += 1
        return []
    learning.propose_review_items = _spy
    try:
        sess = store.create_session(4243, "/capproj2")
        store.start_turn(sess["id"], "turn2", "just a question", [])
        store.append_event(sess["id"], "turn2", {"type": "text", "text": "no edits"})
        learning.capture_after_turn(4243, sess, "turn2", tool_visibility=True)
        assert called["n"] == 0        # no Edit/Write tool → extractor never called
    finally:
        learning.propose_review_items = orig


if __name__ == "__main__":
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print(f"ok {name}")
    print("all passed")
