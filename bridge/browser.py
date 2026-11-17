"""Project folder browser (tap-button navigation under BASE_PATH)."""

import os

from bridge import config, roots, state
from bridge.telegram import send

# Chat-only projects live here, under BASE_PATH: hidden, so the scan below and
# every folder picker pass it by (bridge/newproject.py says why it isn't
# `.mystical`).
CHATS_DIR = ".mystical-chats"


def list_dirs(path: str) -> list[str]:
    try:
        return sorted(
            e.name for e in os.scandir(path)
            if e.is_dir() and not e.name.startswith(".") and e.name not in config.SKIP_DIRS
        )
    except OSError:
        return []


def list_projects(max_depth: int = 3) -> list[str]:
    """Git repos under BASE_PATH as rel paths ('/org/repo'), descending into
    non-repo folders (org dirs) up to max_depth — deep enough for a sub-org
    ('/ainurhq/efas/app'). A repo is never descended into, so a monorepo's
    internals stay hidden; the dashboard's MANAGE modal hides the rest. Only a
    `.git` directory counts: a `.git` file marks a worktree/submodule checkout,
    which is neither listed nor entered."""
    out: list[str] = []

    def scan(path: str, depth: int):
        for name in list_dirs(path):
            p = os.path.join(path, name)
            git = os.path.join(p, ".git")
            if os.path.isdir(git):
                out.append(rel(p))
            elif not os.path.exists(git) and depth < max_depth:
                scan(p, depth + 1)

    scan(config.BASE_PATH, 1)
    # The two kinds of project the scan can't find: a folder outside BASE_PATH
    # you allowed (bridge/roots.py), and a chat folder, which is hidden and no
    # repo (bridge/newproject.py). Both are listed because you made them, so
    # neither needs a `.git` to count.
    out += [rel(r) for r in roots.listing() if os.path.isdir(r)]
    chats = os.path.join(config.BASE_PATH, CHATS_DIR)
    out += [rel(os.path.join(chats, n)) for n in list_dirs(chats)]
    return out


def project_exists(rel_path: str) -> bool:
    """True if a project rel still resolves to a real directory under BASE_PATH
    (a session may point at a since-deleted worktree checkout). A live Claude Code
    session started outside BASE_PATH is labelled with its own (~-collapsed) path
    instead — see native._index_running — so that form is checked literally when
    the base-relative reading finds nothing.

    The two container dirs are never projects: BASE_PATH itself ('/') and your
    home ('~') hold projects instead of being one, so a `claude` started in either
    stops opening a phantom project group in the session lists. Those sessions are
    still resumable and their transcripts still viewable by id."""
    p = os.path.realpath(os.path.join(config.BASE_PATH, (rel_path or "").lstrip("/")))
    if within_base(p) and os.path.isdir(p):
        return p != config.BASE_PATH
    out = os.path.expanduser(rel_path or "")
    return (os.path.isabs(out) and not _under_base(out) and os.path.isdir(out)
            and os.path.realpath(out) != os.path.realpath(os.path.expanduser("~")))


def gone(rel_path: str) -> bool:
    """A project that was a real folder and isn't one any more (moved, renamed,
    deleted): its sessions stay in the lists, marked, until MOVE TO PROJECT puts
    them in one of yours. BASE_PATH and home were never projects, and a removed
    worktree checkout is disposable: those stay out, as before."""
    r = (rel_path or "").strip()
    if not r.strip("/") or r.startswith("~") or r.lstrip("/").startswith(".worktrees/"):
        return False
    return within_base(os.path.realpath(os.path.join(config.BASE_PATH, r.lstrip("/")))) and not project_exists(r)


def _under_base(path: str) -> bool:
    real = os.path.realpath(path)
    return real == config.BASE_PATH or real.startswith(config.BASE_PATH + os.sep)


def within_base(path: str) -> bool:
    """Somewhere Mystical may work: under BASE_PATH, or under a folder outside
    it that you allowed from NEW PROJECT (bridge/roots.py)."""
    return _under_base(path) or roots.allowed(os.path.realpath(path))


def rel(path: str) -> str:
    r = os.path.relpath(path, config.BASE_PATH)
    return "/" if r == "." else "/" + r


def browser_view(chat_id: int) -> tuple[str, dict]:
    cur = state.browse.get(chat_id, config.BASE_PATH)
    dirs = list_dirs(cur)
    shown = dirs[:config.MAX_BTNS]
    rows = [[{"text": "📁 " + d, "callback_data": f"nav:{i}"}]
            for i, d in enumerate(shown)]
    controls = []
    if os.path.realpath(cur) != config.BASE_PATH:
        controls.append({"text": "⬆️ Up", "callback_data": "up"})
    controls.append({"text": "✅ Use this folder", "callback_data": "use"})
    rows.append(controls)

    note = ""
    if len(dirs) > config.MAX_BTNS:
        note = f"\n(showing first {config.MAX_BTNS} of {len(dirs)} folders)"
    if not dirs:
        note = "\n(no subfolders — tap ✅ to use this one)"
    text = f"📂 {rel(cur)}{note}\n\nTap a folder to open it, or ✅ to select it."
    return text, {"inline_keyboard": rows}


def open_browser(chat_id: int):
    state.browse[chat_id] = config.BASE_PATH
    text, kb = browser_view(chat_id)
    send(chat_id, text, reply_markup=kb)
