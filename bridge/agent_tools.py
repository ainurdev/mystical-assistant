"""The AGENT TOOLS page: one grid of what's available to which agent, and where it's set.

A row is a thing (an MCP server, a skill, a built-in tool, a Mystical tool). A column is an
agent. A cell says, in the same words everywhere:
  installed  it lives in this agent; Mystical doesn't manage it
  shared     another agent's, reaching this one through Mystical
  on / off   a switch that works here, and `level` says who set it
  login      needs a login first
  cant       this agent can't do it, and `why` says so, rather than a switch that does nothing

Levels and picks are bridge/tool_policy.py's. This module only reads the sources and joins
them, so nothing about how each thing is really applied lives here. Stdlib only.
"""

import sys

from bridge import acp_agents, agent_caps, gateway_tools, mcp_oauth, mcp_share, profiles, skill_share, tool_policy


def agents_here() -> list:
    rows = [{"id": "claude", "label": "Claude"}]
    try:
        rows += [{"id": p["id"], "label": p.get("label") or p["id"]} for p in acp_agents.available() if p.get("installed")]
    except Exception as e:  # noqa: BLE001
        print(f"[agent_tools] {e!r}", file=sys.stderr)
    return rows


def _mcp_cells(name: str, v: dict, agents: list, project, session) -> dict:
    d, home = v["def"], v["home"]
    out = {}
    for a in agents:
        if a == home:
            out[a] = {"state": "installed", "level": None}
            continue
        on, level = tool_policy.lookup("mcp", name, a, project, session)
        if on is None:
            on, level = mcp_share.shared_with(name, d, a), "default" if mcp_share.known(d) else None
        http_needs = bool(d.get("url")) and not mcp_share.holds_key(d) and not mcp_share.known(d) and not mcp_oauth.logged_in(name)
        out[a] = {"state": "login" if on and http_needs else "shared" if on else "off", "level": level}
    return out


def grid(cwd, project, session) -> dict:
    agents = agents_here()
    ids = [a["id"] for a in agents]
    mcp = []
    for name, v in sorted(mcp_share.definitions(cwd).items()):
        d = v["def"]
        cached = mcp_share._tool_cache.get(name)
        mcp.append({"name": name, "home": v["home"], "transport": "http" if d.get("url") else "stdio",
                    "known": mcp_share.known(d), "holds_key": mcp_share.holds_key(d), "logged_in": mcp_oauth.logged_in(name),
                    "cells": _mcp_cells(name, v, ids, project, session),
                    "tools": None if not cached else [
                        {"name": t.get("name"), "sensitive": bool(mcp_share.SENSITIVE.search(t.get("name") or "")),
                         "on": mcp_share.tool_allowed(name, t.get("name") or "")} for t in cached[1]]})
    skills = []
    for s in skill_share.state(cwd):
        cells = {}
        for a in ids:
            here = (s["home"] == "claude") == (a == "claude")
            if here:
                cells[a] = {"state": "installed", "level": None}
            elif s["conflict"]:
                cells[a] = {"state": "cant", "why": "Another skill already has that name there."}
            else:
                cells[a] = {"state": "shared" if s["on"] else "off", "level": "machine" if not s["claude_only"] or s["on"] else None}
        skills.append({**s, "cells": cells})
    tools = []
    for rule, label in tool_policy.CLAUDE_BUILTINS:
        cells = {}
        for a in ids:
            if a != "claude":
                cells[a] = {"state": "cant", "why": f"{a.title()} takes no tool list over ACP, so this can't be switched here."}
                continue
            on, level = tool_policy.lookup("tool", rule, a, project, session)
            if session is not None and on is None and rule in (profiles.tools_for(session) or []):
                on, level = False, "chat"
            cells[a] = {"state": "on" if on is not False else "off", "level": level}
        tools.append({"name": rule, "label": label, "cells": cells})
    mystical = []
    all_tools = [*gateway_tools.CORE_ALL, *gateway_tools.EXTRA_ALL, *gateway_tools.EXTRA_AGENT]
    for t in all_tools:
        cells = {}
        for a in ids:
            if a == "claude" and t in gateway_tools.EXTRA_AGENT:
                cells[a] = {"state": "cant", "why": "Claude has its own."}
                continue
            on, level = tool_policy.lookup("mystical", t["name"], a, project, session)
            cells[a] = {"state": "off" if on is False else "on", "level": level}
        mystical.append({"name": t["name"], "about": t["description"].split(". ")[0], "cells": cells})
    return {"agents": agents, "mcp": mcp, "skills": skills, "tools": tools, "mystical": mystical,
            "patterns": tool_policy.patterns(project, session),
            "caps": {a: agent_caps.caps(a) for a in ids}}
