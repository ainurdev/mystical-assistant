"""Computer use in the bridge (bridge/computer.py): the per-chat switch, the
Allow card, the grant, the one desktop lock, the order line to Mystical.app and
Stop. Mystical.app is played by a thread on app_exchange: nothing here clicks,
types or looks at the real screen."""
import json
import threading
import time
import uuid

import pytest

from bridge import computer, config, gateway, runner, store

store.init()
CHAT = config.DASH_CHAT_ID


class FakeJob:
    def __init__(self, sid):
        self.id, self.store_session_id, self.chat_id = uuid.uuid4().hex, sid, CHAT
        self.events, self.pending = [], []
        self.status = "running"
        self.exited = threading.Event()
        self.interrupted = False

    def add(self, ev):
        self.events.append(ev)

    def add_pending(self, e):
        self.pending.append(e)

    def interrupt(self):
        self.interrupted = True
        return True


@pytest.fixture(autouse=True)
def isolated(monkeypatch):
    computer._reset_for_tests()
    monkeypatch.setattr(computer, "available", lambda: True)
    monkeypatch.setattr(computer, "ORDER_TIMEOUT", 3)
    monkeypatch.setattr(computer, "PULL_WAIT", 0.2)
    monkeypatch.setattr(runner, "notify_awaiting", lambda *a, **k: None)
    jobs = {}
    monkeypatch.setattr(runner, "live_job", lambda sid: jobs.get(sid) if jobs.get(sid) and
                        jobs[sid].status == "running" else None)
    yield jobs
    computer._reset_for_tests()


def _chat(jobs, on=True, title="q3 numbers"):
    sid = store.create_session(CHAT, "/proj", cwd="/tmp")["id"]
    cid = uuid.uuid4().hex
    store.set_claude_session_id(sid, cid)
    store.rename(sid, title)
    if on:
        computer.set_enabled(sid, True)
    jobs[sid] = FakeJob(sid)
    return sid, cid, jobs[sid]


def _in_thread(fn, *a):
    box = {}
    t = threading.Thread(target=lambda: box.update(out=fn(*a)), daemon=True)
    t.start()
    return t, box


def _card_of(job, before=0, timeout=3):
    end = time.time() + timeout
    while time.time() < end:
        if len(job.pending) > before:
            return job.pending[-1]
        time.sleep(0.01)
    raise AssertionError("no card")


def _grant(job, cid, apps=("Safari",), answers=None, **extra):
    before = len(job.pending)
    t, box = _in_thread(computer.call, cid, "request_access", {"apps": list(apps), "reason": "copy the table", **extra})
    card = _card_of(job, before)
    gateway.answer_card(job, card, answers or [{"header": "Computer", "labels": [computer.ALLOW]}])
    t.join(3)
    return card, box["out"]


def _text(out):
    return " ".join(c.get("text", "") for c in out["content"])


def _app_does(result_for, rounds=1):
    """Play Mystical.app: pull orders, answer each with result_for(order)."""
    seen = []

    def run():
        results = []
        for _ in range(rounds * 20):
            got = computer.app_exchange({"results": results, "perms": {"screen": True, "accessibility": True}})
            results = []
            for o in got["orders"]:
                seen.append(o)
                if o["action"] != "end":
                    results.append({"id": o["id"], **result_for(o)})
            if len([o for o in seen if o["action"] != "end"]) >= rounds and not results:
                return
    t = threading.Thread(target=run, daemon=True)
    t.start()
    return t, seen


# ------- the switch ------------------------------------------------------------------

def test_off_by_default_and_refused_while_off(isolated):
    sid, cid, _job = _chat(isolated, on=False)
    assert computer.enabled(sid) is False
    out = computer.call(cid, "screenshot", {})
    assert out.get("isError") and "switched off" in _text(out)


def test_the_mcp_server_is_declared_only_for_a_chat_that_switched_it_on(isolated):
    sid, cid, _job = _chat(isolated, on=False)
    with open(runner._mcp_config(cid), encoding="utf-8") as f:   # noqa: SLF001
        assert "computer" not in json.load(f)["mcpServers"]
    computer.set_enabled(sid, True)
    with open(runner._mcp_config(cid), encoding="utf-8") as f:   # noqa: SLF001
        srv = json.load(f)["mcpServers"]["computer"]
    assert srv["args"] == ["-m", "bridge.computer_mcp"]
    assert srv["env"]["MYSTICAL_CLAUDE_SESSION_ID"] == cid


def test_not_on_a_machine_that_isnt_a_mac(isolated, monkeypatch):
    sid, cid, _job = _chat(isolated)
    monkeypatch.setattr(computer, "available", lambda: False)
    assert computer.enabled(sid) is False
    with open(runner._mcp_config(cid), encoding="utf-8") as f:   # noqa: SLF001
        assert "computer" not in json.load(f)["mcpServers"]


# ------- the card and the grant ---------------------------------------------------------

def test_nothing_happens_before_access_is_granted(isolated):
    _sid, cid, _job = _chat(isolated)
    out = computer.call(cid, "left_click", {"coordinate": [1, 2]})
    assert out.get("isError") and "request_access" in _text(out)


def test_allow_grants_the_apps_with_terminals_see_only(isolated):
    sid, cid, job = _chat(isolated)
    card, out = _grant(job, cid, apps=("Safari", "Terminal"))
    assert card["gateway"] and card["kind"] == "question"
    q = card["questions"][0]
    assert q["computer"]["apps"] == [{"name": "Safari", "tier": "full"}, {"name": "Terminal", "tier": "look"}]
    assert "copy the table" in q["question"]
    assert "Granted: Safari, Terminal" in _text(out) and "See only" in _text(out)
    assert computer.status(sid)["apps"] == ["Safari", "Terminal"]


def test_deny_grants_nothing(isolated):
    sid, cid, job = _chat(isolated)
    _card, out = _grant(job, cid, answers=[{"header": "Computer", "labels": [computer.DENY]}])
    assert "denied" in _text(out)
    assert computer.status(sid)["apps"] == []


def test_asking_again_only_asks_for_what_is_new(isolated):
    _sid, cid, job = _chat(isolated)
    _grant(job, cid, apps=("Safari",))
    assert _text(computer.call(cid, "request_access", {"apps": ["safari"], "reason": "x"})) == "Those are already granted."
    card, _out = _grant(job, cid, apps=("Safari", "Numbers"))
    assert [a["name"] for a in card["questions"][0]["computer"]["apps"]] == ["Safari", "Numbers"]


def test_clipboard_and_system_keys_need_their_own_ticks(isolated):
    _sid, cid, job = _chat(isolated)
    card, _ = _grant(job, cid, clipboardRead=True, systemKeyCombos=True,
                     answers=[{"header": "Computer", "labels": [computer.ALLOW]},
                              {"header": "Also", "labels": ["Read clipboard"]}])
    assert [o["label"] for o in card["questions"][1]["options"]] == ["Read clipboard", "System keys"]
    assert "wasn't granted" in _text(computer.call(cid, "write_clipboard", {"text": "x"}))
    assert "system key" in _text(computer.call(cid, "key", {"text": "cmd+q"}))
    assert "system key" in _text(computer.call(cid, "computer_batch", {"actions": [{"action": "key", "text": "Q+CMD"}]}))


def test_open_application_only_for_a_granted_app(isolated):
    _sid, cid, job = _chat(isolated)
    _grant(job, cid)
    assert "isn't one of this chat's apps" in _text(computer.call(cid, "open_application", {"app": "Mail"}))


def test_grant_from_reads_answers_and_card_questions_shape():
    apps = [{"name": "Safari", "tier": "full"}]
    assert computer.grant_from(apps, [], []) is None
    g = computer.grant_from(apps, ["Write clipboard"], [{"header": "Computer", "labels": ["Allow apps"]},
                                                         {"header": "Also", "labels": ["Write clipboard", "System keys"]}])
    assert g == {"apps": apps, "clipboard_read": False, "clipboard_write": True, "system_keys": False}
    assert len(computer.card_questions(apps, "", [])) == 1
    assert computer.tier("com.apple.Terminal") == "look" and computer.tier("Mystical") == "look"


# ------- orders to the app ----------------------------------------------------------------

def test_an_action_goes_to_the_app_and_its_picture_comes_back(isolated):
    sid, cid, job = _chat(isolated)
    _grant(job, cid, apps=("Safari", "Terminal"))
    computer.app_exchange({"results": [{"id": "stale"}]})        # the app is online
    t, seen = _app_does(lambda o: {"ok": True, "text": "1456x816", "images": ["AAAA"]})
    out = computer.call(cid, "screenshot", {})
    t.join(3)
    order = seen[0]
    assert order["action"] == "screenshot" and order["full"] == ["Safari"] and order["see"] == ["Safari", "Terminal"]
    assert order["title"] == "q3 numbers"
    assert out["content"] == [{"type": "text", "text": "1456x816"},
                              {"type": "image", "data": "AAAA", "mimeType": "image/jpeg"}]
    st = computer.status(sid)
    assert st["driving"] and st["actions"] == 1 and st["app"]["accessibility"] is True
    assert job.events[-1] == {"type": "computer_state", "state": "driving", "apps": ["Safari", "Terminal"]}


def test_the_apps_refusal_reaches_claude_as_an_error(isolated):
    _sid, cid, job = _chat(isolated)
    _grant(job, cid)
    computer.app_exchange({})
    t, _seen = _app_does(lambda o: {"ok": False, "text": "Mail is in front, and it isn't one of this chat's apps."})
    out = computer.call(cid, "left_click", {"coordinate": [3, 4]})
    t.join(3)
    assert out["isError"] and "Mail is in front" in _text(out)


def test_no_app_no_action(isolated):
    _sid, cid, job = _chat(isolated)
    _grant(job, cid)
    out = computer.call(cid, "screenshot", {})
    assert out["isError"] and "isn't running" in _text(out)


def test_an_app_that_never_answers_times_out_and_the_late_order_is_dropped(isolated, monkeypatch):
    monkeypatch.setattr(computer, "ORDER_TIMEOUT", 0.2)
    _sid, cid, job = _chat(isolated)
    _grant(job, cid)
    computer.app_exchange({})
    out = computer.call(cid, "screenshot", {})
    assert out["isError"] and "didn't answer" in _text(out)
    assert [o for o in computer.app_exchange({})["orders"] if o["action"] != "end"] == []


# ------- one driver at a time, and stopping -------------------------------------------------

def test_one_chat_drives_at_a_time_until_its_turn_ends(isolated):
    _a, cid_a, job_a = _chat(isolated, title="fix login")
    _b, cid_b, job_b = _chat(isolated)
    _grant(job_a, cid_a)
    _grant(job_b, cid_b)
    computer.app_exchange({})
    t, _ = _app_does(lambda o: {"ok": True}, rounds=2)
    assert not computer.call(cid_a, "mouse_move", {"coordinate": [1, 1]}).get("isError")
    busy = computer.call(cid_b, "mouse_move", {"coordinate": [1, 1]})
    assert busy["isError"] and '"fix login" is driving' in _text(busy)
    assert computer.status(_b)["busy_with"] == "fix login"
    job_a.status = "done"
    job_a.exited.set()
    time.sleep(0.1)
    assert not computer.call(cid_b, "mouse_move", {"coordinate": [1, 1]}).get("isError")
    t.join(3)


def test_stop_drops_the_grant_frees_the_desktop_and_interrupts(isolated):
    sid, cid, job = _chat(isolated)
    _grant(job, cid)
    computer.app_exchange({})
    t, _ = _app_does(lambda o: {"ok": True})
    computer.call(cid, "mouse_move", {"coordinate": [1, 1]})
    t.join(3)
    assert computer.stop(sid, "esc")
    assert job.interrupted and computer.status(sid) == {**computer.status(sid), "driving": False, "apps": []}
    assert job.events[-1] == {"type": "computer_state", "state": "stopped", "by": "esc", "actions": 1}
    assert [o["action"] for o in computer.app_exchange({})["orders"]] == ["end"]


def test_esc_on_the_mac_stops_whoever_drives(isolated):
    sid, cid, job = _chat(isolated)
    _grant(job, cid)
    computer.app_exchange({})
    t, _ = _app_does(lambda o: {"ok": True})
    computer.call(cid, "mouse_move", {"coordinate": [1, 1]})
    t.join(3)
    computer.app_exchange({"stop": "esc"})
    assert job.interrupted and not computer.status(sid)["driving"]


def test_switching_it_off_stops_it(isolated):
    sid, cid, job = _chat(isolated)
    _grant(job, cid)
    computer.set_enabled(sid, False)
    assert computer.status(sid)["apps"] == [] and not computer.enabled(sid)


def test_stop_fails_an_order_still_in_flight_and_the_app_never_gets_it_late(isolated):
    sid, cid, job = _chat(isolated)
    _grant(job, cid)
    computer.app_exchange({})
    t, box = _in_thread(computer.call, cid, "type", {"text": "a long text"})
    time.sleep(0.2)                       # queued, the app hasn't pulled it
    computer.stop(sid, "esc")
    t.join(3)
    assert box["out"]["isError"] and "stopped" in _text(box["out"])
    assert [o["action"] for o in computer.app_exchange({})["orders"]] == ["end"]


def test_system_keys_are_caught_in_any_spelling(isolated):
    _sid, cid, job = _chat(isolated)
    _grant(job, cid)
    for k in ("command+q", "Q+CMD", "cmd+option+escape", "meta+tab", "control+command+q"):
        assert "system key" in _text(computer.call(cid, "key", {"text": k})), k
    assert "system key" not in _text(computer.call(cid, "key", {"text": "cmd+c"}))


def test_a_junk_duration_is_an_answer_not_a_crash(isolated):
    _sid, cid, job = _chat(isolated)
    _grant(job, cid)
    assert _text(computer.call(cid, "wait", {"duration": "soon"})) == "Waited."


def test_two_cards_answered_in_turn_keep_both_grants(isolated):
    sid, cid, job = _chat(isolated)
    n = len(job.pending)
    t1, b1 = _in_thread(computer.call, cid, "request_access", {"apps": ["Safari"], "reason": "x"})
    c1 = _card_of(job, n)
    t2, b2 = _in_thread(computer.call, cid, "request_access", {"apps": ["Numbers"], "reason": "y", "clipboardRead": True})
    c2 = _card_of(job, n + 1)
    gateway.answer_card(job, c2, [{"header": "Computer", "labels": [computer.ALLOW]}, {"header": "Also", "labels": ["Read clipboard"]}])
    gateway.answer_card(job, c1, [{"header": "Computer", "labels": [computer.ALLOW]}])
    t1.join(3), t2.join(3)
    assert sorted(computer.status(sid)["apps"]) == ["Numbers", "Safari"]
    assert "Flags: clipboard_read" in _text(computer.call(cid, "list_granted_applications", {}))
