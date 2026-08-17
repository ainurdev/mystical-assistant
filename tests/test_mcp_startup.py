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

import json

import pytest

from bridge import runner, toolsets

SID = "11111111-2222-3333-4444-555555555555"


def _cmd(**kw):
    # Not skip_pack: that's the internal-one-shot branch, which adds
    # --tools "" --strict-mcp-config of its own and would pass these tests for
    # the wrong reason.
    return runner._base_cmd("hi", 555, stream=True, interactive=True,
                            claude_session_id=SID, **kw)


def _mcp_servers(cmd):
    """The inline --mcp-config's server names."""
    return sorted(json.loads(cmd[cmd.index("--mcp-config") + 1])["mcpServers"])


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
