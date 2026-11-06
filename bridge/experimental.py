"""The EXPERIMENTAL switch: multi-agent chats, provider switching, shared tools.

Everything in docs/superpowers/plans/multi-agent-chats.md is behind this one
setting, off by default. With it off, the bridge behaves as it did before that
work: same prompts, same refusals, same UI, and no new process or tool reaches a
run. The tables and columns exist either way (they are additive), so turning it
off keeps what a chat already did, read-only in spirit: its helpers stay listed
in the database but no new one starts.

Persisted beside the DB rather than in it, like aifeatures: one small JSON file,
readable by a bridge whose store is mid-migration, and read per call so the
setting applies to the next turn with no restart. Stdlib only.

It also holds the chat defaults a new multi-agent chat starts from
(channel.config_for overlays a chat's own picks on these).
"""

import json
import os
import threading

from bridge import config

HELPERS = ("off", "ask", "auto")
DEFAULTS = {"helpers": "ask", "max_agents": 5, "max_hops": 20, "per_account": 3}
LIMITS = {"max_agents": (1, 20), "max_hops": (1, 200), "per_account": (1, 20)}

_lock = threading.Lock()
_cache: "tuple[int, dict] | None" = None


def _path() -> str:
    return os.path.join(os.path.dirname(config.BRIDGE_DB), "experimental.json")


def _read() -> dict:
    global _cache
    try:
        stamp = os.stat(_path()).st_mtime_ns
    except OSError:
        return {}
    with _lock:
        if _cache and _cache[0] == stamp:
            return dict(_cache[1])
    try:
        with open(_path(), encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError):
        return {}
    data = data if isinstance(data, dict) else {}
    with _lock:
        _cache = (stamp, data)
    return dict(data)


def _write(data: dict) -> None:
    global _cache
    tmp = _path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, _path())
    with _lock:
        _cache = None


def enabled() -> bool:
    return _read().get("enabled") is True


def set_enabled(on: bool) -> None:
    _write({**_read(), "enabled": bool(on)})


def clean(patch: dict) -> dict:
    """The valid knobs of a defaults or per-chat patch; ValueError on a bad one."""
    out = {}
    for k, v in (patch or {}).items():
        if k == "helpers":
            if v not in HELPERS:
                raise ValueError("helpers must be off, ask or auto")
            out[k] = v
        elif k in LIMITS:
            try:
                n = int(v)
            except (TypeError, ValueError):
                raise ValueError(f"{k} must be a number") from None
            lo, hi = LIMITS[k]
            if not lo <= n <= hi:
                raise ValueError(f"{k} must be {lo}-{hi}")
            out[k] = n
    return out


def defaults() -> dict:
    return {**DEFAULTS, **(_read().get("defaults") or {})}


def set_defaults(patch: dict) -> dict:
    data = _read()
    data["defaults"] = {**(data.get("defaults") or {}), **clean(patch)}
    _write(data)
    return defaults()


def state() -> dict:
    """What every surface asks for: the switch and the chat defaults."""
    return {"enabled": enabled(), "defaults": defaults()}
