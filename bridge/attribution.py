"""Where a session's wall clock and tokens actually went.

Read-side only: every input is already written by the time this runs — `tool_done`
carries `ms`, its row carries `ts`, and the turn carries elapsed and tokens. So a
breakdown is a query, not a pipeline, and it costs a session nothing to ask for one.

Best-effort like graphmap and memory: any failure yields a zeroed breakdown rather
than an exception, because this is a readout and a readout must never be the reason
a turn or a page fails.

Dollars are deliberately absent. The CLI's total_cost_usd prices these runs off the
API list rate while they go through a subscription (see 9f612a4); time and tokens
are the two numbers with something real behind them.
See docs/superpowers/specs/2026-08-13-session-time-token-attribution-design.md
"""

import logging

from bridge import config, store

log = logging.getLogger("bridge.attribution")

# Time inside this tool is a human deciding, not a session being slow, so it is
# reported on its own line and never mixed into tool time.
WAIT_TOOL = "AskUserQuestion"


def merge_intervals(spans) -> float:
    """Seconds covered by the union of [start, end] spans.

    Overlapping calls cover their span once. Summing durations instead
    double-counts wall clock — 6% across the session that motivated this, where
    202 of 2019 calls overlapped a sibling — and a breakdown that claims more time
    than the session took is worse than no breakdown."""
    ordered = sorted((s, e) for s, e in spans if e > s)
    total = 0.0
    start = end = None
    for s, e in ordered:
        if end is None:
            start, end = s, e
        elif s <= end:
            end = max(end, e)
        else:
            total += end - start
            start, end = s, e
    if end is not None:
        total += end - start
    return total


def _empty() -> dict:
    return {"wall": 0.0, "tools": {}, "thinking_s": 0.0, "waiting_s": 0.0,
            "model_s": 0.0, "tokens": None, "capped": 0, "turns": 0}


def _tokens(rows: list[dict]) -> "dict | None":
    """Summed spend, or None when no turn ever reported any. The distinction
    matters: a session from before this was recorded is unknown, not free."""
    cols = (("in", "tok_in"), ("out", "tok_out"),
            ("cache_w", "tok_cache_w"), ("cache_r", "tok_cache_r"))
    if not any(r.get(c) is not None for r in rows for _, c in cols):
        return None
    return {key: sum(r.get(col) or 0 for r in rows) for key, col in cols}


def breakdown(session_id: str) -> dict:
    """What this session spent and on what. See module docstring for the posture."""
    try:
        return _breakdown(session_id)
    except Exception:  # noqa: BLE001
        log.debug("attribution breakdown failed", exc_info=True)
        return _empty()


def _breakdown(session_id: str) -> dict:
    turns = store.turn_metrics(session_id)
    events = store.timed_events(session_id)

    wall = float(sum(t.get("elapsed") or 0 for t in turns))
    # Both conditions are required. Elapsed alone misreads a turn that legitimately
    # ran past the cap after an internal resume as one the cap killed.
    capped = sum(1 for t in turns if t.get("status") == "error"
                 and (t.get("elapsed") or 0) >= config.RUN_TIMEOUT)

    names: dict = {}          # tool-call id -> tool name
    started: set = set()      # ids seen as `tool`
    finished: set = set()     # ids seen as `tool_done`
    spans: dict = {}          # tool name -> [(start, end), ...]
    thinking: list = []

    for ev in events:
        kind = ev.get("type")
        ts = ev.get("ts")
        if kind == "tool":
            if ev.get("id") is not None:
                names[ev["id"]] = ev.get("name") or "?"
                started.add(ev["id"])
            continue
        if ts is None:
            continue
        # `ms` is the duration and the row's ts is the end, so this is the start.
        dur = (ev.get("ms") or 0) / 1000.0
        if kind == "thinking":
            thinking.append((ts - dur, ts))
        elif kind == "tool_done":
            finished.add(ev.get("id"))
            spans.setdefault(names.get(ev.get("id"), "?"), []).append((ts - dur, ts))

    unfinished: dict = {}
    for tid in started - finished:
        name = names.get(tid, "?")
        unfinished[name] = unfinished.get(name, 0) + 1

    tools = {}
    for name in set(spans) | set(unfinished):
        if name == WAIT_TOOL:
            continue
        iv = spans.get(name, [])
        naive = sum(e - s for s, e in iv)
        calls = len(iv) + unfinished.get(name, 0)
        tools[name] = {"calls": calls,
                       "union_s": merge_intervals(iv),
                       "naive_s": naive,
                       "avg_s": naive / calls if calls else 0.0,
                       "unfinished": unfinished.get(name, 0)}

    # One merge across every span at once. Adding three separate unions would
    # re-introduce the double-counting the union exists to remove — a thinking
    # span can sit inside a tool call.
    attributed = merge_intervals([s for iv in spans.values() for s in iv] + thinking)

    return {
        "wall": wall,
        "tools": tools,
        "thinking_s": merge_intervals(thinking),
        "waiting_s": merge_intervals(spans.get(WAIT_TOOL, [])),
        # Whatever wall clock nothing else claims is the model generating. Clamped:
        # skewed or nested spans can attribute past the turn's own elapsed, and a
        # negative readout would be nonsense rather than information.
        "model_s": max(0.0, wall - attributed),
        "tokens": _tokens(turns),
        "capped": capped,
        "turns": len(turns),
    }
