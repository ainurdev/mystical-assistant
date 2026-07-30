"""Unit tests for the usage-limit fallback ladder (bridge/ladder.py).

The ladder decides what happens when a turn dies on a usage limit: hand the work
to another Claude account, hand it to a free agent, or leave it parked. Parking
is limits.py's job and already works — the contract here is that the ladder never
makes things worse than parking.
"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ["BASE_PATH"] = tempfile.mkdtemp()
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ["ALLOWED_CHAT_IDS"] = "555"
os.environ["BRIDGE_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")
os.environ["ACCOUNTS_DIR"] = os.path.join(tempfile.mkdtemp(), "accounts")

from bridge import ladder, store  # noqa: E402

store.init()
CHAT = 555


def _session(policy=None):
    s = store.create_session(CHAT, "/p")
    if policy:
        store.set_fallback_policy(s["id"], policy)
    return store.get_session(s["id"])


# --- schema + policy accessor ------------------------------------------------

def test_a_new_session_has_no_policy_of_its_own():
    assert _session()["fallback_policy"] is None


def test_policy_round_trips():
    s = _session()
    store.set_fallback_policy(s["id"], "auto")
    assert store.get_session(s["id"])["fallback_policy"] == "auto"


def test_policy_for_falls_back_to_the_configured_default():
    s = _session()
    assert ladder.policy_for(s) == ladder.DEFAULT_POLICY


def test_policy_for_prefers_the_sessions_own_setting():
    assert ladder.policy_for(_session("auto")) == "auto"


def test_unknown_stored_policy_is_treated_as_the_default():
    """A hand-edited DB must not disable the safety net silently."""
    s = _session()
    store.set_fallback_policy(s["id"], "nonsense")
    assert ladder.policy_for(store.get_session(s["id"])) == ladder.DEFAULT_POLICY


def test_turn_runtime_round_trips():
    """Which runtime produced a turn has to be visible after the fact."""
    s = _session()
    store.start_turn(s["id"], "t1", "hello", [], runtime="opencode:gemini")
    rows = store.transcript(s["id"])["turns"]
    assert rows[-1]["runtime"] == "opencode:gemini"


def test_turn_runtime_defaults_to_null_for_plain_claude():
    s = _session()
    store.start_turn(s["id"], "t2", "hello", [])
    assert store.transcript(s["id"])["turns"][-1]["runtime"] is None


# --- rungs(): what is actually available right now ---------------------------

def _stub(accounts_pick=None, headroom=None, free=()):
    """Patch the two things rungs() consults. accounts_pick is a callable taking
    (exclude, strategy) so tests can model 'the next best account'."""
    saved = (ladder.accounts.pick, ladder.accounts.headroom, ladder._free_providers)
    ladder.accounts.pick = accounts_pick or (lambda exclude=(), strategy="best": None)
    ladder.accounts.headroom = headroom or (lambda slot: None)
    ladder._free_providers = lambda: list(free)

    def restore():
        (ladder.accounts.pick, ladder.accounts.headroom,
         ladder._free_providers) = saved
    return restore


FREE_GEMINI = {"provider": "gemini", "model": "gemini-3-flash",
               "label": "Gemini Flash"}


def test_no_other_account_and_no_free_agent_means_no_rungs():
    restore = _stub()
    try:
        assert ladder.rungs(_session()) == []
    finally:
        restore()


def test_a_healthy_account_is_the_first_rung():
    restore = _stub(accounts_pick=lambda exclude=(), strategy="best": 2,
                    headroom=lambda slot: 78, free=[FREE_GEMINI])
    try:
        got = ladder.rungs(_session())
        assert [r["kind"] for r in got] == ["account", "free"]
        assert got[0]["slot"] == 2
        assert "78" in got[0]["label"]
    finally:
        restore()


def test_the_dead_account_is_excluded_from_the_rungs():
    seen = {}

    def pick(exclude=(), strategy="best"):
        seen["exclude"] = tuple(exclude)
        return None

    restore = _stub(accounts_pick=pick)
    try:
        ladder.rungs(_session(), dead_slot=2)
        assert 2 in seen["exclude"]
    finally:
        restore()


def test_a_free_agent_alone_is_still_a_rung():
    restore = _stub(free=[FREE_GEMINI])
    try:
        got = ladder.rungs(_session())
        assert [r["kind"] for r in got] == ["free"]
        assert got[0]["provider"] == "gemini"
    finally:
        restore()


# --- escalate(): acting on the policy ----------------------------------------

class _Rec:
    def __init__(self, ret="JOB"):
        self.calls = []
        self._ret = ret

    def __call__(self, *a, **kw):
        self.calls.append((a, kw))
        return self._ret


def test_wait_policy_takes_no_rung_even_when_one_exists():
    """'wait' must be byte-for-byte today's behaviour: park and do nothing."""
    restore = _stub(accounts_pick=lambda exclude=(), strategy="best": 2,
                    headroom=lambda slot: 90)
    run, notify = _Rec(), _Rec()
    try:
        assert ladder.escalate(_session("wait"), CHAT, run=run,
                               notify=notify) is None
        assert run.calls == [] and notify.calls == []
    finally:
        restore()


def test_auto_policy_takes_the_best_rung_immediately():
    restore = _stub(accounts_pick=lambda exclude=(), strategy="best": 3,
                    headroom=lambda slot: 64)
    run, notify = _Rec(), _Rec()
    try:
        taken = ladder.escalate(_session("auto"), CHAT, run=run, notify=notify)
        assert taken["kind"] == "account" and taken["slot"] == 3
        assert len(run.calls) == 1
        assert run.calls[0][1]["account_slot"] == 3
    finally:
        restore()


def test_auto_policy_reports_which_rung_it_landed_on():
    restore = _stub(accounts_pick=lambda exclude=(), strategy="best": 3,
                    headroom=lambda slot: 64)
    run, notify = _Rec(), _Rec()
    try:
        ladder.escalate(_session("auto"), CHAT, run=run, notify=notify)
        assert len(notify.calls) == 1, "a silent switch is untrackable"
    finally:
        restore()


def test_ask_policy_offers_the_rungs_without_taking_one():
    restore = _stub(accounts_pick=lambda exclude=(), strategy="best": 2,
                    headroom=lambda slot: 55, free=[FREE_GEMINI])
    run, notify = _Rec(), _Rec()
    try:
        assert ladder.escalate(_session("ask"), CHAT, run=run,
                               notify=notify) is None
        assert run.calls == [], "ask must not start work on its own"
        assert len(notify.calls) == 1
    finally:
        restore()


def test_no_rung_available_asks_nothing_and_leaves_the_park_alone():
    restore = _stub()
    run, notify = _Rec(), _Rec()
    try:
        for policy in ("ask", "auto"):
            assert ladder.escalate(_session(policy), CHAT, run=run,
                                   notify=notify) is None
        assert run.calls == [] and notify.calls == []
    finally:
        restore()


def test_auto_falls_through_to_the_free_agent_when_no_account_is_left():
    restore = _stub(free=[FREE_GEMINI])
    run, notify = _Rec(), _Rec()
    try:
        taken = ladder.escalate(_session("auto"), CHAT, run=run, notify=notify)
        assert taken["kind"] == "free" and taken["provider"] == "gemini"
    finally:
        restore()


if __name__ == "__main__":
    import traceback
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok   {name}")
            except Exception:  # noqa: BLE001
                fails += 1
                print(f"FAIL {name}")
                traceback.print_exc()
    print(f"\n{fails} failure(s)")
    sys.exit(1 if fails else 0)
