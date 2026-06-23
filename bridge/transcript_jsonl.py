"""Translate Claude Code's native session JSONL into the bridge's transcript
shape ({turns, events, next_cursor}) so the dashboard / Mini App renderers can
show a session that was started in VSCode/terminal with full fidelity.

Native transcripts live at ~/.claude/projects/<enc-cwd>/<uuid>.jsonl. Because the
filename is the globally-unique session UUID, a transcript is located by globbing
on the UUID — we never reverse Claude's lossy directory encoding.

The emitted event vocabulary matches the runner's (text / tool / tool_done), so
both frontends render it unchanged. Internal `thinking` blocks and subagent
`isSidechain` records are dropped — the bridge never surfaces those (the runner
doesn't either). Stdlib only; no bridge.config dependency.
"""

import glob
import json
import os
import re
from datetime import datetime

PROJECTS_DIR = os.path.expanduser("~/.claude/projects")

# Leading system/IDE injections Claude Code prepends to a user turn (e.g.
# <ide_opened_file>…</ide_opened_file>, <command-name>…</command-name>); stripped
# so auto-titles read as the human's actual prompt.
_LEADING_TAGS = re.compile(r"^(?:\s*<[^>]+>.*?</[^>]+>\s*|\s*<[^>]+/>\s*)+", re.DOTALL)

# Mirrors bridge.runner._summarize_tool (kept inline to keep this module free of
# the runner's heavy imports / env requirements).
_SUMMARY_KEYS = ("command", "file_path", "path", "pattern", "url", "query", "prompt")


def find_transcript(claude_session_id: str) -> str | None:
    """Locate the JSONL for a native session UUID, regardless of which project
    directory it lives in (the filename is globally unique)."""
    if not claude_session_id:
        return None
    matches = glob.glob(os.path.join(PROJECTS_DIR, "*", claude_session_id + ".jsonl"))
    return matches[0] if matches else None


def _summarize_tool(name: str, inp) -> str:
    if not isinstance(inp, dict):
        return ""
    if name == "Bash":
        return str(inp.get("command") or "")[:120]
    for key in _SUMMARY_KEYS:
        if inp.get(key):
            return str(inp[key])[:120]
    return ""


def _ts(rec) -> float:
    t = rec.get("timestamp")
    if not isinstance(t, str):
        return 0.0
    try:
        return datetime.fromisoformat(t.replace("Z", "+00:00")).timestamp()
    except ValueError:
        return 0.0


def _text_of(content) -> str:
    """The plain-text of a user message (a raw string, or its text blocks joined)."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts = [b.get("text", "") for b in content
                 if isinstance(b, dict) and b.get("type") == "text"]
        return "\n".join(p for p in parts if p)
    return ""


def _is_tool_result(content) -> bool:
    return isinstance(content, list) and any(
        isinstance(b, dict) and b.get("type") == "tool_result" for b in content)


def first_user_text(path: str) -> str | None:
    """Cheap title source: the first real user prompt in a transcript (used by the
    discovery scanner). Returns None if none found."""
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if (isinstance(rec, dict) and rec.get("type") == "user"
                        and not rec.get("isSidechain")):
                    msg = rec.get("message") if isinstance(rec.get("message"), dict) else {}
                    content = msg.get("content")
                    if not _is_tool_result(content):
                        txt = _LEADING_TAGS.sub("", _text_of(content)).strip()
                        if txt:
                            return txt
    except OSError:
        return None
    return None


def recover_cwd(path: str) -> str | None:
    """The session's true working dir, read from the first record carrying `cwd`
    (avoids decoding Claude's lossy projects-dir name)."""
    try:
        with open(path, encoding="utf-8", errors="replace") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    rec = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(rec, dict) and rec.get("cwd"):
                    return rec["cwd"]
    except OSError:
        return None
    return None


def parse_jsonl(path: str, cursor: int = 0) -> dict:
    """Parse a native transcript into {turns, events, next_cursor}. `seq` is a
    stable, monotonic per-session counter; events with seq < cursor are dropped so
    the same incremental-polling contract as store.transcript() holds."""
    turns: list[dict] = []
    events: list[dict] = []
    state = {"seq": 0, "turn": None}

    def emit(ev: dict):
        cur = state["turn"]
        if cur is None:
            return
        full = {**ev, "seq": state["seq"], "turn_id": cur["id"]}
        state["seq"] += 1
        if full["seq"] >= cursor:
            events.append(full)

    def open_turn(rec, prompt: str):
        tid = rec.get("uuid") or f"turn{len(turns)}"
        cur = {"id": tid, "seq": len(turns), "prompt": prompt, "attachments": [],
               "status": "done", "cost": None, "elapsed": None,
               "started": _ts(rec), "model": None}
        turns.append(cur)
        state["turn"] = cur

    try:
        fh = open(path, encoding="utf-8", errors="replace")
    except OSError:
        return {"turns": [], "events": [], "next_cursor": cursor}
    with fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                rec = json.loads(line)
            except json.JSONDecodeError:
                continue
            if not isinstance(rec, dict) or rec.get("isSidechain"):
                continue
            t = rec.get("type")
            msg = rec.get("message") if isinstance(rec.get("message"), dict) else {}
            content = msg.get("content")
            if t == "user":
                if _is_tool_result(content):
                    emit({"type": "tool_done"})
                else:
                    open_turn(rec, _text_of(content))
            elif t == "assistant":
                if state["turn"] is None:
                    open_turn(rec, "")
                if state["turn"].get("model") is None and msg.get("model"):
                    state["turn"]["model"] = msg.get("model")
                for b in (content or []):
                    if not isinstance(b, dict):
                        continue
                    bt = b.get("type")
                    if bt == "text":
                        txt = (b.get("text") or "").strip()
                        if txt:
                            emit({"type": "text", "text": txt})
                    elif bt == "tool_use":
                        name = b.get("name", "tool")
                        emit({"type": "tool", "name": name,
                              "summary": _summarize_tool(name, b.get("input", {}))})
            # other record types (queue-operation, mode, file-history-snapshot,
            # last-prompt, attachment, ...) carry no transcript content -> skipped
    next_cursor = state["seq"] if state["seq"] > cursor else cursor
    return {"turns": turns, "events": events, "next_cursor": next_cursor}
