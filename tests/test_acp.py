"""acp.py against tests/fake_acp_agent.py: mapping, cards, Stop, resume vs
load, -32601, -32000, junk stdout, crashes (Review Focus 3 and 4)."""
import json
import os
import sys
import threading
import time

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
