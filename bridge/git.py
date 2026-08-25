"""Read git status/diff and perform commit/push for a working tree. Stdlib only;
every call shells out to `git -C <cwd> …` with a timeout. Callers pass an absolute
cwd already confined to BASE_PATH by the dashboard's _abs_project."""

import base64
import mimetypes
import os
import re
import shutil
import subprocess
import time


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


def _mutable_path(cwd: str, path: str) -> str | None:
    """_safe_path for writes: also refuses the repo root itself and anything
    under .git, so an editor request can't rewrite or delete the repository."""
    safe = _safe_path(cwd, path)
    if safe is None or safe == "." or safe.split(os.sep)[0] == ".git":
        return None
    return safe


def _status_letter(xy: str) -> str:
    s = xy.replace(".", "")
    return s[0] if s else "M"


def _parse(raw: str):
    """(branch, upstream, ahead, behind, [(status, path, untracked, xy)]) from
    porcelain v2. `upstream` is "" when the branch has never been pushed —
    which is also when ahead/behind stay 0, so the two can't be told apart
    from the counts alone.

    `xy` is porcelain's raw pair: X is the index (staged) state, Y the working
    tree's, `.` meaning unchanged — that pair is the whole staged/unstaged
    split the CHANGES panel draws."""
    branch, upstream, ahead, behind, entries = "", "", 0, 0, []
    for line in raw.splitlines():
        if line.startswith("# branch.head"):
            branch = line[len("# branch.head"):].strip()
        elif line.startswith("# branch.upstream"):
            upstream = line[len("# branch.upstream"):].strip()
        elif line.startswith("# branch.ab"):
            for tok in line.split():
                if tok.startswith("+"):
                    ahead = int(tok[1:] or 0)
                elif tok.startswith("-"):
                    behind = int(tok[1:] or 0)
        elif line[:1] == "1":
            xy = line.split(" ", 2)[1]
            entries.append((_status_letter(xy),
                            line.split(" ", 8)[8] if len(line.split(" ", 8)) > 8 else "", False, xy))
        elif line[:1] == "2":
            parts = line.split(" ", 9)
            rest = parts[9] if len(parts) > 9 else ""
            xy = line.split(" ", 2)[1]
            entries.append((_status_letter(xy), rest.split("\t")[0], False, xy))
        elif line.startswith("u "):
            # A conflict's XY is both sides (UU, AA…), which would file it under
            # staged AND unstaged. It belongs in neither until it's resolved, so
            # it reports as unstaged only.
            entries.append(("U", line.rsplit(" ", 1)[-1], False, ".U"))
        elif line.startswith("? "):
            entries.append(("?", line[2:], True, "??"))
    return branch, upstream, ahead, behind, entries


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
    # -uall: git collapses a wholly-untracked directory into one "dir/" entry,
    # which has no line count and no diff — the CHANGES panel drew it as an
    # unreadable +0 -0 row. Listing the files inside costs a deeper walk on a
    # dirty tree; ignored directories are still pruned, so it's bounded.
    rc, out, _ = _run(cwd, "-c", "core.quotePath=false",
                      "status", "--porcelain=v2", "--branch", "-uall")
    return out if rc == 0 else None


def badge(cwd: str) -> dict | None:
    if not is_repo(cwd):
        return None
    branch, upstream, ahead, behind, entries = _parse(_porcelain(cwd) or "")
    return {"branch": branch, "upstream": upstream,
            "ahead": ahead, "behind": behind, "dirty": len(entries),
            "branches": len(branches(cwd)),
            # linked worktrees only (main checkout excluded), matching WORKTREES tab
            "worktrees": sum(1 for w in worktrees(cwd) if not w.get("is_main"))}


def status(cwd: str) -> dict:
    if not is_repo(cwd):
        return {"is_repo": False, "branch": "", "upstream": "", "ahead": 0, "behind": 0,
                "dirty": 0, "files": []}
    branch, upstream, ahead, behind, entries = _parse(_porcelain(cwd) or "")
    nums = _numstat(cwd)
    files = []
    for st, path, untracked, xy in entries:
        add, dele = nums.get(path, [0, 0])
        if untracked:
            add = _count_lines(os.path.join(cwd, path))
        files.append({"path": path, "status": st, "add": add, "del": dele,
                      "x": xy[0], "y": xy[1]})
    return {"is_repo": True, "branch": branch, "upstream": upstream,
            "ahead": ahead, "behind": behind,
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


def _has_staged(cwd: str) -> bool:
    # rc 1 = the index differs from HEAD. 0 = nothing staged, anything else
    # (no HEAD yet, broken repo) is read as nothing staged so commit still
    # falls back to staging everything.
    rc, _o, _e = _run(cwd, "diff", "--cached", "--quiet")
    return rc == 1


def commit(cwd: str, message: str) -> tuple[bool, str]:
    """Commit the index; with nothing staged, stage everything first. That's the
    VS Code rule, and it's what makes CHANGES' staged section mean anything —
    an unconditional `add -A` would sweep up the changes you deliberately left
    out. With an empty index the behaviour is unchanged: commit all."""
    if not _has_staged(cwd):
        rc, out, err = _run(cwd, "add", "-A")
        if rc != 0:
            return False, (err or out or "git add failed").strip()
    rc, out, err = _run(cwd, "commit", "-m", message)
    return rc == 0, (out + err).strip()


def _safe_paths(cwd: str, paths: list[str]) -> list[str]:
    return [p for p in (_mutable_path(cwd, x) for x in paths) if p]


def stage(cwd: str, paths: list[str]) -> tuple[bool, str]:
    safe = _safe_paths(cwd, paths)
    if not safe:
        return False, "no files selected"
    rc, out, err = _run(cwd, "add", "--", *safe)
    return rc == 0, (out + err).strip()


def unstage(cwd: str, paths: list[str]) -> tuple[bool, str]:
    safe = _safe_paths(cwd, paths)
    if not safe:
        return False, "no files selected"
    rc, out, err = _run(cwd, "restore", "--staged", "--", *safe)
    return rc == 0, (out + err).strip()


def discard(cwd: str, paths: list[str]) -> tuple[bool, str]:
    """Throw away working-tree changes. A tracked file goes back to the index;
    an untracked one is deleted, because there is no earlier version to go
    back to — same as VS Code's Discard Changes, and just as unrecoverable."""
    safe = _safe_paths(cwd, paths)
    if not safe:
        return False, "no files selected"
    rc, out, _ = _run(cwd, "-c", "core.quotePath=false", "ls-files", "--", *safe)
    tracked = {p for p in out.splitlines() if p} if rc == 0 else set()
    ok, notes = True, []
    if tracked:
        rc, out, err = _run(cwd, "restore", "--worktree", "--", *sorted(tracked))
        ok = rc == 0
        notes.append((out + err).strip())
    for rel in safe:
        if rel in tracked:
            continue
        good, note = delete_path(cwd, rel)
        ok = ok and good
        if not good:
            notes.append(note)
    return ok, "\n".join(n for n in notes if n)


def commit_paths(cwd: str, message: str, paths: list[str]) -> tuple[bool, str]:
    """Commit only `paths` (a partial commit): stage exactly those, then commit
    just them via pathspec, leaving any other changes uncommitted."""
    safe = [p for p in (_safe_path(cwd, x) for x in paths) if p]
    if not safe:
        return False, "no files selected"
    rc, out, err = _run(cwd, "add", "--", *safe)
    if rc != 0:
        return False, (err or out or "git add failed").strip()
    rc, out, err = _run(cwd, "commit", "-m", message, "--", *safe)
    return rc == 0, (out + err).strip()


# --- editor: browse / read / write the working tree ------------------------
# Backs the EDITOR tab. Every path is confined to cwd by _safe_path; the caller
# resolves cwd to a project/worktree already inside BASE_PATH.
_MAX_FILE = 1_000_000  # 1 MB — above this the editor won't load/edit the file
# Types the browser renders on its own — handed over as-is, never parsed here,
# so they get a looser cap than text (a 3 MB PDF is an ordinary PDF).
_MAX_MEDIA = 8_000_000
_VIEWABLE = ("image/", "application/pdf", "video/", "audio/")


# ponytail: name-matched skip list, not configurable — these are what turn a
# 1k-path tree into a 60k-path one (node_modules alone is 62k here), and the
# browser holds the whole list in memory. Add a name if another shows up.
_TREE_SKIP = {"node_modules", ".venv", "venv", "__pycache__",
              ".pytest_cache", ".mypy_cache", ".ruff_cache"}


def list_tree(cwd: str) -> list[str]:
    """Every editable file in the working tree — tracked plus untracked,
    .gitignore'd files included (minus _TREE_SKIP) — as sorted repo-relative
    paths. `-z` keeps non-ASCII paths verbatim; empty list if cwd isn't a
    repo."""
    if not is_repo(cwd):
        return []
    rc, out, _ = _run(cwd, "-c", "core.quotePath=false", "ls-files", "-z",
                      "--cached", "--others")
    if rc != 0:
        return []
    return sorted(p for p in set(_ztokens(out))
                  if _TREE_SKIP.isdisjoint(p.split("/")[:-1]))


def ignored_paths(cwd: str) -> list[str]:
    """Which of `list_tree`'s paths .gitignore covers — the editor dims those rows
    the way VS Code does, it never drops them. `--directory` collapses a wholly
    ignored dir to one `dir/` entry, and anything under an entry we already kept is
    redundant, so a 25k-file tree comes back as a handful of prefixes."""
    if not is_repo(cwd):
        return []
    rc, out, _ = _run(cwd, "-c", "core.quotePath=false", "ls-files", "-z",
                      "--others", "--ignored", "--exclude-standard", "--directory")
    if rc != 0:
        return []
    kept: list[str] = []
    for p in sorted(set(_ztokens(out))):
        if not any(p.startswith(d) for d in kept if d.endswith("/")):
            kept.append(p)
    return kept


def read_file(cwd: str, path: str) -> dict:
    """Load a working-tree file for the editor. Returns {ok, path, content,
    binary, too_large, size}; content is "" when binary or too_large. Binary is
    detected by a NUL byte, so genuine source (UTF-8) always loads. Anything the
    browser can display itself — images, PDFs, video, audio — instead carries
    `media` (a data URL) and `mime`, which the editor renders in place of the
    binary placeholder."""
    safe = _safe_path(cwd, path)
    if safe is None:
        return {"ok": False, "error": "path escapes workspace"}
    full = os.path.join(os.path.realpath(cwd), safe)
    if not os.path.isfile(full):
        return {"ok": False, "error": "not a file"}
    ctype = mimetypes.guess_type(full)[0] or ""
    # svg is text the editor should keep editing, not media to hand off
    media = ctype.startswith(_VIEWABLE) and ctype != "image/svg+xml"
    try:
        size = os.path.getsize(full)
        if size > (_MAX_MEDIA if media else _MAX_FILE):
            return {"ok": True, "path": safe, "content": "", "binary": False,
                    "too_large": True, "size": size}
        with open(full, "rb") as f:
            raw = f.read()
    except OSError as e:
        return {"ok": False, "error": str(e)}
    # ponytail: data URL rather than a raw-bytes route — no second authed
    # endpoint to gate, and the cap keeps the JSON payload bounded
    if media:
        return {"ok": True, "path": safe, "content": "", "binary": True,
                "too_large": False, "size": size, "mime": ctype,
                "media": f"data:{ctype};base64,{base64.b64encode(raw).decode()}"}
    if b"\x00" in raw:
        return {"ok": True, "path": safe, "content": "", "binary": True,
                "too_large": False, "size": size}
    return {"ok": True, "path": safe, "content": raw.decode("utf-8", "replace"),
            "binary": False, "too_large": False, "size": size}


def write_file(cwd: str, path: str, content: str) -> tuple[bool, str]:
    """Save `content` to a working-tree file (creating parent dirs). newline=""
    keeps the browser's LF line endings verbatim. Returns (ok, path-or-error)."""
    safe = _mutable_path(cwd, path)
    if safe is None:
        return False, "path escapes workspace"
    full = os.path.join(os.path.realpath(cwd), safe)
    try:
        parent = os.path.dirname(full)
        if parent:
            os.makedirs(parent, exist_ok=True)
        with open(full, "w", encoding="utf-8", newline="") as f:
            f.write(content)
        return True, safe
    except OSError as e:
        return False, str(e)


def grep(cwd: str, query: str, limit: int = 200) -> list[dict]:
    """EDITOR search-in-files: case-insensitive fixed-string search over the
    working tree (tracked + untracked, .gitignore honored, binaries skipped) →
    [{path, line, text}]. `-e` keeps a query starting with `-` from being read
    as a flag. rc 1 just means no matches."""
    if not query or not is_repo(cwd):
        return []
    base = ("-c", "core.quotePath=false", "grep", "-I", "-n", "-i", "-F",
            "--untracked", "--exclude-standard")
    rc, out, _ = _run(cwd, *base, "--max-count", "20", "-e", query, timeout=15)
    if rc > 1:   # --max-count wants git ≥ 2.38 — fall back to an uncapped grep
        rc, out, _ = _run(cwd, *base, "-e", query, timeout=15)
    if rc > 1:
        return []
    hits: list[dict] = []
    for line in out.splitlines():
        path, _, rest = line.partition(":")
        num, _, text = rest.partition(":")
        if not num.isdigit():
            continue
        hits.append({"path": path, "line": int(num), "text": text.strip()[:200]})
        if len(hits) >= limit:
            break
    return hits


def create_path(cwd: str, path: str, directory: bool = False) -> tuple[bool, str]:
    """New empty file (with parents) or new directory. Refuses to clobber."""
    safe = _mutable_path(cwd, path)
    if safe is None:
        return False, "path escapes workspace"
    full = os.path.join(os.path.realpath(cwd), safe)
    if os.path.exists(full):
        return False, "already exists"
    try:
        if directory:
            os.makedirs(full)
        else:
            os.makedirs(os.path.dirname(full), exist_ok=True)
            with open(full, "x"):
                pass
    except OSError as e:
        return False, str(e)
    return True, safe


def rename_path(cwd: str, path: str, to: str) -> tuple[bool, str]:
    """Rename/move a file or directory inside the working tree."""
    src = _mutable_path(cwd, path)
    dst = _mutable_path(cwd, to)
    if src is None or dst is None:
        return False, "path escapes workspace"
    root = os.path.realpath(cwd)
    full_src, full_dst = os.path.join(root, src), os.path.join(root, dst)
    if not os.path.exists(full_src):
        return False, "not found"
    if os.path.exists(full_dst):
        return False, "already exists"
    try:
        parent = os.path.dirname(full_dst)
        if parent:
            os.makedirs(parent, exist_ok=True)
        os.rename(full_src, full_dst)
    except OSError as e:
        return False, str(e)
    return True, dst


def delete_path(cwd: str, path: str) -> tuple[bool, str]:
    """Delete a file, or a directory and its contents."""
    safe = _mutable_path(cwd, path)
    if safe is None:
        return False, "path escapes workspace"
    full = os.path.join(os.path.realpath(cwd), safe)
    try:
        if os.path.isdir(full) and not os.path.islink(full):
            shutil.rmtree(full)
        else:
            os.remove(full)
    except OSError as e:
        return False, str(e)
    return True, safe


def diff_multi(cwd: str, paths: list[str], limit: int = 8000) -> str:
    """Concatenated working-tree diff for `paths` (tracked + untracked), capped at
    `limit` chars — feeds commit-message generation without unbounded token cost."""
    chunks: list[str] = []
    total = 0
    for p in paths:
        d = diff(cwd, p)
        if not d:
            continue
        chunks.append(d)
        total += len(d)
        if total >= limit:
            break
    return "\n".join(chunks)[:limit]


_FENCE_RE = re.compile(r"^```[^\n]*\n(.*)\n```$", re.S)


def clean_commit_message(raw: str) -> str:
    """Strip a model's markdown code fence / wrapping quotes from a commit message."""
    s = (raw or "").strip()
    m = _FENCE_RE.match(s)
    if m:
        s = m.group(1).strip()
    if len(s) >= 2 and s[0] == '"' and s[-1] == '"' and '"' not in s[1:-1]:
        s = s[1:-1].strip()
    return s[:2000]


def push(cwd: str, timeout: int = 30) -> tuple[bool, str]:
    """Send this branch to its remote. A branch the remote has never seen has no
    upstream, and plain `git push` refuses it ("no upstream branch") — publish it
    with `-u` instead, which is what every caller means either way. Asked with
    rev-parse rather than by matching git's error text, which is localized."""
    published = _run(cwd, "rev-parse", "--abbrev-ref", "@{u}")[0] == 0
    args = ("push",) if published else ("push", "-u", "origin", "HEAD")
    rc, out, err = _run(cwd, *args, timeout=timeout)
    return rc == 0, (out + err).strip()


def fetch(cwd: str, timeout: int = 20) -> bool:
    """Refresh the remote-tracking refs, so status()'s behind count is current."""
    rc, _o, _e = _run(cwd, "fetch", "--quiet", timeout=timeout)
    return rc == 0


def pull(cwd: str, timeout: int = 60) -> tuple[bool, str]:
    """Fast-forward only: never merges or rebases local work behind your back —
    a diverged or dirty tree fails loudly with git's own message."""
    rc, out, err = _run(cwd, "pull", "--ff-only", timeout=timeout)
    return rc == 0, (out + err).strip()


def incoming(cwd: str, limit: int = 20) -> list[dict]:
    """Commits the upstream branch has that this checkout doesn't (newest first).
    Empty when there's no upstream configured. Needs a recent fetch() to be true."""
    rc, out, _ = _run(cwd, "log", f"-{limit}", "--format=%h\t%s", "HEAD..@{u}")
    if rc != 0:
        return []
    commits = []
    for line in out.splitlines():
        sha, _, subject = line.partition("\t")
        if sha:
            commits.append({"sha": sha, "subject": subject})
    return commits


_LOG_FMT = "%H\x1f%P\x1f%an\x1f%at\x1f%D\x1f%s"


def log_graph(cwd: str, limit: int = 200) -> list[dict]:
    """Commits across every ref, newest first, each with its parent shas — the raw
    material the dashboard lays out into lanes. --date-order, not --topo-order:
    topo reshuffles unrelated branches to keep each one contiguous, which makes
    lanes jump around between polls."""
    if not is_repo(cwd):
        return []
    rc, out, _ = _run(cwd, "log", "--all", "--date-order",
                      f"--max-count={max(1, min(limit, 1000))}",
                      f"--format={_LOG_FMT}", timeout=15)
    if rc != 0:
        return []
    commits = []
    for line in out.splitlines():
        parts = line.split("\x1f")
        if len(parts) != 6:
            continue
        sha, parents, author, ts, refs, subject = parts
        commits.append({
            "sha": sha,
            "parents": parents.split(),
            "author": author,
            "ts": int(ts) if ts.isdigit() else 0,
            # origin/HEAD is a symref alias for the default branch — it always
            # duplicates a ref right next to it, so it's pure noise in a chip.
            "refs": [r.strip() for r in refs.split(",")
                     if r.strip() and not r.strip().endswith("/HEAD")],
            "subject": subject,
        })
    return commits


# --- branches & worktrees (powers the unified projects+sessions view) ---

def current_branch(cwd: str) -> str:
    """The name to show for where a checkout is. Detached HEAD answers "HEAD",
    which names nothing and is what every branch chip ended up drawing, so
    resolve it: a ref pointing at this exact commit (a `git checkout origin/foo`
    or a tag, sorted so a local branch wins), else the branch name-rev found this
    commit under (a worktree whose branch was carried off to another checkout
    sits exactly here), else the short sha — git's own "HEAD detached at
    1383914". name-rev's distance suffix is dropped: "staging~1" is a revision,
    not a branch, and a chip has room for one name — worktree_name is what tells
    two trees on the same branch apart. A remote-tracking ref drops its remote:
    the chip names a branch, and "origin/" says where the ref is stored, not
    which branch this is — the local one is gone (deleted after merge) as often
    as not."""
    rc, out, _ = _run(cwd, "rev-parse", "--abbrev-ref", "HEAD")
    name = out.strip() if rc == 0 else ""
    if name != "HEAD":
        return name
    rc, out, _ = _run(cwd, "for-each-ref", "--points-at", "HEAD", "--count=1",
                      "--exclude=refs/remotes/*/HEAD",
                      "--format=%(refname)\x1f%(refname:short)",
                      "refs/heads", "refs/remotes", "refs/tags")
    if rc == 0 and out.strip():
        full, _, short = out.strip().splitlines()[0].partition("\x1f")
        return short.split("/", 1)[1] if full.startswith("refs/remotes/") else short
    rc, out, _ = _run(cwd, "name-rev", "--name-only", "--refs=refs/heads/*", "HEAD")
    name = out.strip() if rc == 0 else ""
    if name and name != "undefined":
        return re.split(r"[~^]", name)[0]
    rc, out, _ = _run(cwd, "rev-parse", "--short", "HEAD")
    return out.strip() if rc == 0 else ""


def worktree_name(cwd: str) -> str:
    """The directory name of the linked worktree `cwd` sits in, "" when it is the
    repo's main checkout (or no repo at all). A branch alone doesn't say where a
    session's commits land — two trees can answer "staging", one of them detached
    because the branch moved to the other — so the chip needs this next to it.
    A linked worktree's `.git` is a *file* pointing at the main repo's admin dir,
    which makes the whole test one stat: no `git worktree list` subprocess per
    session per poll, and no cache to keep warm."""
    d = os.path.abspath(cwd) if cwd else ""
    while d:
        g = os.path.join(d, ".git")
        if os.path.exists(g):
            return os.path.basename(d) if os.path.isfile(g) else ""
        parent = os.path.dirname(d)
        if parent == d:
            return ""
        d = parent
    return ""


def head_sha(cwd: str) -> str:
    """The commit HEAD points at, "" outside a repo or on an unborn branch.
    Moves on every commit, which a branch name does not — the next-up cache keys
    on it to decide whether a repo is worth looking at again."""
    rc, out, _ = _run(cwd, "rev-parse", "HEAD")
    return out.strip() if rc == 0 else ""


_branch_cache: dict[str, tuple[str, float]] = {}
_BRANCH_TTL = 3.0


def current_branch_cached(cwd: str) -> str:
    """current_branch with a short TTL cache. /local/sessions polls every 5s and
    many sessions share one cwd (the project dir), so this avoids spawning a git
    per session on every poll."""
    if not cwd:
        return ""
    now = time.monotonic()
    hit = _branch_cache.get(cwd)
    if hit is not None and now - hit[1] < _BRANCH_TTL:
        return hit[0]
    b = current_branch(cwd)
    _branch_cache[cwd] = (b, now)
    return b


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
    rc, out, _ = _run(cwd, "for-each-ref", "--format=%(refname:short)", "--sort=-committerdate", "refs/heads")
    names = [b.strip() for b in out.splitlines() if b.strip()] if rc == 0 else []
    cur = current_branch(cwd)
    if cur and cur in names:
        names.remove(cur)
        names.insert(0, cur)
    return names


def merged_branches(cwd: str, base: str = "") -> list[str]:
    """Local branches already contained in `base` — the work is in, so the branch
    and its worktree are only taking up space. `base` defaults to the repo's
    default branch, which is what a PR would have targeted.

    Contained, not "was merged": a squash-merged or rebased branch is not reported,
    because its commits are no longer ancestors of base. That is the honest answer
    one git call can give — anything better means comparing trees per branch."""
    if not is_repo(cwd):
        return []
    base = base or default_branch(cwd)
    # --merged takes an *optional* argument, so it has to be attached with '=';
    # `--merged base` would read base as a positional pattern instead.
    rc, out, _ = _run(cwd, "branch", f"--merged={base}", "--format=%(refname:short)")
    if rc != 0:
        return []
    return [b for b in (x.strip() for x in out.splitlines()) if b and b != base]


def checkout(cwd: str, ref: str) -> tuple[bool, str]:
    # --end-of-options: a ref beginning with '-' must be treated as a ref, never
    # parsed as a git option (plain '--' would make checkout read it as a pathspec).
    rc, out, err = _run(cwd, "checkout", "--end-of-options", ref)
    return rc == 0, (out + err).strip()


def delete_branch(cwd: str, name: str, force: bool = False) -> tuple[bool, str]:
    if name in ("main", "master", current_branch(cwd)):
        return False, "refusing to delete the current/default branch"
    rc, out, err = _run(cwd, "branch", "-D" if force else "-d", "--end-of-options", name)
    return rc == 0, (out + err).strip()


def merge(cwd: str, branch: str, ff_only: bool = False) -> tuple[bool, str]:
    """Merge `branch` into the current branch."""
    args = ["merge", "--ff-only" if ff_only else "--no-edit", "--end-of-options", branch]
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


# A session's shell can walk out of the checkout claude was spawned in — `cd
# <worktree> && git commit` is the normal way an agent works a feature branch —
# and from then on the session's stored cwd names a branch nobody is touching.
# These two answer "where is this session's shell, really", for the branch label
# every surface shows. Only a literal `cd` counts: a command that merely reads a
# path is not working there.
_CD = re.compile(
    r"""(?:^|&&|\|\||;|\n)\s*cd\s+(?:-[PL]\s+|--\s+)*"""
    r"""("[^"]*"|'[^']*'|[^\s;&|<>]+)""")


def shell_cd_target(command: str) -> str:
    """The absolute directory the *last* `cd` in a shell command line moves to,
    "" when there is none. Last wins because that is where the rest of the line
    runs. Relative targets are dropped rather than guessed at — resolving them
    needs the shell's own cwd, which we don't have."""
    last = ""
    for m in _CD.finditer(command or ""):
        raw = m.group(1).strip("\"'")
        if raw:
            last = os.path.expanduser(raw)
    return last if last.startswith("/") else ""


def is_worktree_of(cwd: str, path: str) -> bool:
    """True when git lists `path` as a worktree of the repo at `cwd`. Git is the
    source of truth, not the path shape: a worktree may live under our
    `.worktrees/` convention, under Claude Code's `.claude/worktrees/`, or
    anywhere a hand-made `git worktree add` put it."""
    if not path:
        return False
    want = os.path.realpath(path)
    return any(os.path.realpath(w["path"]) == want for w in worktrees(cwd))


def worktree_add(cwd: str, path: str, branch: str, start: str = "",
                 create: bool = True) -> tuple[bool, str]:
    """Add a worktree at `path`. create=True makes a new branch `branch` from
    `start`; create=False checks out an existing `branch` into the worktree."""
    # --end-of-options guards the positional path/commit-ish against a leading '-'
    # being read as an option (the -b value is consumed literally, so it's safe).
    if create:
        args = ["worktree", "add", "-b", branch, "--end-of-options", path] + ([start] if start else [])
    else:
        args = ["worktree", "add", "--end-of-options", path, branch]
    rc, out, err = _run(cwd, *args, timeout=30)
    return rc == 0, (out + err).strip()


def worktree_remove(cwd: str, path: str, force: bool = True) -> tuple[bool, str]:
    args = ["worktree", "remove"] + (["--force"] if force else []) + ["--end-of-options", path]
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


def _diff_files(cwd: str, *cmd: str) -> tuple[list[dict], int, int]:
    """([{name, mark, add, del}], total_add, total_del) for a `git diff`/`git show`
    invocation, run twice: --name-status for the letter, --numstat for the counts.

    -z keeps paths verbatim (no C-quoting of non-ASCII) and splits rename/copy
    entries into separate NUL fields, so every `name` is a real, diffable path —
    not the `old => new` numstat form or a "caf\\303\\251" quoted name."""
    marks: dict[str, str] = {}
    rc, out, _ = _run(cwd, *cmd, "--name-status", "-z")
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
    rc, out, _ = _run(cwd, *cmd, "--numstat", "-z")
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
    return files, total_add, total_del


_SHA_RE = re.compile(r"^[0-9a-f]{7,40}$")


def commit_files(cwd: str, sha: str) -> dict:
    """What a single commit changed — same file shape as compare(). Powers clicking
    a row in the dashboard's commit graph. A merge gets git's combined diff (only
    what differs from every parent), i.e. the conflict resolutions rather than both
    sides replayed."""
    if not _SHA_RE.match(sha) or not is_repo(cwd):
        return {"ok": False, "files": [], "add": 0, "del": 0}
    files, add, dele = _diff_files(cwd, "show", "--format=", sha)
    return {"ok": True, "files": files, "add": add, "del": dele}


def show_file(cwd: str, sha: str, path: str) -> str:
    """One file's diff from one commit (`git show <sha> -- <path>`)."""
    safe = _safe_path(cwd, path)
    if safe is None or not _SHA_RE.match(sha):
        return ""
    _rc, out, _err = _run(cwd, "show", "--format=", sha, "--", safe)
    return out


def since(cwd: str, sha: str) -> dict:
    """How far the tree has drifted from a commit — `git diff <sha>`, i.e. commits
    AND uncommitted work. Powers a checkpoint's "+42 −7 since here"; same file shape
    as compare(). Note it measures from that commit, not from that turn: several
    checkpoints taken between two commits all report the same numbers."""
    if not _SHA_RE.match(sha) or not is_repo(cwd):
        return {"ok": False, "files": [], "add": 0, "del": 0}
    files, add, dele = _diff_files(cwd, "diff", sha)
    return {"ok": True, "files": files, "add": add, "del": dele}


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
    files, total_add, total_del = _diff_files(cwd, "diff", rng)
    return {"ok": True, "commits": ahead, "ahead": ahead, "behind": behind,
            "files": files, "add": total_add, "del": total_del}
