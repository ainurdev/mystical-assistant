"""Translate Claude Code's native session JSONL into the bridge's transcript
shape ({turns, events, next_cursor}) so the dashboard / Mini App renderers can
show a session that was started in VSCode/terminal with full fidelity.

Native transcripts live at ~/.claude/projects/<enc-cwd>/<uuid>.jsonl. Because the
filename is the globally-unique session UUID, a transcript is located by globbing
on the UUID — we never reverse Claude's lossy directory encoding.

The emitted event vocabulary matches the runner's (text / thinking / tool /
tool_done), so both frontends render it unchanged. A `thinking` block carries the
reasoning text as it was recorded (Claude Code keeps it on disk, it just never
prints it) plus the length of the pause; a block whose text was stripped, leaving
only a signature, falls back to the bare marker it always was — how long it
thought. Subagent `isSidechain` records are dropped — the bridge never surfaces
those (the runner doesn't either). Stdlib only; no bridge.config dependency.
"""

import glob
import json
import os
import re
import threading
from datetime import datetime

PROJECTS_DIR = os.path.expanduser("~/.claude/projects")

# Parse memoization. Both HTTP servers poll a native transcript every ~1.5s while
# it's open; without this, every poll re-reads and re-parses the whole JSONL. We
# cache the full parse keyed on (mtime, size) so an unchanged file costs a stat +
# a slice, and only a grown transcript triggers a real re-parse.
_parse_cache: "dict[str, tuple]" = {}   # path -> ((mtime, size), full_result)
_parse_lock = threading.Lock()
_PARSE_CACHE_MAX = 64
# session-uuid -> resolved path; the uuid filename is stable, so a cached hit that
# still exists on disk saves the per-request directory glob.
_path_cache: "dict[str, str]" = {}
_path_lock = threading.Lock()

# Leading system/IDE injections Claude Code prepends to a user turn (e.g.
# <ide_opened_file>…</ide_opened_file>, <command-name>…</command-name>); stripped
# so auto-titles read as the human's actual prompt.
_LEADING_TAGS = re.compile(r"^(?:\s*<[^>]+>.*?</[^>]+>\s*|\s*<[^>]+/>\s*)+", re.DOTALL)

# Mirrors bridge.runner._summarize_tool (kept inline to keep this module free of
# the runner's heavy imports / env requirements).
_SUMMARY_KEYS = ("command", "file_path", "path", "pattern", "url", "query", "prompt",
                 "plan")

# Max chars of Bash output kept per tool call (see bash_output).
_OUT_MAX = 2000
# Shortest pause that earns a bare "thought for …" marker — one with no reasoning
# text behind it, which is the only kind this gates. Extended thinking fires on
# nearly every step, so a low floor would put a marker between every two tool
# cards — the wall of rows the chip folding exists to prevent. Four seconds is
# about where a pause stops being latency and starts being deliberation.
THINK_MIN_MS = 4000
# Max diff lines kept per edit (see patch_lines).
_PATCH_MAX = 120
# Tools whose result carries a structuredPatch we can render as a diff.
PATCH_TOOLS = ("Edit", "Write", "MultiEdit", "NotebookEdit")
# Tools whose result is a fixed confirmation ("Todos have been modified
# successfully…") — measuring it would dress up boilerplate as information.
_NO_STAT = ("TodoWrite", "ExitPlanMode", "EnterPlanMode", "Skill", "AskUserQuestion")

# Estimated Claude list prices, $ per million tokens, so an adopted native session
# reports a cost instead of $0 (native JSONL records token usage, not a dollar
# amount). Approximate — override this dict if prices change. cw = cache write,
# cr = cache read.
MODEL_PRICING = {
    "opus":   {"in": 15.0, "out": 75.0, "cw": 18.75, "cr": 1.50},
    "sonnet": {"in": 3.0,  "out": 15.0, "cw": 3.75,  "cr": 0.30},
    "haiku":  {"in": 0.80, "out": 4.0,  "cw": 1.00,  "cr": 0.08},
}
_DEFAULT_PRICE = MODEL_PRICING["sonnet"]


def _short_model(m: str | None) -> str | None:
    """Normalize a full model id (claude-opus-4-…) to its short family ("opus"),
    so native turns label the same way bridge turns do."""
    s = (m or "").lower()
    for fam in ("opus", "sonnet", "haiku"):
        if fam in s:
            return fam
    return m or None


def _cost_from_usage(model: str | None, u: dict) -> float:
    fam = (model or "").lower()
    price = next((p for k, p in MODEL_PRICING.items() if k in fam), _DEFAULT_PRICE)
    return (u["in"] * price["in"] + u["out"] * price["out"]
            + u["cw"] * price["cw"] + u["cr"] * price["cr"]) / 1_000_000


def find_transcript(claude_session_id: str) -> str | None:
    """Locate the JSONL for a native session UUID, regardless of which project
    directory it lives in (the filename is globally unique). The uuid→path map is
    cached and re-globbed only if the cached path has vanished."""
    if not claude_session_id:
        return None
    with _path_lock:
        cached = _path_cache.get(claude_session_id)
    # Tie the cached path to the current PROJECTS_DIR: in production it never
    # changes, but tests reassign it, and a uuid must resolve under the active root.
    if (cached and cached.startswith(PROJECTS_DIR + os.sep)
            and os.path.exists(cached)):
        return cached
    matches = glob.glob(os.path.join(PROJECTS_DIR, "*", claude_session_id + ".jsonl"))
    path = matches[0] if matches else None
    if path:
        with _path_lock:
            _path_cache[claude_session_id] = path
    return path


def _summarize_tool(name: str, inp) -> str:
    if not isinstance(inp, dict):
        return ""
    if name == "Bash":
        return str(inp.get("command") or "")[:120]
    if name == "TodoWrite":
        return _todo_summary(inp.get("todos"))
    if name == "Skill":
        return " ".join(str(inp.get(k) or "") for k in ("skill", "args")).strip()[:120]
    for key in _SUMMARY_KEYS:
        if inp.get(key):
            return str(inp[key])[:120]
    return _arg_summary(inp)


def _arg_summary(inp: dict) -> str:
    """What the call was about, for every tool whose arguments we don't know by
    name — MCP tools, the task tools, whatever Claude Code adds next. Those cards
    used to render as a bare tag ("SKILL", "TASKUPDATE") saying only that
    *something* ran. Booleans are skipped: a flag modifies a call, it isn't the
    subject of one."""
    parts = []
    for k, v in inp.items():
        s = _arg_value(v)
        if s:
            parts.append(f"{k}={s[:40]}")
        if len(parts) == 3:
            break
    return " · ".join(parts)


def _arg_value(v) -> str:
    if isinstance(v, bool) or v is None:
        return ""
    if isinstance(v, (int, float)):
        return str(v)
    if isinstance(v, str):
        return " ".join(v.split())
    if isinstance(v, list):
        return ", ".join(x for x in (_arg_value(i) for i in v[:3]) if x)
    return ""     # a nested object is structure, not a subject


def _todo_summary(todos) -> str:
    """The checklist itself is the plainest statement of what the model is doing,
    and none of _SUMMARY_KEYS appear in a TodoWrite — so the card used to read
    "checklist updated" and nothing else. Show the item it just started
    (`activeForm` is written for exactly this) and how far down the list it is."""
    items = [t for t in todos if isinstance(t, dict)] if isinstance(todos, list) else []
    if not items:
        return ""
    done = sum(1 for t in items if t.get("status") == "completed")
    cur = next((t for t in items if t.get("status") == "in_progress"), None)
    if cur is None:
        return f"{done}/{len(items)} done"
    label = str(cur.get("activeForm") or cur.get("content") or "")[:100]
    return f"{label} · {done}/{len(items)}" if label else f"{done}/{len(items)} done"


def _kilo(n) -> str:
    """1234 -> "1.2k"; anything smaller stays as it is."""
    try:
        n = int(n)
    except (TypeError, ValueError):
        return ""
    return f"{n / 1000:.1f}k" if n >= 1000 else str(n)


def result_stat(name: str, block: dict, result) -> str:
    """One line of what a tool handed back, for the tools whose output we don't
    store — the size of the answer, so a lookup that found nothing reads
    differently from one that found plenty, and a failure says why. Bash and
    edits show their real output, so they never get here.
    ponytail: counted off the result text, with the three results that carry real
    numbers special-cased (a read's line count, an agent's tool count, a fetch's
    size). A parser per tool would be a lot of code for the same one line."""
    r = result if isinstance(result, dict) else {}
    text = _text_of(block.get("content")).strip()
    if block.get("is_error"):
        # The first line of a tool error is the whole story ("File does not
        # exist", "No such file or directory") — the rest is a stack or a hint.
        return text.splitlines()[0][:90] if text else "failed"
    if name in _NO_STAT:
        return ""
    if name == "Read":
        f = r.get("file") if isinstance(r.get("file"), dict) else {}
        if r.get("type") == "image" or f.get("base64"):
            return "image"      # counting base64 chars would be a lie about size
        n = f.get("numLines") or f.get("totalLines")
        if n:
            return f"{n} lines"
    elif name in ("Task", "Agent"):
        bits = [f"{r['totalToolUseCount']} tools" if r.get("totalToolUseCount") else "",
                f"{_kilo(r.get('totalTokens'))} tokens" if r.get("totalTokens") else ""]
        joined = " · ".join(b for b in bits if b)
        if joined:
            return joined
    elif name == "WebFetch" and r.get("bytes"):
        return f"{_kilo(r['bytes'])} bytes"
    if not text:
        return ""
    lines = text.count("\n") + 1
    return f"{lines} lines" if lines > 1 else f"{len(text)} chars"


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


def bash_output(content) -> str:
    """A Bash tool_result's text, carried into the transcript so the UI can draw a
    real terminal instead of a bare "ran a command" chip.
    ponytail: head-capped and Bash-only — a Read result is the whole file, and
    storing every tool's output would multiply the store for no visible gain."""
    text = _text_of(content).strip()
    if len(text) <= _OUT_MAX:
        return text
    return text[:_OUT_MAX].rstrip() + "\n…"


def patch_lines(result) -> list:
    """Flatten the unified-diff hunks Claude Code already computed for an edit
    (`structuredPatch`) into plain diff lines, so the UI draws a diff without
    re-diffing the file. Empty when the result carries no patch."""
    hunks = result.get("structuredPatch") if isinstance(result, dict) else None
    if not isinstance(hunks, list):
        return []
    out: list = []
    for h in hunks:
        if not isinstance(h, dict):
            continue
        out.append(f"@@ -{h.get('oldStart', 0)},{h.get('oldLines', 0)}"
                   f" +{h.get('newStart', 0)},{h.get('newLines', 0)} @@")
        out.extend(str(x) for x in (h.get("lines") or []))
        if len(out) >= _PATCH_MAX:
            return out[:_PATCH_MAX] + ["…"]
    return out


def tool_done(rid, name, ms: int, block: dict, result) -> dict:
    """The tool_done event for one tool_result. Bash keeps its output, an edit
    keeps its diff, everything else stays a bare marker. Shared by the live
    runner and this translator so both surfaces render the same blocks —
    `result` is the record-level tool result (`tool_use_result` on the live
    stream, `toolUseResult` in the on-disk JSONL)."""
    ev = {"type": "tool_done", "id": rid}
    if ms > 0:
        ev["ms"] = ms
    if name == "Bash":
        ev["output"] = bash_output(block.get("content"))
        ev["is_error"] = bool(block.get("is_error"))
        return ev
    if block.get("is_error"):
        ev["is_error"] = True
    if name in PATCH_TOOLS:
        lines = patch_lines(result)
        if lines:
            ev["patch"] = lines
    if not ev.get("patch"):
        # No diff and no terminal to show: say how big the answer was instead of
        # leaving the card as a bare "it ran".
        stat = result_stat(name, block, result)
        if stat:
            ev["stat"] = stat
    return ev


def _answers_from_result(questions: list, content) -> list:
    """Best-effort: which prepared answers the user picked, by matching option
    labels against the AskUserQuestion tool_result text (native JSONL records no
    structured selection). Unmatched questions are left unhighlighted."""
    if isinstance(content, str):
        text = content
    elif isinstance(content, list):
        text = "\n".join(b.get("text", "") for b in content
                         if isinstance(b, dict) and b.get("type") == "text")
    else:
        text = ""
    out = []
    for q in questions:
        labels = [o.get("label") for o in q.get("options", []) if isinstance(o, dict)]
        chosen = [l for l in labels if l and l in text]
        if chosen:
            out.append({"header": q.get("header"), "labels": chosen})
    return out


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
    return recover_meta(path)[0]


def recover_meta(path: str) -> tuple[str | None, str]:
    """(cwd, origin) from the first record carrying a `cwd` — Claude Code stamps
    the surface's `entrypoint` on that same record: "claude-vscode" for the
    extension, "cli" for an interactive terminal, "sdk-cli" for the bridge's own
    runs. origin comes back in the store's vocabulary so it maps to a surface
    chip, defaulting to "vscode" when `entrypoint` is absent (older transcripts).

    ponytail: two-way split. A bridge run ("sdk-cli") lands on the terminal chip,
    but it only reaches here as a stray — a real bridge session dedups onto its
    existing store row, which keeps its own origin.
    """
    cwd, entrypoint = None, ""
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
                    cwd = rec["cwd"]
                    entrypoint = str(rec.get("entrypoint") or "").lower()
                    break
    except OSError:
        pass
    return cwd, ("terminal" if entrypoint and "vscode" not in entrypoint else "vscode")


def parse_jsonl(path: str, cursor: int = 0) -> dict:
    """Parse a native transcript into {turns, events, next_cursor}. `seq` is a
    stable, monotonic per-session counter; events with seq < cursor are dropped so
    the same incremental-polling contract as store.transcript() holds.

    Memoized on (mtime, size): a repeat poll of an unchanged file returns a slice
    of the cached parse instead of re-reading the whole JSONL."""
    try:
        st = os.stat(path)
    except OSError:
        return {"turns": [], "events": [], "next_cursor": cursor}
    key = (st.st_mtime, st.st_size)
    with _parse_lock:
        entry = _parse_cache.get(path)
        full = entry[1] if entry and entry[0] == key else None
    if full is None:
        full = _parse_full(path)
        with _parse_lock:
            _parse_cache[path] = (key, full)
            if len(_parse_cache) > _PARSE_CACHE_MAX:      # drop oldest entries
                for k in list(_parse_cache)[:len(_parse_cache) - _PARSE_CACHE_MAX]:
                    _parse_cache.pop(k, None)
    total = full["next_cursor"]
    if cursor <= 0:
        return {"turns": full["turns"], "events": full["events"], "next_cursor": total}
    events = [e for e in full["events"] if e["seq"] >= cursor]
    return {"turns": full["turns"], "events": events,
            "next_cursor": total if total > cursor else cursor}


def _parse_full(path: str) -> dict:
    """The actual JSONL→transcript parse, emitting every event (cursor filtering
    happens in parse_jsonl against the cached result)."""
    turns: list[dict] = []
    events: list[dict] = []
    state = {"seq": 0, "turn": None}
    aq: dict = {}   # AskUserQuestion request_id -> its questions, to pair with the answer
    open_tools: dict = {}  # tool_use id -> (name, start ts), for output + duration

    def emit(ev: dict):
        cur = state["turn"]
        if cur is None:
            return
        events.append({**ev, "seq": state["seq"], "turn_id": cur["id"]})
        state["seq"] += 1

    def open_turn(rec, prompt: str):
        tid = rec.get("uuid") or f"turn{len(turns)}"
        cur = {"id": tid, "seq": len(turns), "prompt": prompt, "attachments": [],
               "status": "done", "cost": None, "elapsed": None,
               "started": _ts(rec), "model": None,
               "_last_ts": _ts(rec), "_seen_usage": False,
               "_usage": {"in": 0, "out": 0, "cw": 0, "cr": 0}}
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
                    for b in content:
                        if not (isinstance(b, dict) and b.get("type") == "tool_result"):
                            continue
                        rid = b.get("tool_use_id")
                        if rid in aq:   # the answer to an AskUserQuestion
                            emit({"type": "question_answered", "request_id": rid,
                                  "answers": _answers_from_result(aq[rid], b.get("content"))})
                        else:
                            name, t0 = open_tools.pop(rid, (None, 0.0))
                            end = _ts(rec)
                            ms = int((end - t0) * 1000) if t0 and end else 0
                            emit(tool_done(rid, name, ms, b, rec.get("toolUseResult")))
                else:
                    open_turn(rec, _text_of(content))
            elif t == "assistant":
                if state["turn"] is None:
                    open_turn(rec, "")
                if state["turn"].get("model") is None and msg.get("model"):
                    state["turn"]["model"] = _short_model(msg.get("model"))
                usage = msg.get("usage")
                if isinstance(usage, dict):
                    acc = state["turn"]["_usage"]
                    acc["in"] += usage.get("input_tokens") or 0
                    acc["out"] += usage.get("output_tokens") or 0
                    acc["cw"] += usage.get("cache_creation_input_tokens") or 0
                    acc["cr"] += usage.get("cache_read_input_tokens") or 0
                    state["turn"]["_seen_usage"] = True
                for b in (content or []):
                    if not isinstance(b, dict):
                        continue
                    bt = b.get("type")
                    if bt == "text":
                        txt = (b.get("text") or "").strip()
                        if txt:
                            emit({"type": "text", "text": txt})
                    elif bt == "thinking":
                        # The reasoning text, plus the gap since the previous
                        # record — the pause a human sitting there actually saw.
                        prev = state["turn"].get("_last_ts") or state["turn"]["started"]
                        gap = int(max(0.0, _ts(rec) - prev) * 1000) if prev else 0
                        txt = (b.get("thinking") or "").strip()
                        if txt or gap >= THINK_MIN_MS:
                            ev = {"type": "thinking", "ms": gap}
                            if txt:
                                ev["text"] = txt
                            emit(ev)
                    elif bt == "tool_use":
                        name = b.get("name", "tool")
                        if name == "AskUserQuestion":
                            qs = (b.get("input") or {}).get("questions") or []
                            rid = b.get("id") or f"aq{state['seq']}"
                            aq[rid] = qs
                            emit({"type": "question", "request_id": rid, "questions": qs})
                        else:
                            open_tools[b.get("id")] = (name, _ts(rec))
                            emit({"type": "tool", "name": name, "id": b.get("id"),
                                  "summary": _summarize_tool(name, b.get("input", {}))})
            # other record types (queue-operation, mode, file-history-snapshot,
            # last-prompt, attachment, ...) carry no transcript content -> skipped
            if state["turn"] is not None:
                rts = _ts(rec)
                if rts:
                    state["turn"]["_last_ts"] = rts
    # Finalize per-turn metrics (cost from usage tokens, elapsed from timestamps)
    # and drop the scratch accumulators so the turn shape matches the store's.
    for cur in turns:
        usage = cur.pop("_usage", None)
        seen = cur.pop("_seen_usage", False)
        last_ts = cur.pop("_last_ts", None)
        if seen and usage:
            cur["cost"] = _cost_from_usage(cur.get("model"), usage)
            # Keep the counts themselves, not only the price guessed from them —
            # an adopted session accounts the same way a bridge-run one does.
            cur["tokens"] = {"in": usage["in"], "out": usage["out"],
                             "cache_w": usage["cw"], "cache_r": usage["cr"]}
        if last_ts and cur["started"]:
            cur["elapsed"] = max(0, int(last_ts - cur["started"]))
    return {"turns": turns, "events": events, "next_cursor": state["seq"]}
