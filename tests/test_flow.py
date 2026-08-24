"""Typed-session flows: store columns, flow definitions, the stage engine.

Env is pinned in conftest (config freezes settings at import) — nothing here
touches os.environ.
"""

from bridge import store

store.init()


def test_create_session_carries_stype_and_stage():
    s = store.create_session(555, "/p", stype="fix", stage="reproduce")
    assert s["stype"] == "fix" and s["stage"] == "reproduce"
    plain = store.create_session(555, "/p")
    assert plain["stype"] is None and plain["stage"] is None


def test_set_session_stage_roundtrip():
    s = store.create_session(555, "/p", stype="fix", stage="reproduce")
    store.set_session_stage(s["id"], "rootcause")
    assert store.get_session(s["id"])["stage"] == "rootcause"


def test_turn_stage_stamp_and_prompt():
    s = store.create_session(555, "/p", stype="fix", stage="fix")
    store.start_turn(s["id"], "flow-t1", "do the thing", [])
    store.set_turn_stage("flow-t1", "fix")
    assert store.turn_prompt("flow-t1") == "do the thing"
    assert store.transcript(s["id"])["turns"][0]["stage"] == "fix"


def test_settings_with_prefix():
    store.set_setting("flow:zap", "{}")
    store.set_setting("other-key", "x")
    assert store.settings_with_prefix("flow:") == {"flow:zap": "{}"}
    store.set_setting("flow:zap", None)
    assert store.settings_with_prefix("flow:") == {}
