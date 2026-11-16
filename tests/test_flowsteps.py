"""flow-gear #04: each flow's optional STEPS switch on and off. A step switched off is left
out of the steps a flow will run (FLOW, SESSION ▸ FLOW, GET /local/flow), passed over by
flows already running from their next step, and the step underway still finishes.
Run: python -m pytest tests/test_flowsteps.py -v"""

import os

import pytest

from bridge import aifeatures, flowsettings, paths, store
from test_paths import _end, _git, _job, _turn, _turn_end, fake_queue, repo_session, sess, state_dir  # noqa: F401 — fixtures

store.init()


@pytest.fixture(autouse=True)
def settings(monkeypatch, state_dir):  # noqa: F811
    """Every step on until a test switches one off (conftest gives each test its own file)."""
    monkeypatch.setattr(aifeatures, "enabled", lambda key: key in ("router", "nextstep", "ponytail",
                                                                   "ticketruns", "mergereview"))


def _off(flow, *steps, on=False):
    for st in steps:
        flowsettings.change({"flow": flow, "key": "step", "step": st, "value": on})


def _steps(sid):
    return [st[0] for st in paths.get(sid)["stations"]]


def test_a_fixed_step_cant_be_switched_off():
    for flow, st in (("build", "build"), ("design", "design"), ("refactor", "improve"), ("fix", "diagnose")):
        with pytest.raises(ValueError, match="always runs"):
            _off(flow, st)


def test_a_switched_off_step_is_left_out_of_the_flow_and_its_route(sess, monkeypatch):  # noqa: F811
    _off("build", "retro")
    paths.set_path(sess, "build-here", "x", "rule")
    assert _steps(sess) == ["grill", "build-here", "review", "audit"]
    from bridge.dashboard import server as dash
    box = {}
    monkeypatch.setattr(dash, "_chat", lambda: 1)
    h = dash.Handler.__new__(dash.Handler)
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)   # noqa: SLF001
    h._get_api("/local/flow", {"session": [sess]})                   # noqa: SLF001
    assert "retro" not in [st[0] for st in box["obj"]["flow"]["stations"]]
    _off("build", "retro", on=True)
    assert "retro" in _steps(sess)                                    # read every time, never stored


def test_a_step_switched_off_while_held_is_passed_over(sess, fake_queue):  # noqa: F811
    paths.set_path(sess, "build-here", "x", "rule")
    paths.set_auto(sess, False)                                       # NEXT held: REVIEW waits
    paths.step_done(sess, "t1")
    paths.step_done(sess, "t2")
    assert paths.get(sess)["next"]["station"] == "review"
    _off("build", "review")
    assert paths.get(sess)["next"]["station"] == "retro"
    paths.set_auto(sess, True)
    assert fake_queue.items[-1]["prompt"] == "/mattpocock-skills:retro"
    assert paths.get(sess)["done"] == ["grill", "build-here"]         # REVIEW never ran


def test_the_step_underway_finishes_when_its_chip_goes_off(sess, fake_queue):  # noqa: F811
    t = _turn(sess, "/mattpocock-skills:diagnosing-bugs the crash")
    assert paths.step_done(sess, t) == "review"
    paths.continue_after_turn(_end(sess, t))
    r = _turn(sess, fake_queue.items[-1]["prompt"])                   # /ponytail-review runs
    _off("fix", "review")                                             # switched off mid-turn
    assert _turn_end(_end(sess, r)) is True
    assert paths.get(sess)["done"] == ["diagnose", "review"]
    assert fake_queue.items[-1]["prompt"] == "/mattpocock-skills:retro"


def test_a_step_done_mid_turn_names_the_step_underway(sess, fake_queue):  # noqa: F811
    paths.set_path(sess, "build-here", "x", "rule")
    paths.step_done(sess, "t1")
    paths.continue_after_turn(_end(sess, _turn(sess, "go on")))       # nothing recorded by this turn
    paths._cache[sess]["next"] = {"station": "build-here", "turn_id": "", "started": True}   # the build runs
    _off("build", "retro")
    assert paths.step_done(sess, "t3") == "review"                   # the build finished, though its RETRO went off
    _off("build", "review")
    assert paths.get(sess)["next"]["station"] == "audit"              # REVIEW and RETRO passed over


def test_build_with_its_grill_off_builds_here_on_its_own_branch(repo_session, monkeypatch):  # noqa: F811
    sid, main = repo_session
    master = _git(main, "rev-parse", "master")
    _off("build", "grill")
    prompt = paths.start_flow(sid, "build", "you", "add a digest")
    cwd = store.get_session(sid)["cwd"]
    assert cwd != main and _git(cwd, "rev-parse", "--abbrev-ref", "HEAD") == "feat/my-feature"
    assert _git(main, "rev-parse", "master") == master and _git(main, "rev-parse", "--abbrev-ref", "HEAD") == "master"
    assert prompt == f"/mattpocock-skills:implement Work in {cwd} on branch feat/my-feature, and commit there. add a digest"
    f = paths.get(sid)
    assert (f["path"], f["by"], f["why"]) == ("build-here", "you", "you picked BUILD")
    assert _steps(sid)[0] == "build-here"
    t = _turn(sid, prompt)                                            # the turn keeps the flow
    assert paths.get(sid)["path"] == "build-here" and paths.step_done(sid, t) == "review"


def test_a_build_in_a_session_too_new_for_a_title_is_named_after_its_prompt(repo_session):  # noqa: F811
    sid, _main = repo_session
    store.rename(sid, "")                                             # its first turn hasn't named it yet
    _off("build", "grill")
    paths.start_flow(sid, "build", "you", "add a digest of the week")
    assert _git(store.get_session(sid)["cwd"], "rev-parse", "--abbrev-ref", "HEAD") == "feat/add-a-digest-of-the-week"


def test_a_build_that_cant_branch_off_changes_nothing_and_waits(sess, monkeypatch):  # noqa: F811
    monkeypatch.setattr(paths, "_branch_off", lambda *a: None)
    _off("build", "grill")
    assert paths.start_flow(sess, "build", "you", "add it") == paths.NO_PATH + paths.NO_BRANCH + "add it"
    assert paths.get(sess)["next"] == {"station": "build-here", "turn_id": "", "started": False}


def test_a_build_with_its_grill_off_runs_in_its_branch(repo_session, monkeypatch):  # noqa: F811
    """The runner's half: the turn runs in the checkout the flow moved to."""
    from bridge import config, runner, state, titler
    sid, main = repo_session
    _off("build", "grill")
    seen = {}
    monkeypatch.setattr(runner, "_jobs", {})
    monkeypatch.setattr(titler, "kick", lambda *a, **k: None)
    monkeypatch.setattr(runner, "_run_streaming", lambda job, prompt, imgs, cwd, *a: seen.update(cwd=cwd))
    job = runner.start_streaming_job(1, "add a digest", [], project=main, session_id=sid, flow="build", flow_by="you")
    state.release_run(job.store_session_id)
    assert seen["cwd"] == store.get_session(sid)["cwd"] != main and config


def test_design_with_its_grill_off_starts_at_design(sess):  # noqa: F811
    _off("design", "grill")
    prompt = paths.start_flow(sess, "design", "guess", "a calmer header")
    assert prompt == f"/design-first a calmer header\n\n{paths.DESIGN_STEP}"
    assert _steps(sess)[0] == "design" and paths.get(sess)["path"] == "design-here"
    assert paths.step_done(sess, "t1") == "build-here"                # Approve: the build follows


def test_design_with_its_build_off_ends_at_the_approved_design(sess, fake_queue):  # noqa: F811
    _off("design", "build", "retro")
    paths.set_path(sess, "design", "x", "you")
    assert _steps(sess) == ["grill", "design"]                        # and its review is passed over
    assert paths.step_done(sess, "t1", choice="here") == "design"
    assert paths.step_done(sess, "t2") is None and paths.get(sess)["next"] is None
    _off("design", "retro", on=True)
    paths.set_path(sess, "design", "x", "you")
    paths.step_done(sess, "t3")
    assert paths.step_done(sess, "t4") == "retro"


def test_review_off_leaves_out_every_review(sess):  # noqa: F811
    for flow in ("build", "design", "refactor", "fix"):
        _off(flow, "review")
    for path in ("build-here", "design-here", "fix", "build", "refactor"):
        paths.set_path(sess, path, "x", "rule")
        assert "review" not in _steps(sess), path


def test_the_councils_review_off_is_passed_over_and_settled_when_merge_ends(sess):  # noqa: F811
    built = ["grill", "spec", "tickets", "build"]
    paths.set_path(sess, "build", "x", "claude", done=built)
    assert "review" in _steps(sess)
    _off("build", "review")
    paths.set_auto(sess, False)
    paths.advance(sess, "merge")
    assert paths.get(sess)["next"]["station"] == "retro"
    _off("build", "review", on=True)                                  # MERGE ended without it: it stays out
    assert "review" not in _steps(sess)
    paths.set_path(sess, "build", "x", "claude", done=built)
    paths.advance(sess, "merge")
    _off("build", "review")                                           # reached, then switched off: settled, it stays
    assert paths.get(sess)["next"]["station"] == "review"


def test_ponytail_off_marks_audit_and_a_here_builds_review_in_the_sheet(monkeypatch):
    monkeypatch.setattr(aifeatures, "enabled", lambda key: key == "router")
    marks = {(f["id"], s["step"]): s["ponytail_off"] for f in flowsettings.state()["flows"] for s in f["steps"]}
    assert marks[("build", "audit")] is True and marks[("fix", "review")] is True
    assert marks[("build", "review")] == "here" and marks[("build", "retro")] is False


def test_get_flows_shows_a_switched_off_step(monkeypatch):
    _off("build", "audit")
    b = next(f for f in flowsettings.state()["flows"] if f["id"] == "build")
    assert [(s["step"], s["on"], s["fixed"]) for s in b["steps"]] == [
        ("grill", True, False), ("build", True, True), ("review", True, False),
        ("retro", True, False), ("audit", False, False)]
    assert os.path.exists(flowsettings._file())                       # saved on the bridge


@pytest.mark.parametrize("back", ["chip", "ponytail"])
def test_a_finished_flow_stays_finished_when_a_step_it_passed_comes_back(sess, fake_queue, monkeypatch, back):  # noqa: F811
    if back == "ponytail":
        monkeypatch.setattr(aifeatures, "enabled", lambda key: key in ("router", "nextstep"))   # no ponytail REVIEW
        _off("fix", "retro")
    else:
        _off("fix", "review", "retro")
    t = _turn(sess, paths.start_flow(sess, "fix", "you", "the crash"))
    assert paths.step_done(sess, t) is None                           # DIAGNOSE was the last step on: FIX ended
    if back == "ponytail":
        monkeypatch.setattr(aifeatures, "enabled", lambda key: key in ("router", "nextstep", "ponytail"))
    else:
        _off("fix", "review", "retro", on=True)
    f = paths.get(sess)
    assert all(st[0] in f["done"] for st in f["stations"])            # what FLOW's chip reads: not running
    assert paths.start_flow(sess, "fix", "you", "it's back") == "/mattpocock-skills:diagnosing-bugs it's back"


def test_a_flow_that_ends_at_its_merge_stays_finished(sess):  # noqa: F811
    _off("build", "review", "retro", "audit")
    paths.set_path(sess, "build", "x", "claude", done=["grill", "spec", "tickets", "build"])
    paths.advance(sess, "merge")
    _off("build", "retro", "audit", on=True)
    f = paths.get(sess)
    assert f["next"] is None and all(st[0] in f["done"] for st in f["stations"])


def test_design_with_its_grill_off_keeps_its_design_step_when_the_grill_comes_on(sess):  # noqa: F811
    _off("design", "grill")
    prompt = paths.start_flow(sess, "design", "you", "a calmer header")
    _off("design", "grill", on=True)                                  # switched on before the Approve
    assert paths.step_done(sess, _turn(sess, prompt)) == "build-here"  # the design was this turn's step
