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


# --- the next step starts by itself -------------------------------------------

from types import SimpleNamespace  # noqa: E402


@pytest.fixture
def fake_queue(monkeypatch):
    from bridge import queue_manager
    q = SimpleNamespace(items=[])
    monkeypatch.setattr(queue_manager, "enqueue", lambda sid, **kw: q.items.append(dict(kw, sid=sid)))
    return q


@pytest.fixture
def nextstep_on(monkeypatch):
    monkeypatch.setattr(aifeatures, "enabled", lambda key: key in ("router", "nextstep"))


def _job(sid, turn="t1", **kw):
    return SimpleNamespace(store_session_id=sid, id=turn, status="done", interrupted=False,
                           runtime=None, chat_id=1, **kw)


@pytest.fixture
def flow_job(state_dir, nextstep_on):
    paths.set_path("f1", "feature", "new", "claude")
    return _job("f1")


@pytest.fixture
def plain_job(state_dir, nextstep_on):
    return _job("nopath")


@pytest.fixture
def flow_job_with_next(flow_job):
    paths.step_done("f1", "t1")
    return flow_job


@pytest.fixture
def flow_job_with_next_at_160k(flow_job_with_next, monkeypatch):
    monkeypatch.setattr(store, "get_session", lambda sid: {"ctx_tokens": 160_000, "chat_id": 1})
    monkeypatch.setattr(aifeatures, "enabled", lambda key: key in ("router", "nextstep", "smartzone"))
    return flow_job_with_next


def test_grill_step_done_enqueues_to_spec(router_on, nextstep_on, fake_queue, flow_job):
    paths.step_done(flow_job.store_session_id, flow_job.id)
    assert paths.continue_after_turn(flow_job) is True
    assert fake_queue.items[-1]["prompt"] == "/mattpocock-skills:to-spec"
    assert fake_queue.items[-1]["surface"] == "flow"


def test_no_step_done_no_enqueue(fake_queue, flow_job):
    assert paths.continue_after_turn(flow_job) is False and not fake_queue.items


def test_no_path_no_enqueue(fake_queue, plain_job):
    assert paths.continue_after_turn(plain_job) is False


def test_router_off_no_enqueue(fake_queue, flow_job_with_next, router_off):
    assert paths.continue_after_turn(flow_job_with_next) is False


def test_nextstep_off_no_enqueue(fake_queue, flow_job_with_next, monkeypatch):
    monkeypatch.setattr(aifeatures, "enabled", lambda key: key == "router")
    assert paths.continue_after_turn(flow_job_with_next) is False


def test_held_auto_no_enqueue(fake_queue, flow_job_with_next):
    paths.set_auto(flow_job_with_next.store_session_id, False)
    assert paths.continue_after_turn(flow_job_with_next) is False


def test_next_from_an_earlier_turn_does_not_start(fake_queue, flow_job_with_next):
    flow_job_with_next.id = "t2"
    assert paths.continue_after_turn(flow_job_with_next) is False


def test_interrupted_or_failed_turn_does_not_start(fake_queue, flow_job_with_next):
    flow_job_with_next.interrupted = True
    assert paths.continue_after_turn(flow_job_with_next) is False
    flow_job_with_next.interrupted, flow_job_with_next.status = False, "error"
    assert paths.continue_after_turn(flow_job_with_next) is False


def test_build_station_is_left_to_the_user(fake_queue, nextstep_on):
    paths.set_path("f2", "feature", "x", "claude")
    for t in ("a", "b", "c"):
        paths.step_done("f2", t)           # grill, spec, tickets done; build is next
    assert paths.continue_after_turn(_job("f2", "c")) is False and not fake_queue.items


def test_compact_first_past_150k(fake_queue, flow_job_with_next_at_160k):
    paths.continue_after_turn(flow_job_with_next_at_160k)
    assert fake_queue.items[0]["prompt"].startswith("/compact ")
    assert fake_queue.items[1]["prompt"] == "/mattpocock-skills:to-spec"


def test_advance_from_merge_enqueues_retro(fake_queue, nextstep_on):
    paths.set_path("f3", "feature", "x", "claude")
    for t in ("a", "b", "c", "d"):
        paths.step_done("f3", t)           # through build
    assert paths.advance("f3", "merge") is True
    assert fake_queue.items[-1]["prompt"] == "/mattpocock-skills:retro"


def test_typed_flow_command_joins_its_path(state_dir):
    paths.on_turn_start("s9", "/mattpocock-skills:diagnosing-bugs the crash")
    f = paths.get("s9")
    assert f["path"] == "bug" and f["by"] == "rule"
    paths.on_turn_start("s9", "/mattpocock-skills:retro")
    assert paths.get("s9")["path"] == "bug"       # already on a path
    paths.on_turn_start("s8", "fix the typo")
    assert paths.get("s8") is None


def test_flow_step_wins_over_an_active_goal(fake_queue, flow_job_with_next, monkeypatch):
    from bridge import goals
    monkeypatch.setattr(goals, "continue_after_turn",
                        lambda job, effort=None: fake_queue.items.append({"prompt": "goal"}) or True)
    assert runner._continue_after_turn(flow_job_with_next) is True    # noqa: SLF001
    assert [i["prompt"] for i in fake_queue.items] == ["/mattpocock-skills:to-spec"]


def test_waiting_session_queues_nothing(fake_queue, flow_job_with_next, monkeypatch):
    from bridge import waits
    monkeypatch.setattr(waits, "waiting", lambda sid: True)
    assert paths.continue_after_turn(flow_job_with_next) is False
    assert paths.advance("f1", "spec") is False and not fake_queue.items


def test_build_here_makes_branch_carries_files_then_implements(fake_queue, nextstep_on, state_dir, monkeypatch):
    from bridge import flowbranch
    calls = []
    sess = {"cwd": "/p", "chat_id": 1, "title": "My Feature", "project": "p"}
    monkeypatch.setattr(store, "get_session", lambda sid: sess)
    monkeypatch.setattr(flowbranch, "flow_files", lambda sid, since: ["/p/GLOSSARY.md"])
    monkeypatch.setattr(flowbranch, "ensure_feature_branch",
                        lambda s, slug: calls.append(("ensure", slug)) or ("feat/my-feature", "/wt"))
    monkeypatch.setattr(flowbranch, "carry_and_commit",
                        lambda src, dst, files, slug: calls.append(("carry", src, dst, files, slug)) or True)
    paths.set_path("b1", "feature-here", "new", "claude")
    paths.step_done("b1", "t1")
    assert paths.continue_after_turn(_job("b1")) is True
    assert calls == [("ensure", "my-feature"), ("carry", "/p", "/wt", ["/p/GLOSSARY.md"], "my-feature")]
    assert fake_queue.items[-1]["prompt"] == \
        "/mattpocock-skills:implement Work in /wt on branch feat/my-feature, and commit there."


def test_build_here_failure_enqueues_nothing_and_tells_the_user(fake_queue, nextstep_on, state_dir, monkeypatch):
    from bridge import flowbranch, runner
    sent = []
    monkeypatch.setattr(store, "get_session", lambda sid: {"cwd": "/p", "chat_id": 1, "title": "T", "project": "p"})
    monkeypatch.setattr(flowbranch, "flow_files", lambda sid, since: ["/p/G.md"])
    monkeypatch.setattr(flowbranch, "ensure_feature_branch", lambda s, slug: ("feat/t", "/wt"))
    def boom(*a):
        raise flowbranch.FlowBranchError("pop conflict")
    monkeypatch.setattr(flowbranch, "carry_and_commit", boom)
    monkeypatch.setattr(runner, "_notify", lambda chat, text, *a, **k: sent.append((chat, text)))
    paths.set_path("b2", "feature-here", "new", "claude")
    paths.step_done("b2", "t1")
    assert paths.continue_after_turn(_job("b2")) is False
    assert not fake_queue.items and "pop conflict" in sent[0][1] and "feat/t" in sent[0][1]
