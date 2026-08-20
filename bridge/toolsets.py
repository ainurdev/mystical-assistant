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

# `claude mcp list` health-checks every server, which takes seconds (measured
# 8.6s here, 15 servers). The set of configured servers changes about never, so
# one call is reused — and once it has ever succeeded, no caller waits on it
# again: a stale list is served while the refresh runs off-thread.
_TTL = 300
_cache: "tuple[float, list[dict]] | None" = None
_lock = threading.Lock()
_filling = False   # a background refresh is already in flight

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
            # What it connects to: "https://… (HTTP)" or a stdio command line.
            "target": m.group("rest"),
            # The health check is advisory — a server that needs auth is still
            # configured, and still costs context until it's switched off.
            "ok": status.startswith("✔"),
            "status": status,
        })
    return servers


def _fill() -> list[dict]:
    """Run the health check and store it. Empty on any failure — a settings panel
    with no servers beats a 500."""
    global _cache, _filling
    from bridge import runner  # local: runner imports this module for the deny list
    try:
        p = subprocess.run([runner.claude_bin(), "mcp", "list"],
                           capture_output=True, text=True, timeout=60)
        found = _parse(p.stdout)
    except (OSError, subprocess.SubprocessError):
        found = []
    with _lock:
        _cache = (time.time(), found)
        _filling = False
    return found


def servers(refresh: bool = False) -> list[dict]:
    """Configured MCP servers, health-checked within _TTL.

    Stale-while-revalidate: past the TTL the previous answer is returned
    immediately and the refresh happens on a background thread. Blocking here
    blocks the thread that spawns claude, so an idle session's next turn used to
    sit for the length of a full health check before the run even started —
    which reads as the bridge hanging, for a list that changes about never.
    refresh=True forces the synchronous path, for a panel that wants live status.
    """
    global _filling
    with _lock:
        cached = _cache
        if cached and not refresh:
            if time.time() - cached[0] < _TTL:
                return cached[1]
            if not _filling:
                _filling = True
                threading.Thread(target=_fill, daemon=True).start()
            return cached[1]
    # ponytail: concurrent cold callers each fetch. Bounded to the boot window,
    # and warm() closes it; add an in-flight wait if that ever shows up.
    return _fill()


def invalidate() -> None:
    """Forget the cached list. A server was just added, removed or re-authed,
    so the next servers() call refetches instead of serving the old answer."""
    global _cache
    with _lock:
        _cache = None


def ready() -> bool:
    """True once the list has been fetched at least once — i.e. servers() will
    answer without shelling out. Lets a caller say what it is waiting for."""
    with _lock:
        return _cache is not None


def warm() -> None:
    """Fill the cache off the boot thread, so the first turn never pays for the
    health check. Called once at start-up; safe if it fails."""
    global _filling
    with _lock:
        if _filling or _cache:
            return
        _filling = True
    threading.Thread(target=_fill, daemon=True).start()


def clean(rules) -> list[str]:
    """Keep only rules we know how to draw a switch for, so a stored session can
    never smuggle an arbitrary string onto the claude command line."""
    if not isinstance(rules, list):
        return []
    known = _BUILTIN_RULES | {s["rule"] for s in servers()}
    return sorted({r for r in rules if isinstance(r, str) and r in known})
