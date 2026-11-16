"""The run API (bridge/run_api.py): another program's prompt becomes a session.

The runner is a stand-in that holds the session's real run slot, so what is
tested is this module's reading of the session: when a run is live, waiting on
you, coming back by itself, or over."""

import json
import os
import stat
import threading
import time

import pytest

from bridge import config, limits, models, run_api, runner, state, store, waits


class Job:
    """What run_api reads off a runner.Job, and the ways a turn ends."""

    def __init__(self, sid):
        self.sid, self.status, self.pending = sid, "running", []
        self.interrupted = self.timed_out = False
        self.result = self.error_msg = self.refusal = self.hang_timeout = None
        self.texts, self.started = [], time.time()

    def end(self, status="done", result=None, error=None):
        self.status, self.result, self.error_msg = status, result, error
        state.release_run(self.sid)

    def interrupt(self):
        self.interrupted = True
        self.end("error")
        return True


@pytest.fixture
def world(tmp_path, monkeypatch):
    base = tmp_path / "base"
    for name in ("atlas", "shop"):
        (base / name / ".git").mkdir(parents=True)
    (base / "atlas" / "server").mkdir()
    (base / "loose").mkdir()
    monkeypatch.setattr(config, "BASE_PATH", str(base))
    monkeypatch.setattr(config, "RUN_API_CONCURRENCY", 2)
    monkeypatch.setattr(config, "RUN_API_DIRS", "")
    monkeypatch.setattr(config, "RUN_API_MODEL", "haiku")
    # The account's list as the Models API gives it; no test reaches the network.
    monkeypatch.setattr(models, "model_ids", lambda: {"claude-sonnet-5", "claude-haiku-5"})
    monkeypatch.setattr(run_api, "_dir", lambda: str(tmp_path / "state"))
    monkeypatch.setattr(run_api, "_runs", None)
    monkeypatch.setattr(run_api, "_token", None)
    monkeypatch.setattr(run_api, "_watching", set())
    monkeypatch.setattr(run_api, "POLL_S", 0.01)
    monkeypatch.setattr(run_api, "SETTLE_S", 0.05)
    monkeypatch.setattr(state, "shutting_down", False)
    store.init()
    jobs, calls, parked = {}, [], {}

    def start(chat_id, prompt, images, project=None, **kw):
        sid = kw["session_id"]
        assert state.acquire_run(sid, chat_id)
        jobs[sid] = Job(sid)
        calls.append({"chat": chat_id, "prompt": prompt, "project": project, **kw})
        return jobs[sid]

    monkeypatch.setattr(runner, "start_streaming_job", start)
    monkeypatch.setattr(
        runner,
        "live_job",
        lambda sid: (
            jobs[sid] if sid in jobs and jobs[sid].status == "running" else None
        ),
    )
    monkeypatch.setattr(runner, "_latest_jobs", lambda: dict(jobs))
    monkeypatch.setattr(limits, "parked", lambda: dict(parked))
    monkeypatch.setattr(limits, "cancel", lambda sid: parked.pop(sid, None) is not None)
    monkeypatch.setattr(waits, "waiting", lambda sid: False)
    monkeypatch.setattr(waits, "drop", lambda sid: False)
    w = {
        "atlas": str(base / "atlas"),
        "shop": str(base / "shop"),
        "loose": str(base / "loose"),
        "base": str(base),
        "tmp": tmp_path,
        "jobs": jobs,
        "calls": calls,
        "parked": parked,
        "start": start,
    }
    yield w
    for j in jobs.values():  # no slot or watcher outlives its test
        if j.status == "running":
            j.end("error")
    for t in threading.enumerate():  # ...its queue pump included
        if t.name.startswith("run-api-"):
            t.join(3)


def until(cond, timeout=3.0):
    end = time.time() + timeout
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.005)
    return False


def submit(world, repo="atlas", **kw):
    return run_api.submit(
        {"cwd": world[repo], "prompt": "Work through the queue.", **kw}
    )


def status(rid):
    return run_api.get(rid)["status"]


def job_of(world, rid):
    return world["jobs"][run_api.get(rid)["session_id"]]


# --- submit ------------------------------------------------------------------


def test_a_prompt_becomes_a_dashboard_session_and_answers_at_once(world):
    run = submit(world, client="atlas", title="Job queue", ref="batch-7")
    assert run["status"] == "running" and run["started"] and not run["finished"]
    assert (run["client"], run["ref"], run["title"]) == (
        "atlas",
        "batch-7",
        "Job queue",
    )
    s = store.get_session(run["session_id"])
    assert s["origin"] == "api:atlas" and s["title"] == "atlas: Job queue"
    assert s["chat_id"] == config.DASH_CHAT_ID and s["cwd"] == world["atlas"]
    assert s["project"] == "/atlas"
    assert run["session_url"].endswith(f"/?s={s['id']}")
    call = world["calls"][0]
    assert (
        call["prompt"].startswith("Work through the queue.")
        and '"atlas"' in call["prompt"]
    )
    assert call["project"] == world["atlas"] and call["origin"] == "api:atlas"


def test_the_session_gets_the_mode_a_dashboard_session_would(world, monkeypatch):
    monkeypatch.setattr(config, "NEW_SESSION_PERMISSION_MODE", "acceptEdits")
    run = submit(world)
    assert store.get_session(run["session_id"])["permission_mode"] == "acceptEdits"
    # ...and the caller names no mode or account of its own (a model it can).
    assert not {"permission_mode", "account_slot", "runtime"} & set(
        world["calls"][0]
    )
    run2 = run_api.submit(
        {"cwd": world["shop"], "prompt": "x", "permission_mode": "bypassPermissions"}
    )
    assert store.get_session(run2["session_id"])["permission_mode"] == "acceptEdits"


def test_a_run_with_no_title_is_named_by_its_first_line(world):
    run = run_api.submit(
        {"cwd": world["atlas"], "prompt": "Look up   the book.\nThen stop."}
    )
    assert run["title"] == "Look up the book." and run["client"] == "api"


@pytest.mark.parametrize(
    "body, code",
    [
        ({"prompt": "  "}, 400),
        ({"prompt": 7}, 400),
        ({"prompt": "x", "client": "At las!"}, 400),
        ({"prompt": "x" * (run_api.PROMPT_MAX + 1)}, 413),
    ],
)
def test_a_bad_request_is_refused_and_starts_nothing(world, body, code):
    with pytest.raises(run_api.Refused) as e:
        run_api.submit({"cwd": world["atlas"], **body})
    assert e.value.code == code and not world["calls"] and not run_api.listed()


# --- where a run may start -----------------------------------------------------


def test_a_run_starts_only_inside_a_repo_under_the_base(world, tmp_path):
    outside = tmp_path / "elsewhere"
    (outside / ".git").mkdir(parents=True)
    os.symlink(str(outside), os.path.join(world["base"], "atlas", "escape"))
    assert run_api.allowed_dir(world["atlas"]) == world["atlas"]
    assert run_api.allowed_dir(world["atlas"] + "/server") == world["atlas"] + "/server"
    for bad in (
        str(outside),
        world["loose"],
        world["base"],
        "/",
        os.path.expanduser("~"),
        world["atlas"] + "/escape",
    ):
        with pytest.raises(run_api.Refused) as e:
            run_api.allowed_dir(bad)
        assert e.value.code == 403, bad
    for bad in ("atlas", "", None, world["atlas"] + "/nope"):
        with pytest.raises(run_api.Refused) as e:
            run_api.allowed_dir(bad)
        assert e.value.code == 400, bad
    with pytest.raises(run_api.Refused):
        submit(world, repo="loose")
    assert not world["calls"]


def test_the_allow_list_replaces_any_repo(world, monkeypatch, tmp_path):
    outside = tmp_path / "elsewhere"
    outside.mkdir()
    monkeypatch.setattr(
        config, "RUN_API_DIRS", f"{world['atlas']}, {world['loose']}, {outside}"
    )
    assert run_api.allowed_dir(world["atlas"] + "/server")
    assert run_api.allowed_dir(world["loose"])  # listed, so no repo needed
    for bad in (world["shop"], str(outside)):  # unlisted; listed but outside the base
        with pytest.raises(run_api.Refused) as e:
            run_api.allowed_dir(bad)
        assert e.value.code == 403


# --- the model ---------------------------------------------------------------


@pytest.mark.parametrize("model", ["sonnet", "haiku", "opus", "fable", "claude-sonnet-5"])
def test_a_named_model_reaches_the_runner_and_stays_on_the_run(world, model):
    run = submit(world, model=model, effort="low")
    assert (run["model"], run["effort"]) == (model, "low")
    call = world["calls"][0]
    assert (call["model"], call["effort"]) == (model, "low")
    row = store.get_session(run["session_id"])  # a resumed turn reads the row
    assert (row["model"], row["effort"]) == (model, "low")
    assert run_api.listed()[0]["model"] == model


@pytest.mark.parametrize(
    "extra",
    [
        {"model": "gpt-4"},
        {"model": "claude-nonsense"},
        {"model": "Sonnet!"},
        {"model": 5},
        {"model": ["sonnet"]},
        {"effort": "extreme"},
        {"model": "sonnet", "effort": 3},
    ],
)
def test_an_unknown_model_or_effort_is_refused_and_starts_nothing(world, extra):
    with pytest.raises(run_api.Refused) as e:
        submit(world, **extra)
    assert e.value.code == 400 and "unknown" in str(e.value)
    if "model" in extra and extra["model"] != "sonnet":
        assert "haiku, sonnet, opus, fable" in str(e.value)
    assert not world["calls"] and not run_api.listed()


def test_a_full_id_passes_unchecked_only_while_the_live_list_is_missing(world, monkeypatch):
    monkeypatch.setattr(models, "model_ids", lambda: set(config.MINIAPP_MODELS))
    assert submit(world, model="claude-opus-9")["model"] == "claude-opus-9"
    with pytest.raises(run_api.Refused):
        submit(world, model="gpt-4")


def test_a_run_that_names_no_model_gets_the_lowest(world):
    assert config.MODELS_LOW_TO_HIGH[0] == "haiku"
    assert set(config.MODELS_LOW_TO_HIGH) == set(config.MINIAPP_MODELS)
    run = submit(world)
    assert (run["model"], run["effort"]) == ("haiku", None)
    assert world["calls"][0]["model"] == "haiku" and world["calls"][0]["effort"] is None
    assert submit(world, repo="shop", model="")["model"] == "haiku"


def test_the_default_model_is_a_setting_and_empty_means_the_bridges_own(world, monkeypatch):
    monkeypatch.setattr(config, "RUN_API_MODEL", "sonnet")
    assert submit(world)["model"] == "sonnet"
    assert submit(world, repo="shop", model="opus")["model"] == "opus"
    monkeypatch.setattr(config, "RUN_API_MODEL", "")
    world["calls"].clear()
    for j in world["jobs"].values():
        j.end("done")
    assert until(lambda: all(r["status"] == "done" for r in run_api.listed()))
    run = submit(world)
    assert run["model"] is None and world["calls"][0]["model"] is None
    assert store.get_session(run["session_id"])["model"] is None


def test_a_queued_run_starts_with_the_model_it_was_accepted_with(world, monkeypatch):
    monkeypatch.setattr(config, "RUN_API_CONCURRENCY", 1)
    first = submit(world)
    second = submit(world, repo="shop")
    assert status(second["id"]) == "queued" and second["model"] == "haiku"
    monkeypatch.setattr(config, "RUN_API_MODEL", "opus")
    job_of(world, first["id"]).end("done")
    assert until(lambda: status(second["id"]) == "running")
    assert world["calls"][1]["model"] == "haiku"


def test_a_run_stored_before_models_existed_still_reads(world):
    run = submit(world)
    with run_api._lock:
        r = run_api._load_locked()[run["id"]]
        del r["model"], r["effort"]
    got = run_api.get(run["id"])
    assert got["model"] is None and got["effort"] is None


# --- states ----------------------------------------------------------------------


def test_running_then_waiting_on_you_then_done_with_the_answer(world):
    run = submit(world)
    job = job_of(world, run["id"])
    job.pending = [{"kind": "permission"}]
    assert until(lambda: status(run["id"]) == "waiting_for_input")
    assert run_api.get(run["id"])["detail"] == "needs permission"
    job.pending = [{"kind": "permission"}, {"kind": "question"}]
    assert until(lambda: run_api.get(run["id"])["detail"] == "asked a question")
    job.pending = []
    assert until(lambda: status(run["id"]) == "running")
    job.end("done", result="Finished 3 jobs.")
    assert until(lambda: status(run["id"]) == "done")
    done = run_api.get(run["id"])
    assert done["response"] == "Finished 3 jobs." and done["error"] is None
    assert done["created"] <= done["started"] <= done["finished"]


def test_an_answer_with_no_result_event_is_the_last_thing_it_said(world):
    run = submit(world)
    job = job_of(world, run["id"])
    job.texts = ["Looking.", "All done."]
    job.end("done")
    assert until(lambda: status(run["id"]) == "done")
    assert run_api.get(run["id"])["response"] == "All done."


def test_a_turn_that_dies_is_failed_with_its_error(world):
    run = submit(world)
    job_of(world, run["id"]).end("error", error="`claude` not found on PATH")
    assert until(lambda: status(run["id"]) == "failed")
    out = run_api.get(run["id"])
    assert out["error"] == "`claude` not found on PATH" and out["response"] is None


def test_a_run_killed_as_hung_is_failed_even_if_it_read_done(world):
    run = submit(world)
    job = job_of(world, run["id"])
    job.timed_out = True
    job.end("done", result="an interim note")
    assert until(lambda: status(run["id"]) == "failed")
    assert "silence" in run_api.get(run["id"])["error"]


def test_a_resumed_turn_is_still_the_same_run(world):
    """Auto-resume and the fallback ladder start a new job in the session: the
    run reads through to that one's ending."""
    run = submit(world)
    sid = run["session_id"]
    job_of(world, run["id"]).end("error", error="API Error: 529 overloaded")
    world["start"](config.DASH_CHAT_ID, "resume", [], session_id=sid)  # inside SETTLE_S
    time.sleep(0.15)
    assert status(run["id"]) == "running"
    world["jobs"][sid].end("done", result="Second wind.")
    assert until(lambda: status(run["id"]) == "done")
    assert run_api.get(run["id"])["response"] == "Second wind."


def test_a_usage_limit_parks_the_run_instead_of_failing_it(world):
    run = submit(world)
    sid = run["session_id"]
    world["parked"][sid] = {"kind": "limit", "at": time.time() + 3600, "offer": None}
    job_of(world, run["id"]).end("error", error="You've hit your limit")
    assert until(lambda: "usage limit" in run_api.get(run["id"])["detail"])
    assert status(run["id"]) == "running"
    # The ladder asking which login to move to is a question for you.
    world["parked"][sid] = {
        "kind": "limit",
        "at": time.time() + 3600,
        "offer": [{"slot": 2}],
    }
    assert until(lambda: status(run["id"]) == "waiting_for_input")
    # Another login takes it: unparked, a new turn, and its answer is the run's.
    world["start"](config.DASH_CHAT_ID, "carry on", [], session_id=sid)
    world["parked"].clear()
    assert until(lambda: status(run["id"]) == "running")
    world["jobs"][sid].end("done", result="Done on the other account.")
    assert until(lambda: status(run["id"]) == "done")
    assert run_api.get(run["id"])["response"] == "Done on the other account."


def test_a_finished_run_stays_finished_when_you_carry_on_in_its_session(world):
    run = submit(world)
    sid = run["session_id"]
    job_of(world, run["id"]).end("done", result="First answer.")
    assert until(lambda: status(run["id"]) == "done")
    world["start"](config.DASH_CHAT_ID, "and another thing", [], session_id=sid)
    world["jobs"][sid].end("done", result="Yours, not the program's.")
    time.sleep(0.15)
    assert run_api.get(run["id"])["response"] == "First answer."


# --- wait --------------------------------------------------------------------------


def test_wait_returns_when_the_run_ends_not_when_the_time_does(world):
    run = submit(world)
    threading.Timer(
        0.1, lambda: job_of(world, run["id"]).end("done", result="ok")
    ).start()
    t0 = time.time()
    out = run_api.get(run["id"], wait=10)
    assert out["status"] == "done" and out["response"] == "ok" and time.time() - t0 < 5


def test_wait_gives_up_at_its_time_and_says_where_the_run_stands(world):
    run = submit(world)
    t0 = time.time()
    out = run_api.get(run["id"], wait=0.2)
    assert out["status"] == "running" and 0.15 < time.time() - t0 < 3
    assert run_api.get("nope", wait=5) is None


def test_one_wait_is_capped(world, monkeypatch):
    monkeypatch.setattr(run_api, "WAIT_MAX", 0.1)
    run = submit(world)
    t0 = time.time()
    assert (
        run_api.get(run["id"], wait=3600)["status"] == "running"
        and time.time() - t0 < 3
    )


# --- cancel --------------------------------------------------------------------------


def test_cancel_interrupts_the_turn_and_the_run_reads_cancelled(world):
    run = submit(world)
    job = job_of(world, run["id"])
    out = run_api.cancel(run["id"])
    assert job.interrupted and out["status"] in ("running", "cancelled")
    assert until(lambda: status(run["id"]) == "cancelled")
    assert run_api.get(run["id"])["finished"]
    with pytest.raises(run_api.Refused) as e:
        run_api.cancel(run["id"])
    assert e.value.code == 409
    assert run_api.cancel("nope") is None


def test_cancel_reaches_a_turn_whose_child_was_not_up_yet(world):
    run = submit(world)
    job = job_of(world, run["id"])
    real, job.interrupt = (
        job.interrupt,
        lambda: False,
    )  # still booting: nothing to signal
    run_api.cancel(run["id"])
    time.sleep(0.1)
    assert status(run["id"]) == "running" and not job.interrupted
    job.interrupt = real
    assert until(lambda: status(run["id"]) == "cancelled")


def test_cancelling_a_parked_run_unparks_it(world):
    run = submit(world)
    sid = run["session_id"]
    world["parked"][sid] = {"kind": "limit", "at": time.time() + 3600, "offer": None}
    job_of(world, run["id"]).end("error", error="limit")
    assert until(lambda: "usage limit" in run_api.get(run["id"])["detail"])
    assert run_api.cancel(run["id"])["status"] == "cancelled"
    assert sid not in world["parked"]


def test_a_turn_you_stop_in_the_dashboard_cancels_the_run(world):
    run = submit(world)
    job_of(world, run["id"]).interrupt()
    assert until(lambda: status(run["id"]) == "cancelled")
    assert run_api.get(run["id"])["detail"] == "stopped in the dashboard"


# --- the cap and the queue ---------------------------------------------------------------


def test_runs_past_the_cap_queue_and_start_oldest_first(world):
    a, b = submit(world, title="a"), submit(world, title="b")
    c, d = submit(world, title="c"), submit(world, repo="shop", title="d")
    assert [r["status"] for r in (a, b, c, d)] == [
        "running",
        "running",
        "queued",
        "queued",
    ]
    assert (c["queue_position"], d["queue_position"]) == (1, 2)
    assert c["session_id"] is None and len(world["calls"]) == 2
    job_of(world, a["id"]).end("done", result="a done")
    assert until(lambda: status(c["id"]) == "running")
    assert status(d["id"]) == "queued" and run_api.get(d["id"])["queue_position"] == 1
    job_of(world, b["id"]).end("error", error="boom")  # a failure frees its slot too
    assert until(lambda: status(d["id"]) == "running")
    assert store.get_session(run_api.get(d["id"])["session_id"])["cwd"] == world["shop"]


def test_a_run_waiting_on_you_keeps_its_slot(world, monkeypatch):
    monkeypatch.setattr(config, "RUN_API_CONCURRENCY", 1)
    a, b = submit(world), submit(world)
    job_of(world, a["id"]).pending = [{"kind": "question"}]
    assert until(lambda: status(a["id"]) == "waiting_for_input")
    time.sleep(0.1)
    assert status(b["id"]) == "queued"


def test_a_queued_run_that_is_cancelled_never_starts(world, monkeypatch):
    monkeypatch.setattr(config, "RUN_API_CONCURRENCY", 1)
    a, b, c = submit(world), submit(world), submit(world)
    assert run_api.cancel(b["id"])["status"] == "cancelled"
    job_of(world, a["id"]).end("done")
    assert until(lambda: run_api.get(c["id"])["session_id"])
    assert run_api.get(b["id"])["session_id"] is None and len(world["calls"]) == 2


def test_the_queue_itself_is_bounded(world, monkeypatch):
    monkeypatch.setattr(config, "RUN_API_CONCURRENCY", 1)
    monkeypatch.setattr(run_api, "QUEUE_MAX", 2)
    for _ in range(3):
        submit(world)
    with pytest.raises(run_api.Refused) as e:
        submit(world)
    assert e.value.code == 429


def test_a_start_that_blows_up_fails_that_run_and_frees_the_slot(world, monkeypatch):
    monkeypatch.setattr(config, "RUN_API_CONCURRENCY", 1)
    ok = world["start"]
    boom = {"left": 1}

    def start(*a, **kw):
        if boom["left"]:
            boom["left"] -= 1
            raise RuntimeError("no such profile")
        return ok(*a, **kw)

    monkeypatch.setattr(runner, "start_streaming_job", start)
    a = submit(world)
    assert a["status"] == "failed" and "no such profile" in a["error"]
    assert submit(world)["status"] == "running"


# --- listing, and what survives a restart ----------------------------------------------------


def test_runs_list_newest_first_and_filter_by_client(world):
    a = submit(world, client="atlas")
    b = submit(world, client="cron")
    assert [r["id"] for r in run_api.listed()] == [b["id"], a["id"]]
    assert [r["id"] for r in run_api.listed("atlas")] == [a["id"]]
    assert run_api.listed("nobody") == []
    assert "prompt" not in run_api.listed()[0]


def test_only_so_many_finished_runs_are_kept(world, monkeypatch):
    monkeypatch.setattr(run_api, "KEEP", 2)
    ids = []
    for _ in range(4):
        r = submit(world)
        ids.append(r["id"])
        job_of(world, r["id"]).end("done")
        assert until(lambda: status(r["id"]) == "done")
    assert [r["id"] for r in run_api.listed()] == ids[:1:-1]


def _restart(monkeypatch):
    monkeypatch.setattr(run_api, "_runs", None)
    monkeypatch.setattr(run_api, "_token", None)
    until(lambda: not run_api._watching)


def test_a_restart_picks_up_live_runs_and_starts_queued_ones(world, monkeypatch):
    monkeypatch.setattr(config, "RUN_API_CONCURRENCY", 1)
    a, b = submit(world), submit(world)
    sid = a["session_id"]
    # The bridge goes down mid-turn: the watcher stops without a verdict.
    monkeypatch.setattr(state, "shutting_down", True)
    assert until(lambda: not run_api._watching)
    monkeypatch.setattr(state, "shutting_down", False)
    _restart(monkeypatch)
    run_api.boot()  # recovery already resumed the turn: the slot is held
    assert status(a["id"]) == "running" and status(b["id"]) == "queued"
    world["jobs"][sid].end("done", result="After the restart.")
    assert until(lambda: status(a["id"]) == "done")
    assert until(lambda: status(b["id"]) == "running")


def test_a_run_that_ended_while_the_bridge_was_down_reads_from_the_store(
    world, monkeypatch
):
    a, b = submit(world), submit(world, repo="shop")
    monkeypatch.setattr(state, "shutting_down", True)
    assert until(lambda: not run_api._watching)
    monkeypatch.setattr(state, "shutting_down", False)
    for run, how in ((a, "done"), (b, "error")):
        sid = run["session_id"]
        store.start_turn(sid, f"t-{sid}", "p", [])
        if how == "done":
            store.append_event(
                sid, f"t-{sid}", {"type": "result", "result": "Stored answer."}
            )
        store.finish_turn(f"t-{sid}", how, None, 1)
        world["jobs"].pop(sid).end(how)  # the old process's job is gone
    _restart(monkeypatch)
    run_api.boot()
    assert until(lambda: status(a["id"]) == "done" and status(b["id"]) == "failed")
    assert run_api.get(a["id"])["response"] == "Stored answer."
    assert run_api.get(b["id"])["error"]


def test_no_run_starts_while_the_bridge_is_going_down(world, monkeypatch):
    monkeypatch.setattr(state, "shutting_down", True)
    run = submit(world, client="ghost")
    assert run["status"] == "queued" and not world["calls"]
    monkeypatch.setattr(state, "shutting_down", False)
    monkeypatch.setattr(
        runner, "start_streaming_job", lambda *a, **kw: None
    )  # refused mid-shutdown
    run_api._pump()
    assert status(run["id"]) == "queued"
    assert not [
        s
        for s in store.list_sessions_all(config.DASH_CHAT_ID)
        if s["origin"] == "api:ghost"
    ]


# --- the token ------------------------------------------------------------------------------


def test_the_token_file_is_private_and_survives_a_restart(world, monkeypatch):
    monkeypatch.setattr(config, "DASH_PORT", 8790)
    run_api.boot()
    path = run_api.conn_path()
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    conn = json.load(open(path))
    assert conn["url"] == "http://127.0.0.1:8790" and len(conn["token"]) >= 32
    assert conn["token"] != config.DASH_TOKEN
    _restart(monkeypatch)
    monkeypatch.setattr(config, "DASH_PORT", 9999)
    run_api.boot()
    again = json.load(open(path))
    assert again["token"] == conn["token"] and again["url"] == "http://127.0.0.1:9999"


def test_every_route_wants_the_run_token(world):
    tok = run_api.token()
    body = {"cwd": world["atlas"], "prompt": "x"}
    for bad in (None, "", "nope", config.DASH_TOKEN, tok + "x"):
        for method, path, b in (
            ("GET", "/local/runs", None),
            ("POST", "/local/runs", body),
            ("GET", "/local/runs/abc", None),
            ("POST", "/local/runs/abc/cancel", {}),
        ):
            assert run_api.http(method, path, {}, b, bad)[1] == 401, (bad, method, path)
    assert not world["calls"]
    assert run_api.http("GET", "/local/runs", {}, None, tok) == ({"runs": []}, 200)


def test_the_routes(world):
    tok = run_api.token()
    out, code = run_api.http(
        "POST",
        "/local/runs",
        {},
        {"cwd": world["atlas"], "prompt": "x", "client": "atlas"},
        tok,
    )
    assert code == 202 and out["run"]["status"] == "running"
    rid = out["run"]["id"]
    assert (
        run_api.http("GET", f"/local/runs/{rid}", {"wait": ["0.05"]}, None, tok)[0][
            "run"
        ]["id"]
        == rid
    )
    assert [
        r["id"]
        for r in run_api.http("GET", "/local/runs", {"client": ["atlas"]}, None, tok)[
            0
        ]["runs"]
    ] == [rid]
    assert (
        run_api.http("GET", "/local/runs", {"client": ["cron"]}, None, tok)[0]["runs"]
        == []
    )
    assert run_api.http("POST", f"/local/runs/{rid}/cancel", {}, {}, tok)[1] == 200
    assert until(lambda: status(rid) == "cancelled")
    assert run_api.http("POST", f"/local/runs/{rid}/cancel", {}, {}, tok)[1] == 409
    assert run_api.http("GET", "/local/runs/nope", {}, None, tok)[1] == 404
    assert run_api.http("POST", "/local/runs/nope/cancel", {}, {}, tok)[1] == 404
    assert run_api.http("POST", "/local/runs", {}, None, tok)[1] == 400
    assert (
        run_api.http(
            "POST", "/local/runs", {}, {"cwd": world["loose"], "prompt": "x"}, tok
        )[1]
        == 403
    )
    assert run_api.http("POST", f"/local/runs/{rid}/respond", {}, {}, tok)[1] == 404


def test_the_json_shape_scripts_rely_on(world):
    """Documented in docs/superpowers/specs/local-run-api.md: add keys, never drop one."""
    assert set(submit(world)) == {
        "id",
        "status",
        "detail",
        "client",
        "ref",
        "title",
        "cwd",
        "model",
        "effort",
        "session_id",
        "session_url",
        "created",
        "started",
        "finished",
        "queue_position",
        "response",
        "error",
    }


# --- through the real runner -----------------------------------------------------------------


def test_the_real_runner_starts_it_with_the_dashboard_mode_and_ends_it(tmp_path, monkeypatch):
    """No stand-in for start_streaming_job: the session, its turn and the mode the
    turn runs with are the runner's own. Only the claude child is replaced."""
    from bridge import titler

    base = tmp_path / "base"
    (base / "atlas" / ".git").mkdir(parents=True)
    monkeypatch.setattr(config, "BASE_PATH", str(base))
    monkeypatch.setattr(config, "RUN_API_DIRS", "")
    monkeypatch.setattr(config, "NEW_SESSION_PERMISSION_MODE", "acceptEdits")
    monkeypatch.setattr(run_api, "_dir", lambda: str(tmp_path / "state"))
    monkeypatch.setattr(run_api, "_runs", None)
    monkeypatch.setattr(run_api, "_token", None)
    monkeypatch.setattr(run_api, "_watching", set())
    monkeypatch.setattr(run_api, "POLL_S", 0.01)
    monkeypatch.setattr(run_api, "SETTLE_S", 0.05)
    monkeypatch.setattr(state, "shutting_down", False)
    monkeypatch.setattr(runner, "_jobs", {})
    monkeypatch.setattr(titler, "kick", lambda *a, **k: None)
    store.init()
    spawned = []

    def child(job, prompt, image_paths, cwd, model, effort, perm, ponytail):
        spawned.append({"prompt": prompt, "cwd": cwd, "perm": perm})
        time.sleep(0.1)
        job.status, job.result = "done", "Looked up 2 books."
        store.finish_turn(job.id, "done", None, 1)
        state.release_run(job.store_session_id)
        job.exited.set()

    monkeypatch.setattr(runner, "_run_streaming", child)
    run = run_api.submit({"cwd": str(base / "atlas"), "prompt": "Do the jobs.", "client": "atlas"})
    assert run["status"] == "running"
    assert until(lambda: status(run["id"]) == "done")
    assert run_api.get(run["id"])["response"] == "Looked up 2 books."
    assert spawned[0]["cwd"] == str(base / "atlas") and spawned[0]["perm"] == "acceptEdits"
    turn = store.last_turn(run["session_id"])
    assert turn["permission_mode"] == "acceptEdits" and turn["prompt"].startswith("Do the jobs.")
    for t in threading.enumerate():
        if t.name.startswith("run-api-"):
            t.join(3)
