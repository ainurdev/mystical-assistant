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
    rc, out, _ = _run(cwd, "status", "--porcelain=v2", "--branch")
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
