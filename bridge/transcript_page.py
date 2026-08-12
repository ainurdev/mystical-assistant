"""Tail-slice an assembled transcript ({session, turns, events, next_cursor})
down to the last N event-bearing turns, so a 2608-event session doesn't ship
whole on first open. Applied AFTER assembly (store or native JSONL — 37ms for
the worst session, so re-querying isn't worth plumbing SQL for), which keeps
one implementation for both sources.

The turns list and next_cursor pass through untouched: turns are cheap (max
observed 34 rows) and the frontends' checkpoint list needs them all, while
next_cursor must keep meaning "the live head" so forward polling is unaffected.
Stdlib only."""


def tail_slice(data: dict, tail: int, before: int | None = None) -> dict:
    """Adds has_older / oldest_seq / tail_from; slices only `events`.

    tail:   keep the last N turns that have events (a prompt-only turn costs
            nothing to ship, so it doesn't spend the budget).
    before: consider only events with seq < before — the "load older" page.
    """
    events = data.get("events") or []
    considered = [e for e in events if before is None or e["seq"] < before]
    order = {t["id"]: i for i, t in enumerate(data.get("turns") or [])}
    bearing: list = []                     # turn ids with events, transcript order
    seen: set = set()
    for e in considered:
        tid = e.get("turn_id")
        if tid not in seen:
            seen.add(tid)
            bearing.append(tid)
    bearing.sort(key=lambda tid: order.get(tid, -1))
    keep = set(bearing[-tail:]) if tail > 0 else set()
    kept = [e for e in considered if e.get("turn_id") in keep]
    has_older = len(kept) < len(considered)
    out = dict(data)
    out["events"] = kept
    out["has_older"] = has_older
    out["oldest_seq"] = kept[0]["seq"] if kept else None
    out["tail_from"] = kept[0]["turn_id"] if (kept and has_older) else None
    return out
