"""Per-prompt flow typing (bridge/flowtype.py).

Every prompt is classified in front of its turn — blocking, fail-open — so a
session's flow follows the work as it changes kind mid-session. Env is pinned
in conftest (config freezes settings at import) — the AUTO TYPE switch is
flipped through aifeatures' persisted setting, never os.environ. The model
call is always injected; nothing here spawns a real one-shot.
"""

import pytest

from bridge import aifeatures, flow, flowtype, store

store.init()


@pytest.fixture
def autotype_on():
    aifeatures.set_enabled("flowtype", True)
    yield
    aifeatures.set_enabled("flowtype", None)


def _events(sid):
    return store.transcript(sid)["events"]


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


def test_decide_names_the_current_kind_and_leans_to_it():
    seen = {}
    def run(p):
        seen["prompt"] = p
        return '{"stype": "fix"}'
    assert flowtype.decide("looks good, go on", current="fix", run=run) == "fix"
    assert '"fix"' in seen["prompt"] and "already doing" in seen["prompt"]


def test_decide_is_silent_while_flows_are_off():
    aifeatures.set_enabled("flows", False)
    try:
        boom = lambda p: (_ for _ in ()).throw(AssertionError("called the model"))
        assert flowtype.decide("build me a thing", run=boom) is None
    finally:
        aifeatures.set_enabled("flows", None)


# --- check: the blocking per-prompt pass -------------------------------------

def test_check_types_an_untyped_session_at_its_first_stage(autotype_on):
    s = store.create_session(555, "/p")
    flowtype.check(s, "the login page 500s", run=lambda p: '{"stype": "fix"}')
    row = store.get_session(s["id"])
    assert row["stype"] == "fix" and row["stage"] == "reproduce"
    # The caller composes this turn from the dict it holds — it must be fresh.
    assert s["stype"] == "fix" and s["stage"] == "reproduce"


def test_check_switches_a_typed_session_and_journals_it(autotype_on):
    s = store.create_session(555, "/p", stype="design", stage="implement")
    flowtype.check(s, "now the tunnel is down, bring it back",
                   run=lambda p: '{"stype": "infra"}')
    row = store.get_session(s["id"])
    assert row["stype"] == "infra" and row["stage"] == "map"
    ev = [e for e in _events(s["id"]) if e.get("type") == "retype"]
    assert ev and ev[-1]["by"] == "auto" and ev[-1]["from"] == "design" \
        and ev[-1]["to"] == "infra"


def test_check_same_kind_keeps_the_stage_and_writes_nothing(autotype_on):
    s = store.create_session(555, "/p", stype="fix", stage="rootcause")
    flowtype.check(s, "and the traceback?", run=lambda p: '{"stype": "fix"}')
    row = store.get_session(s["id"])
    assert row["stype"] == "fix" and row["stage"] == "rootcause"
    assert not [e for e in _events(s["id"]) if e.get("type") == "retype"]


def test_check_chat_verdict_never_untypes(autotype_on):
    s = store.create_session(555, "/p", stype="fix", stage="verify")
    flowtype.check(s, "thanks!", run=lambda p: '{"stype": "chat"}')
    row = store.get_session(s["id"])
    assert row["stype"] == "fix" and row["stage"] == "verify"


def test_check_a_manual_retype_mid_classify_wins(autotype_on):
    s = store.create_session(555, "/p")
    def race(p):        # the user typed the session while haiku was thinking
        flow.retype(s["id"], "build")
        return '{"stype": "fix"}'
    flowtype.check(s, "x", run=race)
    row = store.get_session(s["id"])
    assert row["stype"] == "build" and row["stage"] == "plan"


def test_check_skips_nudges_off_switch_and_no_session(autotype_on):
    boom = lambda p: (_ for _ in ()).throw(AssertionError("called the model"))
    s = store.create_session(555, "/p")
    flowtype.check(None, "x", run=boom)
    flowtype.check(s, flow.NUDGE_PREFIX + " your last reply…", run=boom)
    aifeatures.set_enabled("flowtype", None)
    flowtype.check(s, "x", run=boom)
    assert store.get_session(s["id"])["stype"] is None


def test_check_fails_open_when_the_model_breaks(autotype_on):
    s = store.create_session(555, "/p", stype="fix", stage="fix")
    flowtype.check(s, "x", run=lambda p: (_ for _ in ()).throw(RuntimeError("boom")))
    row = store.get_session(s["id"])
    assert row["stype"] == "fix" and row["stage"] == "fix"


# --- the switch, as the surfaces see it --------------------------------------

def test_catalog_carries_the_auto_flag(autotype_on):
    assert flow.catalog()["auto"] is True
    aifeatures.set_enabled("flowtype", None)
    assert flow.catalog()["auto"] is False
