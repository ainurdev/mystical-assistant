"""Spin-offs: work a chat turned up and isn't doing, each item started in its own project's session.

GLOSSARY: Spin-off, Spin-off card; ADR 0007. A turn that finds work for other projects (Sentry issues
across orgs, a bug in another repo, a plan across repos) or a list of separate items calls spin_off.
The card it leaves under the reply is an offer that stays in the chat, never an Ask. Only your tap
files a row as a Task on its own project's work list (bridge/worklist.py): PARK files it, START files
it and opens its session there on its flow. The taps are the dashboard's (its token), the Mini App's
and Telegram's Start all. Item text comes from Sentry, trackers and other people's repos, which anyone
can write into, so no text can set work going: the rule the work list keeps.

The card is drawn from what the tool stored (title, brief, flow, sources, after, project), never from
the reply's words. A row goes to the project whose folder, remote or name the agent gave; nothing maps
Sentry to folders, so a row nobody could place waits for you to pick. You can change a row's project
and flow before you tap. A row whose source is on a work list already is a repeat: it links there, has
no tick, and START passes it by. A GitHub repo with no checkout here offers Clone & start, only when one
of your own accounts or orgs owns it, as a cloned repo's CLAUDE.md steers the agent that runs in it;
the row starts unticked, and Telegram's Start all never clones.

A chain across repos (`after`) starts its later rows by themselves once the earlier one is done:
worklist's armed Tasks, with the blocker in another project's list. The blocker is the earlier row's
Task, or the Task its repeat links to; a row after one that is still to be cloned waits for that
clone, and the phone's Start all leaves it, as it leaves its blocker. A later row is never started
unchained: ticked without its earlier row (one that hasn't gone), the tap is refused, and when the
earlier one fails to go, the later one stays on the card saying so.

Kept in the bridge's state folder, one file per chat that offered cards (spinoffs/<session>.json): a chat
with no project has cards too. A row keeps only which Task it became; that Task's own list says what
became of it (view). A clone runs in a thread of this process, so one a restart cut off reads as failed
and can be tried again. Stdlib only.
shortcut: the card files and their locks are never pruned; they are small, one per chat that offered any.
"""

import json
import os
import re
import subprocess
import sys
import threading
import time
import uuid

from bridge import config, store, worklist

FLOWS = ("fix", "build", "design")
MAX_ROWS, MAX_SOURCES = 50, 20
_OWNERS_TTL = 600.0
_GITHUB = re.compile(r"github\.com[/:]([\w.-]+)/([\w.-]+?)(?:\.git)?/?$", re.I)
_SLUG = re.compile(r"^([\w.-]+)/([\w.-]+)$")
_BOOT = uuid.uuid4().hex   # this process: a clone marked by another one was cut off by a restart
_locks: dict = {}   # one per chat: a tap launching sessions holds up no other chat's turn (pop_line)
_owners_cache: "tuple[float, set] | None" = None


class Refused(ValueError):
    """A sentence for whoever asked: what to change."""


def _said(text: str, error: bool = False) -> dict:
    return {"content": [{"type": "text", "text": text}], **({"isError": True} if error else {})}


# ------- the cards a chat offered ------------------------------------------------

def _path(sid: str) -> str:
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,64}", sid or ""):
        raise Refused("No such chat.")
    return os.path.join(os.path.dirname(config.BRIDGE_DB), "spinoffs", f"{sid}.json")


def _load(sid: str) -> dict:
    try:
        with open(_path(sid), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        data = {}
    data = data if isinstance(data, dict) else {}
    return {"next": int(data.get("next") or 1), "cards": list(data.get("cards") or []), "told": list(data.get("told") or [])}


def _lock(sid: str):
    return _locks.setdefault(sid, threading.RLock())


def _mutate(sid: str, fn):
    """Read, change, write, as one step. `fn` raising leaves the file alone."""
    with _lock(sid):
        data = _load(sid)
        out = fn(data)
        path = _path(sid)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        tmp = f"{path}.{threading.get_ident()}.tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(data, f, ensure_ascii=False, indent=1)
        os.replace(tmp, path)
        return out


# ------- where a row goes ----------------------------------------------------------

def _roots() -> list:
    """(rel, root) of every project here, as the PROJECTS tree lists them."""
    from bridge import browser
    out = []
    for rel in browser.list_projects():
        root = os.path.realpath(os.path.join(config.BASE_PATH, rel.lstrip("/")))
        if os.path.isdir(root):
            out.append((rel, root))
    return out


def _owners() -> set:
    """Your GitHub accounts and their orgs, lowercased: who may own a repo Clone & start clones.
    `gh auth status` fails when any one login is broken, and still lists the rest.
    shortcut: the active gh account's orgs only; a second signed-in account's orgs are missed,
    list them per account if that bites."""
    global _owners_cache
    if _owners_cache and time.time() - _owners_cache[0] < _OWNERS_TTL:
        return _owners_cache[1]

    def gh(*args: str, any_rc: bool = False) -> str:
        try:
            p = subprocess.run(["gh", *args], capture_output=True, text=True, timeout=15, stdin=subprocess.DEVNULL)
        except (OSError, subprocess.SubprocessError):
            return ""
        return f"{p.stdout}\n{p.stderr}" if any_rc else p.stdout if p.returncode == 0 else ""
    found = re.findall(r"account (\S+)", gh("auth", "status", any_rc=True)) + gh("api", "user/orgs", "--jq", ".[].login").split()
    _owners_cache = (time.time(), {o.lower() for o in found if o})
    return _owners_cache[1]


def _slug(hint: str) -> "tuple[str, str] | None":
    m = _GITHUB.search(hint) or _SLUG.match(hint.strip("/"))
    return (m.group(1), m.group(2).removesuffix(".git")) if m else None


def _place(hint: str, roots: list, remotes: dict) -> "tuple[str, str]":
    """(the project's rel or "", a GitHub URL to clone or "") for where the agent said a row goes:
    a project's folder by key, path or name, or a repo by a remote of its checkout. `remotes` keeps
    each checkout's owner/repos for the rest of the card: one git call per project, not per row."""
    from bridge import github
    h = " ".join(str(hint or "").split())
    if not h:
        return "", ""
    want = h.rstrip("/").lower()
    for rel, root in roots:
        if want in (rel.lower(), rel.lower().lstrip("/"), root.lower()):
            return rel, ""
    slug = _slug(h)
    if slug:
        for rel, root in roots:
            if root not in remotes:
                remotes[root] = {x.lower() for x in github.remote_slugs(root)}
            if f"{slug[0]}/{slug[1]}".lower() in remotes[root]:
                return rel, ""
    name = re.split(r"[/:]", want.removesuffix(".git"))[-1]
    named = [rel for rel, root in roots if os.path.basename(root).lower() == name]
    if len(named) == 1:
        return named[0], ""
    if slug and slug[0].lower() in _owners():
        return "", f"https://github.com/{slug[0]}/{slug[1]}"
    return "", ""


def _repeat(sources: list, roots: list) -> "dict | None":
    """{root, id, project} of the Task a work list here already has for one of these sources."""
    if sources:
        for rel, root in roots:
            item = worklist.holding(root, sources)
            if item:
                return {"root": root, "id": item["id"], "project": rel}
    return None


# ------- the tool ------------------------------------------------------------------

def _rows(raw) -> list:
    if not isinstance(raw, list) or not raw:
        raise Refused("Give the items as a list, each with a title.")
    if len(raw) > MAX_ROWS:
        raise Refused(f"A card holds {MAX_ROWS} items.")
    out = []
    for n, r in enumerate(raw, 1):
        r = r if isinstance(r, dict) else {"title": r}
        title = " ".join(str(r.get("title") or "").split())[:worklist.MAX_TITLE]
        if not title:
            raise Refused(f"Item {n} needs a title.")
        after = _n(r.get("after")) if r.get("after") else 0
        if after and not 0 < after < n:
            raise Refused(f"Item {n}'s after must name an earlier item, 1 to {n - 1}.")
        raw_src = r.get("sources") if isinstance(r.get("sources"), list) else []
        sources = [x for x in (worklist._source(x) for x in raw_src[:MAX_SOURCES]) if x]   # noqa: SLF001
        out.append({"n": n, "title": title, "brief": str(r.get("brief") or "").strip()[:worklist.MAX_DETAIL],
                    "flow": r.get("flow") if r.get("flow") in FLOWS else "build", "sources": sources, "after": after,
                    "hint": " ".join(str(r.get("project") or "").split())[:300]})
    return out


def offer(s: dict, job, a: dict) -> dict:
    """spin_off: the card under this turn's reply. Rows are checked and placed; nothing starts."""
    if job is None:
        return _said("No turn is running to offer this in.", error=True)
    try:
        made = _rows(a.get("items"))
    except Refused as e:
        return _said(str(e), error=True)
    roots, remotes = _roots(), {}
    for row in made:
        row["project"], row["clone"] = _place(row["hint"], roots, remotes)
        row["repeat"] = _repeat(row["sources"], roots)

    def put(data: dict) -> "tuple[str, bool]":
        card = next((c for c in data["cards"] if c.get("job") == job.id), None)
        if card:     # called again in the same turn: the card is the last list
            card["rows"] = made
            return card["id"], False
        cid = f"c{data['next']}"
        data["next"] += 1
        data["cards"].append({"id": cid, "job": job.id, "at": time.time(), "rows": made})
        return cid, True
    cid, new = _mutate(s["id"], put)
    if new:
        job.add({"type": "spinoffs", "card": cid})
    notes = [f"Item {r['n']} is already on the work list of {r['repeat']['project']}, as {r['repeat']['id']}: the card links there."
             for r in made if r["repeat"]]
    notes += [f"Item {r['n']} has no checkout here: the user can clone {r['clone']}." for r in made if r["clone"] and not r["repeat"]]
    lost = [str(r["n"]) for r in made if not (r["project"] or r["clone"] or r["repeat"])]
    if lost:
        notes.append(f"No project here matches item{'s' if len(lost) > 1 else ''} {', '.join(lost)}: the user picks one.")
    return _said(f"The card is under your reply: {len(made)} item{'s' if len(made) > 1 else ''}. " + " ".join(notes)
                 + (" " if notes else "") + "Lead your reply with one line and don't list the items again: the card is the "
                 "list. Only the user starts them, each in its own session.")


# ------- your taps -------------------------------------------------------------------

def _n(raw) -> int:
    try:
        return int(raw)
    except (TypeError, ValueError):
        return 0


def _card(data: dict, cid) -> dict:
    card = next((c for c in data["cards"] if c["id"] == str(cid)), None)
    if not card:
        raise Refused("No such card.")
    return card


def _row(card: dict, n) -> "dict | None":
    return next((r for r in card["rows"] if r["n"] == _n(n)), None)


def _cloning(row: dict) -> bool:
    """A clone this process is running for the row; one an earlier bridge started was cut off."""
    return row.get("state") == "cloning" and row.get("boot") == _BOOT


def _task(ref: "dict | None", lists: dict) -> "dict | None":
    """The Task a row's `task` or `repeat` names, read off its list now: None once it's gone from it.
    `lists` keeps each list read for the rest of the card."""
    if not ref:
        return None
    if ref["root"] not in lists:
        lists[ref["root"]] = {i["id"]: i for i in worklist.load(ref["root"])["items"]}
    return lists[ref["root"]].get(ref["id"])


def _blocker(card: dict, row: dict, lists: "dict | None" = None) -> "dict | None":
    """{root, id} of the Task the row waits on: the earlier row's own, or the one its repeat links to,
    while it is on its list."""
    before = _row(card, row.get("after")) if row.get("after") else None
    lists = {} if lists is None else lists
    ref = before and next((r for r in (before.get("task"), before.get("repeat")) if _task(r, lists)), None)
    return {"root": ref["root"], "id": ref["id"]} if ref else None


def _keys(row: dict) -> list:
    return [s.get("ref") or s.get("url") for s in row.get("sources") or [] if s.get("ref") or s.get("url")]


def _file(s: dict, card: dict, row: dict, rel: str, root: str, flow: str, start: bool) -> str:
    """The row filed as a Task on `rel`'s list, waiting on its blocker, and started there on `flow`
    when `start`. A row filed already (a start that failed) is started again on its Task. Returns how
    it went: started, waiting, parked or failed (filed, but its session didn't open)."""
    sources = row.get("sources") or []
    if not row.get("task"):
        item = worklist.file(root, {"title": row["title"], "detail": row.get("brief") or "", "source": sources[0] if sources else None},
                             s["id"], {"session": s["id"], "keys": _keys(row)}, sources, _blocker(card, row))
        row["task"] = {"root": root, "id": item["id"], "project": rel}
    row.update(flow=flow, note="", start=start)
    row.pop("state", None)
    if not start:
        return "parked"
    try:
        got = worklist.start(root, row["task"]["id"], flow, s["id"])
    except Exception as e:  # noqa: BLE001 — filed already: the row keeps its Task and says why it didn't start
        row["note"] = f"Didn't start: {e}"
        return "failed"
    return "waiting" if got.get("armed") else "started" if got.get("session_id") else "failed"


def _tell(data: dict, row: dict, rel: str, how: str) -> None:
    data["told"].append({"title": row["title"], "project": rel, "flow": row["flow"], "how": how})


def tap(s: dict, cid: str, picks: list, start: bool) -> int:
    """START (start) or PARK the rows you ticked, each on the project and flow you left it on. A row
    goes once; one whose Task left its list since is open again, and one whose start failed is tried
    again on its Task. One whose source reached a work list since the card was offered is a repeat
    now: it is passed by and links there. One that can't go refuses the whole tap before anything is
    filed, as does a row after one that neither went nor is ticked with it. A row after one that
    didn't go stays on the card. Returns how many started or wait for the one before."""
    if not isinstance(picks, list) or not picks:
        raise Refused("Tick at least one row.")
    went = []

    def go(data: dict) -> list:
        card, roots, plan, clones, lists = _card(data, cid), _roots(), [], set(), {}
        for p in sorted((p for p in picks if isinstance(p, dict)), key=lambda p: _n(p.get("n"))):
            row = _row(card, p.get("n"))
            if not row:
                raise Refused(f"The card has no item {p.get('n')}.")
            if row.get("task") and not _task(row["task"], lists):
                row.pop("task")       # removed from its list by hand or by a replace: open again
            if (row.get("task") and _row_view(row, lists)["state"] != "failed") or _cloning(row):
                raise Refused(f"Item {row['n']} has gone to its project already.")
            flow = p.get("flow") or row["flow"]
            if flow not in FLOWS:
                raise Refused("Start it as fix, build or design.")
            if row.get("task"):      # its start failed: tried again where its Task is
                plan.append((row, row["task"]["project"], row["task"]["root"], flow))
                continue
            row["repeat"] = _repeat(row.get("sources") or [], roots)
            if row["repeat"]:
                continue
            if row.get("after") in clones or _cloning(_row(card, row.get("after")) or {}):
                raise Refused(f"Item {row['n']} comes after item {row['after']}, which is cloned first: start it once item {row['after']} has started.")
            if row.get("after") and row["after"] not in {r["n"] for r, *_ in plan} and not _blocker(card, row):
                raise Refused(f"Item {row['n']} comes after item {row['after']}: tick item {row['after']} too.")
            rel = str(p.get("project") or row.get("project") or ("clone" if row.get("clone") else ""))
            if rel == "clone" and row.get("clone"):
                if not start:
                    raise Refused(f"Item {row['n']} has no checkout here: Clone & start it, or pick a project.")
                clones.add(row["n"])
                plan.append((row, rel, "", flow))
                continue
            root = next((r for k, r in roots if k == rel), None)
            if not root:
                raise Refused(f"Pick a project for item {row['n']}.")
            plan.append((row, rel, root, flow))
        for row, rel, root, flow in plan:
            if rel == "clone":
                row.update(state="cloning", boot=_BOOT, flow=flow, note="")
                continue
            if row.get("after") and not row.get("task") and not _blocker(card, row):
                row["note"] = f"Didn't go: item {row['after']}, which it comes after, didn't."
                continue
            try:
                how = _file(s, card, row, rel, root, flow, start)
            except Exception as e:  # noqa: BLE001 — the others still go, this one says why, and the card keeps what went
                print(f"[spinoffs] item {row['n']}: {e!r}", file=sys.stderr)
                row["note"] = f"Didn't go: {e}"
                continue
            _tell(data, row, rel, how)
            if how in ("started", "waiting"):
                went.append(row["n"])
        return [(row["n"], row["clone"], flow) for row, rel, _, flow in plan if rel == "clone"]
    for n, url, flow in _mutate(s["id"], go):
        threading.Thread(target=_clone_then, args=(s, cid, n, url, flow), daemon=True).start()
    return len(went)


def _clone_then(s: dict, cid: str, n: int, url: str, flow: str) -> None:
    """Clone & start: the repo cloned into your projects, then the row filed and started in it."""
    from bridge import browser, newproject
    try:
        slug = _slug(url)
        if not slug or slug[0].lower() not in _owners():
            raise Refused("only repos your own GitHub accounts and orgs own are cloned")
        got = newproject.prepare({"kind": "clone", "url": url})
        if got.get("confirm"):
            raise Refused(got["confirm"][0].get("text") or "it needs your yes first")
        root = worklist.root_of(got["cwd"])
        rel = browser.rel(root)

        def go(data: dict) -> None:
            card = _card(data, cid)
            row = _row(card, n)
            _tell(data, row, rel, _file(s, card, row, rel, root, flow, True))
        _mutate(s["id"], go)
    except Exception as e:  # noqa: BLE001 — said on the row, never raised into a thread
        print(f"[spinoffs] clone of {url}: {e!r}", file=sys.stderr)
        _mutate(s["id"], lambda data: _row(_card(data, cid), n).update(state="failed", note=f"Couldn't clone it: {e}"))


def _startable(card: dict) -> list:
    """The rows the phone's Start all starts: open, placed on a project here, no repeat, and not
    after a row it can't start either. Rows with no checkout stay for the dashboard: the phone never
    clones."""
    lists: dict = {}
    went: list = []
    for r in card["rows"]:
        v = _row_view(r, lists)
        if (r.get("project") and v["state"] == "open" and not v["repeat"]
                and (not r.get("after") or r["after"] in went or _blocker(card, r, lists))):
            went.append(r["n"])
    return went


def start_all(s: dict, cid: str) -> int:
    """The phone's Start all, on each row's guessed flow. Returns how many started or wait for the one
    before; none raises, as a row that turned into a repeat since or failed to start says so on the card."""
    picks = [{"n": n} for n in _startable(_card(_load(s["id"]), cid))]
    if not picks:
        raise Refused("Nothing on the card is left to start.")
    n = tap(s, cid, picks, True)
    if not n:
        raise Refused("None of them started: the card says why.")
    return n


def phone(sid: str, cid: str) -> "tuple[str, int]":
    """The phone's line under a reply with a card, and how many rows its Start all starts."""
    try:
        card = _card(_load(sid), cid)
    except Refused:
        return "", 0
    places = {r.get("project") or r.get("clone") for r in card["rows"]} - {"", None}
    n = len(card["rows"])
    return (f"Spin-offs: {n}" + (f" for {len(places)} project{'s' if len(places) > 1 else ''}" if places else ""),
            len(_startable(card)))


def pop_line(sid: str) -> str:
    """One line for this chat's next prompt naming what you spun off from it since its last turn, so
    its agent doesn't do that work too. Taken off the card file as it's read: said once. Every turn
    asks, so a chat with no cards answers from one stat, and an id no card file can have from none."""
    try:
        if not os.path.isfile(_path(sid)):
            return ""
    except Refused:
        return ""

    def take(data: dict) -> list:
        told, data["told"] = data["told"], []
        return told
    with _lock(sid):
        if not _load(sid)["told"]:
            return ""
        told = _mutate(sid, take)
    how = {"started": "started", "waiting": "waiting for the one before it", "parked": "parked on its work list",
           "failed": "filed on its work list, but its session didn't start"}
    said = "; ".join(f"“{t['title']}” in {worklist.name_of(t['project'])} ({t['flow']}, {how.get(t['how'], t['how'])})" for t in told)
    return f"[mystical] Since your last turn the user spun off from this chat: {said}. Each runs in its own session: don't do it here."


# ------- what the surfaces read ----------------------------------------------------

def _row_view(row: dict, lists: dict) -> dict:
    """A row as the card draws it: what it became read off its Task's list now. One you started whose
    Task is back to todo, neither armed nor in a session, failed to start: its Task's note says why."""
    out = {k: row.get(k) for k in ("n", "title", "brief", "flow", "sources", "after", "project", "clone")}
    out.update(state="open", session="", note=row.get("note") or "", repeat=None)
    rep = _task(row.get("repeat"), lists)
    if rep:
        sess = store.get_session(rep["session_id"]) if rep.get("session_id") else None
        out["repeat"] = {"project": row["repeat"]["project"], "task": rep["id"], "session": rep.get("session_id") or "",
                         "title": (sess or {}).get("title") or rep["title"], "at": rep.get("created")}
    item = _task(row.get("task"), lists)
    if row.get("state") == "cloning" and not _cloning(row):
        out.update(state="failed", note="The clone stopped when the bridge restarted: try again.")
    elif row.get("state") in ("cloning", "failed"):
        out["state"] = row["state"]
    elif item:
        out.update(project=row["task"]["project"], session=item.get("session_id") or "",
                   state="started" if item.get("session_id") else "waiting" if item.get("armed")
                   else "failed" if row.get("start") and item["state"] == "todo" else "parked")
        if out["state"] == "failed":
            out["note"] = out["note"] or item.get("note") or "Its session didn't start."
    return out


def view(sid: str) -> dict:
    """Every card this chat offered, each row as it stands and how many the phone's Start all would
    start, and the chat's own project (`here`)."""
    lists: dict = {}
    return {"cards": [{"id": c["id"], "rows": [_row_view(r, lists) for r in c["rows"]], "startable": len(_startable(c))}
                      for c in _load(sid)["cards"]],
            "here": (store.get_session(sid) or {}).get("project") or ""}


def api(path: str, body: dict, s: "dict | None") -> "tuple[dict, int]":
    """POST spinoffs/*: the card's taps, from a chat already checked as yours."""
    if not s:
        return {"error": "No such chat."}, 404
    if path not in ("spinoffs/start", "spinoffs/park", "spinoffs/start-all"):
        return {"error": "No such route."}, 404
    try:
        if path == "spinoffs/start-all":
            start_all(s, str(body.get("card") or ""))
        else:
            tap(s, str(body.get("card") or ""), body.get("rows"), path == "spinoffs/start")
    except Refused as e:
        return {"error": str(e)}, 400
    return view(s["id"]), 200
