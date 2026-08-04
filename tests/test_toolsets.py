from bridge import toolsets

# Verbatim `claude mcp list` output, including the health-check header and the
# three shapes that matter: an HTTP server, a plugin-bundled one (colons in the
# name), and a stdio one whose failure text carries its own colons.
SAMPLE = """Checking MCP server health…

plugin:cloudflare:cloudflare-api: https://mcp.cloudflare.com/mcp (HTTP) - ✔ Connected
github: https://api.githubcopilot.com/mcp (HTTP) - ✔ Connected
figma: https://mcp.figma.com/mcp (HTTP) - ! Needs authentication
chrome-devtools: npx -y chrome-devtools-mcp@latest - ✔ Connected
railway: railway mcp - ✘ Failed to connect — -32000: MCP error -32000: Connection closed
"""


def test_parses_every_server_shape():
    got = {s["name"]: s for s in toolsets._parse(SAMPLE)}
    assert set(got) == {"plugin:cloudflare:cloudflare-api", "github", "figma",
                        "chrome-devtools", "railway"}
    assert got["github"]["ok"] and not got["figma"]["ok"]
    assert not got["railway"]["ok"]


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
