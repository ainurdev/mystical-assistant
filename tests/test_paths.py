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
    assert paths.get("s1")["skill"] == "research"
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


def test_build_station_starts_tickets_when_on(fake_queue, state_dir, monkeypatch):
    from bridge import tickets
    calls = []
    monkeypatch.setattr(tickets, "start_build", lambda sid: calls.append(sid) or "")
    monkeypatch.setattr(aifeatures, "enabled", lambda key: key in ("router", "nextstep", "ticketruns"))
    paths.set_path("f5", "feature", "x", "claude")
    for t in ("a", "b", "c"):
        paths.step_done("f5", t)           # build is next
    assert paths.continue_after_turn(_job("f5", "c")) is True and calls == ["f5"] and not fake_queue.items
    monkeypatch.setattr(tickets, "start_build", lambda sid: "cycle: #01 → #02 → #01")
    assert paths._start("f5", "build") is False  # noqa: SLF001


def test_mark_done_marks_once_and_starts_nothing(fake_queue, state_dir):
    paths.set_path("f6", "feature", "x", "claude")
    paths.mark_done("f6", "build")
    paths.mark_done("f6", "build")
    assert paths.get("f6")["done"] == ["build"] and not fake_queue.items
    paths.mark_done("nopath", "build")
    assert paths.get("nopath") is None


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


def test_typed_flow_command_joins_its_path(state_dir, router_on):
    paths.on_turn_start("s9", "/mattpocock-skills:diagnosing-bugs the crash")
    f = paths.get("s9")
    assert f["path"] == "bug" and f["by"] == "rule"
    paths.on_turn_start("s9", "/mattpocock-skills:retro")
    assert (paths.get("s9")["path"], paths.get("s9")["skill"]) == ("one", "retro")   # not bug's next station
    paths.on_turn_start("s8", "fix the typo")
    assert paths.get("s8") is None


# --- C1: a typed or auto-picked command joins mid-path, or replaces a stale path ---

def _turn(sid, prompt):
    """A turn of `sid` sent as `prompt`, as start_streaming_job records it and tells paths."""
    t = "t-" + os.urandom(4).hex()
    store.start_turn(sid, t, prompt, None)
    paths.on_turn_start(sid, prompt)
    return t


@pytest.fixture
def sess(state_dir):
    return store.create_session(1, "p")["id"]


def test_typed_tdd_is_a_one_step_path(sess, fake_queue, nextstep_on):
    t = _turn(sess, "/mattpocock-skills:tdd the parser")
    assert (paths.get(sess)["path"], paths.get(sess)["skill"]) == ("one", "tdd")
    assert paths.step_done(sess, t) is None
    assert paths.continue_after_turn(_job(sess, t)) is False and not fake_queue.items


def test_a_typed_command_replaces_a_stale_path(sess, fake_queue, nextstep_on):
    paths.set_path(sess, "feature", "new", "claude")
    paths.step_done(sess, "t0")                          # grill done; stuck at SPEC
    t = _turn(sess, "/mattpocock-skills:diagnosing-bugs the crash")
    assert paths.get(sess)["path"] == "bug" and paths.get(sess)["done"] == []
    assert paths.step_done(sess, t) == "fix"
    assert paths.continue_after_turn(_job(sess, t)) is True
    assert fake_queue.items[-1]["prompt"] == "/mattpocock-skills:tdd"


def test_a_typed_to_spec_joins_feature_at_spec(sess, nextstep_on):
    _turn(sess, "/mattpocock-skills:to-spec")
    f = paths.get(sess)
    assert (f["path"], f["done"]) == ("feature", ["grill"])
    assert paths.path_for_command("to-tickets") == ("feature", "tickets")
    assert paths.path_for_command("improve-codebase-architecture") == ("refactor", "improve")
    assert paths.path_for_command("tdd") == paths.path_for_command("implement")[:1] + ("tdd",) == ("one", "tdd")


def test_a_typed_implement_starts_nothing_after_it(sess, fake_queue, nextstep_on):
    t = _turn(sess, "/mattpocock-skills:implement .mystical/tickets/x/01-a.md")
    assert (paths.get(sess)["path"], paths.get(sess)["skill"]) == ("one", "implement")
    assert paths.step_done(sess, t) is None
    assert paths.continue_after_turn(_job(sess, t)) is False and not fake_queue.items


def test_the_next_station_typed_keeps_the_path(sess, nextstep_on):
    paths.set_path(sess, "feature", "new", "claude")
    paths.step_done(sess, "t0")
    before = paths.get(sess)
    _turn(sess, "/mattpocock-skills:to-spec")
    assert paths.get(sess) == before


def test_step_done_marks_the_station_its_turn_named(sess, nextstep_on):
    paths.set_path(sess, "feature", "new", "claude")
    t = "t-spec"
    store.start_turn(sess, t, "/mattpocock-skills:to-spec", None)   # SKILL PATHS came on mid-turn: no join
    assert paths.step_done(sess, t) == "tickets"
    assert paths.get(sess)["done"] == ["grill", "spec"]


def test_no_join_while_paths_are_off(sess, router_off):
    _turn(sess, "/mattpocock-skills:tdd x")
    assert paths.get(sess) is None


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
                        lambda s, slug, prefix: calls.append(("ensure", slug, prefix)) or ("feat/my-feature", "/wt"))
    monkeypatch.setattr(flowbranch, "carry_and_commit",
                        lambda src, dst, files, slug: calls.append(("carry", src, dst, files, slug)) or True)
    paths.set_path("b1", "feature-here", "new", "claude")
    paths.step_done("b1", "t1")
    assert paths.continue_after_turn(_job("b1")) is True
    assert calls == [("ensure", "my-feature", "feat"), ("carry", "/p", "/wt", ["/p/GLOSSARY.md"], "my-feature")]
    assert fake_queue.items[-1]["prompt"] == \
        "/mattpocock-skills:implement Work in /wt on branch feat/my-feature, and commit there."


def test_build_here_failure_enqueues_nothing_and_tells_the_user(fake_queue, nextstep_on, state_dir, monkeypatch):
    from bridge import flowbranch, runner
    sent = []
    monkeypatch.setattr(store, "get_session", lambda sid: {"cwd": "/p", "chat_id": 1, "title": "T", "project": "p"})
    monkeypatch.setattr(flowbranch, "flow_files", lambda sid, since: ["/p/G.md"])
    monkeypatch.setattr(flowbranch, "ensure_feature_branch", lambda s, slug, prefix: ("feat/t", "/wt"))
    def boom(*a):
        raise flowbranch.FlowBranchError("pop conflict")
    monkeypatch.setattr(flowbranch, "carry_and_commit", boom)
    monkeypatch.setattr(runner, "_notify", lambda chat, text, *a, **k: sent.append((chat, text)))
    paths.set_path("b2", "feature-here", "new", "claude")
    paths.step_done("b2", "t1")
    assert paths.continue_after_turn(_job("b2")) is False
    assert not fake_queue.items and "pop conflict" in sent[0][1] and "feat/t" in sent[0][1]


# --- "No path" on Esc: /local/run prefixes the prompt ---------------------------

def _run_prompt(monkeypatch, body):
    from types import SimpleNamespace

    from bridge import relevance
    from bridge.dashboard import server as dash
    seen = []
    monkeypatch.setattr(runner, "start_streaming_job",
                        lambda chat, prompt, *a, **kw: seen.append(prompt) or SimpleNamespace(id="j", store_session_id=SID))
    monkeypatch.setattr(relevance, "gate", lambda *a, **k: None)
    h = dash.Handler.__new__(dash.Handler)
    h._json = lambda obj, code=200: None
    h._run(555, {"session_id": SID, **body})
    return seen[0]


def test_no_path_prefix(monkeypatch):
    assert _run_prompt(monkeypatch, {"prompt": "add a digest", "no_path": True}) == "No path for this message.\n\nadd a digest"
    assert _run_prompt(monkeypatch, {"prompt": "add a digest"}) == "add a digest"
    assert _run_prompt(monkeypatch, {"prompt": "add a digest", "no_path": "yes"}) == "add a digest"


def test_no_path_images_only_stays_empty(monkeypatch):
    assert _run_prompt(monkeypatch, {"prompt": "", "images": ["x"], "no_path": True}) == ""


def test_no_path_ignored_for_commands(monkeypatch):
    assert _run_prompt(monkeypatch, {"prompt": "/compact keep it", "no_path": True}) == "/compact keep it"


# --- I1: a resume of the recording turn, or releasing AUTO, starts the pending step ---

def _end(sid, t, status="done"):
    """Turn t ended `status`; the job its end hands on."""
    store.finish_turn(t, status, 0, 1)
    job = _job(sid, t)
    job.status = status
    return job


def test_a_resumed_turn_starts_the_step_its_cut_turn_recorded(sess, fake_queue, nextstep_on):
    from bridge import runner as r
    t = _turn(sess, "/mattpocock-skills:diagnosing-bugs the crash")
    paths.step_done(sess, t)
    _end(sess, t, "error")                              # cut by an error after StepDone
    n1 = _turn(sess, r.RESUME_NUDGE)
    _end(sess, n1, "error")                             # the resume dies too
    n2 = _turn(sess, r.RESUME_NUDGE)
    assert paths.step_done(sess, n2) == "fix" and paths.get(sess)["done"] == ["diagnose"]   # a repeat moves nothing
    job = _end(sess, n2)
    assert paths.continue_after_turn(job) is True
    assert [i["prompt"] for i in fake_queue.items] == ["/mattpocock-skills:tdd"]
    assert paths.continue_after_turn(job) is False and len(fake_queue.items) == 1   # once per step


def test_a_typed_turn_after_the_recording_one_starts_nothing(sess, fake_queue, nextstep_on):
    t = _turn(sess, "/mattpocock-skills:diagnosing-bugs the crash")
    paths.step_done(sess, t)
    _end(sess, t, "error")
    u = _turn(sess, "what did you find?")
    assert paths.continue_after_turn(_end(sess, u)) is False and not fake_queue.items


def test_releasing_auto_starts_the_pending_step(sess, fake_queue, nextstep_on):
    t = _turn(sess, "/mattpocock-skills:diagnosing-bugs the crash")
    paths.step_done(sess, t)
    paths.set_auto(sess, False)
    assert paths.continue_after_turn(_end(sess, t)) is False and not fake_queue.items
    paths.set_auto(sess, True)
    assert [i["prompt"] for i in fake_queue.items] == ["/mattpocock-skills:tdd"]
    paths.set_auto(sess, False)
    paths.set_auto(sess, True)
    assert len(fake_queue.items) == 1


def test_releasing_auto_mid_turn_starts_it_when_that_turn_ends(sess, fake_queue, nextstep_on):
    t = _turn(sess, "/mattpocock-skills:diagnosing-bugs the crash")
    paths.step_done(sess, t)
    paths.set_auto(sess, False)
    paths.continue_after_turn(_end(sess, t))
    u = _turn(sess, "and the logs?")                    # running
    paths.set_auto(sess, True)
    assert not fake_queue.items                         # never in the middle of a turn
    assert paths.continue_after_turn(_end(sess, u)) is True and len(fake_queue.items) == 1


def test_every_resume_nudge_starts_with_the_resume_mark():
    from bridge import ladder, limits, recovery
    from bridge import runner as r
    for text in (recovery.CONTINUED, recovery.NUDGE, limits.NUDGE, limits.SERVER_NUDGE, r.RESUME_NUDGE,
                 r.TIMEOUT_NUDGE, r.AUTH_NUDGE, r.AGENT_AUTH_NUDGE, ladder.ACCOUNT_NUDGE):
        assert text.startswith(paths._RESUME), text   # noqa: SLF001


def test_merge_is_done_even_while_auto_is_held(fake_queue, nextstep_on, state_dir):
    paths.set_path("f7", "feature", "x", "claude")
    for t in ("a", "b", "c", "d"):
        paths.step_done("f7", t)           # through build
    paths.set_auto("f7", False)
    assert paths.advance("f7", "merge") is False and not fake_queue.items
    f = paths.get("f7")
    assert f["done"][-1] == "merge" and f["next"]["station"] == "retro"
    paths.set_auto("f7", True)              # released: RETRO starts now
    assert fake_queue.items[-1]["prompt"] == "/mattpocock-skills:retro"


# --- I10: no auto step commits to the default branch ------------------------------

import subprocess  # noqa: E402


def _git(cwd, *a):
    return subprocess.run(["git", "-C", cwd, *a], capture_output=True, text=True, check=True).stdout.strip()


@pytest.fixture
def repo_session(tmp_path, monkeypatch, state_dir):
    """A session titled "My Feature" in a repo's main checkout, on master."""
    monkeypatch.setattr(config, "BASE_PATH", str(tmp_path / "base"))
    main = str(tmp_path / "proj")
    os.makedirs(main)
    for a in (("init", "-q", "-b", "master"), ("config", "user.email", "t@t"), ("config", "user.name", "t")):
        _git(main, *a)
    with open(os.path.join(main, "README.md"), "w") as f:
        f.write("x\n")
    _git(main, "add", "-A")
    _git(main, "commit", "-qm", "init")
    sid = store.create_session(1, "proj", cwd=main)["id"]
    store.rename(sid, "My Feature")
    return sid, main


def _wrote(sid, t, path):
    with open(path, "w") as f:
        f.write("flow")
    store.append_event(sid, t, {"type": "tool", "name": "Write", "summary": path})


def test_build_here_moves_the_session_into_its_feature_worktree(repo_session, fake_queue, nextstep_on):
    sid, main = repo_session
    master = _git(main, "rev-parse", "master")
    t = _turn(sid, "/mattpocock-skills:grill-with-docs add X")
    _wrote(sid, t, os.path.join(main, "GLOSSARY.md"))
    paths.step_done(sid, t, choice="here")
    assert paths.continue_after_turn(_end(sid, t)) is True
    cwd = store.get_session(sid)["cwd"]
    assert cwd != main and _git(cwd, "rev-parse", "--abbrev-ref", "HEAD") == "feat/my-feature"
    assert _git(cwd, "log", "-1", "--format=%s") == "docs: decisions from the my-feature flow"
    assert _git(main, "rev-parse", "master") == master
    assert fake_queue.items[-1]["prompt"] == \
        f"/mattpocock-skills:implement Work in {cwd} on branch feat/my-feature, and commit there."


def test_an_auto_fix_on_the_default_branch_moves_to_a_fix_worktree(repo_session, fake_queue, nextstep_on):
    sid, main = repo_session
    master = _git(main, "rev-parse", "master")
    t = _turn(sid, "/mattpocock-skills:diagnosing-bugs the crash")
    _wrote(sid, t, os.path.join(main, "test_crash.py"))
    paths.step_done(sid, t)
    assert paths.continue_after_turn(_end(sid, t)) is True
    cwd = store.get_session(sid)["cwd"]
    assert cwd != main and _git(cwd, "rev-parse", "--abbrev-ref", "HEAD") == "fix/my-feature"
    assert os.path.isfile(os.path.join(cwd, "test_crash.py")) and _git(main, "rev-parse", "master") == master
    assert fake_queue.items[-1]["prompt"] == "/mattpocock-skills:tdd"


def test_an_auto_fix_off_the_default_branch_stays_put(repo_session, fake_queue, nextstep_on):
    sid, main = repo_session
    wt = os.path.join(os.path.dirname(main), "wt")
    _git(main, "worktree", "add", "-q", "-b", "feat/y", wt)
    store.set_cwd(sid, wt)
    t = _turn(sid, "/mattpocock-skills:diagnosing-bugs the crash")
    paths.step_done(sid, t)
    assert paths.continue_after_turn(_end(sid, t)) is True
    assert store.get_session(sid)["cwd"] == wt and fake_queue.items[-1]["prompt"] == "/mattpocock-skills:tdd"
