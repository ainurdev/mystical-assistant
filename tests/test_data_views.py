"""show_data's contract (bridge/data_views.py): what an agent sends becomes one shape to draw."""
import json
import time

import pytest

from bridge import config, data_views as dv, experimental, gateway, gateway_tools as gt, store


@pytest.mark.parametrize("raw,want", [
    (1234.5, 1234.5), ("1234.5", 1234.5), ("1.234,56", 1234.56), ("1,234.56", 1234.56), ("€ 1,234.56", 1234.56),
    ("1.234.567", 1234567.0), ("1,234", None), ("1.000", None), ("0.125", 0.125), ("1234.567", 1234.567), ("1,234,567", 1234567.0), ("0,50", 0.5), ("12,5", 12.5), ("12%", 12.0), ("(40)", -40.0),
    ("-3", -3.0), ("EUR 10", 10.0), ("1 234,50", 1234.5), (0, 0.0),
    ("abc", None), ("", None), (None, None), (True, None), ("12 apples and 3", None), (float("nan"), None),
])
def test_numbers_as_agents_send_them(raw, want):
    assert dv.to_number(raw) == want


@pytest.mark.parametrize("raw,want", [
    ("2026-11-07", "2026-11-07"), ("07-11-2026", "2026-11-07"), ("2026-11", "2026-11"),
    ("2026-11-07T10:00:00Z", "2026-11-07"), (1793985411, "2026-11-06"), ("soon", None), (-5, None),
])
def test_dates(raw, want):
    assert dv.to_date(raw) == want


def test_a_sheet_types_its_values_and_computes_totals():
    ev, notes = dv.build({"view": "table", "title": "Invoices", "currency": "eur", "columns": [
        {"key": "who"}, {"key": "amt", "label": "Amount", "type": "money"}, {"key": "on", "type": "date"},
        {"key": "pct", "type": "percent"}, {"key": "url", "type": "link"}],
        "rows": [{"who": "A", "amt": "1.000,50", "on": "07-11-2026", "pct": "10%", "url": "https://x/1"},
                 {"who": "B", "amt": 99.5, "on": "nope", "url": "javascript:alert(1)"},
                 {"who": "C", "amt": "free"}]})
    assert ev["type"] == "data" and ev["view"] == "table" and ev["as_of"]
    assert ev["rows"][0]["amt"] == 1000.5 and ev["rows"][0]["on"] == "2026-11-07"
    assert ev["rows"][1]["url"] is None and ev["rows"][2]["amt"] is None
    assert ev["totals"] == {"amt": 1100.0}             # computed, percent isn't summed
    assert ev["columns"][1]["currency"] == "EUR"
    assert len(notes) == 2 and any("free" in n for n in notes)


def test_a_sheet_guesses_columns_and_can_hide_totals():
    ev, _ = dv.build({"view": "table", "title": "T", "rows": [{"a": 1, "b": "x"}, {"a": 2, "c": 3}], "totals": False})
    assert [c["key"] for c in ev["columns"]] == ["a", "b", "c"] and ev["totals"] == {}


def test_charts():
    ev, _ = dv.build({"view": "chart", "title": "Burn", "kind": "line", "x": "m", "series": ["in", {"key": "out", "label": "Out"}],
                      "format": "money", "currency": "EUR", "rows": [{"m": "Jan", "in": "1.000,00", "out": 5}, {"m": "Feb", "in": 2, "out": None}]})
    assert ev["series"][1]["label"] == "Out" and ev["points"][0] == {"x": "Jan", "in": 1000.0, "out": 5.0}
    assert ev["points"][1]["out"] is None
    guessed, _ = dv.build({"view": "chart", "title": "T", "rows": [{"day": "a", "n": 1, "m": 2}]})
    assert guessed["kind"] == "bar" and [s["key"] for s in guessed["series"]] == ["n", "m"]


def test_a_burndowns_ideal_line_is_computed():
    ev, _ = dv.build({"view": "chart", "title": "Sprint", "kind": "burndown", "x": "d", "series": ["left"],
                      "rows": [{"d": i, "left": v} for i, v in enumerate((40, 35, 35, 20, 10))]})
    assert ev["ideal"] == [40.0, 30.0, 20.0, 10.0, 0.0]
    with pytest.raises(dv.Refused):
        dv.build({"view": "chart", "title": "S", "kind": "burndown", "x": "d", "series": ["left"], "rows": [{"d": 0, "left": None}]})


@pytest.mark.parametrize("spec,word", [
    ({"view": "pie", "title": "T"}, "view must"),
    ({"view": "table", "rows": [{"a": 1}]}, "title"),
    ({"view": "table", "title": "T", "rows": []}, "rows"),
    ({"view": "table", "title": "T", "rows": [{"a": 1}] * (dv.MAX_ROWS + 1)}, "Group or filter"),
    ({"view": "chart", "title": "T", "rows": [{"a": "x"}]}, "numeric series"),
    ({"view": "chart", "title": "T", "kind": "radar", "rows": [{"a": 1}]}, "kind"),
    ({"view": "chart", "title": "T", "rows": [{"x": 1}] * (dv.MAX_POINTS + 1), "series": ["x2"]}, "Bucket"),
    ({"view": "chart", "title": "T", "x": "a", "series": [f"s{i}" for i in range(9)], "rows": [{"a": 1}]}, "Other"),
    ({"view": "chart", "title": "T", "kind": "donut", "x": "a", "series": ["b", "c"], "rows": [{"a": 1, "b": 1, "c": 1}]}, "one series"),
    ({"view": "chart", "title": "T", "kind": "donut", "x": "a", "series": ["b"], "rows": [{"a": 1, "b": -1}]}, "negative"),
    ({"view": "kanban", "title": "T", "columns": []}, "columns"),
    ({"view": "kanban", "title": "T", "columns": [{"cards": []}]}, "name"),
    ({"view": "stats", "title": "T", "items": []}, "items"),
])
def test_refusals_say_what_to_change(spec, word):
    with pytest.raises(dv.Refused, match=word):
        dv.build(spec)


def test_too_big_says_to_aggregate():
    with pytest.raises(dv.Refused, match="Group or filter"):
        dv.build({"view": "table", "title": "T", "rows": [{"a": "x" * 1900, "b": "y" * 1900} for _ in range(300)]})


def test_a_board_keeps_empty_columns_and_counts():
    ev, notes = dv.build({"view": "kanban", "title": "Sprint", "columns": [
        {"name": "To do", "limit": 5, "cards": [{"title": "A", "key": "NRF-1", "assignee": "M", "due": "2026-11-20", "priority": "high",
                                                 "tags": ["x", 3], "url": "https://x/1"},
                                                {"title": "B", "url": "javascript:x", "due": "whenever"}, {"key": "no title"}, "Plain"]},
        {"name": "Done", "cards": []}]})
    cols = ev["columns"]
    assert ev["count"] == 3 and [c["name"] for c in cols] == ["To do", "Done"] and cols[1]["cards"] == []
    assert cols[0]["cards"][0]["tags"] == ["x", "3"] and cols[0]["cards"][1]["url"] is None and cols[0]["cards"][1]["due"] is None
    assert cols[0]["cards"][2]["title"] == "Plain" and cols[0]["limit"] == 5 and notes


def test_stats():
    ev, _ = dv.build({"view": "stats", "title": "Now", "currency": "EUR", "items": [
        {"label": "Revenue", "value": "12.500,00", "format": "money", "delta": "4%"}, {"label": "Status", "value": "OK", "format": "text"},
        {"label": "Odd", "value": "lots"}]})
    assert ev["items"][0]["value"] == 12500.0 and ev["items"][0]["delta"] == 4.0 and ev["items"][0]["currency"] == "EUR"
    assert ev["items"][2]["format"] == "text" and ev["items"][2]["value"] == "lots"


def test_no_markup_or_line_breaks_get_through_as_structure():
    ev, _ = dv.build({"view": "table", "title": "<b>T</b>\nx", "rows": [{"a": "<img src=x onerror=y>"}]})
    assert ev["title"] == "<b>T</b> x"      # plain text for a client that draws text
    json.dumps(ev)


# ---- through the gateway ------------------------------------------------------------

class Job:
    def __init__(self):
        self.id, self.events = f"j{time.time_ns()}", []

    def add(self, e):
        self.events.append(e)


@pytest.fixture
def session(monkeypatch, tmp_path):
    monkeypatch.setattr(experimental, "_path", lambda: str(tmp_path / "experimental.json"))
    monkeypatch.setattr(experimental, "_cache", None)
    experimental.set_enabled(True)
    store.init()
    return store.create_session(config.DASH_CHAT_ID, "/p", cwd=str(tmp_path))


def test_the_tool_puts_it_on_the_turn_and_tells_the_agent(session):
    job = Job()
    res = gt.call(session, job, "show_data", {"view": "table", "title": "Money", "columns": [{"key": "a", "type": "money"}],
                                              "rows": [{"a": 1}, {"a": "x"}]})
    assert job.events[0]["type"] == "data" and "It's in the chat" in res["content"][0]["text"]
    assert "a total 1.00" in res["content"][0]["text"] and "couldn't be read" in res["content"][0]["text"]
    bad = gt.call(session, job, "show_data", {"view": "nope", "title": "x"})
    assert bad["isError"] and len(job.events) == 1
    assert gt.call(session, None, "show_data", {"view": "stats", "title": "x", "items": [{"label": "a", "value": 1}]})["isError"]


def test_every_provider_has_it_listed(session):
    assert "show_data" in gateway.tool_names(session)
    assert "show_data" in {t["name"] for t in gateway.tools_for(session)}


def test_off_with_the_switch(session):
    tok = gateway.issue(session["id"])
    experimental.set_enabled(False)
    assert gateway.handle(tok, "tools/list", {})[1] == 401


def test_history_says_what_was_shown(session):
    from bridge import handoff
    tid = f"t{time.time_ns()}"
    store.start_turn(session["id"], tid, "tasks?", [])
    ev, _ = dv.build({"view": "kanban", "title": "Sprint 4", "columns": [{"name": "To do", "cards": ["A"]}]})
    store.append_event(session["id"], tid, ev)
    block = handoff._turn_block(session, store.turns_of(session["id"])[-1], tools=False)
    assert "a board, Sprint 4: 1 card in 1 columns" in block


def test_a_helpers_view_reaches_the_channel_as_its_title_only():
    from bridge import team
    assert team._FIELDS["data"] == ("view", "title", "caption", "source", "as_of")


def test_through_the_gateway_as_an_agent_calls_it(session, monkeypatch):
    from bridge import runner
    job = Job()
    monkeypatch.setattr(runner, "live_job", lambda sid: job)
    res, code = gateway.handle(gateway.issue(session["id"]), "tools/call", {"name": "show_data", "arguments": {
        "view": "kanban", "title": "Sprint", "columns": [{"name": "To do", "cards": [{"title": "A"}]}]}})
    assert code == 200 and not res.get("isError") and job.events[0]["count"] == 1


def test_a_progress_column_is_a_number_and_isnt_summed():
    ev, notes = dv.build({"view": "table", "title": "Coverage", "columns": [{"key": "dir"}, {"key": "cov", "type": "progress"}],
                          "rows": [{"dir": "src", "cov": "72%"}, {"dir": "lib", "cov": 91.5}]})
    assert ev["rows"][0]["cov"] == 72.0 and ev["rows"][1]["cov"] == 91.5 and ev["totals"] == {} and not notes


FLOW = {"view": "diagram", "kind": "flow", "title": "Retry", "direction": "down",
        "nodes": [{"id": "a", "label": "Webhook", "group": "In", "shape": "terminal"}, {"id": "b", "note": "seen before?", "shape": "decision", "group": "Core"},
                  {"id": "c", "shape": "cloud"}], "edges": [{"from": "a", "to": "b"}, {"from": "b", "to": "c", "label": "new"}, {"from": "c", "to": "a"}]}


def test_a_flow_keeps_its_steps_and_arrows():
    ev, _ = dv.build(FLOW)
    assert ev["kind"] == "flow" and [n["label"] for n in ev["nodes"]] == ["Webhook", "b", "c"]
    assert ev["nodes"][2]["shape"] == "process" and ev["groups"] == ["In", "Core"] and ev["edges"][1]["label"] == "new"
    assert dv.describe(ev) == "a flow diagram, Retry: 3 steps"


def test_a_timeline():
    ev, _ = dv.build({"view": "diagram", "kind": "timeline", "title": "Launch", "items": [
        {"date": "Mar", "label": "Beta", "state": "done"}, {"date": "Apr", "label": "GA", "state": "soon"}, "Later"]})
    assert ev["items"][0]["state"] == "done" and ev["items"][1]["state"] == "" and ev["items"][2]["label"] == "Later"
    assert dv.describe(ev) == "a timeline, Launch: 3 events"


@pytest.mark.parametrize("spec,word", [
    ({"view": "diagram", "title": "T", "kind": "mindmap"}, "kind"),
    ({"view": "diagram", "title": "T", "kind": "flow"}, "nodes"),
    ({"view": "diagram", "title": "T", "kind": "flow", "nodes": ["a", "a"]}, "own id"),
    ({"view": "diagram", "title": "T", "kind": "flow", "nodes": ["a"], "edges": [{"from": "a", "to": "z"}]}, "isn't in nodes"),
    ({"view": "diagram", "title": "T", "kind": "flow", "nodes": [str(i) for i in range(dv.MAX_NODES + 1)]}, "Split"),
    ({"view": "diagram", "title": "T", "kind": "timeline"}, "items"),
])
def test_diagrams_refuse_with_a_sentence(spec, word):
    with pytest.raises(dv.Refused, match=word):
        dv.build(spec)
