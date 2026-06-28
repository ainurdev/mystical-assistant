"""Read git status/diff and perform commit/push for a working tree. Stdlib only;
every call shells out to `git -C <cwd> …` with a timeout. Callers pass an absolute
cwd already confined to BASE_PATH by the dashboard's _abs_project."""

import os
import subprocess


def _run(cwd: str, *args: str, timeout: int = 8) -> tuple[int, str, str]:
    try:
        p = subprocess.run(["git", "-C", cwd, *args], capture_output=True,
                           text=True, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "git timed out"
    except OSError as e:
        return 127, "", str(e)


def is_repo(cwd: str) -> bool:
    rc, out, _ = _run(cwd, "rev-parse", "--is-inside-work-tree")
    return rc == 0 and out.strip() == "true"


def _safe_path(cwd: str, path: str) -> str | None:
    """Return path relative to cwd iff it stays inside cwd, else None."""
    root = os.path.realpath(cwd)
    full = os.path.realpath(os.path.join(root, path))
    if full == root or full.startswith(root + os.sep):
        return os.path.relpath(full, root)
    return None


def _status_letter(xy: str) -> str:
    s = xy.replace(".", "")
    return s[0] if s else "M"


def _parse(raw: str):
    """(branch, ahead, behind, [(status, path, untracked)]) from porcelain v2."""
    branch, ahead, behind, entries = "", 0, 0, []
    for line in raw.splitlines():
        if line.startswith("# branch.head"):
            branch = line[len("# branch.head"):].strip()
        elif line.startswith("# branch.ab"):
            for tok in line.split():
                if tok.startswith("+"):
                    ahead = int(tok[1:] or 0)
                elif tok.startswith("-"):
                    behind = int(tok[1:] or 0)
        elif line[:1] == "1":
            entries.append((_status_letter(line.split(" ", 2)[1]),
                            line.split(" ", 8)[8] if len(line.split(" ", 8)) > 8 else "", False))
        elif line[:1] == "2":
            parts = line.split(" ", 9)
            rest = parts[9] if len(parts) > 9 else ""
            entries.append((_status_letter(line.split(" ", 2)[1]),
                            rest.split("\t")[0], False))
        elif line.startswith("u "):
            entries.append(("U", line.rsplit(" ", 1)[-1], False))
        elif line.startswith("? "):
            entries.append(("?", line[2:], True))
    return branch, ahead, behind, entries


def _numstat(cwd: str) -> dict:
    res: dict[str, list[int]] = {}
    for args in (("diff", "--numstat"), ("diff", "--cached", "--numstat")):
        rc, out, _ = _run(cwd, *args)
        if rc != 0:
            continue
        for line in out.splitlines():
            parts = line.split("\t")
            if len(parts) != 3:
                continue
            a, d, path = parts
            cur = res.get(path, [0, 0])
            res[path] = [cur[0] + (0 if a == "-" else int(a)),
                         cur[1] + (0 if d == "-" else int(d))]
    return res


def _count_lines(path: str) -> int:
    try:
        if os.path.getsize(path) > 1_000_000:
            return 0
        with open(path, "rb") as f:
            return sum(1 for _ in f)
    except OSError:
        return 0


def _porcelain(cwd: str) -> str | None:
    # quotePath=false: emit non-ASCII paths verbatim, not C-quoted ("caf\303\251"),
    # so the path is usable as a pathspec and the file's diff renders.
    rc, out, _ = _run(cwd, "-c", "core.quotePath=false",
                      "status", "--porcelain=v2", "--branch")
    return out if rc == 0 else None


def badge(cwd: str) -> dict | None:
    if not is_repo(cwd):
        return None
    branch, ahead, behind, entries = _parse(_porcelain(cwd) or "")
    return {"branch": branch, "ahead": ahead, "behind": behind, "dirty": len(entries)}


def status(cwd: str) -> dict:
    if not is_repo(cwd):
        return {"is_repo": False, "branch": "", "ahead": 0, "behind": 0,
                "dirty": 0, "files": []}
    branch, ahead, behind, entries = _parse(_porcelain(cwd) or "")
    nums = _numstat(cwd)
    files = []
    for st, path, untracked in entries:
        add, dele = nums.get(path, [0, 0])
        if untracked:
            add = _count_lines(os.path.join(cwd, path))
        files.append({"path": path, "status": st, "add": add, "del": dele})
    return {"is_repo": True, "branch": branch, "ahead": ahead, "behind": behind,
            "dirty": len(files), "files": files}


def diff(cwd: str, path: str) -> str:
    safe = _safe_path(cwd, path)
    if safe is None:
        return ""
    rc, out, _ = _run(cwd, "status", "--porcelain", "--", safe)
    if out.startswith("??"):
        _rc, out, _err = _run(cwd, "diff", "--no-index", "--", os.devnull, safe)
        return out
    rc, _o, _e = _run(cwd, "rev-parse", "--verify", "HEAD")
    args = ["diff"] + (["HEAD"] if rc == 0 else []) + ["--", safe]
    _rc, out, _err = _run(cwd, *args)
    return out


def commit(cwd: str, message: str) -> tuple[bool, str]:
    rc, out, err = _run(cwd, "add", "-A")
    if rc != 0:
        return False, (err or out or "git add failed").strip()
    rc, out, err = _run(cwd, "commit", "-m", message)
    return rc == 0, (out + err).strip()


def push(cwd: str, timeout: int = 30) -> tuple[bool, str]:
    rc, out, err = _run(cwd, "push", timeout=timeout)
    return rc == 0, (out + err).strip()


# --- branches & worktrees (powers the unified projects+sessions view) ---

def current_branch(cwd: str) -> str:
    rc, out, _ = _run(cwd, "rev-parse", "--abbrev-ref", "HEAD")
    return out.strip() if rc == 0 else ""


def default_branch(cwd: str) -> str:
    """The repo's default branch — what PRs/merges target. Prefers the remote's
    HEAD (origin/HEAD), then a local main/master, then the current branch. Many
    repos don't use 'main' (e.g. master, or a custom default), so callers must not
    assume it."""
    rc, out, _ = _run(cwd, "rev-parse", "--abbrev-ref", "origin/HEAD")
    name = out.strip() if rc == 0 else ""
    if name and name != "origin/HEAD":
        return name.split("/", 1)[-1]
    local = branches(cwd)
    for cand in ("main", "master"):
        if cand in local:
            return cand
    return current_branch(cwd) or "main"


def branches(cwd: str) -> list[str]:
    """Local branch names, current first."""
    if not is_repo(cwd):
        return []
    rc, out, _ = _run(cwd, "for-each-ref", "--format=%(refname:short)", "refs/heads")
    names = [b.strip() for b in out.splitlines() if b.strip()] if rc == 0 else []
    cur = current_branch(cwd)
    if cur and cur in names:
        names.remove(cur)
        names.insert(0, cur)
    return names


def checkout(cwd: str, ref: str) -> tuple[bool, str]:
    rc, out, err = _run(cwd, "checkout", ref)
    return rc == 0, (out + err).strip()


def create_branch(cwd: str, name: str, start: str = "") -> tuple[bool, str]:
    args = ["branch", name] + ([start] if start else [])
    rc, out, err = _run(cwd, *args)
    return rc == 0, (out + err).strip()


def delete_branch(cwd: str, name: str, force: bool = False) -> tuple[bool, str]:
    if name in ("main", "master", current_branch(cwd)):
        return False, "refusing to delete the current/default branch"
    rc, out, err = _run(cwd, "branch", "-D" if force else "-d", name)
    return rc == 0, (out + err).strip()


def merge(cwd: str, branch: str, ff_only: bool = False) -> tuple[bool, str]:
    """Merge `branch` into the current branch."""
    args = ["merge", "--ff-only" if ff_only else "--no-edit", branch]
    rc, out, err = _run(cwd, *args, timeout=30)
    return rc == 0, (out + err).strip()


def worktrees(cwd: str) -> list[dict]:
    """Parse `git worktree list --porcelain` → [{path, branch, head, is_main}]."""
    if not is_repo(cwd):
        return []
    rc, out, _ = _run(cwd, "worktree", "list", "--porcelain")
    if rc != 0:
        return []
    items: list[dict] = []
    cur: dict = {}
    for line in out.splitlines():
        if line.startswith("worktree "):
            if cur:
                items.append(cur)
            cur = {"path": line[len("worktree "):].strip(), "branch": "",
                   "head": "", "detached": False}
        elif line.startswith("HEAD "):
            cur["head"] = line[len("HEAD "):].strip()[:10]
        elif line.startswith("branch "):
            ref = line[len("branch "):].strip()
            cur["branch"] = ref[len("refs/heads/"):] if ref.startswith("refs/heads/") else ref
        elif line.strip() == "detached":
            cur["detached"] = True
    if cur:
        items.append(cur)
    for i, w in enumerate(items):
        w["is_main"] = i == 0
    return items


def worktree_add(cwd: str, path: str, branch: str, start: str = "",
                 create: bool = True) -> tuple[bool, str]:
    """Add a worktree at `path`. create=True makes a new branch `branch` from
    `start`; create=False checks out an existing `branch` into the worktree."""
    if create:
        args = ["worktree", "add", "-b", branch, path] + ([start] if start else [])
    else:
        args = ["worktree", "add", path, branch]
    rc, out, err = _run(cwd, *args, timeout=30)
    return rc == 0, (out + err).strip()


def worktree_remove(cwd: str, path: str, force: bool = True) -> tuple[bool, str]:
    args = ["worktree", "remove"] + (["--force"] if force else []) + [path]
    rc, out, err = _run(cwd, *args, timeout=20)
    return rc == 0, (out + err).strip()


def diff_ref(cwd: str, base: str, head: str, path: str) -> str:
    """Per-file text diff between two refs, tip-to-tip (`git diff base..head -- path`).
    Powers the Changes tab's branch comparison. The caller must validate base/head
    are real branch refs; path is confined to cwd."""
    safe = _safe_path(cwd, path)
    if safe is None:
        return ""
    _rc, out, _err = _run(cwd, "diff", f"{base}..{head}", "--", safe)
    return out


def _ztokens(out: str) -> list[str]:
    """Split NUL-delimited git output, dropping the trailing empty field."""
    toks = out.split("\0")
    if toks and toks[-1] == "":
        toks.pop()
    return toks


def compare(cwd: str, base: str, head: str, three_dot: bool = True) -> dict:
    """Diff stats between `base` and `head`. With three_dot (default) the range is
    `base...head` (changes since the merge-base) — powers the PR preview. With
    three_dot=False it's a direct tip-to-tip `base..head` diff — powers the Changes
    tab's branch comparison. Returns commit count, files changed, +/- totals."""
    if not is_repo(cwd):
        return {"ok": False, "commits": 0, "ahead": 0, "behind": 0,
                "files": [], "add": 0, "del": 0}
    rng = f"{base}...{head}" if three_dot else f"{base}..{head}"
    # left-right count needs the symmetric (three-dot) form regardless of `rng`.
    rc, out, _ = _run(cwd, "rev-list", "--left-right", "--count", f"{base}...{head}")
    behind = ahead = 0
    if rc == 0 and out.strip():
        parts = out.split()
        if len(parts) == 2:
            behind, ahead = int(parts[0] or 0), int(parts[1] or 0)
    # -z keeps paths verbatim (no C-quoting of non-ASCII) and splits rename/copy
    # entries into separate NUL fields, so every `name` is a real, diffable path —
    # not the `old => new` numstat form or a "caf\303\251" quoted name.
    marks: dict[str, str] = {}
    rc, out, _ = _run(cwd, "diff", "--name-status", "-z", rng)
    if rc == 0:
        toks = _ztokens(out)
        i = 0
        while i < len(toks):
            st = toks[i]
            i += 1
            if st[:1] in ("R", "C"):  # rename/copy → old, new follow; key on new
                if i + 1 < len(toks):
                    marks[toks[i + 1]] = st[0]
                i += 2
            elif i < len(toks):
                marks[toks[i]] = st[0] if st else "M"
                i += 1
    files = []
    total_add = total_del = 0
    rc, out, _ = _run(cwd, "diff", "--numstat", "-z", rng)
    if rc == 0:
        toks = _ztokens(out)
        i = 0
        while i < len(toks):
            cols = toks[i].split("\t")
            i += 1
            if len(cols) < 3:
                continue
            a, d, name = cols[0], cols[1], cols[2]
            if name == "":  # rename/copy → old, new follow as separate tokens
                if i + 1 < len(toks):
                    name = toks[i + 1]
                i += 2
            if not name:
                continue
            add = 0 if a == "-" else int(a)
            dele = 0 if d == "-" else int(d)
            total_add += add
            total_del += dele
            files.append({"name": name, "mark": marks.get(name, "M"),
                          "add": add, "del": dele})
    return {"ok": True, "commits": ahead, "ahead": ahead, "behind": behind,
            "files": files, "add": total_add, "del": total_del}
