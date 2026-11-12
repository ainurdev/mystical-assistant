"""The project's .mystical folder: what's in it, and what's safe to clear.

It had one rule, "git never sees this", and no shape: this repo's held 240 MB of probes,
source checkouts and drafts, side by side with the bridge's own files. Now agents are told
where things go, and the MYSTICAL panel shows it by kind.

  images/   pictures in your messages (bridge/chat_images.py)
  docs/     reports and other Markdown written to be read
  drafts/   design drafts and mockups (design-drafts/ is the older name, still honoured)
  scratch/  throwaway scripts, probes, downloads
  learn/    saved lessons (bridge/learn.py)
  plans/    each chat's plan, as its agent wrote it (bridge/chatplan.py)
  runs/     what work list runs kept: helpers' screenshots and logs, check output (bridge/workrun.py)

Nothing already there is moved: code, old links and old transcripts name those paths, and an
agent's folder may hold the only copy of something. An entry that fits no kind reads
"other". Only scratch and other can be cleared in bulk, by age. The rest is one at a time,
and images ask first because old chats show them. Nothing ever cleans itself. Bridge-owned
files (dev.log, tasks.json, .gitignore, checks) can't be deleted here at all.

`keep` marks something clearing should leave alone, in .mystical/.keep.json.
Stdlib only, read fresh per ask.
"""

import json
import mimetypes
import os
import shutil
import time

from bridge import chat_images, devserver

KINDS = {"images": "images", "docs": "docs", "drafts": "drafts", "design-drafts": "drafts",
         "scratch": "scratch", "learn": "learn", "handoff": "bridge", "helpers": "bridge", "runs": "docs", "plans": "bridge"}
OWNED = {".gitignore", ".keep.json", "dev.log", "tasks.json", "checks.json", "checks-last.log", "worklist.json"}
NOTE = ("Keep it tidy: .mystical/scratch/ for throwaway scripts and probes, .mystical/docs/ for reports and "
        "other Markdown written to be read, .mystical/drafts/ for design drafts and mockups. "
        ".mystical/images/ holds the pictures in the user's messages: leave it alone.")
_DAY = 86400


def _du(path: str) -> "tuple[int, float, int]":
    """(bytes, newest mtime, files) under a path. Links aren't followed."""
    try:
        st = os.lstat(path)
    except OSError:
        return 0, 0.0, 0
    if not os.path.isdir(path) or os.path.islink(path):
        return st.st_size, st.st_mtime, 1
    size, newest, n = 0, st.st_mtime, 0
    for root, dirs, files in os.walk(path):
        for name in files:
            try:
                s = os.lstat(os.path.join(root, name))
            except OSError:
                continue
            size += s.st_size
            newest = max(newest, s.st_mtime)
            n += 1
    return size, newest, n


def _keeps(root: str) -> set:
    try:
        with open(os.path.join(root, ".mystical", ".keep.json"), encoding="utf-8") as f:
            v = json.load(f)
        return set(v) if isinstance(v, list) else set()
    except (OSError, ValueError):
        return set()


def _kind(name: str) -> str:
    if name in OWNED:
        return "bridge"
    return KINDS.get(name, "other")


def _preview_kind(path: str) -> str:
    kind = mimetypes.guess_type(path)[0] or ""
    if kind in chat_images.SERVABLE:
        return "image"
    return "text" if path.endswith((".md", ".markdown", ".txt", ".log", ".json")) else "none"


def _safe(root: str, rel: str) -> "str | None":
    """rel inside .mystical, and not .mystical itself. Links resolve before the check."""
    base = os.path.realpath(os.path.join(root, ".mystical"))
    parent = os.path.realpath(os.path.join(base, os.path.dirname(rel or "")))
    if not rel or "\0" in rel or not (parent == base or parent.startswith(base + os.sep)):
        return None
    path = os.path.join(parent, os.path.basename(rel))
    return path if path != base else None


def listing(root: "str | None", sub: str = "") -> dict:
    """The folder by kind, or one sub-folder's entries."""
    if not root:
        return {"root": None, "total": 0, "entries": [], "groups": {}}
    base = os.path.join(root, ".mystical")
    d = _safe(root, sub) if sub else base
    if d is None or not os.path.isdir(d):
        return {"root": root, "total": 0, "entries": [], "groups": {}, "sub": sub}
    keeps = _keeps(root)
    rows = []
    for name in sorted(os.listdir(d)):
        p = os.path.join(d, name)
        rel = os.path.join(sub, name) if sub else name
        size, at, files = _du(p)
        top = rel.split(os.sep)[0]
        kind = _kind(top)
        rows.append({"name": name, "path": rel, "dir": os.path.isdir(p) and not os.path.islink(p), "bytes": size,
                     "at": at, "files": files, "kind": kind, "keep": rel in keeps,
                     "preview": _preview_kind(p), "deletable": kind != "bridge" and top not in OWNED})
    rows.sort(key=lambda r: -r["at"])
    groups: dict = {}
    for r in rows:
        g = groups.setdefault(r["kind"], {"bytes": 0, "count": 0})
        g["bytes"] += r["bytes"]
        g["count"] += 1
    return {"root": root, "total": sum(r["bytes"] for r in rows), "entries": rows, "groups": groups, "sub": sub}


def set_keep(root: str, rel: str, on: bool) -> None:
    if _safe(root, rel) is None:
        raise ValueError("That isn't in this folder.")
    keeps = _keeps(root)
    (keeps.add if on else keeps.discard)(rel)
    devserver.mystical_dir(root)
    path = os.path.join(root, ".mystical", ".keep.json")
    with open(path + ".tmp", "w", encoding="utf-8") as f:
        json.dump(sorted(keeps), f, indent=1)
    os.replace(path + ".tmp", path)


def delete(root: str, rel: str, confirm_images: bool = False) -> None:
    """One entry. ValueError with a sentence when it can't go."""
    path = _safe(root, rel)
    if path is None or not os.path.lexists(path):
        raise ValueError("That isn't in this folder.")
    top = rel.split(os.sep)[0]
    if _kind(top) == "bridge":
        raise ValueError("Mystical uses that file.")
    if _kind(top) == "images" and not confirm_images:
        raise ValueError("Old chats show these images. Confirm to delete.")
    if os.path.isdir(path) and not os.path.islink(path):
        shutil.rmtree(path)
    else:
        os.unlink(path)


def stale(root: "str | None", days: int = 30) -> list:
    """What clearing would take: scratch and other, older than `days`, not marked keep.
    Inside scratch by entry, so a folder holding something recent is judged on its own."""
    if not root:
        return []
    cutoff, keeps, out = time.time() - days * _DAY, _keeps(root), []
    for r in listing(root)["entries"]:
        if r["kind"] == "scratch" and r["dir"]:
            out += [e for e in listing(root, r["path"])["entries"] if e["at"] < cutoff and e["path"] not in keeps]
        elif r["kind"] == "other" and r["at"] < cutoff and not r["keep"]:
            out.append(r)
    return out


def clear_stale(root: str, days: int = 30) -> dict:
    gone, freed = 0, 0
    for r in stale(root, days):
        try:
            delete(root, r["path"])
        except (ValueError, OSError):
            continue
        gone, freed = gone + 1, freed + r["bytes"]
    return {"removed": gone, "freed": freed}


def read_text(root: str, rel: str, limit: int = 200_000) -> "str | None":
    path = _safe(root, rel)
    if path is None or not os.path.isfile(path) or _preview_kind(path) != "text":
        return None
    with open(path, encoding="utf-8", errors="replace") as f:
        return f.read(limit)
