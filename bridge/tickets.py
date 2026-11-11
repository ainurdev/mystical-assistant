"""Ticket sets: Matt Pocock's /to-tickets files, read as a dependency graph.

A feature path's TICKETS step runs Matt's skill, which writes one markdown file per
ticket under `.mystical/tickets/<feature-slug>/<NN>-<slug>.md` in the session's
checkout, beside the SPEC.md its SPEC step wrote (no NN- name, so no ticket). We read
those files as they are (`# NN: Title`, `**Blocked by:** ...`) rather than keep a
second copy of the plan in the DB: the files are what the user and Claude both edit,
so they can't drift.

What the bridge adds is state, in `set.json` beside the ticket files: per ticket
queued/running/done/fix/missing, its branch, worktree, session and base. State is files,
not DB tables, so a set moves with its checkout and a restart loses nothing. A registry
(`ticketsets.json`, beside the DB like waits.json) lists the folders so we can find sets.

Rules the scheduler and the merge follow, decided in the spec:
- At most 3 tickets run at once.
- Branching: a ticket with one blocker starts from that blocker's branch; with several,
  from the first blocker's branch with the rest merged in.
- Nothing merges while building. One merge session handles the whole pass at the end.
- Tickets live in the session's checkout, not the feature worktree.

Blocked-by parsing: `#2`, `02`, `2`, `#02` are all ticket 02; anything else must equal
another ticket's title (trimmed, case-insensitive). "None..." or empty is no blockers.
Several are separated by commas or "and".

Not built: titles containing a comma or " and " can't be referenced by title; use the number.

The scheduler. BUILD (start_build) freezes the graph into set.json at approval, so a
ticket file edited later can't rewire a running set; one deleted or renamed is
`missing` when its turn to start comes, and holds its dependents. A ticket session is
an ordinary session (origin "ticket", "#NN Title") in its own worktree, put on a
one-step `implement` path before its first turn: that way its StepDone lands in
flows.json like any path's, and its typed /implement can't join the FEATURE path
(paths.on_turn_start), whose next station would build a second time. A one-step path
has no next station, so StepDone never starts a flow step there either.

Done means StepDone was called since the ticket last (re)started and its branch has
a commit of its own, merges aside: the merge of a second blocker is not work. Since
StepDone rather than this exact turn: a turn that dies after StepDone is resumed by
the runner, and the resumed turn ends without calling it again. A failed turn the
runner gave up on (a usage limit parks and resumes by itself) and a StepDone with
nothing committed are both `fix`: the slot frees, dependents wait, and the StepDone is
forgotten, so only a new one finishes it. retry() runs it again in the same session,
or with MAX_RUNNING running marks it `retry`, first in line for the next free slot. A
turn that just ends (a question in prose, a Stop) keeps its slot: it is waiting on you.
Nobody watches a ticket session, though, and a turn that ends to wait on a background
command never wakes (the command dies with the turn): a turn that ends done without
StepDone gets a carry-on, at most NUDGES per run, before the slot is left waiting.
The merge session gets the same, and once the carry-ons are spent a `tickets` notice
on that session says it waits on you. Both prompts say to test in the foreground:
with that line no ticket stalled (7 of 7, 2026-11-11), without it the same set's
merge did, and stayed `merging` until someone asked.

A set can span repos (Rivendell beside Mystical): the prompt sends work in another repo
to a worktree on the ticket's branch at the place worktree_path_for gives that repo, so
_repos finds it. A ticket is done when any of its repos has a commit of its own, and
MERGE merges each repo's ticket branches into a branch of the feature's name there.

Never twice: a ticket gets its session_id in set.json before its first turn starts,
tick starts as new only tickets that never had one (`queued`, or `missing` once its
file is back), and it runs one with a session again only when retry() asked (`retry`).
boot() judges what a restart left unheard: a running ticket whose session sits idle,
and isn't parked, ended its turn (or never got one) while nothing listened, and is
judged as at a turn end; one that ended without StepDone keeps its slot and gets the
carry-on its turn end would have brought, unless that turn ended on your Stop. A set
builds once: a finished one would start every ticket
again, so only a new set or one that stopped before building starts. The flow's BUILD
is marked done once the last ticket is, so FLOW shows it running while tickets build
and the step after MERGE is RETRO. One lock serializes tick and every set.json write, since
turn ends arrive on several threads at once; it is held across git and session
creation, which takes seconds only when tickets are starting.

APPROVE BEFORE BUILD (`ticketapprove`) is the user's choice to trust the skill or not:
/to-tickets is meant to quiz the user before it ends, but can skip it. On, start_build
parses and validates the tickets, saves the set as `approve` and stops: no feature
branch, carry or worktree. approve() (the Approve & build tap) does the rest. boot()
and tick() leave an `approve` set alone.
"""

import json
import os
import re
import sys
import threading
import time
from typing import NamedTuple

from bridge import aifeatures, config, flowbranch, git, limits, notices, paths, profiles, state, store


class TicketError(ValueError):
    pass


class Ticket(NamedTuple):
    n: str
    title: str
    path: str
    blocked_by: tuple


_FILE = re.compile(r"\d+-")   # <NN>-<slug>.md
_HEAD = re.compile(r"^#\s+(\d{1,2})\s*:\s*(.+?)\s*$", re.M)
# Label with an optional list marker and bold, colon inside or outside the bold.
_BLOCK = re.compile(r"^[ \t]*(?:[-*+][ \t]+)?(?:\*\*)?blocked by(?:\*\*[ \t]*:|[ \t]*:(?:\*\*)?)[ \t]*(.*?)\s*$",
                    re.M | re.I)
_TAIL = re.compile(r"(?:\.+|\s*\([^)]*\))+\s*$")
_NUM = re.compile(r"^#?(\d{1,2})$")
_ITEM = re.compile(r"^[ \t]*(?:[-*+]|\d+[.)])[ \t]+(?!\[[ xX]\])(.+?)\s*$")   # a checkbox is no ref
_SPLIT = re.compile(r"\s*,\s*|\s+and\s+", re.I)


def parse_dir(folder: str) -> list:
    raw = []   # (n, title, path, refs)
    for name in sorted(os.listdir(folder)):
        if not (name.endswith(".md") and _FILE.match(name)):   # the SPEC.md beside them is no ticket
            continue
        path = os.path.join(folder, name)
        with open(path, encoding="utf-8") as f:
            text = f.read()
        h = _HEAD.search(text)
        if not h:   # silently skipped, a ticket would vanish from the set
            raise TicketError(f"{name} has no '# NN: Title' line")
        b = _BLOCK.search(text)
        val = b.group(1).strip().strip("*").strip() if b else ""
        if b and not val:   # refs may be a list on the lines under the label
            items = []
            for line in text[b.end():].lstrip(" \t").lstrip("\n").split("\n"):
                m = _ITEM.match(line)
                if not m:
                    break
                items.append(m.group(1))
            val = ", ".join(items)
        refs = [] if not val or val.lower().startswith("none") else \
            [r for r in (_TAIL.sub("", x.strip()).strip()
                         for x in _SPLIT.split(re.sub(r"\([^)]*\)", "", val))) if r]
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
    for r in sorted(sets(), key=lambda r: r["created"] if isinstance(r.get("created"), (int, float)) else 0, reverse=True):
        if not isinstance(r.get("folder"), str):
            continue
        st = load(r["folder"])
        if st.get("parent_session") == session_id:
            return {**st, "folder": r["folder"]}
    return None


# --- the scheduler: BUILD, MAX_RUNNING at once ---------------------------------

MAX_RUNNING = 3
_build = threading.RLock()   # tick and every set.json write; re-entered by start_build/after_turn -> tick


def _on() -> bool:
    return paths.on() and aifeatures.enabled("ticketruns")


def _flow_folder(flow_session_id: str, co: str, since: float) -> str:
    """The ticket folder under `co` this flow's turns wrote last, else the newest one."""
    root = os.path.join(co, ".mystical", "tickets")
    mine = [os.path.basename(os.path.dirname(p)) for p in flowbranch.written(flow_session_id, since)
            if os.path.dirname(os.path.dirname(os.path.realpath(p))) == os.path.realpath(root)]
    return os.path.join(root, mine[-1]) if mine else _newest(root, since)


def _newest(root: str, since: float) -> str:
    """The ticket folder under `root` whose newest .md was written last, at or after `since`."""
    best, at = "", since
    try:
        names = os.listdir(root)
    except OSError:
        return ""
    for name in names:
        d = os.path.join(root, name)
        try:
            m = max(os.path.getmtime(os.path.join(d, f)) for f in os.listdir(d) if f.endswith(".md"))
        except (OSError, ValueError):   # not a folder, or no ticket in it
            continue
        if m >= at:
            best, at = d, m
    return best


def start_build(flow_session_id: str, folder: str = "") -> str:
    """BUILD: the ticket folder this flow wrote since its path began (or `folder`,
    a stopped set built again) becomes a set on top of the feature branch,
    and its first tickets start. "" once it is building, else why not; a set that
    can't build stops with a `tickets` notice."""
    sess = store.get_session(flow_session_id) or {}
    flow = paths.get(flow_session_id) or {}
    since = flow.get("at") or 0
    co = flowbranch._checkout(sess)  # noqa: SLF001
    folder = folder or (_flow_folder(flow_session_id, co, since) if co else "")
    if not folder:
        msg = "no ticket files were written since this path began"
        notices.emit("tickets", flow_session_id, body=f"BUILD stopped: {msg}.")
        return msg
    slug = flowbranch.feature_slug(os.path.basename(folder))
    with _build:
        old = load(folder)
        was = old.get("status")
        wait = aifeatures.enabled("ticketapprove")   # APPROVE BEFORE BUILD: stop at the breakdown
        if was not in (None, "stopped", "approve"):
            return f"{slug} is already {was}"
        # flow_at: the flow's path this set builds for, kept when a stopped set builds again;
        # a new path in that session since is left alone (mark_done, advance)
        at = old.get("flow_at", flow.get("at"))
        since = at or 0
        st = {"slug": slug, "parent_session": flow_session_id, "flow_at": at, "checkout": co,
              "feature_branch": "", "feature_checkout": "", "status": "building", "tickets": {}, "merge_session": ""}
        try:
            tks = parse_dir(folder)
            order(tks)
            if not tks:
                raise TicketError(f"no tickets in {folder}")
            if not wait:
                _branch(st, sess, flow_session_id, since)
        except Exception as e:  # noqa: BLE001 — a cycle, a missing blocker or git: nothing starts
            st.update(status="stopped", error=str(e))
            save(folder, st)
            register(folder, sess.get("project") or "", slug)
            notices.emit("tickets", flow_session_id, body=f"BUILD stopped: {e}")
            return str(e)
        st["tickets"] = {t.n: {"status": "queued", "title": t.title, "path": t.path,
                               "blocked_by": list(t.blocked_by), "branch": f"tk/{slug}-{t.n}",
                               "worktree": "", "session_id": "", "base": ""} for t in tks}
        if wait:
            st["status"] = "approve"
        save(folder, st)
        register(folder, sess.get("project") or "", slug)
        if not wait:
            tick(folder)
    return ""


def _branch(st: dict, sess: dict, flow_session_id: str, since) -> None:
    """The feature branch and what the flow wrote so far carried onto it."""
    st["feature_branch"], st["feature_checkout"] = flowbranch.ensure_feature_branch(sess, st["slug"])
    flowbranch.carry_and_commit(st["checkout"], st["feature_checkout"],
                                flowbranch.flow_files(flow_session_id, since), st["slug"])


def approve(folder: str) -> str:
    """The user's tap on a set waiting in `approve`: branch, carry, then build as
    start_build would have. "" once building, else why not."""
    with _build:
        st = load(folder)
        if st.get("status") != "approve":
            return f"{st.get('slug') or 'the set'} is already {st.get('status')}"
        sid = st["parent_session"]
        try:
            _branch(st, store.get_session(sid) or {}, sid, st.get("flow_at") or 0)
        except Exception as e:  # noqa: BLE001 — git: nothing starts
            st.update(status="stopped", error=str(e))
            save(folder, st)
            notices.emit("tickets", sid, body=f"BUILD stopped: {e}")
            return str(e)
        st["status"] = "building"
        save(folder, st)
        tick(folder)
    return ""


_FOREGROUND = " Run tests in the foreground: a background command dies when your turn ends."


def _elsewhere(st: dict, n: str) -> str:
    """Where a ticket's work in another repo goes: a worktree at the place
    worktree_path_for gives that repo, on this ticket's branch name, so _repos finds it."""
    t = st["tickets"][n]
    base = ", ".join(st["tickets"][b]["branch"] for b in t["blocked_by"])
    return (f"\nIf the ticket needs another repo, work there in a worktree at "
            f"{os.path.join(config.BASE_PATH, '.worktrees', '<repo>', git.slug(t['branch']))} on branch {t['branch']} "
            + (f"(start from {base} there if it exists, else from that repo's up-to-date main)"
               if base else "(start from that repo's up-to-date main)")
            + " and commit there too." + _FOREGROUND)


def _prompt(st: dict, n: str, clash: "list | None" = None) -> str:
    t = st["tickets"][n]
    return (f"/mattpocock-skills:implement {t['path']}\n\nThis is ticket #{n} of {st['slug']}. "
            f"Work on branch {t['branch']} in this checkout and commit there. "
            "When it is done and the tests pass, call StepDone." + _elsewhere(st, n)
            + (f"\nFirst resolve the merge of {', '.join(clash)} left in this checkout." if clash else ""))


def _again(st: dict, n: str) -> str:
    """A retry's prompt. With no /command in front, the paths pack would have Claude
    pick a path for it, hence the pack's own "No path" line first."""
    t = st["tickets"][n]
    return ("No path for this message.\n\n"
            f"Try this ticket again: {t['path']}\n"
            f"Work on branch {t['branch']} in this checkout and commit there. "
            "When it is done and the tests pass, call StepDone." + _elsewhere(st, n))


def _one_step(sid: str, st: dict, n: str) -> None:
    """Ticket n's session on a fresh one-step `implement` path: StepDone counts from now."""
    paths.set_path(sid, "one", f"ticket #{n} of {st['slug']}", "rule", skill="implement")


def _settle(st: dict, n: str, status: str) -> None:
    """Ticket n is `status` now. A fix forgets its StepDone, so a later turn that
    commits half the work can't finish it, and start its dependents, without a new one."""
    t = st["tickets"][n]
    t["status"] = status
    if status == "fix" and t.get("session_id"):
        _one_step(t["session_id"], st, n)


def _start_ticket(folder: str, st: dict, n: str) -> None:
    """Worktree, session and first turn for ticket n: running after, or fix when it
    couldn't start. Base: the feature branch, its one blocker's branch, or with
    several the first's with the others merged in (--no-ff); a clash is its first job."""
    from bridge import runner  # local import: runner<->tickets cycle
    t = st["tickets"][n]
    try:
        parent = store.get_session(st["parent_session"])
        if not parent:
            raise RuntimeError("its flow session is gone")
        main = git.main_checkout(st["feature_checkout"])
        blockers = [st["tickets"][b]["branch"] for b in t["blocked_by"]]
        t["base"] = blockers[0] if blockers else st["feature_branch"]
        clash: list = []
        wt = next((w["path"] for w in git.worktrees(main)
                   if w["branch"] == t["branch"] and os.path.isdir(w["path"])), "")
        if not wt:   # a branch from an earlier run of this set is reused, never remade
            wt = git.worktree_path_for(main, t["branch"], free=True)
            os.makedirs(os.path.dirname(wt), exist_ok=True)
            new = t["branch"] not in git.branches(main)
            ok, out = git.worktree_add(main, wt, t["branch"], start=t["base"] if new else "", create=new)
            if not ok:
                raise RuntimeError(f"worktree failed: {out}")
            git.copy_env(main, wt)
            for i, b in enumerate(blockers[1:] if new else []):
                if git._run(wt, "merge", "--no-ff", "--no-edit", b, timeout=60)[0] != 0:  # noqa: SLF001
                    clash = blockers[1 + i:]   # left mid-merge; the rest come after it
                    break
        project = parent.get("project") or ""
        pid = profiles.claude_default(project)   # Claude, never an agent: the steps are Claude skills
        s = store.create_session(parent["chat_id"], project, origin="ticket", cwd=wt,
                                 permission_mode=None if pid else config.NEW_SESSION_PERMISSION_MODE,
                                 profile_id=pid)
        store.rename(s["id"], f"#{n} {t['title']}")
        _one_step(s["id"], st, n)
        t.update(status="running", worktree=wt, session_id=s["id"], nudges=0)
        save(folder, st)   # before the turn: from here on a restart never starts it again
        if runner.start_streaming_job(parent["chat_id"], _prompt(st, n, clash), [], project=wt,
                                      session_id=s["id"], origin="ticket") is None:
            raise RuntimeError("the bridge refused the run")
    except Exception as e:  # noqa: BLE001 — one ticket failing to start never stops the others
        print(f"[tickets] #{n} of {st['slug']} didn't start: {e}", file=sys.stderr)
        t["status"] = "fix"
    save(folder, st)


def tick(folder: str) -> None:
    """Start ready tickets, lowest number first, until MAX_RUNNING run, and MERGE once
    every one is done. Only while SKILL PATHS and TICKETS are on: switched off,
    running tickets finish and nothing new starts."""
    with _build:
        if state.shutting_down or not _on():
            return
        st = load(folder)
        tks = st.get("tickets") or {}
        if st.get("status") != "building" or not tks:
            return
        for n in sorted(tks, key=lambda k: (tks[k]["status"] != "retry", k)):   # a retry was promised the next slot
            if sum(t["status"] == "running" for t in tks.values()) >= MAX_RUNNING:
                break
            t = tks[n]
            if t["status"] not in ("queued", "missing", "retry") or \
                    any(tks[b]["status"] != "done" for b in t["blocked_by"]):
                continue
            if t["status"] == "retry":
                _rerun(folder, st, n)
            elif not os.path.isfile(t["path"]):
                t["status"] = "missing"   # deleted or renamed after approval: held, and its dependents
            else:
                _start_ticket(folder, st, n)
        save(folder, st)
        if all(t["status"] == "done" for t in tks.values()):
            # only now: FLOW shows BUILD running while tickets build, and after MERGE comes RETRO
            paths.mark_done(st["parent_session"], "build", st.get("flow_at"))
            start_merge(folder)


def _merge_prompt(st: dict, tks: dict) -> str:
    branches = ", ".join(tks[n]["branch"] for n in order([Ticket(n, "", "", tuple(t["blocked_by"]))
                                                           for n, t in tks.items()]))
    return ("No path for this message.\n\n"   # else the paths pack has Claude pick a path
            f"Merge these branches into {st['feature_branch']}, in this order, each with git merge --no-ff: "
            f"{branches}\nResolve any clash so both tickets' work survives, run the project's full test "
            "suite, fix what breaks, and commit."
            + "".join(f"\nThen in {repo}: merge {', '.join(bs)} into {st['feature_branch']} there the same way, "
                      f"in a worktree on {st['feature_branch']} (start it from that repo's up-to-date main if it "
                      "doesn't exist), and run that repo's tests."
                      for repo, bs in _other_branches(st).items())
            + " Then call StepDone." + _FOREGROUND)


def _other_branches(st: dict) -> dict:
    """repo -> its ticket branches, in dependency order, for the tickets that worked there."""
    tks = st["tickets"]
    out: dict = {}
    for n in order([Ticket(n, "", "", tuple(t["blocked_by"])) for n, t in tks.items()]):
        for repo in tks[n].get("repos") or []:
            out.setdefault(repo, []).append(tks[n]["branch"])
    return out


def start_merge(folder: str) -> None:
    """MERGE: one session merges every ticket branch onto the feature branch. Idempotent:
    `merging` is saved before the session opens, and only a `building` set starts one
    (tick calls this on every later tick and boot too)."""
    from bridge import runner  # local import: runner<->tickets cycle
    with _build:
        st = load(folder)
        if st.get("status") != "building":
            return
        st["status"] = "merging"
        save(folder, st)
        try:
            parent = store.get_session(st["parent_session"])
            if not parent:
                raise RuntimeError("its flow session is gone")
            project = parent.get("project") or ""
            pid = profiles.claude_default(project)   # Claude, never an agent: the steps are Claude skills
            s = store.create_session(parent["chat_id"], project, origin="ticket-merge",
                                     cwd=st["feature_checkout"],
                                     permission_mode=None if pid else config.NEW_SESSION_PERMISSION_MODE,
                                     profile_id=pid)
            store.rename(s["id"], f"Merge {st['slug']}")
            paths.set_path(s["id"], "one", f"merge {st['slug']}", "rule", skill="merge")
            st["merge_session"] = s["id"]
            save(folder, st)   # before the turn: a restart never opens a second merge session
            if runner.start_streaming_job(parent["chat_id"], _merge_prompt(st, st["tickets"]), [],
                                          project=st["feature_checkout"], session_id=s["id"],
                                          origin="ticket-merge") is None:
                raise RuntimeError("the bridge refused the run")
        except Exception as e:  # noqa: BLE001 — the merge didn't start: fix, retry() starts it again
            print(f"[tickets] merge of {st['slug']} didn't start: {e}", file=sys.stderr)
            st["status"] = "fix"
            save(folder, st)


def _merge_turn(job) -> None:
    """The merge session's turn ended (a Stop moves nothing): judged by _merge_end."""
    if not job.interrupted:
        _merge_end(job.store_session_id, job.status, job.chat_id)


def _merge_end(sid: str, status: str, chat_id=None, carry: bool = True) -> None:
    """The merge session's turn ended `status`: StepDone since it started, with every
    ticket branch in, means merged, then the flow goes on to RETRO; an error that isn't
    a parked limit is `fix`; done without StepDone gets a carry-on (_nudge) unless
    `carry` is off (it ended on your Stop); else it waits on you."""
    with _build:
        for r in sets():
            folder = r.get("folder")
            st = load(folder) if isinstance(folder, str) else {}
            if st.get("merge_session") == sid:
                break
        else:
            return
        if st.get("status") != "merging":
            return
        if status == "error":
            if sid in limits.parked():
                return
            st["status"] = "fix"
        elif status == "done" and (paths.get(sid) or {}).get("done"):
            have = _merged(st)   # StepDone alone isn't merged: every branch must be in
            left = [t["branch"] for t in st["tickets"].values() if t["branch"] not in have]
            for repo, bs in _other_branches(st).items():
                there = _merged_in(repo, st["feature_branch"])
                left += [f"{b} in {repo}" for b in bs if b not in there]
            st["status"] = "fix" if left else "merged"
            if left:
                notices.emit("tickets", st["parent_session"], body=f"MERGE called StepDone, but {', '.join(left)} "
                             f"{'is' if len(left) == 1 else 'are'}n't merged into {st['feature_branch']} yet.")
        elif status == "done" and carry:
            _nudge(st, sid, "merge", chat_id)   # the set keeps its merge's count
        else:
            return
        save(folder, st)
    if st["status"] == "merged":
        paths.advance(st["parent_session"], "merge", st.get("flow_at"))


def _merged(st: dict) -> set:
    """The branches the feature branch already holds."""
    return _merged_in(st["feature_checkout"], st["feature_branch"])


def _merged_in(repo: str, branch: str) -> set:
    """The branches `branch` already holds in `repo`; none when it doesn't exist there."""
    rc, out, _ = git._run(repo, "branch", "--merged", branch)  # noqa: SLF001
    return {b.strip().lstrip("*+ ").strip() for b in out.splitlines()} if rc == 0 else set()


def merged_count(st: dict) -> int:
    """How many done tickets' branches the feature branch already holds (a fresh
    branch sits at the feature tip, so it counts as merged to git)."""
    have = _merged(st)
    return sum(t["status"] == "done" and t["branch"] in have for t in (st.get("tickets") or {}).values())


def summaries() -> list:
    """Every registered set, newest first: set.json plus its folder, how many branches
    are merged (one git call per set) and each ticket's session state: running, or
    how its last turn ended."""
    out = []
    for r in sorted(sets(), key=lambda r: r["created"] if isinstance(r.get("created"), (int, float)) else 0,
                    reverse=True):
        folder = r.get("folder")
        st = load(folder) if isinstance(folder, str) else {}
        if not st:
            continue
        for t in (st.get("tickets") or {}).values():
            sid = t.get("session_id")
            t["session"] = ("running" if store.running_turn_id(sid) else
                            (store.last_turn(sid) or {}).get("status") or "") if sid else ""
        try:
            merged = merged_count(st)
        except Exception:  # noqa: BLE001 — a set whose checkout is gone still lists
            merged = 0
        out.append({**st, "folder": folder, "merged": merged})
    return out


def cleanup(folder: str) -> tuple:
    """Remove a merged set's ticket worktrees and branches: (removed, skipped) names.
    Never forces: a branch git calls unmerged, or a worktree with uncommitted work, stays."""
    with _build:
        st = load(folder)
        tks = st.get("tickets") or {}
        if st.get("status") != "merged":
            return [], [t["branch"] for t in tks.values()]
        fc = st["feature_checkout"]   # branch -d judges "merged" against HEAD: the feature branch's
        merged = git._run(fc, "branch", "--merged", st["feature_branch"])[1]  # noqa: SLF001
        merged = {b.strip().lstrip("*+ ").strip() for b in merged.splitlines()}
        removed, skipped = [], []
        have = set(git.branches(fc))
        for t in tks.values():
            b, wt = t["branch"], t.get("worktree") or ""
            if b not in have:
                continue   # an earlier clean-up got it
            if b not in merged:
                skipped.append(b)
                continue
            if wt and os.path.isdir(wt):
                if git._run(wt, "status", "--porcelain")[1].strip():  # noqa: SLF001
                    skipped.append(b)
                    continue
                ok, _ = git.worktree_remove(fc, wt, force=False)
                if not ok:
                    skipped.append(b)
                    continue
            if git._run(fc, "branch", "-d", b)[0] != 0:  # noqa: SLF001
                skipped.append(b)
            else:
                removed.append(b)
        return removed, skipped


def _verdict(st: dict, t: dict, status: str) -> "str | None":
    """done | fix for a ticket whose turn ended `status`; None while it still runs
    or waits on you."""
    sid = t["session_id"]
    if status == "error":
        return None if sid in limits.parked() else "fix"
    if status != "done" or not (paths.get(sid) or {}).get("done"):
        return None
    blockers = [st["tickets"][b]["branch"] for b in t["blocked_by"]]
    t["repos"] = [r for r in _repos(st, t["branch"]) if _own(r, t["branch"], blockers + ["--remotes"])]
    return "done" if _own(st["feature_checkout"], t["branch"], [st["feature_branch"]] + blockers) \
        or t["repos"] else "fix"


def _own(repo: str, branch: str, nots: list) -> bool:
    """`branch` has a commit of its own in `repo`, merges aside. A ref missing there
    (a blocker that never touched that repo) is dropped rather than failing the count."""
    have = [x for x in nots if x.startswith("--") or
            git._run(repo, "rev-parse", "--verify", "-q", f"refs/heads/{x}")[0] == 0]  # noqa: SLF001
    have += [b for b in ("main", "master")
             if git._run(repo, "rev-parse", "--verify", "-q", f"refs/heads/{b}")[0] == 0 and b != branch]  # noqa: SLF001
    rc, out, _ = git._run(repo, "rev-list", "--count", "--no-merges", branch, "--not", *have)  # noqa: SLF001
    return rc == 0 and out.strip() not in ("", "0")


def _repos(st: dict, branch: str) -> list:
    """Other repos this ticket worked in: worktrees on its branch at the place the
    prompt names (<BASE>/.worktrees/<repo>/<branch slug>), each folded to its main checkout.
    shortcut: finds only worktrees at that place; a ticket that branched in a repo's
    main checkout goes unseen, upgrade to asking the session if that happens."""
    root = os.path.join(config.BASE_PATH, ".worktrees")
    home = os.path.realpath(git.main_checkout(st["feature_checkout"]))
    out = []
    try:
        dirs = sorted(os.listdir(root))
    except OSError:
        return []
    for d in dirs:
        wt = os.path.join(root, d, git.slug(branch))
        if not os.path.isdir(wt):
            continue
        main = git.main_checkout(wt)
        if os.path.realpath(main) == home or main in out:
            continue
        if git._run(wt, "rev-parse", "--abbrev-ref", "HEAD")[1].strip() == branch:  # noqa: SLF001
            out.append(main)
    return out


NUDGES = 2   # carry-ons per ticket or merge run before its session is left waiting on you
_NUDGE = ("[mystical] Your turn ended without StepDone. A background command dies when a turn ends, "
          "so anything you were waiting for did not finish: run it again in the foreground, finish the "
          "{} and call StepDone. If you really need the user, say what in one line and stop.")


def _nudge(own: dict, sid: str, what: str, chat_id=None) -> None:
    """A ticket's or the merge's turn ended done without StepDone, and not on your Stop:
    nobody is watching such a session, so most often it ended to wait on a background
    command the turn's end killed. Queue a carry-on, at most NUDGES per run, unless
    something is queued; once they are spent, say once that the session waits on you.
    `own` keeps the count: the ticket, or the set for its merge."""
    from bridge import queue_manager  # local import: heavy module
    if any(i.get("status") in ("queued", "running") for i in queue_manager.snapshot(sid).get("items") or []):
        return
    n = own.get("nudges", 0)
    if n > NUDGES:
        return   # said already
    own["nudges"] = n + 1
    if n == NUDGES:
        notices.emit("tickets", sid, body=f"Told to carry on {NUDGES} times and still not finished: "
                                          f"this {what} waits on you.")
        return
    sess = store.get_session(sid) or {}
    text = _NUDGE.format(what)
    queue_manager.enqueue(
        sid, text=text, prompt=text, images=[], model=None, effort=None,
        permission_mode=None, width=None, sel=[], surface="carry-on",
        chat_id=chat_id if chat_id is not None else sess.get("chat_id"),
        project=sess.get("project") or "")


def _stopped(sid: str) -> bool:
    """The session's last turn ended on your Stop: the runner marks it with a `stopped`
    event. For boot, which has no job to ask."""
    return any(e.get("type") == "stopped"
               for e in store.events_of_turn(sid, store.latest_turn_id(sid) or ""))


def _find(sid: str):
    """(folder, set, n) of the ticket this session runs, or None."""
    for r in sets():
        folder = r.get("folder")
        if not isinstance(folder, str):
            continue
        st = load(folder)
        for n, t in (st.get("tickets") or {}).items():
            if isinstance(t, dict) and t.get("session_id") == sid:
                return folder, st, n
    return None


def after_turn(job) -> bool:
    """A turn ended in a ticket's session: judge its ticket, then start what that
    frees. True when the session was a ticket's."""
    try:
        sid = job.store_session_id
        origin = (store.get_session(sid) or {}).get("origin") if sid else None
        if origin == "ticket-merge":
            _merge_turn(job)
            return True
        if origin != "ticket":
            return False
        with _build:
            hit = _find(sid)
            if not hit:
                return False
            folder, st, n = hit
            t = st["tickets"][n]
            # after a Stop nothing moves by itself
            v = _verdict(st, t, job.status) if t["status"] in ("running", "fix") and not job.interrupted else None
            if v:
                _settle(st, n, v)
            elif t["status"] == "running" and job.status == "done" and not job.interrupted:
                _nudge(t, sid, "ticket", job.chat_id)
            save(folder, st)
            tick(folder)
        return True
    except Exception as e:  # noqa: BLE001 — never raise into the turn lifecycle
        print(f"[tickets] after_turn failed: {e}", file=sys.stderr)
        return False


def _rerun(folder: str, st: dict, n: str) -> str:
    """A new turn in ticket n's own session and worktree: "" once it runs, else why
    not, and it is fix again. Its StepDone is forgotten before the turn starts (a fast one must count)
    and put back if the run is refused (your own turn still going)."""
    from bridge import runner  # local import: runner<->tickets cycle
    t = st["tickets"][n]
    t.update(status="running", nudges=0)
    save(folder, st)
    snap = paths.get(t["session_id"])
    try:
        s = store.get_session(t["session_id"]) or {}
        _one_step(t["session_id"], st, n)   # before the turn: a StepDone it records at once must count
        job = runner.start_streaming_job(s.get("chat_id"), _again(st, n), [], project=t["worktree"],
                                         session_id=t["session_id"], origin="ticket")
        err = "" if job else "the bridge refused the run"
    except Exception as e:  # noqa: BLE001 — a retry that can't start is fix again
        err = str(e) or type(e).__name__
    if err:
        print(f"[tickets] #{n} of {st['slug']} didn't start again: {err}", file=sys.stderr)
        paths.restore(t["session_id"], snap)   # a refused run keeps the StepDone you recorded
        t["status"] = "fix"
    save(folder, st)
    return err


def _retry_merge(folder: str, st: dict) -> str:
    """The merge asked for fix runs again: a new turn in its own session, or a fresh start."""
    from bridge import runner  # local import: runner<->tickets cycle
    sid = st.get("merge_session")
    if not sid:
        st["status"] = "building"
        save(folder, st)
        start_merge(folder)
        return "" if load(folder).get("status") == "merging" else "the merge didn't start"
    st.update(status="merging", nudges=0)
    save(folder, st)
    snap = paths.get(sid)
    try:
        s = store.get_session(sid) or {}
        paths.set_path(sid, "one", f"merge {st['slug']}", "rule", skill="merge")   # before the turn: its StepDone must count
        job = runner.start_streaming_job(s.get("chat_id"), _merge_prompt(st, st["tickets"]), [],
                                         project=st["feature_checkout"], session_id=sid, origin="ticket-merge")
        err = "" if job else "the bridge refused the run"
    except Exception as e:  # noqa: BLE001
        err = str(e) or type(e).__name__
    if err:
        paths.restore(sid, snap)
        st["status"] = "fix"
    save(folder, st)
    return err


def retry(folder: str, n: str) -> str:
    """A fix ticket runs again: a new turn in its own session and worktree, or a fresh
    start when it never got a session. "" once that is under way; with MAX_RUNNING
    running it waits as `retry` and tick gives it the next free slot."""
    with _build:
        st = load(folder)
        tks = st.get("tickets") or {}
        if n == "merge":
            return _retry_merge(folder, st) if st.get("status") == "fix" else "the merge isn't waiting for a retry"
        t = tks.get(n)
        if not t or t.get("status") != "fix":
            return f"#{n} isn't waiting for a retry"
        if not t.get("session_id"):
            t["status"] = "queued"   # tick starts it as new, within the cap
            save(folder, st)
            tick(folder)
            return ""
        if sum(x["status"] == "running" for x in tks.values()) >= MAX_RUNNING:
            t["status"] = "retry"
            save(folder, st)
            return f"{MAX_RUNNING} tickets are running; #{n} starts when one finishes."
        return _rerun(folder, st, n)


def _boot_merge(folder: str) -> None:
    """A merging set after a restart: no merge session yet (cut between the two saves)
    opens one; an idle, unparked one is judged as at its turn end (no turn: never began).
    Loaded and acted on under _build, so overlapping boots never open two."""
    with _build:
        st = load(folder)
        if st.get("status") != "merging":
            return
        sid = st.get("merge_session")
        if not sid:
            if _on():
                save(folder, {**st, "status": "building"})   # start_merge opens one only from building
                start_merge(folder)
            return
    if not store.running_turn_id(sid) and sid not in limits.parked():
        _merge_end(sid, (store.last_turn(sid) or {}).get("status") or "error", carry=not _stopped(sid))


def boot() -> None:
    """After a restart: judge every running ticket whose session sits idle and isn't
    parked (its turn ended, or never began, while nothing listened) as at a turn end:
    done, fix, or still running and told to carry on. Then tick each building set, and
    reconcile each merging one (_boot_merge). Nothing here starts a ticket that has a
    session; only retry() does. Run again when TICKETS or SKILL PATHS comes back on."""
    for r in sets():
        folder = r.get("folder")
        try:
            if isinstance(folder, str) and load(folder).get("status") == "merging":
                _boot_merge(folder)
            if not isinstance(folder, str) or load(folder).get("status") != "building":
                continue
            with _build:
                st = load(folder)
                for n, t in st["tickets"].items():
                    sid = t.get("session_id")
                    if t["status"] != "running" or not sid or store.running_turn_id(sid) or sid in limits.parked():
                        continue
                    last = (store.last_turn(sid) or {}).get("status") or "error"   # no turn at all: never began
                    _settle(st, n, _verdict(st, t, last) or "running")
                    if t["status"] == "running" and last == "done" and not _stopped(sid):
                        _nudge(t, sid, "ticket")   # ended without StepDone while nothing listened
                save(folder, st)
                tick(folder)
        except Exception as e:  # noqa: BLE001 — one bad set never stops the boot
            print(f"[tickets] boot of {folder} failed: {e}", file=sys.stderr)
