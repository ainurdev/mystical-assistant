"""Where each tool, MCP server and skill is available: machine, project, chat.

One answer to "why is this off here?": the nearest level that says anything wins, chat over
project over machine, and the cell says which one that was. Picks live in
~/.mystical/tool-policy.json for machine and project, and in the chat's own chat_config.

What a level can say depends on what the agent lets us do, and the page says that too:
  - Claude: any built-in, and any pattern like Bash(git push*), through --disallowedTools.
    A chat's existing switches (the ⚒ modal, disabled_tools) stay what they are and are read
    as the chat level for Claude.
  - An agent over ACP takes no such list, so its built-ins can't be switched off from here.
    Its tools from Mystical can: they're filtered in the gateway, for any agent alike.
  - An MCP server shared through the gateway can be turned off per level for any agent.
    The MCP server's own home isn't ours to edit, so "in Kimi" rows are read only.

Stdlib only.
"""

import json
import os
import threading

from bridge import store

_FILE = os.path.expanduser(os.environ.get("TOOL_POLICY_FILE", "~/.mystical/tool-policy.json"))
_lock = threading.Lock()
LEVELS = ("machine", "project", "chat")

# Past toolsets.BUILTINS' short list: everything Claude Code documents that can usefully be
# denied. Read/Grep/Glob stay out, for the reason toolsets gives.
CLAUDE_BUILTINS = (
    ("Bash", "Shell"), ("Edit", "Edit files"), ("Write", "Create files"), ("NotebookEdit", "Edit notebooks"),
    ("WebSearch", "Web search"), ("WebFetch", "Fetch URLs"), ("Agent", "Subagents"), ("Skill", "Skills"),
    ("Workflow", "Workflows"), ("TodoWrite", "Task list"), ("AskUserQuestion", "Question cards"),
    ("EnterPlanMode", "Plan mode"), ("SendMessage", "Messages between sessions"), ("ListAgents", "List sessions"),
    ("ToolSearch", "Deferred tools"), ("Monitor", "Monitor"), ("CronCreate", "Scheduled prompts"),
)


def _load() -> dict:
    try:
        with open(_FILE, encoding="utf-8") as f:
            v = json.load(f)
        return v if isinstance(v, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(d: dict) -> None:
    os.makedirs(os.path.dirname(_FILE), mode=0o700, exist_ok=True)
    with open(_FILE + ".tmp", "w", encoding="utf-8") as f:
        json.dump(d, f, indent=1)
    os.replace(_FILE + ".tmp", _FILE)


def _chat_policy(session: "dict | None") -> dict:
    return store.parse_json((session or {}).get("chat_config")).get("_policy") or {}


def _scopes(project: "str | None", session: "dict | None") -> list:
    d = _load()
    return [("chat", _chat_policy(session)), ("project", (d.get("projects") or {}).get(project or "") or {}),
            ("machine", d.get("machine") or {})]


def key(section: str, name: str, agent: str) -> str:
    return f"{section}:{name}:{agent}"


def lookup(section: str, name: str, agent: str, project: "str | None", session: "dict | None") -> "tuple[bool | None, str | None]":
    """(the pick, the level it came from), or (None, None) when nothing says."""
    k = key(section, name, agent)
    for level, picks in _scopes(project, session):
        if k in picks:
            return bool(picks[k]), level
    return None, None


def set_pick(level: str, section: str, name: str, agent: str, on: "bool | None",
             project: "str | None", session: "dict | None") -> None:
    """Set a level's pick; None clears it, so the next level decides."""
    if level not in LEVELS:
        raise ValueError("level must be machine, project or chat")
    k = key(section, name, agent)
    if level == "chat":
        if not session:
            raise ValueError("That needs a chat.")
        cfg = store.parse_json(session.get("chat_config"))
        pol = cfg.setdefault("_policy", {})
        pol.pop(k, None) if on is None else pol.__setitem__(k, bool(on))
        store.set_session_field(session["id"], "chat_config", json.dumps(cfg))
        return
    if level == "project" and not project:
        raise ValueError("That needs a project.")
    with _lock:
        d = _load()
        picks = d.setdefault("machine", {}) if level == "machine" else d.setdefault("projects", {}).setdefault(project, {})
        picks.pop(k, None) if on is None else picks.__setitem__(k, bool(on))
        _save(d)


def patterns(project: "str | None", session: "dict | None") -> list:
    """Deny patterns in force, nearest level first: `Bash(git push*)`. Claude only."""
    out = []
    d = _load()
    for scope in (_chat_policy(session).get("_patterns") or [], ((d.get("projects") or {}).get(project or "") or {}).get("_patterns") or [],
                  (d.get("machine") or {}).get("_patterns") or []):
        out += [p for p in scope if p not in out]
    return out


def set_patterns(level: str, rows: list, project: "str | None", session: "dict | None") -> list:
    clean = []
    for p in rows or []:
        p = str(p).strip()
        if p and len(p) < 200 and p[0].isalpha() and p not in clean:
            clean.append(p)
    if level == "chat":
        if not session:
            raise ValueError("That needs a chat.")
        cfg = store.parse_json(session.get("chat_config"))
        cfg.setdefault("_policy", {})["_patterns"] = clean
        store.set_session_field(session["id"], "chat_config", json.dumps(cfg))
        return clean
    if level not in LEVELS or (level == "project" and not project):
        raise ValueError("Pick a level, and a project for that level.")
    with _lock:
        d = _load()
        picks = d.setdefault("machine", {}) if level == "machine" else d.setdefault("projects", {}).setdefault(project, {})
        picks["_patterns"] = clean
        _save(d)
    return clean


def claude_denied(project: "str | None", session: "dict | None") -> list:
    """--disallowedTools entries from the machine and project levels and patterns. The chat's
    own switches are disabled_tools, read separately as ever; a chat-level ON beats a
    wider OFF."""
    out = []
    for rule, _label in CLAUDE_BUILTINS:
        on, _ = lookup("tool", rule, "claude", project, session)
        if on is False:
            out.append(rule)
    for p in patterns(project, session):
        if p not in out:
            out.append(p)
    return out


def gateway_off(agent: str, project: "str | None", session: "dict | None", names: "set") -> set:
    """Mystical tools switched off for this agent here."""
    return {n for n in names if lookup("mystical", n, agent, project, session)[0] is False}
