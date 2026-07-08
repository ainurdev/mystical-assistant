"""Project folder browser (tap-button navigation under BASE_PATH)."""

import os

from bridge import config, state
from bridge.telegram import send


def list_dirs(path: str) -> list[str]:
    try:
        return sorted(
            e.name for e in os.scandir(path)
            if e.is_dir() and not e.name.startswith(".") and e.name not in config.SKIP_DIRS
        )
    except OSError:
        return []


def list_projects(max_depth: int = 2) -> list[str]:
    """Git repos under BASE_PATH as rel paths ('/org/repo'), descending one
    level into non-repo folders (org dirs). Repos nested deeper (members of a
    monorepo folder) are the monorepo's internals, not projects. Only a `.git`
    directory counts: a `.git` file marks a worktree/submodule checkout, which
    is neither listed nor entered."""
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
    return out


def project_exists(rel_path: str) -> bool:
    """True if a project rel still resolves to a real directory under BASE_PATH
    (a session may point at a since-deleted worktree checkout)."""
    p = os.path.realpath(os.path.join(config.BASE_PATH, (rel_path or "").lstrip("/")))
    return within_base(p) and os.path.isdir(p)


def within_base(path: str) -> bool:
    real = os.path.realpath(path)
    return real == config.BASE_PATH or real.startswith(config.BASE_PATH + os.sep)


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
