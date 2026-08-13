"""tail_slice: last-N-turns windowing over an assembled transcript."""
from bridge.transcript_page import tail_slice


def _data(events, turns=None):
    tids = turns or sorted({e["turn_id"] for e in events})
    return {
        "session": {"id": "s"},
        "turns": [{"id": t, "seq": i} for i, t in enumerate(tids)],
        "events": events,
        "next_cursor": (events[-1]["seq"] + 1) if events else 0,
    }


def _ev(seq, turn):
    return {"seq": seq, "turn_id": turn, "type": "text"}


THREE_TURNS = [_ev(1, "t1"), _ev(2, "t1"), _ev(3, "t2"), _ev(4, "t3"), _ev(5, "t3")]


def test_tail_keeps_last_n_turns_events():
    out = tail_slice(_data(THREE_TURNS), tail=2)
    assert [e["seq"] for e in out["events"]] == [3, 4, 5]
    assert out["has_older"] is True
    assert out["oldest_seq"] == 3
    assert out["tail_from"] == "t2"


def test_turns_and_cursor_pass_through():
    d = _data(THREE_TURNS)
    out = tail_slice(d, tail=2)
    assert out["turns"] == d["turns"]
    assert out["next_cursor"] == 6            # still the live head


def test_tail_covering_everything_flags_nothing():
    out = tail_slice(_data(THREE_TURNS), tail=3)
    assert len(out["events"]) == 5
    assert out["has_older"] is False
    assert out["tail_from"] is None           # no slice -> render from the top


def test_before_pages_backwards():
    out = tail_slice(_data(THREE_TURNS), tail=1, before=3)
    assert [e["seq"] for e in out["events"]] == [1, 2]
    assert out["has_older"] is False          # t1 was the oldest turn
    assert out["oldest_seq"] == 1


def test_before_with_more_behind():
    out = tail_slice(_data(THREE_TURNS), tail=1, before=4)
    assert [e["seq"] for e in out["events"]] == [3]
    assert out["has_older"] is True


def test_empty_events():
    out = tail_slice(_data([]), tail=5)
    assert out["events"] == []
    assert out["has_older"] is False
    assert out["oldest_seq"] is None
    assert out["tail_from"] is None


def test_prompt_only_turns_do_not_count_toward_n():
    # t2 exists in turns but has no events; tail counts event-bearing turns.
    evs = [_ev(1, "t1"), _ev(2, "t3")]
    out = tail_slice(_data(evs, turns=["t1", "t2", "t3"]), tail=1)
    assert [e["seq"] for e in out["events"]] == [2]
    assert out["has_older"] is True


def test_transcript_for_applies_tail(monkeypatch):
    from bridge.miniapp import server as mini
    canned = _data(THREE_TURNS)
    monkeypatch.setattr(mini.store, "transcript", lambda sid, cursor=0: dict(canned))
    out = mini.transcript_for({"id": "s", "origin": "miniapp"}, tail=2)
    assert out["has_older"] is True and [e["seq"] for e in out["events"]] == [3, 4, 5]


def test_transcript_for_without_tail_is_unchanged(monkeypatch):
    from bridge.miniapp import server as mini
    canned = _data(THREE_TURNS)
    monkeypatch.setattr(mini.store, "transcript", lambda sid, cursor=0: dict(canned))
    out = mini.transcript_for({"id": "s", "origin": "miniapp"})
    assert "has_older" not in out and len(out["events"]) == 5


def test_transcript_for_tails_native_jsonl(monkeypatch):
    from bridge.miniapp import server as mini
    canned = _data(THREE_TURNS)
    monkeypatch.setattr(mini.transcript_jsonl, "find_transcript", lambda sid: "/tmp/x.jsonl")
    monkeypatch.setattr(mini.transcript_jsonl, "parse_jsonl",
                        lambda path, cursor=0: {k: canned[k] for k in ("turns", "events", "next_cursor")})
    out = mini.transcript_for({"id": "s", "origin": "vscode", "claude_session_id": "u"}, tail=2)
    assert out["has_older"] is True
