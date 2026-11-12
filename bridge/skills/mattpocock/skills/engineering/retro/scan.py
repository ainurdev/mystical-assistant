"""Retro scan of one Claude Code transcript: every tool call in order, with its size and wait.

usage: python3 scan.py <transcript.jsonl> [stats|list|errors|text|show N…|top N|slow N|grep RE [all]]

A session's transcript is ~/.claude/projects/<its cwd, "/" and "." as "-">/<session-id>.jsonl.
Times print in UTC, as the transcript stores them."""
import json, sys, collections, datetime

path = sys.argv[1]
cmd = sys.argv[2] if len(sys.argv) > 2 else "stats"
# Only lines with a timestamp: `api-request-blob` lines repeat every tool call (595 calls counted for 334).
# A helper's calls are not in here: scan <session-id>/subagents/agent-*.jsonl the same way.
rows = [r for r in map(json.loads, open(path)) if r.get("timestamp")]

def ts(r):
    t = r.get("timestamp")
    return datetime.datetime.fromisoformat(t.replace("Z", "+00:00")) if t else None

calls = {}   # tool_use id -> dict
order = []
for i, r in enumerate(rows):
    msg = r.get("message") or {}
    content = msg.get("content")
    if not isinstance(content, list):
        continue
    for b in content:
        if not isinstance(b, dict):
            continue
        if b.get("type") == "tool_use":
            c = {"i": i, "id": b["id"], "name": b["name"], "input": b.get("input") or {}, "t0": ts(r), "side": r.get("isSidechain")}
            calls[b["id"]] = c
            order.append(c)
        elif b.get("type") == "tool_result":
            c = calls.get(b.get("tool_use_id"))
            if not c:
                continue
            body = b.get("content")
            text = body if isinstance(body, str) else "".join(x.get("text", "") for x in body or [] if isinstance(x, dict))
            c.update(out=text, err=bool(b.get("is_error")) and not text.startswith("The user answered"), t1=ts(r))  # an answered card comes back flagged as an error

def brief(c):
    inp = c["input"]
    for k in ("command", "file_path", "skill", "query", "description", "prompt", "pattern"):
        if k in inp:
            return f"{k}={str(inp[k])[:150]!r}"
    return json.dumps(inp)[:150]

def wait(c):
    return (c["t1"] - c["t0"]).total_seconds() if c.get("t1") and c.get("t0") else 0

if cmd == "list":
    for n, c in enumerate(order):
        print(f"{n:3} {c['t0'].strftime('%H:%M:%S') if c['t0'] else '?':8} {wait(c):6.0f}s in={len(json.dumps(c['input'])):6} out={len(c.get('out', '')):7} {'ERR ' if c.get('err') else ''}{c['name']}: {brief(c)}")
elif cmd == "stats":
    by = collections.defaultdict(lambda: [0, 0, 0, 0.0])
    for c in order:
        b = by[c["name"]]
        b[0] += 1; b[1] += len(json.dumps(c["input"])); b[2] += len(c.get("out", "")); b[3] += wait(c)
    print(f"{len(rows)} lines, {len(order)} tool calls, {sum(1 for c in order if c.get('err'))} errors")
    for k, v in sorted(by.items(), key=lambda kv: -kv[1][2]):
        print(f"{k:42} n={v[0]:3} in={v[1]:7} out={v[2]:8} wait={v[3]:6.0f}s")
    t = [ts(r) for r in rows if ts(r)]
    print("span", t[0], "->", t[-1])
elif cmd == "errors":
    for n, c in enumerate(order):
        if c.get("err"):
            print(f"--- {n} {c['name']}: {brief(c)}\n{c.get('out', '')[:600]}\n")
elif cmd == "show":
    for n in sys.argv[3:]:
        c = order[int(n)]
        print(f"=== {n} {c['name']} wait={wait(c):.0f}s\nINPUT: {json.dumps(c['input'], indent=1)[:6000]}\nOUT ({len(c.get('out', ''))}): {c.get('out', '')[:6000]}\n")
elif cmd == "text":
    # every user/assistant text block, in order, cut short: the story between the tool calls
    for i, r in enumerate(rows):
        msg = r.get("message") or {}
        content = msg.get("content")
        role = msg.get("role")
        if isinstance(content, str):
            print(f"[{i}] {role}: {content[:700]}\n")
        elif isinstance(content, list):
            for b in content:
                if isinstance(b, dict) and b.get("type") == "text" and b.get("text", "").strip():
                    print(f"[{i}] {role}: {b['text'][:700]}\n")
elif cmd in ("top", "slow"):
    # the N largest outputs (top) or longest waits (slow)
    key = (lambda c: len(c.get("out", ""))) if cmd == "top" else wait
    for c in sorted(order, key=key, reverse=True)[:int(sys.argv[3]) if len(sys.argv) > 3 else 20]:
        print(f"{order.index(c):3} {wait(c):6.0f}s out={len(c.get('out', '')):7} {c['name']}: {brief(c)}")
elif cmd == "grep":
    # calls whose input (default) or input+output ("grep RE all") matches, first hit shown
    import re
    rx = re.compile(sys.argv[3])
    for n, c in enumerate(order):
        hay = json.dumps(c["input"]) + ("\n" + c.get("out", "") if sys.argv[4:] == ["all"] else "")
        m = rx.search(hay)
        if m:
            print(f"{n:3} {c['t0'].strftime('%H:%M:%S') if c['t0'] else '?':8} {c['name']}: …{hay[max(0, m.start() - 60):m.end() + 100]!r}")
