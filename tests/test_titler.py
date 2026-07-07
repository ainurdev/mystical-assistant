"""Unit tests for bridge.titler — subject generation after a session's first
turn. runner.run_blocking (which spawns `claude`) is stubbed; everything else is
real store code.
Run: `python tests/test_titler.py`
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

from bridge import config, runner, store, titler  # noqa: E402

store.init()


@pytest.fixture(autouse=True)
def _restore_run_blocking():
    """Every test here swaps runner.run_blocking for a stub; restore the real one
    afterward so the stub can't leak into later test modules (test_native,
    test_running_status, … all import runner)."""
    orig = runner.run_blocking
    try:
        yield
    finally:
        runner.run_blocking = orig


def _session_with_first_turn(prompt="help me center a div in CSS",
                             reply="Use display:flex with margin:auto."):
    s = store.create_session(1, "/p")
    tid = s["id"] + "-t1"
    store.start_turn(s["id"], tid, prompt, None)
    if reply:
        store.append_event(s["id"], tid, {"type": "text", "text": reply})
    return store.get_session(s["id"]), tid


def _stub_run_blocking(result, *, is_error=False, calls=None):
    def fake(chat_id, prompt, *a, **k):
        if calls is not None:
            calls.append(prompt)
        return (result, "sid", 0.0, is_error)
    return fake


def test_generates_subject_from_first_turn():
    calls = []
    runner.run_blocking = _stub_run_blocking("Center a Div With CSS", calls=calls)
    sess, tid = _session_with_first_turn()
    titler.generate_after_turn(1, sess, tid)
    got = store.get_session(sess["id"])
    assert got["title"] == "Center a Div With CSS"
    assert got["title_source"] == "subject"
    assert len(calls) == 1                        # the model was consulted once
    assert "center a div" in calls[0]             # first prompt fed to the model
    assert "display:flex" in calls[0]             # assistant reply fed too


def test_prompt_is_tagged_internal():
    # The titler runs a headless one-shot that persists a JSONL; the internal tag
    # keeps native.scan from surfacing it as a phantom session in the list.
    from bridge import native
    calls = []
    runner.run_blocking = _stub_run_blocking("Some Title", calls=calls)
    sess, tid = _session_with_first_turn()
    titler.generate_after_turn(1, sess, tid)
    assert calls and calls[0].startswith(native.INTERNAL_ONESHOT_TAG)


def test_skips_when_manually_renamed():
    calls = []
    runner.run_blocking = _stub_run_blocking("Should Not Apply", calls=calls)
    sess, tid = _session_with_first_turn()
    store.rename(sess["id"], "My Chat")
    titler.generate_after_turn(1, store.get_session(sess["id"]), tid)
    got = store.get_session(sess["id"])
    assert got["title"] == "My Chat"
    assert got["title_source"] == "manual"
    assert calls == []                            # never consults the model


def test_skips_after_first_turn_no_backfill():
    calls = []
    runner.run_blocking = _stub_run_blocking("Nope", calls=calls)
    sess, tid = _session_with_first_turn()
    store.start_turn(sess["id"], sess["id"] + "-t2", "second prompt", None)  # 2nd turn
    titler.generate_after_turn(1, store.get_session(sess["id"]), tid)
    got = store.get_session(sess["id"])
    assert got["title_source"] == "auto"          # untouched — no retro-titling
    assert calls == []


def test_model_error_leaves_provisional_title():
    runner.run_blocking = _stub_run_blocking("whatever", is_error=True)
    sess, tid = _session_with_first_turn(prompt="fix the flaky test")
    titler.generate_after_turn(1, sess, tid)
    got = store.get_session(sess["id"])
    assert got["title"] == "fix the flaky test"   # provisional stays
    assert got["title_source"] == "auto"


def test_raising_model_is_swallowed():
    def boom(*a, **k):
        raise RuntimeError("subprocess died")
    runner.run_blocking = boom
    sess, tid = _session_with_first_turn(prompt="explain WAL mode")
    titler.generate_after_turn(1, sess, tid)      # must not raise
    assert store.get_session(sess["id"])["title_source"] == "auto"


def test_empty_subject_leaves_provisional_title():
    runner.run_blocking = _stub_run_blocking("   ")   # blank after cleaning
    sess, tid = _session_with_first_turn(prompt="set up CI")
    titler.generate_after_turn(1, sess, tid)
    assert store.get_session(sess["id"])["title"] == "set up CI"


def test_disabled_flag_short_circuits():
    calls = []
    runner.run_blocking = _stub_run_blocking("X", calls=calls)
    sess, tid = _session_with_first_turn()
    old = config.TITLE_ENABLE
    config.TITLE_ENABLE = False
    try:
        titler.generate_after_turn(1, sess, tid)
    finally:
        config.TITLE_ENABLE = old
    assert store.get_session(sess["id"])["title_source"] == "auto"
    assert calls == []


def test_clean_strips_quotes_punctuation_and_fences():
    assert titler._clean('"Center a Div".') == "Center a Div"
    assert titler._clean("```\nFix Login Bug\n```") == "Fix Login Bug"
    assert titler._clean("  Multiple   spaces  ") == "Multiple spaces"
    assert titler._clean("Trailing dash —") == "Trailing dash"
    assert titler._clean("") == ""
    assert titler._clean("x" * 80) == "x" * 60


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items())
           if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL {fn.__name__}: {type(e).__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    raise SystemExit(1 if failed else 0)
