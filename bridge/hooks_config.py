"""Your own hooks, in each agent's own config: list, add, edit, remove, copy across.

Rules (bridge/rules.py) cover what most people want from a hook. This is for the rest: a
real shell command on a real event, kept where that agent reads it, so it also fires when
you run the agent in a terminal.

  Claude   ~/.claude/settings.json, or .claude/settings.json in a project
  Kimi     config.toml under its home, user level only: Kimi has no project hooks

A hook is a shell command that runs on every matching tool call, so adding or changing one
is for the dashboard only. The Mini App's route refuses, and only shows them.

Writes are atomic and leave everything else in the file alone. Kimi's TOML has no writer in
stdlib, so a hook there is a block of text inserted before Mystical's own, and the result
must parse before it replaces the file: an unknown field stops Kimi loading its config at
all, so only event, matcher, command and timeout are written.

Copying only offers events both agents have. Mystical's own hooks are listed read-only, with
what each does, because they run per turn and exist in no file. Stdlib only.
"""

import hashlib
import json
import os
import re
import tomllib

from bridge import rules

CLAUDE_EVENTS = ("SessionStart", "UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolUse",
                 "PostToolUseFailure", "PostToolBatch", "Notification", "SubagentStart", "SubagentStop", "Stop",
                 "StopFailure", "PreCompact", "PostCompact", "SessionEnd", "CwdChanged", "FileChanged")
KIMI_EVENTS = ("UserPromptSubmit", "UserPromptQueued", "PreToolUse", "Stop", "TurnStarted", "PostToolUse",
               "PostToolUseFailure", "PermissionRequest", "PermissionResult", "SessionStart", "SessionEnd",
               "SubagentStart", "SubagentStop", "TaskStarted", "StopFailure", "Interrupt", "PreCompact", "PostCompact",
               "Notification")
CAN_BLOCK = {"claude": {"UserPromptSubmit", "PreToolUse", "PermissionRequest", "PostToolBatch", "SubagentStop", "Stop",
                        "PreCompact"},
             "kimi": {"UserPromptSubmit", "PreToolUse", "Stop"}}
OWN = (
    {"name": "Ask with a card", "event": "Stop", "agent": "claude",
     "about": "If an answer ends by offering options in prose, it goes back once to ask them as a card you can tap."},
    {"name": "Rivendell push check", "event": "PreToolUse", "agent": "claude",
     "about": "Holds back a push from a repo on a Rivendell board that names no task, once per branch."},
    {"name": "Rivendell push check", "event": "pre-push (git)", "agent": "other agents",
     "about": "The same check for agents with no hooks to use, as a git hook set for that agent's process alone."},
)
_NAME = re.compile(r"^[A-Za-z][A-Za-z]{2,40}$")


def _claude_path(scope: str, cwd: "str | None") -> "str | None":
    if scope == "user":
        return os.path.expanduser(os.environ.get("CLAUDE_SETTINGS_FILE", "~/.claude/settings.json"))
    return os.path.join(cwd, ".claude", "settings.json") if cwd else None


def _kimi_path() -> str:
    return os.path.join(os.path.expanduser(os.environ.get("KIMI_CODE_HOME") or "~/.kimi-code"), "config.toml")


def _id(*parts) -> str:
    return hashlib.sha256("\0".join(str(p) for p in parts).encode()).hexdigest()[:16]


def _read_json(path: "str | None") -> dict:
    try:
        with open(path or "", encoding="utf-8") as f:
            v = json.load(f)
        return v if isinstance(v, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_json(path: str, data: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".mystical.tmp", "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
        f.write("\n")
    os.replace(path + ".mystical.tmp", path)


def _claude_rows(cwd: "str | None") -> list:
    rows = []
    for scope in ("user", "project"):
        path = _claude_path(scope, cwd)
        hooks = _read_json(path).get("hooks")
        for event, entries in (hooks if isinstance(hooks, dict) else {}).items():
            for entry in entries if isinstance(entries, list) else []:
                for h in (entry.get("hooks") or []) if isinstance(entry, dict) else []:
                    if not isinstance(h, dict):
                        continue
                    cmd = h.get("command") or h.get("url") or h.get("prompt") or ""
                    rows.append({"id": _id("claude", scope, event, entry.get("matcher") or "", cmd), "agent": "claude",
                                 "scope": scope, "event": event, "matcher": entry.get("matcher") or "",
                                 "type": h.get("type") or "command", "command": cmd, "timeout": h.get("timeout"),
                                 "can_block": event in CAN_BLOCK["claude"], "editable": h.get("type", "command") == "command"})
    return rows


def _kimi_rows() -> list:
    try:
        with open(_kimi_path(), "rb") as f:
            hooks = tomllib.load(f).get("hooks") or []
    except (OSError, tomllib.TOMLDecodeError):
        return []
    rows = []
    for h in hooks:
        if not isinstance(h, dict) or "hook_dispatch.py" in str(h.get("command")):
            continue       # Mystical's managed block: it's Rules, not yours
        rows.append({"id": _id("kimi", "user", h.get("event"), h.get("matcher") or "", h.get("command")), "agent": "kimi",
                     "scope": "user", "event": h.get("event"), "matcher": h.get("matcher") or "", "type": "command",
                     "command": h.get("command"), "timeout": h.get("timeout"),
                     "can_block": h.get("event") in CAN_BLOCK["kimi"], "editable": True})
    return rows


def listing(cwd: "str | None") -> dict:
    return {"hooks": _claude_rows(cwd) + _kimi_rows(), "own": list(OWN),
            "events": {"claude": list(CLAUDE_EVENTS), "kimi": list(KIMI_EVENTS)},
            "can_block": {k: sorted(v) for k, v in CAN_BLOCK.items()}}


def _check(agent: str, event: str, command: str) -> None:
    allowed = {"claude": CLAUDE_EVENTS, "kimi": KIMI_EVENTS}.get(agent)
    if allowed is None:
        raise ValueError("Hooks can be set for Claude and Kimi.")
    if event not in allowed:
        raise ValueError(f"{agent.title()} has no {event} event.")
    if not str(command or "").strip() or "\n" in command:
        raise ValueError("A hook needs a one-line command.")


def add(agent: str, scope: str, event: str, matcher: str, command: str, cwd: "str | None", timeout: "int | None" = None) -> None:
    _check(agent, event, command)
    matcher = str(matcher or "").strip()
    if agent == "claude":
        path = _claude_path(scope, cwd)
        if not path:
            raise ValueError("A project hook needs a project.")
        data = _read_json(path)
        entry = {"hooks": [{"type": "command", "command": command, **({"timeout": int(timeout)} if timeout else {})}]}
        if matcher:
            entry["matcher"] = matcher
        data.setdefault("hooks", {}).setdefault(event, []).append(entry)
        _write_json(path, data)
        return
    if scope != "user":
        raise ValueError("Kimi has no project hooks: it only reads its user-level config.")
    block = f'[[hooks]]\nevent = {json.dumps(event)}\ncommand = {json.dumps(command)}\n'
    if matcher:
        block += f"matcher = {json.dumps(matcher)}\n"
    if timeout:
        block += f"timeout = {max(1, min(int(timeout), 600))}\n"
    _edit_kimi(lambda text: _insert(text, block))


def _insert(text: str, block: str) -> str:
    """Before Mystical's managed block, so that block stays whole at the end."""
    at = text.find(rules.KIMI_BEGIN)
    head, tail = (text[:at], text[at:]) if at >= 0 else (text, "")
    return head.rstrip("\n") + "\n\n" + block + ("\n" + tail if tail else "")


def _edit_kimi(fn) -> None:
    path = _kimi_path()
    try:
        with open(path, encoding="utf-8") as f:
            old = f.read()
    except FileNotFoundError:
        old = ""
    new = fn(old)
    tomllib.loads(new)      # a file Kimi can't load is worse than no hook
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".mystical.tmp", "w", encoding="utf-8") as f:
        f.write(new)
    os.replace(path + ".mystical.tmp", path)


def remove(hook_id: str, cwd: "str | None") -> dict:
    """Take a hook out; returns it, for an edit to re-add. ValueError if it's gone."""
    row = next((r for r in _claude_rows(cwd) + _kimi_rows() if r["id"] == hook_id), None)
    if row is None:
        raise ValueError("That hook isn't there any more.")
    if row["agent"] == "claude":
        path = _claude_path(row["scope"], cwd)
        data = _read_json(path)
        entries = data["hooks"][row["event"]]
        for entry in entries:
            kept = [h for h in entry.get("hooks") or [] if not (
                (entry.get("matcher") or "") == row["matcher"] and (h.get("command") or h.get("url") or h.get("prompt") or "") == row["command"])]
            entry["hooks"] = kept
        data["hooks"][row["event"]] = [e for e in entries if e.get("hooks")]
        if not data["hooks"][row["event"]]:
            del data["hooks"][row["event"]]
        if not data["hooks"]:
            del data["hooks"]
        _write_json(path, data)
    else:
        def cut(text: str) -> str:
            parts = re.split(r"(?m)^(?=\[\[hooks\]\]\s*$)", text)
            for i, part in enumerate(parts):
                if not part.startswith("[[hooks]]"):
                    continue
                body = part.split("\n# ")[0]
                try:
                    got = tomllib.loads(body).get("hooks", [{}])[0]
                except tomllib.TOMLDecodeError:
                    continue
                if got.get("command") == row["command"] and got.get("event") == row["event"]:
                    tail = part[len(body):]
                    parts[i] = tail.lstrip("\n")
                    return "".join(parts).rstrip("\n") + "\n"
            raise ValueError("Couldn't find that hook in Kimi's config.")
        _edit_kimi(cut)
    return row


def edit(hook_id: str, event: str, matcher: str, command: str, cwd: "str | None", timeout: "int | None" = None) -> None:
    """Remove and add back. If the new values are refused, the old one stays."""
    row = next((r for r in _claude_rows(cwd) + _kimi_rows() if r["id"] == hook_id), None)
    if row is None:
        raise ValueError("That hook isn't there any more.")
    if not row["editable"]:
        raise ValueError("Only command hooks can be edited here.")
    _check(row["agent"], event, command)
    remove(hook_id, cwd)
    add(row["agent"], row["scope"], event, matcher, command, cwd, timeout)


def copy_to(hook_id: str, agent: str, cwd: "str | None") -> None:
    row = next((r for r in _claude_rows(cwd) + _kimi_rows() if r["id"] == hook_id), None)
    if row is None:
        raise ValueError("That hook isn't there any more.")
    add(agent, "user", row["event"], row["matcher"], row["command"], cwd, row.get("timeout"))
