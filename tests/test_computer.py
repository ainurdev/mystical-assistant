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
    store.rename(sid, title)
    if on:
        computer.set_enabled(sid, True)
    jobs[sid] = FakeJob(sid)
    return sid, jobs[sid]


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


def _grant(job, sid, apps=("Safari",), answers=None, **extra):
    before = len(job.pending)
    t, box = _in_thread(computer.call, sid, "request_access", {"apps": list(apps), "reason": "copy the table", **extra})
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
    sid, _job = _chat(isolated, on=False)
    assert computer.enabled(sid) is False
    out = computer.call(sid, "screenshot", {})
    assert out.get("isError") and "switched off" in _text(out)


def _servers(job, claude_id="claude-id"):
    """The MCP servers a turn of `job` would be started with."""
    cmd = runner._base_cmd("p", CHAT, stream=True, interactive=True, claude_session_id=claude_id,   # noqa: SLF001
                           computer=runner._computer_session(job))                                  # noqa: SLF001
    with open(cmd[cmd.index("--mcp-config") + 1], encoding="utf-8") as f:
        return json.load(f)["mcpServers"]


def test_the_mcp_server_is_declared_only_for_a_chat_that_switched_it_on(isolated):
    sid, job = _chat(isolated, on=False)
    assert "computer" not in _servers(job)
    computer.set_enabled(sid, True)
    srv = _servers(job)["computer"]
    assert srv["args"] == ["-m", "bridge.computer_mcp"]
    assert srv["env"]["MYSTICAL_COMPUTER_SESSION"] == sid


def test_not_on_a_machine_that_isnt_a_mac(isolated, monkeypatch):
    sid, job = _chat(isolated)
    monkeypatch.setattr(computer, "available", lambda: False)
    assert computer.enabled(sid) is False
    assert "computer" not in _servers(job)


def test_a_duplicated_chats_first_turn_acts_as_itself_not_as_its_source(isolated):
    """That turn still runs under the source's claude id (fork_from). The session its
    computer server acts for is the store's own, and the copy never switched it on."""
    src, _job = _chat(isolated)
    store.set_claude_session_id(src, "claude-src")
    copy = store.duplicate(src)["id"]
    assert runner._claim_session_id(copy, None)[0] == "claude-src"   # noqa: SLF001 - the premise
    job = FakeJob(copy)
    assert "computer" not in _servers(job, "claude-src")
    computer.set_enabled(copy, True)
    assert _servers(job, "claude-src")["computer"]["env"]["MYSTICAL_COMPUTER_SESSION"] == copy


# ------- the card and the grant ---------------------------------------------------------

def test_nothing_happens_before_access_is_granted(isolated):
    sid, _job = _chat(isolated)
    out = computer.call(sid, "left_click", {"coordinate": [1, 2]})
    assert out.get("isError") and "request_access" in _text(out)


def test_allow_grants_the_apps_with_terminals_see_only(isolated):
    sid, job = _chat(isolated)
    card, out = _grant(job, sid, apps=("Safari", "Terminal"))
    assert card["gateway"] and card["kind"] == "question"
    q = card["questions"][0]
    assert q["computer"]["apps"] == [{"name": "Safari", "tier": "full"}, {"name": "Terminal", "tier": "look"}]
    # A surface that shows only the question (Telegram) still says which apps, and how far.
    assert q["question"].splitlines() == ["Let this chat control these apps on your Mac?",
                                          "See, click and type: Safari.", "See only: Terminal.",
                                          "Why: copy the table"]
    assert "Granted: Safari, Terminal" in _text(out) and "See only" in _text(out)
    assert computer.status(sid)["apps"] == ["Safari", "Terminal"]


def test_deny_grants_nothing(isolated):
    sid, job = _chat(isolated)
    _card, out = _grant(job, sid, answers=[{"header": "Computer", "labels": [computer.DENY]}])
    assert "denied" in _text(out)
    assert computer.status(sid)["apps"] == []


def test_asking_again_only_asks_for_what_is_new(isolated):
    sid, job = _chat(isolated)
    _grant(job, sid, apps=("Safari",))
    assert _text(computer.call(sid, "request_access", {"apps": ["safari"], "reason": "x"})) == "Those are already granted."
    card, _out = _grant(job, sid, apps=("Safari", "Numbers"))
    assert [a["name"] for a in card["questions"][0]["computer"]["apps"]] == ["Safari", "Numbers"]


def test_clipboard_and_system_keys_need_their_own_ticks(isolated):
    sid, job = _chat(isolated)
    card, _ = _grant(job, sid, clipboardRead=True, systemKeyCombos=True,
                     answers=[{"header": "Computer", "labels": [computer.ALLOW]},
                              {"header": "Also", "labels": ["Read clipboard"]}])
    assert [o["label"] for o in card["questions"][1]["options"]] == ["Read clipboard", "System keys"]
    assert "wasn't granted" in _text(computer.call(sid, "write_clipboard", {"text": "x"}))
    assert "system key" in _text(computer.call(sid, "key", {"text": "cmd+q"}))
    assert "system key" in _text(computer.call(sid, "computer_batch", {"actions": [{"action": "key", "text": "Q+CMD"}]}))


def test_open_application_only_for_a_granted_app(isolated):
    sid, job = _chat(isolated)
    _grant(job, sid)
    assert "isn't one of this chat's apps" in _text(computer.call(sid, "open_application", {"app": "Mail"}))


def test_grant_from_reads_answers_and_card_questions_shape():
    apps = [{"name": "Safari", "tier": "full"}]
    assert computer.grant_from(apps, [], []) is None
    g = computer.grant_from(apps, ["Write clipboard"], [{"header": "Computer", "labels": ["Allow apps"]},
                                                         {"header": "Also", "labels": ["Write clipboard", "System keys"]}])
    assert g == {"apps": apps, "clipboard_read": False, "clipboard_write": True, "system_keys": False}
    assert len(computer.card_questions(apps, "", [])) == 1
    assert computer.tier(" terminal ") == "look" and computer.tier("Mystical") == "look"
    # Where this chat's own cards are answered is never clicked or typed into.
    assert computer.tier("Telegram") == "look" and computer.tier("Safari") == "full"


def test_an_app_is_asked_for_by_name_never_by_bundle_id_or_path(isolated):
    """LOOK_ONLY knows names: "com.microsoft.VSCode" would come out FULL. And a name
    is later opened as /Applications/<name>.app, so it can't carry a path."""
    sid, job = _chat(isolated)
    for bad in ("com.microsoft.VSCode", "com.apple.systempreferences", "../../Users/me/evil", "x" * 61, "Safari\nMail"):
        out = computer.call(sid, "request_access", {"apps": ["Safari", bad], "reason": "x"})
        assert out.get("isError") and "isn't an app's name" in _text(out), bad
    assert job.pending == []
    card, _out = _grant(job, sid, apps=("draw.io", "Brave Browser"))
    assert [a["name"] for a in card["questions"][0]["computer"]["apps"]] == ["draw.io", "Brave Browser"]


# ------- orders to the app ----------------------------------------------------------------

def test_an_action_goes_to_the_app_and_its_picture_comes_back(isolated):
    sid, job = _chat(isolated)
    _grant(job, sid, apps=("Safari", "Terminal"))
    computer.app_exchange({"results": [{"id": "stale"}]})        # the app is online
    t, seen = _app_does(lambda o: {"ok": True, "text": "1456x816", "images": ["AAAA"]})
    out = computer.call(sid, "screenshot", {})
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
    sid, job = _chat(isolated)
    _grant(job, sid)
    computer.app_exchange({})
    t, _seen = _app_does(lambda o: {"ok": False, "text": "Mail is in front, and it isn't one of this chat's apps."})
    out = computer.call(sid, "left_click", {"coordinate": [3, 4]})
    t.join(3)
    assert out["isError"] and "Mail is in front" in _text(out)


def test_no_app_no_action_and_the_desktop_is_not_taken(isolated):
    sid, job = _chat(isolated)
    _grant(job, sid)
    out = computer.call(sid, "screenshot", {})
    assert out["isError"] and "isn't running" in _text(out)
    assert not computer.status(sid)["driving"]
    assert not [e for e in job.events if e["type"] == "computer_state"]


def test_the_app_gets_one_order_at_a_time(isolated):
    """Never one pulled and waiting its turn in the app, where a Stop couldn't reach it."""
    sid, job = _chat(isolated)
    _grant(job, sid)
    computer.app_exchange({})
    calls = [_in_thread(computer.call, sid, "mouse_move", {"coordinate": [i, i]}) for i in (1, 2)]
    time.sleep(0.2)
    first = computer.app_exchange({})["orders"]
    assert len(first) == 1
    second = computer.app_exchange({"results": [{"id": first[0]["id"], "ok": True}]})["orders"]
    assert len(second) == 1 and second[0]["id"] != first[0]["id"]
    computer.app_exchange({"results": [{"id": second[0]["id"], "ok": True}]})
    for t, box in calls:
        t.join(3)
        assert not box["out"].get("isError")


def test_a_batch_is_bounded(isolated):
    sid, job = _chat(isolated)
    _grant(job, sid)
    many = computer.call(sid, "computer_batch", {"actions": [{"action": "wait", "duration": 0}] * 51})
    assert many["isError"] and "at most 50" in _text(many)
    slow = computer.call(sid, "computer_batch", {"actions": [{"action": "wait", "duration": 100}] * 2})
    assert slow["isError"] and "at most 120 seconds" in _text(slow)


def test_an_app_that_never_answers_times_out_and_the_late_order_is_dropped(isolated, monkeypatch):
    monkeypatch.setattr(computer, "ORDER_TIMEOUT", 0.2)
    sid, job = _chat(isolated)
    _grant(job, sid)
    computer.app_exchange({})
    out = computer.call(sid, "screenshot", {})
    assert out["isError"] and "didn't answer" in _text(out)
    assert [o for o in computer.app_exchange({})["orders"] if o["action"] != "end"] == []


# ------- one driver at a time, and stopping -------------------------------------------------

def test_one_chat_drives_at_a_time_until_its_turn_ends(isolated):
    _a, job_a = _chat(isolated, title="fix login")
    _b, job_b = _chat(isolated)
    _grant(job_a, _a)
    _grant(job_b, _b)
    computer.app_exchange({})
    t, _ = _app_does(lambda o: {"ok": True}, rounds=2)
    assert not computer.call(_a, "mouse_move", {"coordinate": [1, 1]}).get("isError")
    busy = computer.call(_b, "mouse_move", {"coordinate": [1, 1]})
    assert busy["isError"] and '"fix login" is driving' in _text(busy)
    assert computer.status(_b)["busy_with"] == "fix login"
    job_a.status = "done"
    job_a.exited.set()
    time.sleep(0.1)
    assert not computer.call(_b, "mouse_move", {"coordinate": [1, 1]}).get("isError")
    t.join(3)


def test_stop_drops_the_grant_frees_the_desktop_and_interrupts(isolated):
    sid, job = _chat(isolated)
    _grant(job, sid)
    computer.app_exchange({})
    t, _ = _app_does(lambda o: {"ok": True})
    computer.call(sid, "mouse_move", {"coordinate": [1, 1]})
    t.join(3)
    assert computer.stop(sid, "esc")
    assert job.interrupted and computer.status(sid) == {**computer.status(sid), "driving": False, "apps": []}
    assert job.events[-1] == {"type": "computer_state", "state": "stopped", "by": "esc", "actions": 1}
    assert [o["action"] for o in computer.app_exchange({})["orders"]] == ["end"]


def test_esc_on_the_mac_stops_whoever_drives(isolated):
    sid, job = _chat(isolated)
    _grant(job, sid)
    computer.app_exchange({})
    t, _ = _app_does(lambda o: {"ok": True})
    computer.call(sid, "mouse_move", {"coordinate": [1, 1]})
    t.join(3)
    computer.app_exchange({"stop": "esc"})
    assert job.interrupted and not computer.status(sid)["driving"]


def test_switching_it_off_stops_it(isolated):
    sid, job = _chat(isolated)
    _grant(job, sid)
    computer.set_enabled(sid, False)
    assert computer.status(sid)["apps"] == [] and not computer.enabled(sid)


def test_stop_fails_an_order_still_in_flight_and_the_app_never_gets_it_late(isolated):
    sid, job = _chat(isolated)
    _grant(job, sid)
    computer.app_exchange({})
    t, box = _in_thread(computer.call, sid, "type", {"text": "a long text"})
    time.sleep(0.2)                       # queued, the app hasn't pulled it
    computer.stop(sid, "esc")
    t.join(3)
    assert box["out"]["isError"] and "stopped" in _text(box["out"])
    assert [o["action"] for o in computer.app_exchange({})["orders"]] == ["end"]


def test_system_keys_are_caught_in_any_spelling(isolated):
    sid, job = _chat(isolated)
    _grant(job, sid)
    for k in ("command+q", "Q+CMD", "cmd+option+escape", "meta+tab", "control+command+q",
              "cmd+cmd+q", "fn+cmd+q", "cmd+cmd+shift+alt+q", "command+meta+q"):
        assert "system key" in _text(computer.call(sid, "key", {"text": k})), k
    assert "system key" not in _text(computer.call(sid, "key", {"text": "cmd+c"}))


def test_a_junk_duration_is_an_answer_not_a_crash(isolated):
    sid, job = _chat(isolated)
    _grant(job, sid)
    assert _text(computer.call(sid, "wait", {"duration": "soon"})) == "Waited."
    assert computer.call(sid, "key", ["not", "a", "dict"])["isError"]      # refused, not raised


def test_two_cards_answered_in_turn_keep_both_grants(isolated):
    sid, job = _chat(isolated)
    n = len(job.pending)
    t1, b1 = _in_thread(computer.call, sid, "request_access", {"apps": ["Safari"], "reason": "x"})
    c1 = _card_of(job, n)
    t2, b2 = _in_thread(computer.call, sid, "request_access", {"apps": ["Numbers"], "reason": "y", "clipboardRead": True})
    c2 = _card_of(job, n + 1)
    gateway.answer_card(job, c2, [{"header": "Computer", "labels": [computer.ALLOW]}, {"header": "Also", "labels": ["Read clipboard"]}])
    gateway.answer_card(job, c1, [{"header": "Computer", "labels": [computer.ALLOW]}])
    t1.join(3), t2.join(3)
    assert sorted(computer.status(sid)["apps"]) == ["Numbers", "Safari"]
    assert "Flags: clipboard_read" in _text(computer.call(sid, "list_granted_applications", {}))


# ------- Stop reaches an order the app is already doing ---------------------------------------

def _app_takes_an_order(sid, name="computer_batch", args=None):
    """A call in flight whose order the app has pulled and not answered: (call thread, its box, order id)."""
    args = args or {"actions": [{"action": "left_click", "coordinate": [1, 1]}, {"action": "wait", "duration": 1}]}
    computer.app_exchange({})
    t, box = _in_thread(computer.call, sid, name, args)
    order = next(o for _ in range(20) for o in computer.app_exchange({})["orders"] if o["action"] != "end")
    return t, box, order["id"]


def test_the_chats_stop_cuts_short_an_order_the_app_is_doing(isolated, monkeypatch):
    sid, job = _chat(isolated)
    _grant(job, sid)
    t, box, oid = _app_takes_an_order(sid)
    monkeypatch.setattr(computer, "PULL_WAIT", 5)       # the watch would hold on this long
    w, heard = _in_thread(computer.app_exchange, {"watch": oid})
    time.sleep(0.1)
    assert w.is_alive()                          # still wanted: the watch holds on
    began = time.time()
    computer.stop(sid, "you")
    w.join(3), t.join(3)
    assert heard["out"] == {"wanted": False} and time.time() - began < 1
    assert "stopped" in _text(box["out"]) and job.interrupted
    # A result the app sends for it afterwards changes nothing.
    assert computer.app_exchange({"results": [{"id": oid, "ok": True}]})["driving"] is False


def test_the_turn_ending_cuts_it_short_too_even_while_its_child_lives_on(isolated, monkeypatch):
    """The turn's own Stop button, or its result: `exited` comes later, after any
    background command the child is waiting on (bg_waiting)."""
    sid, job = _chat(isolated)
    _grant(job, sid)
    t, box, oid = _app_takes_an_order(sid)
    monkeypatch.setattr(computer, "PULL_WAIT", 5)
    w, heard = _in_thread(computer.app_exchange, {"watch": oid})
    job.status = "done"                          # and job.exited stays unset
    w.join(3), t.join(3)
    assert heard["out"] == {"wanted": False} and box["out"]["isError"]
    assert not computer.status(sid)["driving"]
    assert computer.status(sid)["apps"] == ["Safari"]      # the grant is the chat's, not the turn's


def test_an_order_whose_caller_gave_up_is_no_longer_wanted(isolated, monkeypatch):
    monkeypatch.setattr(computer, "ORDER_TIMEOUT", 0.5)
    sid, job = _chat(isolated)
    _grant(job, sid)
    t, box, oid = _app_takes_an_order(sid, "screenshot", {})
    monkeypatch.setattr(computer, "PULL_WAIT", 5)
    began = time.time()
    assert computer.app_exchange({"watch": oid}) == {"wanted": False} and time.time() - began < 2
    t.join(3)
    assert "didn't answer" in _text(box["out"])
    assert computer.app_exchange({"watch": "never-existed"}) == {"wanted": False}


def test_a_watch_on_an_order_still_wanted_says_so(isolated):
    sid, job = _chat(isolated)
    _grant(job, sid)
    t, box, oid = _app_takes_an_order(sid)
    assert computer.app_exchange({"watch": oid}) == {"wanted": True}      # after PULL_WAIT
    computer.app_exchange({"results": [{"id": oid, "ok": True}]})
    t.join(3)
    assert not box["out"].get("isError")


def test_a_stop_that_crossed_a_call_wins(isolated):
    """The call read the grant, then Stop dropped it: the call can't take the desktop
    back, or queue anything on the grant it read."""
    sid, job = _chat(isolated)
    _grant(job, sid)
    computer.app_exchange({})
    s = store.get_session(sid)
    computer.stop(sid, "you")
    assert computer._take_lock(s, job) == computer.STOPPED           # noqa: SLF001
    assert computer._order(sid, "left_click", {})["isError"]         # noqa: SLF001
    assert not computer.status(sid)["driving"]
    assert [o["action"] for o in computer.app_exchange({})["orders"]] == []


def test_a_late_stop_from_the_mac_cant_end_another_chats_drive(isolated):
    _a, job_a = _chat(isolated, title="fix login")
    _grant(job_a, _a)
    computer.app_exchange({})
    t, _ = _app_does(lambda o: {"ok": True})
    computer.call(_a, "mouse_move", {"coordinate": [1, 1]})
    t.join(3)
    assert computer.app_exchange({"stop": "esc", "sid": "some-earlier-chat"}) == {"orders": [], "driving": True}
    assert computer.status(_a)["driving"] and not job_a.interrupted
    assert computer.app_exchange({"stop": "esc", "sid": _a}) == {"orders": [], "driving": False}
    assert job_a.interrupted


def test_the_next_turn_of_the_same_chat_drives_afresh(isolated):
    """Even if the earlier turn's lock was never let go: its own driving event (the
    pill reads it per turn) and its own release."""
    sid, job = _chat(isolated)
    _grant(job, sid)
    computer.app_exchange({})
    t, _ = _app_does(lambda o: {"ok": True}, rounds=2)
    computer.call(sid, "mouse_move", {"coordinate": [1, 1]})
    nxt = FakeJob(sid)
    isolated[sid] = nxt
    assert not computer.call(sid, "mouse_move", {"coordinate": [2, 2]}).get("isError")
    t.join(3)
    assert nxt.events[-1] == {"type": "computer_state", "state": "driving", "apps": ["Safari"]}
    nxt.status = "done"
    nxt.exited.set()
    time.sleep(0.2)
    assert not computer.status(sid)["driving"]
