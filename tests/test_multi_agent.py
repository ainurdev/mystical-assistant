"""Multi-agent chats, behind the EXPERIMENTAL switch: the switch itself, provider
switching, the gateway, delegation rules, the channel and merging. Against the real
store and, where a turn runs, tests/fake_acp_agent.py (docs/superpowers/plans/
multi-agent-chats.md)."""
import json
import os
import subprocess
import sys
import threading
import time

import pytest

from bridge import (acp_agents, agent_caps, agent_tree, channel, config, experimental, gateway, handoff,
                    learn, mcp_share, multi_api, profiles, project_config, prompt_pack, pushgate, runner,
                    skill_share, store, taskcheck, titler)
from bridge.dashboard import server as dash
from bridge.miniapp import server as mini

store.init()
CHAT = config.DASH_CHAT_ID
FAKE = os.path.join(os.path.dirname(__file__), "fake_acp_agent.py")


def chunk(text):
    return {"update": {"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}}}


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(profiles, "PATH", str(tmp_path / "profiles.json"))
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "project_config.json"))
    monkeypatch.setattr(experimental, "_path", lambda: str(tmp_path / "experimental.json"))
    monkeypatch.setattr(experimental, "_cache", None)
    monkeypatch.setattr(mcp_share, "_FILE", str(tmp_path / "share.json"))
    monkeypatch.setattr(mcp_share, "_tool_cache", {})
    monkeypatch.setattr(skill_share, "_FILE", str(tmp_path / "skills.json"))
    monkeypatch.setattr(skill_share, "_HOME", str(tmp_path / "home"))
    monkeypatch.setattr(pushgate, "_DIR", str(tmp_path / "githooks"))
    monkeypatch.setattr(acp_agents, "PRESETS", (
        {"id": "fake", "label": "Fake", "cmd": [sys.executable, FAKE], "key_env": None,
         "home_env": None, "key_required": False, "login": "fake login", "install": "n/a",
         "env": {"FAKE_ACP_LOG": str(tmp_path / "log.jsonl")}},))
    monkeypatch.setattr(acp_agents, "_resolve", lambda name: name)
    monkeypatch.setattr(acp_agents, "ACCOUNTS_FILE", str(tmp_path / "agent-accounts.json"))
    monkeypatch.setattr(acp_agents, "OPTIONS_FILE", str(tmp_path / "acp-options.json"))
    monkeypatch.setattr(acp_agents, "HOMES", str(tmp_path / "agent-homes"))
    monkeypatch.setattr(acp_agents, "_options", {})
    monkeypatch.setattr(runner, "_jobs", {})
    monkeypatch.setattr(store, "default_disabled_tools", lambda: [])
    monkeypatch.setattr(runner, "_notify", lambda *a, **k: None)
    for mod in (titler, learn):
        monkeypatch.setattr(mod, "kick", lambda *a, **k: None)
    monkeypatch.setattr(runner, "_announce_end", lambda job: None)
    monkeypatch.setattr(runner, "_ensure_journal_thread", lambda: None)
    monkeypatch.setattr(runner, "_base_cmd", _no_claude)
    yield
    end = time.time() + 10
    while time.time() < end and any("_run_streaming" in t.name for t in threading.enumerate()):
        time.sleep(0.02)
    runner._drain_journal()


def _no_claude(*a, **k):
    raise AssertionError("a test reached the Claude path")


@pytest.fixture
def on():
    experimental.set_enabled(True)


def _script(monkeypatch, script):
    p = dict(acp_agents.PRESETS[0])
    p["env"] = {**p["env"], "FAKE_ACP": json.dumps(script)}
    monkeypatch.setattr(acp_agents, "PRESETS", (p,))


def _session(tmp_path, *, agent="fake", prompts=(), **fields):
    pid = None
    if agent:
        pid = profiles.create({"name": f"P{time.time_ns()}", "agent": agent})["id"]
    s = store.create_session(CHAT, "/p", cwd=str(tmp_path), profile_id=pid)
    for i, text in enumerate(prompts):
        store.start_turn(s["id"], f"{s['id']}-{i}", text, [], runtime="acp:fake" if agent else None)
        store.finish_turn(f"{s['id']}-{i}", "done", None, 1)
    for k, v in fields.items():
        store.set_session_field(s["id"], k, v)
    return store.get_session(s["id"])


def _wait(job, secs=15):
    assert job is not None
    assert job.exited.wait(secs), "the turn never ended"
    runner._drain_journal()


def _repo(path):
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    subprocess.run(["git", "-C", str(path), "config", "user.email", "t@t"], check=True)
    subprocess.run(["git", "-C", str(path), "config", "user.name", "t"], check=True)
    (path / "a.txt").write_text("one\n")
    subprocess.run(["git", "-C", str(path), "add", "."], check=True)
    subprocess.run(["git", "-C", str(path), "commit", "-qm", "x"], check=True)


# ---- the switch ---------------------------------------------------------------

def test_off_by_default_and_the_routes_say_so(tmp_path):
    assert experimental.enabled() is False
    assert multi_api.get("experimental", {}, CHAT)[0]["enabled"] is False
    assert multi_api.get("tree", {}, CHAT)[1] == 409
    assert multi_api.post("channel/hold", {}, CHAT)[1] == 409
    multi_api.post("experimental", {"enabled": True}, CHAT)
    assert experimental.enabled() is True
    assert multi_api.get("tree", {}, CHAT)[1] == 200


def test_off_keeps_the_old_refusals_and_the_old_brief(tmp_path):
    s = _session(tmp_path, agent=None, prompts=("hi",))
    p = profiles.create({"name": "Kimi-ish", "agent": "fake"})
    out, code = profiles.bind(s, p["id"])
    assert code == 409 and "new session" in out["error"]
    assert "caps" not in mini._session_brief(s)
    assert "helpers" not in mini._session_brief(s)
    # Nothing to do, whatever's asked.
    assert channel.refusal(s).startswith("Helpers are an experimental")
    assert gateway.eligible(s) is False
    assert gateway.session_of(gateway.issue(s["id"])) is None


def test_off_agent_turn_sends_the_old_prompt_and_no_servers(tmp_path, monkeypatch):
    _script(monkeypatch, {"turn": [chunk("ok")]})
    s = _session(tmp_path)
    job = runner.start_streaming_job(CHAT, "hello", [], project=str(tmp_path), session_id=s["id"])
    _wait(job)
    log = [json.loads(line) for line in open(tmp_path / "log.jsonl")]
    new = next(m for m in log if m.get("method") == "session/new")
    assert new["params"]["mcpServers"] == []
    prompt = next(m for m in log if m.get("method") == "session/prompt")
    text = prompt["params"]["prompt"][0]["text"]
    assert text.startswith(runner._MYSTICAL_NOTE) and "Mystical's instructions" not in text


# ---- provider switching ---------------------------------------------------------

def test_switch_after_a_turn_tells_the_new_agent_everything(tmp_path, monkeypatch, on):
    s = _session(tmp_path, agent=None, prompts=("build the thing",))
    t = store.turns_of(s["id"])[0]
    store.append_event(s["id"], t["id"], {"type": "text", "text": "built it, tests pass"})
    target = profiles.create({"name": "To Fake", "agent": "fake"})
    prev = multi_api.get("session/handoff", {"session": [s["id"]], "profile": [target["id"]]}, CHAT)[0]
    assert prev["needs_dialog"] and prev["fits"] and prev["from"] == "Claude" and prev["to"] == "Fake"
    out, code = profiles.bind(s, target["id"])
    assert code == 200, out
    _script(monkeypatch, {"turn": [chunk("on it")]})
    job = runner.start_streaming_job(CHAT, "carry on", [], project=str(tmp_path), session_id=s["id"])
    _wait(job)
    prompt = next(json.loads(line) for line in open(tmp_path / "log.jsonl") if '"session/prompt"' in line)
    text = prompt["params"]["prompt"][0]["text"]
    assert "build the thing" in text and "built it, tests pass" in text
    assert text.rstrip().endswith("carry on")
    assert ".mystical/handoff/" in text and (tmp_path / ".mystical" / "handoff" / f"{s['id']}.md").exists()
    # The turn's own prompt stays what you typed, and the switch shows in the transcript.
    assert store.turns_of(s["id"])[-1]["prompt"] == "carry on"
    kinds = [e["type"] for e in store.events_of_turn(s["id"], job.id)]
    assert "switch" in kinds
    time.sleep(0.2)
    assert store.get_session(s["id"]).get("handoff") in (None, "")


def test_returning_keeps_the_claude_session_and_tells_only_what_it_missed(tmp_path, on):
    s = _session(tmp_path, agent=None, prompts=("first",))
    store.set_claude_session_id(s["id"], "claude-1")
    s = store.get_session(s["id"])
    fake = profiles.create({"name": "To Fake", "agent": "fake"})
    assert profiles.bind(s, fake["id"])[1] == 200
    s = store.get_session(s["id"])
    store.start_turn(s["id"], "t-fake", "second", [], runtime="acp:fake")
    store.finish_turn("t-fake", "done", None, 1)
    store.set_session_field(s["id"], "agent_session_id", "fake-1")
    s = store.get_session(s["id"])
    assert profiles.bind(s, "")[1] == 200
    back = store.get_session(s["id"])
    assert back["claude_session_id"] == "claude-1" and not back["agent_session_id"]
    assert store.native_id(s["id"], "fake", "") == "fake-1"
    text, row = handoff.consume(back, str(tmp_path), None)
    assert row["to"] == "Claude" and "second" in text and "first" not in text
    # And going to Fake again reuses its session.
    assert profiles.bind(back, fake["id"])[1] == 200
    assert store.get_session(s["id"])["agent_session_id"] == "fake-1"


def test_the_turn_being_started_isnt_history(tmp_path, on):
    """Live test, Claude to Kimi and back: Kimi was told it had missed nothing, because
    the new turn is already in the table and on Kimi."""
    s = _session(tmp_path, prompts=("kimi did this",))
    store.set_session_field(s["id"], "agent_session_id", "k-1")
    s = store.get_session(s["id"])
    store.set_native_id(s["id"], profiles.effective(s)["agent"], "", "k-1")
    pid = s["profile_id"]
    assert profiles.bind(s, "")[1] == 200
    store.start_turn(s["id"], "c-1", "claude did that", [])
    store.finish_turn("c-1", "done", None, 1)
    assert profiles.bind(store.get_session(s["id"]), pid)[1] == 200
    store.start_turn(s["id"], "k-2", "new question", [], runtime="acp:fake")
    text, row = handoff.consume(store.get_session(s["id"]), str(tmp_path), None, "k-2")
    assert row["turns"] == 1 and "claude did that" in text
    assert "new question" not in text and "kimi did this" not in text


def test_too_big_keeps_the_newest_and_says_so(tmp_path, on, monkeypatch):
    s = _session(tmp_path, agent=None, prompts=("OLD" + "x" * 4000, "NEW" + "y" * 100))
    target = profiles.create({"name": "T", "agent": "fake"})
    monkeypatch.setattr(agent_caps, "history_budget", lambda m: 200)
    assert handoff.preview(s, target)["fits"] is False
    profiles.bind(s, target["id"])
    text, row = handoff.consume(store.get_session(s["id"]), str(tmp_path), None)
    assert row["whole"] is False and "NEW" in text and "OLD" not in text and "doesn't all fit" in text


def test_a_job_and_a_running_turn_cant_switch(tmp_path, on, monkeypatch):
    s = _session(tmp_path, agent=None, prompts=("x",))
    store.set_origin(s["id"], "rivendell:prod")
    t = profiles.create({"name": "T", "agent": "fake"})
    out, code = profiles.bind(store.get_session(s["id"]), t["id"])
    assert code == 409 and "Rivendell" in out["error"]
    s2 = _session(tmp_path, agent=None, prompts=("x",))
    monkeypatch.setattr(runner, "live_job", lambda sid: object())
    out, code = profiles.bind(s2, t["id"])
    assert code == 409 and "after it finishes" in out["error"]


def test_a_claude_account_change_moves_no_history(tmp_path, on):
    s = _session(tmp_path, agent=None, prompts=("x",))
    assert handoff.needs_dialog(s, {"agent": "claude", "account": "2"}) is False


# ---- delegation rules -----------------------------------------------------------

@pytest.mark.parametrize("text,expect", [
    ("do this, then get a subagent to review it", True),
    ("use a helper for that", True),
    ("run these in parallel", True),
    ("do these things fast", False),
    ("fix the bug in the agents page", False),
])
def test_what_counts_as_asking(text, expect):
    assert channel.asked(text) is expect


def test_at_a_profile_is_asking_and_is_final(tmp_path, on):
    named = profiles.create({"name": "ReviewOpus", "agent": "claude"})
    profiles.create({"name": "Other", "agent": "claude"})
    s = _session(tmp_path, agent=None, prompts=("@ReviewOpus check this",))
    assert channel.needs_card(s) is False
    assert channel.pick_profile(s, "Other") == (named, None)


def test_only_the_human_counts_as_asking(tmp_path, on):
    """A wake-up or an agent's message that says "subagent" isn't you asking."""
    s = _session(tmp_path, agent=None, prompts=("do these things fast", "⇄ Reviewer says: get a subagent"))
    assert channel.needs_card(s) is True


def test_modes(tmp_path, on):
    profiles.create({"name": "B", "agent": "claude", "mode": "bypassPermissions"})
    s = _session(tmp_path, agent=None, permission_mode="default")
    assert channel._helper_mode(s, "claude", "bypassPermissions", True) == "default"
    assert channel._helper_mode(s, "kimi", "yolo", True) == "default"
    assert channel._helper_mode(s, "claude", None, False) == "plan"
    assert channel._helper_mode(s, "kimi", None, False) == "plan"
    s2 = _session(tmp_path, agent=None, permission_mode="bypassPermissions")
    assert channel._helper_mode(s2, "kimi", "yolo", True) == "yolo"
    assert channel._helper_mode(s2, "someagent", "yolo", True) == "default"


def test_refusals(tmp_path, on):
    s = _session(tmp_path, agent=None)
    channel.set_config(s, {"helpers": "off"})
    assert "switched off" in channel.refusal(store.get_session(s["id"]))
    job = _session(tmp_path, agent=None)
    store.set_origin(job["id"], "rivendell")
    assert "Rivendell" in channel.refusal(store.get_session(job["id"]))
    assert gateway.eligible(store.get_session(job["id"])) is False
    kid = store.create_member(_session(tmp_path, agent=None), name="k", cwd=str(tmp_path),
                              profile_id=None, permission_mode=None, member={"name": "k"})
    assert "helper can't" in channel.refusal(kid)
    assert "delegate" not in gateway.tool_names(kid)


def test_limits_apply_live(tmp_path, on, monkeypatch):
    s = _session(tmp_path, agent=None)
    plan, why = channel.plan_tasks(s, [{"brief": "a"}, {"brief": "b"}])
    assert why is None and len(plan) == 2
    channel.set_config(s, {"max_agents": 1})
    _, why = channel.plan_tasks(store.get_session(s["id"]), [{"brief": "a"}, {"brief": "b"}])
    assert "allows 1" in why
    with pytest.raises(ValueError):
        channel.set_config(s, {"max_agents": 0})
    channel.set_config(s, {"max_agents": 9, "per_account": 1})
    _, why = channel.plan_tasks(store.get_session(s["id"]), [{"brief": "a"}, {"brief": "b"}])
    assert "login may carry" in why


def test_card_answer_reads_labels():
    assert channel.approved([{"labels": ["Start"]}]) is True
    assert channel.approved([{"labels": ["Not now"]}]) is False
    assert channel.approved([]) is False


# ---- helpers end to end ----------------------------------------------------------

def test_a_helper_runs_reports_and_wakes_its_chat(tmp_path, monkeypatch, on):
    _script(monkeypatch, {"turn": [chunk("all good, no findings")]})
    chat = _session(tmp_path, prompts=("do it, then get a subagent to review",))
    assert channel.needs_card(chat) is False
    woke = []
    monkeypatch.setattr(channel, "_reach", lambda c, t, text: woke.append((t["id"], text)) or True)
    plan, why = channel.plan_tasks(chat, [{"brief": "review the diff", "name": "reviewer"}])
    assert why is None
    out = channel.start(chat, plan)
    assert "reviewer started" in out[0]
    kid = store.members_of(chat["id"])[0]
    job = runner.live_job(kid["id"])
    if job:
        _wait(job)
    deadline = time.time() + 5
    while time.time() < deadline and not woke:
        time.sleep(0.05)
    assert woke and woke[0][0] == chat["id"]
    assert "all good, no findings" in woke[0][1] and "not from the user" in woke[0][1]
    assert kid["permission_mode"] == "default" or kid["permission_mode"] == "plan"
    assert store.parse_member(store.get_session(kid["id"])["member"])["state"] == "done"
    # It's in the tree, not in the list.
    rows = agent_tree.tree(chat)
    assert [r["name"] for r in rows] == ["reviewer"] and rows[0]["kind"] == "member"
    assert kid["id"] not in [x["id"] for x in store.list_sessions(CHAT, "/p")]
    assert "delegation" in [e["type"] for t in store.turns_of(chat["id"])
                            for e in store.events_of_turn(chat["id"], t["id"])]


def test_channel_brakes(tmp_path, monkeypatch, on):
    chat = _session(tmp_path, agent=None)
    monkeypatch.setattr(channel, "_reach", lambda c, t, text: True)
    a = store.create_member(chat, name="a", cwd=str(tmp_path), profile_id=None, permission_mode=None, member={})
    assert a
    assert channel.post(chat, "a", "main", "message", "hi")["state"] == "queued"
    assert channel.post(chat, "a", "main", "message", "hi")["state"] == "dropped"
    channel.set_config(chat, {"max_hops": 2})
    chat = store.get_session(chat["id"])
    channel.post(chat, "a", "main", "message", "two")
    assert channel.post(chat, "a", "main", "message", "three")["state"] == "held"
    assert channel.config_for(store.get_session(chat["id"]))["held"] is True
    # You always get through, and your words reset the count.
    assert channel.human_message(chat, "a", "stop that")["state"] != "held"
    held = store.channel_messages(chat["id"], states=("held",))
    assert channel.edit_held(chat, held[0]["id"], "edited") is True
    assert channel.edit_held(chat, "nope", "x") is False
    channel.set_held(store.get_session(chat["id"]), False)
    rows = store.channel_messages(chat["id"])
    assert any(m["body"] == "edited" and m["state"] == "delivered" for m in rows)


def test_a_restart_keeps_undelivered_messages(tmp_path, monkeypatch, on):
    chat = _session(tmp_path, agent=None)
    monkeypatch.setattr(channel, "_reach", lambda c, t, text: False)
    channel.post(chat, channel.USER, "main", "human", "later")
    assert store.waiting_channel_chats() == [chat["id"]]
    monkeypatch.setattr(channel, "_reach", lambda c, t, text: True)
    channel.resume_pending()
    assert not store.channel_messages(chat["id"], states=("queued",))


def test_quiet_pings(tmp_path, monkeypatch, on):
    chat = _session(tmp_path, agent=None)
    assert channel.quiet_ping(chat["id"]) is False
    kid = store.create_member(chat, name="a", cwd=str(tmp_path), profile_id=None, permission_mode=None, member={})
    assert channel.quiet_ping(kid["id"]) is True
    monkeypatch.setattr(channel, "_running", lambda sid: sid == kid["id"])
    assert channel.quiet_ping(chat["id"]) is True


# ---- merging ----------------------------------------------------------------------

def _writer(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    repo.mkdir()
    _repo(repo)
    monkeypatch.setattr(config, "BASE_PATH", str(tmp_path))
    chat = store.create_session(CHAT, "/p", cwd=str(repo))
    copy, why = channel._make_copy(chat, str(repo), "abc")
    assert why is None
    kid = store.create_member(chat, name="w", cwd=copy["cwd"], profile_id=None, permission_mode=None,
                              member={"name": "w", "write": True, "copy": copy, "short": "abc", "state": "done"})
    return repo, chat, kid, copy


def test_merge_is_uncommitted_and_leaves_the_index_alone(tmp_path, monkeypatch, on):
    repo, chat, kid, copy = _writer(tmp_path, monkeypatch)
    (repo / "mine.txt").write_text("staged by the user\n")
    subprocess.run(["git", "-C", str(repo), "add", "mine.txt"], check=True)
    with open(os.path.join(copy["path"], "a.txt"), "a") as f:
        f.write("two\n")
    open(os.path.join(copy["path"], "new.txt"), "w").write("new\n")
    assert "2 files changed" in channel.changes(chat, "w")
    out = channel.merge(chat, "w")
    assert "uncommitted" in out, out
    assert (repo / "a.txt").read_text() == "one\ntwo\n" and (repo / "new.txt").exists()
    head = subprocess.run(["git", "-C", str(repo), "log", "--oneline"], capture_output=True, text=True).stdout
    assert len(head.splitlines()) == 1
    staged = subprocess.run(["git", "-C", str(repo), "diff", "--cached", "--name-only"],
                            capture_output=True, text=True).stdout.split()
    assert staged == ["mine.txt"]
    assert not os.path.isdir(copy["path"])
    assert "out of the folder" in channel.undo_merge(chat, "w")
    assert (repo / "a.txt").read_text() == "one\n"


def test_starts_from_uncommitted_work(tmp_path, monkeypatch, on):
    repo = tmp_path / "repo"
    repo.mkdir()
    _repo(repo)
    (repo / "a.txt").write_text("edited not committed\n")
    monkeypatch.setattr(config, "BASE_PATH", str(tmp_path))
    chat = store.create_session(CHAT, "/p", cwd=str(repo))
    copy, why = channel._make_copy(chat, str(repo), "dirty")
    assert why is None
    assert open(os.path.join(copy["path"], "a.txt")).read() == "edited not committed\n"


def test_a_conflict_changes_nothing_and_says_how_to_go_on(tmp_path, monkeypatch, on):
    repo, chat, kid, copy = _writer(tmp_path, monkeypatch)
    open(os.path.join(copy["path"], "a.txt"), "w").write("theirs\n")
    (repo / "a.txt").write_text("mine\n")
    out = channel.merge(chat, "w")
    assert "doesn't apply cleanly" in out and "ask them" in out
    assert (repo / "a.txt").read_text() == "mine\n"
    assert os.path.isdir(copy["path"])
    assert "copy is gone" in channel.discard(chat, "w")
    assert not os.path.isdir(copy["path"])


def test_deps_are_linked_and_env_copied(tmp_path, monkeypatch, on):
    repo = tmp_path / "repo"
    repo.mkdir()
    _repo(repo)
    (repo / ".gitignore").write_text("node_modules\n.env\n")
    (repo / "node_modules").mkdir()
    (repo / ".env").write_text("A=1\n")
    subprocess.run(["git", "-C", str(repo), "add", "."], check=True)
    subprocess.run(["git", "-C", str(repo), "commit", "-qm", "ignore"], check=True)
    monkeypatch.setattr(config, "BASE_PATH", str(tmp_path))
    chat = store.create_session(CHAT, "/p", cwd=str(repo))
    copy, _ = channel._make_copy(chat, str(repo), "deps")
    assert os.path.islink(os.path.join(copy["path"], "node_modules"))
    assert open(os.path.join(copy["path"], ".env")).read() == "A=1\n"


# ---- steering and cards on an agent ------------------------------------------------

TOOL = {"update": {"sessionUpdate": "tool_call", "toolCallId": "t1", "title": "Bash", "kind": "execute",
                   "status": "pending", "rawInput": {"command": "sleep"}}}
TOOL_DONE = {"update": {"sessionUpdate": "tool_call_update", "toolCallId": "t1", "status": "completed",
                        "content": [{"type": "content", "content": {"type": "text", "text": "ok"}}]}}


def _prompts(tmp_path):
    return [m["params"]["prompt"][0]["text"] for m in map(json.loads, open(tmp_path / "log.jsonl"))
            if m.get("method") == "session/prompt"]


def test_soft_steer_waits_for_the_tool_then_continues_the_same_session(tmp_path, monkeypatch, on):
    _script(monkeypatch, {"turn": [TOOL, {"sleep": 0.6}, TOOL_DONE, {"wait_cancel": 5}, chunk("after")]})
    s = _session(tmp_path)
    job = runner.start_streaming_job(CHAT, "start", [], project=str(tmp_path), session_id=s["id"])
    end = time.time() + 8
    while time.time() < end and not (job.turn and job.turn.tools):
        time.sleep(0.02)
    assert runner.steer(s["id"], "change of plan") is True
    assert job.turn.want_cancel is True     # the tool is open: not yet
    _wait(job, 20)
    prompts = _prompts(tmp_path)
    assert prompts[-1] == "change of plan" and len(prompts) == 2
    assert job.status == "done" and not job.interrupted
    assert "steer" in [e["type"] for e in store.events_of_turn(s["id"], job.id)]
    methods = [json.loads(line).get("method") for line in open(tmp_path / "log.jsonl")]
    assert methods.count("session/new") == 1 and "session/cancel" in methods


def test_steer_off_is_refused_as_before(tmp_path, monkeypatch):
    _script(monkeypatch, {"turn": [{"sleep": 1}]})
    s = _session(tmp_path)
    job = runner.start_streaming_job(CHAT, "start", [], project=str(tmp_path), session_id=s["id"])
    time.sleep(0.2)
    assert runner.steer(s["id"], "x") is False
    _wait(job)


def test_a_card_pauses_the_turn_and_the_answer_is_the_next_prompt(tmp_path, monkeypatch, on):
    _script(monkeypatch, {"turn": [TOOL, {"sleep": 0.4}, TOOL_DONE, {"wait_cancel": 5}, chunk("thanks")]})
    s = _session(tmp_path)
    job = runner.start_streaming_job(CHAT, "start", [], project=str(tmp_path), session_id=s["id"])
    end = time.time() + 8
    while time.time() < end and not (job.turn and job.turn.tools):
        time.sleep(0.02)
    q = [{"question": "Which?", "header": "Pick", "options": [{"label": "A"}, {"label": "B"}]}]
    res = gateway._call(store.get_session(s["id"]), "ask_user", {"questions": q})
    assert "End your turn" in res["content"][0]["text"]
    rid = job.pending[0]["request_id"]
    # The turn stops and holds; nothing goes out until you answer.
    time.sleep(1.2)
    assert job.status == "running" and len(_prompts(tmp_path)) == 1
    assert job.respond(rid, answers=[{"header": "Pick", "labels": ["B"]}]) is True
    _wait(job, 20)
    assert "Pick" in _prompts(tmp_path)[-1] and "B" in _prompts(tmp_path)[-1]
    assert job.status == "done"


def test_stop_ends_a_paused_turn(tmp_path, monkeypatch, on):
    _script(monkeypatch, {"turn": [TOOL, {"sleep": 0.2}, TOOL_DONE, {"wait_cancel": 5}]})
    s = _session(tmp_path)
    job = runner.start_streaming_job(CHAT, "start", [], project=str(tmp_path), session_id=s["id"])
    end = time.time() + 8
    while time.time() < end and not (job.turn and job.turn.tools):
        time.sleep(0.02)
    gateway._call(store.get_session(s["id"]), "ask_user",
                  {"questions": [{"question": "Q", "options": [{"label": "A"}]}]})
    time.sleep(0.8)
    assert job.interrupt() is True
    _wait(job, 15)
    assert job.interrupted and not job.pending


# ---- the gateway -------------------------------------------------------------------

def test_token_is_the_only_authority(tmp_path, on):
    s = _session(tmp_path)
    assert gateway.handle("nope", "tools/list", {})[1] == 401
    tok = gateway.issue(s["id"])
    out, code = gateway.handle(tok, "tools/list", {})
    assert code == 200 and "delegate" in {t["name"] for t in out["tools"]}
    res, _ = gateway.handle(tok, "tools/call", {"name": "reveal_anything", "arguments": {}})
    assert res.get("isError")
    gateway.revoke(tok)
    assert gateway.handle(tok, "tools/list", {})[1] == 401


def test_claude_gets_channel_tools_not_duplicates(tmp_path, on):
    s = _session(tmp_path, agent=None)
    names = gateway.tool_names(s)
    assert {"delegate", "send_message"} <= names
    assert not names & {"ask_user", "run_project", "create_goal"}
    agent = gateway.tool_names(_session(tmp_path))
    assert {"ask_user", "run_project", "create_goal"} <= agent


def test_relay_holds_no_secret_and_imports_no_bridge(tmp_path, on):
    d = gateway.server_def("tok")
    assert set(d["env"]) == {"MYSTICAL_GATEWAY_URL", "MYSTICAL_GATEWAY_TOKEN"}
    assert "-I" in d["args"]
    import ast
    tree = ast.parse(open(d["args"][-1]).read())
    mods = {n.module if isinstance(n, ast.ImportFrom) else a.name.split(".")[0]
            for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom))
            for a in n.names}
    assert "bridge" not in mods
    # It runs, alone, and answers initialize with nothing around it.
    p = subprocess.run([d["command"], *d["args"]], env={"PATH": os.environ["PATH"]},
                       input=json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize"}) + "\n",
                       capture_output=True, text=True, timeout=10)
    assert json.loads(p.stdout)["result"]["serverInfo"]["name"] == "mystical"


def test_gateway_route_takes_its_token_not_the_dashboards(tmp_path, on):
    """A wrong token gets 401 before anything else, with no dashboard token involved."""
    assert gateway.handle(config.DASH_TOKEN, "tools/list", {})[1] == 401


# ---- sharing -----------------------------------------------------------------------

def _server(monkeypatch, defs):
    monkeypatch.setattr(mcp_share, "definitions", lambda cwd: {k: {"home": "claude", "def": v} for k, v in defs.items()})


def test_share_rules(tmp_path, monkeypatch, on):
    defs = {"browser": {"command": "npx", "args": ["@playwright/mcp"]},
            "rivendell": {"url": "https://x/mcp", "headers": {"Authorization": "Bearer s3cret"}},
            "railway": {"command": "railway", "args": ["mcp"]}}
    _server(monkeypatch, defs)
    assert set(mcp_share.for_agent("kimi", None)) == {"browser"}     # known: everyone
    assert mcp_share.for_agent("claude", None) == {}                 # its own aren't repeated
    mcp_share.set_share("rivendell", "kimi", True)
    assert set(mcp_share.for_agent("kimi", None)) == {"browser", "rivendell"}
    assert set(mcp_share.for_agent("codex", None)) == {"browser"}    # per model
    mcp_share.set_share("browser", "kimi", False)
    assert "browser" not in mcp_share.for_agent("kimi", None)


@pytest.mark.parametrize("tool,held", [
    ("reveal_secret", True), ("set_shared_secret", True), ("deploy_infrastructure_changes", True),
    ("get_service_variables", True), ("run_service_action", True), ("get_board", False), ("read_route", False)])
def test_sensitive_tools_stay_off_until_named(tool, held, on):
    assert mcp_share.tool_allowed("rivendell", tool) is (not held)
    if held:
        mcp_share.set_tool("rivendell", tool, True)
        assert mcp_share.tool_allowed("rivendell", tool) is True


def test_a_real_server_through_the_gateway_never_gives_the_agent_its_env(tmp_path, monkeypatch, on):
    server = tmp_path / "srv.py"
    server.write_text('''
import sys, json, os
for line in sys.stdin:
    m = json.loads(line)
    if "id" not in m: continue
    if m["method"] == "initialize":
        r = {"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "s", "version": "1"}}
    elif m["method"] == "tools/list":
        r = {"tools": [{"name": "echo", "description": "says", "inputSchema": {}}, {"name": "reveal_secret", "inputSchema": {}}]}
    else:
        r = {"content": [{"type": "text", "text": "key is " + os.environ["THE_KEY"]}]}
    print(json.dumps({"jsonrpc": "2.0", "id": m["id"], "result": r}), flush=True)
''')
    d = {"command": sys.executable, "args": [str(server)], "env": {"THE_KEY": "abc"}}
    _server(monkeypatch, {"tool": d})
    mcp_share.set_share("tool", "fake", True)
    s = _session(tmp_path)
    assert {"find_tools", "call_tool"} <= gateway.tool_names(s)
    found = gateway._call(s, "find_tools", {"server": "tool"})["content"][0]["text"]
    assert "echo" in found and "reveal_secret" not in found
    res = gateway._call(s, "call_tool", {"server": "tool", "tool": "echo", "arguments": {}})
    assert res["content"][0]["text"] == "key is abc"       # the server ran with its key
    held = gateway._call(s, "call_tool", {"server": "tool", "tool": "reveal_secret"})
    assert held["isError"] and "held back" in held["content"][0]["text"]
    mcp_share._clients.clear()


def test_skills_link_both_ways_and_hold_back_claude_only(tmp_path, on):
    home = tmp_path / "home"
    (home / ".claude/skills/plain").mkdir(parents=True)
    (home / ".claude/skills/plain/SKILL.md").write_text("---\nname: plain\n---\nDo a thing.\n")
    (home / ".claude/skills/tooly").mkdir()
    (home / ".claude/skills/tooly/SKILL.md").write_text("Call AskUserQuestion here.\n")
    (home / ".agents/skills/fromkimi").mkdir(parents=True)
    (home / ".agents/skills/fromkimi/SKILL.md").write_text("x\n")
    (home / ".agents/skills/taken").mkdir()
    (home / ".claude/skills/taken").mkdir()
    (home / ".claude/skills/taken/SKILL.md").write_text("a\n")
    (home / ".agents/skills/taken/SKILL.md").write_text("b\n")
    skill_share.sync(None)
    assert os.path.islink(home / ".agents/skills/plain")
    assert not os.path.lexists(home / ".agents/skills/tooly")
    assert os.path.islink(home / ".claude/skills/fromkimi")
    assert not os.path.islink(home / ".agents/skills/taken")      # a real one is never replaced
    rows = {(r["key"], r["home"]): r for r in skill_share.state(None)}
    assert rows[("user:tooly", "claude")]["claude_only"] is True
    assert rows[("user:taken", "claude")]["conflict"] is True
    skill_share.set_share("user:tooly", True, None)
    assert os.path.islink(home / ".agents/skills/tooly")
    skill_share.set_share("user:plain", False, None)
    assert not os.path.lexists(home / ".agents/skills/plain")


def test_a_projects_link_stays_out_of_git_status(tmp_path, on):
    repo = tmp_path / "repo"
    repo.mkdir()
    _repo(repo)
    (repo / ".claude/skills/one").mkdir(parents=True)
    (repo / ".claude/skills/one/SKILL.md").write_text("x\n")
    skill_share.sync(str(repo))
    assert os.path.islink(repo / ".agents/skills/one")
    st = subprocess.run(["git", "-C", str(repo), "status", "--short", "-uall"], capture_output=True, text=True).stdout
    assert ".agents" not in st


# ---- the pack and the push check ----------------------------------------------------

def test_pack_names_only_what_the_agent_has(tmp_path, on):
    s = _session(tmp_path)
    assert "ask_user" not in prompt_pack.agent_pack(s, None, set(), extra=("NOTE",))
    assert "NOTE" in prompt_pack.agent_pack(s, None, set(), extra=("NOTE",))
    full = prompt_pack.agent_pack(s, None, {"ask_user", "delegate", "run_project", "list_rivendell_tasks"},
                                  rivendell=True)
    assert "ask_user" in full and "Rivendell" in full and "delegate" in full
    assert "AskUserQuestion" not in full and "mcp__goals" not in full


def test_a_shrunk_context_sends_the_pack_again(tmp_path, on):
    s = _session(tmp_path, agent_session_id="x")
    assert prompt_pack.needs_pack(s) is False
    prompt_pack.note_context(s["id"], 90000)
    assert prompt_pack.needs_pack(store.get_session(s["id"])) is False
    prompt_pack.note_context(s["id"], 20000)
    fresh = store.get_session(s["id"])
    assert prompt_pack.needs_pack(fresh) is True
    prompt_pack.sent(s["id"])
    assert prompt_pack.needs_pack(store.get_session(s["id"])) is False


def test_agent_gets_the_pack_and_the_gateway(tmp_path, monkeypatch, on):
    _script(monkeypatch, {"turn": [chunk("ok")]})
    s = _session(tmp_path)
    job = runner.start_streaming_job(CHAT, "hello", [], project=str(tmp_path), session_id=s["id"])
    tok_seen = {}
    _wait(job)
    log = [json.loads(line) for line in open(tmp_path / "log.jsonl")]
    new = next(m for m in log if m.get("method") == "session/new")
    server = new["params"]["mcpServers"][0]
    assert server["name"] == "mystical"
    envs = {e["name"] for e in server["env"]}
    assert envs == {"MYSTICAL_GATEWAY_URL", "MYSTICAL_GATEWAY_TOKEN"}
    tok_seen["t"] = next(e["value"] for e in server["env"] if e["name"] == "MYSTICAL_GATEWAY_TOKEN")
    text = next(m for m in log if m.get("method") == "session/prompt")["params"]["prompt"][0]["text"]
    assert "ask_user" in text and text.rstrip().endswith("hello")
    # Its token dies with the turn.
    end = time.time() + 3
    while time.time() < end and gateway.session_of(tok_seen["t"]):
        time.sleep(0.05)
    assert gateway.session_of(tok_seen["t"]) is None


def test_git_level_push_gate_holds_once_and_runs_the_repos_own_hook(tmp_path, monkeypatch):
    repo = tmp_path / "repo"
    repo.mkdir()
    _repo(repo)
    bare = tmp_path / "o.git"
    subprocess.run(["git", "init", "-q", "--bare", str(bare)], check=True)
    subprocess.run(["git", "-C", str(repo), "remote", "add", "origin", str(bare)], check=True)
    subprocess.run(["git", "-C", str(repo), "checkout", "-qb", "feat/x"], check=True)
    own = repo / ".git/hooks/pre-push"
    marker = tmp_path / "own-hook-ran"
    own.write_text(f"#!/bin/sh\ntouch {marker}\n")
    own.chmod(0o755)
    monkeypatch.setattr("bridge.rivendell.key_prefixes", lambda p: [])
    env = {**os.environ, **pushgate.env(str(repo))}
    first = subprocess.run(["git", "-C", str(repo), "push", "-q", "origin", "feat/x"], env=env,
                           capture_output=True, text=True)
    assert first.returncode != 0 and "Held once" in first.stderr
    second = subprocess.run(["git", "-C", str(repo), "push", "-q", "origin", "feat/x"], env=env,
                            capture_output=True, text=True)
    assert second.returncode == 0, second.stderr
    assert marker.exists()


def test_taskcheck_still_works_as_the_claude_hook(tmp_path):
    p = subprocess.run([sys.executable, "-I", taskcheck.__file__, "/nowhere", ""],
                       input=json.dumps({"tool_name": "Bash", "tool_input": {"command": "ls"}}),
                       capture_output=True, text=True)
    assert p.returncode == 0


# ---- the surfaces ------------------------------------------------------------------

def test_brief_carries_caps_and_limits_when_on(tmp_path, on):
    s = _session(tmp_path)
    b = mini._session_brief(s)
    assert b["caps"]["steer"] == "soft" and b["helpers"]["helpers"] == "ask"
    claude = mini._session_brief(_session(tmp_path, agent=None))
    assert claude["caps"]["steer"] == "native"
    assert dash._session_brief is mini._session_brief


def test_goal_is_offered_on_an_agent_only_when_on(tmp_path):
    s = _session(tmp_path)
    assert profiles.claude_only_refusal(s, "goal")
    experimental.set_enabled(True)
    assert profiles.claude_only_refusal(s, "goal") is None
    assert profiles.claude_only_refusal(s, "duplicate")


def test_bot_commands(tmp_path, monkeypatch, on):
    from bridge import dispatch
    s = _session(tmp_path, agent=None)
    monkeypatch.setattr(store, "latest_session", lambda c, k: store.get_session(s["id"]))
    assert "Only the main" in dispatch.handle_agents_command(CHAT, "/agents")
    store.create_member(s, name="rev", cwd=str(tmp_path), profile_id=None, permission_mode=None,
                        member={"state": "done"})
    assert "rev" in dispatch.handle_agents_command(CHAT, "/agents")
    assert "No agent" in dispatch.handle_agents_command(CHAT, "/tell nobody hi")
    monkeypatch.setattr(channel, "_reach", lambda c, t, text: True)
    assert "Sent to rev" in dispatch.handle_agents_command(CHAT, "/tell rev hi there")
    assert "hold" in dispatch.handle_agents_command(CHAT, "/agents hold")
    assert channel.config_for(store.get_session(s["id"]))["held"] is True
    experimental.set_enabled(False)
    assert "experimental" in dispatch.handle_agents_command(CHAT, "/agents")


def test_a_team_share_keeps_the_new_rows(tmp_path):
    from bridge import team
    for ev in ({"type": "switch", "from": "Claude", "to": "Kimi"},
               {"type": "delegation", "name": "rev", "brief": "b", "session_id": "secret-id"},
               {"type": "merge", "name": "rev", "state": "merged"}):
        clean, _ = team._clean_event(ev, lambda p: None, {})
        assert clean and clean["type"] == ev["type"] and "session_id" not in clean


def test_a_shared_chat_carries_its_helpers(tmp_path, on):
    from bridge import team
    s = _session(tmp_path, agent=None, prompts=("main work",))
    kid = store.create_member(s, name="rev", cwd=str(tmp_path), profile_id=None, permission_mode=None, member={})
    store.start_turn(kid["id"], "kid-t", "review it", [])
    store.append_event(kid["id"], "kid-t", {"type": "result", "result": "fine"})
    store.finish_turn("kid-t", "done", None, 1)
    import gzip
    packed = team.pack_session(s["id"], pictures=False)
    doc = json.loads(gzip.decompress(packed["payload"]))
    assert any("[helper: rev] review it" == t.get("prompt") for t in doc["turns"])
