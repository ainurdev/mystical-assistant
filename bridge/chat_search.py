"""Searching what was said in earlier chats, and in one chat.

Plain LIKE over prompts and the agent's words, newest first. Tool output is left out on
purpose: it's most of the bytes and mostly noise. A chat has at most a few thousand rows of
words and this runs when someone asks, so no index table has to be kept in step.
Saved lessons (.mystical/learn) are searched by search_chats' caller only when a project is
known. Read only. Stdlib only.
"""

import json
import os
import sqlite3
from contextlib import closing

from bridge import config

_LIMIT = 12


def _snippet(text: str, q: str, width: int = 160) -> str:
    low = text.lower()
    i = low.find(q.lower())
    if i < 0:
        return " ".join(text.split())[:width]
    a, b = max(0, i - width // 2), min(len(text), i + len(q) + width // 2)
    return ("…" if a else "") + " ".join(text[a:b].split()) + ("…" if b < len(text) else "")


def _like(q: str) -> str:
    return "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"


def _words_of(row) -> str:
    try:
        d = json.loads(row["payload"])
    except (ValueError, TypeError):
        return ""
    return d.get("text") or d.get("result") or ""


def search(chat_id: int, query: str, project: "str | None" = None, exclude: "str | None" = None,
           limit: int = _LIMIT) -> list:
    """Across chats: one row per chat, its best hit."""
    q = (query or "").strip()
    if len(q) < 2:
        return []
    like = _like(q)
    where, args = "s.chat_id=?", [chat_id]
    if project:
        where += " AND s.project=?"
        args.append(project)
    if exclude:
        where += " AND s.id!=?"
        args.append(exclude)
    with closing(sqlite3.connect(f"file:{config.BRIDGE_DB}?mode=ro", uri=True)) as c:
        c.row_factory = sqlite3.Row
        rows = c.execute(
            f"SELECT t.session_id, t.prompt AS text, t.started AS at, s.title, s.project FROM turns t "
            f"JOIN sessions s ON s.id=t.session_id WHERE {where} AND t.prompt LIKE ? ESCAPE '\\' "
            f"ORDER BY t.started DESC LIMIT 200", (*args, like)).fetchall()
        hits = c.execute(
            f"SELECT e.session_id, e.payload, e.ts AS at, s.title, s.project FROM events e "
            f"JOIN sessions s ON s.id=e.session_id WHERE {where} AND e.type IN ('text','result') "
            f"AND e.payload LIKE ? ESCAPE '\\' ORDER BY e.rowid DESC LIMIT 200", (*args, like)).fetchall()
    seen, out = set(), []
    merged = [(r["at"] or 0, r["session_id"], r["text"] or "", r["title"], r["project"]) for r in rows] + \
             [(r["at"] or 0, r["session_id"], _words_of(r), r["title"], r["project"]) for r in hits]
    for at, sid, text, title, proj in sorted(merged, key=lambda x: -x[0]):
        if sid in seen or q.lower() not in text.lower():
            continue
        seen.add(sid)
        out.append({"session_id": sid, "title": title or "untitled", "project": proj, "at": at,
                    "snippet": _snippet(text, q)})
        if len(out) >= limit:
            break
    return out


def in_chat(session_id: str, query: str, limit: int = 100) -> list:
    """Within one chat: every hit, oldest first, with the turn to jump to."""
    q = (query or "").strip()
    if len(q) < 2:
        return []
    like = _like(q)
    with closing(sqlite3.connect(f"file:{config.BRIDGE_DB}?mode=ro", uri=True)) as c:
        c.row_factory = sqlite3.Row
        prompts = c.execute("SELECT id, prompt, started FROM turns WHERE session_id=? AND prompt LIKE ? ESCAPE '\\'",
                            (session_id, like)).fetchall()
        events = c.execute("SELECT turn_id, type, payload, seq FROM events WHERE session_id=? "
                           "AND type IN ('text','result','steer') AND payload LIKE ? ESCAPE '\\' ORDER BY seq LIMIT 400",
                           (session_id, like)).fetchall()
    out = [{"turn": r["id"], "kind": "prompt", "seq": None, "snippet": _snippet(r["prompt"], q), "at": r["started"]}
           for r in prompts]
    for r in events:
        text = _words_of(r)
        if q.lower() in text.lower():
            out.append({"turn": r["turn_id"], "kind": r["type"], "seq": r["seq"], "snippet": _snippet(text, q)})
    return out[:limit]


def lessons(root: "str | None", query: str, limit: int = 5) -> list:
    """Saved lessons in a project that mention this."""
    d = os.path.join(root or "", ".mystical", "learn")
    q = (query or "").strip().lower()
    out = []
    try:
        names = sorted(os.listdir(d), reverse=True)
    except OSError:
        return []
    for n in names:
        if not n.endswith(".md"):
            continue
        try:
            with open(os.path.join(d, n), encoding="utf-8", errors="replace") as f:
                text = f.read(20000)
        except OSError:
            continue
        if q and q in text.lower():
            out.append({"name": n, "snippet": _snippet(text, q)})
            if len(out) >= limit:
                break
    return out


