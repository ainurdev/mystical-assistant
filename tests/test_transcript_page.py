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


# --- summarize: every turn's outline, loaded or not ---------------------------
from bridge.transcript_page import summarize


def _sum_data():
    ev = [
        {"seq": 1, "turn_id": "t1", "type": "tool", "at": 100.0},
        {"seq": 2, "turn_id": "t1", "type": "question", "request_id": "q1",
         "questions": [{"header": "Design", "question": "Which one?"}], "at": 101.0},
        {"seq": 3, "turn_id": "t1", "type": "question_answered", "request_id": "q1",
         "answers": [{"header": "Design", "labels": ["A · Ledger (Recommended)"]}], "at": 102.0},
        {"seq": 4, "turn_id": "t1", "type": "steer", "text": "also the mobile view", "at": 103.0},
        {"seq": 5, "turn_id": "t1", "type": "question", "request_id": "q2",
         "questions": [{"header": "", "question": "Push it?"}], "at": 104.0},
        {"seq": 6, "turn_id": "t1", "type": "question_answered", "request_id": "q2",
         "answers": [{"header": "Push", "labels": [], "notes": "not yet"}], "at": 105.0},
        {"seq": 7, "turn_id": "t1", "type": "result", "result": "", "at": 106.0},
        {"seq": 8, "turn_id": "t1", "type": "result", "result": "\n\n## Done.\nMore below.", "at": 107.0},
        {"seq": 9, "turn_id": "t2", "type": "tool", "at": 200.0},
        {"seq": 10, "turn_id": "t2", "type": "question", "request_id": "q3",
         "questions": [{"header": "Push", "question": "Push?"}], "at": 201.0},
    ]
    return _data(ev, turns=["t1", "t2", "t3"])


def test_summary_reads_each_turns_outline():
    s = {t["id"]: t["sum"] for t in summarize(_sum_data())["turns"]}
    assert s["t1"]["answer"] == "## Done."           # the last result that said something, first line
    assert s["t1"]["tools"] == 1
    assert s["t1"]["ended"] == 107.0
    assert s["t1"]["marks"] == [
        {"kind": "question", "id": "q1", "label": "Design", "pick": "A · Ledger (Recommended)", "note": None},
        {"kind": "steer", "i": 3, "label": "also the mobile view"},
        {"kind": "question", "id": "q2", "label": "Push it?", "pick": None, "note": "not yet"},
    ]


def test_summary_of_an_unanswered_ask_and_a_silent_turn():
    s = {t["id"]: t["sum"] for t in summarize(_sum_data())["turns"]}
    assert s["t2"]["answer"] == ""
    assert s["t2"]["marks"] == [{"kind": "question", "id": "q3", "label": "Push", "pick": None, "note": None}]
    assert s["t3"] == {"answer": "", "tools": 0, "marks": [], "ended": None}


def test_summary_caps_the_answer_and_leaves_the_input_alone():
    d = _data([{"seq": 1, "turn_id": "t1", "type": "result", "result": "x" * 900}])
    out = summarize(d)
    assert len(out["turns"][0]["sum"]["answer"]) == 240
    assert "sum" not in d["turns"][0]
    assert out["events"] is d["events"]
