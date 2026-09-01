"""The markdown a repo was written with, listed for the dashboard's DOCS tab.

A doc here is prose you sit down and *read*: a spec under
`docs/superpowers/specs/`, a release note, a README, a design brief someone
dropped in `.mystical/docs/`. The tab exists so reading one is two clicks
instead of a hunt through the FILES tree for a name you half remember.

What is pruned is the point. Most `.md` in a repo is not a doc anyone wrote for
this project: `node_modules` ships thousands, `.claude` and `.superpowers` hold
tooling a skill installed, `graphify-out` holds generated reports, and
`.mystical/learn` holds lessons that already have their own tab. Take those out
and what is left is the writing — a few dozen files, which is a list you can
read down.

Why a walk and not an index. Nothing writes these *through* the bridge — the
model calls Write and a file appears — so a registry would be a second source of
truth that goes stale the first time a session writes a doc somewhere it doesn't
know about. The tree is the index. With SKIP_DIRS pruned the walk is a few
milliseconds per repo, and the tab reads it on mount, not per frame.

Dotted directories are *not* skipped wholesale: `.mystical/docs/` is the shelf a
repo can put anything on that it wants rendered here, and it has to be walked to
be found.
"""

import os

from bridge import config

# Dependency trees, build output, and the two kinds of markdown that are not
# this project's writing: tooling a skill installed (`.claude`, `.superpowers`)
# and output a tool generated (`graphify-out`, `dist`).
SKIP_DIRS = {".git", "node_modules", "dist", "build", ".next", "coverage",
             "__pycache__", ".venv", "venv", ".mypy_cache", ".pytest_cache",
             ".bridge_uploads", "vendor", ".claude", ".superpowers",
             "graphify-out", "site-packages"}

# Walked but not listed: `.mystical/learn` is the LEARN tab's shelf, and folding
# a repo's 200 lessons into DOCS would bury the dozen docs someone wrote.
SKIP_PATHS = {os.path.join(".mystical", "learn")}

_MAX_PER_REPO = 300
_MAX_ALL = 800
_HEAD_BYTES = 4096


def _title(path: str, at_root: bool = False) -> str:
    """The doc's first `# ` heading, which is what it calls itself. Only the top
    of the file is read — a heading below the first few KB is a section, not a
    title. Scanned rather than stopped at the first line of content, because a
    README opens with badges and a spec with front-matter. Falls back to the
    filename, de-slugged.

    A doc in the repo root is titled by its filename instead: README.md and
    CLAUDE.md both open `# <repo name>`, so their headings collide into two
    identical rows, and "the README" is what anyone calls it anyway."""
    if at_root:
        return os.path.basename(path)[:-3][:80]
    try:
        with open(path, "rb") as f:
            head = f.read(_HEAD_BYTES).decode("utf-8", "replace")
    except OSError:
        head = ""
    for line in head.splitlines():
        s = line.strip()
        if s.startswith("# "):
            return s[2:].strip()[:80]
    name = os.path.basename(path)[:-3]
    # A dated spec filename ("2026-08-25-flow-native-chat.md") reads better as
    # its subject; the date is already in the row's timestamp.
    parts = name.split("-")
    if len(parts) > 3 and parts[0].isdigit() and len(parts[0]) == 4:
        name = "-".join(parts[3:]) or name
    return name.replace("-", " ").replace("_", " ")[:80]


def docs(cwd: str) -> list[dict]:
    """Every markdown doc in a repo, newest first. `path` is repo-rel with
    forward slashes (it round-trips through a URL); `dir` is what the tab groups
    by — the folder is the subject."""
    out: list[dict] = []
    for root, dirs, names in os.walk(cwd):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        rel_root = os.path.relpath(root, cwd)
        if rel_root in SKIP_PATHS:
            dirs[:] = []
            continue
        for n in names:
            if not n.endswith(".md") or n.startswith("."):
                continue
            p = os.path.join(root, n)
            try:
                st = os.stat(p)
            except OSError:
                continue
            if not st.st_size:
                continue        # an empty file is not a doc
            out.append({
                "path": os.path.relpath(p, cwd).replace(os.sep, "/"),
                "dir": "" if rel_root == "." else rel_root.replace(os.sep, "/"),
                "name": n,
                "title": _title(p, at_root=rel_root == "."),
                "at": st.st_mtime,
                "size": st.st_size,
            })
    out.sort(key=lambda a: a["at"], reverse=True)
    return out[:_MAX_PER_REPO]


def all_docs() -> list[dict]:
    """Every repo's docs in one list, each tagged with the project that holds
    it — the tab's default scope, because a spec belongs to the repo it was
    written for, not to whichever session happens to be focused."""
    from bridge import browser   # local import: browser imports config too

    out = []
    for p in browser.list_projects():
        for a in docs(os.path.join(config.BASE_PATH, p.lstrip("/"))):
            out.append({**a, "project": p})
    out.sort(key=lambda a: a["at"], reverse=True)
    return out[:_MAX_ALL]


def read(cwd: str, path: str) -> "str | None":
    """One doc's markdown. `path` arrives from the browser, so it is matched
    against what the walk actually found rather than joined onto a path — the
    containment check is the listing itself, so `../` never resolves.

    ponytail: re-walks the repo per open (milliseconds at this size). Cache the
    listing if a repo ever makes that show.
    """
    if path not in {a["path"] for a in docs(cwd)}:
        return None
    try:
        with open(os.path.join(cwd, path), encoding="utf-8", errors="replace") as f:
            return f.read()
    except OSError:
        return None
