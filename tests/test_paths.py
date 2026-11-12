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
    cmd = runner._base_cmd("hi", 1, stream=True, interactive=True, claude_session_id="c2")
    assert "--plugin-dir" not in cmd                 # nobody there to walk a path either


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
    paths.set_path("s1", "build", "new feature", "claude")
    assert paths.step_done("s1", "t1") == "spec"


def test_choice_here_switches_to_feature_here(state_dir):
    paths.set_path("s1", "build", "small", "claude")
    assert paths.step_done("s1", "t1", choice="here") == "build-here"
    g = paths.get("s1")
    assert g["path"] == "build-here" and g["done"] == ["grill"]


def test_step_done_same_turn_twice_is_one_step(state_dir):
    paths.set_path("s1", "fix", "crash", "rule")            # PONYTAIL is on by default: REVIEW follows
    assert paths.step_done("s1", "t1") == "review" and paths.step_done("s1", "t1") == "review"
    assert paths.get("s1")["done"] == ["diagnose"]


def test_last_station_returns_none(state_dir):
    paths.set_path("s1", "build-here", "x", "rule")     # grill, build here, review, retro, audit
    for i in range(4):
        paths.step_done("s1", f"t{i}")
    assert paths.step_done("s1", "t9") is None
    assert paths.step_done("s1", "t9") is None
    assert paths.get("s1")["next"] is None and paths.get("s1")["done"][-1] == "audit"


def test_flows_survive_reload(state_dir):
    paths.set_path("s1", "fix", "crash", "rule")
    paths._cache.clear()
    g = paths.get("s1")
    assert g["path"] == "fix" and g["auto"] is True and g["at"] > 0
    paths.set_auto("s1", False)
    paths._cache.clear()
    assert paths.get("s1")["auto"] is False


def test_new_path_replaces_old(state_dir):
    paths.set_path("s1", "fix", "crash", "rule")
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
    assert paths.path_for_command("to-tickets") == ("build", "tickets")
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
    assert server.post("/local/flow/set", {"claude_session_id": "cf1", "path": "build", "why": "new"})["obj"] == \
        {"text": "Path recorded: build."}
    a = server.post("/local/flow/done", {"claude_session_id": "cf1"})
    b = server.post("/local/flow/done", {"claude_session_id": "cf1"})
    assert paths.get(flow_session)["next"]["station"] == "spec" and a == b
    assert a["obj"]["text"].startswith("Step done. Next: spec")


def test_step_done_without_a_path_changes_nothing(server, flow_session):
    r = server.post("/local/flow/done", {"claude_session_id": "cf1"})
    assert r["obj"] == {"text": "No path is running in this session."} and paths.get(flow_session) is None


def test_a_bad_path_is_told_to_claude(server, flow_session):
    # an HTTP error reaches Claude as "Could not reach the bridge"; the reason must get through
    assert server.post("/local/flow/set", {"claude_session_id": "cf1", "path": "nope", "why": "x"}) == \
        {"obj": {"text": "Path not recorded: unknown path 'nope'."}, "code": 200}
    assert server.post("/local/flow/set", {"claude_session_id": "cf1", "path": "one", "why": "x"})["obj"] == \
        {"text": "Path not recorded: path 'one' needs a skill."}
    assert paths.get(flow_session) is None


def test_a_full_skill_name_is_kept_short(state_dir):
    paths.set_path("s1", "one", "review", "claude", skill="mattpocock-skills:code-review")
    assert paths.get("s1")["skill"] == "code-review"


def test_auto_route(server, flow_session):
    paths.set_path(flow_session, "fix", "x", "claude")
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
    paths.set_path("f1", "build", "new", "claude")
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
    paths.set_path("f2", "build", "x", "claude")
    for t in ("a", "b", "c"):
        paths.step_done("f2", t)           # grill, spec, tickets done; build is next
    assert paths.continue_after_turn(_job("f2", "c")) is False and not fake_queue.items


def test_build_station_starts_tickets_when_on(fake_queue, state_dir, monkeypatch):
    from bridge import tickets
    calls = []
    monkeypatch.setattr(tickets, "start_build", lambda sid: calls.append(sid) or "")
    monkeypatch.setattr(aifeatures, "enabled", lambda key: key in ("router", "nextstep", "ticketruns"))
    paths.set_path("f5", "build", "x", "claude")
    for t in ("a", "b", "c"):
        paths.step_done("f5", t)           # build is next
    assert paths.continue_after_turn(_job("f5", "c")) is True and calls == ["f5"] and not fake_queue.items
    monkeypatch.setattr(tickets, "start_build", lambda sid: "cycle: #01 → #02 → #01")
    assert paths._start("f5", "build") is False  # noqa: SLF001


def test_mark_done_marks_once_and_starts_nothing(fake_queue, state_dir):
    paths.set_path("f6", "build", "x", "claude")
    paths.mark_done("f6", "build")
    paths.mark_done("f6", "build")
    assert paths.get("f6")["done"] == ["build"] and not fake_queue.items
    paths.mark_done("nopath", "build")
    assert paths.get("nopath") is None


def test_compact_first_past_150k(fake_queue, flow_job_with_next_at_160k):
    paths.continue_after_turn(flow_job_with_next_at_160k)
    assert fake_queue.items[0]["prompt"].startswith("/compact ")
    assert fake_queue.items[1]["prompt"] == "/mattpocock-skills:to-spec"


def test_the_smart_zone_starts_at_150k_as_in_route(fake_queue, flow_job_with_next_at_160k, monkeypatch):
    from bridge import route
    monkeypatch.setattr(store, "get_session", lambda sid: {"ctx_tokens": route.SMART_ZONE, "chat_id": 1})
    paths.continue_after_turn(flow_job_with_next_at_160k)
    assert fake_queue.items[0]["prompt"].startswith("/compact ")


def test_advance_from_merge_enqueues_retro(fake_queue, nextstep_on):
    paths.set_path("f3", "build", "x", "claude")
    for t in ("a", "b", "c", "d"):
        paths.step_done("f3", t)           # through build
    assert paths.advance("f3", "merge") is True
    assert fake_queue.items[-1]["prompt"] == "/mattpocock-skills:retro"


def test_typed_flow_command_joins_its_path(state_dir, router_on):
    paths.on_turn_start("s9", "/mattpocock-skills:diagnosing-bugs the crash")
    f = paths.get("s9")
    assert f["path"] == "fix" and f["by"] == "rule"
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
    paths.set_path(sess, "build", "new", "claude")
    paths.step_done(sess, "t0")                          # grill done; stuck at SPEC
    t = _turn(sess, "/mattpocock-skills:diagnosing-bugs the crash")
    assert paths.get(sess)["path"] == "fix" and paths.get(sess)["done"] == []
    assert paths.step_done(sess, t) == "retro"
    assert paths.continue_after_turn(_job(sess, t)) is True
    assert fake_queue.items[-1]["prompt"] == "/mattpocock-skills:retro"


def test_a_typed_to_spec_joins_feature_at_spec(sess, nextstep_on):
    _turn(sess, "/mattpocock-skills:to-spec")
    f = paths.get(sess)
    assert (f["path"], f["done"]) == ("build", ["grill"])
    assert paths.path_for_command("to-tickets") == ("build", "tickets")
    assert paths.path_for_command("improve-codebase-architecture") == ("refactor", "improve")
    assert paths.path_for_command("tdd") == paths.path_for_command("implement")[:1] + ("tdd",) == ("one", "tdd")


def test_a_typed_implement_starts_nothing_after_it(sess, fake_queue, nextstep_on):
    t = _turn(sess, "/mattpocock-skills:implement .mystical/tickets/x/01-a.md")
    assert (paths.get(sess)["path"], paths.get(sess)["skill"]) == ("one", "implement")
    assert paths.step_done(sess, t) is None
    assert paths.continue_after_turn(_job(sess, t)) is False and not fake_queue.items


def test_the_next_station_typed_keeps_the_path(sess, nextstep_on):
    paths.set_path(sess, "build", "new", "claude")
    paths.step_done(sess, "t0")
    before = paths.get(sess)
    _turn(sess, "/mattpocock-skills:to-spec")
    assert paths.get(sess) == before


def test_step_done_marks_the_station_its_turn_named(sess, nextstep_on):
    paths.set_path(sess, "build", "new", "claude")
    t = "t-spec"
    store.start_turn(sess, t, "/mattpocock-skills:to-spec", None)   # SKILL PATHS came on mid-turn: no join
    assert paths.step_done(sess, t) == "tickets"
    assert paths.get(sess)["done"] == ["grill", "spec"]


def test_wait_what_mid_grill_keeps_the_path(sess, nextstep_on):
    _turn(sess, "/mattpocock-skills:grill-with-docs add X")
    before = paths.get(sess)
    _turn(sess, "/mattpocock-skills:wait-what what?")      # route.py offers it inside any step
    assert paths.get(sess) == before


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
                        lambda src, dst, files, slug, msg="", ours=None: calls.append(("carry", src, dst, files, slug)) or True)
    paths.set_path("b1", "build-here", "new", "claude")
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
    def boom(*a, **k):
        raise flowbranch.FlowBranchError("pop conflict")
    monkeypatch.setattr(flowbranch, "carry_and_commit", boom)
    monkeypatch.setattr(runner, "_notify", lambda chat, text, *a, **k: sent.append((chat, text)))
    paths.set_path("b2", "build-here", "new", "claude")
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
    assert paths.step_done(sess, n2) == "retro" and paths.get(sess)["done"] == ["diagnose"]   # a repeat moves nothing
    job = _end(sess, n2)
    assert paths.continue_after_turn(job) is True
    assert [i["prompt"] for i in fake_queue.items] == ["/mattpocock-skills:retro"]
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
    assert [i["prompt"] for i in fake_queue.items] == ["/mattpocock-skills:retro"]
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
                 r.TIMEOUT_NUDGE, r.ECHO_NUDGE, r.AUTH_NUDGE, r.AGENT_AUTH_NUDGE, ladder.ACCOUNT_NUDGE):
        assert text.startswith(paths._RESUME), text   # noqa: SLF001


def test_merge_is_done_even_while_auto_is_held(fake_queue, nextstep_on, state_dir):
    paths.set_path("f7", "build", "x", "claude")
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


# --- the FLOW chip: REVIEW and AUDIT steps, per-session overrides, skipping ----------
# (.mystical/design-drafts/flow-chip/SPEC.md; the chip is Composer's, the overrides are flows.json's)

import json  # noqa: E402


@pytest.fixture
def pony_on(monkeypatch):
    monkeypatch.setattr(aifeatures, "enabled", lambda key: key in ("router", "nextstep", "ponytail"))


def _stations(sid):
    return [s[0] for s in paths.get(sid)["stations"]]


def test_review_and_audit_join_the_paths_while_ponytail_is_on(state_dir, pony_on):
    for path, want in (("build-here", "grill build-here review retro audit"),
                       ("fix", "diagnose review retro"),
                       ("build", "grill spec tickets build merge retro audit"),
                       ("refactor", "improve tickets build merge retro audit")):
        paths.set_path("s1", path, "x", "rule")
        assert " ".join(_stations("s1")) == want, path


def test_no_review_or_audit_while_ponytail_is_off(state_dir, nextstep_on):
    paths.set_path("s1", "build-here", "x", "rule")
    assert _stations("s1") == ["grill", "build-here", "retro"]
    paths.set_path("s1", "fix", "x", "rule")
    assert paths.step_done("s1", "t1") == "retro"


def test_review_runs_as_the_ponytail_command_and_ends_by_itself(sess, fake_queue, pony_on):
    t = _turn(sess, "/mattpocock-skills:diagnosing-bugs the crash")
    assert paths.step_done(sess, t) == "review"
    assert paths.continue_after_turn(_end(sess, t)) is True
    assert fake_queue.items[-1]["prompt"].startswith("/ponytail-review ")
    r = _turn(sess, fake_queue.items[-1]["prompt"])     # its turn never calls StepDone
    assert paths.get(sess)["path"] == "fix"              # a /ponytail- command keeps the path
    assert paths.continue_after_turn(_end(sess, r)) is True
    assert paths.get(sess)["done"] == ["diagnose", "review"]
    assert fake_queue.items[-1]["prompt"] == "/mattpocock-skills:retro"


def test_a_review_that_calls_step_done_moves_once(sess, fake_queue, pony_on):
    paths.set_path(sess, "fix", "x", "rule", done=["diagnose"])
    r = _turn(sess, "/ponytail-review the work on this path")
    assert paths.step_done(sess, r) == "retro"
    assert paths.continue_after_turn(_end(sess, r)) is True
    assert paths.get(sess)["done"] == ["diagnose", "review"] and len(fake_queue.items) == 1


def test_a_typed_review_off_its_step_marks_nothing(sess, fake_queue, pony_on):
    paths.set_path(sess, "build-here", "x", "rule")          # GRILL is the step
    r = _turn(sess, "/ponytail-review")
    assert paths.continue_after_turn(_end(sess, r)) is False
    assert paths.get(sess)["done"] == []


def test_audit_runs_last(sess, fake_queue, pony_on):
    paths.set_path(sess, "build-here", "x", "rule", done=["grill", "build-here", "review"])
    t = _turn(sess, "/mattpocock-skills:retro")
    assert paths.step_done(sess, t) == "audit"
    paths.continue_after_turn(_end(sess, t))
    assert fake_queue.items[-1]["prompt"] == "/ponytail-audit"
    a = _turn(sess, "/ponytail-audit")
    assert paths.continue_after_turn(_end(sess, a)) is False   # the last step: nothing after it
    assert paths.get(sess)["done"][-1] == "audit" and paths.get(sess)["next"] is None


def test_a_session_override_wins_over_the_switch(sess, fake_queue, monkeypatch):
    monkeypatch.setattr(aifeatures, "enabled", lambda key: key == "router")   # AUTO NEXT STEPS off
    t = _turn(sess, "/mattpocock-skills:diagnosing-bugs the crash")
    paths.step_done(sess, t)
    assert paths.get(sess)["auto"] is False and paths.get(sess)["overrides"] == {}
    paths.set_option(sess, "nextstep", True)                                # this session only
    assert paths.get(sess)["auto"] is True and paths.get(sess)["overrides"] == {"nextstep": True}
    assert paths.continue_after_turn(_end(sess, t)) is True


def test_reset_follows_settings_again(sess, nextstep_on):
    paths.set_path(sess, "fix", "x", "rule")
    paths.set_option(sess, "autopick", False)
    paths.set_option(sess, "smartzone", False)
    paths.set_auto(sess, False)
    assert paths.get(sess)["overrides"] == {"autopick": False, "smartzone": False, "nextstep": False}
    paths.set_option(sess, "smartzone", None)
    assert paths.get(sess)["overrides"] == {"autopick": False, "nextstep": False}
    paths.reset(sess)
    assert paths.get(sess)["overrides"] == {} and paths.get(sess)["auto"] is True


def test_only_the_three_switches_can_be_set_here(sess, nextstep_on):
    paths.set_path(sess, "fix", "x", "rule")
    with pytest.raises(ValueError):
        paths.set_option(sess, "ponytail", True)


def test_overrides_outlive_a_new_path(sess, nextstep_on):
    paths.set_path(sess, "fix", "x", "rule")
    paths.set_auto(sess, False)
    paths.set_path(sess, "build", "y", "claude")
    assert paths.get(sess)["overrides"] == {"nextstep": False} and paths.get(sess)["auto"] is False


def test_a_flow_held_before_overrides_stays_held(state_dir, nextstep_on):
    old = {"path": "fix", "skill": None, "by": "rule", "why": "x", "at": 1, "done": [], "next": None, "last": None}
    with open(paths._file(), "w") as f:   # noqa: SLF001
        json.dump({"a": dict(old, auto=True), "b": dict(old, auto=False)}, f)
    paths._cache.clear()
    assert paths.get("a")["overrides"] == {} and paths.get("a")["auto"] is True
    assert paths.get("b")["overrides"] == {"nextstep": False} and paths.get("b")["auto"] is False


def test_a_smart_zone_override_skips_the_compact(fake_queue, flow_job_with_next_at_160k):
    paths.set_option("f1", "smartzone", False)
    paths.continue_after_turn(flow_job_with_next_at_160k)
    assert [i["prompt"] for i in fake_queue.items] == ["/mattpocock-skills:to-spec"]


def test_skip_to_marks_the_steps_between_skipped_and_starts_the_target(sess, fake_queue, pony_on):
    paths.set_path(sess, "build-here", "x", "rule", done=["grill", "build-here"])
    assert paths.skip_to(sess, "retro") == ""
    f = paths.get(sess)
    assert f["done"] == ["grill", "build-here", "review"] and f["skipped"] == ["review"]
    assert [i["prompt"] for i in fake_queue.items] == ["/mattpocock-skills:retro"]


def test_skip_to_the_end_completes_the_path(sess, fake_queue, pony_on):
    paths.set_path(sess, "build-here", "x", "rule", done=["grill", "build-here", "review", "retro"])
    assert paths.skip_to(sess, "") == ""
    f = paths.get(sess)
    assert f["next"] is None and f["skipped"] == ["audit"] and not fake_queue.items


def test_a_skip_while_held_waits_for_the_release(sess, fake_queue, pony_on):
    paths.set_path(sess, "fix", "x", "rule", done=["diagnose"])
    paths.set_auto(sess, False)
    assert paths.skip_to(sess, "retro") == ""
    assert paths.get(sess)["next"]["station"] == "retro" and not fake_queue.items
    paths.set_auto(sess, True)
    assert [i["prompt"] for i in fake_queue.items] == ["/mattpocock-skills:retro"]


def test_a_skip_mid_turn_spares_the_running_step_and_waits_for_its_end(sess, fake_queue, pony_on):
    paths.set_path(sess, "build-here", "x", "rule", done=["grill"])
    t = _turn(sess, "/mattpocock-skills:implement the thing")      # BUILD HERE runs
    assert paths.skip_to(sess, "retro") == ""
    assert paths.get(sess)["skipped"] == ["review"] and not fake_queue.items
    assert paths.step_done(sess, t) == "retro"
    assert paths.continue_after_turn(_end(sess, t)) is True
    assert [i["prompt"] for i in fake_queue.items] == ["/mattpocock-skills:retro"]


def test_a_skip_to_a_done_or_unknown_step_is_refused(sess, pony_on):
    paths.set_path(sess, "fix", "x", "rule", done=["diagnose"])
    assert paths.skip_to(sess, "diagnose") and paths.skip_to(sess, "nope")
    assert paths.skip_to("nopath", "") and paths.get(sess)["skipped"] == []


def test_settings_and_step_routes(server, flow_session, monkeypatch):
    monkeypatch.setattr(aifeatures, "enabled", lambda key: key in ("router", "ponytail"))
    paths.set_path(flow_session, "fix", "x", "claude")
    r = server.post("/local/flow/settings", {"session": flow_session, "key": "autopick", "on": False})
    assert r["code"] == 200 and r["obj"]["flow"]["overrides"] == {"autopick": False}
    assert server.post("/local/flow/settings", {"session": flow_session, "reset": True})["obj"]["flow"]["overrides"] == {}
    assert server.post("/local/flow/settings", {"session": flow_session, "key": "ponytail", "on": True})["code"] == 400
    assert server.post("/local/flow/settings", {"session": "zzz", "reset": True})["code"] == 404
    r = server.post("/local/flow/step", {"session": flow_session, "to": "retro"})   # DIAGNOSE's turn runs
    assert r["code"] == 200 and r["obj"]["flow"]["skipped"] == ["review"]
    assert server.post("/local/flow/step", {"session": flow_session, "to": "nope"})["code"] == 400
    assert server.post("/local/flow/step", {"session": "zzz", "to": ""})["code"] == 404


def test_route_reads_the_session_overrides(server, flow_session, monkeypatch):
    from bridge import commands, route
    seen = {}
    monkeypatch.setattr(route, "pick", lambda text, **kw: seen.update(kw) or None)
    monkeypatch.setattr(commands, "available", lambda root: [])
    monkeypatch.setattr(aifeatures, "enabled", lambda key: key in ("router", "autopick", "smartzone"))
    paths.set_path(flow_session, "fix", "x", "claude")
    paths.set_option(flow_session, "autopick", False)
    server.post("/local/route", {"session": flow_session, "text": "", "prompts": []})
    assert seen["off"] == frozenset({"autopick"})
    paths.reset(flow_session)
    paths.set_option(flow_session, "smartzone", False)
    server.post("/local/route", {"session": flow_session, "text": "", "prompts": []})
    assert seen["off"] == frozenset({"smartzone"})


def test_route_hears_the_pending_step(server, flow_session, monkeypatch):
    from bridge import commands, route
    seen = {}
    monkeypatch.setattr(route, "pick", lambda text, **kw: seen.update(kw) or None)
    monkeypatch.setattr(commands, "available", lambda root: [])
    monkeypatch.setattr(aifeatures, "enabled", lambda key: key in ("router", "ponytail"))
    paths.set_path(flow_session, "fix", "x", "claude")
    paths.step_done(flow_session, "t-" + flow_session)                  # DIAGNOSE done: REVIEW waits
    server.post("/local/route", {"session": flow_session, "text": "", "prompts": []})
    assert seen["flow_next"] == ("ponytail-review", paths._PONY["review"])   # noqa: SLF001


# --- REVIEW after MERGE -----------------------------------------------------------

_BUILT = ["grill", "spec", "tickets", "build"]


def _steps(sid):
    return [st[0] for st in paths.stations(sid)]


def _switches(monkeypatch, *on):
    monkeypatch.setattr(aifeatures, "enabled", lambda key: key in on)


@pytest.mark.parametrize("path, before", [("build", ["grill", "spec", "tickets", "build"]),
                                          ("refactor", ["improve", "tickets", "build"])])
def test_review_follows_merge_only_with_tickets_and_its_own_switch_on(state_dir, monkeypatch, path, before):
    paths.set_path("f1", path, "new", "claude")
    _switches(monkeypatch, "router", "ticketruns", "mergereview")
    assert _steps("f1") == before + ["merge", "review", "retro"]
    for on in (("router", "ticketruns"), ("router", "mergereview")):    # its own switch off, then TICKETS off
        _switches(monkeypatch, *on)
        assert _steps("f1") == before + ["merge", "retro"], on


def test_the_paths_that_merge_nothing_have_no_review(state_dir, monkeypatch):
    _switches(monkeypatch, "router", "ticketruns", "mergereview")
    paths.set_path("h", "build-here", "new", "claude")
    paths.set_path("b", "fix", "broken", "claude")
    assert _steps("h") == ["grill", "build-here", "retro"] and _steps("b") == ["diagnose", "retro"]


def test_merge_ending_settles_whether_review_follows(state_dir, monkeypatch):
    """The switches say until MERGE ends, and what the flow recorded says after: a flow
    past MERGE from before the step, or with it off, never grows one, and one that
    reached REVIEW keeps it when the switch goes off."""
    _switches(monkeypatch, "router", "ticketruns", "mergereview")
    paths.set_path("old", "build", "x", "claude", done=_BUILT + ["merge"])     # MERGE ended before the step existed
    assert _steps("old")[-2:] == ["merge", "retro"]
    paths.set_path("new", "build", "x", "claude", done=_BUILT)
    assert paths.advance("new", "merge") is False                                 # AUTO NEXT STEPS is off: nothing starts
    assert paths.get("new")["next"]["station"] == "review"
    _switches(monkeypatch, "router", "ticketruns")
    assert _steps("new")[-3:] == ["merge", "review", "retro"]                     # reached: it stays
    paths.set_path("off", "build", "x", "claude", done=_BUILT)
    paths.advance("off", "merge")
    assert paths.get("off")["next"]["station"] == "retro" and "review" not in _steps("off")
    _switches(monkeypatch, "router", "ticketruns", "mergereview")
    assert "review" not in _steps("off")                                          # passed over: it stays out


def test_review_done_goes_on_to_retro(state_dir, fake_queue, monkeypatch):
    _switches(monkeypatch, "router", "nextstep", "ticketruns", "mergereview")
    paths.set_path("f1", "build", "x", "claude", done=_BUILT + ["merge"])
    paths._cache["f1"]["next"] = {"station": "review", "turn_id": "", "started": True}
    assert paths.advance("f1", "review") is True
    assert [i["prompt"] for i in fake_queue.items] == ["/mattpocock-skills:retro"]
    assert paths.get("f1")["done"][-2:] == ["merge", "review"]



def test_step_done_in_the_flow_session_takes_a_waiting_review_as_done(state_dir, monkeypatch):
    """The way on when the council stopped and you accept the work as it is: tell the
    flow's session to go on, and its StepDone ends REVIEW."""
    _switches(monkeypatch, "router", "nextstep", "ticketruns", "mergereview")
    paths.set_path("f1", "build", "x", "claude", done=_BUILT + ["merge"])
    paths._cache["f1"]["next"] = {"station": "review", "turn_id": "", "started": True}
    assert paths.step_done("f1", "t-go-on") == "retro"
    assert paths.get("f1")["done"][-2:] == ["merge", "review"]


# --- the six flows (flow-gear #01) ------------------------------------------

def test_the_steps_table_says_which_steps_always_run():
    fixed = {p: [st.station for st in sts if st.fixed] for p, sts in paths.PATHS.items()}
    assert fixed == {"design": ["design"], "design-here": ["design"],
                     "build": ["spec", "tickets", "build", "merge"], "build-here": ["build-here"],
                     "refactor": ["improve", "tickets", "build", "merge"], "fix": ["diagnose"],
                     "ship": ["ship"], "ask": ["answer"]}
    own = {st.station for sts in paths.PATHS.values() for st in sts if st.own}
    assert own == {"build", "merge"} and set(paths.FLOWS) == {p.split("-")[0] for p in paths.PATHS}


@pytest.mark.parametrize("choice, path, then", [(None, "design", "spec"), ("tickets", "design", "spec"),
                                                ("here", "design-here", "build-here")])
def test_design_goes_grill_design_build(router_on, nextstep_on, fake_queue, state_dir, choice, path, then):
    paths.set_path("d1", "design", "a new screen", "claude")
    assert paths.step_done("d1", "t1", choice=choice) == "design"
    assert paths.continue_after_turn(_job("d1", "t1")) is True
    assert fake_queue.items[-1]["prompt"] == paths.DESIGN_TEXT       # /design-first, told not to build
    assert paths.step_done("d1", "t2") == then                       # Approve: StepDone starts the build
    assert paths.get("d1")["path"] == path and paths.get("d1")["done"] == ["grill", "design"]
    if then == "spec":
        assert paths.continue_after_turn(_job("d1", "t2")) is True
        assert fake_queue.items[-1]["prompt"] == "/mattpocock-skills:to-spec"


def test_design_runs_grill_design_build_review_retro(state_dir):
    paths.set_path("d1", "design-here", "x", "rule")
    assert _stations("d1") == ["grill", "design", "build-here", "review", "retro"]


@pytest.mark.parametrize("flow, step", [("ship", "ship"), ("ask", "answer")])
def test_a_one_step_flow_ends_at_its_turns_clean_end(state_dir, nextstep_on, fake_queue, flow, step):
    paths.set_path("o1", flow, "you picked it", "rule")
    failed, stopped = _job("o1", "t1"), _job("o1", "t2")
    failed.status, stopped.interrupted = "error", True
    assert paths.continue_after_turn(failed) is False and paths.continue_after_turn(stopped) is False
    assert paths.get("o1")["done"] == []                               # a stopped or failed turn leaves it open
    paths.continue_after_turn(_job("o1", "t3"))
    f = paths.get("o1")
    assert f["done"] == [step] and f["next"] is None and not fake_queue.items


def test_old_records_carry_on_under_the_new_names(state_dir):
    old = {"skill": None, "by": "rule", "why": "x", "at": 1, "skipped": [], "last": "t1",
           "overrides": {"nextstep": False}}
    recs = {"a": dict(old, path="feature", done=["grill"], next={"station": "spec", "turn_id": "t1", "started": False}),
            "b": dict(old, path="feature-here", done=["grill"], next={"station": "build-here", "turn_id": "t1"}),
            "c": dict(old, path="bug", done=["diagnose"], next={"station": "review", "turn_id": "t1"}),
            "d": dict(old, path="refactor", done=[], next=None)}
    with open(paths._file(), "w") as f:   # noqa: SLF001
        json.dump(recs, f)
    paths._cache.clear()
    got = {k: paths.get(k) for k in recs}
    assert {k: g["path"] for k, g in got.items()} == {"a": "build", "b": "build-here", "c": "fix", "d": "refactor"}
    assert all(got[k]["done"] == recs[k]["done"] and got[k]["next"] == recs[k]["next"]
               and got[k]["overrides"] == {"nextstep": False} for k in recs)
    assert paths.step_done("a", "t2") == "tickets"                     # and it carries on


def test_set_path_takes_the_old_names(state_dir, server, flow_session):
    assert paths.set_path("s1", "feature-here", "x", "rule")["path"] == "build-here"
    assert server.post("/local/flow/set", {"claude_session_id": "cf1", "path": "bug", "why": "x"})["obj"] == \
        {"text": "Path recorded: fix."}


def test_set_path_and_the_routing_text_name_the_new_flows():
    from bridge import goal_mcp
    enum = next(t for t in goal_mcp._PATH_TOOLS if t["name"] == "SetPath")["inputSchema"]["properties"]["path"]["enum"]
    assert enum == ["design", "build", "refactor", "fix", "one"]
    for name in ("design", "build", "fix", "refactor"):
        assert f"\n- {name}: " in paths.PACK_TEXT
    assert "feature:" not in paths.PACK_TEXT and "bug:" not in paths.PACK_TEXT


# --- ticket 02: the flow a send names starts at its turn ----------------------

def test_a_tapped_build_records_it_and_puts_the_grill_in_front(sess, router_on):
    assert paths.start_flow(sess, "build", "you", "add a digest") == "/mattpocock-skills:grill-with-docs add a digest"
    f = paths.get(sess)
    assert (f["path"], f["by"], f["why"]) == ("build", "you", "you picked BUILD")


def test_a_guess_says_the_box_guessed(sess, router_on):
    paths.start_flow(sess, "fix", "guess", "the list jumps")
    assert (paths.get(sess)["by"], paths.get(sess)["why"]) == ("guess", "the box guessed FIX")


@pytest.mark.parametrize("flow, skill", [("design", "grill-with-docs"), ("refactor", "improve-codebase-architecture"),
                                         ("fix", "diagnosing-bugs")])
def test_each_flow_starts_with_its_first_step(sess, router_on, flow, skill):
    assert paths.start_flow(sess, flow, "you", "x y") == f"/mattpocock-skills:{skill} x y"
    t = _turn(sess, f"/mattpocock-skills:{skill} x y")     # the turn joins the recorded flow, not a new one
    assert paths.get(sess)["path"] == flow and paths.get(sess)["by"] == "you"
    assert paths.step_done(sess, t) is not None


@pytest.mark.parametrize("flow, step", [("ship", "ship"), ("ask", "answer")])
def test_ship_and_ask_go_behind_the_no_path_line_and_end_with_the_turn(sess, nextstep_on, fake_queue, flow, step):
    prompt = paths.start_flow(sess, flow, "you", "merge this")
    assert prompt == paths.NO_PATH + "merge this"
    t = _turn(sess, prompt)
    assert paths.get(sess)["path"] == flow
    paths.continue_after_turn(_job(sess, t))
    assert paths.get(sess)["done"] == [step] and not fake_queue.items


def test_another_flow_replaces_the_running_one_the_same_keeps_it(sess, nextstep_on):
    paths.start_flow(sess, "build", "you", "add a digest")
    paths.step_done(sess, _turn(sess, "/mattpocock-skills:grill-with-docs add a digest"))
    before = paths.get(sess)
    assert paths.start_flow(sess, "build", "guess", "and the footer") == "and the footer"
    assert paths.get(sess) == before                               # nothing recorded
    assert paths.start_flow(sess, "fix", "you", "it crashes") == "/mattpocock-skills:diagnosing-bugs it crashes"
    f = paths.get(sess)
    assert (f["path"], f["done"], f["by"]) == ("fix", [], "you")


def test_a_finished_flow_tapped_again_starts_over(sess, nextstep_on, fake_queue):
    paths.start_flow(sess, "ask", "you", "why")
    paths.continue_after_turn(_job(sess, _turn(sess, paths.NO_PATH + "why")))
    assert paths.start_flow(sess, "ask", "you", "and how") == paths.NO_PATH + "and how"
    assert paths.get(sess)["done"] == []


def test_a_replaced_flows_ticket_set_no_longer_moves_it(sess, nextstep_on, fake_queue):
    paths.start_flow(sess, "build", "you", "big thing")
    at = paths.get(sess)["at"]                                     # what the set keeps as flow_at
    paths.start_flow(sess, "fix", "you", "it crashes")             # the same second: `at` still moves
    assert paths.get(sess)["at"] != at
    paths.mark_done(sess, "build", at)
    assert paths.advance(sess, "merge", at) is False and paths.get(sess)["done"] == []


def _send(monkeypatch, body, agent="claude"):
    """POST /local/run with the run faked: (answer, code, the run's kwargs or None)."""
    from bridge import profiles, relevance
    from bridge.dashboard import server as dash
    seen, box = [], {}
    monkeypatch.setattr(runner, "start_streaming_job",
                        lambda chat, prompt, *a, **kw: seen.append(dict(kw, prompt=prompt))
                        or SimpleNamespace(id="j", store_session_id=SID))
    monkeypatch.setattr(relevance, "gate", lambda *a, **k: None)
    monkeypatch.setattr(profiles, "agent_for", lambda *a, **k: agent)
    h = dash.Handler.__new__(dash.Handler)
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)   # noqa: SLF001
    h._run(555, {"session_id": SID, **body})
    return box["obj"], box["code"], (seen[0] if seen else None)


def test_a_send_carries_its_flow_to_the_run(monkeypatch, router_on):
    _obj, code, run = _send(monkeypatch, {"prompt": "add a digest", "flow": "build", "by": "you"})
    assert code == 200 and (run["flow"], run["flow_by"], run["prompt"]) == ("build", "you", "add a digest")
    _obj, _code, run = _send(monkeypatch, {"prompt": "add a digest"})
    assert run["flow"] is None


@pytest.mark.parametrize("body, agent, why", [
    ({"prompt": "add it", "flow": "nope", "by": "you"}, "claude", "unknown flow"),
    ({"prompt": "add it", "flow": "build", "by": "someone"}, "claude", "by"),
    ({"prompt": "/compact add it", "flow": "build", "by": "you"}, "claude", "/"),
    ({"prompt": "add it", "flow": "build", "by": "you"}, "kimi", "Claude"),
])
def test_the_bridge_refuses_a_flow_it_cant_take(monkeypatch, router_on, body, agent, why):
    obj, code, run = _send(monkeypatch, body, agent)
    assert code == 400 and why in obj["error"] and run is None


def test_no_flow_while_skill_paths_is_off(monkeypatch, router_off):
    obj, code, run = _send(monkeypatch, {"prompt": "add it", "flow": "build", "by": "you"})
    assert code == 400 and "FLOWS is off" in obj["error"] and run is None


def test_a_queued_prompt_keeps_its_flow_until_it_runs(monkeypatch, router_on):
    from bridge import queue_manager
    from bridge.dashboard import server as dash
    got, box = [], {}
    monkeypatch.setattr(queue_manager, "enqueue", lambda sid, **kw: got.append(kw) or "q1")
    monkeypatch.setattr(queue_manager, "snapshot", lambda sid: {})
    h = dash.Handler.__new__(dash.Handler)
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)   # noqa: SLF001
    h._queue("enqueue", 1, {"session_id": SID, "text": "add it", "flow": "fix", "by": "guess"})
    assert (got[0]["flow"], got[0]["flow_by"]) == ("fix", "guess")
    h._queue("enqueue", 1, {"session_id": SID, "text": "add it", "flow": "nope", "by": "guess"})
    assert box["code"] == 400 and len(got) == 1
    runs = []
    monkeypatch.setattr(runner, "start_streaming_job", lambda **kw: runs.append(kw))
    item = queue_manager.QueueItem(id="q", session_id=SID, chat_id=1, project=None, text="a", prompt="a", images=[],
                                   model=None, effort=None, permission_mode=None, width=0, sel=[], surface="dashboard",
                                   flow="fix", flow_by="guess")
    queue_manager._default_run_fn(item)                           # noqa: SLF001
    assert (runs[0]["flow"], runs[0]["flow_by"]) == ("fix", "guess")


def test_a_queued_flow_goes_as_typed_once_skill_paths_is_off(sess, router_off):
    assert paths.start_flow(sess, "build", "you", "add it") == "add it" and paths.get(sess) is None


def test_a_flow_wins_over_the_no_path_flag(monkeypatch, router_on):
    _obj, _code, run = _send(monkeypatch, {"prompt": "add it", "flow": "build", "by": "you", "no_path": True})
    assert run["prompt"] == "add it"


def test_a_turn_sent_with_a_flow_starts_it(state_dir, router_on, monkeypatch):
    """The runner's half: start_streaming_job records the flow and runs the grill's command."""
    from bridge import state, titler
    seen = {}
    monkeypatch.setattr(runner, "_jobs", {})
    monkeypatch.setattr(titler, "kick", lambda *a, **k: None)
    monkeypatch.setattr(runner, "_run_streaming", lambda job, prompt, *a: seen.update(prompt=prompt))
    s = store.create_session(555, "/flow-run", cwd=config.BASE_PATH)
    job = runner.start_streaming_job(555, "add a digest", [], project=config.BASE_PATH, session_id=s["id"],
                                     flow="build", flow_by="you")
    state.release_run(job.store_session_id)
    assert seen["prompt"].startswith("/mattpocock-skills:grill-with-docs add a digest")
    assert store.turn_prompt(job.id) == "/mattpocock-skills:grill-with-docs add a digest"
    assert (paths.get(s["id"])["path"], paths.get(s["id"])["by"]) == ("build", "you")
