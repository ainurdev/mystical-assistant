"""Which bundled plugins are installed: Rivendell and Claude Design.

Mystical is being prepared for a public release, and each of these
belongs to a particular setup (a Rivendell team, a Claude Design
project), not to every install. They ship inside the tree but start OFF
and invisible. "Install" flips a switch here and downloads nothing: the code is
already on disk. Not installed means none of it exists. Its routes answer 404 at
each server's door (route_owner), the Rivendell worker sits idle, its env rows,
session origins and Telegram callbacks are not offered, and neither frontend
draws its UI. Every one of those asks this module, so "is X on" has one answer
instead of one per call site.

Removing a plugin switches it off and leaves its own state where it is
(rivendell_instances.json, a repo's design link), so installing it again brings
it back as it was. The first read with no plugins.json adopts what the machine
already uses (a Rivendell instance, a linked repo), so an upgrade breaks nothing
and asks for no click. Adoption runs once: from then on the file exists, and a
removal survives a restart. A corrupt file counts as a missing one. An id the
file holds that PLUGINS no longer has (the Teamwork/Jira "trackers", removed) is
ignored.

Persisted beside the DB as plugins.json, the way aifeatures is: one small file,
readable by a bridge whose store is mid-migration. Stdlib only.

Not built: out-of-tree plugins. PLUGINS is a table shaped to take them (the
routes a plugin owns, the env keys and session origins it brings), but nothing
loads code from outside this repo.
"""

import json
import os
import threading

from bridge import config

# id       -- stable id used by the API, the UI and installed()
# label    -- the plugin's name on its card
# blurb    -- what it does and what appears once it is installed
# needs    -- what it takes before it does anything, shown on the card
# env_keys -- settings the plugin owns: envsettings lists them only while it is installed
# origins  -- session origins its workers stamp; "rivendell" also matches "rivendell:<name>",
#             "device-run:<name>" is a teammate's run on this device (bridge/device_view.py),
#             and "team:<name>" a session a teammate sent (bridge/team.py)
# routes   -- path prefixes both servers answer 404 to while it is not installed
PLUGINS: tuple[dict, ...] = (
    {"id": "rivendell", "label": "Rivendell",
     "blurb": "Rivendell's Request review and Implement using AI buttons run as autonomous "
              "Claude sessions here. Adds the RIVENDELL tab, the queue, Telegram approvals "
              "and the video kind.",
     "needs": "Rivendell token",
     "env_keys": ("FFMPEG_BIN", "WHISPER_BIN", "WHISPER_MODEL"),
     "origins": ("rivendell", "device-run", "team"),
     "routes": ("/local/rivendell",)},
    {"id": "design", "label": "Claude Design",
     "blurb": "Link a repo to its Claude Design system: pull tokens and component specs as a "
              "skill, push finished work back. Adds SETTINGS ▸ Projects' Design system row and the DESIGN button.",
     "needs": "claude.ai login",
     "env_keys": (),
     "origins": (),
     "routes": ("/local/design",)},
)

_IDS = tuple(p["id"] for p in PLUGINS)
_lock = threading.Lock()
_cache: "dict | None" = None


class IntegrationError(Exception):
    """One line a panel can show. Deliberately not a ValueError, so a route can
    tell a refusal (this) from a bad id (ValueError)."""


def _path() -> str:
    return os.path.join(os.path.dirname(config.BRIDGE_DB), "plugins.json")


def _adopt() -> dict:
    """The install set for a machine with no plugins.json: whatever it already
    uses. Imported here so rivendell.py and runner.py can import this module
    without a cycle; a source that cannot be read counts as unused. This runs
    under _lock, which is not reentrant: a source must never ask this module
    anything (installed(), flags(), state(), all of which take it), or the first
    boot hangs."""
    from bridge import project_config, rivendell_instances
    uses = {
        "rivendell": lambda: rivendell_instances.raw_instances(),
        "design": lambda: project_config.design_link_count() > 0,
    }
    found = {}
    for pid, probe in uses.items():
        try:
            found[pid] = bool(probe())
        except Exception:  # noqa: BLE001 - an unreadable source counts as unused
            found[pid] = False
    return found


def _save(d: dict) -> None:
    try:
        os.makedirs(os.path.dirname(_path()), exist_ok=True)
        tmp = _path() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(d, f)
        os.chmod(tmp, 0o600)
        os.replace(tmp, _path())
    except OSError:
        pass  # in-memory answer still holds for this process


def _load() -> dict:
    """The install set, every id in PLUGINS. Callers hold _lock."""
    global _cache
    if _cache is None:
        try:
            with open(_path(), encoding="utf-8") as f:
                raw = json.load(f)
            _cache = {pid: bool(raw.get(pid)) for pid in _IDS}
        except (OSError, ValueError, AttributeError):    # missing, corrupt, or not an object
            _cache = _adopt()
            _save(_cache)
    return _cache


def installed(pid: str) -> bool:
    """Is this plugin installed? An id that is not in PLUGINS reads False."""
    with _lock:
        return bool(_load().get(pid))


def flags() -> dict[str, bool]:
    """Every plugin's answer, id -> installed."""
    with _lock:
        return dict(_load())


def set_installed(pid: str, on: bool) -> None:
    """Install or remove a plugin. ValueError for an id not in PLUGINS;
    IntegrationError when removing Rivendell would interrupt a run in flight
    (a stopped worker interrupts its run, and one can run for hours)."""
    if pid not in _IDS:
        raise ValueError(f"unknown plugin {pid!r}")
    global _cache
    if pid == "rivendell":
        from bridge import rivendell    # local: rivendell.py imports this module
        if not on and rivendell.busy():
            raise IntegrationError(
                "A Rivendell run is in flight — let it finish, then remove Rivendell.")
    with _lock:
        cur = dict(_load())
        cur[pid] = bool(on)
        _cache = cur
        _save(cur)
    if pid == "rivendell":
        rivendell.reconfigure()     # outside the lock: it asks installed(), which takes it


def _count(n: int, noun: str) -> str:
    return f"{n} {noun}" + ("" if n == 1 else "s")


def _summary(pid: str) -> str:
    """One line of what an installed plugin is holding, for its card. A store
    that raises reads "": this is the page that installs and removes, so one bad
    store must not fail it (nor a POST that worked, which answers state())."""
    from bridge import project_config, rivendell_instances
    try:
        if pid == "rivendell":
            rows = rivendell_instances.instances()
            return f"{_count(len(rows), 'instance')} · {sum(1 for r in rows if r['enable'])} on"
        return _count(project_config.design_link_count(), "repo") + " linked"
    except Exception:  # noqa: BLE001 - one bad store blanks its own row only
        return ""


def state() -> list[dict]:
    """Every plugin with its current answer, for the Integrations page."""
    on = flags()
    return [{"id": p["id"], "label": p["label"], "blurb": p["blurb"], "needs": p["needs"],
             "installed": on[p["id"]],
             "summary": _summary(p["id"]) if on[p["id"]] else ""}
            for p in PLUGINS]


def origins() -> tuple[str, ...]:
    """The session origins of the installed plugins."""
    on = flags()
    return tuple(o for p in PLUGINS if on[p["id"]] for o in p["origins"])


def is_plugin_origin(origin) -> bool:
    """Does this session origin belong to an installed plugin's worker? Matches
    the base origin ("rivendell") and every per-instance one ("rivendell:prod")."""
    return bool(origin) and any(origin == o or origin.startswith(o + ":") for o in origins())


def route_owner(path: str) -> "str | None":
    """The plugin a route belongs to, installed or not: each server asks this
    once at its door and answers 404 when the owner is not installed."""
    for p in PLUGINS:
        if any(path == r or path.startswith(r + "/") for r in p["routes"]):
            return p["id"]
    return None


def hidden_env_keys() -> set[str]:
    """The env keys that belong to plugins that are not installed."""
    on = flags()
    return {k for p in PLUGINS if not on[p["id"]] for k in p["env_keys"]}
