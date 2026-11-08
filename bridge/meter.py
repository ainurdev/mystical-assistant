"""The SESSION tab's numbers: how full the window was at every request, who was
working when, and what the tokens went on, read from the CLI's own transcript.

Why the transcript and not the bridge's events: only the CLI's JSONL has every
request's usage. The stream the runner reads gives a message's usage as it
started (output near zero), and the store keeps one total per turn. The JSONL
also holds the helpers' own transcripts (`<id>/subagents/agent-*.jsonl`), so
their spend shows beside the session's instead of vanishing.

The window per request is exact: input + cache read + cache write. A message is
written as one record per content block, each repeating its usage, so a message
counts once, by id.

What fills the window is worked out by difference. Request i's window minus
request i-1's is what was added between them: i-1's output (what Claude wrote:
text, thinking, tool inputs; exact, from its output tokens) plus the user-side
items that arrived in between (tool results, prompts, pictures, attachments).
When several arrived together they share the growth by text length, a picture
counting as 1.6k tokens; that split is the only estimate here. The first request,
and the first after a compaction, is start-up (system prompt, tools, CLAUDE.md,
memory, skills list) plus the summary. A window that shrank without a compaction
(the CLI clearing old thinking) scales every kind down. Spend by kind charges
each request for the window it read, by kind, plus its output, so the kinds add
up to the total; the helpers' own spend joins as its own kind.

Time comes from the main thread's open tool calls (tool_use record to its
tool_result): waiting on you (AskUserQuestion), helpers (Agent/Task), tools (the
rest), in that order where they overlap; what's left of a turn is Claude itself,
and the gaps between turns are away. shortcut: a permission prompt's wait counts as
tool time, because the JSONL can't see it; read the bridge's permission events if
sessions outside bypass mode start to matter here.

Read-side and best-effort like attribution: a failure yields None and the tab
shows what it has. The files are append-only, so each is read from where the last
read stopped; a file that shrank is read again from the start.
"""

import glob
import json
import logging
import os
import re
import threading
import time
from collections import Counter

from bridge import agents, transcript_jsonl

log = logging.getLogger("bridge.meter")

ASK = "AskUserQuestion"
HELP = ("Agent", "Task")
PICTURE = 1600 * 4             # a picture's share, in characters (~1.6k tokens)
TOP = 3                        # biggest items listed per kind
_KIND = {"Read": "files", "NotebookRead": "files", "Bash": "commands", "BashOutput": "commands",
         "Monitor": "commands", "KillShell": "commands", "Grep": "search", "Glob": "search",
         "ToolSearch": "search", "LSP": "search", "WebFetch": "web", "WebSearch": "web",
         "Skill": "skills", "Agent": "helpers", "Task": "helpers"}
_STARTUP = {"instructions", "skill_listing", "deferred_tools_record", "deferred_tools_delta",
            "agent_listing_delta", "hook_additional_context", "session_context",
            "environment", "model", "date", "nested_memory", "plan_mode"}
_FILES = {"file", "edited_text_file", "compact_file_reference", "directory", "selected_lines_in_ide"}
_USAGE = ("input_tokens", "cache_read_input_tokens", "cache_creation_input_tokens")

_lock = threading.RLock()   # held through a whole read: two tabs on one session share its file's read
_files: dict = {}              # main transcript path -> the read so far (see _read)
_helper_files: dict = {}       # a helper's: only its usage, so many fit
_CAP = {False: 16, True: 2048}


def _window(u: dict) -> int:
    return sum(u.get(k) or 0 for k in _USAGE)


def _spend(u: dict) -> int:
    return _window(u) + (u.get("output_tokens") or 0)


def _label(name: str, inp: dict) -> str:
    """What a tool call was about, in a line: its file, command, pattern or question."""
    shown = " · ".join(name.split("__")[1:]) if name.startswith("mcp__") else name
    if not isinstance(inp, dict):
        return shown
    if name == ASK:
        q = (inp.get("questions") or [{}])[0] if isinstance(inp.get("questions"), list) else {}
        return f"your answer: {q.get('header') or q.get('question') or ''}".strip(": ")
    for key in ("file_path", "notebook_path", "command", "pattern", "url", "query", "skill", "description"):
        v = inp.get(key)
        if isinstance(v, str) and v.strip():
            v = _home(v.strip().split("\n")[0][:160])
            return f"{shown} {v}" if key in ("pattern", "url", "query") or shown != name else v
    return shown


_HOME = os.path.expanduser("~")


def _home(text: str) -> str:
    return text.replace(_HOME + "/", "~/")


def _said(text: str) -> str:
    """A prompt in a line: a slash command with its arguments, a notice the CLI
    wrapped in tags by its tag's name, else its first words."""
    cmd = re.search(r"<command-name>([^<]*)</command-name>", text)
    if cmd:
        args = re.search(r"<command-args>([^<]*)</command-args>", text)
        return " ".join(f"{cmd.group(1).strip()} {args.group(1) if args else ''}".split())[:80]
    lead = re.match(r"\s*<([a-z][a-z-]*)", text)
    if lead:
        return lead.group(1).replace("-", " ")
    return " ".join(text.split())[:80] or "your prompt"


def _size(content) -> tuple:
    """(characters, pictures) of a tool result or a message's content."""
    if isinstance(content, str):
        return len(content), 0
    if isinstance(content, list):
        pics = sum(1 for b in content if isinstance(b, dict) and b.get("type") == "image")
        rest = [b for b in content if not (isinstance(b, dict) and b.get("type") == "image")]
        return len(json.dumps(rest)), pics
    return len(json.dumps(content)) if content is not None else 0, 0


def _blank() -> dict:
    return {"size": 0, "off": 0, "msgs": {}, "order": [], "tools": {}, "spans": [],
            "items": [], "cuts": [], "first": 0.0, "last": 0.0}


def _take(st: dict, rec: dict, helper: bool) -> None:
    """Fold one record into a file's read. A helper's file needs only its usage."""
    t = transcript_jsonl._ts(rec)
    if t:
        st["first"] = st["first"] or t
        st["last"] = max(st["last"], t)
    kind = rec.get("type")
    if rec.get("isSidechain") and not helper:
        return
    msg = rec.get("message") if isinstance(rec.get("message"), dict) else {}
    if kind == "assistant":
        mid = msg.get("id") or f"#{len(st['order'])}"
        m = st["msgs"].get(mid)
        if m is None:
            m = st["msgs"][mid] = {"ts": t, "usage": {}, "what": ""}
            st["order"].append(mid)
        if isinstance(msg.get("usage"), dict):
            m["usage"] = msg["usage"]
        if helper:
            return
        for b in msg.get("content") or []:
            if not isinstance(b, dict):
                continue
            if b.get("type") == "tool_use":
                name = b.get("name") or "?"
                st["tools"][b.get("id")] = (name, _label(name, b.get("input")), t)
                if not m["what"] or name in ("Write", "Edit", "MultiEdit", "NotebookEdit"):
                    m["what"] = f"{name} {_label(name, b.get('input'))}"[:120]
            elif b.get("type") == "text" and not m["what"]:
                m["what"] = "reply"
            elif b.get("type") == "thinking" and not m["what"]:
                m["what"] = "thinking"
        return
    if helper:
        return
    if kind == "user":
        content = msg.get("content")
        if rec.get("isCompactSummary"):
            st["items"].append((t, "summary", _size(content)[0], "summary of the turns before"))
            return
        if isinstance(content, str):
            if rec.get("isMeta"):
                if content.startswith("Base directory for this skill"):
                    st["items"].append((t, "skills", len(content), _skill_name(content)))
                return
            st["items"].append((t, "you", len(content), _said(content)))
            return
        for b in content or []:
            if not isinstance(b, dict):
                continue
            bt = b.get("type")
            if bt == "tool_result":
                name, label, t0 = st["tools"].pop(b.get("tool_use_id"), ("?", "?", t))
                st["spans"].append((name, t0, t))
                chars, pics = _size(b.get("content"))
                k = "mcp" if name.startswith("mcp__") else _KIND.get(name, "other")
                if name == ASK:
                    k = "you"
                st["items"].append((t, k, chars + pics * PICTURE, label))
            elif bt == "image":
                st["items"].append((t, "you", PICTURE, "picture"))
            elif bt == "text":
                text = b.get("text") or ""
                if rec.get("isMeta"):
                    if text.startswith("Base directory for this skill"):
                        st["items"].append((t, "skills", len(text), _skill_name(text)))
                else:
                    st["items"].append((t, "you", len(text), _said(text)))
        return
    if kind == "attachment":
        a = rec.get("attachment") if isinstance(rec.get("attachment"), dict) else {}
        k = a.get("type")
        if k in _STARTUP:
            st["items"].append((t, "startup", len(json.dumps(a)), k.replace("_", " ")))
        elif k in _FILES:
            name = _home(str(a.get("filename") or a.get("path") or k))
            st["items"].append((t, "files", len(json.dumps(a)), name))
        return
    if kind == "system" and rec.get("subtype") == "compact_boundary":
        pre = (rec.get("compactMetadata") or {}).get("preTokens")
        st["cuts"].append((t, pre if isinstance(pre, int) else None))


def _skill_name(text: str) -> str:
    first = text.split("\n")[0].rstrip("/")
    return "skill " + os.path.basename(first) if "/" in first else "a skill"


def _read(path: str, helper: bool = False) -> dict:
    """The file read up to its current end, carrying on from the last read."""
    try:
        size = os.path.getsize(path)
    except OSError:
        return _blank()
    cache = _helper_files if helper else _files
    with _lock:
        st = cache.get(path)
        if st is None or size < st["size"]:
            st = _blank()
        if size == st["size"]:
            cache[path] = st
            return st
        try:
            with open(path, "rb") as fh:
                fh.seek(st["off"])
                data = fh.read(size - st["off"])
        except OSError:
            return st
        end = data.rfind(b"\n") + 1          # a half-written last line waits for the next read
        for line in data[:end].splitlines():
            try:
                rec = json.loads(line)
            except ValueError:
                continue
            if isinstance(rec, dict):
                _take(st, rec, helper)
        st["off"] += end
        st["size"] = st["off"]
        if path not in cache and len(cache) >= _CAP[helper]:
            cache.pop(next(iter(cache)))
        cache[path] = st
        return st


def _segments(turns: list, spans: list) -> list:
    """[start, end, who] across the session: inside a turn the first of you,
    helpers, tools that has a call open, else claude; between turns, away.
    One sweep over the calls' edges, so a turn of a thousand calls stays cheap."""
    who = lambda n: "you" if n == ASK else "helpers" if n in HELP else "tools"
    segs: list = []

    def put(a, b, c):
        if b - a <= 0:
            return
        if segs and segs[-1][2] == c and abs(segs[-1][1] - a) < 1e-6:
            segs[-1][1] = b
        else:
            segs.append([a, b, c])

    for a, b in turns:
        if segs and a > segs[-1][1]:
            put(segs[-1][1], a, "away")
        edges = sorted([(max(s, a), 1, who(n)) for n, s, e in spans if e > a and s < b]
                       + [(min(e, b), -1, who(n)) for n, s, e in spans if e > a and s < b])
        count = Counter()
        at = a
        for x, step, c in edges:
            if x > at:
                put(at, x, next((k for k in ("you", "helpers", "tools") if count[k] > 0), "claude"))
                at = x
            count[c] += step
        put(at, b, next((k for k in ("you", "helpers", "tools") if count[k] > 0), "claude"))
    return [[round(a, 1), round(b, 1), c] for a, b, c in segs if b - a >= 0.5]


def _turn_spans(turns: list, st: dict, now: float) -> list:
    """(start, end) of each turn: its recorded length, its last record, or now
    while it runs. A transcript the bridge never ran is one turn."""
    if not turns:
        return [(st["first"], st["last"])] if st["first"] else []
    out = []
    for i, t in enumerate(turns):
        a = float(t.get("started") or 0)
        nxt = float(turns[i + 1]["started"]) if i + 1 < len(turns) else None
        if t.get("status") == "running" and nxt is None:
            b = now
        elif t.get("elapsed"):
            b = a + float(t["elapsed"])
        else:
            inside = [m["ts"] for m in st["msgs"].values() if a <= m["ts"] < (nxt or now)]
            b = max(inside + [a])
        out.append((a, max(a, min(b, nxt) if nxt else b)))
    return out


def _helpers(session: dict, main_path: str, st: dict, turns: list, now: float) -> list:
    """Every helper with its own spend. Running as the AGENTS modal reads it
    (bridge/agents.py): a foreground one until its Agent call has a result, a
    background one until the CLI marks it finished, and none once the session's
    process is gone."""
    base = os.path.join(os.path.dirname(main_path), os.path.basename(main_path)[:-len(".jsonl")], "subagents")
    alive = agents._session_alive(session)
    out = []
    for path in sorted(glob.glob(os.path.join(base, "agent-*.jsonl"))):
        h = _read(path, helper=True)
        if not h["order"]:
            continue
        try:
            with open(path[:-len(".jsonl")] + ".meta.json", encoding="utf-8") as f:
                meta = json.load(f)
        except (OSError, ValueError):
            meta = {}
        tid = meta.get("toolUseId")
        running = alive and (not meta.get("finished") if meta.get("requestShape") == "background"
                             else tid in st["tools"])
        start = h["first"] or 0.0
        out.append({"id": os.path.basename(path)[:-len(".jsonl")],
                    "what": meta.get("description") or meta.get("agentType") or "helper",
                    "start": round(start, 1), "end": round(now if running else h["last"], 1),
                    "running": bool(running), "tokens": sum(_spend(h["msgs"][m]["usage"]) for m in h["order"]),
                    "requests": len(h["order"]),
                    "turn": next((t.get("id") for t in reversed(turns) if float(t.get("started") or 0) <= start), None)})
    out.sort(key=lambda h: (not h["running"], -h["tokens"]))
    return out


def _merge(items: list, n: int, spent: bool = False) -> dict:
    """Items by (kind, label): a file read twice, or a start-up re-sent after a
    compaction, is one line. Window: its tokens now. Spent: its size times the
    requests that read it, until a compaction let it go (or now)."""
    out: dict = {}
    for k, label, tok, at, tid, *left in items:
        reads = (left[0] if left else n) - at
        if spent:
            size, cost, r, t0 = out.get((k, label), (0, 0, 0, tid))
            out[(k, label)] = (max(size, tok), cost + tok * reads, r + reads, t0)
        else:
            have, _, t0 = out.get((k, label), (0, 0, tid))
            out[(k, label)] = (have + tok, 0, t0)
    return out


def read(session: dict, turns: list, now: "float | None" = None) -> "dict | None":
    """The meter for a store session and its turns (store.turn_metrics), or None."""
    try:
        with _lock:
            return _read_meter(session, turns, time.time() if now is None else now)
    except Exception:  # noqa: BLE001
        log.debug("meter read failed", exc_info=True)
        return None


def _read_meter(session: dict, turns: list, now: float) -> "dict | None":
    path = transcript_jsonl.find_transcript(session.get("claude_session_id") or "")
    if not path:
        return None
    st = _read(path)
    reqs = [(st["msgs"][m]["ts"], m, st["msgs"][m]) for m in st["order"] if st["msgs"][m]["usage"]]
    if not reqs:
        return None
    items, cuts = st["items"], [c[0] for c in st["cuts"]]
    starts = [float(t.get("started") or 0) for t in turns]

    def turn_at(ts):
        k = None
        for i, s in enumerate(starts):
            if s - 1 <= ts:
                k = i
        return turns[k].get("id") if k is not None else None

    win: Counter = Counter()
    spent: Counter = Counter()
    per_turn: dict = {}
    live: list = []            # items in the window now: [kind, label, tokens, arrived at request i, turn]
    gone: list = []            # items a compaction let go: the same, plus the request it left at
    j = 0                      # next item not yet in the window
    prev = None
    for i, (ts, mid, m) in enumerate(reqs):
        u, ctx = m["usage"], _window(m["usage"])
        between = []
        while j < len(items) and items[j][0] <= ts:
            between.append(items[j])
            j += 1
        if prev is None or any(prev[0] < c <= ts for c in cuts):
            gone += [x + [i] for x in live]
            live = []
            summ = min(ctx, sum(s for _, k, s, _ in between if k == "summary") // 4)
            mine = min(ctx - summ, sum(s for _, k, s, _ in between if k == "you") // 4)
            win = Counter({"startup": ctx - summ - mine, "summary": summ, "you": mine})
            live.append(["startup", "system prompt, tools, CLAUDE.md, memory", ctx - summ - mine, i, turn_at(ts)])
            if summ:
                live.append(["summary", "summary of the turns before", summ, i, turn_at(ts)])
            if mine:
                live.append(["you", next((l for _, k, _, l in between if k == "you"), "your prompt"), mine, i, turn_at(ts)])
        else:
            pu = prev[2]["usage"]
            grew, wrote = ctx - _window(pu), pu.get("output_tokens") or 0
            if grew > 0:
                win["claude"] += min(grew, wrote)
                live.append(["claude", prev[2]["what"] or "reply", min(grew, wrote), i, turn_at(prev[0])])
            rest = grew - wrote
            if rest > 0:
                total = sum(s for _, _, s, _ in between)
                for t_, k, s, label in between:
                    share = rest * s / total if total else 0
                    win[k] += share
                    live.append([k, label, share, i, turn_at(t_)])
                if not total:
                    win["other"] += rest
            have = sum(win.values())
            if have > ctx > 0:               # the CLI dropped something (old thinking): scale down
                f = ctx / have
                for k in win:
                    win[k] *= f
                for x in live:
                    x[2] *= f
        for k, v in win.items():
            spent[k] += v
        spent["claude"] += u.get("output_tokens") or 0
        tid = turn_at(ts)
        pt = per_turn.setdefault(tid, {"spent": 0, "requests": 0, "from": ctx, "to": ctx, "peak": ctx})
        pt["spent"] += _spend(u)
        pt["requests"] += 1
        pt["to"] = ctx
        pt["peak"] = max(pt["peak"], ctx)
        prev = (ts, mid, m)

    n = len(reqs)
    biggest_win: dict = {}
    for (k, label), (tok, _, tid) in sorted(_merge(live, n).items(), key=lambda kv: -kv[1][0]):
        lst = biggest_win.setdefault(k, [])
        if len(lst) < TOP and tok >= 1:
            lst.append({"label": label, "tokens": round(tok), "turn": tid})
    biggest_spent: dict = {}
    for (k, label), (size, cost, reads, tid) in sorted(_merge(live + gone, n, spent=True).items(), key=lambda kv: -kv[1][1]):
        lst = biggest_spent.setdefault(k, [])
        if len(lst) < TOP and cost >= 1:
            lst.append({"label": label, "tokens": round(cost), "size": round(size), "reads": reads, "turn": tid})

    tspans = _turn_spans(turns, st, now)
    # A call with no result yet is open until now, unless a later turn began: then
    # it never got one (a cut or resumed turn), and it ends with its own turn.
    ends = [b for _, b in tspans]
    spans = st["spans"] + [(name, t0, next((e for e in ends if e > t0), now)) for name, _, t0 in st["tools"].values()]
    segs = _segments(tspans, spans)
    tsum = Counter()
    for a, b, c in segs:
        tsum[c] += b - a
    helpers = _helpers(session, path, st, turns, now)
    spent["helpers"] += sum(h["tokens"] for h in helpers)
    fresh = sum((m["usage"].get("input_tokens") or 0) + (m["usage"].get("cache_creation_input_tokens") or 0)
                + (m["usage"].get("output_tokens") or 0) for _, _, m in reqs)
    reread = sum(m["usage"].get("cache_read_input_tokens") or 0 for _, _, m in reqs)
    return {
        "series": [[round(ts, 1), _window(m["usage"])] for ts, _, m in reqs],
        "segs": segs,
        "time": {k: round(tsum.get(k, 0)) for k in ("claude", "tools", "helpers", "you", "away")},
        "window": {"total": _window(reqs[-1][2]["usage"]), "kinds": {k: round(v) for k, v in win.items() if v >= 1}},
        "spent": {"total": round(sum(spent.values())), "fresh": fresh, "reread": reread,
                  "kinds": {k: round(v) for k, v in spent.items() if v >= 1}},
        "biggest": {"window": biggest_win, "spent": biggest_spent},
        "helpers": helpers,
        "turns": {k: v for k, v in per_turn.items() if k},
        "compactions": [[round(t, 1), pre] for t, pre in st["cuts"]],
    }
