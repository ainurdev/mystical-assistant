"""Goal loop: state transitions, the iteration cap, and the MCP tool server."""

import json
import os
import time
from types import SimpleNamespace

import pytest

from bridge import goal_mcp, goals, store

store.init()


@pytest.fixture(autouse=True)
def _queued(monkeypatch):
    """No test here may start a real turn: a nudge lands in this list instead."""
    from bridge import queue_manager
    got = []
    monkeypatch.setattr(queue_manager, "enqueue", lambda sid, **kw: got.append((sid, kw)) or "q1")
    return got


def _session() -> str:
    sid = store.create_session(555, "/goaltest", origin="dashboard")
    return sid["id"] if isinstance(sid, dict) else sid


def test_create_and_get_roundtrip():
    sid = _session()
    assert goals.get(sid) is None
    goals.create(sid, "  ship the thing  ")
    g = goals.get(sid)
    assert g["objective"] == "ship the thing"     # trimmed
    assert g["state"] == goals.ACTIVE
    assert g["iter"] == 0


def test_should_continue_respects_state_and_cap():
    assert goals.should_continue(None) is False
    assert goals.should_continue({"state": goals.ACTIVE, "iter": 0}) is True
    assert goals.should_continue({"state": goals.COMPLETE, "iter": 0}) is False
    assert goals.should_continue({"state": goals.BLOCKED, "iter": 0}) is False
    # The cap is the brake on an unattended loop.
    assert goals.should_continue(
        {"state": goals.ACTIVE, "iter": goals.MAX_ITER - 1}) is True
    assert goals.should_continue(
        {"state": goals.ACTIVE, "iter": goals.MAX_ITER}) is False


def test_mark_complete_stops_the_loop():
    sid = _session()
    goals.create(sid, "refactor the parser")
    goals.mark(sid, goals.COMPLETE, "done in 3 files")
    g = goals.get(sid)
    assert g["state"] == goals.COMPLETE
    assert g["note"] == "done in 3 files"
    assert goals.should_continue(g) is False


def test_mark_without_a_goal_is_a_noop():
    assert goals.mark(_session(), goals.COMPLETE) is None


def test_clear_removes_the_goal():
    sid = _session()
    goals.create(sid, "x")
    goals.clear(sid)
    assert goals.get(sid) is None


def test_corrupt_goal_json_reads_as_no_goal():
    sid = _session()
    with store._connect() as c:                    # noqa: SLF001 — corrupt on purpose
        c.execute("UPDATE sessions SET goal=? WHERE id=?", ("{not json", sid))
    assert store.get_goal(sid) is None


# --- the MCP tool server -----------------------------------------------------

def _rpc(method, params=None, rid=1):
    return goal_mcp._handle(                       # noqa: SLF001 — the unit under test
        {"jsonrpc": "2.0", "id": rid, "method": method, "params": params or {}})


def _bind(sid: str) -> None:
    """Point the tool server at a session the way --mcp-config's env does."""
    row = store.get_session(sid)
    csid = row.get("claude_session_id")
    if not csid:
        csid = "csid-" + sid
        store.set_claude_session_id(sid, csid)
    os.environ["MYSTICAL_CLAUDE_SESSION_ID"] = csid


def test_initialize_and_tools_list():
    init = _rpc("initialize")["result"]
    assert init["protocolVersion"] == goal_mcp.PROTOCOL
    names = {t["name"] for t in _rpc("tools/list")["result"]["tools"]}
    assert names == {"CreateGoal", "UpdateGoal", "GetGoal", "WaitForSession"}


def test_notification_gets_no_response():
    assert goal_mcp._handle({"jsonrpc": "2.0",          # noqa: SLF001
                             "method": "notifications/initialized"}) is None


def test_unknown_method_is_an_error_not_a_crash():
    err = _rpc("nope/nope")["error"]
    assert err["code"] == -32601


def test_tool_call_creates_then_completes_a_goal():
    sid = _session()
    _bind(sid)
    out = _rpc("tools/call", {"name": "CreateGoal",
                              "arguments": {"objective": "green the suite"}})
    assert "green the suite" in out["result"]["content"][0]["text"]
    assert goals.get(sid)["state"] == goals.ACTIVE

    _rpc("tools/call", {"name": "UpdateGoal", "arguments": {"state": "complete"}})
    assert goals.get(sid)["state"] == goals.COMPLETE


def test_get_goal_reports_progress():
    sid = _session()
    _bind(sid)
    _rpc("tools/call", {"name": "CreateGoal", "arguments": {"objective": "abc"}})
    text = _rpc("tools/call", {"name": "GetGoal"})["result"]["content"][0]["text"]
    assert "abc" in text and f"0/{goals.MAX_ITER}" in text


def test_bad_state_is_rejected():
    sid = _session()
    _bind(sid)
    _rpc("tools/call", {"name": "CreateGoal", "arguments": {"objective": "abc"}})
    text = _rpc("tools/call", {"name": "UpdateGoal",
                               "arguments": {"state": "donezo"}})["result"]["content"][0]["text"]
    assert "must be" in text
    assert goals.get(sid)["state"] == goals.ACTIVE      # unchanged


def test_unbound_server_refuses_rather_than_guessing():
    os.environ["MYSTICAL_CLAUDE_SESSION_ID"] = ""
    text = _rpc("tools/call", {"name": "GetGoal"})["result"]["content"][0]["text"]
    assert "No session bound" in text


# --- the HTTP endpoint -------------------------------------------------------

def _dash_handler():
    """Drive the dashboard handler without sockets (mirrors test_fallback_endpoints)."""
    from bridge.dashboard import server as dash
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)   # noqa: SLF001
    return h, box


def test_endpoint_sets_then_clears_a_goal():
    sid = _session()
    h, box = _dash_handler()
    h._post_api(f"/local/sessions/{sid}/goal", {"objective": "make it green"})  # noqa: SLF001
    assert box["code"] == 200
    assert box["obj"]["goal"]["objective"] == "make it green"
    assert goals.get(sid)["state"] == goals.ACTIVE

    h._post_api(f"/local/sessions/{sid}/goal", {"objective": "  "})   # noqa: SLF001
    assert box["obj"]["goal"] is None                 # blank objective abandons it
    assert goals.get(sid) is None


def test_endpoint_refuses_another_chats_session():
    """The ownership check is the trust boundary — a foreign sid must 404, not
    silently set a goal on someone else's session."""
    other = store.create_session(999, "/notyours")
    sid = other["id"] if isinstance(other, dict) else other
    h, box = _dash_handler()
    h._post_api(f"/local/sessions/{sid}/goal", {"objective": "x"})    # noqa: SLF001
    assert box["code"] == 404
    assert goals.get(sid) is None


def test_endpoint_caps_a_runaway_objective():
    sid = _session()
    h, box = _dash_handler()
    h._post_api(f"/local/sessions/{sid}/goal", {"objective": "z" * 5000})  # noqa: SLF001
    assert len(box["obj"]["goal"]["objective"]) == 2000


def test_brief_exposes_the_parsed_goal():
    from bridge.miniapp.server import _session_brief   # noqa: SLF001
    sid = _session()
    goals.create(sid, "carry the objective to the client")
    b = _session_brief(store.get_session(sid))
    assert b["goal"]["objective"] == "carry the objective to the client"
    assert b["goal"]["state"] == goals.ACTIVE          # a dict, not raw JSON


def test_mcp_config_carries_the_session_and_repo_root():
    from bridge import runner
    with open(runner._mcp_config("abc-123"), encoding="utf-8") as f:   # noqa: SLF001
        cfg = json.load(f)
    assert set(cfg["mcpServers"]) == {"goals", "mystical-ux", "verify"}
    env = cfg["mcpServers"]["goals"]["env"]
    assert env["MYSTICAL_CLAUDE_SESSION_ID"] == "abc-123"
    assert os.path.isdir(os.path.join(env["PYTHONPATH"], "bridge"))


# --- title, times, re-arming (design-drafts/goals, A · SHEET) ----------------

def test_create_keeps_a_title_and_when_it_began():
    sid = _session()
    g = goals.create(sid, "x", title="  Ship   it  ")
    assert g["title"] == "Ship it" and g["since"] > 0


def test_title_falls_back_to_the_objective_head():
    assert goals.title_of({"objective": "Multi-org export is built: (1) a ticket"}) == "Multi-org export is built"
    assert goals.title_of({"objective": "Fix v1.2 parsing. Then ship"}) == "Fix v1.2 parsing"
    assert len(goals.title_of({"objective": "word " * 30})) == 60          # capped, with an ellipsis
    assert goals.title_of({"objective": "x: y", "title": "Mine"}) == "Mine"
    assert goals.brief(None) is None
    assert goals.brief({"objective": "a: b"})["title"] == "a"               # every client gets one


def test_nudge_carries_its_count_and_title(_queued):
    sid = _session()
    goals.create(sid, "Green the suite: all of it")
    job = SimpleNamespace(store_session_id=sid, status="done", interrupted=False, runtime=None, chat_id=555)
    assert goals.continue_after_turn(job) is True
    _, kw = _queued[-1]
    assert kw["prompt"].startswith(f"[goal 1/{goals.MAX_ITER}] Green the suite\n")
    assert "Green the suite: all of it" in kw["prompt"] and kw["surface"] == "goal"


def test_mark_stamps_when_and_rearm_counts_on_or_starts_fresh():
    sid = _session()
    goals.create(sid, "x")
    goals.mark(sid, goals.BLOCKED, "need a key")
    g = goals.get(sid)
    assert g["at"] > 0 and g["note"] == "need a key"
    store.set_goal(sid, {**g, "iter": 3})
    g = goals.rearm(sid)
    assert g["state"] == goals.ACTIVE and g["iter"] == 3    # blocked: the count carries on
    assert "note" not in g and "at" not in g
    goals.mark(sid, goals.COMPLETE)
    assert goals.rearm(sid)["iter"] == 0                    # met: Keep going gets a fresh MAX_ITER


def test_edit_keeps_the_count_and_drops_the_old_title():
    sid = _session()
    goals.create(sid, "x", title="Old")
    store.set_goal(sid, {**goals.get(sid), "iter": 2})
    g = goals.edit(sid, "New brief: more")
    assert g["iter"] == 2 and "title" not in g and goals.title_of(g) == "New brief"
    assert goals.edit(sid, "  ") is None


def test_a_reply_rearms_a_blocked_goal_but_bridge_prompts_do_not():
    sid = _session()
    goals.create(sid, "x")
    goals.mark(sid, goals.BLOCKED, "?")
    for bridge_said in ("[goal 2/10] x", "⏮ You were interrupted", "⧖ **y** finished"):
        goals.on_user_turn(sid, bridge_said)
        assert goals.get(sid)["state"] == goals.BLOCKED
    goals.on_user_turn(sid, "use the staging key")
    assert goals.get(sid)["state"] == goals.ACTIVE


def test_your_next_prompt_marks_a_met_goal_seen():
    sid = _session()
    goals.create(sid, "x")
    goals.mark(sid, goals.COMPLETE, "done")
    goals.on_user_turn(sid, "open a pr for it")
    g = goals.get(sid)
    assert g["state"] == goals.COMPLETE and g["seen"] is True


def test_verdict_is_only_the_turn_that_landed_it():
    sid = _session()
    goals.create(sid, "x")
    job = SimpleNamespace(store_session_id=sid, started=time.time() - 5)
    assert goals.verdict(job) is None                       # still active
    goals.mark(sid, goals.COMPLETE)
    assert goals.verdict(job)["state"] == goals.COMPLETE
    assert goals.verdict(SimpleNamespace(store_session_id=sid, started=time.time() + 60)) is None


def test_kick_starts_an_idle_goal_once(_queued, monkeypatch):
    from bridge import state
    sid = _session()
    goals.create(sid, "x")
    monkeypatch.setattr(state, "is_running", lambda s: True)
    assert goals.kick(sid) is False and not _queued         # the running turn nudges when it ends
    monkeypatch.setattr(state, "is_running", lambda s: False)
    assert goals.kick(sid) is True and len(_queued) == 1
    assert goals.get(sid)["iter"] == 1
    goals.mark(sid, goals.COMPLETE)
    assert goals.kick(sid) is False and len(_queued) == 1   # a met goal stays met


def test_set_by_user_refuses_an_agent_session(monkeypatch):
    from bridge import profiles
    sid = _session()
    monkeypatch.setattr(profiles, "claude_only_refusal", lambda s, what: "no goals on Kimi")
    assert goals.set_by_user(store.get_session(sid), "x") == (None, "no goals on Kimi")
    assert goals.get(sid) is None
    assert goals.set_by_user(store.get_session(sid), "  ") == (None, "")   # clearing is always fine


def test_create_goal_tool_takes_a_title():
    sid = _session()
    _bind(sid)
    _rpc("tools/call", {"name": "CreateGoal",
                        "arguments": {"objective": "a long brief", "title": "Short name"}})
    assert goals.get(sid)["title"] == "Short name"


def test_endpoint_edit_done_keep(_queued, monkeypatch):
    from bridge import state
    monkeypatch.setattr(state, "is_running", lambda s: False)
    sid = _session()
    goals.create(sid, "first: brief")
    h, box = _dash_handler()
    h._post_api(f"/local/sessions/{sid}/goal/act", {"action": "edit", "objective": "second: brief"})  # noqa: SLF001
    assert box["obj"]["goal"]["objective"] == "second: brief" and box["obj"]["goal"]["title"] == "second"
    h._post_api(f"/local/sessions/{sid}/goal/act", {"action": "done"})        # noqa: SLF001
    assert goals.get(sid)["state"] == goals.COMPLETE
    h._post_api(f"/local/sessions/{sid}/goal/act", {"action": "keep"})        # noqa: SLF001
    assert goals.get(sid)["state"] == goals.ACTIVE and len(_queued) == 1  # re-opened and started
    h._post_api(f"/local/sessions/{sid}/goal/act", {"action": "nope"})        # noqa: SLF001
    assert box["code"] == 400
    goals.clear(sid)
    h._post_api(f"/local/sessions/{sid}/goal/act", {"action": "done"})        # noqa: SLF001
    assert box["code"] == 409


def test_keep_going_on_a_capped_goal_gets_a_fresh_count():
    sid = _session()
    goals.create(sid, "x")
    store.set_goal(sid, {**goals.get(sid), "iter": goals.MAX_ITER})
    assert goals.should_continue(goals.get(sid)) is False     # the loop stopped at the cap
    assert goals.rearm(sid)["iter"] == 0


def test_miniapp_sets_and_clears_with_goal():
    from bridge.miniapp import server as mini
    sid = _session()
    h = mini.Handler.__new__(mini.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)        # noqa: SLF001
    h._api_session_goal(555, sid, {"objective": "Ship it: today"})        # noqa: SLF001
    assert box["code"] == 200 and box["obj"]["goal"]["title"] == "Ship it"
    h._api_session_goal(555, sid, {"objective": ""})                      # noqa: SLF001
    assert box["obj"]["goal"] is None and goals.get(sid) is None
    h._api_session_goal(999, sid, {"objective": "x"})                     # noqa: SLF001
    assert box["code"] == 404


def test_a_blocked_goal_waits_in_needs_you_until_answered():
    from bridge import notices
    sid = _session()
    goals.create(sid, "x")
    goals.mark(sid, goals.BLOCKED, "need the key")
    notices.emit("goal_blocked", sid, body="need the key")
    assert any(n["kind"] == "goal_blocked" and n["subject"] == sid for n in notices.needs({}))
    assert notices.verb("goal_blocked") == "GOAL NEEDS YOU"
    goals.on_user_turn(sid, "here it is")
    assert not any(n["subject"] == sid for n in notices.needs({}))


def test_the_turn_that_meets_a_goal_says_so_instead_of_done(monkeypatch):
    from bridge import runner
    sid = _session()
    goals.create(sid, "Ship: the export")
    job = runner.Job("j-goal-met", 555, sid)
    job.status = "done"
    goals.mark(sid, goals.COMPLETE, "12 commits")
    said = []
    monkeypatch.setattr(runner, "_notify", lambda chat, text, kb=None, **kw: said.append((text, kw.get("kind"))))
    runner._announce_end(job)                                            # noqa: SLF001
    assert said and said[0][1] == "goal_met"
    assert "Ship" in said[0][0] and "12 commits" in said[0][0]


def test_bot_goal_sets_then_clears(monkeypatch):
    from bridge import dispatch, state
    sent = []
    monkeypatch.setattr(dispatch, "send", lambda chat, text, *a, **k: sent.append(text))
    s = store.create_session(555, state.project_key(555))
    sid = s["id"] if isinstance(s, dict) else s
    monkeypatch.setattr(store, "latest_session", lambda chat, key: store.get_session(sid))
    assert dispatch.handle_fallback_command(555, "/goal Ship it: today") is True
    assert goals.get(sid)["objective"] == "Ship it: today" and sent[-1].startswith("◎ Goal set — Ship it")
    dispatch.handle_fallback_command(555, "/goal")
    assert goals.get(sid) is None and sent[-1] == "Goal cleared."
    assert ("goal", "keep Claude working until it's true · /goal alone clears it") in dispatch.menu()


def test_goal_is_in_the_slash_menu():
    from bridge import commands
    assert any(c["name"] == "goal" and c["scope"] == "builtin" for c in commands.available(None))


def test_a_turn_that_errors_after_the_verdict_still_reports_the_error(monkeypatch):
    from bridge import runner
    sid = _session()
    goals.create(sid, "x")
    job = runner.Job("j-goal-err", 555, sid)
    job.status, job.error_msg = "error", "API error"
    goals.mark(sid, goals.COMPLETE, "done")
    said = []
    monkeypatch.setattr(runner, "_notify", lambda chat, text, kb=None, **kw: said.append(kw.get("kind")))
    runner._announce_end(job)                                            # noqa: SLF001
    assert said == ["failed"]
