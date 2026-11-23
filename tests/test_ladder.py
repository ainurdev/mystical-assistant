"""Unit tests for the usage-limit fallback ladder (bridge/ladder.py).

The ladder decides what happens when a turn dies on a usage limit: hand the work
to another Claude account, or leave it parked. Parking is limits.py's job and
already works — the contract here is that the ladder never makes things worse
than parking.
"""

import os
import sys
import tempfile
import time

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
    store.start_turn(s["id"], "t1", "hello", [], runtime="acp:gemini")
    rows = store.transcript(s["id"])["turns"]
    assert rows[-1]["runtime"] == "acp:gemini"


def test_turn_runtime_defaults_to_null_for_plain_claude():
    s = _session()
    store.start_turn(s["id"], "t2", "hello", [])
    assert store.transcript(s["id"])["turns"][-1]["runtime"] is None


def test_turn_records_the_commit_it_started_from():
    """A checkpoint needs its commit to say what the tree has drifted since."""
    s = _session()
    store.start_turn(s["id"], "t3", "hello", [], sha="a" * 40)
    store.start_turn(s["id"], "t4", "outside a repo", [], sha="")
    rows = store.transcript(s["id"])["turns"]
    assert rows[-2]["sha"] == "a" * 40
    assert rows[-1]["sha"] is None   # "" is not a commit — store it as absent


# --- rungs(): what is actually available right now ---------------------------

def _stub(accounts_pick=None, headroom=None):
    """Patch what rungs() consults: accounts_pick is a callable taking
    (exclude, strategy, auto_switch) so tests can model 'the next best account'."""
    saved = (ladder.accounts.pick, ladder.accounts.headroom)
    given = accounts_pick or (lambda exclude=(), strategy="best", auto_switch=False: None)
    ladder.accounts.pick = lambda exclude=(), strategy="best", auto_switch=False, model=None: given(
        exclude=exclude, strategy=strategy, auto_switch=auto_switch)
    ladder.accounts.headroom = headroom or (lambda slot: None)

    def restore():
        (ladder.accounts.pick, ladder.accounts.headroom) = saved
    return restore


def test_no_other_account_means_no_rungs():
    restore = _stub()
    try:
        assert ladder.rungs(_session()) == []
    finally:
        restore()


def test_a_healthy_account_is_the_first_rung():
    restore = _stub(accounts_pick=lambda exclude=(), strategy="best", auto_switch=False: 2,
                    headroom=lambda slot: 78)
    try:
        got = ladder.rungs(_session())
        assert [r["kind"] for r in got] == ["account"]
        assert got[0]["slot"] == 2
        assert "78" in got[0]["label"]
    finally:
        restore()


def test_the_dead_account_is_excluded_from_the_rungs():
    seen = {}

    def pick(exclude=(), strategy="best", auto_switch=False):
        seen["exclude"] = tuple(exclude)
        return None

    restore = _stub(accounts_pick=pick)
    try:
        ladder.rungs(_session(), dead_slot=2)
        assert 2 in seen["exclude"]
    finally:
        restore()


# --- resolve_agent(): the same rungs, picked by hand -------------------------

def _stub_agents(rows=()):
    saved = ladder.accounts.list_accounts
    ladder.accounts.list_accounts = lambda: list(rows)

    def restore():
        ladder.accounts.list_accounts = saved
    return restore


A1 = {"slot": 1, "email": "a@b.c", "alias": None, "disabled": False, "default": True}
A2_OFF = {"slot": 2, "email": "d@e.f", "alias": None, "disabled": True, "default": False}


def test_no_pick_means_the_ambient_login():
    assert ladder.resolve_agent("") == (None, None)


def test_a_claude_slot_resolves_to_that_account():
    restore = _stub_agents(rows=[A1, {**A2_OFF, "disabled": False}])
    try:
        assert ladder.resolve_agent("claude:2") == (2, None)
    finally:
        restore()


def test_picks_that_are_not_live_are_refused():
    """A disabled/absent account or an unknown agent must not silently fall back
    to whoever is ambient — the turn would run as the wrong identity."""
    restore = _stub_agents(rows=[A1, A2_OFF])
    try:
        for spec in ("claude:2", "claude:9", "claude:x", "wat:1"):
            try:
                ladder.resolve_agent(spec)
            except ValueError:
                continue
            raise AssertionError(f"{spec} should not have resolved")
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
    restore = _stub(accounts_pick=lambda exclude=(), strategy="best", auto_switch=False: 2,
                    headroom=lambda slot: 90)
    run, notify = _Rec(), _Rec()
    try:
        assert ladder.escalate(_session("wait"), CHAT, run=run,
                               notify=notify) is None
        assert run.calls == [] and notify.calls == []
    finally:
        restore()


def test_auto_policy_takes_the_best_rung_immediately():
    restore = _stub(accounts_pick=lambda exclude=(), strategy="best", auto_switch=False: 3,
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
    """A silent switch is untrackable: the bell always has it, and Telegram once
    its route is on (Settings ▸ NOTIFY ▸ Resumed or retrying on its own)."""
    from bridge import notices
    restore = _stub(accounts_pick=lambda exclude=(), strategy="best", auto_switch=False: 3,
                    headroom=lambda slot: 64)
    run, notify = _Rec(), _Rec()
    try:
        s = _session("auto")
        ladder.escalate(s, CHAT, run=run, notify=notify)
        row = notices.feed()[0]
        assert (row["kind"], row["subject"], row["body"]) == (
            "resumed", s["id"], "Continuing on Account 3 (64% left).")
        assert notify.calls == []
        notices.set_prefs({"events": {"resumed": {"tg": "always"}}})
        ladder.escalate(_session("auto"), CHAT, run=run, notify=notify)
        assert len(notify.calls) == 1
    finally:
        store.set_setting("notify_prefs", None)
        restore()


def test_ask_policy_offers_the_rungs_without_taking_one():
    restore = _stub(accounts_pick=lambda exclude=(), strategy="best", auto_switch=False: 2,
                    headroom=lambda slot: 55)
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


# --- Auto-switch never lands on an account you kept out of it -----------------

def _logins(used, kept_out=()):
    """The real pick() over accounts 1..n: `used` is each slot's percent of its
    window spent; the slots in kept_out have their Auto-switch switch off."""
    saved = (ladder.accounts.list_accounts, ladder.accounts.usage_for)
    ladder.accounts.list_accounts = lambda: [
        {"slot": s, "disabled": False, "auto_switch": s not in kept_out} for s in sorted(used)]
    ladder.accounts.usage_for = lambda slot: {"available": True, "five_hour": {"percent": used[slot]}}

    def restore():
        (ladder.accounts.list_accounts, ladder.accounts.usage_for) = saved
    return restore


def test_auto_switch_moves_only_onto_accounts_still_in_it():
    """Account 2 has the most room but is kept out of Auto-switch: the work
    moves to account 3, as silently as ever."""
    restore = _logins({1: 100, 2: 5, 3: 40}, kept_out=(2,))
    run, notify = _Rec(), _Rec()
    try:
        taken = ladder.escalate(_session("auto"), CHAT, dead_slot=1, run=run, notify=notify)
        assert taken["slot"] == 3 and run.calls[0][1]["account_slot"] == 3
    finally:
        restore()


def test_auto_switch_asks_you_when_only_accounts_kept_out_of_it_have_room():
    """No silent move then: the Ask card, on Telegram, the chat and the bell,
    each saying why. Unanswered, the park stands and resumes at the reset."""
    from bridge import limits, notices
    why = "No account in Auto-switch has room, and Account 2 (95% left) is kept out of it."
    restore = _logins({1: 100, 2: 5, 3: 100}, kept_out=(2,))
    s = _session("auto")
    saved, got = limits.offer, []
    limits.offer = lambda sid, rungs, why=None: got.append((sid, rungs, why)) or True
    run, notify = _Rec(), _Rec()
    try:
        assert ladder.escalate(s, CHAT, dead_slot=1, run=run, notify=notify) is None
        assert run.calls == []
        assert got == [(s["id"], [{"slot": 2, "label": "Account 2 (95% left)"}], why)]
        assert why in notify.calls[0][0][1]
        bell = [r for r in notices.feed() if r["kind"] == "limit_choice" and r["subject"] == s["id"]]
        assert why in bell[0]["body"]
    finally:
        limits.offer = saved
        restore()


def test_ask_still_offers_an_account_kept_out_of_auto_switch_without_a_why():
    """The switch is about moves made without asking; Ask always asks."""
    from bridge import limits
    restore = _logins({1: 100, 2: 5}, kept_out=(2,))
    saved, got = limits.offer, []
    limits.offer = lambda sid, rungs, why=None: got.append((rungs, why)) or True
    try:
        ladder.escalate(_session("ask"), CHAT, dead_slot=1, run=_Rec(), notify=_Rec())
        assert got == [([{"slot": 2, "label": "Account 2 (95% left)"}], None)]
    finally:
        limits.offer = saved
        restore()


def test_take_declines_a_rung_kind_it_no_longer_knows():
    """A stale card from before the free rung was removed must not crash --
    it should decline like any other handover that can't be started."""
    assert ladder.take(_session(), CHAT,
                       {"kind": "free", "provider": "gemini", "label": "x"}) is None


def test_ask_policy_puts_its_offer_on_the_park():
    """The chat's YOUR CALL card reads the offer off the parked status."""
    from bridge import limits
    restore = _stub(accounts_pick=lambda exclude=(), strategy="best", auto_switch=False: 2,
                    headroom=lambda slot: 55)
    s = _session("ask")
    saved, got = limits.offer, []
    limits.offer = lambda sid, rungs, why=None: got.append((sid, rungs)) or True
    try:
        ladder.escalate(s, CHAT, run=_Rec(), notify=_Rec())
        assert got == [(s["id"], [{"slot": 2, "label": "Account 2 (55% left)"}])]
    finally:
        limits.offer = saved
        restore()


def test_the_nudges_say_what_the_dashboard_reads():
    """The chat draws these turns as a receipt, not as your words, by matching
    their wording (dashboard lib/limit.ts limitNudge). Reword one, reword both."""
    from bridge import limits
    for nudge in (limits.NUDGE, ladder.ACCOUNT_NUDGE, ladder.MODEL_NUDGE):
        assert nudge.startswith("⏮ ") and "usage limit was reached" in nudge
    assert "resumed on another account" in ladder.ACCOUNT_NUDGE
    assert "resumed on another model" in ladder.MODEL_NUDGE
    assert "resumed on another" not in limits.NUDGE


# --- a model's own limit: every login can be out of it -------------------------

FABLE_OUT = ("You've hit your Fable limit · resets Nov 27 at 6am (Asia/Yerevan). Switch to "
             "another model, or manage usage credits at https://claude.ai/settings/usage"
             "?from=cc_cli_limit_message, to continue.")


def _meter(weekly, fable):
    """A login's meter as get_usage reads it (shape seen live 2026-11-23): the
    weekly window every model shares, and Fable's own weekly cap."""
    return {"available": True, "five_hour": None,
            "seven_day": {"percent": weekly, "resets_at": None, "severity": "normal"},
            "limits": [{"kind": "weekly_all", "group": "weekly", "percent": weekly, "scope": None},
                       {"kind": "weekly_scoped", "group": "weekly", "percent": fable,
                        "scope": {"model": {"id": None, "display_name": "Fable"}, "surface": None}}]}


def _fable_deaths(meters, deaths):
    """Turns on Fable die on its limit, up to `deaths` times, each on the login
    the previous handover went to, through the runner's real limit path (park,
    then the ladder). Returns the handovers as (account_slot, model) and the
    session as it ends up."""
    from bridge import config, limits, runner
    saved = (ladder.accounts.list_accounts, ladder.accounts.usage_for,
             runner.start_streaming_job, config.AUTO_RESUME)
    ladder.accounts.list_accounts = lambda: [
        {"slot": s, "disabled": False, "auto_switch": True} for s in sorted(meters)]
    ladder.accounts.usage_for = lambda slot: meters[slot]
    run = _Rec()
    runner.start_streaming_job = run
    config.AUTO_RESUME = True
    s = _session("auto")
    store.set_claude_session_id(s["id"], "c-" + s["id"])
    slot, model = 1, "claude-fable-5-2"
    try:
        for _ in range(deaths):
            job = runner.Job("j-" + os.urandom(4).hex(), CHAT, s["id"])
            job.status, job.result, job.account_slot = "error", FABLE_OUT, slot
            job.rate_limit = {"status": "rejected", "resetsAt": time.time() + 3 * 86400}
            if not runner._maybe_auto_resume(job, "/p", model, None) or not run.calls:
                break
            slot, model = run.calls[-1][1]["account_slot"], run.calls[-1][1]["model"]
            if model != "claude-fable-5-2":
                break                       # off Fable: this turn would run
        return [(kw["account_slot"], kw["model"]) for _a, kw in run.calls], store.get_session(s["id"])
    finally:
        (ladder.accounts.list_accounts, ladder.accounts.usage_for,
         runner.start_streaming_job, config.AUTO_RESUME) = saved
        with limits._lock:
            if limits._timer is not None:
                limits._timer.cancel()
            limits._timer = limits._fire_at = None
            limits._pending.clear()
        limits._last_tries.clear()
        ladder.accounts._model_out.clear()


def test_auto_switch_drops_to_opus_when_every_login_is_out_of_fable():
    """Both logins had room overall and none left for Fable: Auto-switch handed
    the work back and forth between them every few seconds, Fable each time
    (2026-11-23: four sessions, ~50 dead turns each). It goes on Opus instead,
    once, and the session stays on Opus."""
    went, s = _fable_deaths({1: _meter(90, 100), 2: _meter(52, 100)}, deaths=6)
    assert went[0][1] == "opus", f"handed over on Fable again: {went}"
    assert len(went) == 1
    assert s["model"] == "opus", "its next turn would die on Fable all over again"


def test_a_login_with_fable_left_still_takes_the_work_on_fable():
    """Dropping a model is the last resort: a login in Auto-switch with room
    for it keeps the work on the model it was on."""
    went, s = _fable_deaths({1: _meter(90, 100), 2: _meter(30, 100), 3: _meter(70, 40)}, deaths=1)
    assert went == [(3, "claude-fable-5-2")]
    assert s["model"] != "opus"


def test_a_login_that_just_refused_fable_gets_no_more_fable_whatever_its_meter_says():
    """A meter's model caps refresh only on a full read (every 5 minutes), and a
    meter that won't read has none: either way both logins can look like they
    have Fable left after both refused it, and the bounce came back. The refusal
    is first-hand: at most one wasted hop, then Opus."""
    for meters in ({1: _meter(60, 97), 2: _meter(50, 97)},             # read before the caps ran out
                   {1: {"available": False}, 2: {"available": False}}):  # won't read
        went, _s = _fable_deaths(meters, deaths=6)
        assert [m for _slot, m in went] == ["claude-fable-5-2", "opus"], went


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
