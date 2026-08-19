"""Claude Code skills: what is installed for a project and for the user
(system), plus installing/removing entries from the built-in catalog.

A skill is a directory holding a SKILL.md whose front matter carries `name` and
`description`. Project skills live in `<project>/.claude/skills/<id>/SKILL.md`,
system (user-wide) skills in `~/.claude/skills/<id>/SKILL.md` — the same paths
Claude Code itself reads.

Catalog entries either render locally (`steps`) or are downloaded verbatim from
GitHub (`url`), so a community skill installs as the maintained original.

Provenance: every install drops a MARKER file next to the SKILL.md. Only a
directory carrying that marker may be removed, so a hand-written skill that
happens to share a catalog name is never overwritten or deleted from the UI.
"""

import concurrent.futures
import hashlib
import os
import urllib.request

from bridge.skills_catalog import CATALOG, skill_md

SYSTEM_ROOT = os.path.expanduser("~/.claude/skills")
MARKER = ".installed-from-catalog"
# A pulled design system is neither a catalog skill (no upstream URL to diff
# against) nor hand-written (a re-pull may overwrite it). Its own marker keeps
# the three apart; line 1 is the design project id, the rest are pulled paths.
DESIGN_MARKER = ".synced-from-design"
_MAX_BYTES = 512_000
_TIMEOUT = 20

_BY_ID = {e["id"]: e for e in CATALOG}


def _project_root(abs_project: str) -> str:
    return os.path.join(abs_project, ".claude", "skills")


def _root(scope: str, abs_project: "str | None") -> "str | None":
    if scope == "system":
        return SYSTEM_ROOT
    if scope == "project" and abs_project:
        return _project_root(abs_project)
    return None


def _front_matter(text: str) -> dict:
    """`key: value` pairs from the leading `---` block. Deliberately minimal —
    skills only carry flat scalars there (name, description), though a long
    description is sometimes folded (`description: >` + indented lines), which
    reads back as those lines joined."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    out = {}
    key = None
    for line in lines[1:]:
        if line.strip() == "---":
            break
        if key and line.startswith((" ", "\t")):
            out[key] = f"{out[key]} {line.strip()}".strip()     # continuation of a folded value
            continue
        k, sep, val = line.partition(":")
        if sep and not k.startswith((" ", "\t")):
            val = val.strip().strip('"').strip("'")
            key = k.strip()
            # `>` / `|` (and their -/+ chomping forms) open a block scalar
            out[key] = "" if val and val[0] in ">|" and len(val) <= 2 else val
        else:
            key = None
    return out


def _design_id(d: str) -> "tuple[bool, str | None]":
    """(is a pulled design system, which project). Best-effort: a truncated or
    hand-emptied marker still means the directory is ours. errors="replace"
    so invalid bytes can't raise UnicodeDecodeError out of a function whose
    whole job is never raising."""
    try:
        with open(os.path.join(d, DESIGN_MARKER), encoding="utf-8", errors="replace") as f:
            first = f.readline().strip()
    except OSError:
        return False, None
    return True, first or None


def _design_paths(d: str) -> "tuple[set | None, str | None]":
    """The pulled paths a .synced-from-design marker recorded — remove()'s
    delete authority for a design-sourced directory. None + a reason means
    the marker can't be trusted to say what's safe to delete: unreadable, or
    truncated/hand-emptied so it never even got past the project id line.
    Unlike `_design_id` (best-effort, for display), this is conservative on
    purpose — it gates a delete, not a label."""
    try:
        with open(os.path.join(d, DESIGN_MARKER), encoding="utf-8", errors="replace") as f:
            lines = f.read().splitlines()
    except OSError as e:
        return None, str(e)
    if not lines or not lines[0].strip():
        return None, "design marker has no project id"
    return {ln.strip() for ln in lines[1:] if ln.strip()}, None


def _fetch(url: str) -> "tuple[str, str]":
    """Download an upstream SKILL.md. Returns (text, error)."""
    try:
        with urllib.request.urlopen(url, timeout=_TIMEOUT) as r:
            raw = r.read(_MAX_BYTES + 1)
    except Exception as e:  # noqa: BLE001 — urllib raises a zoo of network errors
        return "", f"download failed: {type(e).__name__}"
    if len(raw) > _MAX_BYTES:
        return "", "download too large"
    text = raw.decode("utf-8", "replace")
    # A SKILL.md always opens with front matter; anything else means we were
    # served an error page rather than the file.
    if not text.lstrip().startswith("---"):
        return "", "not a SKILL.md"
    return text, ""


def _scan(root: "str | None", scope: str) -> list:
    if not root:
        return []
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return []
    out = []
    for n in names:
        d = os.path.join(root, n)
        md = os.path.join(d, "SKILL.md")
        if not os.path.isfile(md):
            continue
        try:
            with open(md, encoding="utf-8", errors="replace") as f:
                fm = _front_matter(f.read(4096))
        except OSError:
            fm = {}
        entry = _BY_ID.get(n)
        ours = os.path.isfile(os.path.join(d, MARKER))
        from_design, design_id = _design_id(d)
        out.append({
            "id": n,
            "name": entry["name"] if (entry and ours) else (fm.get("name") or n),
            "description": (fm.get("description") or "")[:400],
            "scope": scope,
            "category": entry["category"] if (entry and ours) else "other",
            "from_catalog": ours,
            "from_design": from_design,
            "design_project": design_id,
        })
    return out


def installed(abs_project: "str | None" = None) -> dict:
    return {"project": _scan(_project_root(abs_project) if abs_project else None, "project"),
            "system": _scan(SYSTEM_ROOT, "system")}


def catalog() -> list:
    return [{"id": e["id"], "name": e["name"], "category": e["category"],
             "description": e["description"], "repo": e.get("repo")} for e in CATALOG]


def install(skill_id: str, scope: str, abs_project: "str | None" = None) -> "tuple[bool, str]":
    entry = _BY_ID.get(skill_id)
    root = _root(scope, abs_project)
    if not entry:
        return False, "unknown skill"
    if root is None:
        return False, "invalid scope"
    d = os.path.join(root, skill_id)
    if os.path.isfile(os.path.join(d, "SKILL.md")) and not os.path.isfile(os.path.join(d, MARKER)):
        return False, "a skill of your own already has that name here"
    body, err = _fetch(entry["url"]) if entry.get("url") else (skill_md(entry), "")
    if err:
        return False, err
    try:
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "SKILL.md"), "w", encoding="utf-8") as f:
            f.write(body)
        # Source + the digest of exactly what we wrote, so a later check can tell
        # "upstream moved" apart from "the user edited this".
        with open(os.path.join(d, MARKER), "w", encoding="utf-8") as f:
            f.write(f"{entry.get('url') or 'built-in catalog'}\n{_digest(body)}\n")
    except OSError as e:
        return False, str(e)
    return True, ""


def _digest(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def _drifted(d: str, entry: dict) -> "bool | None":
    """Has the source moved on since we installed this? None means leave it
    alone — offline, unreadable, or edited locally (updating would throw the
    user's edit away, so a modified file is never reported as outdated)."""
    try:
        with open(os.path.join(d, "SKILL.md"), encoding="utf-8", errors="replace") as f:
            local = f.read()
        with open(os.path.join(d, MARKER), encoding="utf-8") as f:
            installed = (f.read().splitlines() + ["", ""])[1]
    except OSError:
        return None
    if installed and installed != _digest(local):
        return None                 # hand-edited since install — not ours to replace
    if entry.get("url"):
        body, err = _fetch(entry["url"])
        if err:
            return None
    else:
        body = skill_md(entry)      # built-in text can change when we ship a new one
    return body != local


def check_updates(abs_project: "str | None" = None) -> dict:
    """Compare every catalog skill we installed against its source. Applying an
    update is just install() again — it overwrites what it owns."""
    targets = []
    for scope in ("project", "system"):
        root = _root(scope, abs_project)
        for s in _scan(root, scope):
            if s["from_catalog"] and s["id"] in _BY_ID:
                targets.append((scope, s["id"], os.path.join(root, s["id"])))
    if not targets:
        return {"outdated": [], "checked": 0, "unreachable": 0}

    # One request per skill, run wide — a serial sweep over 30 skills would
    # keep the panel spinning for a minute.
    def one(t):
        scope, sid, d = t
        return scope, sid, _drifted(d, _BY_ID[sid])

    with concurrent.futures.ThreadPoolExecutor(min(8, len(targets))) as ex:
        results = list(ex.map(one, targets))
    return {
        "outdated": [{"id": sid, "scope": scope} for scope, sid, d in results if d],
        "checked": len(results),
        "unreachable": sum(1 for _, _, d in results if d is None),
    }


def _remove_design_sourced(d: str) -> "tuple[bool, str]":
    """Delete a .synced-from-design directory: SKILL.md, the marker, and
    exactly the paths the marker recorded pulling — pruning directories left
    empty behind them. A real pull is more than two files (tokens/,
    guidelines/, assets/…), so unlike the catalog branch this walks the tree
    rather than requiring an exact two-entry match. Anything on disk the
    marker doesn't account for is a file the user added since the pull, so
    this backs off entirely rather than take it with the skill."""
    recorded, reason = _design_paths(d)
    if reason:
        return False, reason
    # Every directory a recorded path passes through, at every depth — the
    # only directories this delete is allowed to find on disk. Built from
    # `recorded` rather than from what currently exists, so a dir emptied by
    # an earlier, partially-failed sweep still counts as ours on retry.
    recorded_dirs = set()
    for p in recorded:
        parts = p.split("/")[:-1]
        for i in range(1, len(parts) + 1):
            recorded_dirs.add("/".join(parts[:i]))
    try:
        actual = set()
        for dirpath, dirnames, filenames in os.walk(d):
            for dn in dirnames:
                # followlinks=False means a symlinked directory is never
                # descended into, so anything inside it can never land in
                # `actual` no matter what it is — refuse before looking, not
                # after failing to notice.
                if os.path.islink(os.path.join(dirpath, dn)):
                    return False, "directory has other files"
            rel_dir = os.path.relpath(dirpath, d)
            if rel_dir != "." and rel_dir not in recorded_dirs:
                # a directory no recorded path ever routed a pull through —
                # the user's own, empty or not. Same back-off as an
                # unrecorded file: refuse rather than silently rmdir it.
                return False, "directory has other files"
            for fn in filenames:
                actual.add(os.path.relpath(os.path.join(dirpath, fn), d))
        if actual - recorded - {"SKILL.md", DESIGN_MARKER}:
            return False, "directory has other files"
        # Nothing about a filesystem delete is atomic, so this chases
        # retryability instead: pulled content goes first, in a fixed sorted
        # order (not set-iteration order, which is hash-randomized and would
        # make a mid-sweep failure untestable); SKILL.md and the marker go
        # last. If any content delete fails, the identity files are never
        # even attempted, so the directory still reads as design-sourced and
        # the same remove() call can just be retried.
        identity = [p for p in ("SKILL.md", DESIGN_MARKER) if p in actual]
        for rel in sorted(actual.difference(identity)):
            os.remove(os.path.join(d, rel))
        for rel in identity:
            os.remove(os.path.join(d, rel))
        for dirpath, _dirnames, _filenames in os.walk(d, topdown=False):
            if not os.listdir(dirpath):
                os.rmdir(dirpath)
    except OSError as e:
        return False, str(e)
    return True, ""


def remove(skill_id: str, scope: str, abs_project: "str | None" = None) -> "tuple[bool, str]":
    """Uninstall a skill the bridge itself put there: one pulled from the
    catalog (MARKER) or pulled from a design project (DESIGN_MARKER). Refuses
    anything else: the directory must carry one of those two provenance
    markers, so an edited or hand-written skill is never deleted from the UI.
    A catalog directory must hold nothing but SKILL.md + MARKER; a design
    directory may hold nested content too, but only exactly what its marker
    recorded pulling — see `_remove_design_sourced`."""
    root = _root(scope, abs_project)
    if root is None:
        return False, "invalid scope"
    if os.path.basename(skill_id) != skill_id:
        # defense-in-depth: the marker gate below already requires disk
        # state matching the id, but a bare id (no separators) is one less
        # thing that gate has to be trusted alone to catch.
        return False, "bad id"
    d = os.path.join(root, skill_id)
    if os.path.isfile(os.path.join(d, MARKER)):
        if skill_id not in _BY_ID:
            return False, "not a catalog skill"
        marker = MARKER
    elif os.path.isfile(os.path.join(d, DESIGN_MARKER)):
        return _remove_design_sourced(d)
    else:
        return False, "not installed from the catalog"
    try:
        if set(os.listdir(d)) != {"SKILL.md", marker}:
            return False, "directory has other files"
        os.remove(os.path.join(d, "SKILL.md"))
        os.remove(os.path.join(d, marker))
        os.rmdir(d)
    except OSError as e:
        return False, str(e)
    return True, ""
