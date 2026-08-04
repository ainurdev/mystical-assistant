"""bridge.relevance — the "start a new session?" guardrail: the should_check gate,
lenient JSON parsing, fail-open on every model-call failure, and the /local/run
hold (no job started) with its force bypass. The `claude` one-shot is stubbed.
Run: python -m pytest tests/test_relevance.py -v"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import aifeatures, config, relevance, runner, store  # noqa: E402
from bridge.dashboard import server as dash  # noqa: E402

store.init()

LONG = "x" * (config.RELEVANCE_MIN_CHARS + 1)


@pytest.fixture(autouse=True)
def _guard_on(monkeypatch):
    """The guardrail ships OFF (bridge/aifeatures.py); switch it on for the module
    so these tests exercise it. Tests that need it off set the flag themselves."""
    monkeypatch.setattr(config, "RELEVANCE_CHECK", True)


def _session(chat=901, project="/relproj", turns=1, title="Fix The Login Form"):
    s = store.create_session(chat, project, cwd="/tmp")
    store.rename(s["id"], title)
    for i in range(turns):
        store.start_turn(s["id"], f"{s['id']}-t{i}", f"prior task {i}", None)
    return store.get_session(s["id"])


# --- should_check truth table -----------------------------------------------

def test_should_check_long_prompt_on_session_with_history():
    assert relevance.should_check(_session(), LONG) is True


def test_should_check_multiline_prompt_qualifies_even_when_short():
    assert relevance.should_check(_session(), "add a\nsecond line") is True


def test_should_check_skips_short_single_line_prompt():
    assert relevance.should_check(_session(), "fix that") is False


def test_should_check_skips_session_without_turns():
    assert relevance.should_check(_session(turns=0), LONG) is False


def test_should_check_skips_when_forced():
    assert relevance.should_check(_session(), LONG, force=True) is False


def test_should_check_skips_without_a_session():
    assert relevance.should_check(None, LONG) is False


def test_should_check_skips_when_disabled(monkeypatch):
    monkeypatch.setattr(config, "RELEVANCE_CHECK", False)
    assert relevance.should_check(_session(), LONG) is False


def test_settings_toggle_overrides_the_env_default(monkeypatch):
    """The AI tab's NEW-SESSION GUARD switch wins over RELEVANCE_CHECK, both ways."""
    monkeypatch.setattr(config, "RELEVANCE_CHECK", True)
    try:
        aifeatures.set_enabled("relevance", False)
        assert relevance.should_check(_session(), LONG) is False
        monkeypatch.setattr(config, "RELEVANCE_CHECK", False)
        aifeatures.set_enabled("relevance", True)
        assert relevance.should_check(_session(), LONG) is True
    finally:
        aifeatures.set_enabled("relevance", None)   # back to "env decides"
    assert aifeatures.enabled("relevance") is False  # the patched env, again


# --- parsing + fail-open -----------------------------------------------------

def test_parses_plain_json():
    out = relevance.check_relevance(
        _session(), LONG,
        run=lambda _p: '{"related": false, "reason": "different feature",'
                       ' "suggested_title": "Add CSV Export"}')
    assert out == {"related": False, "reason": "different feature",
                   "suggested_title": "Add CSV Export"}


def test_parses_code_fenced_json_and_null_title():
    out = relevance.check_relevance(
        _session(), LONG,
        run=lambda _p: '```json\n{"related": false, "reason": "new work",'
                       ' "suggested_title": null}\n```')
    assert out["related"] is False and out["suggested_title"] is None


def test_bad_json_fails_open():
    assert relevance.check_relevance(_session(), LONG, run=lambda _p: "garbage") \
        == {"related": True, "reason": "", "suggested_title": None}


def test_missing_related_key_fails_open():
    out = relevance.check_relevance(_session(), LONG,
                                    run=lambda _p: '{"reason": "hmm"}')
    assert out["related"] is True


def test_empty_output_fails_open():
    assert relevance.check_relevance(_session(), LONG, run=lambda _p: "")["related"] is True


def test_raising_run_fails_open():
    def boom(_p):
        raise RuntimeError("subprocess died")
    assert relevance.check_relevance(_session(), LONG, run=boom)["related"] is True


def test_timeout_or_nonzero_exit_fails_open(monkeypatch):
    # run_blocking reports both as data: (text, None, None, is_error=True).
    monkeypatch.setattr(runner, "run_blocking",
                        lambda *a, **k: ("⏱️ Timed out after 0 min.", None, None, True))
    assert relevance.check_relevance(_session(), LONG)["related"] is True


# --- the /local/run hold ------------------------------------------------------

def _handler():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


def _no_jobs(monkeypatch):
    """start_streaming_job must not be reached for a held prompt."""
    started = []

    def fake(*a, **k):
        started.append(k)
        return type("J", (), {"id": "job1", "store_session_id": k.get("session_id")})()

    monkeypatch.setattr(runner, "start_streaming_job", fake)
    return started


def test_unrelated_prompt_is_held_and_starts_no_job(monkeypatch):
    s = _session(chat=902)
    started = _no_jobs(monkeypatch)
    monkeypatch.setattr(relevance, "check_relevance", lambda *a, **k: {
        "related": False, "reason": "different feature", "suggested_title": "Add CSV Export"})
    h, box = _handler()
    h._run(902, {"prompt": LONG, "session_id": s["id"]})
    assert box["obj"] == {"suggest_new": True, "reason": "different feature",
                          "suggested_title": "Add CSV Export"}
    assert started == []


def test_force_bypasses_the_check_and_starts_a_job(monkeypatch):
    s = _session(chat=903)
    started = _no_jobs(monkeypatch)
    monkeypatch.setattr(relevance, "check_relevance",
                        lambda *a, **k: (_ for _ in ()).throw(
                            AssertionError("force must not call the model")))
    h, box = _handler()
    h._run(903, {"prompt": LONG, "session_id": s["id"], "force": True})
    assert box["obj"]["job_id"] == "job1" and len(started) == 1


def test_short_prompt_skips_the_check_and_runs(monkeypatch):
    s = _session(chat=904)
    started = _no_jobs(monkeypatch)
    monkeypatch.setattr(relevance, "check_relevance",
                        lambda *a, **k: (_ for _ in ()).throw(
                            AssertionError("short prompts must not call the model")))
    h, box = _handler()
    h._run(904, {"prompt": "fix that", "session_id": s["id"]})
    assert box["obj"]["job_id"] == "job1" and len(started) == 1


def test_related_prompt_runs_normally(monkeypatch):
    s = _session(chat=905)
    started = _no_jobs(monkeypatch)
    monkeypatch.setattr(relevance, "check_relevance", lambda *a, **k: {
        "related": True, "reason": "", "suggested_title": None})
    h, box = _handler()
    h._run(905, {"prompt": LONG, "session_id": s["id"]})
    assert box["obj"]["job_id"] == "job1" and len(started) == 1


def test_session_shows_as_checking_while_the_check_runs(monkeypatch):
    """No job exists for the ~10s a check takes, so without the checking state the
    session drops out of every "active sessions" list until it's approved."""
    s = _session(chat=906)
    _no_jobs(monkeypatch)
    mid: dict = {}

    def fake_check(*a, **k):
        mid.update(runner._build_status(bridge_running=[], awaiting=[], jobs=[],
                                        external=[], native_snap={}))
        return {"related": True, "reason": "", "suggested_title": None}

    monkeypatch.setattr(relevance, "check_relevance", fake_check)
    h, _box = _handler()
    h._run(906, {"prompt": LONG, "session_id": s["id"]})
    assert mid[s["id"]]["state"] == "checking"
    assert s["id"] not in relevance.checking_ids()      # cleared once it's done
