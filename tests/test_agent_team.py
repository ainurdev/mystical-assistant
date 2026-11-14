"""A chat's sub-agents as a team: the tree, who's finished, the conversation, and edits as diffs."""
import json
import os
import time

import pytest

from bridge import agent_team as T, agents, runner, rules, transcript_jsonl

SID = "sess-1"


def rec(kind, content, at="2026-11-14T00:00:00Z", **kw):
    # Compact, as Claude Code writes them: the scanner skips records on substrings before parsing any.
    return json.dumps({"type": kind, "timestamp": at, "message": {"role": kind, "content": content, **kw.pop("msg", {})}, **kw}, separators=(",", ":"))


def use(name, inp, tid="t1"):
    return [{"type": "tool_use", "id": tid, "name": name, "input": inp}]


@pytest.fixture
def world(tmp_path, monkeypatch):
    main = tmp_path / f"{SID}.jsonl"
    sub = tmp_path / SID / "subagents"
    sub.mkdir(parents=True)
    monkeypatch.setattr(transcript_jsonl, "find_transcript", lambda sid: str(main))
    monkeypatch.setattr(agents, "_session_alive", lambda s: True)
    monkeypatch.setattr(T, "_scans", {})
    monkeypatch.setattr(agents, "_completed_cache", {})

    def agent(aid, lines, **meta):
        (sub / f"agent-{aid}.meta.json").write_text(json.dumps({"agentType": "general-purpose", "description": aid, "spawnDepth": 1, "requestShape": "background", **meta}))
        (sub / f"agent-{aid}.jsonl").write_text("\n".join(lines) + "\n")
    main.write_text("\n".join([
        rec("user", "do it all with subagents"),
        rec("assistant", use("Agent", {"description": "lead", "prompt": "Lead the lines"}, "tu-lead")),
        rec("user", [{"type": "tool_result", "tool_use_id": "tu-lead", "content": "Async agent launched"}]),
        rec("user", "⧖ Your checks finished."),
    ]) + "\n")
    agent("lead", [rec("user", "Lead the lines", isSidechain=True),
                   rec("assistant", use("Agent", {"description": "kid", "prompt": "Write the dare lines"}, "tu-kid"), isSidechain=True),
                   rec("assistant", use("SendMessage", {"to": "kid", "summary": "rule", "message": "Never name the player"}), isSidechain=True)],
          toolUseId="tu-lead")
    agent("kid", [rec("user", "Write the dare lines", isSidechain=True),
                  rec("assistant", use("Edit", {"file_path": "/r/lines.rpy", "old_string": "a\nthem \"No.\"\nz", "new_string": "a\nthem \"Not tonight.\"\nreturn\nz"}), isSidechain=True),
                  rec("user", [{"type": "tool_result", "tool_use_id": "t1", "content": "x" * 5000}], isSidechain=True),
                  rec("assistant", use("SubagentHandback", {"message": "All 40 lines are written."}), isSidechain=True)],
          toolUseId="tu-kid", parentAgentId="lead", spawnDepth=2, requestShape="foreground", finished=True)
    return {"session": {"id": "x", "claude_session_id": SID}, "agent": agent, "sub": sub, "main": main}


def test_the_tree_and_who_is_finished(world):
    r = T.team(world["session"])
    rows = {a["id"]: a for a in r["agents"]}
    assert rows["agent-kid"]["parent"] == "agent-lead" and rows["agent-lead"]["parent"] == "main" and r["depth"] == 2
    assert rows["agent-kid"]["status"] == "done", "a sub-agent's sub-agent is done when the CLI says so, though the main chat never saw its result"
    assert rows["agent-lead"]["status"] == "running" and rows["agent-lead"]["now"].startswith("Sent a message")
    assert agents.session_agents(world["session"])["running"] == 1, "and the sidebar's count agrees"


def test_the_conversation_says_who_told_whom(world):
    r = T.team(world["session"])
    got = [(m["kind"], m["from"], m["to"], m["text"]) for m in r["messages"]]
    assert ("you", "you", "main", "do it all with subagents") in got
    assert ("brief", "main", "agent-lead", "Lead the lines") in got and ("brief", "agent-lead", "agent-kid", "Write the dare lines") in got
    assert ("message", "agent-lead", "agent-kid", "Never name the player") in got
    assert ("report", "agent-kid", "agent-lead", "All 40 lines are written.") in got
    assert not any("checks finished" in m["text"] for m in r["messages"]), "what Mystical told the agent isn't you"


def test_only_new_bytes_are_read(world, monkeypatch):
    T.team(world["session"])
    path = str(world["sub"] / "agent-lead.jsonl")
    before = T._scans[path]["offset"]
    with open(path, "a") as f:
        f.write(rec("assistant", use("Bash", {"command": "ls", "description": "List files"}), isSidechain=True) + "\n")
    seen = []
    real = open

    def spy(p, *a, **k):
        f = real(p, *a, **k)
        if str(p) == path:
            seek = f.seek
            f.seek = lambda n, *x: (seen.append(n), seek(n, *x))[1]
        return f
    monkeypatch.setattr("builtins.open", spy)
    r = T.team(world["session"])
    assert seen == [before] and next(a for a in r["agents"] if a["id"] == "agent-lead")["now"] == "Ran List files"


def test_an_agent_that_went_quiet_after_its_last_words_is_done(world):
    old = "2026-11-13T00:00:00Z"
    world["agent"]("old", [rec("user", "go", at=old, isSidechain=True), rec("assistant", [{"type": "text", "text": "Finished."}], at=old, isSidechain=True, msg={"stop_reason": "end_turn"})])
    world["agent"]("err", [rec("user", "go", isSidechain=True), rec("assistant", [{"type": "text", "text": "API Error: overloaded"}], at=old, isSidechain=True, isApiErrorMessage=True, msg={"stop_reason": "end_turn"})], finished=True)
    r = T.team(world["session"])
    rows = {a["id"]: a["status"] for a in r["agents"]}
    assert rows["agent-old"] == "done" and rows["agent-err"] == "failed"
    kinds = {(m["kind"], m["from"]) for m in r["messages"]}
    assert ("report", "agent-old") in kinds and ("problem", "agent-err") in kinds, "an agent with no handback reports with its last words"


def test_one_agent_up_close_shows_its_edit_as_a_diff(world):
    d = T.agent(world["session"], "agent-kid")
    assert d["brief"] == "Write the dare lines" and d["report"] == "All 40 lines are written."
    edit = next(s for s in d["steps"] if s["kind"] == "edit")
    assert edit["text"] == "Edited lines.rpy" and edit["diff"]["added"] == 2 and edit["diff"]["removed"] == 1
    assert [(x["k"], x["t"]) for x in edit["diff"]["lines"]] == [("c", "a"), ("r", 'them "No."'), ("a", 'them "Not tonight."'), ("a", "return"), ("c", "z")]
    assert T.agent(world["session"], "main")["steps"][0]["kind"] == "agent"
    assert T.agent(world["session"], "../../etc/passwd") is None and T.agent(world["session"], "agent-nope") is None


def test_a_new_file_and_a_long_edit(world):
    assert T._diff("Write", {"file_path": "/r/a.py", "content": "one\ntwo\n"}) == {"path": "/r/a.py", "added": 2, "removed": 0, "lines": [{"k": "a", "t": "one"}, {"k": "a", "t": "two"}], "more": 0, "new": True}
    long = T._diff("Edit", {"file_path": "f", "old_string": "", "new_string": "\n".join(str(i) for i in range(40))})
    assert len(long["lines"]) == T.DIFF_LINES and long["more"] == 40 - T.DIFF_LINES and T._diff("Bash", {}) is None


def test_a_chat_without_agents_answers_empty():
    assert T.team({"id": "x"})["agents"] == [] and T.agent({"id": "x"}, "main") is None


class Job:
    def __init__(self):
        self.events, self.bash_cmds, self.sub_cmds, self.open_tools = [], {}, [], {}
        self.boot, self.session_id, self.store_session_id, self.status, self.last_at = None, "s", None, "running", time.time()
        self.todos, self.task_status, self.clip_meta, self.read_paths = [], {}, {}, {}

    def add(self, ev):
        self.events.append(ev)


def test_a_sub_agents_steps_stay_out_of_the_chat(monkeypatch):
    job = Job()
    sub_use = {"type": "assistant", "session_id": "s", "parent_tool_use_id": "tu-lead", "message": {"content": use("Bash", {"command": "./strings.sh test"})}}
    sub_res = {"type": "user", "session_id": "s", "parent_tool_use_id": "tu-lead", "message": {"content": [{"type": "tool_result", "tool_use_id": "t1", "content": "ok"}]}}
    runner._handle_event(job, sub_use)
    runner._handle_event(job, sub_res)
    assert job.events == [] and job.sub_cmds == ["./strings.sh test"]
    assert rules._TEST_CMD.search(job.sub_cmds[0]), "and a sub-agent's test run still counts as tested"


def test_a_held_plan_line_goes_in_after_the_tools_result():
    job = Job()
    job.after_tool = [{"type": "plan"}]
    job.open_tools = {"t1": ("mcp__mystical__chat_plan", time.time()), "t2": ("Bash", time.time())}
    res = lambda tid: {"type": "user", "session_id": "s", "message": {"content": [{"type": "tool_result", "tool_use_id": tid, "content": "ok"}]}}
    job.id = "j"
    runner._handle_event(job, res("t1"))
    assert [e["type"] for e in job.events] == ["tool_done"], "another call is still open"
    runner._handle_event(job, res("t2"))
    assert [e["type"] for e in job.events] == ["tool_done", "tool_done", "plan"]
