"""Claude Code skills: what is installed for a project and for the user
(system), plus installing/removing entries from the built-in catalog.

A skill is a directory holding a SKILL.md whose front matter carries `name` and
`description`. Project skills live in `<project>/.claude/skills/<id>/SKILL.md`,
system (user-wide) skills in `~/.claude/skills/<id>/SKILL.md` — the same paths
Claude Code itself reads.
"""

import os

from bridge.skills_catalog import CATALOG, skill_md

SYSTEM_ROOT = os.path.expanduser("~/.claude/skills")

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


def _scan(root: "str | None", scope: str) -> list:
    if not root:
        return []
    try:
        names = sorted(os.listdir(root))
    except OSError:
        return []
    out = []
    for n in names:
        md = os.path.join(root, n, "SKILL.md")
        if not os.path.isfile(md):
            continue
        try:
            with open(md, encoding="utf-8", errors="replace") as f:
                fm = _front_matter(f.read(4096))
        except OSError:
            fm = {}
        entry = _BY_ID.get(n)
        out.append({
            "id": n,
            "name": entry["name"] if entry else (fm.get("name") or n),
            "description": (fm.get("description") or "")[:400],
            "scope": scope,
            "category": entry["category"] if entry else "other",
            "from_catalog": entry is not None,
        })
    return out


def installed(abs_project: "str | None" = None) -> dict:
    return {"project": _scan(_project_root(abs_project) if abs_project else None, "project"),
            "system": _scan(SYSTEM_ROOT, "system")}


def catalog() -> list:
    return [{k: e[k] for k in ("id", "name", "category", "description")} for e in CATALOG]


def install(skill_id: str, scope: str, abs_project: "str | None" = None) -> "tuple[bool, str]":
    entry = _BY_ID.get(skill_id)
    root = _root(scope, abs_project)
    if not entry:
        return False, "unknown skill"
    if root is None:
        return False, "invalid scope"
    d = os.path.join(root, skill_id)
    try:
        os.makedirs(d, exist_ok=True)
        with open(os.path.join(d, "SKILL.md"), "w", encoding="utf-8") as f:
            f.write(skill_md(entry))
    except OSError as e:
        return False, str(e)
    return True, ""


def remove(skill_id: str, scope: str, abs_project: "str | None" = None) -> "tuple[bool, str]":
    """Uninstall a catalog skill. Refuses anything we did not write: the id must
    be a catalog one and the directory must hold nothing but the SKILL.md, so a
    hand-written skill (or one someone edited) is never deleted from the UI."""
    root = _root(scope, abs_project)
    if skill_id not in _BY_ID:
        return False, "not a catalog skill"
    if root is None:
        return False, "invalid scope"
    d = os.path.join(root, skill_id)
    if not os.path.isfile(os.path.join(d, "SKILL.md")):
        return False, "not installed"
    try:
        if os.listdir(d) != ["SKILL.md"]:
            return False, "directory has other files"
        os.remove(os.path.join(d, "SKILL.md"))
        os.rmdir(d)
    except OSError as e:
        return False, str(e)
    return True, ""
