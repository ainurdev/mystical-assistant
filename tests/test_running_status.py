"""Unit tests for the unified session-status merge (runner._build_status).
Run: `python tests/test_running_status.py`
"""

import json
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ["BASE_PATH"] = tempfile.mkdtemp()
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ["BRIDGE_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")

from bridge import machine, runner, transcript_jsonl  # noqa: E402


def test_bridge_running_session_is_working():
    status = runner._build_status(
        bridge_running=["b1"], awaiting=[],
        jobs=[{"session_id": "b1", "activity": {"label": "Bash: ls"}}],
        external=[], native_snap={})
    assert status["b1"]["state"] == "working"
    assert status["b1"]["source"] == "bridge"
    assert status["b1"]["label"] == "Bash: ls"


def test_bridge_awaiting_takes_precedence_over_running():
    status = runner._build_status(
        bridge_running=["b1"],
        awaiting=[{"session_id": "b1", "kind": "question"}],
        jobs=[], external=[], native_snap={})
    assert status["b1"]["state"] == "awaiting"
    assert status["b1"]["kind"] == "question"


def _finished_job(sid: str, result: str, *, needs: str | None = None,
                  status: str = "done", ago: float = 0.0):
    """A finished job in the registry, as _build_status sees it. `ago` backdates
    when the turn ended, for the ASK time-out."""
    job = runner.Job.__new__(runner.Job)
    job.store_session_id, job.result, job.texts = sid, result, []
    job.status, job.started, job.tail_needs = status, time.time() - ago, needs
    job.last_at, job.ask_dismissed = time.time() - ago, False
    runner._jobs[sid + "-job"] = job


def test_turn_that_ended_on_a_question_is_asking():
    runner._jobs.clear()
    _finished_job("q1", "Wired the importer.\nWant me to add the two screens too?")
    status = runner._build_status(bridge_running=[], awaiting=[], jobs=[],
                                  external=[], native_snap={})
    assert status["q1"]["state"] == "asking"
    assert status["q1"]["label"] == "Want me to add the two screens too?"
    runner._jobs.clear()


def test_asking_never_outranks_a_live_turn_or_a_real_block():
    runner._jobs.clear()
    _finished_job("q2", "Done. Want the docs too?")
    _finished_job("q3", "Which branch should this land on?", needs="pick a branch")
    status = runner._build_status(bridge_running=["q2"], awaiting=[], jobs=[],
                                  external=[], native_snap={})
    assert status["q2"]["state"] == "working"     # a new turn is already going
    assert status["q3"]["state"] == "awaiting"    # blocked beats merely asking
    runner._jobs.clear()


def test_asking_ages_out_instead_of_waiting_forever():
    """An unanswered question you walked away from stops counting as WAITING."""
    runner._jobs.clear()
    _finished_job("q7", "Written and tested. Commit it now?", ago=runner._ASK_TTL + 60)
    _finished_job("q8", "Written and tested. Commit it now?")
    status = runner._build_status(bridge_running=[], awaiting=[], jobs=[],
                                  external=[], native_snap={})
    assert "q7" not in status
    assert status["q8"]["state"] == "asking"
    runner._jobs.clear()


def test_declarative_ending_and_error_turns_are_not_asking():
    runner._jobs.clear()
    _finished_job("q4", "Shipped it. Tests pass.")
    _finished_job("q5", "Crashed. Retry?", status="error")
    # A paragraph that happens to end in "?" is rhetoric, not an ask.
    _finished_job("q6", "x" * 300 + "?")
    status = runner._build_status(bridge_running=[], awaiting=[], jobs=[],
                                  external=[], native_snap={})
    assert not [s for s in ("q4", "q5", "q6") if s in status]
    runner._jobs.clear()


def test_native_working_session_in_status_and_annotates_external():
    external = [{"session_id": "n1", "source": "vscode"}]
    status = runner._build_status(
        bridge_running=[], awaiting=[], jobs=[],
        external=external,
        native_snap={"n1": {"state": "working", "label": "thinking…", "last_write": 1.0}})
    assert status["n1"]["state"] == "working"
    assert status["n1"]["source"] == "native"
    assert external[0]["state"] == "working"          # external row annotated in place


def test_idle_native_session_not_in_status_but_annotated():
    external = [{"session_id": "n2", "source": "vscode"}]
    status = runner._build_status(
        bridge_running=[], awaiting=[], jobs=[],
        external=external,
        native_snap={"n2": {"state": "idle", "label": None, "last_write": 1.0}})
    assert "n2" not in status
    assert external[0]["state"] == "idle"


def test_unknown_external_session_defaults_to_idle():
    external = [{"session_id": "n3", "source": "vscode"}]
    runner._build_status(bridge_running=[], awaiting=[], jobs=[],
                         external=external, native_snap={})
    assert external[0]["state"] == "idle"


def test_recently_active_native_session_is_live_not_idle():
    # Alive + transcript touched a few seconds ago but not writing *right now*:
    # shows LIVE (current session, briefly paused) instead of flat IDLE.
    external = [{"session_id": "n4", "source": "vscode", "last_active": time.time() - 5}]
    status = runner._build_status(bridge_running=[], awaiting=[], jobs=[],
                                  external=external, native_snap={})
    assert status["n4"]["state"] == "live"
    assert status["n4"]["source"] == "native"
    assert external[0]["state"] == "live"


def test_working_native_session_beats_live_recency():
    external = [{"session_id": "n5", "source": "vscode", "last_active": time.time() - 5}]
    status = runner._build_status(
        bridge_running=[], awaiting=[], jobs=[], external=external,
        native_snap={"n5": {"state": "working", "label": "Bash", "last_write": 1.0}})
    assert status["n5"]["state"] == "working"


def test_stale_native_session_is_idle():
    external = [{"session_id": "n6", "source": "vscode",
                 "last_active": time.time() - runner._LIVE_WINDOW - 30}]
    status = runner._build_status(bridge_running=[], awaiting=[], jobs=[],
                                  external=external, native_snap={})
    assert "n6" not in status
    assert external[0]["state"] == "idle"


def _agents_fixture(sid: str, *, finished: bool) -> str:
    """~/.claude/projects-style tree: main transcript spawning one Task, plus that
    subagent's files. finished=True writes the Task's tool_result (agent done)."""
    root = tempfile.mkdtemp()
    proj = os.path.join(root, "-tmp-proj")
    sub = os.path.join(proj, sid, "subagents")
    os.makedirs(sub, exist_ok=True)
    # A session listed by machine.list_running() is alive by construction; these
    # rows are injected straight into _build_status, so register the pid the
    # agent liveness check looks for.
    machine.SESSIONS_DIR = tempfile.mkdtemp()
    with open(os.path.join(machine.SESSIONS_DIR, f"{os.getpid()}.json"), "w") as f:
        json.dump({"pid": os.getpid(), "sessionId": sid, "cwd": "/tmp/proj"}, f)
    with open(os.path.join(proj, sid + ".jsonl"), "w") as f:
        f.write(json.dumps({"type": "assistant", "message": {"role": "assistant",
                "content": [{"type": "tool_use", "id": "T1", "name": "Task",
                             "input": {"description": "d"}}]}}) + "\n")
        if finished:
            f.write(json.dumps({"type": "user", "message": {"role": "user",
                    "content": [{"type": "tool_result", "tool_use_id": "T1",
                                 "content": "ok"}]}}) + "\n")
    with open(os.path.join(sub, "agent-a1.meta.json"), "w") as f:
        json.dump({"agentType": "Explore", "description": "d", "toolUseId": "T1"}, f)
    open(os.path.join(sub, "agent-a1.jsonl"), "w").close()
    return root


def _status_for(sid: str, root: str) -> dict:
    """_build_status for one long-quiet native session, agents read from `root`."""
    external = [{"session_id": sid, "source": "vscode",
                 "last_active": time.time() - runner._LIVE_WINDOW - 30}]
    orig = transcript_jsonl.PROJECTS_DIR
    transcript_jsonl.PROJECTS_DIR = root
    try:
        status = runner._build_status(bridge_running=[], awaiting=[], jobs=[],
                                     external=external, native_snap={})
    finally:
        transcript_jsonl.PROJECTS_DIR = orig
    return {"status": status, "row": external[0]}


def test_quiet_native_session_with_running_agents_is_working():
    # The parent writes nothing while a subagent runs — without the agent check
    # this session would age out of LIVE into IDLE mid-fan-out.
    sid = "aaaaaaaa-1111-2222-3333-444444444444"
    out = _status_for(sid, _agents_fixture(sid, finished=False))
    assert out["status"][sid]["state"] == "working"
    assert out["status"][sid]["label"] == "1 agent working"
    assert out["row"]["state"] == "working"


def test_quiet_native_session_with_finished_agents_is_idle():
    sid = "bbbbbbbb-1111-2222-3333-444444444444"
    out = _status_for(sid, _agents_fixture(sid, finished=True))
    assert sid not in out["status"]
    assert out["row"]["state"] == "idle"


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items())
           if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL {fn.__name__}: {type(e).__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    raise SystemExit(1 if failed else 0)
