"""Derived cards for the CANVAS gutter: facts, one optional model call, a cache.

A transcript is a queue, so anything a model produces is buried by the next
message. The board's gutter is where output that must *stand* goes — and the
cheapest way to fill it is not five features but one: a card is deterministic
facts, an optional one-shot that turns them into a few lines, and a watermark
naming the cheapest thing that changes when the answer would.

Same watermark -> served from cache -> costs nothing. That is `nextup.py`'s
posture (a repo whose state has not moved is free) applied per card, and it is
what makes a card safe to refetch on every turn end.

Nothing here raises. A card whose facts blow up renders empty; a card whose
model call fails keeps the last answer and marks it stale — a blank card is a
worse answer than an old one, and an exception into a turn's lifecycle is
worse than both (the scar `titler.py` carries).

The cache is one JSON file beside the DB, not a table: this is derived data,
and derived data must never become a migration.

ponytail: cards are computed on request, never pushed. If a card ever needs to
be fresh before it is asked for, hook it where `learn.kick` hangs, not here.
"""

import json
import os
import sys
import threading
import time

from bridge import config, native, runner

_MAX_FACTS = 6000  # what a one-shot may be handed, in characters
_lock = threading.Lock()


def _cache_path() -> str:
    return os.path.join(os.path.dirname(config.BRIDGE_DB), "cards.json")


def _load() -> dict:
    try:
        with open(_cache_path()) as f:
            return json.load(f) or {}
    except (OSError, ValueError):
        return {}


def _save(state: dict) -> None:
    try:
        with open(_cache_path(), "w") as f:
            json.dump(state, f)
    except OSError:
        pass


def _one_shot(chat_id: int, prompt: str, cwd: "str | None") -> str:
    """One cheap call, tagged so its JSONL never surfaces as a phantom session.
    Mirrors titler._ask: errors are data, so they are logged, not raised."""
    text, _sid, _cost, is_error = runner.run_blocking(
        chat_id, f"{native.INTERNAL_ONESHOT_TAG}\n{prompt}", cwd=cwd or None,
        timeout=45, model="haiku", skip_pack=True)
    if is_error:
        print(f"[cards] one-shot error: {str(text)[:200]}", file=sys.stderr)
        return ""
    return (text or "").strip()


def card(key: str) -> "dict | None":
    return next((c for c in CARDS if c["key"] == key), None)


def render(key: str, ctx: dict, force: bool = False) -> dict:
    spec = card(key)
    if spec is None:
        return {"key": key, "title": key.upper(), "shape": "lines",
                "body": None, "generated": 0, "stale": True}
    out = {"key": key, "title": spec["title"], "shape": spec["shape"],
           "body": None, "generated": 0, "stale": False}
    slot = f"{ctx.get('id') or ''}:{key}"
    with _lock:
        state = _load()
    prev = state.get(slot) or {}
    try:
        mark = spec["watermark"](ctx)
    except Exception:  # noqa: BLE001 — a watermark is a convenience, not a contract
        mark = ""
    if not force and mark and prev.get("mark") == mark:
        return {**out, "body": prev.get("body"), "generated": prev.get("at", 0)}
    try:
        facts = spec["facts"](ctx)
    except Exception as e:  # noqa: BLE001
        print(f"[cards] {key} facts failed: {e}", file=sys.stderr)
        return {**out, "body": prev.get("body"), "generated": prev.get("at", 0),
                "stale": True}
    if not spec["prompt"]:
        body = facts
    else:
        try:
            body = _one_shot(ctx.get("chat_id") or 0,
                             spec["prompt"].format(
                                 facts=json.dumps(facts, indent=1)[:_MAX_FACTS]),
                             ctx.get("cwd"))
        except Exception as e:  # noqa: BLE001
            print(f"[cards] {key} call failed: {e}", file=sys.stderr)
            return {**out, "body": prev.get("body"), "generated": prev.get("at", 0),
                    "stale": True}
        if not body:
            return {**out, "body": prev.get("body"), "generated": prev.get("at", 0),
                    "stale": True}
    at = time.time()
    with _lock:
        state = _load()
        state[slot] = {"mark": mark, "body": body, "at": at}
        _save(state)
    return {**out, "body": body, "generated": at}


def context(session: "dict | None" = None, project: "str | None" = None) -> dict:
    """What every card's facts/watermark reads. `id` is the cache slot: the
    session for session cards, the project for project ones."""
    cwd = (session or {}).get("cwd") or (
        os.path.normpath(os.path.join(config.BASE_PATH, (project or "/").lstrip("/")))
        if project else config.BASE_PATH)
    return {"id": (session or {}).get("id") or project or "",
            "session": session, "project": project, "cwd": cwd,
            "chat_id": (session or {}).get("chat_id") or 0}


CARDS: tuple = ()   # filled by the card modules below (Tasks 4, 6, 7, 8)
