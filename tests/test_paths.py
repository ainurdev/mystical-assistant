"""paths: the bundled skill pack rides every interactive run while SKILL PATHS
(the `router` AI switch) is on. Run: python -m pytest tests/test_paths.py -v"""

import os

import pytest

from bridge import aifeatures, config, paths, runner, store

store.init()
SID = "11111111-2222-3333-4444-555555555555"


def _cmd(**kw):
    return runner._base_cmd("hi", 1, stream=True, interactive=True, claude_session_id=SID, **kw)


@pytest.fixture
def router_on(monkeypatch):
    monkeypatch.setattr(aifeatures, "enabled", lambda key: key == "router")


@pytest.fixture
def router_off(monkeypatch):
    monkeypatch.setattr(aifeatures, "enabled", lambda key: False)


def test_base_cmd_adds_plugin_dir_when_router_on(router_on):
    cmd = _cmd()
    assert cmd[cmd.index("--plugin-dir") + 1] == paths.PACK_DIR


def test_base_cmd_no_plugin_dir_when_off_or_skip_pack(router_off, monkeypatch):
    assert "--plugin-dir" not in _cmd()
    monkeypatch.setattr(aifeatures, "enabled", lambda key: True)
    assert "--plugin-dir" not in _cmd(skip_pack=True)


@pytest.fixture
def session_c1():
    s = store.create_session(1, "p")
    store.set_claude_session_id(s["id"], "c1")
    paths._pack_ok.clear()


@pytest.fixture
def rivendell_session_c2():
    s = store.create_session(1, "p", origin="rivendell:job")
    store.set_claude_session_id(s["id"], "c2")
    paths._pack_ok.clear()


def test_pack_in_prompt_when_on(router_on, session_c1):
    assert paths.PACK_TEXT in runner._compose_system_prompt(paths_pack=paths.pack_for("c1"))


def test_pack_is_constant(router_on, session_c1):
    a = runner._compose_system_prompt(paths_pack=paths.pack_for("c1"))
    assert a == runner._compose_system_prompt(paths_pack=paths.pack_for("c1"))


def test_no_pack_for_rivendell_jobs(router_on, rivendell_session_c2):
    assert paths.pack_for("c2") == ""


def test_no_pack_when_off(router_off, session_c1):
    assert paths.pack_for("c1") == ""


@pytest.fixture
def state_dir():
    f = os.path.join(os.path.dirname(config.BRIDGE_DB), "flows.json")
    paths._cache.clear()
    if os.path.exists(f):
        os.remove(f)
    yield
    paths._cache.clear()


def test_feature_grill_done_goes_to_spec(state_dir):
    paths.set_path("s1", "feature", "new feature", "claude")
    assert paths.step_done("s1", "t1") == "spec"


def test_choice_here_switches_to_feature_here(state_dir):
    paths.set_path("s1", "feature", "small", "claude")
    assert paths.step_done("s1", "t1", choice="here") == "build-here"
    g = paths.get("s1")
    assert g["path"] == "feature-here" and g["done"] == ["grill"]


def test_step_done_same_turn_twice_is_one_step(state_dir):
    paths.set_path("s1", "bug", "crash", "rule")
    assert paths.step_done("s1", "t1") == "fix" and paths.step_done("s1", "t1") == "fix"
    assert paths.get("s1")["done"] == ["diagnose"]


def test_last_station_returns_none(state_dir):
    paths.set_path("s1", "feature-here", "x", "rule")
    for i in range(2):
        paths.step_done("s1", f"t{i}")
    assert paths.step_done("s1", "t9") is None
    assert paths.step_done("s1", "t9") is None
    assert paths.get("s1")["next"] is None and paths.get("s1")["done"][-1] == "retro"


def test_flows_survive_reload(state_dir):
    paths.set_path("s1", "bug", "crash", "rule")
    paths._cache.clear()
    g = paths.get("s1")
    assert g["path"] == "bug" and g["auto"] is True and g["at"] > 0
    paths.set_auto("s1", False)
    paths._cache.clear()
    assert paths.get("s1")["auto"] is False


def test_new_path_replaces_old(state_dir):
    paths.set_path("s1", "bug", "crash", "rule")
    paths.step_done("s1", "t1")
    paths.set_path("s1", "refactor", "mess", "claude")
    g = paths.get("s1")
    assert g["path"] == "refactor" and g["done"] == [] and g["next"] is None


def test_one_path_uses_skill(state_dir):
    paths.set_path("s1", "one", "dig", "claude", skill="research")
    assert paths.step_done("s1", "t1") is None
    assert paths.get("s1")["done"] == ["research"]


def test_unknown_path_rejected(state_dir):
    with pytest.raises(ValueError):
        paths.set_path("s1", "nope", "", "claude")


def test_typed_to_tickets_joins_feature_at_tickets():
    assert paths.path_for_command("to-tickets") == ("feature", "tickets")
    assert paths.path_for_command("research") == ("one", "research")


# --- SetPath / StepDone: the tools and the bridge routes ---------------------

def _list_tools():
    from bridge import goal_mcp
    out = goal_mcp._handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})  # noqa: SLF001
    return out["result"]["tools"]


@pytest.fixture
def flow_session(state_dir, monkeypatch):
    from bridge.dashboard import server as dash
    monkeypatch.setattr(dash, "_chat", lambda: 1)
    s = store.create_session(1, "p")
    store.set_claude_session_id(s["id"], "cf1")
    store.start_turn(s["id"], "t-" + s["id"], "hi", None)
    return s["id"]


@pytest.fixture
def server(flow_session):
    from bridge.dashboard import server as dash
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)   # noqa: SLF001

    class S:
        def post(self, path, body):
            h._post_api(path, body)  # noqa: SLF001
            return dict(box)
    return S()


@pytest.fixture
def rivendell_origin(monkeypatch):
    s = store.create_session(1, "p", origin="rivendell:job")
    store.set_claude_session_id(s["id"], "c-rv")
    monkeypatch.setenv("MYSTICAL_CLAUDE_SESSION_ID", "c-rv")


def test_path_tools_listed_only_when_on(router_on, session_c1, monkeypatch):
    monkeypatch.setenv("MYSTICAL_CLAUDE_SESSION_ID", "c1")
    assert {"SetPath", "StepDone"} <= {t["name"] for t in _list_tools()}


def test_path_tools_hidden_when_off(router_off, session_c1, monkeypatch):
    monkeypatch.setenv("MYSTICAL_CLAUDE_SESSION_ID", "c1")
    assert "SetPath" not in {t["name"] for t in _list_tools()}


def test_path_tools_hidden_for_rivendell_origin(router_on, rivendell_origin):
    assert "SetPath" not in {t["name"] for t in _list_tools()}


def test_set_path_and_step_done_idempotent(server, flow_session):
    assert server.post("/local/flow/set", {"claude_session_id": "cf1", "path": "feature", "why": "new"})["obj"] == \
        {"text": "Path recorded: feature."}
    a = server.post("/local/flow/done", {"claude_session_id": "cf1"})
    b = server.post("/local/flow/done", {"claude_session_id": "cf1"})
    assert paths.get(flow_session)["next"]["station"] == "spec" and a == b
    assert a["obj"]["text"].startswith("Step done. Next: spec")


def test_step_done_without_a_path_changes_nothing(server, flow_session):
    r = server.post("/local/flow/done", {"claude_session_id": "cf1"})
    assert r["obj"] == {"text": "No path is running in this session."} and paths.get(flow_session) is None


def test_bad_path_is_a_400(server, flow_session):
    assert server.post("/local/flow/set", {"claude_session_id": "cf1", "path": "nope", "why": "x"})["code"] == 400
    assert server.post("/local/flow/set", {"claude_session_id": "cf1", "path": "one", "why": "x"})["code"] == 400


def test_auto_route(server, flow_session):
    paths.set_path(flow_session, "bug", "x", "claude")
    assert server.post("/local/flow/auto", {"session": flow_session, "on": False})["obj"] == {"ok": True}
    assert paths.get(flow_session)["auto"] is False
    assert server.post("/local/flow/auto", {"session": "zzz", "on": True})["code"] == 404
