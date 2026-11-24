"""Read git status/diff and perform commit/push for a working tree. Stdlib only;
every call shells out to `git -C <cwd> …` with a timeout. Callers pass an absolute
cwd already confined to BASE_PATH by the dashboard's _abs_project."""

import base64
import glob
import mimetypes
import os
import re
import shutil
import subprocess
import time

from bridge import config


def _run(cwd: str, *args: str, timeout: int = 8,
         env: dict | None = None, errors: str | None = None) -> tuple[int, str, str]:
    try:
        p = subprocess.run(["git", "-C", cwd, *args], capture_output=True,
                           text=True, timeout=timeout, env=env, errors=errors)
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

    `# branch.upstream` only names the *configured* upstream: git prints it
    even when the remote has no such branch (never pushed, deleted there,
    config carried over from another clone). Only a remote ref that exists adds
    `# branch.ab`, so without that line the upstream counts as "".

    `xy` is porcelain's raw pair: X is the index (staged) state, Y the working
    tree's, `.` meaning unchanged — that pair is the whole staged/unstaged
    split the CHANGES panel draws."""
    branch, upstream, ahead, behind, entries = "", "", 0, 0, []
    tracked = False
    for line in raw.splitlines():
        if line.startswith("# branch.head"):
            branch = line[len("# branch.head"):].strip()
        elif line.startswith("# branch.upstream"):
            upstream = line[len("# branch.upstream"):].strip()
        elif line.startswith("# branch.ab"):
            tracked = True
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
    return branch, upstream if tracked else "", ahead, behind, entries


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
    """Three git runs: GET /local/git/all asks this of every sidebar repo each 10 s.
    status fails outside a work tree, so it answers is_repo too."""
    porcelain = _porcelain(cwd)
    if porcelain is None:
        return None
    branch, upstream, ahead, behind, entries = _parse(porcelain)
    rc, heads, _ = _run(cwd, "for-each-ref", "--format=%(refname)", "refs/heads")
    rc2, trees, _ = _run(cwd, "worktree", "list", "--porcelain")
    return {"branch": branch, "upstream": upstream,
            "ahead": ahead, "behind": behind, "dirty": len(entries),
            "branches": len(heads.split()) if rc == 0 else 0,
            # linked worktrees only (main checkout excluded), matching WORKTREES tab
            "worktrees": max(0, sum(ln.startswith("worktree ") for ln in trees.splitlines()) - 1)
                         if rc2 == 0 else 0}


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
    st = {"is_repo": True, "branch": branch, "upstream": upstream,
          "ahead": ahead, "behind": behind,
          "dirty": len(files), "files": files, "fetched_at": _fetched_at(cwd)}
    if branch and branch != "(detached)" and not upstream:
        st["unpublished"] = _unpublished(cwd)
    return st


def _fetched_at(cwd: str) -> float | None:
    """When this repo last fetched, from any of its checkouts: FETCH_HEAD is per
    worktree, but the remote-tracking refs a fetch moves are shared, so the
    newest one says how fresh status()'s behind count is. None = never."""
    rc, out, _ = _run(cwd, "rev-parse", "--git-common-dir")
    if rc != 0:
        return None
    common = os.path.join(cwd, out.strip())
    newest = None
    for head in [os.path.join(common, "FETCH_HEAD"),
                 *glob.glob(os.path.join(common, "worktrees", "*", "FETCH_HEAD"))]:
        try:
            t = os.path.getmtime(head)
        except OSError:
            continue
        newest = t if newest is None else max(newest, t)
    return newest


def _unpublished(cwd: str) -> int | None:
    """Commits a publish would send (on no remote branch yet), or None when
    there is no origin to publish to — push() publishes to origin."""
    if _run(cwd, "remote", "get-url", "origin")[0] != 0:
        return None
    rc, out, _ = _run(cwd, "rev-list", "--count", "HEAD", "--not", "--remotes")
    return int(out.strip() or 0) if rc == 0 else 0


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
    repo. The skip list also goes to git as exclude pathspecs so it never
    walks those dirs: on this repo that is 52k paths (4.5MB) down to 3.4k, and
    94ms down to 8ms. The Python filter stays — it is the exact-component
    check the globs only approximate."""
    if not is_repo(cwd):
        return []
    rc, out, _ = _run(cwd, "-c", "core.quotePath=false", "ls-files", "-z",
                      "--cached", "--others", "--", ".",
                      *(f":(exclude,glob)**/{d}/**" for d in sorted(_TREE_SKIP)))
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


def _is_text(raw: bytes) -> bool:
    if b"\x00" in raw[:8192]:
        return False
    try:
        raw.decode("utf-8")   # a real video or image fails within its first bytes
    except UnicodeDecodeError:
        return False
    return True


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
    # The type was guessed from the extension alone, and `.ts` is MPEG-TS video
    # to mimetypes: TypeScript opened as a video player. Bytes with no NUL that
    # decode as UTF-8 are source, so they load as text under the text cap.
    if media and _is_text(raw):
        media = False
        if size > _MAX_FILE:
            return {"ok": True, "path": safe, "content": "", "binary": False,
                    "too_large": True, "size": size}
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


def read_head(cwd: str, path: str) -> dict:
    """A working-tree file as committed at HEAD → {ok, path, exists, content}.
    `cat-file blob` rather than file_at(): one call tells "absent" from "empty",
    and a directory or a repo with no commits fails it instead of printing a
    tree. `./` keeps the path cwd-relative like every other editor path."""
    safe = _safe_path(cwd, path)
    if safe is None:
        return {"ok": False, "error": "path escapes workspace"}
    rc, out, _ = _run(cwd, "cat-file", "blob", f"HEAD:./{safe}")
    return {"ok": True, "path": safe, "exists": rc == 0, "content": out if rc == 0 else ""}


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


_IDENT = re.compile(r"[A-Za-z_$][\w$]*")
# Declaration shapes for go-to-definition, %s = the escaped identifier. POSIX
# ERE: `git grep -E` knows no \s or \w.
_DEF_PATTERNS = (
    # function foo( · def foo( · class Foo · const foo = · type Foo = · fn foo
    r"(^|[^[:alnum:]_$])(function\*?|def|class|interface|type|enum|struct|trait"
    r"|fn|func|const|let|var)[[:space:]]+%s([^[:alnum:]_$]|$)",
    # fileWrite: (project) => · foo = () => · foo = async (
    r"^[[:space:]]*(export[[:space:]]+)?((static|async|public|private|protected"
    r"|readonly)[[:space:]]+)*%s[[:space:]]*(\??:|=)[[:space:]]*(async[[:space:]]+)?"
    r"(\(|function|<)",
    # save() { · async load(x: T): Promise<void> {  — not the call foo(a, () => {
    r"^[[:space:]]*((static|async|public|private|protected|get|set)[[:space:]]+)*"
    r"%s[[:space:]]*\(.*\)[[:space:]]*(:[^=]*)?\{[[:space:]]*$",
)


def grep(cwd: str, query: str, limit: int | None = None, mode: str = "") -> list[dict]:
    """EDITOR search-in-files: case-insensitive fixed-string search over the
    working tree (tracked + untracked, .gitignore honored, binaries skipped) →
    [{path, line, text}]. `-e` keeps a query starting with `-` from being read
    as a flag. rc 1 just means no matches.

    mode="word" is find-references: case-sensitive, whole word. mode="def" is
    go-to-definition: `query` must be an identifier (else [] — no regex is ever
    built from raw input), tried against _DEF_PATTERNS. Each mode has its own
    per-file cap and default `limit`."""
    if not query or not is_repo(cwd):
        return []
    if mode == "word":
        args, cap, top = ["-w", "-F", "-e", query], "50", 300
    elif mode == "def":
        if not _IDENT.fullmatch(query):
            return []
        name = query.replace("$", r"\$")   # the one ERE metachar an identifier can hold
        args, cap, top = ["-E"] + [a for p in _DEF_PATTERNS for a in ("-e", p % name)], "20", 100
    else:
        args, cap, top = ["-i", "-F", "-e", query], "20", 200
    base = ("-c", "core.quotePath=false", "grep", "-I", "-n",
            "--untracked", "--exclude-standard")
    rc, out, _ = _run(cwd, *base, "--max-count", cap, *args, timeout=15)
    if rc > 1:   # --max-count wants git ≥ 2.38 — fall back to an uncapped grep
        rc, out, _ = _run(cwd, *base, *args, timeout=15)
    if rc > 1:
        return []
    hits: list[dict] = []
    for line in out.splitlines():
        path, _, rest = line.partition(":")
        num, _, text = rest.partition(":")
        if not num.isdigit():
            continue
        hits.append({"path": path, "line": int(num), "text": text.strip()[:200]})
        if len(hits) >= (limit or top):
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


def fetch(cwd: str, timeout: int = 20) -> tuple[bool, str]:
    """Refresh the remote-tracking refs, so status()'s behind count is current.
    The dashboard also runs it unasked (auto-fetch), so a remote that wants a
    password fails at once instead of prompting on a hand-launched bridge's tty."""
    rc, out, err = _run(cwd, "fetch", "--quiet", timeout=timeout,
                        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"})
    return rc == 0, (out + err).strip()


def pull(cwd: str, timeout: int = 60) -> tuple[bool, str]:
    """Fast-forward only: never merges or rebases local work behind your back —
    a diverged or dirty tree fails loudly with git's own message."""
    rc, out, err = _run(cwd, "pull", "--ff-only", timeout=timeout)
    return rc == 0, (out + err).strip()


def merge_check(cwd: str, ours: str = "HEAD", theirs: str = "@{u}") -> "list[str] | None":
    """The files merging `theirs` (the upstream) into `ours` (HEAD) would clash in,
    from a dry run: `git merge-tree --write-tree` merges in memory and touches no
    file, index or ref (the merged objects it writes are left for gc). [] = merges
    cleanly; None = couldn't tell (git before 2.38, no upstream)."""
    rc, out, _ = _run(cwd, "merge-tree", "-z", "--write-tree", "--name-only", "--no-messages",
                      "--end-of-options", ours, theirs, timeout=20)
    return [p for p in out.split("\0")[1:] if p] if rc in (0, 1) else None


def merge_upstream(cwd: str, theirs: str = "@{u}") -> tuple[bool, str, list[str]]:
    """The GIT tab's Merge on a diverged branch: the upstream merged into HEAD as
    a merge commit, never a rebase, so this branch's commits keep their shas.
    A clash never starts: the dry run says so first, and one it missed (a race)
    is undone at once (`merge --abort`). Either way its files come back and the
    tree is as it was. Without a dry run (old git) it won't merge over
    uncommitted edits, since an abort can't always give those back."""
    clash = merge_check(cwd, theirs=theirs)
    if clash:
        return False, "Merging would clash, so nothing was changed.", clash
    if clash is None and _run(cwd, "status", "--porcelain", "--untracked-files=no")[1].strip():
        return False, ("This git can't test a merge before running it, so it won't merge "
                       "over uncommitted changes. Commit or stash them first."), []
    ok, output = merge(cwd, theirs)
    if ok or _run(cwd, "rev-parse", "-q", "--verify", "MERGE_HEAD")[0] != 0:
        return ok, output, []
    _, names, _ = _run(cwd, "diff", "-z", "--name-only", "--diff-filter=U")
    _run(cwd, "merge", "--abort")
    return False, output, [p for p in names.split("\0") if p]


def _commits(cwd: str, rng: str, limit: int, *more: str) -> list[dict]:
    rc, out, _ = _run(cwd, "log", f"-{limit}", "--format=%h\t%ct\t%s", rng, *more)
    if rc != 0:
        return []
    commits = []
    for line in out.splitlines():
        sha, ts, subject = (line.split("\t", 2) + ["", ""])[:3]
        if sha:
            commits.append({"sha": sha, "subject": subject, "ts": int(ts or 0)})
    return commits


def incoming(cwd: str, limit: int = 20) -> list[dict]:
    """Commits the upstream branch has that this checkout doesn't (newest first).
    Empty when there's no upstream configured. Needs a recent fetch() to be true."""
    return _commits(cwd, "HEAD..@{u}", limit)


def outgoing(cwd: str, limit: int = 20) -> list[dict]:
    """The mirror: commits here that the upstream doesn't have — what a push
    sends (newest first). With no upstream push() publishes the branch, so it
    sends what no remote has yet, like status()'s unpublished."""
    if _run(cwd, "rev-parse", "-q", "--verify", "@{u}")[0] == 0:
        return _commits(cwd, "@{u}..HEAD", limit)
    return _commits(cwd, "HEAD", limit, "--not", "--remotes")


def base_ref(cwd: str, base: str) -> str:
    """The ref a branch is compared with: origin's copy of `base` when there is
    one (what a PR lands on), else the local branch; "" when neither exists."""
    for ref in (f"origin/{base}", base):
        if base and _run(cwd, "rev-parse", "-q", "--verify", f"{ref}^{{commit}}")[0] == 0:
            return ref
    return ""


def ledger(cwd: str, base: str = "", limit: int = 30) -> dict:
    """The GIT tab's line below the working tree. `local`: commits only on this
    machine (what a push sends; with no upstream, everything `base` lacks).
    `shipped`: on origin but not in `base` yet. `ahead`/`behind`: HEAD against
    `base` (behind = the base moved). base "" (the branch is its own base, or
    none is set) gives the local list alone."""
    has_up = _run(cwd, "rev-parse", "-q", "--verify", "@{u}")[0] == 0
    ref = base_ref(cwd, base)
    out = {"base": base if ref else "", "ref": ref, "ahead": 0, "behind": 0, "shipped": [], "shipped_n": 0,
           "local": _commits(cwd, "@{u}..HEAD" if has_up else f"{ref}..HEAD", limit) if has_up or ref else []}
    if not ref:
        return out
    out["ahead"], out["behind"] = _left_right(cwd, ref, "HEAD") or (0, 0)
    if has_up:
        # Not `ref..@{u}`: behind origin, that would list commits this checkout doesn't have.
        rc, mb, _ = _run(cwd, "merge-base", "HEAD", "@{u}")
        if rc == 0 and mb.strip():
            out["shipped"] = _commits(cwd, f"{ref}..{mb.strip()}", limit)
            rc, n, _ = _run(cwd, "rev-list", "--count", f"{ref}..{mb.strip()}")
            out["shipped_n"] = int(n) if rc == 0 and n.strip().isdigit() else len(out["shipped"])
    return out


def undo_commit(cwd: str) -> tuple[bool, str]:
    """Take the newest commit back, keeping its changes staged (`reset --soft`).
    Only a commit that never left this machine, and never a merge: undoing a
    pushed commit would need a force push, and a merge's second parent is lost."""
    rc, parents, _ = _run(cwd, "rev-list", "--parents", "-1", "HEAD")
    if rc != 0 or len(parents.split()) != 2:
        return False, "Only a plain commit with a parent can be undone here."
    if _run(cwd, "rev-parse", "-q", "--verify", "@{u}")[0] == 0:
        rc, n, _ = _run(cwd, "rev-list", "--count", "@{u}..HEAD")
        if rc != 0 or n.strip() in ("", "0"):
            return False, "That commit is already on origin, so it stays."
    rc, out, err = _run(cwd, "reset", "--soft", "HEAD~1")
    return rc == 0, (out + err).strip()


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
    if not os.path.isdir(cwd):            # a removed worktree: git would only fail
        return ""
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


def main_checkout(cwd: str) -> str:
    """The checkout a session in `cwd` belongs to — `cwd` itself, unless it sits
    inside a linked worktree, in which case the repo that worktree was added
    from. A worktree is a branch of a project, not a second project: a bridge
    session already keeps the parent's rel as its project and the worktree as its
    cwd, so anything else deriving a project from a cwd has to fold the same way
    or the sidebar grows a group per branch.

    A linked worktree's `.git` file reads `gitdir: <main>/.git/worktrees/<name>`,
    so the parent is two levels above that — one file read, no subprocess (same
    reason as worktree_name). A submodule's `.git` file points at
    `<super>/.git/modules/<name>` and is deliberately left alone: it is a
    different repository, not another view of this one."""
    d = os.path.abspath(cwd) if cwd else ""
    while d and not os.path.exists(os.path.join(d, ".git")):
        d, up = os.path.dirname(d), d
        if d == up:
            return cwd
    g = os.path.join(d, ".git") if d else ""
    if not (g and os.path.isfile(g)):
        return cwd                       # the main checkout, or no repo at all
    try:
        with open(g, encoding="utf-8") as fh:
            gitdir = fh.read().strip().partition("gitdir:")[2].strip()
    except OSError:
        return cwd
    head, sep, _name = gitdir.rpartition("/worktrees/")
    if not sep:
        return cwd
    top = os.path.dirname(head)          # <main>/.git -> <main>
    return top if os.path.isdir(os.path.join(top, ".git")) else cwd


def head_sha(cwd: str) -> str:
    """The commit HEAD points at, "" outside a repo or on an unborn branch.
    Moves on every commit, which a branch name does not — the next-up cache keys
    on it to decide whether a repo is worth looking at again."""
    rc, out, _ = _run(cwd, "rev-parse", "HEAD")
    return out.strip() if rc == 0 else ""


_branch_cache: dict[str, tuple[str, float, "tuple | None"]] = {}
_BRANCH_TTL = 3.0      # a cwd that is no checkout's root: ask git again after this
_BRANCH_HOLD = 60.0    # an unmoved HEAD: refs can still rename a detached one


def _head_stamp(cwd: str) -> "tuple | None":
    """(inode, mtime) of the HEAD of the checkout rooted at cwd: .git/HEAD, or the
    one in the gitdir a linked worktree's .git file names. Git replaces HEAD on
    every checkout, switch and detached commit, so a new stamp is a new answer.
    None when cwd is no checkout's root."""
    dot = os.path.join(cwd, ".git")
    try:
        if os.path.isfile(dot):
            with open(dot, encoding="utf-8") as f:
                line = f.readline().strip()
            if not line.startswith("gitdir:"):
                return None
            dot = os.path.join(cwd, line[len("gitdir:"):].strip())   # an absolute gitdir wins the join
        st = os.stat(os.path.join(dot, "HEAD"))
    except (OSError, UnicodeDecodeError):
        return None
    return st.st_ino, st.st_mtime_ns


def current_branch_cached(cwd: str) -> str:
    """current_branch, asked again once the checkout's HEAD changes, or after
    _BRANCH_HOLD at the latest. /local/sessions asks it for every session on every
    5 s poll: a 3 s TTL alone spawned ~35 gits per poll, 0.3 s of a 0.34 s list
    (Sentry MYSTICAL-9). A cwd that is no checkout's root keeps the TTL."""
    if not cwd:
        return ""
    now, stamp = time.monotonic(), _head_stamp(cwd)
    hit = _branch_cache.get(cwd)
    if hit is not None and hit[2] == stamp and \
            now - hit[1] < (_BRANCH_TTL if stamp is None else _BRANCH_HOLD):
        return hit[0]
    b = current_branch(cwd)
    _branch_cache[cwd] = (b, now, stamp)
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
    # A detached checkout lists as "(HEAD detached at …)": not a branch.
    return [b for b in (x.strip() for x in out.splitlines()) if b and b != base and not b.startswith("(")]


def _left_right(cwd: str, base: str, ref: str) -> "tuple[int, int] | None":
    """(ahead, behind) of `ref` against `base`; None when git can't say."""
    rc, out, _ = _run(cwd, "rev-list", "--left-right", "--count", f"{base}...{ref}")
    parts = out.split() if rc == 0 else []
    return (int(parts[1]), int(parts[0])) if len(parts) == 2 else None


_CREATED = re.compile(r"branch: Created from (.+)$")


def _made_from(cwd: str, name: str, local: set, remote: set, base: str) -> tuple[str, bool]:
    """Where `name` was made from, read off its reflog's first entry ("branch:
    Created from origin/staging"), as a ref this repo has: the local branch, else
    origin's copy. A gone remote's name ("nr/release/x") falls back to origin's.
    "Created from HEAD" names whatever a checkout had out: the base when the start
    commit is in its history, else the branch whose own reflog stood on that
    commit (a stack: pins cut from the videos branch's worktree). "" when nothing
    says, or the reflog expired (90 days).
    Also whether the branch ever moved after it was made: a worktree opened a
    minute ago sits on its start commit and looks merged, but it holds no work
    (True when the reflog can't say)."""
    rc, out, _ = _run(cwd, "reflog", "show", "--format=%H%x09%gs", f"refs/heads/{name}", "--")
    lines = [ln for ln in out.splitlines() if ln.strip()] if rc == 0 else []
    sha, _, said = (lines[-1].partition("\t") if lines else ("", "", ""))
    m = _CREATED.match(said.strip())
    src = m.group(1).strip() if m else ""
    for pre in ("refs/heads/", "refs/remotes/"):
        src = src[len(pre):] if src.startswith(pre) else src
    if src == "HEAD" and sha:
        if base and _run(cwd, "merge-base", "--is-ancestor", sha, base)[0] == 0:
            return ("" if base == name else base), len(lines) != 1
        rc, held, _ = _run(cwd, "for-each-ref", "--contains", sha, "--format=%(refname:short)", "refs/heads")
        for c in (held.split() if rc == 0 else []):
            if c != name and sha in _run(cwd, "reflog", "show", "--format=%H", f"refs/heads/{c}", "--")[1].split():
                return c, len(lines) != 1
        return "", len(lines) != 1
    cands = [c for c in (src, src.split("/", 1)[1] if "/" in src else "") if c and c != "HEAD"]
    hit = next((c for c in cands if c in local), "") or next(
        (r for c in cands for r in (c, f"origin/{c}") if r in remote), "")
    return ("" if hit == name else hit), (len(lines) != 1)


def branch_status(cwd: str, targets: "dict | None" = None) -> dict:
    """Every local branch, and every detached checkout, with where it goes and what
    it has against that: the dashboard's BRANCHES tab in one call.

    Each branch goes into its own `target`: `targets` first (the route passes a
    PR's base, then the user's pick, "" for none), else the branch it was made
    from (its reflog), else the repo's base; the base itself goes nowhere. One
    base for all was wrong outside this repo: efas features read "62 ahead of
    main" while their PRs go to staging, where they were 3 ahead (2026-11-08).

    A row: `name` ("" for a detached checkout, which carries `head`), `at` (last
    commit, epoch s), `subject` (its first line), `sha` (the branch's tip, which
    the tab matches against a merged PR's head), `target`, `ahead`/`behind`
    against it, `merged` (contained in it), `worked` (it moved after it was
    made), `clash` (the files a merge into its target would clash in, from a dry
    run: [] = clean, None = not asked or git can't say), `upstream` with
    `unpushed` (its commits the remote lacks; None when it was never pushed or its
    remote branch is gone), `worktree` (the checkout holding it, else None),
    `main` (that checkout is the repo folder itself) and `dirty` (uncommitted
    files there, None without a checkout).

    One `for-each-ref` for the names, dates and upstreams, then a rev-list and a
    reflog read per branch, a status per checkout, and a dry-run merge per branch
    with work to land. ponytail: a repo with hundreds of branches pays a few git
    calls each; fold them into one `rev-list` if that bites."""
    if not is_repo(cwd):
        return {"base": "", "branches": []}
    base = default_branch(cwd)
    trees = worktrees(cwd)
    held = {w["branch"]: w for w in trees if w["branch"]}
    want = targets or {}
    rc, out, _ = _run(cwd, "for-each-ref", "--format=%(refname:short)", "refs/remotes")
    remote = {r.strip() for r in out.splitlines() if r.strip()} if rc == 0 else set()

    def dirty(path: str) -> int:   # porcelain v2: "#" lines are the branch header
        return sum(1 for ln in (_porcelain(path) or "").splitlines() if ln and not ln.startswith("#"))

    # the subject goes last: a tab inside it stays part of it
    fmt = ("%(refname:short)%09%(committerdate:unix)%09%(upstream:short)%09%(upstream:track,nobracket)"
           "%09%(objectname)%09%(subject)")
    rc, out, _ = _run(cwd, "for-each-ref", f"--format={fmt}", "--sort=-committerdate", "refs/heads")
    lines = out.splitlines() if rc == 0 else []
    local = {ln.split("\t", 1)[0] for ln in lines}

    def known(t: str) -> str:      # a target as a ref git can read: local, else origin's copy
        return t if t in local else f"origin/{t}" if f"origin/{t}" in remote else t if t in remote else ""

    rows: list[dict] = []
    dry = 12   # dry-run merges per read: the newest branches with work to land
    for line in lines:
        name, at, up, track, sha, subject = (line.split("\t", 5) + [""] * 6)[:6]
        if not name:
            continue
        gone = track.strip() == "gone"
        m = re.search(r"ahead (\d+)", track)
        start, worked = _made_from(cwd, name, local, remote, base)
        target = "" if name == base else known(want[name]) if name in want else start or base
        if target == name:
            target = ""
        lr = _left_right(cwd, target, name) if target else None
        ahead, behind = lr or (0, 0)
        clash = None
        if lr and ahead:
            clash = [] if not behind else merge_check(cwd, target, name) if dry > 0 else None
            dry -= 1 if behind else 0
        w = held.get(name)
        rows.append({
            "name": name, "at": int(at or 0), "subject": subject, "sha": sha,
            "target": target, "ahead": ahead, "behind": behind,
            "merged": bool(lr) and ahead == 0, "worked": worked, "clash": clash,
            "upstream": "" if gone else up,
            "unpushed": None if (gone or not up) else (int(m.group(1)) if m else 0),
            "worktree": w["path"] if w else None, "main": bool(w and w["is_main"]),
            "dirty": dirty(w["path"]) if w else None,
        })
    for w in trees:
        if not w["detached"]:
            continue
        ahead, behind = _left_right(cwd, base, w["head"]) or (0, 0)
        rc, log, _ = _run(cwd, "log", "-1", "--format=%ct%x09%s", w["head"])
        at, subject = (log.strip().split("\t", 1) + [""])[:2] if rc == 0 else ("", "")
        rows.append({
            "name": "", "head": w["head"][:7], "at": int(at or 0), "subject": subject, "sha": w["head"],
            "target": base, "ahead": ahead, "behind": behind, "merged": False, "worked": True, "clash": None,
            "upstream": "", "unpushed": None,
            "worktree": w["path"], "main": w["is_main"], "dirty": dirty(w["path"]),
        })
    return {"base": base, "branches": rows}


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


def drop_pr_copy(cwd: str, number: int) -> bool:
    """Delete `pr-<number>`, the copy a PR review leaves when it fetches
    pull/<number>/head to read it, once nothing would be lost: every commit on it
    is on a remote branch, or it is exactly the PR's head on GitHub. A checkout
    still using it keeps it (git refuses). True when it went.
    shortcut: a PR pushed to after the review fetched it, from a branch never
    fetched here, keeps its copy; fetch the PR head to check ancestry if that shows up."""
    name = f"pr-{number}"
    rc, tip, _ = _run(cwd, "rev-parse", "--verify", "-q", f"refs/heads/{name}")
    if rc != 0:
        return False
    rc, extra, _ = _run(cwd, "rev-list", "--count", tip.strip(), "--not", "--remotes")
    if not (rc == 0 and extra.strip() == "0"):
        rc, out, _ = _run(cwd, "ls-remote", "origin", f"refs/pull/{number}/head", timeout=20)
        if rc != 0 or out.split("\t")[0].strip() != tip.strip():
            return False
    return delete_branch(cwd, name, force=True)[0]


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


def worktree_holding(cwd: str, path: str) -> str:
    """The linked worktree of the repo at `cwd` that `path` is in, at any depth —
    `cd <wt>/web/src` works on that tree's branch as much as `cd <wt>` does — as
    git lists it; "" when it is in none. The main checkout never answers: it is
    where scratch probes (.mystical/), merges and reads of master happen
    mid-feature, and naming it from there flipped 117 of 175 sessions' labels
    back and forth (Oct 2026). Skipping it also keeps a tree nested inside it
    (Claude Code's `.claude/worktrees/`) from being shadowed; the deepest tree
    wins. Same source of truth as is_worktree_of.

    ponytail: paths compare as strings after realpath, so on a case-insensitive
    Mac a `cd ~/projects/…` misses a tree git lists as ~/Projects/… (2 of 170
    sessions, Oct 2026); compare os.stat identities if that grows."""
    want = os.path.realpath(path) + os.sep if path else ""
    hits = [w["path"] for w in worktrees(cwd) if not w["is_main"]
            and want.startswith(os.path.realpath(w["path"]) + os.sep)]
    return max(hits, key=len, default="")


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
    if rc and create and _run(cwd, "rev-parse", "--verify", "-q", "HEAD")[0]:
        # a repo with no commits: git only says "invalid reference: HEAD", which names no way out
        cur = _run(cwd, "symbolic-ref", "-q", "--short", "HEAD")[1].strip() or "the default branch"
        return False, f"this repo has no commits yet, so there is nothing to branch from. Commit once on {cur}, then try again."
    return rc == 0, (out + err).strip()


_SLUG_RE = re.compile(r"[^A-Za-z0-9._-]+")


def slug(s: str) -> str:
    return _SLUG_RE.sub("-", (s or "").strip().strip("/")).strip("-") or "wt"


def cut_words(s: str, cap: int) -> str:
    """A slug cut to `cap` characters at a whole word (a "-"), or mid-word when it is one long word."""
    if len(s) <= cap:
        return s
    i = s.rfind("-", 0, cap + 1)   # a "-" right at the cap means the cap ends a word
    return s[:i] if i > 0 else s[:cap]


def worktree_path_for(repo_root: str, branch: str, free: bool = False) -> str:
    """Where the bridge keeps `branch`'s worktree of the repo at `repo_root`:
    <BASE_PATH>/.worktrees/<repo>/<branch>, a hidden dir so the project browser
    never lists it. free=True adds -2, -3, ... until the directory is unused."""
    repo = slug(os.path.basename((repo_root or "").rstrip("/")) or "repo")
    wt = base = os.path.join(config.BASE_PATH, ".worktrees", repo, slug(branch))
    n = 2
    while free and os.path.isdir(wt):
        wt, n = f"{base}-{n}", n + 1
    return wt


def copy_env(src: str, dst: str) -> str:
    """git checks out tracked files only, so a new worktree lacks .env. Copy it;
    returns an error text, "" on success or when there is nothing to copy."""
    s, d = os.path.join(src, ".env"), os.path.join(dst, ".env")
    if os.path.isfile(s) and not os.path.exists(d):
        try:
            shutil.copy2(s, d)
        except OSError as e:
            return f"worktree created, .env not copied: {e}"
    return ""


def worktree_remove(cwd: str, path: str, force: bool = True) -> tuple[bool, str]:
    args = ["worktree", "remove"] + (["--force"] if force else []) + ["--end-of-options", path]
    rc, out, err = _run(cwd, *args, timeout=20)
    return rc == 0, (out + err).strip()


SCRATCH = (".mystical", ".superpowers")   # git-ignored, so a forced remove would delete them


def archive_scratch(cwd: str, path: str) -> str:
    """Move a worktree's git-ignored scratch (screenshots, probe kits, a plan's
    ledger) into the repo folder's .mystical/archive/<worktree>/ before the
    worktree goes, as the user's own clean-ups do by hand. Returns where it went,
    "" when there was nothing to keep. A clash with an older archive gets -2, -3."""
    found = [d for d in SCRATCH if os.path.isdir(os.path.join(path, d))]
    main = next((w["path"] for w in worktrees(cwd) if w["is_main"]), "")
    if not found or not main or os.path.realpath(main) == os.path.realpath(path):
        return ""
    dest = base = os.path.join(main, ".mystical", "archive", os.path.basename(path.rstrip("/")))
    n = 2
    while os.path.exists(dest):
        dest, n = f"{base}-{n}", n + 1
    os.makedirs(dest)
    for d in found:
        shutil.move(os.path.join(path, d), os.path.join(dest, d))
    return dest


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
    # Flags go right after the subcommand, so a caller's `--end-of-options`
    # (before a range) can't turn them into revisions.
    rc, out, _ = _run(cwd, cmd[0], "--name-status", "-z", *cmd[1:])
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
    rc, out, _ = _run(cwd, cmd[0], "--numstat", "-z", *cmd[1:])
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


def file_at(cwd: str, sha: str, path: str) -> str:
    """A file's text as committed at `sha` — `git show <sha>:<path>`. "" when the
    file isn't in that commit or the sha is unknown (callers diff two versions,
    and "absent" reads the same as "empty")."""
    rc, out, _ = _run(cwd, "show", f"{sha}:{path}")
    return out if rc == 0 else ""


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
    # --end-of-options: a ref is never read as a flag (`--output=…` would write
    # a file). The route checks refs too; this holds for any other caller.
    # left-right count needs the symmetric (three-dot) form regardless of `rng`.
    rc, out, _ = _run(cwd, "rev-list", "--left-right", "--count", "--end-of-options",
                      f"{base}...{head}")
    behind = ahead = 0
    if rc == 0 and out.strip():
        parts = out.split()
        if len(parts) == 2:
            behind, ahead = int(parts[0] or 0), int(parts[1] or 0)
    files, total_add, total_del = _diff_files(cwd, "diff", "--end-of-options", rng)
    return {"ok": True, "commits": ahead, "ahead": ahead, "behind": behind,
            "files": files, "add": total_add, "del": total_del}
