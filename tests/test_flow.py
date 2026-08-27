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
{"stage": "fix", "summary": "patched",
 "fields": {"changed": [{"file": "a.py", "add": 3, "del": 1}]},
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
    assert flow.stage_permission(f, "fix") is None    # no built-in pins one
    assert flow.stage_permission(
        {"stages": [{"id": "fix", "permission_mode": "plan"}]}, "fix") == "plan"


def test_apply_stage_writes_and_journals():
    s = store.create_session(555, "/p", stype="fix", stage="reproduce")
    store.start_turn(s["id"], "flow-ts1", "x", [])
    flow.apply_stage(s["id"], "rootcause", "user", turn_id="flow-ts1")
    assert store.get_session(s["id"])["stage"] == "rootcause"
    st = [e for e in store.transcript(s["id"])["events"] if e["type"] == "stage"]
    assert st, "a stage transition must be journaled"
    assert st[-1]["from"] == "reproduce" and st[-1]["to"] == "rootcause"
    assert st[-1]["by"] == "user"
    assert st[-1]["turn_id"] == "flow-ts1"


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
    """Duck-typed stand-in for runner.Job — after_turn reads only these.
    flow_stage is the stage the turn was COMPOSED under (runner stamps it);
    None means the turn ran before any stage contract existed."""

    def __init__(self, sid, turn_id, result, status="done", chat_id=555,
                 flow_stage="fix"):
        self.store_session_id = sid
        self.id = turn_id
        self.result = result
        self.texts = [result] if result else []
        self.status = status
        self.interrupted = False
        self.chat_id = chat_id
        self.flow_stage = flow_stage
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
    assert flow.permission_for(s, "default") == "default"       # no built-in pins one
    custom = json.loads(json.dumps(flow.load_flows()["fix"]))
    next(st for st in custom["stages"] if st["id"] == "fix")["permission_mode"] = "plan"
    assert flow.save_custom("fix", custom) == []
    assert flow.permission_for(s, "default") == "plan"          # stage override
    flow.delete_custom("fix")
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
    assert j.added[0]["gated"] is False        # the browser draws APPROVE off this
    assert store.get_session(s["id"])["stage"] == "verify"     # advance, no gate
    assert store.transcript(s["id"])["turns"][-1]["stage"] == "fix"


def test_after_turn_gated_stage_does_not_advance():
    s = store.create_session(555, "/p", stype="fix", stage="rootcause")
    store.start_turn(s["id"], "flow-j3", "work", [])
    body = "```hud-card\n" + json.dumps(
        {"stage": "rootcause", "summary": "found it",
         "fields": {"cause": "c", "fix_plan": "p"}, "advance": True}) + "\n```"
    flow.after_turn(_StubJob(s["id"], "flow-j3", body, flow_stage="rootcause"))
    assert store.get_session(s["id"])["stage"] == "rootcause"   # the gate holds


def test_after_turn_missing_card_costs_nothing(monkeypatch):
    """A card that never arrives journals the miss and stops. Re-asking for it
    used to cost a whole turn to recover a rendering — the work was already
    done and said, so the reply just stands as prose."""
    calls = []
    from bridge import queue_manager
    monkeypatch.setattr(queue_manager, "enqueue",
                        lambda sid, **kw: calls.append(kw) or True)
    s = _typed(turn="flow-j4")
    j = _StubJob(s["id"], "flow-j4", "prose only, no card")
    flow.after_turn(j)
    assert calls == []                                   # no turn spent
    assert [e["type"] for e in j.added] == ["card_missing"]
    assert store.get_session(s["id"])["stage"] == "fix"  # and the stage holds


def test_after_turn_skips_turns_composed_before_the_type_landed(monkeypatch):
    """An auto-classify verdict can type the session mid-turn; the turn already
    in flight was composed without a contract and must not be nudged."""
    calls = []
    from bridge import queue_manager
    monkeypatch.setattr(queue_manager, "enqueue",
                        lambda sid, **kw: calls.append(kw) or True)
    s = _typed(turn="flow-j8")                       # typed by the time it ends
    j = _StubJob(s["id"], "flow-j8", "prose only", flow_stage=None)
    flow.after_turn(j)
    assert j.added == [] and calls == []


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


def test_history_rows_carry_the_type():
    s = store.create_session(556, "/hp", stype="probe", stage="dig")
    store.start_turn(s["id"], "flow-h1", "q", [])
    row = next(r for r in store.history(556) if r["id"] == s["id"])
    assert row["stype"] == "probe" and row["stage"] == "dig"


# --- bot: a type picked from a keyboard, cards as plain text ----------------

def test_bot_form_fill_uses_the_primary_field():
    f = flow.get_flow("fix")
    p = flow.compose_first_prompt(f, {"what": "it crashes on save"})
    assert p == "[FIX]\nWHAT BROKE: it crashes on save"


def test_render_card_is_plain_text():
    card = {"stage": "fix", "summary": "patched a.py",
            "fields": {"changed": ["a.py", "b.py"], "pass": True}, "advance": True}
    txt = flow.render_card(card)
    assert "patched a.py" in txt
    assert "a.py, b.py" in txt                 # a list reads as a list
    assert "PASS: ✓" in txt                    # a bool reads as a glyph
    assert "hud-card" not in txt and "{" not in txt


def test_strip_card_leaves_the_prose():
    body = "Fixed it.\n\n```hud-card\n{\"stage\": \"fix\"}\n```"
    assert flow.strip_card(body) == "Fixed it."
    assert flow.strip_card("no card") == "no card"


# --- branching, repair, retype (2026-08-24) ----------------------------------

def test_validate_flow_rejects_a_branch_to_nowhere():
    f = flow.get_flow("fix")
    bad = {**f, "stages": [{**f["stages"][0], "next_allowed": ["nope"]}]}
    assert flow.validate_flow(bad) == [
        "stages[0].next_allowed names unknown stage 'nope'"]
    assert flow.validate_flow({**f, "stages": [{**f["stages"][0],
                                                "next_allowed": "fix"}]}) == [
        "stages[0].next_allowed must be a list of stage ids"]


def test_branch_is_offered_only_where_it_exists():
    f = flow.get_flow("fix")
    assert '"next"' in flow.compose_section(f, "verify")     # loops back to fix
    assert '"next"' not in flow.compose_section(f, "reproduce")


def test_card_branch_loops_back_instead_of_advancing():
    s = store.create_session(555, "/p", stype="fix", stage="verify")
    store.start_turn(s["id"], "flow-b1", "work", [])
    body = "```hud-card\n" + json.dumps(
        {"stage": "verify", "summary": "two checks failed",
         "fields": {"checks": [{"cmd": "pytest", "ok": False}], "pass": False},
         "advance": True, "next": "fix"}) + "\n```"
    flow.after_turn(_StubJob(s["id"], "flow-b1", body, flow_stage="verify"))
    assert store.get_session(s["id"])["stage"] == "fix"   # back, not on to done


def test_card_branch_off_the_allowlist_is_an_error(monkeypatch):
    from bridge import queue_manager
    monkeypatch.setattr(queue_manager, "enqueue", lambda sid, **kw: True)
    f = flow.get_flow("fix")
    errs = flow.validate_card(f, "verify", {"stage": "verify", "summary": "s",
                                            "fields": {"checks": [], "pass": True},
                                            "next": "reproduce"})
    assert errs == ["next 'reproduce' is not one of fix"]
    # a stage with no branch simply ignores the key
    assert flow.validate_card(f, "reproduce",
                              {"stage": "reproduce", "summary": "s",
                               "fields": {"reproduced": True, "evidence": "e"},
                               "next": "anywhere"}) == []


def test_a_gate_still_holds_against_a_branch():
    s = store.create_session(555, "/p", stype="fix", stage="rootcause")
    store.start_turn(s["id"], "flow-b2", "work", [])
    body = "```hud-card\n" + json.dumps(
        {"stage": "rootcause", "summary": "found it",
         "fields": {"cause": "c", "fix_plan": "p"},
         "advance": True, "next": "reproduce"}) + "\n```"
    flow.after_turn(_StubJob(s["id"], "flow-b2", body, flow_stage="rootcause"))
    assert store.get_session(s["id"])["stage"] == "rootcause"


def test_parse_card_repairs_what_the_model_nearly_got_right():
    trailing = '```hud-card\n{"stage": "fix", "summary": "s", "fields": {},}\n```'
    assert flow.parse_card(trailing)["summary"] == "s"
    unfenced = 'All done.\n\n{"stage": "fix", "summary": "no fence", "fields": {}}'
    assert flow.parse_card(unfenced)["summary"] == "no fence"
    brace = '```hud-card\n{"stage": "f", "summary": "a } brace", "fields": {}}\n```'
    assert flow.parse_card(brace)["summary"] == "a } brace"


def test_parse_card_still_refuses_what_is_not_a_card():
    assert flow.parse_card('prose with {"unrelated": 1} in it') is None
    assert flow.parse_card("no json at all") is None
    assert flow.parse_card('```hud-card\n["a list"]\n```') is None


def test_retype_moves_a_session_between_flows_and_out_to_chat():
    s = store.create_session(555, "/p", stype="fix", stage="verify")
    assert flow.retype(s["id"], "build") is True
    row = store.get_session(s["id"])
    assert row["stype"] == "build" and row["stage"] == "plan"   # flow restarts
    assert flow.retype(s["id"], None) is True
    row = store.get_session(s["id"])
    assert row["stype"] is None and row["stage"] is None        # back to CHAT
    assert flow.retype(s["id"], "nope") is False                # unknown type
    assert store.get_session(s["id"])["stype"] is None


def test_retype_journals_an_event_the_surfaces_can_read():
    s = store.create_session(555, "/p")
    flow.retype(s["id"], "probe")
    ev = [e for e in store.transcript(s["id"])["events"] if e["type"] == "retype"]
    assert ev and ev[-1]["to"] == "probe" and ev[-1]["stage"] == "dig"


def test_retype_endpoint_guards_ownership_and_the_type():
    from bridge.miniapp.server import _retype_action
    s = store.create_session(555, "/p", stype="fix", stage="reproduce")
    h = _StubHandler()
    _retype_action(h, 555, s["id"], {"stype": "probe"})
    assert h.sent == ({"ok": True, "stype": "probe", "stage": "dig"}, 200)
    _retype_action(h, 999, s["id"], {"stype": "build"})       # someone else's
    assert h.sent[1] == 404 and store.get_session(s["id"])["stype"] == "probe"
    _retype_action(h, 555, s["id"], {"stype": "nope"})
    assert h.sent[1] == 400 and store.get_session(s["id"])["stype"] == "probe"
    _retype_action(h, 555, s["id"], {"stype": ""})            # "" clears to chat
    assert h.sent == ({"ok": True, "stype": None, "stage": None}, 200)


# --- typed card fields, input hints, handoffs -------------------------------

def _flow_with(stage_extra: dict) -> dict:
    return {"stype": "t1", "label": "T1", "stages": [
        {"id": "one", "label": "ONE", "gate": False,
         "instructions": "do it", **stage_extra}]}


def test_fields_of_normalizes_strings_objects_and_junk():
    st = {"card_fields": ["a", {"name": "b", "type": "checks"},
                          {"name": "c", "type": "nope"}, {"type": "files"}, 7, ""]}
    assert flow.fields_of(st) == [
        {"name": "a", "type": "text"},              # bare string: still text
        {"name": "b", "type": "checks"},
        {"name": "c", "type": "text"},              # unknown type degrades
    ]                                                # nameless and junk dropped


def test_validate_flow_accepts_typed_fields_and_rejects_unknown_ones():
    assert flow.validate_flow(_flow_with(
        {"card_fields": ["a", {"name": "b", "type": "findings"}]})) == []
    for bad, needle in [
        ({"card_fields": [{"name": "b", "type": "nope"}]}, "type must be one of"),
        ({"card_fields": [{"type": "files"}]}, "must be a name"),
        ({"card_fields": ["a"], "input": "shout"}, "input must be one of"),
        ({"card_fields": ["a"], "handoff": "fix"}, "handoff must be a list"),
        ({"card_fields": ["a"], "handoff": ["NOPE"]}, "handoff must be a list"),
    ]:
        errs = flow.validate_flow(_flow_with(bad))
        assert any(needle in e for e in errs), (bad, errs)


def test_validate_flow_accepts_the_hints_the_surfaces_read():
    assert flow.validate_flow(_flow_with(
        {"card_fields": ["a"], "input": "triage", "handoff": ["fix"]})) == []


def test_builtins_carry_the_shapes_the_widgets_need():
    flows = flow.load_flows()
    types = {(st, s["id"], x["name"]): x["type"]
             for st, f in flows.items() for s in f["stages"]
             for x in flow.fields_of(s)}
    assert types[("build", "verify", "checks")] == "checks"
    assert types[("build", "plan", "files")] == "files"
    assert types[("build", "ship", "commit_msg")] == "draft"
    assert types[("review", "sweep", "findings")] == "findings"
    assert types[("ops", "state", "will_do")] == "commands"
    assert types[("probe", "report", "confidence")] == "confidence"
    assert types[("design", "draft", "screens")] == "screens"
    inputs = {(st, s["id"]): s.get("input")
              for st, f in flows.items() for s in f["stages"]}
    assert inputs[("ops", "state")] == "arm"
    assert inputs[("fix", "reproduce")] == "evidence"
    assert inputs[("review", "sweep")] == "triage"
    assert flow.stage_by_id(flows["review"], "report")["handoff"] == ["fix"]
    assert flow.stage_by_id(flows["probe"], "report")["handoff"] == ["fix", "build"]


def test_catalog_carries_fields_input_and_handoff():
    cat = flow.catalog()
    review = next(f for f in cat["flows"] if f["stype"] == "review")
    sweep = next(s for s in review["stages"] if s["id"] == "sweep")
    assert sweep["fields"] == [{"name": "findings", "type": "findings"}]
    assert sweep["input"] == "triage"
    report = next(s for s in review["stages"] if s["id"] == "report")
    assert report["handoff"] == ["fix"] and report["input"] == ""


def test_contract_states_each_fields_shape():
    sec = flow.compose_section(flow.get_flow("build"), "verify")
    assert '"checks": [{"cmd": "<command>", "ok": true}]' in sec
    assert "checks, pass" in sec                     # the names line still holds
    sec = flow.compose_section(flow.get_flow("build"), "plan")
    assert '"files": ["path/to/file", ...]' in sec
    assert '"approach": ...' in sec                  # text stays a bare slot


def test_typed_fields_are_checked_by_name_and_shape():
    f = flow.get_flow("build")
    card = {"stage": "verify", "summary": "ran them",
            "fields": {"checks": "pytest passed", "pass": "yes"}}
    assert any("fields.checks" in e for e in flow.validate_card(f, "verify", card))
    card["fields"]["checks"] = [{"cmd": "pytest", "ok": True}]
    assert flow.validate_card(f, "verify", card) == []
    card["fields"].pop("checks")                          # missing: nudged
    assert any("fields.checks" in e for e in flow.validate_card(f, "verify", card))


def test_shape_check_allows_empty_and_partial_but_not_the_wrong_container():
    f = flow.get_flow("data")
    ok = {"stage": "read", "summary": "read it", "fields": {
        "over_time": [], "headline": None, "reading": "flat",
        "rows": {"cols": ["DAY"], "rows": [["08-22"]]}}}
    assert flow.validate_card(f, "read", ok) == []        # empty/null draw fine
    ok["fields"]["over_time"] = [{"label": "08-22"}]      # missing value: draws
    assert flow.validate_card(f, "read", ok) == []
    ok["fields"]["rows"] = {"cols": ["DAY"]}              # no rows: cannot draw
    assert any("rows" in e for e in flow.validate_card(f, "read", ok))


def test_shape_check_leaves_text_fields_alone():
    f = flow.get_flow("probe")
    card = {"stage": "report", "summary": "done", "fields": {
        "answer": [{"text": "it is the lock", "cites": [1]}],
        "recommendation": {"anything": "goes"},          # text: never checked
        "confidence": 0.8}}
    assert flow.validate_card(f, "report", card) == []
    card["fields"]["confidence"] = "high"                 # num: checked
    assert any("confidence" in e for e in flow.validate_card(f, "report", card))


def test_shape_check_never_rejects_what_the_widget_would_draw():
    """The safety property: every loose form the as*() coercers in
    web/src/lib/cardfields.ts accept has to survive validation."""
    drawable = {
        "confidence": ["0.8", 80, 0.8],                  # asConfidence
        "verdict": ["PASS", True],                       # VerdictBanner
        "output": ["it printed this", {"text": "x", "cmd": "pytest"}],  # asOutput
        "files": [["a.py"], [{"path": "a.py", "add": 3}]],             # asFiles
        "checks": [[], [{"cmd": "pytest", "ok": True}]],
    }
    for t, values in drawable.items():
        for v in values:
            assert flow._shape_error("f", t, v) is None, (t, v)


def test_save_custom_rejects_a_handoff_to_a_flow_that_does_not_exist():
    d = {"stype": "t2", "label": "T2", "stages": [
        {"id": "one", "label": "ONE", "gate": False, "instructions": "go",
         "card_fields": ["a"], "handoff": ["ghost"]}]}
    assert any("unknown flow" in e for e in flow.save_custom("t2", d))
    d["stages"][0]["handoff"] = ["build"]
    assert flow.save_custom("t2", d) == []
    assert "t2" in flow.load_flows()
    flow.delete_custom("t2")


def test_render_card_flattens_typed_rows_for_the_bot():
    txt = flow.render_card({"stage": "verify", "summary": "ran",
                            "fields": {"checks": [{"cmd": "pytest -q", "ok": True},
                                                  {"cmd": "tsc", "ok": False}]}})
    assert "CHECKS: pytest -q ✓, tsc ✗" in txt
