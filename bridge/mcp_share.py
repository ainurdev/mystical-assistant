"""Which MCP server each agent may use through the bridge.

The user's rule: a server that can be shared is available to every model. If we
don't know that it can be, it stays with the agent it's installed in, until the user
shares it with specific models.

So "known" has to mean something a person checked, not something inferred. A server
with no key in its definition can still act as you (a stdio CLI reads your login from
disk), so a clean definition proves nothing. KNOWN is a short list of servers that
work on local or public data and hold no account of yours. Everything else is
unknown, whatever it looks like, and the Settings row offers a switch per model.

Sharing moves results, not secrets. The bridge calls the server (mcp_client) and
keeps its key or token, but what the tool returns goes to that agent's vendor. Hence
the warning on the switch, and the tool rule below it: a tool that reveals a secret or
changes infrastructure stays off even on a shared server, until enabled by name. On
Rivendell that's reveal_secret, set_shared_secret, the infrastructure and service-action
tools; the rest of a shared Rivendell works.

Where definitions come from: Claude's (the same files runner._configured_mcp_servers
reads) and each agent's own config. Plugin-bundled servers have no definition to read
(same docstring), so they stay where they are and are listed as such. `~/.mystical/
mcp-share.json` holds the choices. An agent's own servers need nothing from here on
that agent, and the gateway doesn't repeat them there.

Stdlib only.
"""

import json
import os
import re
import sys
import threading
import time
import tomllib

from bridge import experimental, mcp_client, mcp_oauth

_FILE = os.path.expanduser(os.environ.get("MCP_SHARE_FILE", "~/.mystical/mcp-share.json"))
_lock = threading.RLock()

# Matched on the server's command, package or URL, never on the name you gave it.
KNOWN = re.compile(r"(@playwright/mcp|playwright-mcp|playwright run-mcp-server|chrome-devtools-mcp|context7|"
                   r"mcp\.deepwiki\.com|@modelcontextprotocol/server-(memory|sequential-thinking|time|fetch))", re.I)
SENSITIVE = re.compile(r"secret|credential|password|passwd|api[_-]?key|token|infrastructure|"
                       r"deploy|service[_-]?action|service[_-]?variables|impersonat", re.I)
_CRED_KEY = re.compile(r"KEY|TOKEN|SECRET|PASS|AUTH|COOKIE", re.I)

_clients: dict = {}          # (server, fingerprint) -> mcp_client.Client
_tool_cache: dict = {}       # server -> (when, tools)
_CACHE_S = 600


def _load() -> dict:
    try:
        with open(_FILE, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(data: dict) -> None:
    os.makedirs(os.path.dirname(_FILE), mode=0o700, exist_ok=True)
    tmp = _FILE + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, _FILE)


def _read_json(path: str) -> dict:
    try:
        with open(os.path.expanduser(path), encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _kimi() -> dict:
    home = os.environ.get("KIMI_CODE_HOME", "~/.kimi-code")
    return _read_json(os.path.join(home, "mcp.json")).get("mcpServers") or {}


def _gemini() -> dict:
    return _read_json("~/.gemini/settings.json").get("mcpServers") or {}


def _codex() -> dict:
    try:
        with open(os.path.expanduser("~/.codex/config.toml"), "rb") as f:
            return tomllib.load(f).get("mcp_servers") or {}
    except (OSError, tomllib.TOMLDecodeError):
        return {}


def _opencode() -> dict:
    out = {}
    for name, d in (_read_json("~/.config/opencode/opencode.json").get("mcp") or {}).items():
        if not isinstance(d, dict) or d.get("enabled") is False:
            continue
        if d.get("type") == "remote":
            out[name] = {"url": d.get("url"), "headers": d.get("headers") or {}}
        elif d.get("command"):
            cmd = d["command"] if isinstance(d["command"], list) else [d["command"]]
            out[name] = {"command": cmd[0], "args": cmd[1:], "env": d.get("environment") or {}}
    return out


_AGENT_SOURCES = (("kimi", _kimi), ("gemini", _gemini), ("codex", _codex), ("opencode", _opencode))


def _claude(cwd: "str | None") -> dict:
    from bridge import runner   # local: runner imports the gateway side of this
    return runner._configured_mcp_servers(cwd)


def definitions(cwd: "str | None") -> dict:
    """server name -> {home: the agent it's installed in, def}. The first home wins
    a name, Claude's before the others, as it's the one the bridge manages."""
    out: dict = {}
    for name, d in _claude(cwd).items():
        out[name] = {"home": "claude", "def": d}
    for agent, read in _AGENT_SOURCES:
        try:
            for name, d in read().items():
                if isinstance(d, dict) and name not in out:
                    out[name] = {"home": agent, "def": d}
        except Exception as e:  # noqa: BLE001 - someone else's config file
            print(f"[mcp_share] {agent}: {e!r}", file=sys.stderr)
    return out


def _haystack(d: dict) -> str:
    return " ".join([str(d.get("command") or ""), " ".join(map(str, d.get("args") or [])), str(d.get("url") or "")])


def known(d: dict) -> bool:
    return bool(KNOWN.search(_haystack(d)))


def holds_key(d: dict) -> bool:
    """A credential in the definition. Only for the row's words: see the docstring."""
    env = d.get("env") if isinstance(d.get("env"), dict) else {}
    hdr = d.get("headers") if isinstance(d.get("headers"), dict) else {}
    return any(_CRED_KEY.search(str(k)) for k in [*env, *hdr])


def shared_with(name: str, d: dict, agent: str, project: "str | None" = None, session: "dict | None" = None) -> bool:
    """Whether this agent gets this server through the bridge. A project's or a chat's pick
    (bridge/tool_policy.py) comes first, then the machine's, then known or not."""
    from bridge import tool_policy
    near, _level = tool_policy.lookup("mcp", name, agent, project, session)
    if near is not None:
        return near
    pick = (_load().get(name) or {}).get("agents") or {}
    if agent in pick:
        return bool(pick[agent])
    return known(d)


def tool_allowed(name: str, tool: str) -> bool:
    if not SENSITIVE.search(tool):
        return True
    return bool(((_load().get(name) or {}).get("tools") or {}).get(tool))


def for_agent(agent: str, cwd: "str | None", project: "str | None" = None, session: "dict | None" = None) -> dict:
    """server name -> definition, for what this agent gets from the bridge. Its own
    servers aren't repeated: it already has them."""
    if not experimental.enabled():
        return {}
    return {n: v["def"] for n, v in definitions(cwd).items()
            if v["home"] != agent and shared_with(n, v["def"], agent, project, session)}


def set_share(name: str, agent: str, on: bool) -> None:
    with _lock:
        data = _load()
        row = data.setdefault(name, {})
        row.setdefault("agents", {})[agent] = bool(on)
        _save(data)


def set_tool(name: str, tool: str, on: bool) -> None:
    with _lock:
        data = _load()
        row = data.setdefault(name, {})
        row.setdefault("tools", {})[tool] = bool(on)
        _save(data)


def _client(name: str, d: dict) -> mcp_client.Client:
    key = (name, json.dumps(d, sort_keys=True, default=str))
    with _lock:
        for k in [k for k in _clients if k[0] == name and k != key]:
            _clients.pop(k).close()
        for c in _clients.values():
            c.close_if_idle()
        if key not in _clients:
            _clients[key] = mcp_client.Client(d, token=lambda: mcp_oauth.token(name))
        return _clients[key]


def tools_of(name: str, d: dict, refresh: bool = False) -> list:
    """A server's tools. Cached: listing can mean starting the server."""
    cached = _tool_cache.get(name)
    if cached and not refresh and time.time() - cached[0] < _CACHE_S:
        return cached[1]
    tools = _client(name, d).tools()
    _tool_cache[name] = (time.time(), tools)
    return tools


def call(name: str, d: dict, tool: str, args: dict) -> dict:
    return _client(name, d).call(tool, args)


def state(cwd: "str | None", agents: list) -> list:
    """The Settings rows: every server, where it lives, who has it, what's held back."""
    data = _load()
    rows = []
    for name, v in sorted(definitions(cwd).items()):
        d, pick = v["def"], (data.get(name) or {})
        http = bool(d.get("url"))
        cached = _tool_cache.get(name)
        tools = cached[1] if cached else None
        rows.append({
            "name": name, "home": v["home"], "transport": "http" if http else "stdio",
            "known": known(d), "holds_key": holds_key(d),
            "needs_login": bool(http and not holds_key(d) and not mcp_oauth.logged_in(name) and not known(d)),
            "logged_in": mcp_oauth.logged_in(name),
            "agents": {a: shared_with(name, d, a) for a in agents if a != v["home"]},
            "tools": None if tools is None else [
                {"name": t.get("name"), "sensitive": bool(SENSITIVE.search(t.get("name") or "")),
                 "on": tool_allowed(name, t.get("name") or "")} for t in tools],
        })
    return rows
