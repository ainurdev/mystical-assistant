"""mystical-ux: what earlier sessions learned about UX, served to every session.

Spawned per run via --mcp-config beside goals and verify (runner._mcp_config),
so it is on in every project with nothing to toggle. The point is to need Mobbin
less over time: a UI question starts from our own answers, and Mobbin is opened
only for a real gap. Two stores, both plain files the user can read and grep in
~/.mystical/ux (MYSTICAL_UX_DIR overrides it, for tests):

- patterns/<slug>.md: one pattern each. A one-line verdict, a status (decided:
  the user picked; researched: evidence, no pick yet; open), rules, the
  real-app screens in our own words, guidelines, and cases (the user's picks,
  and whether they matched the recommendation). Written by RecordUx. Evidence
  and cases are only ever added to; a replaced verdict moves under History.
- mobbin.jsonl: every Mobbin search any session ran, appended by the bridge as
  the result streams past (capture(), called from runner._handle_event), so
  nothing depends on a model remembering to save it. It keeps the query, the
  apps and their mobbin_url, never the image URLs: those expire after 30 days
  and the pictures are not ours.

Search is word overlap, not embeddings: a few hundred entries don't need more.
Every session is told to ask here first by runner._UX_NOTE.

Stdlib only, line-delimited JSON-RPC 2.0 on stdin/stdout, like goal_mcp.py.
Nothing is logged to stdout; that channel is the protocol.
"""

import contextlib
import fcntl
import glob
import json
import os
import re
import sys
from datetime import date, datetime

PROTOCOL = "2024-11-05"
STATUSES = ("decided", "researched", "open")
_SLUG = re.compile(r"[a-z0-9][a-z0-9-]{0,79}")
_FIELDS = ("title", "status", "verdict", "tags", "projects", "updated")
_ORDER = ("Rules", "Seen in real apps", "Guidelines", "Cases", "History")
_STOP = set("a an and are as at be but by can do does for from how i in is it its of on or should "
            "that the this to was we what when where which with you".split())

_LIST = {"type": "array", "items": {"type": "string"}}
_TOOLS = [
    {
        "name": "SearchUx",
        "description": (
            "Before you settle a UI or UX question (a layout, a component, a link or button "
            "style, the words on a control), search what earlier sessions learned: patterns "
            "with a verdict, rules, real-app screens and the user's past picks, then every "
            "past Mobbin search. Open Mobbin only when nothing here answers the question."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "The question in a few plain words."},
                "tags": {**_LIST, "description": "Only patterns carrying all of these tags."},
            },
            "required": ["query"],
        },
    },
    {
        "name": "GetUx",
        "description": "One whole pattern: verdict, rules, screens, guidelines, cases, history.",
        "inputSchema": {
            "type": "object",
            "properties": {"slug": {"type": "string", "description": "As SearchUx lists it."}},
            "required": ["slug"],
        },
    },
    {
        "name": "RecordUx",
        "description": (
            "Save what a UX question taught us, so the next session needs Mobbin less. Call "
            "it after Mobbin or guideline research, and after the user picks a design option. "
            "Creates the pattern or adds to it; evidence and cases are never removed."),
        "inputSchema": {
            "type": "object",
            "properties": {
                "slug": {"type": "string",
                         "description": "lowercase-words-with-hyphens, e.g. icons-beside-links."},
                "title": {"type": "string", "description": "Required for a new pattern."},
                "verdict": {"type": "string",
                            "description": "One line: what to do. Required for a new pattern."},
                "status": {"type": "string", "enum": list(STATUSES),
                           "description": "decided once the user picked; researched before that."},
                "tags": _LIST,
                "project": {"type": "string", "description": "The repo this came up in."},
                "rules": {**_LIST, "description": "Replaces the rules: short imperative lines."},
                "screens": {**_LIST, "description": "App · what it shows, in your words · mobbin_url"},
                "guidelines": {**_LIST, "description": "Source · its rule · URL"},
                "case": {"type": "string",
                         "description": ("What was asked and decided: what the user picked, and "
                                         "whether it matched your recommendation.")},
            },
            "required": ["slug"],
        },
    },
]


def root() -> str:
    return os.environ.get("MYSTICAL_UX_DIR") or os.path.expanduser("~/.mystical/ux")


@contextlib.contextmanager
def _lock():
    """One writer at a time: several sessions (and the bridge) share these files."""
    os.makedirs(root(), exist_ok=True)
    with open(os.path.join(root(), ".lock"), "w") as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        yield


def _line(v) -> str:
    return " ".join(str(v or "").split())        # front matter and bullets are one line each


def _split(v) -> list[str]:
    return [t for t in (s.strip().lower() for s in str(v or "").split(",")) if t]


def _words(text: str) -> set[str]:
    return {w[:-1] if len(w) > 3 and w.endswith("s") and not w.endswith("ss") else w
            for w in re.findall(r"[a-z0-9]+", str(text).lower()) if w not in _STOP}


def _project(cwd: str | None) -> str:
    """The repo a run was in; a worktree (…/.worktrees/<repo>/<branch>) counts as its repo."""
    if not cwd:
        return ""
    head, _, tail = cwd.rstrip("/").partition("/.worktrees/")
    return tail.split("/")[0] if tail else os.path.basename(head)


def _path(slug: str) -> str:
    return os.path.join(root(), "patterns", slug + ".md")


def _read(path: str) -> tuple[dict, dict]:
    meta: dict = {}
    sections: dict[str, list[str]] = {}
    with open(path, encoding="utf-8") as f:
        text = f.read()
    if text.startswith("---\n"):
        head, _, text = text[4:].partition("\n---\n")
        for row in head.splitlines():
            k, sep, v = row.partition(":")
            if sep:
                meta[k.strip()] = v.strip()
    cur = None
    for row in text.splitlines():
        if row.startswith("## "):
            cur = row[3:].strip()
            sections.setdefault(cur, [])
        elif cur is not None and row.strip():
            # shortcut: blank lines inside a section are not kept; fine while sessions write bullets
            sections[cur].append(row.rstrip())
    return meta, sections


def _write(path: str, meta: dict, sections: dict) -> None:
    keys = [k for k in _FIELDS if meta.get(k)] + [k for k in meta if k not in _FIELDS and meta[k]]
    names = [n for n in _ORDER if sections.get(n)] + [n for n in sections if n not in _ORDER and sections[n]]
    text = ("---\n" + "\n".join(f"{k}: {meta[k]}" for k in keys) + "\n---\n\n"
            + "\n\n".join(f"## {n}\n" + "\n".join(sections[n]) for n in names) + "\n")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(path + ".tmp", path)               # never a half-written pattern


def record(args: dict) -> str:
    slug = str(args.get("slug") or "").strip()
    if not _SLUG.fullmatch(slug):
        return "slug must be lowercase words joined by hyphens, like icons-beside-links."
    status = _line(args.get("status"))
    if status and status not in STATUSES:
        return "status must be decided, researched or open."
    path, today = _path(slug), date.today().isoformat()
    with _lock():
        exists = os.path.exists(path)
        meta, sec = _read(path) if exists else ({}, {})
        if not exists and not (_line(args.get("title")) and _line(args.get("verdict"))):
            return "A new pattern needs a title and a verdict."
        if _line(args.get("title")):
            meta["title"] = _line(args["title"])
        meta["status"] = status or meta.get("status") or "researched"
        verdict = _line(args.get("verdict"))
        if verdict and verdict != meta.get("verdict"):
            if meta.get("verdict"):
                sec.setdefault("History", []).append(f"- {today} · verdict was: {meta['verdict']}")
            meta["verdict"] = verdict
        for key, more in (("tags", args.get("tags") or []), ("projects", [args.get("project")])):
            have = _split(meta.get(key))
            meta[key] = ", ".join(have + [t for t in _split(",".join(map(_line, more))) if t not in have])
        if args.get("rules"):
            sec["Rules"] = [f"- {_line(r)}" for r in args["rules"] if _line(r)]
        for key, name in (("screens", "Seen in real apps"), ("guidelines", "Guidelines")):
            for item in args.get(key) or []:
                bullet = f"- {_line(item)}"
                if _line(item) and bullet not in sec.setdefault(name, []):
                    sec[name].append(bullet)
        if _line(args.get("case")):
            where = f" · {_line(args.get('project'))}" if _line(args.get("project")) else ""
            sec.setdefault("Cases", []).append(f"- {today}{where} · {_line(args['case'])}")
        meta["updated"] = today
        _write(path, meta, sec)
    return f"{'Updated' if exists else 'Created'} {slug} ({meta['status']}): {meta['verdict']}"


def get(slug: str) -> str:
    slug = str(slug or "").strip()
    if not _SLUG.fullmatch(slug) or not os.path.exists(_path(slug)):
        return f"No pattern named {slug!r}. SearchUx lists them."
    with open(_path(slug), encoding="utf-8") as f:
        return f.read()


def _log() -> list[dict]:
    try:
        with open(os.path.join(root(), "mobbin.jsonl"), encoding="utf-8") as f:
            rows = [json.loads(r) for r in f if r.strip()]
    except (OSError, ValueError):
        return []
    return [r for r in rows if isinstance(r, dict)]


def search(query: str, tags=None) -> str:
    want = _words(query)
    if not want:
        return "Give a few words to search for."
    need = set(_split(",".join(tags or [])))
    hits = []
    for path in glob.glob(os.path.join(root(), "patterns", "*.md")):
        meta, sec = _read(path)
        if need and not need <= set(_split(meta.get("tags"))):
            continue
        body = " ".join(" ".join(v) for v in sec.values())
        score = (3 * len(want & _words(meta.get("title", ""))) + 3 * len(want & _words(meta.get("tags", "")))
                 + 2 * len(want & _words(meta.get("verdict", ""))) + len(want & _words(body)))
        if score:
            n = {k: len(sec.get(k, [])) for k in ("Seen in real apps", "Guidelines", "Cases")}
            hits.append((score, os.path.basename(path)[:-3], meta, n))
    hits.sort(key=lambda h: -h[0])
    out = []
    def count(k, word):
        return f"{k} {word}" + ("" if k == 1 else "s")
    if hits:
        out.append(f"Patterns ({min(len(hits), 5)} of {len(hits)}):")
        for _, slug, meta, n in hits[:5]:
            out += [f"- {slug} · {meta.get('status', '').upper()} · {meta.get('title', '')}",
                    f"  {meta.get('verdict', '')} ({count(n['Seen in real apps'], 'screen')} · "
                    f"{count(n['Guidelines'], 'guideline')} · {count(n['Cases'], 'case')} · {meta.get('updated', '')})"]
    past = []
    for r in _log():
        got = len(want & _words(f"{r.get('query', '')} {r.get('intent', '')}"))
        if got and got >= (len(want) + 1) // 2:      # at least half the question's words
            past.append((got, r))
    past.sort(key=lambda p: (p[0], str(p[1].get("at", ""))), reverse=True)   # best, then newest
    if past:
        out.append(f"Past Mobbin searches ({len(past)}):")
        for _, r in past[:3]:
            shots = ", ".join(f"{s.get('app', '')} {s.get('url', '')}" for s in r.get("screens", [])[:6])
            out.append(f"- {str(r.get('at', ''))[:10]} · {r.get('project', '')} · \"{r.get('query', '')}\": {shots}")
    if not out:
        return ("Nothing yet for that. Research it (Mobbin, guidelines), then RecordUx what you learn "
                "so the next session finds it here.")
    if hits:
        out.append("GetUx(slug) gives a whole pattern.")
    return "\n".join(out)


def capture(tool: str, content, cwd: str | None = None) -> bool:
    """Append one Mobbin result to mobbin.jsonl. Called from the bridge's stream
    handler, so it swallows its own errors: nothing here may break a turn."""
    try:
        if not isinstance(content, list):
            return False
        query, screens = "", []
        for block in content:
            if not (isinstance(block, dict) and block.get("type") == "text"):
                continue
            try:
                data = json.loads(block.get("text") or "")
            except ValueError:
                continue
            if not isinstance(data, dict):
                continue
            query = query or _line(data.get("query"))
            for v in data.values():
                if isinstance(v, list):
                    screens += [{"app": _line(x.get("app_name")), "id": _line(x.get("id")),
                                 "url": _line(x["mobbin_url"])}
                                for x in v if isinstance(x, dict) and x.get("mobbin_url")]
        if not screens:
            return False
        row = {"at": datetime.now().isoformat(timespec="seconds"), "tool": tool.rsplit("__", 1)[-1],
               "project": _project(cwd), "query": query, "screens": screens}
        with _lock(), open(os.path.join(root(), "mobbin.jsonl"), "a", encoding="utf-8") as f:
            f.write(json.dumps(row, ensure_ascii=False) + "\n")
        return True
    except Exception:  # noqa: BLE001 — best-effort, like bridge/learn.py
        return False


def _call(name: str, args: dict) -> str:
    if name == "SearchUx":
        return search(args.get("query") or "", args.get("tags"))
    if name == "GetUx":
        return get(args.get("slug") or "")
    if name == "RecordUx":
        return record(args)
    return f"Unknown tool: {name}"


def _handle(req: dict) -> dict | None:
    """One JSON-RPC request in, one response out. None for notifications."""
    method, rid = req.get("method"), req.get("id")
    if method == "initialize":
        result = {"protocolVersion": PROTOCOL, "capabilities": {"tools": {}},
                  "serverInfo": {"name": "mystical-ux", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": _TOOLS}
    elif method == "tools/call":
        params = req.get("params") or {}
        try:
            text = _call(params.get("name") or "", params.get("arguments") or {})
        except Exception as e:  # noqa: BLE001 — the model reads the failure instead of hanging
            text = f"mystical-ux failed: {e}"
        result = {"content": [{"type": "text", "text": text}]}
    elif rid is None:
        return None
    else:
        return {"jsonrpc": "2.0", "id": rid, "error": {"code": -32601, "message": f"no method {method}"}}
    return {"jsonrpc": "2.0", "id": rid, "result": result}


def main() -> None:
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            resp = _handle(json.loads(line))
        except Exception as e:  # noqa: BLE001 — a bad frame must not kill the server
            print(f"[ux_mcp] {e}", file=sys.stderr)
            continue
        if resp is not None:
            sys.stdout.write(json.dumps(resp) + "\n")
            sys.stdout.flush()


if __name__ == "__main__":
    main()
