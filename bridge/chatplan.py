"""A chat's plan: the steps an agent set itself, shown in the Work list beside the project's tasks.

Different from the work list (bridge/worklist.py), which is the project's and outlives every chat. A plan
is one chat's: what the agent is doing now, in what order, how far it got. Writing it down keeps an agent
on track, and showing it lets you see "step 5 of 10" without reading the transcript.

Where it comes from. An agent writes it with chat_plan: steps with a Markdown description, sub-steps and
a note on what it found. A Claude chat that only keeps its built-in task list (TodoWrite), and an ACP
agent's plan updates, are mirrored in as plain steps (from_todos), so nothing has to change for a chat to
show one. A plan an agent wrote with the tool isn't overwritten by its task list: the richer one wins.

Who owns it. The agent does: it's what the agent means to do. Your changes go to it as a message from you
(channel.human_message), with what you changed, and stay pending until it next writes its plan. The one
thing that doesn't need it is copying a step to the work list, which is yours.

In the chat. A plan beside the list is easy to miss while you read the transcript, so every write that
changes something also adds a "plan" event to the turn (changes): which steps were added, removed,
started, finished, skipped or renamed, and how far sub-steps got. Both apps draw it as a line of its own.

Kept in .mystical/plans/<chat>.json at the main checkout: per chat, it survives a restart, and it's
readable without the store. Bridge-owned, so the MYSTICAL panel can't clear it. Stdlib only.
"""

import json
import os
import re
import sys
import threading
import time

from bridge import chat_images

STATUSES = ("pending", "in_progress", "completed", "skipped")
MAX_STEPS, MAX_SUBSTEPS, MAX_TITLE, MAX_DETAIL, MAX_NOTE = 60, 20, 200, 4000, 1000
_lock = threading.RLock()


class Refused(ValueError):
    """A sentence for whoever asked: what to change."""


def _path(root: str, chat: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", chat or ""):
        raise Refused("No such chat.")
    return os.path.join(root, ".mystical", "plans", f"{chat}.json")


def load(root: str, chat: str) -> dict:
    try:
        with open(_path(root, chat), encoding="utf-8") as f:
            d = json.load(f)
    except (OSError, ValueError):
        d = {}
    d = d if isinstance(d, dict) else {}
    return {"steps": list(d.get("steps") or []), "pending": list(d.get("pending") or []), "next": int(d.get("next") or 1),
            "source": d.get("source") or "", "started": d.get("started"), "updated": d.get("updated")}


def _save(root: str, chat: str, data: dict) -> None:
    from bridge import devserver
    devserver.mystical_dir(root)
    path = _path(root, chat)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = f"{path}.{threading.get_ident()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path)


def _text(v, n: int) -> str:
    return str(v or "").strip()[:n]


def _status(v, default: str = "pending") -> str:
    v = str(v or "").strip().lower().replace(" ", "_").replace("-", "_")
    v = {"done": "completed", "complete": "completed", "doing": "in_progress", "active": "in_progress", "todo": "pending", "skip": "skipped"}.get(v, v)
    return v if v in STATUSES else default


def _substeps(raw) -> list:
    if not isinstance(raw, list):
        return []
    out = []
    for s in raw[:MAX_SUBSTEPS]:
        s = s if isinstance(s, dict) else {"title": s}
        title = " ".join(_text(s.get("title") or s.get("content"), MAX_TITLE).split())
        if title:
            out.append({"title": title, "status": _status(s.get("status"))})
    return out


def _times(step: dict, old: "dict | None", now: float) -> None:
    """When it started and finished, carried over from the step it replaces."""
    for k in ("started_at", "done_at"):
        if old and old.get(k) and k not in step:
            step[k] = old[k]
    if step["status"] == "in_progress" and not step.get("started_at"):
        step["started_at"] = now
    if step["status"] in ("completed", "skipped") and not step.get("done_at"):
        step["done_at"] = now
    if step["status"] in ("pending", "in_progress"):
        step.pop("done_at", None)


def _match(old: list, row: dict, taken: set) -> "dict | None":
    if row.get("id"):
        hit = next((s for s in old if s["id"] == str(row["id"]) and s["id"] not in taken), None)
        if hit:
            return hit
    title = " ".join(_text(row.get("title"), MAX_TITLE).split()).lower()
    return next((s for s in old if s["title"].lower() == title and s["id"] not in taken), None)


MAX_CHANGES = 12


def changes(old: list, new: list) -> list:
    """What a write did to the plan, step by step, in the plan's order. Only what you'd notice: a
    status, a title, a step coming or going, sub-steps done. Not a description's every word."""
    before = {s["id"]: s for s in old}
    out = []
    for n, s in enumerate(new, 1):
        o = before.get(s["id"])
        row = {"n": n, "id": s["id"], "title": s["title"]}
        if not o:
            out.append({**row, "kind": "added", "status": s["status"]})
            continue
        if o["title"] != s["title"]:
            out.append({**row, "kind": "renamed", "was": o["title"]})
        if o["status"] != s["status"]:
            kind = {"completed": "done", "in_progress": "started", "skipped": "skipped"}.get(s["status"], "reopened")
            out.append({**row, "kind": kind})
        subs, was = s.get("substeps") or [], o.get("substeps") or []
        done = sum(x["status"] in ("completed", "skipped") for x in subs)
        if subs and (done != sum(x["status"] in ("completed", "skipped") for x in was) or len(subs) != len(was)) and o["status"] == s["status"]:
            out.append({**row, "kind": "substeps", "done": done, "of": len(subs)})
        elif (o.get("detail") or "") != (s.get("detail") or "") and o["status"] == s["status"] and o["title"] == s["title"]:
            out.append({**row, "kind": "edited"})
    kept = {s["id"] for s in new}
    out += [{"n": None, "id": s["id"], "title": s["title"], "kind": "removed"} for s in old if s["id"] not in kept]
    return out


def event(old: list, data: dict) -> "dict | None":
    """The transcript's line for a write, or None when nothing a reader would notice changed."""
    steps = data["steps"]
    rows = changes(old, steps)
    if not rows:
        return None
    first = not old
    return {"type": "plan", "first": first, "done": sum(s["status"] in ("completed", "skipped") for s in steps), "total": len(steps),
            "steps": [s["title"] for s in steps][:30] if first else [], "changes": [] if first else rows[:MAX_CHANGES],
            "more": 0 if first else max(0, len(rows) - MAX_CHANGES)}


def _tell(job, old: list, data: "dict | None") -> None:
    if job is None or not data:
        return
    try:
        ev = event(old, data)
        if ev:
            job.add(ev)
    except Exception as e:  # noqa: BLE001 - the plan is saved; only its line in the chat is missing
        print(f"[chatplan] event: {e!r}", file=sys.stderr)


def _write(root: str, chat: str, rows: list, source: str, keep_rich: bool = False) -> "dict | None":
    """The plan becomes `rows`. Steps it names, by id or title, keep their id and times."""
    if not isinstance(rows, list):
        raise Refused("Give the steps as a list.")
    now = time.time()
    with _lock:
        data = load(root, chat)
        if keep_rich and data["source"] == "tool":
            return None
        old, steps, taken = data["steps"], [], set()
        for row in rows[:MAX_STEPS]:
            row = row if isinstance(row, dict) else {"title": row}
            title = " ".join(_text(row.get("title") or row.get("content"), MAX_TITLE).split())
            if not title:
                continue
            prev = _match(old, row, taken)
            step = {"id": prev["id"] if prev else f"s{data['next']}", "title": title, "status": _status(row.get("status")),
                    "detail": _text(row.get("detail"), MAX_DETAIL) if "detail" in row else (prev or {}).get("detail", ""),
                    "note": _text(row.get("note"), MAX_NOTE) if "note" in row else (prev or {}).get("note", ""),
                    "substeps": _substeps(row.get("substeps")) if "substeps" in row else (prev or {}).get("substeps", [])}
            if not prev:
                data["next"] += 1
            taken.add(step["id"])
            _times(step, prev, now)
            steps.append(step)
        if rows and not steps:
            raise Refused("Every step needs a title.")
        data.update(steps=steps, source=source, updated=now, pending=[], started=data["started"] or (now if steps else None))
        _save(root, chat, data)
        return data


def _update(root: str, chat: str, a: dict) -> dict:
    sid = str(a.get("id") or "")
    with _lock:
        data = load(root, chat)
        step = next((s for s in data["steps"] if s["id"] == sid), None)
        if not step:
            raise Refused(f"No step is called {sid}. Read the plan for the ids.")
        if "title" in a and _text(a["title"], MAX_TITLE):
            step["title"] = " ".join(_text(a["title"], MAX_TITLE).split())
        if "status" in a:
            step["status"] = _status(a["status"], step["status"])
        for k, n in (("detail", MAX_DETAIL), ("note", MAX_NOTE)):
            if k in a:
                step[k] = _text(a[k], n)
        if "substeps" in a:
            step["substeps"] = _substeps(a["substeps"])
        _times(step, None, time.time())
        data.update(source="tool", updated=time.time(), pending=[])
        _save(root, chat, data)
        return data


def briefly(data: dict) -> str:
    if not data["steps"]:
        return "No plan yet."
    mark = {"completed": "x", "in_progress": ">", "skipped": "-", "pending": " "}
    out = []
    for s in data["steps"]:
        out.append(f"[{mark[s['status']]}] {s['id']} {s['title']}" + (f"\n    note: {s['note']}" if s.get("note") else ""))
        out += [f"    [{mark[x['status']]}] {x['title']}" for x in s.get("substeps") or []]
    return "\n".join(out)


def _root(s: dict) -> str:
    root = chat_images.root_of(s.get("work_cwd") if s.get("work_cwd") and os.path.isdir(s["work_cwd"]) else s.get("cwd"))
    if not root:
        raise Refused("This chat has no project folder.")
    return root


def tool(s: dict, a: dict, job=None) -> str:
    """chat_plan, for a chat's main agent. With the turn's `job`, what changed goes in the chat too."""
    root, action = _root(s), str(a.get("action") or "read")
    if action == "read":
        return briefly(load(root, s["id"]))
    old = load(root, s["id"])["steps"]
    if action == "set":
        data = _write(root, s["id"], a.get("steps"), "tool")
        _tell(job, old, data)
        return "Plan saved. The user sees it in the Work list, and its changes in the chat.\n\n" + briefly(data)
    if action == "update":
        data = _update(root, s["id"], a)
        _tell(job, old, data)
        return "Updated.\n\n" + briefly(data)
    raise Refused("action must be read, set or update.")


def from_todos(session_id: "str | None", todos: list, job=None) -> None:
    """An agent's built-in task list, mirrored in as plain steps. Never raises into a turn."""
    try:
        from bridge import experimental, store
        if not session_id or not experimental.enabled():
            return
        s = store.get_session(session_id)
        if not s or s.get("parent_session"):
            return
        rows = [{"title": t.get("content") or t.get("activeForm"), "status": t.get("status")} for t in todos if isinstance(t, dict)]
        root = _root(s)
        old = load(root, s["id"])["steps"]
        _tell(job, old, _write(root, s["id"], rows, "todos", keep_rich=True))
    except Exception as e:  # noqa: BLE001
        print(f"[chatplan] todos: {e!r}", file=sys.stderr)


def view(root: str, chat: "str | None") -> "dict | None":
    if not chat:
        return None
    try:
        data = load(root, chat)
    except Refused:
        return None
    return data if data["steps"] or data["pending"] else None


# ------- your changes -------------------------------------------------------------

def _step(data: dict, sid: str) -> dict:
    step = next((s for s in data["steps"] if s["id"] == str(sid)), None)
    if not step:
        raise Refused("That step is gone. The agent may have rewritten its plan.")
    return step


def _bullets(rows: list) -> str:
    return "\n".join(f"- {r['title']}" + (" (done)" if r.get("status") == "completed" else "") for r in rows)


def message(data: dict, kind: str, body: dict) -> "tuple[str, str]":
    """(what the agent is told, what the panel says is pending)."""
    why = _text(body.get("why"), 2000)
    tail = (f"\n\nWhy: {why}" if why else "") + "\n\nUpdate your plan to match, with chat_plan or your task list, then carry on."
    if kind == "whole":
        text = _text(body.get("text"), 4000)
        if not text:
            raise Refused("Say what to change.")
        return f"About your plan: {text}{tail}", text[:200]
    step = _step(data, body.get("step"))
    head = f'About step {step["id"]} of your plan, "{step["title"]}"'
    if kind == "change":
        title = " ".join(_text(body.get("title"), MAX_TITLE).split()) or step["title"]
        detail = _text(body.get("detail"), MAX_DETAIL)
        subs = _substeps(body.get("substeps"))
        parts = [f"{head}: change it to read as follows.", f"Step: {title}"]
        if detail != (step.get("detail") or ""):
            parts.append(f"Description:\n{detail or '(none)'}")
        if [x["title"] for x in subs] != [x["title"] for x in step.get("substeps") or []]:
            parts.append("Sub-steps:\n" + (_bullets(subs) or "(none)"))
        changed = []
        if title != step["title"]:
            changed.append(f"title: {title}")
        if detail != (step.get("detail") or ""):
            changed.append("description")
        added = [x["title"] for x in subs if x["title"] not in {y["title"] for y in step.get("substeps") or []}]
        gone = [x["title"] for x in step.get("substeps") or [] if x["title"] not in {y["title"] for y in subs}]
        changed += [f"add a sub-step: {t}" for t in added] + [f"drop a sub-step: {t}" for t in gone]
        if len(subs) == len(step.get("substeps") or []) and not added and not gone and [x["title"] for x in subs] != [x["title"] for x in step.get("substeps") or []]:
            changed.append("reorder sub-steps")
        if not changed and not why:
            raise Refused("Nothing changed.")
        return "\n\n".join(parts) + tail, "; ".join(changed) or "see why"
    if kind == "ask":
        q = _text(body.get("text"), 2000)
        if not q:
            raise Refused("Say what you'd like to know.")
        return f"{head}: {q}\n\nAnswer, and if it changes the plan, update it.", f"asked: {q[:160]}"
    if kind == "sooner":
        return f"{head}: do this one next, before the steps still ahead of it." + tail, "do it sooner"
    if kind == "skip":
        return f"{head}: skip it." + tail, "skip it"
    raise Refused("No such change.")


def change(root: str, chat: dict, kind: str, body: dict) -> dict:
    """Your change, sent to the agent. Pending until it next writes its plan."""
    from bridge import channel
    with _lock:
        data = load(root, chat["id"])
        text, summary = message(data, kind, body)
        channel.human_message(chat, channel.MAIN, text)
        data["pending"] = (data["pending"] + [{"at": time.time(), "step": str(body.get("step") or ""), "summary": summary}])[-20:]
        _save(root, chat["id"], data)
        return data


def to_task(root: str, chat: dict, sid: str) -> dict:
    """A copy on the project's work list. Yours to make, so the agent isn't told."""
    from bridge import worklist
    data = load(root, chat["id"])
    step = _step(data, sid)
    detail = step.get("detail") or ""
    if step.get("substeps"):
        detail = (detail + "\n\n" if detail else "") + _bullets(step["substeps"])
    return worklist.add(root, [{"title": step["title"], "detail": detail}], chat["id"])[0]


def api(path: str, body: dict, root: "str | None", chat: "dict | None") -> "tuple[dict, int]":
    """POST worklist/plan/*"""
    if not root or not chat:
        return {"error": "Open a chat: a plan is a chat's."}, 400
    kind = path.rsplit("/", 1)[-1]
    try:
        if kind == "task":
            item = to_task(root, chat, str(body.get("step") or ""))
            return {"plan": view(root, chat["id"]), "task": item["id"]}, 200
        if kind in ("whole", "change", "ask", "sooner", "skip"):
            change(root, chat, kind, body)
        else:
            return {"error": "No such route."}, 404
    except Refused as e:
        return {"error": str(e)}, 400
    except OSError as e:
        return {"error": f"Couldn't save it: {e}"}, 500
    return {"plan": view(root, chat["id"])}, 200
