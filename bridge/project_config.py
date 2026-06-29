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


def get(project: str) -> dict:
    with _lock:
        return _load().get(project, {})


def run_cmd(project: str) -> str | None:
    """The configured dev/run command for a project, or None if unset."""
    return get(project).get("run_cmd") or None


def set_run_cmd(project: str, cmd: str) -> str | None:
    """Persist (or clear, when blank) a project's dev/run command."""
    cmd = (cmd or "").strip()
    with _lock:
        data = _load()
        entry = data.get(project, {})
        if cmd:
            entry["run_cmd"] = cmd
        else:
            entry.pop("run_cmd", None)
        if entry:
            data[project] = entry
        else:
            data.pop(project, None)
        _save(data)
    return cmd or None


def prod_url(project: str) -> str | None:
    """The configured production/deployed URL for a project, or None if unset."""
    return get(project).get("prod_url") or None


def set_prod_url(project: str, url: str) -> str | None:
    """Persist (or clear, when blank) a project's production URL."""
    url = (url or "").strip()
    with _lock:
        data = _load()
        entry = data.get(project, {})
        if url:
            entry["prod_url"] = url
        else:
            entry.pop("prod_url", None)
        if entry:
            data[project] = entry
        else:
            data.pop(project, None)
        _save(data)
    return url or None


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
