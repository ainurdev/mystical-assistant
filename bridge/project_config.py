"""Per-project settings — currently the dev/run command — persisted as JSON
keyed by the project's path (the same rel key the store uses). Also reads the
runnable scripts from a project's package.json so a surface can offer them as
choices. Lives next to the bridge DB, in $HOME, git-ignored."""

import json
import os
import threading

from bridge import config

_lock = threading.Lock()
_PATH = os.path.join(os.path.dirname(config.BRIDGE_DB), "project_config.json")


def _load() -> dict:
    try:
        with open(_PATH, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(data: dict) -> None:
    os.makedirs(os.path.dirname(_PATH), exist_ok=True)
    tmp = _PATH + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, _PATH)


def _key(project: str, branch: "str | None") -> str:
    """Settings are scoped per directory and per branch, so the same repo on a
    different branch (or in a different worktree) keeps its own run command and
    prod URL. A blank branch keeps the legacy directory-only key."""
    return f"{project}@{branch}" if branch else project


def get(project: str) -> dict:
    with _lock:
        return _load().get(project, {})


def _get_field(project: str, branch: "str | None", field: str) -> "str | None":
    v = get(_key(project, branch)).get(field)
    if v is None and branch:  # fall back to the directory-only entry
        v = get(project).get(field)
    return v or None


def _set_field(project: str, branch: "str | None", field: str, value: str) -> "str | None":
    value = (value or "").strip()
    key = _key(project, branch)
    with _lock:
        data = _load()
        entry = data.get(key, {})
        if value:
            entry[field] = value
        else:
            entry.pop(field, None)
        if entry:
            data[key] = entry
        else:
            data.pop(key, None)
        _save(data)
    return value or None


def run_cmd(project: str, branch: "str | None" = None) -> "str | None":
    """The configured dev/run command for a project (optionally branch), or None."""
    return _get_field(project, branch, "run_cmd")


def set_run_cmd(project: str, cmd: str, branch: "str | None" = None) -> "str | None":
    """Persist (or clear, when blank) a project's dev/run command."""
    return _set_field(project, branch, "run_cmd", cmd)


def prod_url(project: str, branch: "str | None" = None) -> "str | None":
    """The configured production/deployed URL for a project (optionally branch)."""
    return _get_field(project, branch, "prod_url")


def set_prod_url(project: str, url: str, branch: "str | None" = None) -> "str | None":
    """Persist (or clear, when blank) a project's production URL."""
    return _set_field(project, branch, "prod_url", url)


_MEMORY_MODES = ("ask", "auto", "off")


def memory_mode(project: str) -> str:
    """Per-project memory posture: 'ask' (default) | 'auto' | 'off'. Project-wide
    (never branch-scoped), so it reads the bare-project key only."""
    return _get_field(project, None, "memory_mode") or "ask"


def set_memory_mode(project: str, mode: str) -> str:
    """Persist the posture; invalid/blank coerces to 'ask'. 'ask' is the default, so
    it is stored blank (clearing the field) to keep the JSON minimal. Returns the
    effective mode."""
    mode = (mode or "").strip().lower()
    if mode not in _MEMORY_MODES:
        mode = "ask"
    _set_field(project, None, "memory_mode", "" if mode == "ask" else mode)
    return mode


def set_hidden(project: str, on: bool) -> bool:
    """Keep a project out of the sidebar (projects + session list). Project-wide,
    like the memory posture; returns the effective value."""
    _set_field(project, None, "hidden", "1" if on else "")
    return on


def hidden_projects() -> list[str]:
    """Every project rel currently hidden. Only ever written project-wide, so
    branch-scoped keys never carry the flag."""
    with _lock:
        return sorted(k for k, v in _load().items() if isinstance(v, dict) and v.get("hidden"))


def package_scripts(cwd: str) -> dict:
    """The `scripts` map (name -> command) from the project's package.json, or
    {} when there is no package.json / no scripts."""
    try:
        with open(os.path.join(cwd, "package.json"), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    scripts = data.get("scripts")
    if not isinstance(scripts, dict):
        return {}
    return {str(k): str(v) for k, v in scripts.items()}
