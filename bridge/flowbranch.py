"""The feature branch a skill path builds on.

No automatic step may build on the default branch. When a path reaches BUILD,
ensure_feature_branch finds or makes `feat/<slug>` in its own worktree, and
carry_and_commit moves the flow's decisions (the grill's GLOSSARY.md and
docs/adr/*, the spec) there and commits them.

Only the files this flow's turns wrote move (flow_files), never the whole dirty
tree: the session's checkout may hold other sessions' half-done edits, and those
must stay exactly where they are. A stash carries them because it is the one
git primitive that moves chosen files, untracked ones included, between two
worktrees of one repo: the stash list is shared across them. That sharing is
also the hazard: `stash pop` takes the newest entry, so carry_and_commit pops
only if its own push added one, or it would apply someone else's stash.
"""

import os

from bridge import git, store

_WRITES = ("Write", "Edit", "MultiEdit", "NotebookEdit")


def _checkout(session: dict) -> str:
    return session.get("work_cwd") or session.get("cwd") or ""


def flow_files(session_id: str, since: int) -> list[str]:
    """Files the session's Write/Edit/MultiEdit/NotebookEdit calls touched since
    `since`, inside its checkout. Tool events keep the call's first input field as
    `summary` (cut at 120 chars, the whole text in `detail`), which for these tools
    is file_path. shortcut: NotebookEdit's notebook_path isn't a summary key, so
    notebooks are missed; add it if a flow ever writes one."""
    s = store.get_session(session_id) or {}
    root = os.path.realpath(_checkout(s))
    out: list[str] = []
    for ev in store.timed_events(session_id):
        if ev.get("type") != "tool" or ev.get("name") not in _WRITES or ev.get("ts", 0) < since:
            continue
        p = ev.get("detail") or ev.get("summary") or ""
        if root and os.path.isabs(p) and os.path.realpath(p).startswith(root + os.sep) and p not in out:
            out.append(p)
    return out


def ensure_feature_branch(session: dict, slug: str) -> tuple[str, str]:
    """(branch, checkout) BUILD works in. A linked worktree already on a non-default
    branch is used as is; otherwise `feat/<slug>` gets its own worktree."""
    co = _checkout(session)
    main = git.main_checkout(co)
    default = git.default_branch(main)
    if os.path.realpath(co) != os.path.realpath(main):
        cur = git.current_branch(co)
        if cur and cur != default:
            return cur, co
    branch = f"feat/{slug}"
    for w in git.worktrees(main):
        if w["branch"] == branch:
            return branch, w["path"]
    wt = git.worktree_path_for(main, branch, free=True)
    os.makedirs(os.path.dirname(wt), exist_ok=True)
    exists = branch in git.branches(main)
    ok, out = git.worktree_add(main, wt, branch, start="" if exists else "HEAD", create=not exists)
    if not ok:
        raise RuntimeError(f"feature worktree failed: {out}")
    git.copy_env(main, wt)
    return branch, wt


def carry_and_commit(src: str, dst: str, files: list[str], slug: str) -> bool:
    """Move `files` from `src` to `dst` (stash push, then pop) and commit only
    them there. False when there is nothing to do or git said no."""
    if not files:
        return False
    rel = [os.path.relpath(f, src) if os.path.isabs(f) else f for f in files]
    if os.path.realpath(src) != os.path.realpath(dst):
        before = git._run(src, "stash", "list")[1]  # noqa: SLF001
        rc, _, _ = git._run(src, "stash", "push", "-u", "-m", f"mystical flow {slug}", "--", *rel, timeout=30)  # noqa: SLF001
        if rc != 0 or git._run(src, "stash", "list")[1] == before:  # noqa: SLF001
            return False
        if git._run(dst, "stash", "pop", timeout=30)[0] != 0:  # noqa: SLF001
            return False
    if git._run(dst, "add", "--", *rel)[0] != 0:  # noqa: SLF001
        return False
    rc, _, _ = git._run(dst, "commit", "-m", f"docs: decisions from the {slug} flow", "--", *rel, timeout=30)  # noqa: SLF001
    return rc == 0
