"""A work run on the Live board (bridge/tgboard.py, ticket telegram-widgets 09): the
manager's row shows the run's counts and an item in progress while the run is running,
and Stop on it does what `/work stop` does, under the same trust checks as a turn's Stop."""

import json
import uuid

import pytest

from bridge import config, experimental, machine, runner, state, store, telegram, tgboard, worklist

store.init()
CHAT = config.DASH_CHAT_ID
NOW = 1794300000.0
RUN_START = NOW - 600


class Calls(list):
    stopped: list


@pytest.fixture
def tg(monkeypatch):
    calls, stopped = Calls(), []
    mids = iter(range(900, 10_000))

    def fake(method, **params):
        calls.append((method, params))
        return {"message_id": next(mids)} if method == "sendWidget" else True
    monkeypatch.setattr(telegram, "tg", fake)
    monkeypatch.setattr(experimental, "enabled", lambda: True)
    monkeypatch.setattr(machine, "live_session_ids", lambda: set())
    monkeypatch.setattr(state, "miniapp_url", "https://mini.example")
    monkeypatch.setattr(runner.Job, "interrupt", lambda job: stopped.append(job.store_session_id) or job.status == "running")
    store.set_setting(tgboard.KEY, None)
    tgboard._seen.clear()
    tgboard._sent.clear()
    runner._jobs.clear()
    calls.stopped = stopped
    yield calls
    runner._jobs.clear()


def session(title, parent=None):
    sess = store.create_session(CHAT, "proj")
    with store.closing(store._connect()) as c:
        c.execute("UPDATE sessions SET title=?, parent_session=? WHERE id=?", (title, parent, sess["id"]))
    return sess["id"]


def run_turn(sid):
    job = runner.Job(uuid.uuid4().hex, CHAT, sid)
    job.started = NOW - 30
    runner._jobs[job.id] = job
    return job


def work_run(tmp_path, manager, states, titles=None, run_state="running"):
    """A run on a fresh work list, managed by `manager`: one item per state."""
    root = str(tmp_path)
    titles = titles or [f"item {n}" for n in range(len(states))]
    items = [{"id": f"w{n + 1}", "title": t, "state": s} for n, (t, s) in enumerate(zip(titles, states))]
    rid = uuid.uuid4().hex[:8]
    run = {"id": rid, "chat": manager, "state": run_state, "started": RUN_START, "items": [i["id"] for i in items]}
    worklist.save(root, {"next": len(items) + 1, "items": items, "runs": [run]})
    store.set_session_field(manager, "chat_config", json.dumps({"_work": {"root": root, "run": rid}}))
    return root, rid


def shown(tg):
    d = [json.loads(p["chat_data"]) for m, p in tg if m in ("sendWidget", "editMessageWidgetData")]
    return d[-1]["rows"] if d else None


def board_with_run(tg, tmp_path, *, manager_runs=True):
    mgr = session("ship widgets")
    helper = session("w2", parent=mgr)
    if manager_runs:
        run_turn(mgr)
    run_turn(helper)
    root, rid = work_run(tmp_path, mgr, ["done", "done", "doing", "doing", "doing", "todo", "review"],
                         ["a", "b", "Board stop row", "usage bars", "limit card", "f", "g"])
    tgboard.look(NOW)
    return mgr, helper, root, rid


def ask(data, *, msg=None, sender=CHAT, chat=CHAT):
    msg = msg or tgboard.record()["board"]["msg"]
    tgboard.query({"id": "q1", "from": {"id": sender}, "chat": {"id": chat, "type": "private"},
                   "message_id": msg, "chat_instance": "x", "type": "data", "data": data})


def answers(calls):
    return [p["data"] for m, p in calls if m == "answerWidgetQuery"]


def test_the_managers_row_shows_the_runs_counts_an_item_in_progress_and_its_start(tg, tmp_path):
    mgr, *_ = board_with_run(tg, tmp_path)
    assert shown(tg) == [{"k": mgr[:8], "c": "w", "t": "ship widgets", "s": "Board stop row", "a": int(RUN_START), "p": [2, 7, 2]}]


def test_the_row_shows_while_only_helpers_are_in_flight(tg, tmp_path):
    mgr, *_ = board_with_run(tg, tmp_path, manager_runs=False)
    rows = shown(tg)
    assert [(r["k"], r["c"], r["p"]) for r in rows] == [(mgr[:8], "w", [2, 7, 2])]
    assert tgboard._sent["keys"] == {f"w:{mgr[:8]}": mgr}       # its ■ is live too


def test_stop_on_the_row_does_what_work_stop_does(tg, tmp_path):
    mgr, helper, root, rid = board_with_run(tg, tmp_path)
    tg.clear()
    ask(f"w:{mgr[:8]}")
    assert answers(tg) == ["ok"]
    assert worklist.load(root)["runs"][0]["state"] == "paused"
    assert sorted(tg.stopped) == sorted([mgr, helper])


@pytest.mark.parametrize("case", ["stranger", "other chat", "old board", "unknown key", "a turn's stop", "run already paused"])
def test_the_trust_checks_of_a_turns_stop_apply(tg, tmp_path, case):
    mgr, helper, root, rid = board_with_run(tg, tmp_path)
    tg.clear()
    key = f"w:{mgr[:8]}"
    if case == "stranger":
        ask(key, sender=777)
    elif case == "other chat":
        ask(key, sender=777, chat=777)
    elif case == "old board":
        ask(key, msg=tgboard.record()["board"]["msg"] - 1)
    elif case == "unknown key":
        ask("w:deadbeef")
    elif case == "a turn's stop":
        ask(f"s:{mgr[:8]}")                      # a work-run row only stops as a run
    else:
        worklist.mutate(root, lambda d: d["runs"][0].update(state="paused"))
        ask(key)
    assert tg.stopped == []
    assert answers(tg) == (["gone"] if case == "run already paused" else ["no"])
    if case != "run already paused":
        assert worklist.load(root)["runs"][0]["state"] == "running"


def test_a_paused_run_has_no_work_run_row_and_a_run_sends_no_message(tg, tmp_path):
    mgr = session("ship widgets")
    run_turn(mgr)
    work_run(tmp_path, mgr, ["doing"], run_state="paused")
    tgboard.look(NOW)
    assert [r["c"] for r in shown(tg)] == ["r"]
    root, _ = work_run(tmp_path, mgr, ["doing"])
    tgboard.look(NOW + 1)
    assert [r["c"] for r in shown(tg)] == ["w"]
    assert not [m for m, _ in tg if m in ("sendMessage", "sendPhoto", "sendDocument")]


def test_long_multibyte_titles_keep_the_data_inside_its_budget(tg, tmp_path):
    long = "پنجره‌ی زنده‌ی تلگرام با نوار مصرف و کارت محدودیت 🚀" * 3
    for n in range(12):
        mgr = session(f"{long} {n}")
        run_turn(mgr)
        work_run(tmp_path / str(n), mgr, ["done"] * 99 + ["doing"] * 3, [long] * 102)
    tgboard.look(NOW)
    sent = [p["chat_data"] for m, p in tg if m == "sendWidget"][0]
    assert len(sent.encode()) <= tgboard.DATA_MAX
    rows = json.loads(sent)["rows"]
    assert len(rows) == tgboard.MAX_ROWS and all(r["c"] == "w" and r["p"] == [99, 102, 2] for r in rows)
    assert all(len(r["s"].encode()) <= tgboard.STEP_B for r in rows)
