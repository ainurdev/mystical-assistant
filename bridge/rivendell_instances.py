"""The set of rivendell-api instances the PR-review plugin connects to.

One bridge, several Rivendells: a production dashboard, a local one you develop
against, a staging one later. Each is an independent websocket connection with
its own URL, token, model and workdir, so this is a keyed collection rather than
the single flat ``RIVENDELL_*`` block it grew out of — the same shape
``bridge/trackers.py`` uses for Teamwork/Jira connections, persisted the same
way (a JSON file beside the session store, mode 0600, the token never returned in
full).

Migration is transparent: the first read, with no file yet, seeds one instance
named "production" from whatever ``RIVENDELL_*`` was set in the environment, so a
bridge that already had a production connection keeps it with nothing to do. The
``.env`` values stay the floor that seed was taken from; edit the instance from
the dashboard's PLUGINS tab afterwards.

``bridge/rivendell.py`` reads ``raw_instances()`` (tokens intact) to run one
worker per enabled instance; the dashboard reads ``instances()`` (masked) to draw
the panel. A save here nudges the worker manager (``rivendell.reconfigure``) so a
change is live without a restart, exactly as the old flat settings were.
"""

import json
import os
import re
import threading
import uuid

from bridge import config

_lock = threading.Lock()

# Bounds mirror the old envsettings PLUGINS rows so the panel can't store a
# timeout the worker would reject.
_TIMEOUT_MIN = 60
_TIMEOUT_MAX = 86400
_REVIEW_DEFAULT = 3600
_IMPL_DEFAULT = 10800
_MODEL_DEFAULT = "opus"


class RivendellError(Exception):
    """One line the panel can show. Never a traceback."""


# ---------------------------------------------------------------------------
# Store — rivendell_instances.json beside the DB, mode 0600
# ---------------------------------------------------------------------------

def _path() -> str:
    return os.path.join(os.path.dirname(config.BRIDGE_DB), "rivendell_instances.json")


def _seed_from_env() -> "dict | None":
    """The single instance the flat RIVENDELL_* environment described, or None.
    Used once, to migrate a bridge that already had a production connection."""
    if not (config.RIVENDELL_API_URL and config.RIVENDELL_TOKEN):
        return None
    return {
        "id": "production",
        "name": "production",
        "enable": bool(config.RIVENDELL_ENABLE),
        "api_url": config.RIVENDELL_API_URL,
        "token": config.RIVENDELL_TOKEN,
        "ws_url": config.RIVENDELL_WS_URL,
        "model": config.RIVENDELL_MODEL or _MODEL_DEFAULT,
        "workdir": config.RIVENDELL_WORKDIR,
        "review_timeout": config.RIVENDELL_REVIEW_TIMEOUT,
        "impl_timeout": config.RIVENDELL_IMPL_TIMEOUT,
    }


def _load() -> dict:
    """The instances map. On a first run with no file, migrate the .env instance
    (if any) and persist it, so the seed is a one-time event, not re-applied
    after the user later removes it. Callers hold ``_lock``."""
    try:
        with open(_path(), encoding="utf-8") as f:
            d = json.load(f)
        if isinstance(d, dict) and isinstance(d.get("instances"), dict):
            return d
    except (OSError, ValueError):
        pass
    seed = _seed_from_env()
    if seed:
        d = {"instances": {seed["id"]: seed}}
        _save(d)
        return d
    return {"instances": {}}


def _save(d: dict) -> None:
    os.makedirs(os.path.dirname(_path()), exist_ok=True)
    tmp = _path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, indent=1)
    os.chmod(tmp, 0o600)
    os.replace(tmp, _path())


def _slug(s: str) -> str:
    return re.sub(r"-+", "-", re.sub(r"[^a-z0-9]+", "-", (s or "").lower())).strip("-")


# ---------------------------------------------------------------------------
# Validation / coercion
# ---------------------------------------------------------------------------

def _norm_url(url: str) -> str:
    url = (url or "").strip().rstrip("/")
    if url and "://" not in url:
        url = "http://" + url
    return url


def _timeout(raw, default: int, label: str) -> int:
    if raw in (None, ""):
        return default
    try:
        n = int(raw)
    except (TypeError, ValueError):
        raise RivendellError(f"{label} must be a whole number of seconds")
    if not (_TIMEOUT_MIN <= n <= _TIMEOUT_MAX):
        raise RivendellError(f"{label} must be between {_TIMEOUT_MIN} and {_TIMEOUT_MAX} seconds")
    return n


def _clean(fields: dict, existing: "dict | None" = None) -> dict:
    """Validate a create/edit payload into a stored instance dict. On edit
    (``existing`` given), a blank token keeps the stored one — the panel shows
    the token masked and only resends it when it is deliberately changed."""
    name = (fields.get("name") or "").strip()
    if not name:
        raise RivendellError("name is required")
    api_url = _norm_url(fields.get("api_url"))
    if not api_url:
        raise RivendellError("API URL is required")
    token = (fields.get("token") or "").strip()
    if not token:
        if existing and existing.get("token"):
            token = existing["token"]
        else:
            raise RivendellError("token is required")
    workdir = (fields.get("workdir") or "").strip()
    if workdir:
        workdir = os.path.realpath(os.path.expanduser(workdir))
    return {
        "id": (existing or {}).get("id") or uuid.uuid4().hex[:8],
        "name": name,
        "enable": bool(fields.get("enable", True)),
        "api_url": api_url,
        "token": token,
        "ws_url": _norm_url(fields.get("ws_url")),
        "model": (fields.get("model") or "").strip() or _MODEL_DEFAULT,
        "workdir": workdir,
        "review_timeout": _timeout(fields.get("review_timeout"), _REVIEW_DEFAULT, "review timeout"),
        "impl_timeout": _timeout(fields.get("impl_timeout"), _IMPL_DEFAULT, "implementation timeout"),
    }


def _masked(inst: dict) -> dict:
    """What the panel may see. The token is never returned in full."""
    tok = inst.get("token") or ""
    out = {k: inst.get(k, "") for k in
           ("id", "name", "api_url", "ws_url", "model", "workdir")}
    out["enable"] = bool(inst.get("enable"))
    out["review_timeout"] = inst.get("review_timeout", _REVIEW_DEFAULT)
    out["impl_timeout"] = inst.get("impl_timeout", _IMPL_DEFAULT)
    out["origin"] = origin_for(inst)
    out["token"] = ("…" + tok[-4:]) if len(tok) > 4 else ("set" if tok else "")
    return out


def origin_for(inst: dict) -> str:
    """The session origin runs from this instance carry, e.g.
    ``rivendell:production``. The ``rivendell`` prefix keeps every instance's
    runs visible under config.is_plugin_origin; the suffix tells them apart."""
    return "rivendell:" + (_slug(inst.get("name", "")) or inst.get("id", ""))


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def instances() -> list:
    """Every instance, masked, for the dashboard panel."""
    with _lock:
        rows = list(_load()["instances"].values())
    return sorted((_masked(i) for i in rows), key=lambda i: i["name"].lower())


def raw_instances() -> list:
    """Every instance, tokens intact, for the worker manager."""
    with _lock:
        return list(_load()["instances"].values())


def get_instance(iid: str) -> "dict | None":
    with _lock:
        return _load()["instances"].get(iid or "")


def add_instance(**fields) -> dict:
    inst = _clean(fields)
    with _lock:
        d = _load()
        d["instances"][inst["id"]] = inst
        _save(d)
    return _masked(inst)


def update_instance(iid: str, **fields) -> dict:
    with _lock:
        d = _load()
        existing = d["instances"].get(iid or "")
        if existing is None:
            raise RivendellError("no such instance")
        inst = _clean(fields, existing)
        inst["id"] = existing["id"]      # id is never editable
        d["instances"][inst["id"]] = inst
        _save(d)
    return _masked(inst)


def remove_instance(iid: str) -> bool:
    with _lock:
        d = _load()
        gone = d["instances"].pop(iid or "", None) is not None
        if gone:
            _save(d)
    return gone
