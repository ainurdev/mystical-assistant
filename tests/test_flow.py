"""Typed-session flows: store columns, flow definitions, the stage engine.

Env is pinned in conftest (config freezes settings at import) — nothing here
touches os.environ.
"""

import json

from bridge import flow, store

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


# --- definitions: built-ins, settings overlay, validation --------------------

def test_builtins_load_and_validate():
    flows = flow.load_flows()
    assert set(flows) >= {"build", "fix", "probe", "ops", "review", "design"}
    for f in flows.values():
        assert flow.validate_flow(f) == []


def test_settings_overlay_wins_and_delete_restores():
    fix = dict(flow.load_flows()["fix"])
    fix["blurb"] = "custom"
    assert flow.save_custom("fix", fix) == []
    assert flow.load_flows()["fix"]["blurb"] == "custom"
    assert flow.get_flow("fix")["blurb"] == "custom"
    assert flow.delete_custom("fix") is True
    assert flow.load_flows()["fix"]["blurb"] != "custom"


def test_new_custom_type_and_disable():
    zap = {"stype": "zap", "label": "ZAP", "blurb": "b", "form": [],
           "stages": [{"id": "go", "label": "GO", "gate": False,
                       "instructions": "x", "card_fields": []}]}
    assert flow.save_custom("zap", zap) == []
    assert "zap" in {f["stype"] for f in flow.catalog()["flows"]}
    zap["disabled"] = True
    flow.save_custom("zap", zap)
    assert "zap" not in {f["stype"] for f in flow.catalog()["flows"]}
    assert flow.get_flow("zap") is not None      # in-flight sessions keep it
    flow.delete_custom("zap")


def test_validate_flow_errors():
    bad = {"stype": "x!", "label": "", "form": "nope",
           "stages": [{"id": "a", "label": "A", "gate": "yes",
                       "instructions": "", "card_fields": []},
                      {"id": "a", "label": "B", "gate": False,
                       "instructions": "x", "card_fields": []}]}
    joined = " ".join(flow.validate_flow(bad))
    assert "stype" in joined and "form" in joined
    assert "duplicate" in joined and "gate" in joined
    assert flow.validate_flow("not a dict")


def test_catalog_shape_has_no_instructions():
    cat = flow.catalog()
    assert isinstance(cat["enabled"], bool)
    f = next(x for x in cat["flows"] if x["stype"] == "fix")
    assert f["form"][0]["key"] == "what"
    assert [s["id"] for s in f["stages"]][0] == "reproduce"
    assert "instructions" not in f["stages"][0]


def test_compose_first_prompt():
    f = flow.get_flow("fix")
    p = flow.compose_first_prompt(f, {"what": "boom", "repro": "run x"})
    assert p.startswith("[FIX]")
    assert "WHAT BROKE: boom" in p and "REPRO STEPS: run x" in p
    assert "WHERE SEEN" not in p        # empty fields are omitted


# --- engine: contract composition, card parsing, transitions -----------------

CARD = """Did the work.

```hud-card
{"stage": "fix", "summary": "patched", "fields": {"changed": ["a.py"]},
 "advance": true, "actions": [{"label": "TEST", "send": "run tests"}]}
```"""


def test_parse_card_last_block_wins():
    two = CARD + '\n\n```hud-card\n{"stage": "verify", "summary": "s", "fields": {}}\n```'
    assert flow.parse_card(two)["stage"] == "verify"
    assert flow.parse_card("no card here") is None
    assert flow.parse_card("```hud-card\nnot json\n```") is None
    assert flow.parse_card(None) is None


def test_validate_card_required_fields():
    f = flow.get_flow("fix")
    assert flow.validate_card(f, "fix", flow.parse_card(CARD)) == []
    assert flow.validate_card(f, "verify", flow.parse_card(CARD))     # wrong stage
    bare = {"stage": "fix", "summary": "s", "fields": {}}
    assert any("changed" in e for e in flow.validate_card(f, "fix", bare))


def test_compose_section_has_only_current_stage():
    f = flow.get_flow("fix")
    s = flow.compose_section(f, "rootcause")
    assert "ROOT-CAUSE" in s and "hud-card" in s
    assert "Trace the failure" in s                       # this stage's instructions
    assert "Apply the approved fix" not in s              # not the other stages'
    assert "approve" in s.lower()                         # the gate rule
    assert len(flow.compose_section(f, "done")) < 200     # a light note only


def test_next_stage_and_permission():
    f = flow.get_flow("fix")
    assert flow.next_stage(f, "reproduce") == "rootcause"
    assert flow.next_stage(f, "verify") == "done"
    assert flow.next_stage(f, "done") is None
    assert flow.stage_permission(f, "fix") == "acceptEdits"
    assert flow.stage_permission(f, "reproduce") is None


def test_apply_stage_writes_and_journals():
    s = store.create_session(555, "/p", stype="fix", stage="reproduce")
    store.start_turn(s["id"], "flow-ts1", "x", [])
    flow.apply_stage(s["id"], "rootcause", "user", turn_id="flow-ts1")
    assert store.get_session(s["id"])["stage"] == "rootcause"
    st = [e for e in store.transcript(s["id"])["events"] if e["type"] == "stage"]
    assert st, "a stage transition must be journaled"
    assert st[-1]["from"] == "reproduce" and st[-1]["to"] == "rootcause"
    assert st[-1]["by"] == "user"


def test_resolve_stage_action():
    f = flow.get_flow("fix")
    assert flow.resolve_stage_action(f, "reproduce", "advance", None) == "rootcause"
    assert flow.resolve_stage_action(f, "rootcause", "back", None) == "reproduce"
    assert flow.resolve_stage_action(f, "reproduce", "set", "verify") == "verify"
    assert flow.resolve_stage_action(f, "verify", "advance", None) == "done"
    assert flow.resolve_stage_action(f, "done", "advance", None) is None
    assert flow.resolve_stage_action(f, "done", "back", None) == "verify"
    assert flow.resolve_stage_action(f, "reproduce", "back", None) is None
    assert flow.resolve_stage_action(f, "reproduce", "set", "nope") is None
    assert flow.resolve_stage_action(f, "reproduce", "sideways", None) is None


# --- what the runner calls: per-turn injection and post-turn settlement ------

class _StubJob:
    """Duck-typed stand-in for runner.Job — after_turn reads only these."""

    def __init__(self, sid, turn_id, result, status="done", chat_id=555):
        self.store_session_id = sid
        self.id = turn_id
        self.result = result
        self.texts = [result] if result else []
        self.status = status
        self.interrupted = False
        self.chat_id = chat_id
        self.added = []

    def add(self, ev):
        self.added.append(ev)


def _typed(stage="fix", turn="flow-j1"):
    s = store.create_session(555, "/p", stype="fix", stage=stage)
    store.start_turn(s["id"], turn, "work", [])
    return s


def test_section_and_permission_for_session():
    s = store.create_session(555, "/p", stype="fix", stage="fix")
    assert "FIX" in flow.section_for(s)
    assert flow.permission_for(s, "default") == "acceptEdits"   # stage override
    s2 = store.create_session(555, "/p", stype="fix", stage="reproduce")
    assert flow.permission_for(s2, "default") == "default"      # no override
    plain = store.create_session(555, "/p")
    assert flow.section_for(plain) == ""
    assert flow.permission_for(plain, "plan") == "plan"


def test_after_turn_valid_card_emits_and_advances():
    s = _typed(turn="flow-j2")
    j = _StubJob(s["id"], "flow-j2", CARD)
    flow.after_turn(j)
    assert [e["type"] for e in j.added] == ["card"]
    assert store.get_session(s["id"])["stage"] == "verify"     # advance, no gate
    assert store.transcript(s["id"])["turns"][-1]["stage"] == "fix"


def test_after_turn_gated_stage_does_not_advance():
    s = store.create_session(555, "/p", stype="fix", stage="rootcause")
    store.start_turn(s["id"], "flow-j3", "work", [])
    body = "```hud-card\n" + json.dumps(
        {"stage": "rootcause", "summary": "found it",
         "fields": {"cause": "c", "fix_plan": "p"}, "advance": True}) + "\n```"
    flow.after_turn(_StubJob(s["id"], "flow-j3", body))
    assert store.get_session(s["id"])["stage"] == "rootcause"   # the gate holds


def test_after_turn_missing_card_nudges_once(monkeypatch):
    calls = []
    from bridge import queue_manager
    monkeypatch.setattr(queue_manager, "enqueue",
                        lambda sid, **kw: calls.append(kw) or True)
    s = _typed(turn="flow-j4")
    flow.after_turn(_StubJob(s["id"], "flow-j4", "prose only, no card"))
    assert len(calls) == 1 and calls[0]["surface"] == "flow"
    # the nudge turn itself failing must not nudge again
    store.start_turn(s["id"], "flow-j5", calls[0]["prompt"], [])
    flow.after_turn(_StubJob(s["id"], "flow-j5", "still prose"))
    assert len(calls) == 1


def test_after_turn_is_a_noop_for_plain_chat_and_bad_turns():
    s = store.create_session(555, "/p")
    store.start_turn(s["id"], "flow-j6", "x", [])
    j = _StubJob(s["id"], "flow-j6", CARD)
    flow.after_turn(j)
    assert j.added == []
    t = _typed(turn="flow-j7")
    err = _StubJob(t["id"], "flow-j7", CARD, status="error")
    flow.after_turn(err)
    assert err.added == []                    # a failed turn settles nothing


# --- API: what both servers hand out ----------------------------------------

def test_session_brief_carries_stype_and_stage():
    from bridge.miniapp.server import _session_brief
    s = store.create_session(555, "/p", stype="fix", stage="reproduce")
    b = _session_brief(s)
    assert b["stype"] == "fix" and b["stage"] == "reproduce"
    plain = _session_brief(store.create_session(555, "/p"))
    assert plain["stype"] is None and plain["stage"] is None


class _StubHandler:
    """Duck-typed stand-in for either server's Handler: _stage_action only
    needs _json, and both real ones have the same signature."""

    def __init__(self):
        self.sent = None

    def _json(self, body, code=200):
        self.sent = (body, code)
        return self.sent


def test_resolve_stype_gates_creation():
    from bridge.miniapp.server import _resolve_stype
    assert _resolve_stype("fix") == ("fix", "reproduce", None)
    assert _resolve_stype("") == (None, None, None)          # plain chat
    assert _resolve_stype(None) == (None, None, None)
    assert _resolve_stype("nope")[2] == "unknown flow type"


def test_resolve_stype_refuses_a_disabled_type():
    from bridge.miniapp.server import _resolve_stype
    zap = {"stype": "zap", "label": "ZAP", "blurb": "", "form": [],
           "stages": [{"id": "go", "label": "GO", "gate": False,
                       "instructions": "x", "card_fields": []}],
           "disabled": True}
    flow.save_custom("zap", zap)
    try:
        assert _resolve_stype("zap")[2] == "unknown flow type"
    finally:
        flow.delete_custom("zap")


def test_stage_endpoint_moves_and_refuses():
    from bridge.miniapp.server import _stage_action
    s = store.create_session(555, "/p", stype="fix", stage="reproduce")
    h = _StubHandler()
    _stage_action(h, 555, s["id"], {"action": "advance"})
    assert h.sent == ({"ok": True, "stage": "rootcause"}, 200)
    assert store.get_session(s["id"])["stage"] == "rootcause"

    _stage_action(h, 555, s["id"], {"action": "set", "stage": "nope"})
    assert h.sent[1] == 400
    _stage_action(h, 999, s["id"], {"action": "advance"})     # another chat
    assert h.sent[1] == 404
    plain = store.create_session(555, "/p")
    _stage_action(h, 555, plain["id"], {"action": "advance"})
    assert h.sent == ({"error": "not a typed session"}, 400)
