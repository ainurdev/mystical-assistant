"""Tail-slice an assembled transcript ({session, turns, events, next_cursor})
down to the last N event-bearing turns, so a 2608-event session doesn't ship
whole on first open. Applied AFTER assembly (store or native JSONL — 37ms for
the worst session, so re-querying isn't worth plumbing SQL for), which keeps
one implementation for both sources.

The turns list and next_cursor pass through untouched: turns are cheap (max
observed 34 rows) and the dashboard's TURNS tab needs them all, while
next_cursor must keep meaning "the live head" so forward polling is unaffected.
summarize() gives each turn the outline that tab draws before its events are
cut, so a turn behind the tail still says what it answered and asked.
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


ANSWER_MAX = 240


def summarize(data: dict) -> dict:
    """Gives every turn a `sum`: the outline the TURNS tab draws for it whether or
    not its events are on the client — the first line of its last result that
    said something, its tool count, its asks (with the label you picked or the
    note you wrote) and steers in order, and when its last event landed (a killed
    turn has no elapsed of its own). Run on the assembled transcript before
    tail_slice drops the older events, so it costs one pass over what is already
    in memory. A steer is named by its index among its turn's events, which is
    how the client anchors it (lib/checkpoints steerKey).

    Turns are copied, not mutated; events pass through as they are."""
    turns = [dict(t) for t in data.get("turns") or []]
    sums = {t["id"]: {"answer": "", "tools": 0, "marks": [], "ended": None} for t in turns}
    index: dict = {}                    # turn id -> events of it seen so far
    asks: dict = {}                     # request id -> its question mark
    for e in data.get("events") or []:
        tid = e.get("turn_id")
        s = sums.get(tid)
        if s is None:
            continue
        i = index.get(tid, 0)
        index[tid] = i + 1
        if e.get("at") is not None:
            s["ended"] = e["at"]
        kind = e.get("type")
        if kind == "tool":
            s["tools"] += 1
        elif kind == "result":
            line = next((ln.strip() for ln in str(e.get("result") or "").splitlines() if ln.strip()), "")
            if line:
                s["answer"] = line[:ANSWER_MAX]
        elif kind == "question":
            q = (e.get("questions") or [{}])[0]
            mark = {"kind": "question", "id": e.get("request_id"),
                    "label": q.get("header") or (q.get("question") or "")[:80] or "question",
                    "pick": None, "note": None}
            asks[e.get("request_id")] = mark
            s["marks"].append(mark)
        elif kind == "question_answered":
            mark = asks.get(e.get("request_id"))
            first = (e.get("answers") or [{}])[0]
            if mark is not None:
                mark["pick"] = (first.get("labels") or [None])[0]
                mark["note"] = first.get("notes") or None
        elif kind == "steer":
            s["marks"].append({"kind": "steer", "i": i, "label": e.get("text") or ""})
    for t in turns:
        t["sum"] = sums[t["id"]]
    return {**data, "turns": turns}
