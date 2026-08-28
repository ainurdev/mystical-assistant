import threading

from bridge import toolsets

# Verbatim `claude mcp list` output, including the health-check header and the
# four shapes that matter: an HTTP server, a plugin-bundled one (colons in the
# name), a claude.ai connector (spaces in the name), and a stdio one whose
# failure text carries its own colons.
SAMPLE = """Checking MCP server health…

plugin:cloudflare:cloudflare-api: https://mcp.cloudflare.com/mcp (HTTP) - ✔ Connected
claude.ai Slack: https://mcp.slack.com/mcp - ✔ Connected
github: https://api.githubcopilot.com/mcp (HTTP) - ✔ Connected
figma: https://mcp.figma.com/mcp (HTTP) - ! Needs authentication
chrome-devtools: npx -y chrome-devtools-mcp@latest - ✔ Connected
railway: railway mcp - ✘ Failed to connect — -32000: MCP error -32000: Connection closed
"""
SAMPLE_NAMES = {"plugin:cloudflare:cloudflare-api", "claude.ai Slack", "github",
                "figma", "chrome-devtools", "railway"}


def test_parses_every_server_shape():
    got = {s["name"]: s for s in toolsets._parse(SAMPLE)}
    assert set(got) == SAMPLE_NAMES
    assert got["github"]["ok"] and not got["figma"]["ok"]
    assert not got["railway"]["ok"]
    assert got["claude.ai Slack"]["rule"] == "mcp__claude_ai_Slack"


def test_plugin_servers_get_the_plugin_prefixed_rule():
    # A rule written against the bare server key never matches a plugin server.
    assert toolsets.rule_for("plugin:cloudflare:cloudflare-api") == \
        "mcp__plugin_cloudflare_cloudflare-api"
    assert toolsets.rule_for("chrome-devtools") == "mcp__chrome-devtools"
    assert toolsets.rule_for("my server!") == "mcp__my_server_"


def test_disabled_rules_reach_the_claude_command_line():
    from bridge import runner
    cmd = runner._base_cmd("hi", 555, stream=True, interactive=True,
                           disabled_tools=["Bash", "mcp__playwright"])
    assert "--disallowedTools" in cmd
    assert cmd[cmd.index("--disallowedTools") + 1] == "Bash,mcp__playwright"
    # Nothing switched off = no flag at all, not an empty one (which would read
    # as a deny rule named "").
    assert "--disallowedTools" not in runner._base_cmd(
        "hi", 555, stream=True, interactive=True, disabled_tools=[])


def test_clean_drops_anything_not_offered_as_a_switch(monkeypatch):
    monkeypatch.setattr(toolsets, "servers", lambda: [{"rule": "mcp__github"}])
    assert toolsets.clean(["Bash", "mcp__github"]) == ["Bash", "mcp__github"]
    # Not a known tool, and not a shell fragment we'd hand to claude either.
    assert toolsets.clean(["Bash; rm -rf /", "mcp__nope", 7]) == []
    assert toolsets.clean("Bash") == []


def test_a_stale_cache_is_served_without_waiting_for_the_health_check(monkeypatch):
    # The regression this guards: `claude mcp list` ran on the thread that spawns
    # claude, so an idle session's next turn stalled for a full health check
    # (measured 8.6s) before the run started.
    import time as _time
    import types

    started = threading.Event()
    release = threading.Event()

    def slow_run(*a, **kw):
        started.set()
        release.wait(5)
        return types.SimpleNamespace(stdout=SAMPLE)

    monkeypatch.setattr(toolsets.subprocess, "run", slow_run)
    monkeypatch.setattr(toolsets, "_cache", (_time.time() - toolsets._TTL - 1,
                                            [{"name": "stale", "rule": "mcp__stale"}]))
    monkeypatch.setattr(toolsets, "_filling", False)

    t0 = _time.monotonic()
    got = toolsets.servers()
    assert _time.monotonic() - t0 < 1          # did not block on the health check
    assert [s["name"] for s in got] == ["stale"]
    assert started.wait(5)                     # ...but the refresh did start

    release.set()
    for _ in range(100):                       # and lands in the cache
        if {s["name"] for s in toolsets._cache[1]} == SAMPLE_NAMES:
            break
        _time.sleep(0.05)
    else:
        raise AssertionError("background refresh never updated the cache")


def test_other_projects_local_servers_are_listed_too(tmp_path, monkeypatch):
    # `claude mcp list` is cwd-scoped: run from the bridge's own checkout it never
    # shows a server scoped `local` to any other project in ~/.claude.json.
    import json
    import types

    cfg = {"mcpServers": {"railway": {"type": "stdio", "command": "railway", "args": ["mcp"]}},
           "projects": {
               "/home/u": {"mcpServers": {
                   "wanderlog": {"type": "stdio", "command": "npx", "args": ["wanderlog-mcp"]},
                   "railway": {"type": "stdio", "command": "railway", "args": ["mcp"]},
               }},
               "/home/u/site": {"mcpServers": {
                   "teamwork": {"type": "http", "url": "https://mcp.ai.teamwork.com"},
               }},
               "/home/u/junk": {"mcpServers": "not-a-dict"},
           }}
    path = tmp_path / "claude.json"
    path.write_text(json.dumps(cfg), encoding="utf-8")
    monkeypatch.setattr(toolsets, "CLAUDE_JSON", str(path))
    monkeypatch.setattr(toolsets.subprocess, "run",
                        lambda *a, **kw: types.SimpleNamespace(stdout=SAMPLE))
    monkeypatch.setattr(toolsets, "_cache", None)
    monkeypatch.setattr(toolsets, "_filling", False)

    got = {s["name"]: s for s in toolsets.servers()}
    assert set(got) == SAMPLE_NAMES | {"wanderlog", "teamwork"}
    assert got["wanderlog"]["dir"] == "/home/u"
    assert got["wanderlog"]["target"] == "npx wanderlog-mcp"
    assert got["wanderlog"]["rule"] == "mcp__wanderlog"
    assert not got["wanderlog"]["ok"]           # configured, not health-checked
    assert got["teamwork"]["target"] == "https://mcp.ai.teamwork.com"
    assert "dir" not in got["railway"]          # the CLI's row wins a name clash


def test_foreign_local_servers_do_not_cost_strict_mcp(monkeypatch):
    from bridge import runner

    rows = [{"name": "teamwork", "rule": "mcp__teamwork", "dir": "/home/u/site"},
            {"name": "github", "rule": "mcp__github"}]
    monkeypatch.setattr(toolsets, "servers", lambda: rows)
    defs = {"github": {"type": "http", "url": "https://api.githubcopilot.com/mcp"}}
    monkeypatch.setattr(runner, "_configured_mcp_servers", lambda cwd: defs)

    # Another project's local server can't load in this cwd anyway — skipping it
    # must not drop --strict-mcp-config the way an undeclarable plugin does.
    extra, strict = runner._external_mcp([], "/somewhere/else")
    assert strict and extra == defs

    # In its own project it has a definition, so it rides along like any other.
    home = {"teamwork": {"type": "http", "url": "https://mcp.ai.teamwork.com"}, **defs}
    monkeypatch.setattr(runner, "_configured_mcp_servers", lambda cwd: home)
    extra, strict = runner._external_mcp([], "/home/u/site")
    assert strict and extra == home
