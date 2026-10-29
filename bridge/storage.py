"""SYSTEM ▸ STORAGE: what sessions leave on this machine's disk, per project,
and deleting what you tick (.mystical/design-drafts/clear-caches, variant B).

Three things grow on their own:
- each repo's `.mystical/`, where the CLAUDE.md convention sends a session's
  screenshots, recordings, drafts, probes and scratch. Nothing prunes it: 9.5 GB
  in 21 folders on the machine this was designed on (2026-10-29);
- the turn pictures in UPLOAD_DIR/<turn or session id>/. runner._prune_uploads
  drops them after UPLOAD_KEEP_DAYS; this is for the week before that;
- the file a MOVE import parks in the state dir's incoming-<host>/.

What it never deletes, KEEP: the bridge's own files in `.mystical/` (lessons,
reports and the dream digest, the task check's state, the dev server's log)
and the `.gitignore` that keeps the folder out of git. Pictures of a session
running now and what teammates sent stay too, as _prune_uploads leaves them.
Worktrees count towards the project they were added from, as sessions do.

Sizes are read fresh on every ask, as disk use (what deleting frees): 80k files
took 0.7 s there, so a cache would only add a way to be wrong.

Not built: the Trash (a copy there frees nothing until it is emptied),
remembering what you unticked, an automatic age rule (only 2.1 of 10.2 GB was
older than a week there, so it would free little).
"""

import os
import shutil
import stat
from collections import Counter

from . import browser, config, git, movejob, state, store, team

KEEP = frozenset({"learn", "docs", "tasks.json", "dev.log", ".gitignore"})


def _du(path: str) -> tuple[int, float]:
    """Bytes on disk under `path` and its newest file's mtime. Links are never followed."""
    try:
        st = os.lstat(path)
    except OSError:
        return 0, 0.0
    size = lambda s: getattr(s, "st_blocks", 0) * 512 or s.st_size  # noqa: E731
    if not stat.S_ISDIR(st.st_mode):
        return size(st), st.st_mtime
    total, newest = 0, 0.0
    for root, _dirs, files in os.walk(path):
        for n in files:
            try:
                s = os.lstat(os.path.join(root, n))
            except OSError:
                continue
            total += size(s)
            newest = max(newest, s.st_mtime)
    return total, newest or st.st_mtime


def _mystical(root: str) -> "str | None":
    """root's .mystical/ when it is a real folder. A link could point anywhere."""
    m = os.path.join(root, ".mystical")
    return m if os.path.isdir(m) and not os.path.islink(m) else None


def _names(m: str) -> list[str]:
    try:
        return [n for n in os.listdir(m) if n not in KEEP]
    except OSError:
        return []


def _entries(root: str) -> tuple[list, list]:
    """(what may go, what stays) in root's .mystical/, each biggest first."""
    m = _mystical(root)
    if not m:
        return [], []
    go, kept = [], []
    try:
        names = os.listdir(m)
    except OSError:
        return [], []
    for n in names:
        p = os.path.join(m, n)
        b, t = _du(p)
        (kept if n in KEEP else go).append(
            {"name": n, "dir": os.path.isdir(p) and not os.path.islink(p), "bytes": b, "mtime": t})
    return sorted(go, key=lambda e: -e["bytes"]), sorted(kept, key=lambda e: -e["bytes"])


def _worktrees(root: str) -> list[str]:
    """root's linked worktrees inside BASE_PATH. One in /tmp is not ours to touch."""
    if not os.path.isdir(os.path.join(root, ".git", "worktrees")):
        return []   # none linked: skip the git call
    return [w["path"] for w in git.worktrees(root)
            if not w["is_main"] and browser.within_base(w["path"]) and os.path.isdir(w["path"])]


def _pictures() -> dict:
    """{project: [(folder, bytes, mtime)]}: the upload folders named for a
    project's turns or sessions, less a running session's and teammates'."""
    try:
        names = [e.name for e in os.scandir(config.UPLOAD_DIR) if e.is_dir(follow_symlinks=False)]
    except OSError:
        return {}
    owners = store.projects_of(names)
    spare = team.owned_uploads() | set(state.running_sessions())
    out: dict = {}
    for n in names:
        o = owners.get(n)
        if o and n not in spare and o[1] not in spare:
            b, t = _du(os.path.join(config.UPLOAD_DIR, n))
            out.setdefault(o[0], []).append((n, b, t))
    return out


def _move_files() -> list:
    """The move files an import parked in incoming-<host>/. MOVE also lists the
    exports in your Downloads; those are yours, not leftovers."""
    out = []
    for f in movejob.files():
        d = os.path.basename(os.path.dirname(f["path"]))
        if d.startswith("incoming-"):
            out.append({**f, "from": d[len("incoming-"):]})
    return out


def scan() -> dict:
    """Every project with something to clear, biggest first, and the parked move files."""
    running = Counter(o[0] for o in store.projects_of(state.running_sessions()).values())
    pics = _pictures()
    projects = []
    for rel in browser.list_projects():
        root = os.path.join(config.BASE_PATH, rel.lstrip("/"))
        entries, kept = _entries(root)
        wts = [es for es in (_entries(w)[0] for w in _worktrees(root)) if es]
        wt_bytes = sum(e["bytes"] for es in wts for e in es)
        pp = pics.get(rel, [])
        pic_bytes = sum(b for _n, b, _t in pp)
        total = sum(e["bytes"] for e in entries) + wt_bytes + pic_bytes
        if total:
            projects.append({
                "project": rel, "bytes": total, "running": running.get(rel, 0),
                "entries": entries, "kept": kept,
                "pictures": {"bytes": pic_bytes, "count": len(pp), "mtime": max((t for *_x, t in pp), default=0.0)},
                "worktrees": {"bytes": wt_bytes, "count": len(wts)}})
    projects.sort(key=lambda p: -p["bytes"])
    moves = _move_files()
    return {"projects": projects, "move_files": moves,
            "bytes": sum(p["bytes"] for p in projects) + sum(f["bytes"] for f in moves)}


def _remove(m: str, name) -> tuple[int, "str | None"]:
    """Delete one entry of the .mystical folder `m`: (bytes freed, what went wrong)."""
    if (not isinstance(name, str) or name in ("", ".", "..") or "/" in name or os.sep in name
            or "\0" in name or name in KEEP):
        return 0, f"{name!r} is not something this deletes"
    p = os.path.join(m, name)
    if not os.path.lexists(p):
        return 0, None   # already gone
    b, _t = _du(p)
    try:
        if os.path.isdir(p) and not os.path.islink(p):
            shutil.rmtree(p)
        else:
            os.unlink(p)   # a link goes, never what it points at
    except OSError as e:
        return 0, f"{name}: {e.strerror or e}"
    return b, None


def clear(items: list, move_files: list = ()) -> dict:
    """Delete what the dialog ticked: each item is {project, entries, pictures,
    worktrees}, where no `entries` means every entry but KEEP and [] none.
    Only in projects the bridge lists, only direct children of their .mystical/,
    only the move files scan() lists. Returns {freed, errors}."""
    listed = set(browser.list_projects())
    freed, errors = 0, []
    pics = None
    for it in items:
        rel = it.get("project") if isinstance(it, dict) else None
        if not isinstance(rel, str) or rel not in listed:
            errors.append(f"{rel!r} is not a project")
            continue
        root = os.path.join(config.BASE_PATH, rel.lstrip("/"))
        names, own = it.get("entries"), _mystical(root)
        if os.path.islink(os.path.join(root, ".mystical")):
            errors.append(f"{rel}: its .mystical is a link, so nothing in it was touched")
        elif names is not None and not isinstance(names, list):
            errors.append(f"{rel}: entries must be a list")
        elif own:
            for n in (_names(own) if names is None else names):
                b, err = _remove(own, n)
                freed += b
                if err:
                    errors.append(f"{rel}: {err}")
        if it.get("pictures") is True:
            if pics is None:
                pics = _pictures()
            for n, b, _t in pics.get(rel, []):
                shutil.rmtree(os.path.join(config.UPLOAD_DIR, n), ignore_errors=True)
                freed += b
        if it.get("worktrees") is True:
            for w in _worktrees(root):
                if wm := _mystical(w):
                    for n in _names(wm):
                        b, err = _remove(wm, n)
                        freed += b
                        if err:
                            errors.append(f"{rel}: {err}")
    if move_files:
        parked = {f["path"]: f for f in _move_files()}
        for p in move_files:
            f = parked.get(p) if isinstance(p, str) else None
            if not f:
                errors.append(f"{p!r} is not a move file an import left")
                continue
            r = movejob.delete_file(p)
            if r.get("error"):
                errors.append(r["error"])
            else:
                freed += f["bytes"]
    return {"freed": freed, "errors": errors}
