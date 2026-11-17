"""Folders outside BASE_PATH that Mystical may work in.

Everything that takes a path (the file browser, the git tab, dev servers, the run
API) asks browser.within_base, which used to mean "under BASE_PATH" and nothing
else. That is right for a projects folder and wrong for the one-off: the dotfiles
in ~/.config, a checkout on another disk. Starting a session there by prompt
("go to that directory") worked for the agent and for nothing else: no files, no
git tab, no project in the list.

So this is a list of specific folders, each added by you from NEW PROJECT after
its notice, and within_base answers yes under any of them. A list of folders and
not a second BASE_PATH: a root is one project, never a place scanned for more.

It lives in roots.json beside the DB, not in .env: config is frozen at import, and
the list has to grow while the bridge runs.

What is refused, because allowing it would make the whole machine a project: `/`,
your home, anything above your home or above BASE_PATH, and the bridge's own state
folder. A folder already under BASE_PATH needs no entry and gets none.

ponytail: a root's project key is its path relative to BASE_PATH ("/../../.config/x"),
because that is what every os.path.join(BASE_PATH, rel) in the bridge already
resolves. The ceiling is that the key moves with BASE_PATH: change it and these
projects' sessions lose their group until the folder is added again. Give roots
their own key form only if BASE_PATH starts moving.

Stdlib only. Read through a cache keyed by the file's mtime, since within_base
is asked many times per request.
"""

import json
import os
import threading

from bridge import config

_lock = threading.RLock()
_cache: "tuple[str, float, list[str]] | None" = None  # (file, mtime, roots)


def _file() -> str:
    return os.path.join(os.path.dirname(config.BRIDGE_DB), "roots.json")


def listing() -> "list[str]":
    """The allowed folders, as real paths, in the order they were added."""
    global _cache
    path = _file()
    try:
        mtime = os.path.getmtime(path)
    except OSError:
        return []
    with _lock:
        if _cache and _cache[0] == path and _cache[1] == mtime:
            return list(_cache[2])
        try:
            with open(path, encoding="utf-8") as f:
                raw = json.load(f)
        except (OSError, ValueError):
            raw = []
        roots = (
            [r for r in raw if isinstance(r, str) and os.path.isabs(r)]
            if isinstance(raw, list)
            else []
        )
        _cache = (path, mtime, roots)
        return list(roots)


def _save(roots: "list[str]") -> None:
    global _cache
    path = _file()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(roots, f, indent=1)
    os.replace(tmp, path)
    _cache = None


def _under(real: str, root: str) -> bool:
    return real == root or real.startswith(root.rstrip(os.sep) + os.sep)


def allowed(real: str) -> bool:
    """True when `real` (a realpath) is one of the folders, or inside one."""
    return any(_under(real, r) for r in listing())


def refusal(path: str) -> "str | None":
    """Why this folder can't be added, or None when it can."""
    real = os.path.realpath(path)
    home = os.path.realpath(os.path.expanduser("~"))
    state = os.path.realpath(os.path.dirname(config.BRIDGE_DB))
    if real == os.sep:
        return "the filesystem root can't be a project"
    if _under(home, real):
        return "your home folder (or a folder above it) can't be a project: pick a folder inside it"
    if _under(config.BASE_PATH, real):
        return "that folder holds your projects folder: pick a folder inside it"
    if _under(real, state) or _under(state, real):
        return "that is where Mystical keeps its own state"
    return None


def add(path: str) -> "tuple[bool, str]":
    """Allow one folder. (True, its real path), or (False, why not)."""
    real = os.path.realpath(path)
    if not os.path.isdir(real):
        return False, f"not a folder: {real}"
    if _under(real, config.BASE_PATH):
        return True, real  # already inside the projects folder
    why = refusal(real)
    if why:
        return False, why
    with _lock:
        roots = listing()
        if not any(_under(real, r) for r in roots):
            # A folder above ones already listed takes their place.
            roots = [r for r in roots if not _under(r, real)] + [real]
            _save(roots)
    return True, real


def remove(path: str) -> bool:
    """Stop allowing a folder. Nothing on disk is touched; its sessions stay in
    the DB and come back if the folder is added again."""
    real = os.path.realpath(path)
    with _lock:
        roots = listing()
        if real not in roots:
            return False
        _save([r for r in roots if r != real])
    return True
