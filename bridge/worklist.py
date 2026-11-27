"""The project's work list: tasks you keep, which outlive any chat.

Different from a goal (bridge/goals.py), which is one objective a single chat loops on. This
is many tasks, kept per project, that any chat can read. A task is what you want done and when;
how it is built is its flow (GLOSSARY: Task, Flow, Part). Starting one (start, from the panel's
Start) opens a session of its own on the flow you picked (build, fix or design), named for the
task, on a branch named for it, and from then on the task's state mirrors that flow: spec, parts
or build doing; a set waiting for approval or a part needing a fix blocked; merging or the
council review; the flow's end done. Read live in view(), and written back at every turn's end
(after_turn), which is also when a task waiting on another starts. A one-part task's set starts
without the approval a bigger one waits for (tickets.start_build). See docs/superpowers/specs/work-list.md.

Why only a tap starts one: items come from trackers and notes anyone may have written in, so text
in a task must not be able to set work going. A task after another (depends_on) starts by itself
only once you pressed its Start (`armed`), when the one it waits on is done; a dependency an agent
added alone never starts anything.

A task another chat's Spin-off card filed (bridge/spinoffs.py, file) is the same task with three
fields only a card sets: `from` (that chat and the source keys, so its session links back),
`sources` (every source a row covered, which a repeat is matched by), and `after`, a blocker that
may sit in another project's list. That blocker keeps `then`, so its end syncs the list waiting on
it (sync), and the one after starts with its branch and last reply (_follows).

Why it holds no integrations: an agent reads Jira, Linear, Rivendell or your notes with whichever
tools it has, and writes the list through one tool. So a new tracker needs no code, and nothing
changes behind your back: the list moves when you ask, never on a schedule. `source` only
remembers where an item came from, so a refresh can match it and the sidebar can link to it.

Why JSON in .mystical at the main checkout: one list for every chat and worktree of a repo, it
moves with the project, and it's readable when the store is mid-migration. The file is
bridge-owned, so the MYSTICAL panel can't clear it (mystical_dir.OWNED). In-process lock only:
the bridge is the one writer.

An agent can't set the states a flow owns: `doing` and `review` follow the task's session, and a
task in them can't be edited out from under it.

Stdlib only.
"""

import json
import os
import re
import shutil
import sys
import threading
import time

from bridge import chat_images

STATES = ("todo", "doing", "review", "blocked", "done", "dropped")
SET_BY_HAND = ("todo", "blocked", "done", "dropped")   # doing and review are the flow's
LIVE = ("doing", "review")
MAX_ITEMS, MAX_TITLE, MAX_DETAIL, MAX_NOTE = 500, 200, 8000, 1000
_lock = threading.RLock()


class Refused(ValueError):
    """A sentence for whoever asked: what to change."""


def root_of(cwd: "str | None") -> "str | None":
    return chat_images.root_of(cwd)


def _path(root: str) -> str:
    return os.path.join(root, ".mystical", "worklist.json")


def load(root: str) -> dict:
    try:
        with open(_path(root), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        data = {}
    data = data if isinstance(data, dict) else {}
    return {"next": int(data.get("next") or 1), "items": list(data.get("items") or [])}


def save(root: str, data: dict) -> None:
    from bridge import devserver
    devserver.mystical_dir(root)      # the folder, ignoring itself from git
    tmp = f"{_path(root)}.{threading.get_ident()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, _path(root))


def mutate(root: str, fn):
    """Read, change, write, as one step. `fn` raising leaves the file alone."""
    with _lock:
        data = load(root)
        out = fn(data)
        save(root, data)
        return out


def _text(value, limit: int) -> str:
    return str(value or "").strip()[:limit]


def _source(raw) -> "dict | None":
    if not isinstance(raw, dict):
        return None
    url = _text(raw.get("url"), 1000)
    # The sidebar makes it a link, and this text may have come from a tracker anyone can write to.
    if not url.lower().startswith(("https://", "http://")):
        url = ""
    out = {"kind": _text(raw.get("kind"), 40), "ref": _text(raw.get("ref"), 200), "url": url}
    return out if any(out.values()) else None


def _deps(raw, known: set) -> list:
    if not isinstance(raw, list):
        return []
    return [str(d) for d in raw if str(d) in known][:50]


def _find(data: dict, iid: str) -> dict:
    hit = next((i for i in data["items"] if i["id"] == str(iid)), None)
    if not hit:
        raise Refused(f"No item is called {iid}.")
    return hit


def _new(data: dict, row: dict, session: "str | None") -> dict:
    title = " ".join(_text(row.get("title"), MAX_TITLE).split())
    if not title:
        raise Refused("An item needs a title.")
    if len(data["items"]) >= MAX_ITEMS:
        raise Refused(f"The list holds {MAX_ITEMS} items. Remove some first.")
    now = time.time()
    item = {"id": f"w{data['next']}", "title": title, "detail": _text(row.get("detail"), MAX_DETAIL), "source": _source(row.get("source")),
            "depends_on": _deps(row.get("depends_on"), {i["id"] for i in data["items"]}), "state": "todo", "note": _text(row.get("note"), MAX_NOTE),
            "created": now, "updated": now}
    data["next"] += 1
    data["items"].append(item)
    if row.get("state") in SET_BY_HAND and row["state"] != "todo":
        _set_state(item, row["state"], session)
    return item


def _set_state(item: dict, state: str, session: "str | None") -> None:
    item["state"] = state
    item["updated"] = time.time()
    if state == "done":
        item["done_at"] = item["updated"]
        item["done_in"] = session
    else:
        item.pop("done_at", None)
        item.pop("done_in", None)


def _edit(data: dict, item: dict, patch: dict, session: "str | None") -> None:
    if "title" in patch:
        title = " ".join(_text(patch["title"], MAX_TITLE).split())
        if not title:
            raise Refused("An item needs a title.")
        item["title"] = title
    if "detail" in patch:
        item["detail"] = _text(patch["detail"], MAX_DETAIL)
    if "note" in patch:
        item["note"] = _text(patch["note"], MAX_NOTE)
    if "source" in patch:
        item["source"] = _source(patch["source"])
    if "depends_on" in patch:
        item["depends_on"] = _deps(patch["depends_on"], {i["id"] for i in data["items"] if i["id"] != item["id"]})
    state = patch.get("state")
    if state and state != item["state"]:
        if state not in SET_BY_HAND:
            raise Refused(f"An item can't be set to {state} by hand: its flow moves it there.")
        if item["state"] in LIVE:
            raise Refused(f"{item['id']} is {item['state']} in its session. Stop it there first.")
        _set_state(item, state, session)
    item["updated"] = time.time()


def add(root: str, rows: list, session: "str | None" = None) -> list:
    if not isinstance(rows, list) or not rows:
        raise Refused("Give at least one item, each with a title.")
    return mutate(root, lambda data: [_new(data, r if isinstance(r, dict) else {"title": r}, session) for r in rows])


def _same_source(a: dict, b: dict) -> bool:
    """One source: the same link, or the same ref of the same kind (or of no kind said)."""
    if a.get("url") and a["url"] == b.get("url"):
        return True
    kinds = {a.get("kind") or "", b.get("kind") or ""} - {""}
    return bool(a.get("ref")) and a["ref"] == b.get("ref") and len(kinds) < 2


def holding(root: str, sources: list) -> "dict | None":
    """The task on this list that came from one of these sources, or None."""
    for item in load(root)["items"]:
        theirs = item.get("sources") or ([item["source"]] if item.get("source") else [])
        if any(_same_source(a, b) for a in sources for b in theirs):
            return item
    return None


def file(root: str, row: dict, session: "str | None", came: dict, sources: list, after: "dict | None" = None) -> dict:
    """A Task a chat's spin-off card files here (bridge/spinoffs.py), with what only a card sets: the
    chat it came from (`from`: {session, keys}), every source it covers, and the Task it waits on
    (`after`: {root, id}), in this list or another project's. That one is told (`then`), so its end
    starts this one wherever it is (sync)."""
    def go(data: dict) -> dict:
        item = _new(data, row, session)
        item.update({"from": came, "sources": [s for s in (_source(x) for x in sources) if s]})
        if after:
            item["after"] = after
            if after["root"] == root:
                item["depends_on"] = _deps([after["id"]], {i["id"] for i in data["items"]})
        return dict(item)
    item = mutate(root, go)
    if after and after["root"] != root:
        try:
            mutate(after["root"], lambda data: _find(data, after["id"]).setdefault("then", []).append({"root": root, "id": item["id"]}))
        except Refused:   # gone from its list since: nothing to wait on (_after_done)
            pass
    return item


def update(root: str, rows: list, session: "str | None" = None) -> list:
    if not isinstance(rows, list) or not rows:
        raise Refused("Give at least one item, each with an id.")

    def go(data: dict) -> list:
        out = []
        for row in rows:
            item = _find(data, row.get("id") if isinstance(row, dict) else row)
            _edit(data, item, row, session)
            out.append(item)
        return out
    return mutate(root, go)


def remove(root: str, ids: list) -> int:
    if not isinstance(ids, list) or not ids:
        raise Refused("Say which items.")

    def go(data: dict) -> int:
        gone = {_find(data, i)["id"] for i in ids}
        for item in data["items"]:
            if item["id"] in gone and item["state"] in LIVE:
                raise Refused(f"{item['id']} is {item['state']} in its session. Stop it there first.")
        data["items"] = [i for i in data["items"] if i["id"] not in gone]
        for item in data["items"]:
            item["depends_on"] = [d for d in item.get("depends_on") or [] if d not in gone]
        return len(gone)
    return mutate(root, go)


def reorder(root: str, ids: list) -> None:
    """These first, in this order; the rest keep theirs behind them."""
    if not isinstance(ids, list) or not ids:
        raise Refused("Say which items.")

    def go(data: dict) -> None:
        first = [_find(data, i) for i in dict.fromkeys(str(i) for i in ids)]
        taken = {i["id"] for i in first}
        data["items"] = first + [i for i in data["items"] if i["id"] not in taken]
    mutate(root, go)


def _same(item: dict, row: dict) -> bool:
    if row.get("id") and row["id"] == item["id"]:
        return True
    ref, have = (row.get("source") or {}).get("ref") if isinstance(row.get("source"), dict) else None, (item.get("source") or {}).get("ref")
    return bool(ref and have and ref == have)


def replace(root: str, rows: list, session: "str | None" = None, clear_done: bool = False) -> dict:
    """Make the list this, as a refresh from a tracker or "start over" does. An item it names, by
    id or source ref, is kept with its state. Open items it doesn't name go. Finished ones stay,
    as they're the record, unless clear_done. A started one stays too."""
    if not isinstance(rows, list):
        raise Refused("Give the items as a list.")

    def go(data: dict) -> dict:
        old, new, seen, added, kept = list(data["items"]), [], set(), 0, 0
        data["items"] = old
        for row in rows:
            row = row if isinstance(row, dict) else {"title": row}
            hit = next((i for i in old if i["id"] not in seen and _same(i, row)), None)
            if hit:
                _edit(data, hit, {k: v for k, v in row.items() if k != "id"}, session)
                seen.add(hit["id"])
                new.append(hit)
                kept += 1
            else:
                item = _new(data, row, session)
                seen.add(item["id"])
                new.append(item)
                added += 1
        stays = [i for i in old if i["id"] not in seen and (i["state"] in LIVE or i.get("session_id") and i["state"] not in ("done", "dropped")
                                                             or (i["state"] in ("done", "dropped") and not clear_done))]
        removed = len([i for i in old if i["id"] not in seen]) - len(stays)
        data["items"] = new + stays
        known = {i["id"] for i in data["items"]}
        for item in data["items"]:
            item["depends_on"] = [d for d in item.get("depends_on") or [] if d in known]
        return {"added": added, "kept": kept, "removed": removed}
    return mutate(root, go)


# ------- what the surfaces read ----------------------------------------------

# ------- a task's flow ---------------------------------------------------------

KINDS = {"build": "feat", "fix": "fix", "design": "feat"}   # the flows a task starts, and their branch's type
# What line 2 of a task's row says while its flow is on a step.
FIXING = ("fix", "missing")   # a part's statuses that wait on you
_STEP = {"grill": "Grilling the plan", "design": "Drawing the design", "spec": "Writing the spec",
         "tickets": "Splitting it into parts", "diagnose": "Finding the cause", "build-here": "Building",
         "review": "Reviewing", "retro": "Retro", "audit": "Auditing the repo", "improve": "Planning the refactor"}


def _flow(sid: str) -> "tuple[dict, dict]":
    """(the session's flow, its newest set of parts) as they stand."""
    from bridge import paths, tickets
    return paths.get(sid) or {}, tickets.summary_for(sid) or {}


def _parts(st: dict) -> list:
    ts = st.get("tickets") if isinstance(st.get("tickets"), dict) else {}
    return [{"n": n.lstrip("0") or "0", "title": t.get("title") or "", "status": t.get("status") or "",
             "session_id": t.get("session_id") or ""} for n, t in sorted(ts.items()) if isinstance(t, dict)]


def _underway(f: dict) -> str:
    """The flow's step now: its first not done or skipped."""
    gone = set(f.get("done") or []) | set(f.get("skipped") or [])
    return next((step[0] for step in f.get("stations") or [] if step[0] not in gone), "")


def _mirrored(f: dict, st: dict) -> str:
    """A started task's state, read off its flow: a flow without parts is in review on its review step."""
    if f.get("end"):
        return "done"
    status = st.get("status")
    if status in ("approve", "stopped", "fix") or any(p["status"] in FIXING for p in _parts(st)):
        return "blocked"
    return "review" if status in ("merging", "merged") or (not st and _underway(f) == "review") else "doing"


def _now(f: dict, st: dict) -> str:
    """What a started task is doing, in a few words."""
    status, parts = st.get("status"), _parts(st)
    if status == "approve":
        return f"{len(parts)} parts wait for your approval"
    if status in ("stopped", "fix"):
        return st.get("error") or "Stopped: it needs you"
    fixing = [p for p in parts if p["status"] in FIXING]
    if fixing:
        return f"#{fixing[0]['n']} {fixing[0]['title']} needs a fix"
    if status == "merging":
        return "Merging the parts"
    if status == "merged" and not f.get("end"):
        return "Council review" if "review" not in (f.get("done") or []) else "Retro"
    if status == "building":
        running = [p for p in parts if p["status"] == "running"]
        return (f"Building {', '.join('#' + p['n'] for p in running)}" if running else "Building")
    return _STEP.get(_underway(f), "Starting")


def start(root: str, iid: str, kind: str, chat_session: "str | None") -> dict:
    """The panel's Start: the task's own session on `kind`'s flow, seen from `chat_session`'s chat.
    One waiting on a task not done yet is armed instead, and starts when that one is (after_turn)."""
    if kind not in KINDS:
        raise Refused("Start it as build, fix or design.")
    from bridge import store
    chat = store.get_session(chat_session) if chat_session else None
    if not chat:
        raise Refused("Start it from a chat.")

    def claim(data: dict):
        item = _find(data, iid)
        if item["state"] != "todo" or item.get("session_id"):
            raise Refused(f"{item['id']} is {item['state']}: only a task not started yet starts.")
        done = {i["id"] for i in data["items"] if i["state"] == "done"}
        item.update(kind=kind, chat_id=chat["chat_id"], updated=time.time())
        if any(d not in done for d in item.get("depends_on") or []) or not _after_done(root, item):
            item["armed"] = True
            return None
        item.pop("armed", None)
        item["state"] = "doing"   # claimed before the session opens: a second tap is refused
        return dict(item)
    item = mutate(root, claim)
    if item:
        _launch(root, item)
    return _find(load(root), iid)


def _launch(root: str, item: dict) -> None:
    """Session, branch and first turn for a claimed task. One that can't start goes back to todo,
    with why in its note."""
    from bridge import browser, config, flowbranch, paths, profiles, runner, store
    kind, sid = item["kind"], ""
    try:
        prefix, slug = KINDS[kind], flowbranch.title_slug(item["title"])
        branch, cwd = f"{prefix}/{slug}", root
        if kind == "fix":   # FIX fixes in its first step: it gets its branch before it, never the default one
            branch, cwd = flowbranch.ensure_feature_branch({"cwd": root}, slug, prefix)
        project = browser.rel(root)   # the key every session files under, as the sidebar groups them
        pid = profiles.claude_default(project)   # Claude, never an agent: flows are Claude's
        s = store.create_session(item["chat_id"], project, origin="work", cwd=cwd,
                                 permission_mode=None if pid else config.NEW_SESSION_PERMISSION_MODE, profile_id=pid)
        sid = s["id"]
        store.rename(sid, item["title"])
        came = item.get("from")
        if came:   # a spin-off: it links back to the chat whose card started it (bridge/spinoffs.py)
            store.set_spun_from(sid, {"session": came.get("session") or "", "keys": list(came.get("keys") or [])})
        mutate(root, lambda data: _find(data, item["id"]).update(session_id=sid, branch=branch, note=""))
        prompt = item["title"] + (f"\n\n{item['detail']}" if item.get("detail") else "") + _came_from(item) + \
            _follows(item) + f"\n\nThis is task {item['id']} on the project's work list."
        chat = store.get_session((came or {}).get("session") or "") or {}
        job = runner.start_streaming_job(item["chat_id"], prompt, [], project=cwd, session_id=sid,
                                         origin="work", flow=kind, flow_by="you",
                                         sent_by="mystical:spinoff" if came else "mystical:work",
                                         sent_why=(f"you started it from the chat “{chat.get('title') or 'a chat'}”" if came
                                                   else f"you started task {item['id']} on the work list"))
        if job is None or job.refusal:
            raise RuntimeError(job.refusal if job else "the bridge refused the run")
        paths.set_branch(sid, branch)
    except Exception as e:  # noqa: BLE001 — told on the task, never raised into a turn's end
        print(f"[worklist] {item['id']} didn't start: {e!r}", file=sys.stderr)

        def back(data: dict) -> None:
            i = _find(data, item["id"])
            if not sid:
                _set_state(i, "todo", None)
            i["note"] = _text(f"Didn't start: {e}", MAX_NOTE)
        mutate(root, back)


def name_of(path: str) -> str:
    """A project's folder name, from its root or its key: what a prompt calls it."""
    return os.path.basename(path.rstrip("/")) or path


def _came_from(item: dict) -> str:
    """A spin-off's first prompt says which chat it came from and what it was found in."""
    came = item.get("from")
    if not came:
        return ""
    from bridge import store
    chat = store.get_session(came.get("session") or "") or {}
    where = f" in {name_of(chat['project'])}" if (chat.get("project") or "/") != "/" else ""
    found = "; ".join(" ".join(x for x in (s.get("kind"), s.get("ref"), s.get("url")) if x) for s in item.get("sources") or [])
    return f"\n\nSpun off from the chat “{chat.get('title') or 'a chat'}”{where}." + (f" Found in: {found}." if found else "")


def _other(after: dict) -> "dict | None":
    return next((i for i in load(after["root"])["items"] if i["id"] == after.get("id")), None)


def _finished(item: dict) -> bool:
    """Done, or its parts merged: all a Task after it waits for (its council and retro needn't hold it up)."""
    return item["state"] == "done" or bool(item.get("session_id") and _flow(item["session_id"])[1].get("status") == "merged")


def _after_done(root: str, item: dict) -> bool:
    """The Task it waits on in another project is finished, or gone from its list. One in this
    list is in depends_on, which the caller reads."""
    after = item.get("after")
    if not after or after.get("root") == root:
        return True
    other = _other(after)
    return other is None or _finished(other)


def _follows(item: dict) -> str:
    """What the Task before a chained one left it: its branch and its last reply."""
    after = item.get("after")
    other = _other(after) if after else None
    if not other:
        return ""
    from bridge import store
    reply = ((store.last_turn(other["session_id"]) or {}).get("result") or "").strip() if other.get("session_id") else ""
    on = f", on branch {other['branch']}" if other.get("branch") else ""
    return (f"\n\nIt follows “{other['title']}” in {name_of(after['root'])}{on}."
            + (f" Its last reply:\n\n{reply[:4000]}" if reply else ""))


def sync(root: str, _seen: "frozenset" = frozenset()) -> None:
    """Write each started task's state back from its flow, then start the armed tasks whose
    blockers are done or merged (their council and retro needn't hold the next one up). A task
    waiting here from another project's list (`then`) is synced there in turn."""
    def go(data: dict) -> "tuple[list, set]":
        merged = set()
        for item in data["items"]:
            if item.get("session_id") and item["state"] not in ("done", "dropped"):
                f, st = _flow(item["session_id"])
                if st.get("status") == "merged":
                    merged.add(item["id"])
                state = _mirrored(f, st)
                if state != item["state"]:
                    _set_state(item, state, item["session_id"])
        done = merged | {i["id"] for i in data["items"] if i["state"] == "done"}
        ready = []
        for item in data["items"]:
            if (item.get("armed") and item["state"] == "todo" and all(d in done for d in item.get("depends_on") or [])
                    and _after_done(root, item)):
                item.pop("armed")
                _set_state(item, "doing", None)
                ready.append(dict(item))
        # shortcut: every finished task's `then` is synced at each turn's end here, done or not;
        # drop a link once its task has started if those reads ever show.
        return ready, {t["root"] for i in data["items"] if i["id"] in done for t in i.get("then") or []}
    ready, waiting = mutate(root, go)
    for item in ready:
        _launch(root, item)
    for other in waiting - _seen - {root}:
        if os.path.isfile(_path(other)):
            sync(other, _seen | {root})


def after_turn(job) -> None:
    """A turn's end in a task's session, a part's or the merge's: its flow may have moved. Other
    sessions are passed over before any git runs (root_of), as every turn ends here."""
    try:
        from bridge import store
        s = store.get_session(job.store_session_id) or {}
        if s.get("origin") not in ("work", "ticket", "ticket-merge"):
            return
        root = root_of(s.get("cwd") or s.get("project"))
        if root and os.path.isfile(_path(root)):
            sync(root)
    except Exception as e:  # noqa: BLE001 — nothing may raise into a turn's end
        print(f"[worklist] after_turn: {e!r}", file=sys.stderr)


# ------- what the surfaces read ----------------------------------------------

def _live(item: dict) -> dict:
    """The task as the panel draws it: a started one's state, parts and step read off its flow now."""
    if not item.get("session_id") or item["state"] in ("done", "dropped"):
        return item
    f, st = _flow(item["session_id"])
    return {**item, "state": _mirrored(f, st), "now": _now(f, st), "parts": _parts(st),
            "sessions": [item["session_id"], *[p["session_id"] for p in _parts(st) if p["session_id"]],
                         *([st["merge_session"]] if st.get("merge_session") else [])]}


def _group(item: dict) -> str:
    """Needs you, Building, Up next or Done. The panel moves a task with an open Ask to needs too."""
    return {"blocked": "needs", "doing": "building", "review": "building", "todo": "next"}.get(item["state"], "done")


def view(root: str) -> dict:
    """Everything, with each item's group, so both apps group it alike."""
    from bridge import workrefine
    items = [_live(i) for i in load(root)["items"]]
    return {"items": [{**i, "group": _group(i), "refining": workrefine.refining(root, i["id"])} for i in items],
            "project": os.path.basename(root), "root": root}


def briefly(root: str) -> str:
    """The list in words, for an agent or Telegram."""
    data = load(root)
    if not data["items"]:
        return "The work list is empty."
    lines = []
    for i in data["items"]:
        source = i.get("source") or {}
        tail = (f" [{source.get('kind') or 'source'} {source.get('ref') or source.get('url')}]" if source.get("ref") or source.get("url") else "")
        deps = f" (after {', '.join(i['depends_on'])})" if i.get("depends_on") else ""
        lines.append(f"{i['id']} · {i['state']} · {i['title']}{tail}{deps}" + (f"\n  {i['detail']}" if i.get("detail") else "") + (f"\n  note: {i['note']}" if i.get("note") else ""))
    return "\n".join(lines)


_TRACKER = re.compile(r"jira|linear|github|gitlab|notion|asana|trello|sentry|shortcut|clickup", re.I)


def sources(s: "dict | None") -> list:
    """What Bring in can honestly offer: what an agent here could read. Best-effort, as your notes
    always work, and the box takes anything else you can describe."""
    out = []
    try:
        from bridge import gateway, mcp_share
        if s and gateway._rivendell_on(s):
            out.append("Rivendell")
        if shutil.which("gh"):
            out.append("GitHub issues")
        for name in mcp_share.definitions((s or {}).get("cwd")):
            if _TRACKER.search(name) and name.title() not in out:
                out.append(name.title())
    except Exception as e:  # noqa: BLE001
        print(f"[worklist] sources: {e!r}", file=sys.stderr)
    return out + ["My notes"]


def tool(s: dict, a: dict) -> str:
    """work_list, for a chat's main agent. Raises Refused with what to change."""
    root = root_of(s.get("cwd"))
    if not root:
        raise Refused("This chat has no project folder.")
    action = str(a.get("action") or "read")
    if action == "read":
        return briefly(root)
    if action == "add":
        made = add(root, a.get("items"), s["id"])
        return f"Added {', '.join(i['id'] for i in made)}.\n\n{briefly(root)}"
    if action == "update":
        update(root, a.get("items"), s["id"])
        return f"Updated.\n\n{briefly(root)}"
    if action == "remove":
        return f"Removed {remove(root, a.get('ids'))}.\n\n{briefly(root)}"
    if action == "reorder":
        reorder(root, a.get("ids"))
        return f"Reordered.\n\n{briefly(root)}"
    if action == "replace":
        got = replace(root, a.get("items"), s["id"], a.get("clear_done") is True)
        return f"Added {got['added']}, kept {got['kept']}, removed {got['removed']}.\n\n{briefly(root)}"
    raise Refused("action must be read, add, update, remove, replace or reorder.")


def api(path: str, body: dict, root: "str | None", session: "str | None") -> "tuple[dict, int]":
    """POST worklist/*: the sidebar's own edits."""
    if not root:
        return {"error": "This chat has no project folder."}, 400
    try:
        if path == "worklist/add":
            add(root, body.get("items"), session)
        elif path == "worklist/update":
            update(root, body.get("items"), session)
            sync(root)   # a blocker marked done by hand starts what was armed behind it
        elif path == "worklist/remove":
            remove(root, body.get("ids"))
        elif path == "worklist/reorder":
            reorder(root, body.get("ids"))
        elif path == "worklist/start":
            start(root, str(body.get("id") or ""), str(body.get("kind") or ""), session)
        else:
            return {"error": "No such route."}, 404
    except Refused as e:
        return {"error": str(e)}, 400
    except OSError as e:
        return {"error": f"Couldn't save it: {e}"}, 500
    return view(root), 200
