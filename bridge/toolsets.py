"""What a session is allowed to reach: built-in tools and MCP servers.

Every entry here is a Claude Code *deny rule* — the strings that go to
`--disallowedTools`. A bare tool name (`Bash`) or a bare server name
(`mcp__playwright`) doesn't merely block the tool, it removes it from the
model's context, so turning a server off buys back its schema tokens too.

Plugin-bundled servers are named `mcp__plugin_<plugin>_<server>` (see
https://code.claude.com/docs/en/permissions); `claude mcp list` prints those as
`plugin:<plugin>:<server>`, so the two forms are translated here.
"""

import re
import subprocess
import threading
import time

# The built-ins worth a switch. Not the full tool list on purpose: Read/Grep/Glob
# are how the agent sees anything at all, and denying them makes a session that
# can't work rather than one that's scoped.
BUILTINS = [
    {"rule": "Bash", "label": "Shell", "hint": "Bash, BashOutput, KillShell"},
    {"rule": "Edit", "label": "Edit files", "hint": "Edit"},
    {"rule": "Write", "label": "Create files", "hint": "Write"},
    {"rule": "WebSearch", "label": "Web search", "hint": "WebSearch"},
    {"rule": "WebFetch", "label": "Fetch URLs", "hint": "WebFetch"},
    {"rule": "Task", "label": "Subagents", "hint": "Task"},
]
_BUILTIN_RULES = {b["rule"] for b in BUILTINS}

# `claude mcp list` health-checks every server, which takes seconds. The set of
# configured servers changes about never, so one call is reused.
_TTL = 300
_cache: "tuple[float, list[dict]] | None" = None
_lock = threading.Lock()

# "name: rest - ✔ Connected" / "name: rest - ! Needs authentication". The name is
# matched lazily rather than as "no colons": a plugin server is called
# `plugin:cloudflare:cloudflare-api`, and only the `: ` before the URL ends it.
_LINE = re.compile(r"^(?P<name>\S+?):\s+(?P<rest>.*?)\s+-\s+(?P<status>.+)$")


def rule_for(name: str) -> str:
    """`claude mcp list` name -> the deny rule that matches all of its tools."""
    if name.startswith("plugin:"):
        _, plugin, server = name.split(":", 2)
        return f"mcp__plugin_{_slug(plugin)}_{_slug(server)}"
    return f"mcp__{_slug(name)}"


def _slug(s: str) -> str:
    """Anything outside [A-Za-z0-9_-] becomes `_`, matching how Claude Code
    builds callable MCP tool names."""
    return re.sub(r"[^A-Za-z0-9_-]", "_", s)


def _parse(out: str) -> list[dict]:
    servers = []
    for line in out.splitlines():
        m = _LINE.match(line.strip())
        if not m:
            continue
        name = m.group("name")
        status = m.group("status")
        servers.append({
            "name": name,
            "rule": rule_for(name),
            # The health check is advisory — a server that needs auth is still
            # configured, and still costs context until it's switched off.
            "ok": status.startswith("✔"),
            "status": status,
        })
    return servers


def servers(refresh: bool = False) -> list[dict]:
    """Configured MCP servers, newest health check within _TTL. Empty on any
    failure — a settings panel with no servers beats a 500."""
    global _cache
    with _lock:
        if not refresh and _cache and time.time() - _cache[0] < _TTL:
            return _cache[1]
    from bridge import runner  # local: runner imports this module for the deny list
    try:
        p = subprocess.run([runner.claude_bin(), "mcp", "list"],
                           capture_output=True, text=True, timeout=60)
        found = _parse(p.stdout)
    except (OSError, subprocess.SubprocessError):
        found = []
    with _lock:
        _cache = (time.time(), found)
    return found


def clean(rules) -> list[str]:
    """Keep only rules we know how to draw a switch for, so a stored session can
    never smuggle an arbitrary string onto the claude command line."""
    if not isinstance(rules, list):
        return []
    known = _BUILTIN_RULES | {s["rule"] for s in servers()}
    return sorted({r for r in rules if isinstance(r, str) and r in known})
