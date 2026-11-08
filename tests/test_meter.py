"""bridge/meter.py: the SESSION tab's window, time and spend, from a small
transcript whose numbers are worked out by hand below."""

import json
import os
import tempfile

from bridge import config, meter, store, transcript_jsonl

T = 1_800_000_000.0
CSID = "11111111-2222-3333-4444-555555555555"


def _iso(dt):
    import datetime
    return datetime.datetime.fromtimestamp(T + dt, datetime.timezone.utc).isoformat().replace("+00:00", "Z")


def _u(inp, cr, cw, out):
    return {"input_tokens": inp, "cache_read_input_tokens": cr, "cache_creation_input_tokens": cw, "output_tokens": out}


def _asst(dt, mid, usage, *blocks):
    # One record per block, each repeating the message's usage, as the CLI writes it.
    return [{"type": "assistant", "timestamp": _iso(dt), "message": {"id": mid, "usage": usage, "content": [b]}}
            for b in blocks]


def _user(dt, content, **extra):
    return [{"type": "user", "timestamp": _iso(dt), "message": {"role": "user", "content": content}, **extra}]


def _result(dt, tid, content):
    return _user(dt, [{"type": "tool_result", "tool_use_id": tid, "content": content}])


RECORDS = (
    _user(0, "build the thing")
    + _asst(2, "m1", _u(2, 0, 1000, 50), {"type": "thinking", "thinking": ""},
            {"type": "tool_use", "id": "r1", "name": "Read", "input": {"file_path": "/w/app.py"}})
    + _result(3, "r1", "x" * 1600)
    + _asst(4, "m2", _u(2, 1000, 452, 20),
            {"type": "tool_use", "id": "q1", "name": "AskUserQuestion", "input": {"questions": [{"header": "Pick"}]}})
    + _result(64, "q1", "y" * 60)
    + _asst(65, "m3", _u(2, 1452, 40, 30),
            {"type": "tool_use", "id": "g1", "name": "Agent", "input": {"description": "review it"}})
    + _result(95, "g1", "z" * 200)
    + _asst(96, "m4", _u(2, 1492, 80, 10),
            {"type": "tool_use", "id": "b1", "name": "Bash", "input": {"command": "pytest -q"}})
    + _result(106, "b1", "w" * 400)
    + _asst(107, "m5", _u(2, 1572, 110, 5), {"type": "text", "text": "done"})
    + _user(300, "again")
    + [{"type": "system", "subtype": "compact_boundary", "timestamp": _iso(301), "compactMetadata": {"preTokens": 1684}}]
    + _user(301, "s" * 800, isCompactSummary=True)
    + _asst(302, "m6", _u(2, 0, 700, 5), {"type": "text", "text": "ok"})
)
HELPER = (_asst(66, "h1", _u(1, 0, 100, 10), {"type": "text", "text": "a"})
          + _asst(80, "h2", _u(1, 100, 5, 7), {"type": "text", "text": "b"}))
TURNS = [{"id": "T1", "started": T, "elapsed": 108, "status": "done"},
         {"id": "T2", "started": T + 300, "elapsed": 3, "status": "done"}]


def _write(root):
    proj = os.path.join(root, "-w")
    os.makedirs(os.path.join(proj, CSID, "subagents"))
    with open(os.path.join(proj, CSID + ".jsonl"), "w") as f:
        f.writelines(json.dumps(r) + "\n" for r in RECORDS)
    with open(os.path.join(proj, CSID, "subagents", "agent-x.jsonl"), "w") as f:
        f.writelines(json.dumps(r) + "\n" for r in HELPER)
    with open(os.path.join(proj, CSID, "subagents", "agent-x.meta.json"), "w") as f:
        json.dump({"description": "review it", "toolUseId": "g1", "finished": True}, f)


def _meter(monkeypatch, turns=TURNS):
    root = tempfile.mkdtemp()
    _write(root)
    monkeypatch.setattr(transcript_jsonl, "PROJECTS_DIR", root)
    return meter.read({"claude_session_id": CSID}, turns, now=T + 400)


def test_one_point_per_request_and_a_message_counts_once(monkeypatch):
    m = _meter(monkeypatch)
    assert [w for _, w in m["series"]] == [1002, 1454, 1494, 1574, 1684, 702]
    assert m["turns"]["T1"] == {"spent": 7323, "requests": 5, "from": 1002, "to": 1684, "peak": 1684}
    assert m["turns"]["T2"]["spent"] == 707


def test_the_window_after_a_compaction_is_start_up_summary_and_prompt(monkeypatch):
    m = _meter(monkeypatch)
    assert m["window"] == {"total": 702, "kinds": {"startup": 501, "summary": 200, "you": 1}}


def test_spend_by_kind_adds_up_to_the_session_and_its_helpers(monkeypatch):
    m = _meter(monkeypatch)
    main = 7323 + 707
    assert m["spent"]["total"] == main + 224
    assert sum(m["spent"]["kinds"].values()) == main + 224
    assert m["spent"]["fresh"] + m["spent"]["reread"] == main
    # Before the compaction: the Read's 402 sat in five windows, Claude's 110 grew in.
    assert m["spent"]["kinds"]["files"] == 402 * 4


def test_who_was_working_when(monkeypatch):
    m = _meter(monkeypatch)
    assert m["time"] == {"claude": 10, "tools": 11, "helpers": 30, "you": 60, "away": 192}
    assert [s[2] for s in m["segs"]][:9] == ["claude", "tools", "claude", "you", "claude", "helpers",
                                              "claude", "tools", "claude"]


def test_helpers_carry_their_own_spend(monkeypatch):
    m = _meter(monkeypatch)
    (h,) = m["helpers"]
    assert (h["what"], h["tokens"], h["requests"], h["running"], h["turn"]) == ("review it", 224, 2, False, "T1")


def test_the_biggest_items_by_window_and_by_spend(monkeypatch):
    m = _meter(monkeypatch)
    assert m["biggest"]["window"]["startup"][0]["tokens"] == 501
    files = m["biggest"]["spent"]["files"][0]
    assert (files["label"], files["size"], files["reads"], files["tokens"], files["turn"]) == ("/w/app.py", 402, 4, 1608, "T1")
    you = [x["label"] for x in m["biggest"]["spent"]["you"]]
    assert "your answer: Pick" in you


def test_a_running_turn_runs_to_now_and_reads_grow(monkeypatch):
    root = tempfile.mkdtemp()
    _write(root)
    monkeypatch.setattr(transcript_jsonl, "PROJECTS_DIR", root)
    live = [dict(TURNS[0], elapsed=None, status="running")]
    path = os.path.join(root, "-w", CSID + ".jsonl")
    with open(path, "w") as f:      # only the first message so far
        f.writelines(json.dumps(r) + "\n" for r in RECORDS[:3])
    first = meter.read({"claude_session_id": CSID}, live, now=T + 10)
    assert [w for _, w in first["series"]] == [1002]
    assert first["segs"][-1][1] == T + 10
    with open(path, "a") as f:      # more arrives: read from where it stopped
        f.writelines(json.dumps(r) + "\n" for r in RECORDS[3:5])
    assert [w for _, w in meter.read({"claude_session_id": CSID}, live, now=T + 20)["series"]] == [1002, 1454]


def test_no_transcript_reads_as_none(monkeypatch):
    monkeypatch.setattr(transcript_jsonl, "PROJECTS_DIR", tempfile.mkdtemp())
    assert meter.read({"claude_session_id": CSID}, TURNS) is None


def test_the_endpoint_serves_an_owned_session_only(monkeypatch):
    from bridge.dashboard import server as dash
    root = tempfile.mkdtemp()
    _write(root)
    monkeypatch.setattr(transcript_jsonl, "PROJECTS_DIR", root)
    store.init()
    sid = store.create_session(config.DASH_CHAT_ID, "/proj")["id"]
    store.set_claude_session_id(sid, CSID)
    other = store.create_session(config.DASH_CHAT_ID + 1, "/proj")["id"]
    box = {}
    h = dash.Handler.__new__(dash.Handler)
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    h._get_api(f"/local/sessions/{sid}/meter", {})
    assert box["code"] == 200 and len(box["obj"]["series"]) == 6
    h._get_api(f"/local/sessions/{other}/meter", {})
    assert box["code"] == 404
