"""Which AI-powered extras are on, and where that answer lives.

Everything registered here spends a model call the user did not ask for: a title,
a memory capture, a relevance verdict, a repo scout. That makes them power-user
features rather than defaults, so every one is OFF until switched on, and the
switch is in the dashboard's AI tab instead of an env var only whoever deployed
the bridge can reach.

Precedence is `ladder.default_policy`'s: the persisted setting wins; with none,
the environment setting (config.*) decides; with neither, off. Persisting next to
the DB rather than in it keeps this readable by a bridge whose store is mid-
migration, and one small JSON file is the whole state. Stdlib only.
"""

import json
import os
import threading

from bridge import config

# key   -- stable id used by the API, the UI and enabled()
# env   -- the config setting that decides when nothing is persisted
# cost  -- what one unit of this costs, for the UI to show next to the switch
FEATURES = (
    {"key": "memory", "env": "MEMORY_ENABLE", "label": "PROJECT MEMORY",
     "hint": "curated project facts in every turn, captured after edits",
     "cost": "2 haiku calls per edit turn"},
    {"key": "title", "env": "TITLE_ENABLE", "label": "AUTO TITLES",
     "hint": "names a session from its first exchange",
     "cost": "1 haiku call per new session"},
    {"key": "relevance", "env": "RELEVANCE_CHECK", "label": "NEW-SESSION GUARD",
     "hint": "offers a fresh session when a prompt changes the subject",
     "cost": "1 haiku call per long prompt"},
    {"key": "learning", "env": "LEARNING_ENABLE", "label": "TEACHER MODE",
     "hint": "logs what a run taught, for review later",
     "cost": "1 haiku call per reviewed turn"},
    {"key": "nextup", "env": "NEXTUP_ENABLE", "label": "NEXT-UP BOARD",
     "hint": "ranked next steps across the repos you touched recently",
     "cost": "1 scout per changed repo, free rung first"},
)

_KEYS = {f["key"] for f in FEATURES}
_lock = threading.Lock()
_cache: "dict | None" = None


def _path() -> str:
    return os.path.join(os.path.dirname(config.BRIDGE_DB), "ai_features.json")


def _load() -> dict:
    global _cache
    if _cache is None:
        try:
            with open(_path()) as f:
                raw = json.load(f)
            _cache = {k: bool(v) for k, v in (raw or {}).items() if k in _KEYS}
        except (OSError, ValueError, AttributeError):
            _cache = {}
    return _cache


def enabled(key: str) -> bool:
    """Is this feature on? Persisted setting first, then the env setting, then off."""
    with _lock:
        saved = _load().get(key)
    if saved is not None:
        return saved
    spec = next((f for f in FEATURES if f["key"] == key), None)
    return bool(getattr(config, spec["env"], False)) if spec else False


def set_enabled(key: str, on: "bool | None") -> None:
    """Switch a feature; None clears the override back to the env setting."""
    if key not in _KEYS:
        raise ValueError(f"unknown feature {key!r}")
    global _cache
    with _lock:
        cur = dict(_load())
        if on is None:
            cur.pop(key, None)
        else:
            cur[key] = bool(on)
        _cache = cur
        try:
            os.makedirs(os.path.dirname(_path()), exist_ok=True)
            with open(_path(), "w") as f:
                json.dump(cur, f)
        except OSError:
            pass  # in-memory setting still holds for this process


def state() -> list[dict]:
    """Every feature with its current answer, for the settings UI."""
    return [{**f, "enabled": enabled(f["key"])} for f in FEATURES]
