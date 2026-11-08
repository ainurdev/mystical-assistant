"""The project's work list: tasks you keep, which outlive any chat.

Different from a goal (bridge/goals.py), which is one objective a single chat loops on. This
is many tasks, kept per project, that any chat can read and that a run works through
(bridge/workrun.py). See docs/superpowers/specs/work-list.md.

Why it holds no integrations: an agent reads Jira, Linear, Rivendell or your notes with whichever
tools it has, and writes the list through one tool. So a new tracker needs no code, and nothing
changes behind your back: the list moves when you ask, never on a schedule. `source` only
remembers where an item came from, so a refresh can match it and the sidebar can link to it.

Why JSON in .mystical at the main checkout: one list for every chat and worktree of a repo, it
moves with the project, and it's readable when the store is mid-migration. The file is
bridge-owned, so the MYSTICAL panel can't clear it (mystical_dir.OWNED). In-process lock only:
the bridge is the one writer.

An agent can't set item states a run owns: `doing` and `review` belong to the run, and an item
in them can't be edited out from under a helper. Nothing here starts anything.

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
SET_BY_HAND = ("todo", "blocked", "done", "dropped")   # doing and review are the run's
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
    return {"next": int(data.get("next") or 1), "items": list(data.get("items") or []), "runs": list(data.get("runs") or [])}


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


def active_run(data: dict) -> "dict | None":
    return next((r for r in data["runs"] if r.get("state") in ("running", "paused")), None)


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
            raise Refused(f"An item can't be set to {state} by hand: a run moves it there.")
        if item["state"] in LIVE:
            raise Refused(f"{item['id']} is {item['state']} in a run. Stop or restart it there first.")
        _set_state(item, state, session)
    item["updated"] = time.time()


def add(root: str, rows: list, session: "str | None" = None) -> list:
    if not isinstance(rows, list) or not rows:
        raise Refused("Give at least one item, each with a title.")
    return mutate(root, lambda data: [_new(data, r if isinstance(r, dict) else {"title": r}, session) for r in rows])


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
                raise Refused(f"{item['id']} is {item['state']} in a run. Stop or restart it there first.")
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
    as they're the record, unless clear_done. Anything a run is holding stays too."""
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
        run = active_run(data)
        held = set(run["items"]) if run else set()
        stays = [i for i in old if i["id"] not in seen and (i["state"] in LIVE or i["id"] in held or (i["state"] in ("done", "dropped") and not clear_done))]
        removed = len([i for i in old if i["id"] not in seen]) - len(stays)
        data["items"] = new + stays
        known = {i["id"] for i in data["items"]}
        for item in data["items"]:
            item["depends_on"] = [d for d in item.get("depends_on") or [] if d in known]
        return {"added": added, "kept": kept, "removed": removed}
    return mutate(root, go)


# ------- what the surfaces read ----------------------------------------------

def _group(item: dict, run: "dict | None", chat: "str | None") -> str:
    state = item["state"]
    if state == "done":
        return "here" if chat and item.get("done_in") == chat else "done"
    if state == "todo":
        return "next" if not run or item["id"] in run["items"] else "later"
    return state


def view(root: str, chat: "str | None" = None) -> dict:
    """Everything, with each item's sidebar group, so both apps group it alike."""
    data = load(root)
    run = active_run(data)
    from bridge import workrefine
    return {"items": [{**i, "group": _group(i, run, chat), "refining": workrefine.refining(root, i["id"])} for i in data["items"]],
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
        elif path == "worklist/remove":
            remove(root, body.get("ids"))
        elif path == "worklist/reorder":
            reorder(root, body.get("ids"))
        else:
            return {"error": "No such route."}, 404
    except Refused as e:
        return {"error": str(e)}, 400
    except OSError as e:
        return {"error": f"Couldn't save it: {e}"}, 500
    return view(root, session), 200
