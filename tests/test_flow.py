"""Typed-session flows: store columns, flow definitions, the stage engine.

Env is pinned in conftest (config freezes settings at import) — nothing here
touches os.environ.
"""

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
