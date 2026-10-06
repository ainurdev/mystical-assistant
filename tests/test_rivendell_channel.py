"""The Rivendell channel (docs/superpowers/specs/rivendell-channel.md): what the
bridge itself knows about a Rivendell job — the session that ran it, what that
run is doing or came to, the question it is held on — and the state of the link
the job arrived over.

No network and no Claude: workers are driven directly, every Telegram message
lands in the `quiet` fixture, and the store is conftest's temp DB (store.init()
is idempotent, so each helper that needs tables calls it).
Run: python -m pytest tests/test_rivendell_channel.py -v
"""

import itertools
import json
import socket
import threading
import time
import uuid

import pytest

from bridge import config, rivendell, runner, state, store, wsutil

_mids = itertools.count(1000)          # Telegram message ids, unique across tests


@pytest.fixture(autouse=True)
def quiet(monkeypatch):
    """Every Telegram message a worker or a hook would send, recorded instead of
    sent: {"chat", "text", "kb", "mid"}. The generic run pings (runner._notify)
    are silenced too. NOTIFY_ENABLE and the Mini App URL are pinned here: the
    bridge exports .env into the shells it hosts, and conftest pins neither."""
    from bridge import telegram
    sent = []

    def send(chat_id, text, reply_markup=None):
        sent.append({"chat": chat_id, "text": text, "kb": reply_markup, "mid": next(_mids)})
        return {"message_id": sent[-1]["mid"]}
    monkeypatch.setattr(telegram, "send", send)
    monkeypatch.setattr(runner, "_notify", lambda *a, **k: None)
    monkeypatch.setattr(config, "NOTIFY_ENABLE", True)
    monkeypatch.setattr(state, "miniapp_url", None)        # no OPEN SESSION button to count
    from bridge import github
    monkeypatch.setattr(github, "pr_checks", lambda url: None)   # never `gh` over the network
    rivendell._checks_cache.clear()
    return sent


@pytest.fixture
def workers():
    """The running-worker registry, emptied around the test."""
    store.init()
    rivendell._workers.clear()
    yield rivendell._workers
    rivendell._workers.clear()


@pytest.fixture
def jobs():
    """Jobs a test registers with the runner, dropped again afterwards."""
    made = []
    yield made
    with runner._jobs_lock:
        for j in made:
            runner._jobs.pop(j.id, None)


def _inst(**kw):
    d = {"id": "ch", "name": "test", "enable": True,
         "api_url": "http://api.example:3001", "token": "rvd_testtoken",
         "ws_url": "", "model": "opus", "workdir": "",
         "review_timeout": 3600, "impl_timeout": 10800}
    d.update(kw)
    return d


def _worker(**kw):
    return rivendell.Worker(_inst(**kw))


def _answering(answer):
    """An _api stand-in that returns a fresh copy of `answer` for every call."""
    return lambda path, payload=None: json.loads(json.dumps(answer))


def _session(origin="rivendell:test", title="Inbox: group meeting action items by client"):
    store.init()
    sid = store.create_session(config.DASH_CHAT_ID, "proj", origin=origin)["id"]
    if title:
        store.rename(sid, title)
    return sid


def _turn(sid, *, status="done", elapsed=60, result=None, error=None, tokens=None):
    """One finished turn on `sid`, with the events a run would have journaled.
    Turn ids are a global primary key, hence the uuid."""
    tid = uuid.uuid4().hex
    store.start_turn(sid, tid, "implement it", None)
    if error:
        store.append_event(sid, tid, {"type": "error", "message": error})
    if result is not None:
        store.append_event(sid, tid, {"type": "result", "result": result})
    store.set_turn_tokens(tid, tokens)
    store.finish_turn(tid, status, None, elapsed)
    return tid


def _tasks(*rids, status="COMPLETED"):
    """A /plugin/tasks answer: one of the user's tasks per request id."""
    return {"projects": [{"id": "p1", "name": "Rivendell", "url": "https://rv/projects/p1"}],
            "tasks": [{"id": f"t{i}", "name": f"Task {i}", "mine": True, "implementation":
                       {"id": rid, "status": status, "createdAt": "2026-10-06T10:00:00Z",
                        "completedAt": None}}
                      for i, rid in enumerate(rids, 1)]}


def _wait_until(pred, timeout=3.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return
        time.sleep(0.01)
    raise AssertionError("condition not met within timeout")


# --- Task 1: every run is filed under its request ------------------------------

def test_sessions_are_found_by_their_request_ref():
    a, b = _session(), _session()
    store.set_ref(a, "ch:r-find-1")
    store.set_ref(b, "ch:r-find-2")
    assert store.sessions_for_refs(["ch:r-find-1", "ch:r-find-2", "ch:nope"]) == {
        "ch:r-find-1": a, "ch:r-find-2": b}
    assert store.sessions_for_refs([]) == {}


def test_a_request_run_again_names_its_newest_session():
    """A catch-up after a restart re-claims an IN_PROGRESS request and runs it in
    a new session; the card must open the one that did the work it now shows."""
    old, new = _session(), _session()
    store.set_ref(old, "ch:r-again")
    store.set_ref(new, "ch:r-again")
    assert store.sessions_for_refs(["ch:r-again"]) == {"ch:r-again": new}


def test_track_files_the_session_under_the_request(workers):
    sid = _session()
    _worker()._track("r-track", "impl", "acme/app", sid, label=None, link=None)
    assert store.sessions_for_refs(["ch:r-track"]) == {"ch:r-track": sid}


def test_a_finished_run_keeps_its_session_on_the_card(workers):
    """OPEN SESSION used to vanish with the run (memory only). A DONE card now
    still knows the session that did the work — after a restart too."""
    sid = _session()
    store.set_ref(sid, "ch:r-done")
    w = _worker()
    w._api = _answering(_tasks("r-done"))
    workers["ch"] = w
    assert rivendell.tasks("acme/app")["tasks"][0]["session_id"] == sid


# --- Task 2: a question pauses the job's clock ---------------------------------

class _Waiting:
    """A live job that never ends on its own; `pending` is what it is held on."""

    def __init__(self):
        self.status, self.pending, self.interrupted = "running", [], False
        self.exited = threading.Event()
        self.store_session_id = None

    def interrupt(self):
        self.interrupted = True


def test_a_question_pauses_the_jobs_wall_clock(monkeypatch):
    """Review focus 3. A run held on AskUserQuestion is waiting on a person: its
    kind's timeout must not fail it while they think (the hang watchdog already
    reads a pending question that way — runner._watchdog)."""
    monkeypatch.setattr(rivendell, "_POLL_INTERVAL", 0.02)
    job = _Waiting()
    job.pending = [{"request_id": "q1", "kind": "question"}]
    out = []
    t = threading.Thread(target=lambda: out.append(_worker()._wait_job(job, 0.2)), daemon=True)
    t.start()
    time.sleep(0.6)                       # three timeouts' worth, all of it waiting on you
    assert out == [] and not job.interrupted
    job.pending = []                      # answered: the clock runs again
    t.join(3)
    assert out == [(False, "run timed out after 0.2s")] and job.interrupted


def test_a_question_pauses_a_batchs_wall_clock(monkeypatch):
    from bridge import queue_manager
    from bridge.queue_manager import PreviewQueue
    q = PreviewQueue(run_fn=lambda item: "job-q", persist_path=None)
    monkeypatch.setattr(queue_manager, "_instance", q)
    monkeypatch.setattr(rivendell, "_POLL_INTERVAL", 0.02)
    held = {"on": True}
    monkeypatch.setattr(rivendell, "_held", lambda sid: held["on"])
    q.enqueue("sess-held", text="step", prompt="do it", images=[], model="opus", effort=None,
              permission_mode="bypassPermissions", width=0, sel=[], surface="rivendell",
              chat_id=config.DASH_CHAT_ID, project="/repo", label="step · 1/1", link=None,
              ref="ch:b-held")
    out = []
    t = threading.Thread(target=lambda: out.append(
        _worker()._wait_queue("sess-held", "ch:b-held", 0.2)), daemon=True)
    t.start()
    time.sleep(0.6)
    assert out == [], "a turn waiting on a person must not run the batch's clock out"
    held["on"] = False
    t.join(3)
    assert out == [(False, "run timed out after 0.2s")]


def test_live_job_is_the_sessions_running_job(jobs):
    job = runner.Job(uuid.uuid4().hex, config.DASH_CHAT_ID, "sess-live")
    runner._register(job)
    jobs.append(job)
    assert runner.live_job("sess-live") is job
    assert runner.live_job("sess-other") is None
    job.status = "done"
    assert runner.live_job("sess-live") is None


# --- Task 3: what a card knows about its run -----------------------------------

class _Stdin:
    def __init__(self):
        self.lines = []

    def write(self, s):
        self.lines.append(s)

    def flush(self):
        pass


class _Proc:
    """Enough of a Popen for Job.respond: a stdin to answer on, and alive."""

    def __init__(self):
        self.stdin = _Stdin()

    def poll(self):
        return None


def _use(tid, name, inp):
    return {"type": "assistant",
            "message": {"content": [{"type": "tool_use", "id": tid, "name": name, "input": inp}]}}


def _tool_result(tid, tool_use_result):
    return {"type": "user", "tool_use_result": tool_use_result,
            "message": {"content": [{"type": "tool_result", "tool_use_id": tid,
                                     "content": [{"type": "text", "text": "ok"}]}]}}


COLOUR = [{"question": "Items with no meeting: group them under “No client”, or leave them out?",
           "header": "No meeting", "multiSelect": False,
           "options": [{"label": "Under “No client”", "description": ""},
                       {"label": "Leave them out", "description": ""}]}]


def _held_job(questions=COLOUR, sid=None):
    """A job held on an AskUserQuestion, as runner._handle_control_request leaves it."""
    j = runner.Job(uuid.uuid4().hex, config.DASH_CHAT_ID, sid)
    j.proc = _Proc()
    runner._handle_control_request(j, {"request_id": "q1", "request": {
        "subtype": "can_use_tool", "tool_name": "AskUserQuestion",
        "input": {"questions": questions}}})
    return j


def test_the_task_tools_are_the_runs_todo_list():
    """claude 2.1.280 offers no TodoWrite in -p mode; a run plans with
    TaskCreate/TaskUpdate (shapes captured from the CLI on 2026-10-06)."""
    j = runner.Job(uuid.uuid4().hex, config.DASH_CHAT_ID)
    runner._handle_event(j, _use("u1", "TaskCreate", {"subject": "alpha", "description": "a"}))
    runner._handle_event(j, _tool_result("u1", {"task": {"id": "1", "subject": "alpha"}}))
    runner._handle_event(j, _use("u2", "TaskCreate", {"subject": "beta", "description": "b"}))
    runner._handle_event(j, _tool_result("u2", {"task": {"id": "2", "subject": "beta"}}))
    runner._handle_event(j, _use("u3", "TaskUpdate", {"taskId": "1", "status": "in_progress"}))
    runner._handle_event(j, _use("u4", "TaskUpdate", {"taskId": "1", "status": "completed"}))
    assert j.task_status == {"1": "completed", "2": "pending"}
    assert rivendell.live_view(j)["live"]["todos"] == {"done": 1, "total": 2}


def test_a_deleted_task_leaves_the_count():
    j = runner.Job(uuid.uuid4().hex, config.DASH_CHAT_ID)
    j.task_status = {"1": "completed", "2": "deleted", "3": "in_progress"}
    assert rivendell.live_view(j)["live"]["todos"] == {"done": 1, "total": 2}


def test_a_todowrite_list_still_counts():
    j = runner.Job(uuid.uuid4().hex, config.DASH_CHAT_ID)
    j.todos = [{"content": "a", "status": "completed"}, {"content": "b", "status": "pending"}]
    assert rivendell.live_view(j)["live"]["todos"] == {"done": 1, "total": 2}


def test_live_view_names_the_latest_action_and_counts_steps():
    j = runner.Job(uuid.uuid4().hex, config.DASH_CHAT_ID)
    runner._handle_event(j, _use("u1", "Read", {"file_path": "a.ts"}))
    runner._handle_event(j, _use("u2", "Edit", {"file_path": "frontend/src/routes/tasks/$id.tsx"}))
    v = rivendell.live_view(j)
    assert v["live"] == {"line": "Edit: frontend/src/routes/tasks/$id.tsx", "steps": 2, "todos": None}
    assert v["ask"] is None


def test_live_view_carries_the_question_a_run_is_held_on():
    j = _held_job()
    ask = rivendell.live_view(j)["ask"]
    assert (ask["job_id"], ask["request_id"], ask["header"], ask["simple"]) == (
        j.id, "q1", "No meeting", True)
    assert ask["options"] == ["Under “No client”", "Leave them out"]
    assert ask["question"] == COLOUR[0]["question"] and ask["at"] > 0


def test_a_richer_question_is_not_buttons():
    two = COLOUR + [{"question": "And the rest?", "header": "Rest", "options": [{"label": "x"}]}]
    assert rivendell.live_view(_held_job(two))["ask"]["simple"] is False
    assert rivendell.live_view(_held_job([{**COLOUR[0], "multiSelect": True}]))["ask"]["simple"] is False


def test_result_view_reads_the_pr_time_and_tokens_off_the_session():
    sid = _session()
    _turn(sid, elapsed=2280,
          result="Branch feat/x. PR: https://github.com/acme/app/pull/128 — opened.",
          tokens={"in": 1000, "out": 200, "cache_w": 500, "cache_r": 1_000_000})
    v = rivendell._result_view(sid)
    assert (v["pr"]["number"], v["pr"]["url"]) == (128, "https://github.com/acme/app/pull/128")
    assert v["wall_s"] == 2280 and v["tokens"] == {"in": 1_001_500, "out": 200}
    assert v["outcome"] is None


def test_result_view_names_a_failed_runs_outcome():
    sid = _session()
    _turn(sid, status="error", elapsed=1260, error="⏱️ No output for 30 min — killed as hung.")
    assert rivendell._result_view(sid)["outcome"]["label"] == "KILLED AS HUNG"


def test_a_session_with_no_turns_has_no_result():
    assert rivendell._result_view(_session()) is None


def test_tasks_carry_each_runs_view(workers, jobs):
    done = _session()
    store.set_ref(done, "ch:r-view-done")
    _turn(done, result="https://github.com/acme/app/pull/7")
    live = _session()
    store.set_ref(live, "ch:r-view-live")
    j = _held_job(sid=live)
    runner._register(j)
    jobs.append(j)
    w = _worker()
    w._api = _answering(_tasks("r-view-done", "r-view-live"))
    workers["ch"] = w
    by_rid = {t["implementation"]["id"]: t for t in rivendell.tasks("acme/app")["tasks"]}
    assert by_rid["r-view-done"]["run"]["result"]["pr"]["number"] == 7
    assert by_rid["r-view-live"]["run"]["ask"]["request_id"] == "q1"


# --- Task 4: DONE cards show the PR's checks -----------------------------------

def test_checks_ride_the_pr_and_are_cached_between_polls(monkeypatch):
    from bridge import github
    calls = []
    monkeypatch.setattr(github, "pr_checks", lambda url: calls.append(url) or "pass")
    sid = _session()
    _turn(sid, result="https://github.com/acme/app/pull/31")
    assert rivendell._result_view(sid)["pr"]["checks"] == "pass"
    assert rivendell._result_view(sid)["pr"]["checks"] == "pass"
    assert calls == ["https://github.com/acme/app/pull/31"], "one `gh` call per TTL"
    monkeypatch.setattr(rivendell, "_CHECKS_TTL", 0)
    rivendell._result_view(sid)
    assert len(calls) == 2
    assert "checks" not in rivendell._result_view(sid, checks=False)["pr"]


# --- Task 5: the link's break, flagged once ------------------------------------

def _alerts(quiet):
    return [m["text"] for m in quiet if m["text"].startswith("✕ Rivendell link broken")]


def test_a_rejected_token_alerts_once_per_break(quiet):
    """Review focus 2. The gateway closes a bad token AFTER the 101, so a re-dial
    of a still-bad token passes through "connected": that must not end the
    break, or every TEST LINK would send another message."""
    w = _worker()
    w._set_status("connecting", "ws://x/agent")
    w._set_status("auth_error", "token rejected by gateway (4401 Invalid or revoked token)")
    _wait_until(lambda: len(_alerts(quiet)) == 1)
    assert "4401" in _alerts(quiet)[0] and w.alert_at is not None
    for state in ("connecting", "connected", "auth_error"):          # the re-dial
        w._set_status(state, "token rejected by gateway (4401)")
    time.sleep(0.1)
    assert len(_alerts(quiet)) == 1


def test_an_outage_alerts_only_after_the_grace(quiet):
    w = _worker()
    w._set_status("error", "connection refused")
    w._set_status("connecting", "ws://x/agent")
    assert w.alert_at is None and w.down_since is not None
    w.down_since -= rivendell._LINK_GRACE                  # the outage is five minutes old now
    w._set_status("error", "connection refused")
    _wait_until(lambda: len(_alerts(quiet)) == 1)
    assert "Can't reach" in _alerts(quiet)[0]


def test_coming_back_inside_the_grace_sends_nothing(quiet):
    w = _worker()
    w._set_status("error", "connection refused")
    w._set_status("connected", "ws://x/agent")
    w._recovered()
    assert w.down_since is None and w.alert_at is None
    time.sleep(0.05)
    assert _alerts(quiet) == []


def test_only_a_proven_link_ends_the_break():
    w = _worker()
    w._set_status("auth_error", "token rejected (4401)")
    w._set_status("connected", "ws://x/agent")
    assert w.alert_at is not None, "the 101 alone is not recovery"
    w._recovered()
    assert w.alert_at is None and w.down_since is None


def test_switching_off_ends_the_break_silently(quiet):
    w = _worker()
    w._set_status("auth_error", "token rejected (4401)")
    _wait_until(lambda: len(_alerts(quiet)) == 1)
    w.stop()
    assert w.alert_at is None and w.status_snapshot()["state"] == "off"


def test_a_frame_on_the_link_proves_it(monkeypatch):
    server, client = socket.socketpair()
    w = _worker()
    w.down_since = w.alert_at = time.time() - 600            # a break, already flagged
    monkeypatch.setattr(w, "_connect", lambda: (client, client.makefile("rb")))
    monkeypatch.setattr(w, "_catch_up", lambda: 0)
    t = threading.Thread(target=w._listen, daemon=True)
    t.start()
    try:
        _wait_until(lambda: w.status == "connected")
        assert w.alert_at is not None
        server.sendall(wsutil.encode_frame(b'{"type":"noise"}', wsutil.OP_TEXT))
        _wait_until(lambda: w.alert_at is None)
    finally:
        w.stop()
        t.join(2)
        server.close()


def test_a_failed_dial_counts_and_schedules_the_retry(monkeypatch):
    w = _worker()

    def refuse():
        raise ConnectionRefusedError("connection refused")
    monkeypatch.setattr(w, "_connect", refuse)
    t = threading.Thread(target=w._listen, daemon=True)
    t.start()
    try:
        _wait_until(lambda: w.status == "error")
        snap = w.status_snapshot()
        assert snap["attempt"] == 1 and snap["retry_at"] >= snap["since"]
        assert snap["down_since"] is not None and snap["alert_at"] is None
    finally:
        w.stop()
        t.join(2)


def test_tasks_carry_each_connections_state(workers):
    w = _worker(name="production")
    w._api = _answering(_tasks())
    w._set_status("connected", "wss://rv/agent")
    workers["ch"] = w
    (link,) = rivendell.tasks("acme/app")["links"]
    assert (link["instance_id"], link["instance"], link["state"]) == ("ch", "production", "connected")


def test_a_failing_instance_lists_its_last_good_answer_as_stale(workers):
    w = _worker()
    w._api = _answering(_tasks("r-stale-1", "r-stale-2"))
    workers["ch"] = w
    assert [t["stale"] for t in rivendell.tasks("acme/app")["tasks"]] == [False, False]
    w._set_status("auth_error", "token rejected (4401)")
    out = rivendell.tasks("acme/app")
    assert [(t["id"], t["stale"]) for t in out["tasks"]] == [("t1", True), ("t2", True)]
    assert out["errors"][0]["error"] == "token_rejected" and out["projects"]


# --- Task 6: TEST LINK ----------------------------------------------------------

def _gateway(server, answer_pings=True):
    """What Rivendell's `ws` does with a client's ping (autoPong, ws 8): echo its
    payload back in a pong. Runs until the socket closes."""
    def run():
        srv = server.makefile("rb")
        while True:
            try:
                f = wsutil.decode_frame(srv)
            except OSError:
                return
            if f is None:
                return
            if f[0] == wsutil.OP_PING and answer_pings:
                server.sendall(wsutil.encode_frame(f[1], wsutil.OP_PONG))
    threading.Thread(target=run, daemon=True).start()


def _linked(monkeypatch, answer_pings=True):
    server, client = socket.socketpair()
    w = _worker()
    monkeypatch.setattr(w, "_connect", lambda: (client, client.makefile("rb")))
    monkeypatch.setattr(w, "_catch_up", lambda: 0)
    _gateway(server, answer_pings)
    t = threading.Thread(target=w._listen, daemon=True)
    t.start()
    _wait_until(lambda: w.status == "connected")
    return w, t, server


def test_test_link_is_a_ping_pong_round_trip(monkeypatch):
    w, t, server = _linked(monkeypatch)
    try:
        res = w.test_link()
        assert res["ok"] is True and res["rtt_ms"] is not None and res["detail"] == ""
        assert w.status_snapshot()["last_test"] == res
    finally:
        w.stop()
        t.join(2)
        server.close()


def test_test_link_without_a_pong_says_so(monkeypatch):
    w, t, server = _linked(monkeypatch, answer_pings=False)
    try:
        res = w.test_link(timeout=0.2)
        assert res["ok"] is False and res["detail"] == "no pong in 0.2s"
    finally:
        w.stop()
        t.join(2)
        server.close()


def test_test_link_on_a_parked_token_redials_it_once():
    """A 4401 is any failure of Rivendell's token check, a database hiccup
    included — and a parked worker never retries on its own."""
    w = _worker(token="bad")
    w._block_on_token("token rejected by gateway (4401)")
    res = w.test_link()
    assert res["ok"] is None and w._blocked_token is None and w._wake.is_set()


def test_test_link_while_retrying_reports_the_error():
    w = _worker()
    w._set_status("error", "connection refused")
    res = w.test_link()
    assert (res["ok"], res["detail"]) == (False, "connection refused")


# --- Task 7: NEEDS YOU over Telegram --------------------------------------------

def _needs_you(quiet):
    _wait_until(lambda: any(m["text"].startswith("◆ Rivendell job needs you") for m in quiet))
    return next(m for m in quiet if m["text"].startswith("◆ Rivendell job needs you"))


def _held_here(jobs, origin="rivendell:test"):
    """A run of `origin` held on COLOUR, registered so runner.live_job finds it."""
    j = _held_job(sid=_session(origin=origin))
    runner._register(j)
    jobs.append(j)
    return j


def _answer_sent(j):
    return json.loads(j.proc.stdin.lines[-1])["response"]["response"]["message"]


def _token(ping):
    return ping["kb"]["inline_keyboard"][0][0]["callback_data"].split(":")[1]


def test_the_ping_reads_like_the_mockup():
    text, kb = rivendell._question_message(
        {"id": "s1", "title": "Inbox: group meeting action items by client",
         "origin": "rivendell:production"},
        9 * 60 + 5, COLOUR[0], "abc", ["Under “No client”", "Leave them out", "Ask me later"])
    assert text.splitlines()[:3] == [
        "◆ Rivendell job needs you", "Inbox: group meeting action items by client",
        "rivendell · production · running 9m · paused for you"]
    assert text.endswith(COLOUR[0]["question"])
    assert [[b["callback_data"] for b in row] for row in kb["inline_keyboard"]] == [
        ["rq:abc:0", "rq:abc:1"], ["rq:abc:2"]]


def test_a_rivendell_runs_question_pings_with_its_options(quiet, jobs):
    _held_here(jobs)
    ping = _needs_you(quiet)
    assert ping["chat"] == config.DASH_CHAT_ID
    buttons = [b for row in ping["kb"]["inline_keyboard"] for b in row]
    assert [b["text"] for b in buttons] == ["Under “No client”", "Leave them out"]
    assert all(len(b["callback_data"].encode()) <= 64 for b in buttons)


def test_any_other_sessions_question_keeps_the_generic_ping(quiet, jobs):
    _held_here(jobs, origin="dashboard")
    time.sleep(0.1)
    assert not any(m["text"].startswith("◆ Rivendell") for m in quiet)


def test_a_tap_answers_the_live_run(quiet, jobs):
    j = _held_here(jobs)
    assert rivendell.answer_option(_token(_needs_you(quiet)), 1) == "Leave them out"
    assert j.pending == [] and "Leave them out" in _answer_sent(j)


def test_a_question_answered_elsewhere_makes_the_tap_stale(quiet, jobs):
    """Review focus 1: one question, two surfaces. The second answer must say so,
    and never land on whatever the run asks next."""
    j = _held_here(jobs)
    token = _token(_needs_you(quiet))
    assert j.respond("q1", answers=[{"header": "No meeting", "labels": ["Leave them out"]}])
    assert rivendell.answer_option(token, 0) is None


def test_a_text_reply_is_a_free_answer(quiet, jobs):
    j = _held_here(jobs)
    mid = _needs_you(quiet)["mid"]
    _wait_until(lambda: mid in rivendell._ask_msgs)
    assert rivendell.answer_reply(mid, "only the ones from last week") == "only the ones from last week"
    assert "only the ones from last week" in _answer_sent(j)
    assert rivendell.answer_reply(mid, "again") is False         # its question no longer waits
    assert rivendell.answer_reply(-1, "hello") is None           # not a ping: an ordinary prompt


def test_the_option_button_answers_and_edits_the_ping(monkeypatch):
    from bridge import dispatch
    edits, acks = [], []
    monkeypatch.setattr(dispatch, "edit", lambda chat, mid, text, kb=None: edits.append(text))
    monkeypatch.setattr(dispatch, "answer_cb", lambda cid, text="": acks.append(text))
    monkeypatch.setattr(rivendell, "answer_option",
                        lambda token, i: "Leave them out" if (token, i) == ("tok", 1) else None)
    cb = {"id": "cb1", "message": {"chat": {"id": config.DASH_CHAT_ID}, "message_id": 7,
                                   "text": "◆ Rivendell job needs you"}}
    dispatch._question_callback(cb, config.DASH_CHAT_ID, 7, "rq:tok:1")
    assert edits[-1] == ("◆ Rivendell job needs you\n\n"
                         "✓ You answered: Leave them out. The run continues.")
    dispatch._question_callback(cb, config.DASH_CHAT_ID, 7, "rq:gone:0")
    assert acks[-1] == "Already answered." and edits[-1] == "◆ Rivendell job needs you"


def test_a_reply_to_a_ping_never_becomes_a_prompt(monkeypatch):
    from bridge import dispatch
    started, edits = [], []
    monkeypatch.setattr(dispatch, "handle_task", lambda *a: started.append(a))
    monkeypatch.setattr(dispatch, "send", lambda *a, **k: None)
    monkeypatch.setattr(dispatch, "edit", lambda chat, mid, text, kb=None: edits.append((mid, text)))
    monkeypatch.setattr(rivendell, "answer_reply",
                        lambda mid, text: "only last week" if mid == 41 else None)
    dispatch.on_message({"chat": {"id": 555}, "text": "only last week",    # conftest's allowed chat
                         "reply_to_message": {"message_id": 41,
                                              "text": "◆ Rivendell job needs you"}})
    assert started == []
    assert edits == [(41, "◆ Rivendell job needs you\n\n"
                          "✓ You answered: only last week. The run continues.")]


def test_a_reply_to_any_other_message_is_still_a_prompt(monkeypatch):
    """Review focus 4: replying to an ordinary bot message keeps meaning "do this"."""
    from bridge import dispatch, state
    started = []
    monkeypatch.setattr(dispatch, "handle_task", lambda *a: started.append(a))
    monkeypatch.setattr(dispatch, "send", lambda *a, **k: None)
    monkeypatch.setattr(rivendell, "answer_reply", lambda mid, text: None)
    store.init()
    dispatch.on_message({"chat": {"id": 555}, "text": "fix the header",
                         "reply_to_message": {"message_id": 42, "text": "✅ Claude finished"}})
    _wait_until(lambda: started)
    state.release_run(started[0][2]["id"])
    assert started[0][1] == "fix the header"
