"""Savers: Claude Code's own switches that make a turn cheaper, tried before kept.

Four levers the CLI already has. None is a dependency or a model call of ours
(row 6 of .mystical/docs/reports/Tools and platforms to boost Mystical.md):

  concise          outputStyle "Concise" in each run's --settings: the result
                   first, no recap, the same work. Not TRANSCRIPT ▸ OUTPUT
                   STYLE, which only changes how a turn is drawn.
  subagent_effort  CLAUDE_CODE_SUBAGENT_EFFORT=medium: subagents stop
                   inheriting the session's (usually max) effort.
  trim_tests       a PreToolUse hook (bridge/trimhook.py) that hands Claude a
                   test run's failures and summary, not every passing line.
  one-shot cache   CLAUDE_CODE_PROMPT_CACHE_TTL=5m on runner.run_blocking:
                   titles, commit messages and scouts never reuse their prefix,
                   so the hour-long cache write was waste. Always on, no switch.

None of them is measured on this stack, so each switch has a third position.
TRIAL puts it on every other new session (a coin flip seeded by the session id,
decided on the session's first run) and scores both halves on that first turn
only, with numbers the bridge already logs: answer words, tokens, tool calls
before the first edit, errors (store.first_turn_metrics). Medians per half, not
a model: at one person's scale only large effects show, and a keep-or-drop only
needs those. After TRIAL_N scored sessions the bell says so once and you pick ON
or OFF. Persisted next to the DB like ai_features.json. Stdlib only; nothing
here may raise into a turn.
"""

import hashlib
import json
import os
import statistics
import sys
import threading
import time

from bridge import config, notices, store

SAVERS = (
    {"key": "concise", "label": "Concise replies",
     "hint": "the result first, no recap: the same work, a shorter answer"},
    {"key": "subagent_effort", "label": "Subagent effort",
     "hint": "subagents work at medium effort instead of the session's own"},
    {"key": "trim_tests", "label": "Trim test output",
     "hint": "a test run hands Claude its failures, not every passing line"},
)
KEYS = tuple(s["key"] for s in SAVERS)
MODES = ("off", "trial", "on")
TRIAL_N = 20                 # scored sessions before a trial reports
ARM_TTL = 60 * 86400         # a session's halves are forgotten after this
ONE_SHOT_ENV = {"CLAUDE_CODE_PROMPT_CACHE_TTL": "5m"}

_lock = threading.Lock()


def _path() -> str:
    return os.path.join(os.path.dirname(config.BRIDGE_DB), "savers.json")


def _load() -> dict:
    try:
        with open(_path()) as f:
            raw = json.load(f)
        return raw if isinstance(raw, dict) else {}
    except (OSError, ValueError):
        return {}


def _save(d: dict) -> None:
    tmp = _path() + ".tmp"
    with open(tmp, "w") as f:
        json.dump(d, f)
    os.replace(tmp, _path())


def _mode(d: dict, key: str) -> str:
    m = (d.get("mode") or {}).get(key)
    return m if m in MODES else "off"


def set_mode(key: str, mode: str) -> None:
    """OFF, TRIAL or ON. A new TRIAL starts its count from now."""
    if key not in KEYS or mode not in MODES:
        raise ValueError(f"unknown saver {key!r} or mode {mode!r}")
    with _lock:
        d = _load()
        d.setdefault("mode", {})[key] = mode
        if mode == "trial":
            d.setdefault("since", {})[key] = time.time()
            d.setdefault("told", {}).pop(key, None)
        _save(d)


def _heads(sid: str, key: str) -> bool:
    return hashlib.sha256(f"{sid}:{key}".encode()).digest()[0] % 2 == 0


def assign(session_id: str) -> None:
    """Give a new session its half of every running trial. Called as each turn
    starts; only a session's first turn joins, so an old one never skews a count."""
    try:
        with _lock:
            d = _load()
            trials = [k for k in KEYS if _mode(d, k) == "trial"]
            if not trials or store.count_turns(session_id) > 1:
                return
            arms = d.setdefault("arms", {}).setdefault(session_id, {})
            new = {k: [_heads(session_id, k), time.time()] for k in trials if k not in arms}
            if not new:
                return
            arms.update(new)
            cut = time.time() - ARM_TTL
            d["arms"] = {s: a for s, a in d["arms"].items()
                         if any(v[1] > cut for v in a.values())}
            _save(d)
    except Exception as e:  # noqa: BLE001
        print(f"[savers] assign failed: {e}", file=sys.stderr)


def for_run(session_id: "str | None") -> set:
    """The savers a run of this session gets: every ON one, and each TRIAL whose
    coin landed on it."""
    try:
        d = _load()
        arms = (d.get("arms") or {}).get(session_id or "", {})
        return {k for k in KEYS if _mode(d, k) == "on"
                or (_mode(d, k) == "trial" and (arms.get(k) or [False])[0])}
    except Exception:  # noqa: BLE001
        return set()


def arms_for(session_id: str) -> list:
    """The trials this session got the saver in: its prompts' tag says so."""
    d = _load()
    arms = (d.get("arms") or {}).get(session_id, {})
    return [k for k in KEYS if _mode(d, k) == "trial" and (arms.get(k) or [False])[0]]


def settings_args(on: set, bridge_dir: "str | None" = None) -> list:
    """The --settings a run's savers add (runner._one_settings folds them in)."""
    s: dict = {}
    if "concise" in on:
        s["outputStyle"] = "Concise"
    if "trim_tests" in on:
        hook = os.path.join(bridge_dir or os.path.dirname(os.path.abspath(__file__)), "trimhook.py")
        s["hooks"] = {"PreToolUse": [{"matcher": "Bash", "hooks": [
            {"type": "command", "command": f"{sys.executable} -I {hook}"}]}]}
    return ["--settings", json.dumps(s)] if s else []


def env(on: set) -> dict:
    return {"CLAUDE_CODE_SUBAGENT_EFFORT": "medium"} if "subagent_effort" in on else {}


def _median(xs: list) -> "float | None":
    xs = [x for x in xs if x is not None]
    return statistics.median(xs) if xs else None


def results(key: str, d: "dict | None" = None) -> "dict | None":
    """Both halves of this saver's latest trial, scored on each session's first
    turn. Deltas are the saver's half against the other, in percent of the
    other's median; None while a half has nothing to compare."""
    d = _load() if d is None else d
    since = (d.get("since") or {}).get(key)
    if since is None:
        return None
    halves: dict = {True: [], False: []}
    for sid, arms in (d.get("arms") or {}).items():
        a = arms.get(key)
        if a and a[1] >= since and (m := store.first_turn_metrics(sid)):
            halves[bool(a[0])].append(m)
    on, off = halves[True], halves[False]

    def delta(field: str) -> "int | None":
        a, b = _median([m[field] for m in on]), _median([m[field] for m in off])
        return None if a is None or not b else round((a - b) / b * 100)

    return {"n": len(on) + len(off), "on": len(on), "off": len(off),
            "words": delta("words"), "tokens": delta("tokens"), "tools": delta("tools_before_edit"),
            "errors_on": sum(1 for m in on if m["error"]),
            "errors_off": sum(1 for m in off if m["error"])}


def state() -> list:
    """Every saver with its mode and, once a trial has run, its result."""
    d = _load()
    return [{**s, "mode": _mode(d, s["key"]), "target": TRIAL_N,
             "trial": results(s["key"], d)} for s in SAVERS]


def check_done() -> None:
    """After a turn: a trial that just reached TRIAL_N rings the bell, once."""
    try:
        d = _load()
        for s in SAVERS:
            k = s["key"]
            if _mode(d, k) != "trial" or (d.get("told") or {}).get(k):
                continue
            r = results(k, d)
            if r and r["n"] >= TRIAL_N:
                with _lock:
                    cur = _load()
                    cur.setdefault("told", {})[k] = time.time()
                    _save(cur)
                notices.emit("saver_trial", k, body=f"{s['label']}: the trial has its "
                             f"{TRIAL_N} sessions. Pick ON or OFF in AI management ▸ Savers.")
    except Exception as e:  # noqa: BLE001
        print(f"[savers] check failed: {e}", file=sys.stderr)
