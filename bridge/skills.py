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
    skills only carry flat scalars there (name, description)."""
    lines = text.splitlines()
    if not lines or lines[0].strip() != "---":
        return {}
    out = {}
    for line in lines[1:]:
        if line.strip() == "---":
            break
        key, sep, val = line.partition(":")
        if sep and not key.startswith((" ", "\t")):
            out[key.strip()] = val.strip().strip('"').strip("'")
    return out


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
        out.append({
            "id": n,
            "name": entry["name"] if (entry and ours) else (fm.get("name") or n),
            "description": (fm.get("description") or "")[:400],
            "scope": scope,
            "category": entry["category"] if (entry and ours) else "other",
            "from_catalog": ours,
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


def remove(skill_id: str, scope: str, abs_project: "str | None" = None) -> "tuple[bool, str]":
    """Uninstall a catalog skill. Refuses anything we did not install: the
    directory must carry the provenance MARKER and hold nothing else, so an
    edited or hand-written skill is never deleted from the UI."""
    root = _root(scope, abs_project)
    if skill_id not in _BY_ID:
        return False, "not a catalog skill"
    if root is None:
        return False, "invalid scope"
    d = os.path.join(root, skill_id)
    if not os.path.isfile(os.path.join(d, MARKER)):
        return False, "not installed from the catalog"
    try:
        if set(os.listdir(d)) != {"SKILL.md", MARKER}:
            return False, "directory has other files"
        os.remove(os.path.join(d, "SKILL.md"))
        os.remove(os.path.join(d, MARKER))
        os.rmdir(d)
    except OSError as e:
        return False, str(e)
    return True, ""
