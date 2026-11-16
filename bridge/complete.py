"""What the composer can offer as you type, from disk: paths, and the names defined in a project's code.

The chat's own words and the project's file list are already in the browser (lib/completewords). Two
things aren't: what's on disk outside the project, for `~/Downloads/rep` or `../other-repo/src/`, and the
names the project's code defines, for `useRefS` or `handle_work`.

Paths list names in one folder and nothing else: no contents, no sizes. It's the dashboard's own route,
behind its token, for the person at this machine; the Mini App doesn't have it. Hidden entries only show
when you've typed the dot.

Names come from a regex per line over the files git tracks, not a language server: a def, class,
function, interface, type, struct or top-level const is named the same way in most languages, so one
pattern covers Python, TypeScript, Go, Rust, Swift, C# and more, in well under a second for a thousand
files. It misses what's defined some other way, and that's the trade. Cached per repo until its index
changes, so typing never waits on it.

Stdlib only.
"""

import os
import re
import subprocess
import threading
import time

MAX_ENTRIES, MAX_FILES, MAX_BYTES, MAX_NAMES = 60, 4000, 300_000, 20_000
_CODE_EXT = {".py", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".rs", ".swift", ".cs", ".java", ".kt", ".rb", ".php",
             ".c", ".h", ".cc", ".cpp", ".hpp", ".m", ".scala", ".lua", ".sh", ".dart", ".vue", ".svelte"}
_DEF = re.compile(
    r"^[ \t]*(?:export\s+)?(?:default\s+)?(?:pub(?:\([^)]*\))?\s+)?(?:(?:public|private|protected|internal|static|async|final|"
    r"abstract|override|open|inline|unsafe|extern|declare|readonly|sealed|partial)\s+)*"
    r"(?:def|class|function\*?|interface|type|enum|struct|trait|fn|func|const|let|var|val|record|protocol|module|impl)\s+"
    r"(?:\([^)]*\)\s*)?([A-Za-z_$][\w$]*)", re.M)
_cache: dict = {}
_lock = threading.Lock()


def paths(base: str, prefix: str) -> list:
    """Entries of the folder `prefix` points into, whose names start with what follows its last /.
    Each comes back as the text that replaces `prefix`, with a / on folders so you can keep going."""
    prefix = str(prefix or "")
    if not prefix or "\0" in prefix:
        return []
    cut = prefix.rfind("/")
    head, stem = (prefix[:cut + 1], prefix[cut + 1:]) if cut >= 0 else ("", prefix)
    folder = os.path.expanduser(head) if head.startswith("~") else head
    folder = folder if os.path.isabs(folder) else os.path.join(base or os.getcwd(), folder)
    try:
        entries = list(os.scandir(folder or "/"))
    except OSError:
        return []
    want = stem.lower()
    out = []
    for e in sorted(entries, key=lambda e: e.name.lower())[:5000]:
        if e.name.startswith(".") and not stem.startswith("."):
            continue
        if not e.name.lower().startswith(want) or e.name == stem:
            continue
        try:
            is_dir = e.is_dir()
        except OSError:
            is_dir = False
        out.append({"text": head + e.name + ("/" if is_dir else ""), "name": e.name + ("/" if is_dir else ""), "dir": is_dir})
        if len(out) >= MAX_ENTRIES:
            break
    # Exact case first, then folders, then the rest by name.
    return sorted(out, key=lambda o: (not o["name"].startswith(stem), not o["dir"], o["name"].lower()))


def _stamp(root: str) -> tuple:
    git = os.path.join(root, ".git")
    try:
        if os.path.isfile(git):     # a worktree: its index lives in the main repo
            with open(git, encoding="utf-8") as f:
                git = f.read().split("gitdir:", 1)[-1].strip()
        return (os.stat(os.path.join(git, "index")).st_mtime_ns,)
    except OSError:
        return (int(time.time() // 60),)


def symbols(root: str) -> list:
    """[{name, file}] for what the project's code defines, most-defined first. Cached until the index changes."""
    if not root or not os.path.isdir(root):
        return []
    stamp = _stamp(root)
    with _lock:
        hit = _cache.get(root)
        if hit and hit[0] == stamp:
            return hit[1]
    try:
        files = subprocess.run(["git", "-C", root, "ls-files", "-z"], capture_output=True, text=True, timeout=20).stdout.split("\0")
    except (OSError, subprocess.SubprocessError):
        files = []
    seen: dict = {}
    for rel in [f for f in files if os.path.splitext(f)[1].lower() in _CODE_EXT][:MAX_FILES]:
        path = os.path.join(root, rel)
        try:
            if os.path.getsize(path) > MAX_BYTES:
                continue
            with open(path, encoding="utf-8", errors="replace") as f:
                text = f.read()
        except OSError:
            continue
        for m in _DEF.finditer(text):
            name = m.group(1)
            if len(name) < 3 or name in ("self", "this"):
                continue
            row = seen.setdefault(name, {"name": name, "file": rel, "n": 0})
            row["n"] += 1
    out = [{"name": r["name"], "file": r["file"]} for r in sorted(seen.values(), key=lambda r: -r["n"])][:MAX_NAMES]
    with _lock:
        _cache[root] = (stamp, out)
    return out
