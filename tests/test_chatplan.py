"""A chat's plan: what agents write, what's mirrored, and what your changes do."""
import json
import os
import subprocess

import pytest

from bridge import channel, chatplan as cp, config, experimental, gateway, multi_api, store, worklist as wl

CHAT = config.DASH_CHAT_ID


@pytest.fixture
def world(tmp_path, monkeypatch):
    proj = tmp_path / "base" / "shop"
    proj.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(proj)], check=True)
    monkeypatch.setattr(config, "BASE_PATH", str(tmp_path / "base"))
    monkeypatch.setattr(experimental, "_path", lambda: str(tmp_path / "experimental.json"))
    monkeypatch.setattr(experimental, "_cache", None)
    experimental.set_enabled(True)
    store.init()
    said = []
    monkeypatch.setattr(channel, "human_message", lambda chat, to, text: said.append((chat["id"], to, text)))
    s = store.create_session(CHAT, "/shop", cwd=str(proj))
    return {"s": s, "root": os.path.realpath(str(proj)), "said": said}


STEPS = [{"title": "Read the code", "status": "completed", "note": "Two places to change"},
         {"title": "Build it", "status": "in_progress", "detail": "Use `--no-ff`.\n\n- one commit per item",
          "substeps": [{"title": "Branch", "status": "completed"}, {"title": "Merge", "status": "in_progress"}]},
         {"title": "Test it"}]


def plan(world):
    return cp.load(world["root"], world["s"]["id"])


def test_an_agent_writes_its_plan_and_marks_it(world):
    out = cp.tool(world["s"], {"action": "set", "steps": STEPS})
    assert "[x] s1 Read the code" in out and "[>] s2 Build it" in out and "[x] Branch" in out
    p = plan(world)
    assert p["source"] == "tool" and p["steps"][1]["detail"].startswith("Use") and p["steps"][1]["started_at"]
    assert p["steps"][0]["done_at"] and "done_at" not in p["steps"][2]
    cp.tool(world["s"], {"action": "update", "id": "s2", "status": "completed", "note": "Merged"})
    assert plan(world)["steps"][1]["status"] == "completed" and plan(world)["steps"][1]["note"] == "Merged"


def test_rewriting_keeps_ids_and_times_by_title(world):
    cp.tool(world["s"], {"action": "set", "steps": STEPS})
    started = plan(world)["steps"][1]["started_at"]
    cp.tool(world["s"], {"action": "set", "steps": [{"title": "Build it", "status": "in_progress"}, {"title": "New step"}, {"title": "Test it"}]})
    p = plan(world)
    assert [s["id"] for s in p["steps"]] == ["s2", "s4", "s3"] and p["steps"][0]["started_at"] == started
    assert p["steps"][0]["substeps"][0]["title"] == "Branch", "a rewrite that doesn't name sub-steps keeps them"


def test_bad_input_says_what_to_change(world):
    with pytest.raises(cp.Refused):
        cp.tool(world["s"], {"action": "set", "steps": [{"title": " "}]})
    with pytest.raises(cp.Refused, match="Read the plan"):
        cp.tool(world["s"], {"action": "update", "id": "nope"})
    with pytest.raises(cp.Refused):
        cp.tool(world["s"], {"action": "explode"})
    with pytest.raises(cp.Refused):
        cp._path(world["root"], "../../etc")
    assert cp.load(world["root"], "../../etc")["steps"] == [], "a bad id reads as no plan, and nothing outside is opened"


def test_a_task_list_is_mirrored_but_never_over_a_written_plan(world):
    todos = [{"content": "First", "status": "completed"}, {"content": "Second", "status": "in_progress"}]
    cp.from_todos(world["s"]["id"], todos)
    assert [(s["title"], s["status"]) for s in plan(world)["steps"]] == [("First", "completed"), ("Second", "in_progress")]
    assert plan(world)["source"] == "todos"
    cp.tool(world["s"], {"action": "set", "steps": STEPS})
    cp.from_todos(world["s"]["id"], todos)
    assert plan(world)["steps"][0]["title"] == "Read the code"


def test_a_helpers_task_list_isnt_a_chats_plan(world):
    kid = store.create_member(world["s"], name="h", cwd=world["s"]["cwd"], profile_id=None, permission_mode="plan", member={"name": "h"})
    cp.from_todos(kid["id"], [{"content": "x", "status": "pending"}])
    assert not os.path.exists(cp._path(world["root"], kid["id"]))


def test_the_tool_is_a_chats_and_not_a_helpers(world):
    assert "chat_plan" in gateway.tool_names(world["s"])
    assert "chat_plan" not in gateway.tool_names({**world["s"], "parent_session": "x"})


def test_your_change_reaches_the_agent_and_waits_for_it(world):
    sid = world["s"]["id"]
    cp.tool(world["s"], {"action": "set", "steps": STEPS})
    body, status = multi_api.post("worklist/plan/change", {"session_id": sid, "step": "s2", "title": "Build it", "detail": "Use `--no-ff`.\n\n- one commit per item",
                                                           "substeps": [{"title": "Branch"}, {"title": "Merge"}, {"title": "Commit after"}], "why": "Revert on its own"}, CHAT)
    assert status == 200 and body["plan"]["pending"][0]["summary"] == "add a sub-step: Commit after"
    text = world["said"][0][2]
    assert 'step s2 of your plan, "Build it"' in text and "- Commit after" in text and "Why: Revert on its own" in text and "chat_plan" in text
    assert "Description" not in text, "only what changed is spelled out"
    cp.tool(world["s"], {"action": "update", "id": "s2", "substeps": [{"title": "Branch"}, {"title": "Merge"}, {"title": "Commit after"}]})
    assert plan(world)["pending"] == []


@pytest.mark.parametrize("kind,body,want", [
    ("ask", {"step": "s3", "text": "Which tests?"}, "Which tests?"),
    ("sooner", {"step": "s3"}, "do this one next"),
    ("skip", {"step": "s3"}, "skip it"),
    ("whole", {"text": "Commit after each step"}, "About your plan: Commit after each step"),
])
def test_the_other_changes(world, kind, body, want):
    cp.tool(world["s"], {"action": "set", "steps": STEPS})
    _, status = multi_api.post(f"worklist/plan/{kind}", {"session_id": world["s"]["id"], **body}, CHAT)
    assert status == 200 and want in world["said"][0][2]


@pytest.mark.parametrize("kind,body", [("change", {"step": "s1", "title": "Read the code"}), ("ask", {"step": "s1", "text": ""}),
                                       ("whole", {"text": ""}), ("skip", {"step": "gone"}), ("nope", {})])
def test_changes_that_say_nothing_are_refused(world, kind, body):
    cp.tool(world["s"], {"action": "set", "steps": STEPS})
    assert multi_api.post(f"worklist/plan/{kind}", {"session_id": world["s"]["id"], **body}, CHAT)[1] in (400, 404)
    assert world["said"] == []


def test_a_step_can_become_a_task_without_telling_the_agent(world):
    cp.tool(world["s"], {"action": "set", "steps": STEPS})
    body, status = multi_api.post("worklist/plan/task", {"session_id": world["s"]["id"], "step": "s2"}, CHAT)
    assert status == 200 and world["said"] == []
    item = wl.load(world["root"])["items"][0]
    assert item["id"] == body["task"] and item["title"] == "Build it" and "- Branch (done)" in item["detail"] and "--no-ff" in item["detail"]


def test_the_list_route_carries_the_chats_plan(world):
    assert multi_api.get("worklist", {"session": [world["s"]["id"]]}, CHAT)[0]["plan"] is None
    cp.tool(world["s"], {"action": "set", "steps": STEPS})
    got = multi_api.get("worklist", {"session": [world["s"]["id"]]}, CHAT)[0]["plan"]
    assert len(got["steps"]) == 3 and got["source"] == "tool"
    assert multi_api.post("worklist/plan/skip", {"session_id": world["s"]["id"], "step": "s3"}, 999)[1] == 400


def test_the_panel_cant_clear_plans(world):
    from bridge import mystical_dir
    cp.tool(world["s"], {"action": "set", "steps": STEPS})
    with pytest.raises(ValueError):
        mystical_dir.delete(world["root"], "plans")


class Job:
    def __init__(self):
        self.events = []

    def add(self, ev):
        self.events.append(ev)


def test_a_first_plan_is_one_line_with_its_steps(world):
    job = Job()
    cp.tool(world["s"], {"action": "set", "steps": STEPS}, job)
    ev = job.events[0]
    assert ev["type"] == "plan" and ev["first"] and ev["total"] == 3 and ev["done"] == 1
    assert ev["steps"] == ["Read the code", "Build it", "Test it"] and ev["changes"] == []


def test_each_change_says_what_happened(world):
    cp.tool(world["s"], {"action": "set", "steps": STEPS})
    job = Job()
    cp.tool(world["s"], {"action": "set", "steps": [
        {"title": "Read the code", "status": "completed"},
        {"id": "s2", "title": "Build the run branch", "status": "completed",
         "substeps": [{"title": "Branch", "status": "completed"}, {"title": "Merge", "status": "completed"}]},
        {"title": "Write docs", "status": "pending"}]}, job)
    got = [(c["kind"], c["n"], c["title"]) for c in job.events[0]["changes"]]
    assert ("renamed", 2, "Build the run branch") in got and ("done", 2, "Build the run branch") in got
    assert ("added", 3, "Write docs") in got and ("removed", None, "Test it") in got
    assert next(c for c in job.events[0]["changes"] if c["kind"] == "renamed")["was"] == "Build it"
    assert job.events[0]["done"] == 2 and job.events[0]["total"] == 3


def test_sub_steps_and_descriptions(world):
    cp.tool(world["s"], {"action": "set", "steps": STEPS})
    job = Job()
    cp.tool(world["s"], {"action": "update", "id": "s2", "substeps": [{"title": "Branch", "status": "completed"}, {"title": "Merge", "status": "completed"}]}, job)
    cp.tool(world["s"], {"action": "update", "id": "s3", "detail": "Run pytest"}, job)
    cp.tool(world["s"], {"action": "update", "id": "s3", "note": "only a note"}, job)
    kinds = [(c["kind"], c.get("done"), c.get("of")) for e in job.events for c in e["changes"]]
    assert kinds == [("substeps", 2, 2), ("edited", None, None)], "a note alone isn't worth a line"


def test_starting_skipping_and_reopening(world):
    cp.tool(world["s"], {"action": "set", "steps": STEPS})
    job = Job()
    for status in ("in_progress", "skipped", "pending"):
        cp.tool(world["s"], {"action": "update", "id": "s3", "status": status}, job)
    assert [e["changes"][0]["kind"] for e in job.events] == ["started", "skipped", "reopened"]


def test_a_long_rewrite_is_capped(world):
    job = Job()
    cp.tool(world["s"], {"action": "set", "steps": [{"title": f"one {i}"} for i in range(5)]})
    cp.tool(world["s"], {"action": "set", "steps": [{"title": f"two {i}"} for i in range(20)]}, job)
    ev = job.events[0]
    assert len(ev["changes"]) == cp.MAX_CHANGES and ev["more"] == 25 - cp.MAX_CHANGES


def test_a_mirrored_task_list_shows_in_the_chat_too(world):
    job = Job()
    cp.from_todos(world["s"]["id"], [{"content": "A", "status": "in_progress"}], job)
    cp.from_todos(world["s"]["id"], [{"content": "A", "status": "completed"}], job)
    assert job.events[0]["first"] and job.events[1]["changes"][0]["kind"] == "done"
    cp.from_todos(world["s"]["id"], [{"content": "A", "status": "completed"}], job)
    assert len(job.events) == 2, "the same list again says nothing"
