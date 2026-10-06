"""External MCP servers are off unless a session switched one on.

The cost being bought back here is startup latency. Measured on this machine:
`claude mcp list` health-checks every configured server and takes 6-9s, and
default_disabled_tools() called it to build the deny list for every session that
had never opened the Tools modal — i.e. every new session, before the claude
child was even spawned. Connecting the servers themselves then cost ~1.6s more
(init 1.5s -> 3.2s, first token 3.6s -> 5.5s).

Both go away by saying "none of them" as --strict-mcp-config instead of as a
deny list: there is nothing to enumerate, so nothing to ask `claude mcp list`.
"""

import io
import json
import os
import shutil
import stat

import pytest

from bridge import config, runner, toolsets

SID = "11111111-2222-3333-4444-555555555555"


def _cmd(**kw):
    # Not skip_pack: that's the internal-one-shot branch, which adds
    # --tools "" --strict-mcp-config of its own and would pass these tests for
    # the wrong reason.
    return runner._base_cmd("hi", 555, stream=True, interactive=True,
                            claude_session_id=SID, **kw)


def _mcp_servers(cmd):
    """The --mcp-config file's server names."""
    with open(cmd[cmd.index("--mcp-config") + 1], encoding="utf-8") as f:
        return sorted(json.load(f)["mcpServers"])


@pytest.fixture
def no_mcp_list(monkeypatch):
    """`claude mcp list` explodes, so any test that reaches it fails loudly."""
    def boom(*a, **k):
        raise AssertionError("toolsets.servers() shelled out to `claude mcp list`")
    monkeypatch.setattr(toolsets, "servers", boom)
    return boom


def test_unconfigured_session_never_asks_claude_mcp_list(no_mcp_list):
    # disabled_tools=None is a session that never opened the Tools modal — the
    # case that used to spend 6-9s enumerating servers only to deny them all.
    cmd = _cmd(disabled_tools=None)
    assert "--strict-mcp-config" in cmd
    assert _mcp_servers(cmd) == ["goals", "verify"]


def test_unconfigured_session_emits_no_deny_list(no_mcp_list):
    # Nothing external is loaded, so there is nothing left to deny. An empty
    # --disallowedTools would also read as a rule named "".
    assert "--disallowedTools" not in _cmd(disabled_tools=None)


def test_server_left_on_is_redeclared_under_strict(monkeypatch):
    monkeypatch.setattr(toolsets, "servers", lambda: [
        {"name": "teamwork", "rule": "mcp__teamwork"},
        {"name": "figma", "rule": "mcp__figma"}])
    monkeypatch.setattr(runner, "_configured_mcp_servers", lambda cwd: {
        "teamwork": {"type": "http", "url": "https://mcp.ai.teamwork.com"},
        "figma": {"type": "http", "url": "https://mcp.figma.com/mcp"}})
    cmd = _cmd(disabled_tools=["mcp__figma"])
    assert "--strict-mcp-config" in cmd
    assert _mcp_servers(cmd) == ["goals", "teamwork", "verify"]


def test_plugin_server_left_on_keeps_the_ambient_config(monkeypatch):
    # A plugin-bundled server has no definition we could re-declare, so strict
    # mode would silently drop a tool the Tools modal shows as ON. Pay the
    # startup cost instead of lying about what's loaded.
    monkeypatch.setattr(toolsets, "servers", lambda: [
        {"name": "plugin:cloudflare:cloudflare-api",
         "rule": "mcp__plugin_cloudflare_cloudflare-api"}])
    monkeypatch.setattr(runner, "_configured_mcp_servers", lambda cwd: {})
    cmd = _cmd(disabled_tools=[])
    assert "--strict-mcp-config" not in cmd


def test_configured_session_still_denies_builtins(monkeypatch):
    monkeypatch.setattr(toolsets, "servers", lambda: [])
    monkeypatch.setattr(runner, "_configured_mcp_servers", lambda cwd: {})
    cmd = _cmd(disabled_tools=["Bash", "Write"])
    assert cmd[cmd.index("--disallowedTools") + 1] == "Bash,Write"


# --- secrets stay off the command line -----------------------------------------

def test_a_run_keeps_mcp_secrets_off_argv(monkeypatch):
    """Every token a run's MCP servers carry (the dashboard's own, a server's
    Authorization header, a stdio server's API key) goes in a 0600 file in a
    0700 dir, never in argv, which any process on the machine can read from
    /proc/<pid>/cmdline. The file lives exactly as long as the child: claude may
    re-read it mid-run, and nothing should outlive the run."""
    from bridge import store, tailstate
    store.init()
    sid = store.create_session(555, "p-mcp-secrets")["id"]
    store.set_disabled_tools(sid, [])                      # everything switched on
    monkeypatch.setattr(toolsets, "servers", lambda: [
        {"name": "github", "rule": "mcp__github"},
        {"name": "railway", "rule": "mcp__railway"}])
    monkeypatch.setattr(runner, "_configured_mcp_servers", lambda cwd: {
        "github": {"type": "http", "url": "https://api.githubcopilot.com/mcp/",
                   "headers": {"Authorization": "Bearer ghp_TESTSECRET"}},
        "railway": {"type": "stdio", "command": "railway", "args": ["mcp"],
                    "env": {"RAILWAY_API_TOKEN": "rw_TESTSECRET"}}})
    monkeypatch.setattr(toolsets, "ready", lambda: True)
    monkeypatch.setattr(tailstate, "kick", lambda job, cwd=None: None)
    seen = {}

    def mid_run(path):
        seen["mid_run"] = os.path.exists(path)     # still there while it runs
        yield from ()

    class Child:
        def __init__(self, cmd, **kw):
            path = seen["path"] = cmd[cmd.index("--mcp-config") + 1]
            seen["argv"] = "\0".join(cmd)
            seen["modes"] = (stat.S_IMODE(os.stat(path).st_mode),
                             stat.S_IMODE(os.stat(os.path.dirname(path)).st_mode))
            with open(path, encoding="utf-8") as f:
                seen["servers"] = json.load(f)["mcpServers"]
            self.stdin, self.stderr = io.StringIO(), io.StringIO("")
            self.stdout = mid_run(path)
            self.returncode = 1

        def poll(self):
            return self.returncode

        def wait(self, timeout=None):
            return self.returncode

        def kill(self):
            pass

    monkeypatch.setattr(runner.subprocess, "Popen", Child)
    job = runner.Job("job-mcp-secrets", 555, sid)
    job.resume_id, job.new_session = SID, True
    runner._run_streaming(job, "hi", [], config.BASE_PATH)

    for secret in ("ghp_TESTSECRET", "rw_TESTSECRET", config.DASH_TOKEN):
        assert secret not in seen["argv"]
    assert seen["modes"] == (0o600, 0o700)
    assert seen["servers"]["github"]["headers"]["Authorization"] == "Bearer ghp_TESTSECRET"
    assert seen["servers"]["railway"]["env"]["RAILWAY_API_TOKEN"] == "rw_TESTSECRET"
    assert seen["servers"]["goals"]["env"]["MYSTICAL_DASH_TOKEN"] == config.DASH_TOKEN
    assert seen["mid_run"]
    assert not os.path.exists(os.path.dirname(seen["path"]))   # gone with the child


def test_concurrent_runs_never_share_a_config_file():
    """Two sessions running at once each get their own file, so one run ending
    (and removing its dir) never pulls the config out from under the other."""
    a, b = runner._mcp_config("sess-a"), runner._mcp_config("sess-b")
    assert os.path.dirname(a) != os.path.dirname(b)
    shutil.rmtree(os.path.dirname(a))
    with open(b, encoding="utf-8") as f:
        env = json.load(f)["mcpServers"]["goals"]["env"]
    assert env["MYSTICAL_CLAUDE_SESSION_ID"] == "sess-b"
    shutil.rmtree(os.path.dirname(b))


def test_a_config_that_fails_mid_write_leaves_nothing_behind(monkeypatch, tmp_path):
    """What went in before the failure can already be a token (here a server's
    Authorization header): the half-written file goes with its dir, and the
    error still reaches the run."""
    monkeypatch.setattr(runner.tempfile, "tempdir", str(tmp_path))
    with pytest.raises(TypeError):
        runner._mcp_config("sess-x", {
            "github": {"type": "http", "headers": {"Authorization": "Bearer ghp_X"}},
            "broken": {"command": object()}})                 # not JSON
    assert list(tmp_path.iterdir()) == []


def test_a_run_only_ever_removes_a_dir_mcp_config_made(monkeypatch, tmp_path):
    """The cleanup reads its target back off argv, so it is held to the one shape
    _mcp_config makes: no other directory is ever rmtree'd."""
    from bridge import store, tailstate
    keep = tmp_path / "keep"
    keep.mkdir()
    (keep / "mcp.json").write_text("{}")
    monkeypatch.setattr(runner, "_mcp_config", lambda sid, extra=None: str(keep / "mcp.json"))
    monkeypatch.setattr(toolsets, "servers", lambda: [])
    monkeypatch.setattr(runner, "_configured_mcp_servers", lambda cwd: {})
    monkeypatch.setattr(toolsets, "ready", lambda: True)
    monkeypatch.setattr(tailstate, "kick", lambda job, cwd=None: None)

    class Popen:
        def __init__(self, cmd, **kw):
            raise FileNotFoundError
    monkeypatch.setattr(runner.subprocess, "Popen", Popen)
    store.init()
    sid = store.create_session(555, "p-mcp-keep")["id"]
    store.set_disabled_tools(sid, [])
    job = runner.Job("job-mcp-keep", 555, sid)
    job.resume_id, job.new_session = SID, True
    runner._run_streaming(job, "hi", [], config.BASE_PATH)
    assert (keep / "mcp.json").exists()
