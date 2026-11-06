"""Rules (bridge/rules.py), their dispatcher, and the managed block in Kimi's config."""
import json
import os
import subprocess
import sys
import threading
import time
import tomllib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest

from bridge import config, experimental, gateway, profiles, project_config, rules, runner, store

store.init()
CHAT = config.DASH_CHAT_ID
DISPATCH = os.path.join(os.path.dirname(rules.__file__), "hook_dispatch.py")


class FakeJob:
    def __init__(self):
        self.id = f"j{time.time_ns()}"
        self.events = []
        self.started = time.time()
        self._lock = threading.Lock()

    def add(self, ev):
        self.events.append(ev)


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(rules, "_FILE", str(tmp_path / "rules.json"))
    monkeypatch.setattr(rules, "_log", [])
    monkeypatch.setattr(rules, "_subagents", {})
    monkeypatch.setattr(rules, "_failures", {})
    monkeypatch.setattr(rules, "kimi_homes", lambda: [str(tmp_path / "kimi")])
    monkeypatch.setattr(profiles, "PATH", str(tmp_path / "profiles.json"))
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "pc.json"))
    monkeypatch.setattr(experimental, "_path", lambda: str(tmp_path / "experimental.json"))
    monkeypatch.setattr(experimental, "_cache", None)
    monkeypatch.setattr(runner, "_notify", lambda *a, **k: None)
    monkeypatch.setattr(runner, "live_job", lambda sid: None)
    experimental.set_enabled(True)


def _s(tmp_path, agent=None):
    pid = None
    if agent:
        assert agent == "kimi"       # a real preset: nothing global to change
        pid = profiles.create({"name": f"P{time.time_ns()}", "agent": agent})["id"]
    return store.create_session(CHAT, "/p", cwd=str(tmp_path), profile_id=pid)


def bash(cmd):
    return {"tool_name": "Bash", "tool_input": {"command": cmd}}


def on(rule, **fields):
    rules.set_rule("machine", rule, True, fields, None, None)


def test_all_blocking_rules_start_off(tmp_path):
    s = _s(tmp_path)
    assert rules.evaluate(s, "PreToolUse", bash("git reset --hard")) == {}
    defaults = {r["id"] for r in rules.CATALOG if r["on"]}
    assert defaults == {"pack_after_compact", "subagent_tracking"}


@pytest.mark.parametrize("cmd,hit", [
    ("git reset --hard HEAD~1", True), ("git push origin main --force", True), ("git push -f", True),
    ("rm -rf /tmp/x", True), ("git clean -fd", True), ("git branch -D x", True), ("psql -c 'DROP TABLE users'", True),
    ("git status", False), ("rm file.txt", False), ("git push origin main", False), ("git checkout main", False),
])
def test_destructive(tmp_path, cmd, hit):
    on("destructive")
    s = _s(tmp_path)
    got = rules.evaluate(s, "PreToolUse", bash(cmd))
    assert bool(got.get("block")) is hit, cmd


def test_ask_mode_asks_on_claude_and_blocks_where_it_cant(tmp_path):
    on("destructive", mode="ask")
    assert rules.evaluate(_s(tmp_path), "PreToolUse", bash("rm -rf x")).get("ask")
    assert rules.evaluate(_s(tmp_path, "kimi"), "PreToolUse", bash("rm -rf x")).get("block")


def test_nearest_level_wins(tmp_path):
    on("destructive")
    s = _s(tmp_path)
    rules.set_rule("project", "destructive", False, None, "/p", None)
    assert rules.evaluate(s, "PreToolUse", bash("rm -rf x")) == {}
    assert rules.state_of("destructive", "/p", s)["level"] == "project"
    rules.set_rule("chat", "destructive", True, None, "/p", s)
    s = store.get_session(s["id"])
    assert rules.evaluate(s, "PreToolUse", bash("rm -rf x")).get("block")
    rules.set_rule("chat", "destructive", None, None, "/p", s)
    assert rules.state_of("destructive", "/p", store.get_session(s["id"]))["level"] == "project"


def test_protect_paths(tmp_path):
    on("protect_paths", paths=[".env", "migrations/", "*.pem"])
    s = _s(tmp_path)
    assert rules.evaluate(s, "PreToolUse", {"tool_name": "Edit", "tool_input": {"file_path": "a/.env"}}).get("block")
    assert rules.evaluate(s, "PreToolUse", {"tool_name": "Write", "tool_input": {"file_path": "db/migrations/1.sql"}}).get("block")
    assert rules.evaluate(s, "PreToolUse", bash("cat > key.pem")).get("block")
    assert rules.evaluate(s, "PreToolUse", {"tool_name": "Edit", "tool_input": {"file_path": "src/app.py"}}) == {}
    assert rules.evaluate(s, "PreToolUse", {"tool_name": "Read", "tool_input": {"file_path": ".env"}}) == {}


def test_secrets_are_masked_on_claude_only(tmp_path):
    on("mask_secrets")
    p = {"tool_name": "Bash", "tool_response": "token sk-ant-abc123 here"}
    assert rules.evaluate(_s(tmp_path), "PostToolUse", p)["output"] == "token *** here"
    assert "output" not in rules.evaluate(_s(tmp_path, "kimi"), "PostToolUse", p)


def test_test_before_done_asks_once(tmp_path, monkeypatch):
    on("test_before_done")
    s = _s(tmp_path)
    job = FakeJob()
    monkeypatch.setattr(runner, "live_job", lambda sid: job)
    assert rules.evaluate(s, "Stop", {}) == {}                    # changed nothing
    job.events.append({"type": "tool", "name": "Edit", "summary": "a.py"})
    assert rules.evaluate(s, "Stop", {}).get("keep_going")
    assert rules.evaluate(s, "Stop", {}) == {}                    # once, so it can't loop
    assert any(e["type"] == "rule" for e in job.events)
    fresh = FakeJob()
    monkeypatch.setattr(runner, "live_job", lambda sid: fresh)
    fresh.events += [{"type": "tool", "name": "Write"}, {"type": "tool", "name": "Bash", "summary": "python3 -m pytest tests/"}]
    assert rules.evaluate(s, "Stop", {}) == {}
    other = FakeJob()
    monkeypatch.setattr(runner, "live_job", lambda sid: other)
    other.events += [{"type": "tool", "name": "Edit"}, {"type": "checks", "ok": True}]
    assert rules.evaluate(s, "Stop", {}) == {}


def test_compaction_asks_for_the_pack_again(tmp_path):
    from bridge import prompt_pack
    s = _s(tmp_path, "kimi")
    store.set_session_field(s["id"], "agent_session_id", "x")
    s = store.get_session(s["id"])
    assert prompt_pack.needs_pack(s) is False
    rules.evaluate(s, "PostCompact", {})
    assert prompt_pack.needs_pack(store.get_session(s["id"])) is True


def test_subagent_hooks_feed_the_tree(tmp_path):
    s = _s(tmp_path, "kimi")
    rules.evaluate(s, "SubagentStart", {"agent_name": "explore"})
    assert rules.subagents_of(s["id"])["explore"]["ended"] is None
    rules.evaluate(s, "SubagentStop", {"agent_name": "explore"})
    assert rules.subagents_of(s["id"])["explore"]["ended"]


def test_ping_after_n_failures_and_a_success_resets(tmp_path, monkeypatch):
    on("ping_on_failure", times=2)
    s = _s(tmp_path)
    pings = []
    monkeypatch.setattr(rules, "_ping", lambda sess, what: pings.append(what))
    rules.evaluate(s, "PostToolUseFailure", {"tool_name": "Bash"})
    rules.evaluate(s, "PostToolUse", {"tool_name": "Bash"})
    rules.evaluate(s, "PostToolUseFailure", {"tool_name": "Bash"})
    assert not pings
    rules.evaluate(s, "PostToolUseFailure", {"tool_name": "Bash"})
    assert len(pings) == 1


def test_a_log_of_what_fired(tmp_path):
    on("destructive")
    s = _s(tmp_path)
    rules.evaluate(s, "PreToolUse", bash("rm -rf x"))
    row = rules.recent(s["id"])[0]
    assert row["rule"] == "destructive" and row["decision"] == "blocked"


def test_claude_gets_only_events_a_rule_needs(tmp_path):
    s = _s(tmp_path)
    assert set(rules.claude_hooks(s)) == {"SubagentStart", "SubagentStop"}
    on("destructive")
    h = rules.claude_hooks(s)
    assert "PreToolUse" in h and "hook_dispatch.py" in h["PreToolUse"][0]["hooks"][0]["command"]
    assert "PreToolUse" in h and "Stop" not in h


# ---- dispatcher ----------------------------------------------------------------------

def _run(event, answer, payload=None, env=True):
    class H(BaseHTTPRequestHandler):
        def do_POST(self):
            seen["tok"] = self.headers.get("X-Gateway-Token")
            seen["body"] = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            data = json.dumps(answer).encode()
            self.send_response(200)
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def log_message(self, *a):
            pass
    seen = {}
    srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    e = {"PATH": os.environ["PATH"]}
    if env:
        e.update(MYSTICAL_HOOK_TOKEN="t", MYSTICAL_HOOK_URL=f"http://127.0.0.1:{srv.server_port}/x")
    p = subprocess.run([sys.executable, "-I", DISPATCH, event], input=json.dumps(payload or {"tool_name": "Bash"}),
                       capture_output=True, text=True, env=e, timeout=20)
    srv.shutdown()
    return p, seen


def test_block_is_exit_2_with_the_reason():
    p, seen = _run("PreToolUse", {"block": "no"})
    assert p.returncode == 2 and p.stderr.strip() == "no" and seen["tok"] == "t"
    assert seen["body"]["event"] == "PreToolUse" and seen["body"]["payload"]["tool_name"] == "Bash"


def test_other_answers_are_json():
    assert json.loads(_run("Stop", {"keep_going": "test it"})[0].stdout) == {"decision": "block", "reason": "test it"}
    o = json.loads(_run("PostToolUse", {"output": "x"})[0].stdout)["hookSpecificOutput"]
    assert o == {"hookEventName": "PostToolUse", "updatedToolOutput": "x"}
    o = json.loads(_run("PreToolUse", {"ask": "sure?"})[0].stdout)["hookSpecificOutput"]
    assert o["permissionDecision"] == "ask"
    assert _run("PreToolUse", {})[0].stdout == ""


def test_outside_mystical_it_does_nothing():
    p, seen = _run("PreToolUse", {"block": "no"}, env=False)
    assert p.returncode == 0 and p.stdout == "" and not seen


def test_a_dead_bridge_lets_it_through():
    e = {"PATH": os.environ["PATH"], "MYSTICAL_HOOK_TOKEN": "t", "MYSTICAL_HOOK_URL": "http://127.0.0.1:9/x"}
    p = subprocess.run([sys.executable, "-I", DISPATCH, "PreToolUse"], input="{}", capture_output=True, text=True, env=e, timeout=20)
    assert p.returncode == 0


def test_it_imports_nothing_of_the_bridge():
    import ast
    tree = ast.parse(open(DISPATCH).read())
    mods = {n.module if isinstance(n, ast.ImportFrom) else a.name.split(".")[0]
            for n in ast.walk(tree) if isinstance(n, (ast.Import, ast.ImportFrom)) for a in n.names}
    assert "bridge" not in mods


def test_a_turns_token_reaches_the_hook_route(tmp_path):
    on("destructive")
    s = _s(tmp_path)
    tok = gateway.issue(s["id"])
    assert gateway.hook(tok, {"event": "PreToolUse", "payload": bash("rm -rf x")})[0].get("block")
    assert gateway.hook("nope", {"event": "PreToolUse", "payload": {}})[1] == 401
    gateway.revoke(tok)
    assert gateway.hook(tok, {"event": "PreToolUse", "payload": {}})[1] == 401


# ---- Kimi's config ----------------------------------------------------------------------

BODY = 'default_model = "x"\n\n[thinking]\nenabled = true\n'


def test_block_goes_in_and_comes_out_leaving_the_rest(tmp_path):
    p = tmp_path / "config.toml"
    p.write_text(BODY)
    block = rules.kimi_block(["PreToolUse", "Stop"])
    assert rules.write_kimi_block(str(p), block) is True
    got = tomllib.loads(p.read_text())
    assert got["default_model"] == "x" and got["thinking"]["enabled"] is True
    assert [h["event"] for h in got["hooks"]] == ["PreToolUse", "Stop"]
    assert set(got["hooks"][0]) == {"event", "command", "timeout"}    # an extra field stops Kimi loading it
    assert rules.write_kimi_block(str(p), block) is False             # no change, no write
    rules.write_kimi_block(str(p), rules.kimi_block(["Stop"]))
    assert [h["event"] for h in tomllib.loads(p.read_text())["hooks"]] == ["Stop"]
    rules.write_kimi_block(str(p), "")
    assert tomllib.loads(p.read_text()) == tomllib.loads(BODY) and "mystical" not in p.read_text()


def test_invalid_toml_leaves_the_file_alone(tmp_path):
    p = tmp_path / "config.toml"
    p.write_text("broken = = [\n")
    with pytest.raises(ValueError):
        rules.write_kimi_block(str(p), rules.kimi_block(["Stop"]))
    assert p.read_text() == "broken = = [\n"


def test_sync_follows_the_rules_and_the_switch(tmp_path):
    home = tmp_path / "kimi"
    home.mkdir()
    (home / "config.toml").write_text(BODY)
    on("destructive")
    rules.sync_agents()
    assert "PreToolUse" in {h["event"] for h in tomllib.loads((home / "config.toml").read_text())["hooks"]}
    experimental.set_enabled(False)
    rules.sync_agents()
    assert "hooks" not in tomllib.loads((home / "config.toml").read_text())


def test_an_edit_through_the_shell_counts_as_changed(tmp_path):
    r = tmp_path / "r"
    r.mkdir()
    subprocess.run(["git", "init", "-q", str(r)], check=True)
    (r / "x.py").write_text("x\n")
    assert rules._changed_since(str(r), time.time() - 5) is True
    assert rules._changed_since(str(r), time.time() + 5) is False
    (r / "x.py").unlink()
    (r / "notes.md").write_text("x")
    assert rules._changed_since(str(r), time.time() - 5) is False


def test_kimi_tool_rows_wait_for_their_input():
    from bridge import acp
    class J:
        events, boot, last_at, pending, interrupted = [], None, 0, [], False
        texts = []
        def add(self, e):
            self.events.append(e)
    job = J()
    job.events = []
    t = acp.Turn(job, "Kimi")
    t._update("tool_call", {"toolCallId": "a", "title": "Bash", "kind": "execute", "status": "pending"})
    t._update("tool_call_update", {"toolCallId": "a", "status": "in_progress", "content": []})
    assert job.events == []
    t._update("tool_call_update", {"toolCallId": "a", "status": "in_progress", "title": "Running: echo hi",
                                   "rawInput": {"command": "echo hi"}})
    assert job.events[0]["name"] == "Bash" and job.events[0]["summary"] == "echo hi" and job.events[0]["detail"] == "echo hi"
    t._update("tool_call", {"toolCallId": "b", "title": "Read", "status": "pending"})
    t._update("tool_call_update", {"toolCallId": "b", "status": "completed", "content": []})
    assert [e["type"] for e in job.events[-2:]] == ["tool", "tool_done"]
