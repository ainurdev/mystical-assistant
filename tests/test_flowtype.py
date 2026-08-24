"""Auto-typing a fresh session off its first message (bridge/flowtype.py).

Env is pinned in conftest (config freezes settings at import) — the AUTO TYPE
switch is flipped through aifeatures' persisted setting, never os.environ.
The model call is always injected; nothing here spawns a real one-shot.
"""

import pytest

from bridge import aifeatures, flow, flowtype, store

store.init()


@pytest.fixture
def autotype_on():
    aifeatures.set_enabled("flowtype", True)
    yield
    aifeatures.set_enabled("flowtype", None)


# --- decide: the verdict ------------------------------------------------------

def test_decide_reads_plain_fenced_and_noisy_json():
    assert flowtype.decide("x", run=lambda p: '{"stype": "fix"}') == "fix"
    assert flowtype.decide(
        "x", run=lambda p: 'Sure!\n```json\n{"stype": "BUILD"}\n```') == "build"


def test_decide_fails_open_to_untyped():
    for reply in ('{"stype": "chat"}',      # explicit chat
                  '{"stype": "poem"}',      # not in the catalog
                  "no json here", "", '{"stype": 3}'):
        assert flowtype.decide("x", run=lambda p, r=reply: r) is None


def test_decide_shows_the_catalog_and_the_message():
    seen = {}
    def run(p):
        seen["prompt"] = p
        return '{"stype": "probe"}'
    assert flowtype.decide("why is the build slow?", run=run) == "probe"
    assert "- build:" in seen["prompt"] and "- fix:" in seen["prompt"]
    assert "why is the build slow?" in seen["prompt"]


def test_decide_is_silent_while_flows_are_off():
    aifeatures.set_enabled("flows", False)
    try:
        boom = lambda p: (_ for _ in ()).throw(AssertionError("called the model"))
        assert flowtype.decide("build me a thing", run=boom) is None
    finally:
        aifeatures.set_enabled("flows", None)


# --- _classify: the write ----------------------------------------------------

def test_classify_types_the_session_at_its_first_stage():
    s = store.create_session(555, "/p")
    flowtype._classify(s, "the login page 500s", run=lambda p: '{"stype": "fix"}')
    row = store.get_session(s["id"])
    assert row["stype"] == "fix" and row["stage"] == "reproduce"


def test_classify_first_write_wins():
    s = store.create_session(555, "/p")
    def race(p):        # the user typed the session while haiku was thinking
        store.set_session_stype(s["id"], "build")
        store.set_session_stage(s["id"], "plan")
        return '{"stype": "fix"}'
    flowtype._classify(s, "x", run=race)
    row = store.get_session(s["id"])
    assert row["stype"] == "build" and row["stage"] == "plan"


def test_classify_chat_verdict_changes_nothing():
    s = store.create_session(555, "/p")
    flowtype._classify(s, "hey, how are you", run=lambda p: '{"stype": "chat"}')
    row = store.get_session(s["id"])
    assert row["stype"] is None and row["stage"] is None


# --- kick: the gate -----------------------------------------------------------

def _capture_threads(monkeypatch):
    spawned = []
    class _T:
        def __init__(self, **kw):
            spawned.append(kw)
        def start(self):
            pass
    monkeypatch.setattr(flowtype.threading, "Thread", _T)
    return spawned


def test_kick_needs_the_switch_a_session_and_no_type(monkeypatch, autotype_on):
    spawned = _capture_threads(monkeypatch)
    typed = store.create_session(555, "/p", stype="fix", stage="reproduce")
    flowtype.kick(None, "x")
    flowtype.kick(typed, "x")
    assert spawned == []
    fresh = store.create_session(555, "/p")
    try:
        flowtype.kick(fresh, "x")
        flowtype.kick(fresh, "x")           # in flight: no second verdict
        assert len(spawned) == 1
    finally:
        flowtype._inflight.discard(fresh["id"])


def test_kick_is_a_noop_while_off(monkeypatch):
    spawned = _capture_threads(monkeypatch)
    flowtype.kick(store.create_session(555, "/p"), "x")
    assert spawned == []


# --- the switch, as the surfaces see it --------------------------------------

def test_catalog_carries_the_auto_flag(autotype_on):
    assert flow.catalog()["auto"] is True
    aifeatures.set_enabled("flowtype", None)
    assert flow.catalog()["auto"] is False
