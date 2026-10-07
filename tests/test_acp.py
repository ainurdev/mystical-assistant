"""acp.py against tests/fake_acp_agent.py: mapping, cards, Stop, resume vs
load, -32601, -32000, junk stdout, crashes (Review Focus 3 and 4)."""
import json
import os
import sys
import threading
import time
import types

import pytest

from bridge import acp

FAKE = os.path.join(os.path.dirname(__file__), "fake_acp_agent.py")


class FakeJob:
    def __init__(self):
        self.events, self.pending, self.texts, self.todos = [], [], [], []
        self.ctx_tokens = self.cost = self.result = self.error_msg = self.elapsed = None
        self.status, self.boot, self.model = "running", "starting", None
        self.started = self.last_at = time.time()
        self.interrupted = self.timed_out = False
        self.agent_session_id = self.conn = self.turn = self._interrupt_timer = None
        self.awaited = []
    def add(self, ev): self.events.append(ev); self.last_at = time.time()
    def add_pending(self, e): self.pending.append(e)
    def clear_pending(self): self.pending = []
    def awaiting(self, kind): self.awaited.append(kind)
    def types(self): return [e["type"] for e in self.events]


def _run(tmp_path, script, *, sid=None, opts=None, job=None, background=False):
    log = tmp_path / "log.jsonl"
    env = {**os.environ, "FAKE_ACP": json.dumps(script), "FAKE_ACP_LOG": str(log)}
    job = job or FakeJob()
    kw = dict(argv=[sys.executable, FAKE], env=env, cwd=str(tmp_path), label="Fake",
              login_hint="run fake login", text="hello", agent_session_id=sid,
              opts=opts or {}, on_session=lambda s: job.__dict__.setdefault("saved", s))
    if background:
        t = threading.Thread(target=acp.run_turn, args=(job,), kwargs=kw, daemon=True)
        t.start()
        return job, log, t
    acp.run_turn(job, **kw)
    return job, log


def _sent(log):
    return [json.loads(l) for l in open(log)] if os.path.exists(log) else []


def _wait(cond, t=5):
    end = time.time() + t
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.02)
    return False


def test_a_turn_maps_chunks_tools_plans_and_usage(tmp_path):
    job, log = _run(tmp_path, {"turn": [
        {"update": {"sessionUpdate": "agent_thought_chunk", "content": {"type": "text", "text": "hmm"}}},
        {"update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Hel"}}},
        {"update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "lo."}}},
        {"update": {"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Edit a.py",
                    "kind": "edit", "status": "pending", "locations": [{"path": "a.py"}]}},
        {"update": {"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed",
                    "content": [{"type": "diff", "path": "a.py", "oldText": "x\n", "newText": "y\n"}]}},
        {"update": {"sessionUpdate": "plan", "entries": [{"content": "Do it", "status": "pending",
                                                          "priority": "high"}]}},
        {"update": {"sessionUpdate": "usage_update", "used": 1234, "size": 200000,
                    "cost": {"amount": 0.02, "currency": "USD"}}},
        {"update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "Done"}}},
        {"update": {"sessionUpdate": "brand_new_kind"}},
    ]})
    assert job.status == "done" and job.agent_session_id == job.saved
    assert job.types() == ["thinking", "text", "tool", "tool_done", "text", "result"]
    done = job.events[3]
    assert done["id"] == "t1" and "-x" in done["patch"] and "+y" in done["patch"]
    assert job.texts == ["Hello.", "Done"] and job.result == "Done"
    assert job.todos[0]["content"] == "Do it" and job.ctx_tokens == 1234 and job.cost == 0.02
    sent = _sent(log)
    assert sent[0]["method"] == "initialize" and sent[0]["params"]["protocolVersion"] == 1
    assert sent[0]["params"]["clientCapabilities"]["terminal"] is False


def test_permission_card_round_trip_sends_the_agents_own_option_id(tmp_path):
    job, log, t = _run(tmp_path, {"turn": [{"permission": {
        "toolCall": {"toolCallId": "t9", "title": "Run npm test", "rawInput": {"command": "npm test"}},
        "options": [{"optionId": "yes-1", "name": "Allow", "kind": "allow_once"},
                    {"optionId": "no-1", "name": "Deny", "kind": "reject_once"}]}}]},
        background=True)
    assert _wait(lambda: job.pending)
    card = job.pending[0]
    assert card["kind"] == "permission" and card["tool_name"] == "Run npm test"
    assert job.awaited == ["permission"]
    assert acp.answer(job, card["request_id"], True)
    t.join(5)
    replies = [m for m in _sent(log) if m.get("result", {}).get("outcome")]
    assert replies[0]["result"]["outcome"] == {"outcome": "selected", "optionId": "yes-1"}
    assert job.status == "done"


def test_stop_with_a_waiting_card_answers_cancelled_and_ends_stopped(tmp_path):
    job, log, t = _run(tmp_path, {"turn": [{"permission": {
        "toolCall": {"toolCallId": "t1", "title": "rm -rf"},
        "options": [{"optionId": "y", "kind": "allow_once"}]}}, {"wait_cancel": True}],
        "stop": "cancelled"}, background=True)
    assert _wait(lambda: job.pending)
    assert acp.cancel(job, grace=2.0)
    t.join(5)
    assert not t.is_alive() and job.types()[-1] == "stopped" and job.pending == []
    outcomes = [m["result"]["outcome"] for m in _sent(log) if "result" in m and "outcome" in m["result"]]
    assert {"outcome": "cancelled"} in outcomes
    assert any(m.get("method") == "session/cancel" for m in _sent(log))


def test_an_agent_that_ignores_cancel_is_killed_after_grace(tmp_path):
    job, _, t = _run(tmp_path, {"turn": [{"sleep": 30}], "ignore_cancel": True}, background=True)
    assert _wait(lambda: job.conn is not None and job.agent_session_id)
    acp.cancel(job, grace=0.3)
    t.join(5)
    assert not t.is_alive() and job.types()[-1] == "stopped"
    assert job.conn.poll() is not None


def test_resume_is_preferred_and_load_replay_is_dropped(tmp_path):
    replay = [{"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "OLD"}}]
    job, log = _run(tmp_path, {"caps": {"loadSession": True}, "replay": replay,
                               "turn": [{"update": {"sessionUpdate": "agent_message_chunk",
                                                    "content": {"type": "text", "text": "new"}}}]},
                    sid="s-old")
    assert job.texts == ["new"]
    assert "session/load" in [m.get("method") for m in _sent(log)]
    job2, log2 = _run(tmp_path, {"caps": {"loadSession": True, "sessionCapabilities": {"resume": {}}},
                                 "turn": []}, sid="s-old")
    methods = [m.get("method") for m in _sent(log2)]
    assert "session/resume" in methods and "session/load" not in methods


def test_options_are_applied_by_category_and_unknown_values_logged(tmp_path):
    opts = [{"id": "model", "category": "model", "type": "select", "currentValue": "a",
             "options": [{"value": "a", "name": "A"}, {"value": "b", "name": "B"}]}]
    job, log = _run(tmp_path, {"options": opts, "turn": []},
                    opts={"model": "b", "permission_mode": "nope"})
    sets = [m for m in _sent(log) if m.get("method") == "session/set_config_option"]
    assert sets and sets[0]["params"] == {"sessionId": job.agent_session_id,
                                          "configId": "model", "value": "b"}
    assert any(e["type"] == "log" and "nope" in e["text"] for e in job.events)


def test_unknown_agent_requests_get_method_not_found(tmp_path):
    job, log = _run(tmp_path, {"turn": [{"vendor": "cursor/ask_question"}]})
    errs = [m for m in _sent(log) if "error" in m]
    assert errs and errs[0]["error"]["code"] == -32601 and job.status == "done"


def test_auth_required_names_the_login(tmp_path):
    job, _ = _run(tmp_path, {"new_error": {"code": -32000, "message": "Authentication required"}})
    assert job.status == "error" and "run fake login" in job.error_msg


def test_junk_on_stdout_is_skipped(tmp_path):
    job, _ = _run(tmp_path, {"turn": [{"stdout": "Loading config…"},
                                      {"update": {"sessionUpdate": "agent_message_chunk",
                                                  "content": {"type": "text", "text": "ok"}}}]})
    assert job.status == "done" and job.texts == ["ok"]


def test_a_crash_mid_turn_ends_in_error_with_the_stderr_tail(tmp_path):
    job, _ = _run(tmp_path, {"turn": [{"exit": 3}]})
    assert job.status == "error" and job.conn.poll() is not None
    assert "dying with 3" in job.error_msg


def test_a_prompt_error_ends_in_error(tmp_path):
    job, _ = _run(tmp_path, {"prompt_error": {"code": 429, "message": "Quota exhausted"}})
    assert job.status == "error" and "Quota exhausted" in job.error_msg


def test_a_binary_that_does_not_exist_fails_cleanly(tmp_path):
    job = FakeJob()
    acp.run_turn(job, argv=[str(tmp_path / "nope")], env=dict(os.environ), cwd=str(tmp_path),
                 label="Fake", login_hint="", text="x", agent_session_id=None, opts={})
    assert job.status == "error" and "could not start" in job.error_msg


def test_probe_reports_options_and_cleans_up(tmp_path):
    opts = [{"id": "m", "category": "model", "type": "select", "options": [{"value": "a", "name": "A"}]}]
    env = {**os.environ, "FAKE_ACP": json.dumps({"options": opts,
                                                  "caps": {"sessionCapabilities": {"delete": {}}}}),
           "FAKE_ACP_LOG": str(tmp_path / "p.jsonl")}
    out = acp.probe(argv=[sys.executable, FAKE], env=env, label="Fake", login_hint="")
    assert out["ok"] and out["options"] == opts
    assert "session/delete" in [m.get("method") for m in _sent(tmp_path / "p.jsonl")]


# Fix round 1 (review of Task 7).

def _gone(pid):
    """Not running: no such process, or a zombie its new parent hasn't reaped."""
    try:
        with open(f"/proc/{pid}/stat") as f:
            return f.read().rsplit(") ", 1)[1].startswith("Z")
    except OSError:
        return True


def _stub_conn(**kw):
    """Just enough of a Conn for cancel(): an open stream that does nothing."""
    return types.SimpleNamespace(_closed=False, notify=lambda m, p: None, kill=lambda: None,
                                 **kw)


def test_a_hang_names_the_stderr_tail(tmp_path):
    hang = "import sys, time; print('bad config', file=sys.stderr, flush=True); time.sleep(30)"
    conn = acp.Conn([sys.executable, "-c", hang], env=dict(os.environ), cwd=str(tmp_path),
                    on_notify=lambda m, p: None, on_request=acp._refuse)
    try:
        with pytest.raises(acp.AcpError) as e:
            conn.request("initialize", {}, 0.3)
        assert _wait(lambda: conn.stderr_tail)
        assert acp._why(e.value, conn, "Fake", "") == "Fake: initialize: no answer in 0.3s\nbad config"
    finally:
        conn.close(grace=0)


def test_stop_still_lands_when_the_leader_exits_but_a_child_holds_stdout(tmp_path):
    job, _, t = _run(tmp_path, {"turn": [{"orphan": 30}]}, background=True)
    assert _wait(lambda: job.conn is not None and job.conn.proc.poll() is not None)
    child = int((tmp_path / "log.jsonl.child").read_text())
    assert job.conn.poll() is None                  # its stdout is still open: still running
    assert acp.cancel(job, grace=0.3)
    t.join(5)
    assert not t.is_alive() and job.types()[-1] == "stopped"
    assert _wait(lambda: _gone(child))


def test_a_second_stop_reuses_the_first_kill_timer():
    job = FakeJob()
    job.turn, job.conn = acp.Turn(job, "Fake"), _stub_conn()
    assert acp.cancel(job, grace=5)
    first = job._interrupt_timer
    assert acp.cancel(job, grace=5) and job._interrupt_timer is first
    first.cancel()


def test_kill_never_signals_a_reaped_group(tmp_path, monkeypatch):
    conn = acp.Conn([sys.executable, "-c", "pass"], env=dict(os.environ), cwd=str(tmp_path),
                    on_notify=lambda m, p: None, on_request=acp._refuse)
    assert _wait(lambda: conn.poll() is not None)  # exited, reaped, stdout closed
    sent = []
    monkeypatch.setattr(acp.os, "killpg", lambda pgid, sig: sent.append(sig))
    conn.kill()
    conn.close()
    assert sent == []


def test_once_the_turn_ends_there_is_no_new_card_and_no_stop():
    job = FakeJob()
    job.turn, job.conn = acp.Turn(job, "Fake"), _stub_conn()
    job.turn.done = True
    out = job.turn.on_request(7, "session/request_permission", {"toolCall": {"title": "rm"}})
    assert out == {"outcome": {"outcome": "cancelled"}}
    assert job.pending == [] and job.events == [] and job.awaited == []
    assert acp.cancel(job, grace=5) is False and not job.interrupted


def test_stop_answers_a_card_made_while_it_cancels():
    job, replies = FakeJob(), []
    job.turn = acp.Turn(job, "Fake")
    job.conn = _stub_conn(reply=lambda rid, result=None, error=None: replies.append(rid))
    job.pending = [{"request_id": "acp-1", "acp_rpc_id": 1, "options": []}]
    late = {"request_id": "acp-2", "acp_rpc_id": 2, "options": []}
    add = job.add

    def add_then_a_late_card(ev):        # the reader makes a card mid-cancel
        add(ev)
        if len(replies) == 1:
            job.pending.append(late)
    job.add = add_then_a_late_card
    assert acp.cancel(job, grace=5)
    job._interrupt_timer.cancel()
    assert replies == [1, 2] and job.pending == []


def test_a_switch_while_the_session_opens_is_left_for_the_next_turn(tmp_path):
    opts = [{"id": "model", "category": "model", "type": "select",
             "options": [{"value": "a", "name": "A"}, {"value": "b", "name": "B"}]}]
    job, log, t = _run(tmp_path, {"options": opts, "open_delay": 0.5, "turn": []}, sid="s-old",
                       background=True)
    assert _wait(lambda: job.turn is not None and job.turn.replaying)   # session/load in flight
    assert acp.set_options(job, model="b") is False
    t.join(5)
    assert job.status == "done" and "log" not in job.types()
    assert "session/set_config_option" not in [m.get("method") for m in _sent(log)]


def test_an_echoed_api_key_is_masked_in_errors_and_tool_output(tmp_path, monkeypatch):
    key = "sk-test-0123456789abcdef"
    monkeypatch.setenv("OPENAI_API_KEY", key)
    monkeypatch.setenv("SHORT_TOKEN", key[:12])   # longest first, or the key's tail survives
    echo = [{"type": "content", "content": {"type": "text", "text": f"OPENAI_API_KEY={key}"}}]
    job, _ = _run(tmp_path, {"turn": [
        {"update": {"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "env",
                    "kind": "execute"}},
        {"update": {"sessionUpdate": "tool_call_update", "toolCallId": "t1",
                    "status": "completed", "content": echo}},
        {"update": {"sessionUpdate": "agent_message_chunk",
                    "content": {"type": "text", "text": f"your key is {key}"}}}]})
    assert job.status == "done" and job.events[1]["output"] == "OPENAI_API_KEY=***"
    assert key[12:] not in json.dumps(job.events) and key[12:] not in job.result
    job, _ = _run(tmp_path, {"prompt_error": {"code": 401, "message": f"Invalid API key: {key}"}})
    assert job.error_msg == "Fake: Invalid API key: ***"
