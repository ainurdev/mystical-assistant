"""Ticket sets: Matt Pocock's /to-tickets files, read as a dependency graph.

A feature path's TICKETS step runs Matt's skill, which writes one markdown file per
ticket under `.mystical/tickets/<feature-slug>/<NN>-<slug>.md` in the session's
checkout. We read those files as they are (`# NN: Title`, `**Blocked by:** ...`) rather
than keep a second copy of the plan in the DB: the files are what the user and Claude
both edit, so they can't drift.

What the bridge adds is state, in `set.json` beside the ticket files: per ticket
queued/running/done/fix/missing, its branch, worktree, session and base. State is files,
not DB tables, so a set moves with its checkout and a restart loses nothing. A registry
(`ticketsets.json`, beside the DB like waits.json) lists the folders so we can find sets.

Rules the scheduler (Task 10) and merge (Task 11) follow, decided in the spec:
- At most 3 tickets run at once.
- Branching: a ticket with one blocker starts from that blocker's branch; with several,
  from the first blocker's branch with the rest merged in.
- Nothing merges while building. One merge session handles the whole pass at the end.
- Tickets live in the session's checkout, not the feature worktree.

Blocked-by parsing: `#2`, `02`, `2`, `#02` are all ticket 02; anything else must equal
another ticket's title (trimmed, case-insensitive). "None..." or empty is no blockers.
Several are separated by commas or "and".

Not built: titles containing a comma or " and " can't be referenced by title; use the number.
"""

import json
import os
import re
import sys
import threading
import time
from typing import NamedTuple

from bridge import config


class TicketError(ValueError):
    pass


class Ticket(NamedTuple):
    n: str
    title: str
    path: str
    blocked_by: tuple


_HEAD = re.compile(r"^#\s+(\d{1,2})\s*:\s*(.+?)\s*$", re.M)
# Label with an optional list marker and bold, colon inside or outside the bold.
_BLOCK = re.compile(r"^[ \t]*(?:[-*+][ \t]+)?(?:\*\*)?blocked by(?:\*\*[ \t]*:|[ \t]*:(?:\*\*)?)[ \t]*(.*?)\s*$",
                    re.M | re.I)
_TAIL = re.compile(r"(?:\.+|\s*\([^)]*\))+\s*$")
_NUM = re.compile(r"^#?(\d{1,2})$")
_SPLIT = re.compile(r"\s*,\s*|\s+and\s+", re.I)


def parse_dir(folder: str) -> list:
    raw = []   # (n, title, path, refs)
    for name in sorted(os.listdir(folder)):
        if not name.endswith(".md"):
            continue
        path = os.path.join(folder, name)
        with open(path, encoding="utf-8") as f:
            text = f.read()
        h = _HEAD.search(text)
        if not h:
            continue
        b = _BLOCK.search(text)
        val = b.group(1).strip().strip("*").strip() if b else ""
        refs = [] if not val or val.lower().startswith("none") else \
            [r for r in (_TAIL.sub("", x.strip()).strip() for x in _SPLIT.split(val)) if r]
        if val and not val.lower().startswith("none") and not refs:
            raise TicketError(f"#{h.group(1).zfill(2)} has an unreadable Blocked by: {val!r}")
        if any(r[0] == h.group(1).zfill(2) for r in raw):
            raise TicketError(f"two tickets are numbered #{h.group(1).zfill(2)}")
        raw.append((h.group(1).zfill(2), h.group(2), path, refs))
    by_title = {t.strip().lower(): n for n, t, _, _ in raw}
    known = {n for n, *_ in raw}
    out = []
    for n, title, path, refs in raw:
        deps = []
        for r in refs:
            m = _NUM.match(r)
            d = m.group(1).zfill(2) if m else by_title.get(r.strip().lower())
            if d is None or d not in known:
                raise TicketError(f"#{n} is blocked by {'#' + d if d else repr(r)}, "
                                  "which doesn't exist")
            if d not in deps:
                deps.append(d)
        out.append(Ticket(n, title, path, tuple(deps)))
    return out


def order(tks: list) -> list:
    """Topological order, lowest number first among the ready ones."""
    deps = {t.n: set(t.blocked_by) for t in tks}
    done, out = set(), []
    while len(out) < len(deps):
        ready = sorted(n for n, d in deps.items() if n not in done and d <= done)
        if not ready:
            raise TicketError("cycle: " + " → ".join("#" + n for n in _cycle(deps, done)))
        out.append(ready[0])
        done.add(ready[0])
    return out


def _cycle(deps: dict, done: set) -> list:
    left = {n for n in deps if n not in done}
    n, seen = min(left), []
    while n not in seen:   # every left ticket has a blocker that is also left
        seen.append(n)
        n = min(deps[n] & left)
    loop = seen[seen.index(n):]
    i = loop.index(min(loop))
    loop = loop[i:] + loop[:i]
    return loop + [loop[0]]


def _atomic(path: str, data) -> None:
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, path)


def load(folder: str) -> dict:
    try:
        with open(os.path.join(folder, "set.json"), encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        return {}
    return d if isinstance(d, dict) else {}


def save(folder: str, state: dict) -> None:
    _atomic(os.path.join(folder, "set.json"), state)


_lock = threading.Lock()


def _path() -> str:
    return os.path.join(os.path.dirname(config.BRIDGE_DB), "ticketsets.json")


def _load_locked() -> list:
    try:
        with open(_path(), encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        return []
    return [r for r in d if isinstance(r, dict)] if isinstance(d, list) else []


def _save_locked(rows: list) -> None:
    try:
        _atomic(_path(), rows)
    except OSError as e:
        print(f"[tickets] persist failed: {e}", file=sys.stderr)


def register(folder: str, project: str, slug: str) -> None:
    with _lock:
        rows = [r for r in _load_locked() if r.get("folder") != folder]
        rows.append({"folder": folder, "project": project, "slug": slug, "created": time.time()})
        _save_locked(rows)


def sets() -> list:
    with _lock:
        return _load_locked()


def summary_for(session_id: str):
    """The newest set whose parent session is this one, with its folder, or None."""
    for r in sorted(sets(), key=lambda r: r.get("created", 0), reverse=True):
        if not isinstance(r.get("folder"), str):
            continue
        st = load(r["folder"])
        if st.get("parent_session") == session_id:
            return {**st, "folder": r["folder"]}
    return None
