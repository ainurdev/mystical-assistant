"""flow-gear #05: NEXT, TICKETS, APPROVE BEFORE BUILD and the REVIEW after MERGE are a
flow's own (bridge/flowsettings.py), read by the step engine, the ticket scheduler and
the router. Run: python -m pytest tests/test_flow_next_tickets.py -v"""

from types import SimpleNamespace

import pytest

from bridge import aifeatures, flowsettings, paths, store
from test_paths import flow_session, server, state_dir  # noqa: F401 — fixtures
from test_tickets import make_set  # noqa: F401 — fixture

store.init()


@pytest.fixture
def router_only(monkeypatch):
    """SKILL PATHS on and every old switch off: anything these tests see on is the flow's own."""
    monkeypatch.setattr(aifeatures, "enabled", lambda key: key == "router")


@pytest.fixture
def queue(monkeypatch):
    from bridge import queue_manager
    q = SimpleNamespace(items=[])
    monkeypatch.setattr(queue_manager, "enqueue", lambda sid, **kw: q.items.append(dict(kw, sid=sid)))
    return q


def _set(flow, key, value, **kw):
    flowsettings.change({"flow": flow, "key": key, "value": value, **kw})


def _job(sid, turn):
    return SimpleNamespace(store_session_id=sid, id=turn, status="done", interrupted=False,
                           runtime=None, chat_id=1)


def test_a_flow_on_hold_waits_while_another_flow_starts_its_next_step(state_dir, router_only, queue):
    _set("fix", "next", True)            # FIX: AUTO
    _set("build", "next", False)         # BUILD: HOLD
    paths.set_path("b", "build", "new", "claude")
    paths.set_path("f", "fix", "broken", "claude")
    assert paths.step_done("b", "t1") == "spec" and paths.step_done("f", "t1") == "retro"
    assert paths.continue_after_turn(_job("b", "t1")) is False                  # held: its step waits
    assert paths.continue_after_turn(_job("f", "t1")) is True                   # the other flow's starts
    assert [(i["sid"], i["prompt"]) for i in queue.items] == [("f", "/mattpocock-skills:retro")]
    assert paths.get("b")["auto"] is False and paths.get("f")["auto"] is True


def test_the_flow_chips_override_still_wins_over_the_flows_next(state_dir, router_only):
    _set("build", "next", False)
    paths.set_path("s", "build", "new", "claude")
    paths.set_option("s", "nextstep", True)
    assert paths.get("s")["auto"] is True                                       # this session: AUTO
    _set("build", "next", True)
    paths.set_option("s", "nextstep", False)
    assert paths.get("s")["auto"] is False                                      # this session: HOLD
    paths.reset("s")
    assert paths.get("s")["auto"] is True                                       # back to BUILD's


def test_the_review_after_merge_is_the_flows_tickets_and_review_step(state_dir, router_only):
    for fl in ("build", "refactor"):
        _set(fl, "tickets", True)
    _set("build", "step", True, step="review")
    _set("refactor", "step", False, step="review")
    paths.set_path("b", "build", "x", "claude")
    paths.set_path("r", "refactor", "x", "claude")
    assert "review" in [st[0] for st in paths.stations("b")]   # REVIEW AFTER MERGE (off) is not read
    assert "review" not in [st[0] for st in paths.stations("r")]
    _set("build", "tickets", False)
    assert "review" not in [st[0] for st in paths.stations("b")]               # no set merges, so no review


def test_a_build_step_starts_ticket_sessions_only_with_its_flows_tickets_on(state_dir, router_only, monkeypatch):
    from bridge import tickets
    calls = []
    monkeypatch.setattr(tickets, "start_build", lambda sid: calls.append(sid) or "")
    _set("build", "tickets", True)
    _set("refactor", "tickets", False)
    for sid, path in (("b", "build"), ("r", "refactor")):
        paths.set_path(sid, path, "x", "claude")
        assert paths._start(sid, "build") is (sid == "b")  # noqa: SLF001
    assert calls == ["b"]


def _build(s):
    """BUILD of the set's folder: the tickets were written before this flow began."""
    from bridge import tickets
    return tickets.start_build(s.flow, s.folder)


def test_a_set_waits_for_approval_as_the_flow_that_started_it_says(make_set):
    s = make_set({"01": None}, build=False)
    paths.set_path(s.flow, "refactor", "untangle", "claude")
    _set("refactor", "approve", True)
    _set("build", "approve", False)
    assert _build(s) == "" and s.state["status"] == "approve" and s.starts == []


def test_the_scheduler_reads_the_flow_that_started_the_set(make_set):
    s = make_set({"01": None, "02": "#01"}, build=False)
    paths.set_path(s.flow, "refactor", "untangle", "claude")
    _set("refactor", "approve", False)
    assert _build(s) == "" and s.running() == ["01"]
    paths.set_path(s.flow, "build", "something else", "you")   # the flow is replaced: the set is still REFACTOR's
    _set("build", "tickets", True)
    _set("refactor", "tickets", False)
    s.finish("01")
    assert s.status("02") == "queued" and s.running() == []                     # REFACTOR's TICKETS off: nothing new
    _set("refactor", "tickets", True)
    from bridge import tickets
    tickets.tick(s.folder)
    assert s.running() == ["02"]


def test_the_routers_tickets_is_the_sessions_flows_or_builds(server, flow_session, router_only, monkeypatch):
    from bridge import route
    seen = []
    monkeypatch.setattr(route, "pick", lambda text, **kw: seen.append(kw["ticketruns"]))
    _set("build", "tickets", True)
    _set("refactor", "tickets", False)
    server.post("/local/route", {"text": "go on", "session": flow_session})       # no flow: BUILD's
    paths.set_path(flow_session, "refactor", "untangle", "claude")
    server.post("/local/route", {"text": "go on", "session": flow_session})
    assert seen == [True, False]
