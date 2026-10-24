"""The bot chat as a live chat (bridge/tglive.py, tgask.py, tgtopics.py and their
wiring in dispatch, runner and notices): live answers with Stop, questions and
approvals answered in the chat, a topic per session, and only what needs you
rings. Telegram is stubbed throughout."""

import threading
import time
import uuid
from datetime import datetime

import pytest

from bridge import (config, devserver, dispatch, limits, notices, runner, state, store, telegram,
                    tgask, tgfiles, tglive, tgtopics)

store.init()
CHAT = 555


def _wait(pred, timeout=3.0):
    end = time.time() + timeout
    while time.time() < end:
        if pred():
            return True
        time.sleep(0.01)
    return False


@pytest.fixture
def tg(monkeypatch):
    """What tglive and tgask send, react and draft, recorded."""
    box = {"send": [], "react": [], "draft": []}
    mids = iter(range(70, 10_000))

    def send(chat, text, kb=None, *a, **k):
        box["send"].append(((chat, text, kb), k))
        return {"message_id": next(mids)}
    monkeypatch.setattr(telegram, "send", send)
    monkeypatch.setattr(telegram, "react", lambda chat, mid, emoji: box["react"].append((chat, mid, emoji)))
    monkeypatch.setattr(telegram, "draft", lambda chat, did, text, thread=None: box["draft"].append((chat, did, text)))
    monkeypatch.setattr(tglive, "TICK", 0.01)
    return box


# --- tgask: the ask itself, in the chat ------------------------------------------------

QUESTION = {"request_id": "r1", "kind": "question", "tool_name": "AskUserQuestion",
            "questions": [{"header": "Scope", "question": "Include the old rows?",
                           "options": [{"label": "Keep them"}, {"label": "Leave them out"},
                                       {"label": "Ask later"}]}]}
BASH = {"request_id": "r2", "kind": "permission", "tool_name": "Bash", "summary": "rm -rf build",
        "input": {"command": "rm -rf build"}}


class AskJob:
    def __init__(self, *entries):
        self._lock = threading.Lock()
        self.pending = [dict(e) for e in entries]
        self.answers = []

    def respond(self, rid, **kw):
        if not any(p["request_id"] == rid for p in self.pending):
            return False
        self.pending = [p for p in self.pending if p["request_id"] != rid]
        self.answers.append((rid, kw))
        return True


def test_a_question_pings_with_its_options_two_to_a_row():
    html, kb, options, simple = tgask.message("Fix login", QUESTION, "tok", None)
    assert simple and options == ["Keep them", "Leave them out", "Ask later"]
    assert html.splitlines()[:2] == ["❓ <b>Fix login</b> asks", "Include the old rows?"]
    assert "reply to this message" in html
    assert [[b["callback_data"] for b in row] for row in kb["inline_keyboard"]] == [
        ["ta:tok:0", "ta:tok:1"], ["ta:tok:2"]]


def test_what_a_chat_cant_answer_whole_keeps_only_the_panel():
    many = {**QUESTION, "questions": QUESTION["questions"] * 2}
    panel = {"inline_keyboard": [[{"text": "Open session ↗", "url": "https://x"}]]}
    html, kb, options, simple = tgask.message("Fix <login>", many, "tok", panel)
    assert not simple and options == [] and kb == panel
    assert html.startswith("❓ <b>Fix &lt;login&gt;</b> has 2 questions")


def test_an_approval_is_allow_in_green_deny_in_red_and_a_command_to_copy():
    html, kb, options, _ = tgask.message("Fix login", BASH, "tok", None)
    assert "<pre>rm -rf build</pre>" in html and options == ["Allow", "Deny"]
    allow, deny = kb["inline_keyboard"][0]
    assert (allow["callback_data"], allow["style"], deny["callback_data"], deny["style"]) == (
        "ta:tok:y", "success", "ta:tok:n", "danger")
    assert kb["inline_keyboard"][1] == [{"text": "⎘ Copy command", "copy_text": {"text": "rm -rf build"}}]
    long = {**BASH, "summary": "x" * 120, "input": {"command": "x" * 257}}
    html, kb, _, _ = tgask.message("Fix login", long, "tok", None)
    assert f"<pre>{'x' * 257}</pre>" in html and len(kb["inline_keyboard"]) == 1   # whole; half a command: no copy


def test_an_approval_shows_all_it_approves_or_offers_no_allow():
    """The summary is cut (120 chars of a command, 3×40 of an MCP call), but Allow
    approves the whole input: the card shows that, or it can't be allowed here."""
    mcp = {"request_id": "r3", "kind": "permission", "tool_name": "mcp__teamwork__comment",
           "summary": "body=Shipped the login fi", "input": {"task": 7, "body": "Shipped the login fix.\n" * 3}}
    html, kb, _, _ = tgask.message("Fix login", mcp, "tok", None)
    assert "body:\nShipped the login fix.\nShipped" in html and kb["inline_keyboard"][0][0]["text"] == "✓ Allow"
    huge = {**BASH, "input": {"command": "echo " + "y" * (tgask.SHOWN + 10)}}
    html, kb, _, _ = tgask.message("Fix login", huge, "tok", None)
    assert [b["text"] for b in kb["inline_keyboard"][0]] == ["✕ Deny"]
    assert "…and 15 more characters. Open the session" in html


@pytest.fixture
def asks(tg, monkeypatch):
    jobs = {}
    monkeypatch.setattr(runner, "get_job", lambda jid: jobs.get(jid))
    monkeypatch.setattr(state, "tg_topics", False)
    tgask._asks.clear()
    tgask._msgs.clear()
    return jobs


def test_a_tap_answers_the_turn_once_and_the_ping_records_it(asks, tg):
    sid = store.create_session(CHAT, "/tgask")["id"]
    asks["j1"] = AskJob(QUESTION)
    assert tgask.ping(CHAT, sid, "j1", "r1")
    (chat, html, kb), k = tg["send"][-1]
    assert k["html"] is True
    token = tgask._msgs[(CHAT, 70)]
    assert tgask.tap(777, token, "1")[0] is None and asks["j1"].answers == []   # another chat's tap
    said, ask = tgask.tap(CHAT, token, "1")
    assert said == "Leave them out"
    assert asks["j1"].answers == [("r1", {"answers": [{"header": "Scope", "labels": ["Leave them out"]}]})]
    assert tgask.tap(CHAT, token, "0") == (None, None)                          # stale
    assert tgask.reply(CHAT, 70, "late words") == (False, None)                 # told, not a prompt
    html, kb = tgask.answered(ask, said)
    assert html.endswith("\n\n✓ <b>Leave them out</b>")
    assert kb == {"inline_keyboard": [[{"text": "✓ Leave them out", "disabled": {}}]]}


def test_a_reply_to_an_approval_is_a_no_with_what_to_do_instead(asks, tg):
    sid = store.create_session(CHAT, "/tgask-deny")["id"]
    asks["j2"] = AskJob(BASH)
    assert tgask.ping(CHAT, sid, "j2", "r2")
    assert tgask.reply(CHAT, 9999, "whatever") == (None, None)                   # not a ping: a prompt
    said, _ = tgask.reply(CHAT, 70, "use make clean")
    assert said == "Denied: use make clean"
    assert asks["j2"].answers == [("r2", {"behavior": "deny", "message": "use make clean"})]
    assert tgask.reply(CHAT, 70, "again")[0] is False


def test_an_ask_that_moved_on_pings_the_old_way(asks):
    asks["j3"] = AskJob()                                                       # nothing pending
    assert tgask.ping(CHAT, "s", "j3", "r9") is False


# --- tglive: the turn, run live --------------------------------------------------------

class LiveJob:
    def __init__(self, status="done", result="All done."):
        self.id = uuid.uuid4().hex
        self.chat_id = CHAT
        self.store_session_id = None
        self.events = []
        self._lock = threading.Lock()
        self.exited = threading.Event()
        self.status, self.result, self.error_msg = status, result, None
        self.interrupted = False
        self.started = time.time()
        self.tg_live = False
        self.told = False
        self.stops = 0

    def activity(self):
        return {"state": "tool", "label": "Running tests"}

    def interrupt(self):
        self.stops += 1
        self.interrupted = True
        return True


def _draft_id(job):
    return (int(job.id[:8], 16) % 2_000_000_000) or 1


def test_the_bot_chat_keeps_its_permission_flags():
    for extra, want in (("--permission-mode acceptEdits", ("acceptEdits", [])),
                        ("--dangerously-skip-permissions --add-dir /x", ("bypassPermissions", ["--add-dir", "/x"])),
                        ("--permission-mode=plan --allowedTools Read", ("plan", ["--allowedTools", "Read"])),
                        ("", (None, []))):
        config.EXTRA_CLAUDE_ARGS, saved = extra, config.EXTRA_CLAUDE_ARGS
        try:
            assert tglive.bot_args() == want, extra
        finally:
            config.EXTRA_CLAUDE_ARGS = saved


def test_the_draft_is_what_was_said_then_the_step():
    assert tglive.draft_text("Hi.", {"state": "tool", "label": "Reading x.py"}) == "Hi.\n\n_Reading x.py_"
    assert tglive.draft_text("", {"state": "awaiting"}) == "_Waiting for your answer above._"
    assert tglive.draft_text("", {"state": "thinking"}) == ""                 # Telegram's "Thinking…"


def test_a_live_turn_drafts_then_answers_with_receipts(tg):
    job = LiveJob()
    job.events.append({"type": "text", "text": "Looking at it."})
    t = threading.Thread(target=tglive._watch, args=(job, CHAT, 9, None))
    t.start()
    assert _wait(lambda: tg["draft"])
    job.exited.set()
    t.join(2)
    assert tg["draft"][0] == (CHAT, _draft_id(job), "Looking at it.\n\n_Running tests_")
    assert tg["react"] == [(CHAT, 9, "👀"), (CHAT, 9, "👌")]
    (chat, text, kb), k = tg["send"][-1]
    assert text.startswith("All done.\n\n— ") and text.endswith("s") and k["rich"] is True and kb is None


def test_stop_stops_only_its_own_draft_in_its_own_chat(tg):
    job = LiveJob()
    job.events.append({"type": "text", "text": "Half"})
    t = threading.Thread(target=tglive._watch, args=(job, CHAT, None, None))
    t.start()
    assert _wait(lambda: _draft_id(job) in tglive._live)
    assert tglive.stop(777, _draft_id(job)) is False and job.stops == 0
    assert tglive.stop(CHAT, _draft_id(job) + 1) is False
    assert tglive.stop(CHAT, _draft_id(job)) is True and job.stops == 1
    job.exited.set()
    t.join(2)
    assert tg["send"][-1][0][1].startswith("Half\n\n⏹ Stopped.") and tg["react"] == []
    assert _draft_id(job) not in tglive._live


def test_a_limit_or_a_login_says_so_once(tg):
    job = LiveJob(status="error", result="You've hit your usage limit · resets 3pm")
    job.error_msg, job.told = job.result, True                    # the parked notice came here
    job.exited.set()
    tglive._watch(job, CHAT, 9, None)
    assert tg["send"] == [] and tg["react"] == [(CHAT, 9, "👀"), (CHAT, 9, "😢")]
    job = LiveJob(status="error", result="You've hit your usage limit · resets 3pm")
    job.error_msg = job.result                                    # nothing told it (AUTO_RESUME off)
    job.exited.set()
    tglive._watch(job, CHAT, 10, None)
    assert tg["send"][-1][0][1].startswith("⚠️ You've hit your usage limit") and tg["react"][-1] == (CHAT, 10, "😢")


def test_a_restart_or_a_lost_answer_never_says_ok(tg, monkeypatch):
    job = LiveJob(status="error", result="")
    job.exited.set()
    monkeypatch.setattr(state, "shutting_down", True)
    tglive._watch(job, CHAT, 9, None)
    assert tg["send"] == [] and tg["react"] == [(CHAT, 9, "👀")]     # boot recovery takes it from here
    monkeypatch.setattr(state, "shutting_down", False)
    monkeypatch.setattr(telegram, "send", lambda *a, **k: None)    # Telegram took nothing
    job = LiveJob()
    job.exited.set()
    tglive._watch(job, CHAT, 11, None)
    assert tg["react"][-1] == (CHAT, 11, "😢")


def test_a_group_gets_no_drafts(tg):
    job = LiveJob()
    job.events.append({"type": "text", "text": "Hi"})
    t = threading.Thread(target=tglive._watch, args=(job, -100123, None, None))
    t.start()
    time.sleep(0.1)
    job.exited.set()
    t.join(2)
    assert tg["draft"] == [] and tg["send"][-1][0][0] == -100123


def test_an_agent_session_stays_in_the_panel(tg, monkeypatch):
    from bridge import profiles
    monkeypatch.setattr(profiles, "effective", lambda s: {"agent": "codex", "permission_mode": None})
    monkeypatch.setattr(runner, "start_streaming_job", lambda *a, **k: pytest.fail("ran it"))
    assert tglive.start(CHAT, store.create_session(CHAT, "/tglive-acp"), "hi") is False
    assert "another agent" in tg["send"][-1][0][1]


def test_a_turn_picked_up_again_is_followed_to_its_end(tg, monkeypatch):
    first, second = LiveJob(status="error", result="boom"), LiveJob(result="Recovered.")
    first.store_session_id = "s-picked-up"
    first.exited.set()
    second.exited.set()
    monkeypatch.setattr(runner, "live_job", lambda sid: second)
    tglive._watch(first, CHAT, None, 4)
    (chat, text, kb), k = tg["send"][-1]
    assert text.startswith("Recovered.") and k["thread"] == 4 and second.tg_live is True


def test_a_busy_session_keeps_the_files_and_says_so(tg, monkeypatch):
    monkeypatch.setattr(runner, "start_streaming_job", lambda *a, **k: None)
    monkeypatch.setattr(runner, "adopt_uploads", lambda job_id, files: list(files or []))
    held = []
    monkeypatch.setattr(tgfiles, "hold", lambda chat, p: held.append(p) or len(held))
    s = store.create_session(CHAT, "/tglive-busy")
    assert tglive.start(CHAT, s, "go", ["/tmp/x.txt"], thread=7) is False
    assert held == ["/tmp/x.txt"]
    (chat, text, kb), k = tg["send"][-1]
    assert "Still working" in text and k["thread"] == 7


# --- tgtopics: a thread per session ----------------------------------------------------

def test_topics_off_change_nothing(monkeypatch):
    monkeypatch.setattr(state, "tg_topics", False)
    made = []
    monkeypatch.setattr(telegram, "create_topic", lambda *a: made.append(a) or 1)
    s = store.create_session(CHAT, "/topics-off")
    assert tgtopics.thread_for(CHAT, s["id"]) is None and made == []


def test_a_session_gets_one_topic_the_first_time_one_is_wanted(monkeypatch):
    monkeypatch.setattr(state, "tg_topics", True)
    made = []
    monkeypatch.setattr(telegram, "create_topic", lambda chat, name, color: made.append((chat, name, color)) or 9101)
    s = store.create_session(CHAT, "/org/topics-on")
    assert tgtopics.thread_for(CHAT, s["id"], create=False) is None and made == []
    assert tgtopics.thread_for(CHAT, s["id"]) == 9101 == tgtopics.thread_for(CHAT, s["id"])
    assert made == [(CHAT, "topics-on", tgtopics._color(s))]
    assert store.session_by_thread(CHAT, 9101)["id"] == s["id"]
    assert tgtopics.thread_for(777, s["id"]) is None                            # another chat's session
    assert tgtopics.thread_for(-100123, s["id"]) is None                        # a group: never


def test_a_topic_the_user_makes_is_a_new_session_named_after_it(monkeypatch):
    monkeypatch.setattr(state, "tg_topics", True)
    s = tgtopics.adopt(CHAT, 9102, "Login bug", "/org/app")
    assert (s["tg_thread"], s["title"], s["title_source"], s["project"]) == (9102, "Login bug", "manual", "/org/app")
    renamed = []
    monkeypatch.setattr(telegram, "rename_topic", lambda chat, thread, name: renamed.append((chat, thread, name)))
    store.rename(s["id"], "Login redirect")
    tgtopics.rename(s["id"])
    assert renamed == [(CHAT, 9102, "Login redirect")]


def test_a_deleted_topic_sends_to_the_main_chat_and_gets_replaced(monkeypatch):
    monkeypatch.setattr(state, "tg_topics", True)
    calls = []

    def tg(method, **p):
        calls.append((method, p))
        if method == "createForumTopic":
            return {"message_thread_id": 9402}
        if p.get("message_thread_id") == 9401:
            telegram._last.error = "Bad Request: message thread not found"
            return None
        return {"message_id": 5}
    monkeypatch.setattr(telegram, "tg", tg)
    monkeypatch.setattr(telegram, "gone_threads", set())
    s = tgtopics.adopt(CHAT, 9401, "Old", "/org/gone")
    assert telegram.send(CHAT, "hi", markdown=False, thread=9401) == {"message_id": 5}
    assert "message_thread_id" not in calls[-1][1] and (CHAT, 9401) in telegram.gone_threads
    assert tgtopics.thread_for(CHAT, s["id"]) == 9402 and store.get_session(s["id"])["tg_thread"] == 9402
    assert not telegram.gone_threads
    telegram._last.error = "Bad Request: message is too long"
    monkeypatch.setattr(telegram, "tg", lambda method, **p: None)
    assert telegram.send(CHAT, "x", markdown=False, thread=9402) is None and not telegram.gone_threads


def test_topics_follow_what_getme_says(monkeypatch):
    monkeypatch.setattr(state, "tg_topics", False)
    tgtopics.boot({"has_topics_enabled": True})
    assert tgtopics.on()
    tgtopics.boot(None)
    assert not tgtopics.on()


# --- dispatch: taps, Stop, topics, replies ---------------------------------------------

@pytest.fixture
def chat(monkeypatch):
    box = {"acks": [], "edits": [], "marks": [], "sent": [], "runs": [], "stops": []}
    monkeypatch.setattr(dispatch, "answer_cb", lambda cid, text="": box["acks"].append(text))
    monkeypatch.setattr(dispatch, "edit", lambda chat, mid, text, kb=None, **k: box["edits"].append((mid, text, kb, k)))
    monkeypatch.setattr(dispatch, "edit_markup", lambda chat, mid, kb: box["marks"].append((mid, kb)))
    monkeypatch.setattr(dispatch, "send", lambda chat, text, kb=None, **k: box["sent"].append((text, k)))
    monkeypatch.setattr(tglive, "start", lambda *a, **k: box["runs"].append((a, k)))
    monkeypatch.setattr(tglive, "stop", lambda chat, did: box["stops"].append((chat, did)))
    return box


def _cb(data, who=CHAT):
    return {"id": "cb1", "from": {"id": who}, "data": data,
            "message": {"chat": {"id": CHAT}, "message_id": 7}}


def test_a_tap_answers_and_a_stale_one_loses_its_buttons(chat, monkeypatch):
    monkeypatch.setattr(tgask, "tap", lambda c, tok, choice: ("Allowed", {"html": "🔐 ask"}) if tok == "ok" else (None, None))
    dispatch._ask_callback(_cb("ta:ok:y"), CHAT, 7, "ta:ok:y")
    assert chat["acks"] == ["Answered. The turn goes on."]
    mid, html, kb, k = chat["edits"][-1]
    assert (mid, html, k) == (7, "🔐 ask\n\n✓ <b>Allowed</b>", {"html": True}) and kb["inline_keyboard"][0][0]["disabled"] == {}
    dispatch._ask_callback(_cb("ta:gone:y"), CHAT, 7, "ta:gone:y")
    assert chat["acks"][-1] == "Already answered." and chat["marks"] == [(7, None)]
    dispatch._ask_callback(_cb("ta:ok:y", who=424242), CHAT, 7, "ta:ok:y")      # not someone allowed here
    assert chat["acks"][-1] == "" and len(chat["edits"]) == 1


def test_stop_reaches_the_draft_it_was_pressed_under(chat):
    dispatch.on_stop({"chat": {"id": CHAT}, "draft_id": 42})
    dispatch.on_stop({"chat": {"id": 999}, "draft_id": 43})
    assert chat["stops"] == [(CHAT, 42)]


def test_words_in_a_topic_run_in_its_session(chat, monkeypatch):
    monkeypatch.setattr(state, "tg_topics", False)                # boot's getMe failed
    dispatch.on_message({"chat": {"id": CHAT, "type": "private"}, "from": {"id": CHAT}, "message_id": 5,
                         "message_thread_id": 9201, "is_topic_message": True, "text": "fix it"})
    assert state.tg_topics is True
    [(args, k)] = chat["runs"]
    assert args[0] == CHAT and args[2] == "fix it" and k == {"msg_id": 5, "thread": 9201}
    assert store.session_by_thread(CHAT, 9201)["id"] == args[1]["id"]
    dispatch.on_message({"chat": {"id": CHAT}, "from": {"id": CHAT}, "message_id": 6,
                         "message_thread_id": 9201, "is_topic_message": True, "text": "and the test"})
    assert chat["runs"][1][0][1]["id"] == args[1]["id"]                          # the same session


def test_a_new_topic_is_a_new_session_unless_the_bridge_made_it(chat, monkeypatch):
    monkeypatch.setattr(state, "tg_topics", True)
    made = {"name": "Login bug", "icon_color": 7322096}
    dispatch.on_message({"chat": {"id": CHAT}, "from": {"id": 4242, "is_bot": True}, "message_id": 8,
                         "message_thread_id": 9301, "is_topic_message": True, "forum_topic_created": made})
    assert chat["sent"] == [] and store.session_by_thread(CHAT, 9301) is None
    dispatch.on_message({"chat": {"id": CHAT}, "from": {"id": CHAT}, "message_id": 9,
                         "message_thread_id": 9302, "is_topic_message": True, "forum_topic_created": made})
    assert store.session_by_thread(CHAT, 9302)["title"] == "Login bug"
    [(text, k)] = chat["sent"]
    assert text.startswith("New session in ") and k == {"thread": 9302}
    assert chat["runs"] == []
    dispatch.on_message({"chat": {"id": CHAT}, "from": {"id": CHAT}, "message_id": 10,
                         "message_thread_id": 9303, "is_topic_message": True,
                         "forum_topic_created": {"name": "New topic", "is_name_implicit": True}})
    assert store.session_by_thread(CHAT, 9303)["title_source"] == "auto"     # the titler names it


def test_a_reply_to_an_ask_answers_it_and_is_no_prompt(chat, monkeypatch):
    monkeypatch.setattr(tgask, "reply", lambda c, mid, text: ("only last week", {"html": "❓ q"}) if mid == 41 else (None, None))
    dispatch.on_message({"chat": {"id": CHAT}, "from": {"id": CHAT}, "text": "only last week",
                         "reply_to_message": {"message_id": 41, "text": "❓ q"}})
    assert chat["runs"] == [] and chat["edits"][-1][:2] == (41, "❓ q\n\n✓ <b>only last week</b>")
    monkeypatch.setattr(tgask, "reply", lambda c, mid, text: (False, None))
    dispatch.on_message({"chat": {"id": CHAT}, "from": {"id": CHAT}, "text": "late",
                         "reply_to_message": {"message_id": 41, "text": "❓ q"}})
    assert chat["runs"] == [] and "already answered" in chat["sent"][-1][0]


def test_the_command_menu_is_the_help():
    import re
    menu = dispatch.menu()
    assert ("new", "fresh Claude session for the active project") in menu and len(menu) >= 10
    assert all(re.fullmatch(r"[a-z0-9_]{1,32}", c) and 0 < len(d) <= 256 for c, d in menu)


# --- quieter: only needs-you rings; quiet hours end in one message ----------------------

def test_only_what_needs_you_rings_and_an_ask_sends_itself(monkeypatch):
    sent = []
    monkeypatch.setattr(runner, "send", lambda chat, text, kb=None, **k: sent.append((text, k["silent"])))
    monkeypatch.setattr(notices, "telegram_ok", lambda kind, now=None: True)
    monkeypatch.setattr(config, "NOTIFY_ENABLE", True)
    monkeypatch.setattr(state, "tg_topics", False)
    sid = store.create_session(CHAT, "/ring")["id"]
    runner._notify(CHAT, "done", None, kind="done", sid=sid)
    runner._notify(CHAT, "q", None, kind="question", sid=sid)
    runner._notify(CHAT, "asked", None, kind="question", sid=sid, ask=lambda: True)
    runner._notify(CHAT, "fallback", None, kind="question", sid=sid, ask=lambda: False)
    assert sent == [("done", True), ("q", False), ("fallback", False)]
    assert (notices.tier("approve"), notices.tier("done"), notices.tier(None)) == ("needs", "news", "fyi")
    monkeypatch.setattr(notices, "telegram_ok", lambda kind, now=None: False)   # routed off, or pushes off
    monkeypatch.setattr(config, "NOTIFY_ENABLE", False)
    runner._notify(CHAT, "routed", None, kind="question", sid=sid)
    runner._notify(CHAT, "chat turn", None, kind="question", sid=sid, always=True)
    assert sent[-1] == ("chat turn", False) and ("routed", False) not in sent


def test_a_chat_started_turn_always_gets_its_ask(monkeypatch):
    seen = []
    monkeypatch.setattr(runner, "_notify", lambda *a, **k: seen.append(k["always"]))
    job = runner.Job("j-always", CHAT, "s-always")
    monkeypatch.setattr(runner, "get_job", lambda jid: job if jid == "j-always" else None)
    runner.notify_awaiting(CHAT, "s-always", "permission", job_id="j-always", request_id="r1")
    job.tg_live = True
    runner.notify_awaiting(CHAT, "s-always", "permission", job_id="j-always", request_id="r1")
    runner.notify_awaiting(CHAT, "s-always", "permission")
    assert seen == [False, True, False]


def test_quiet_hours_hold_what_would_have_pinged_and_say_it_in_one_message():
    p = notices._defaults()                                 # needs pass quiet hours by default
    t0 = time.time()
    tag = uuid.uuid4().hex[:6]
    for kind in ("done", "started", "question", "failed"):
        notices.emit(kind, f"held:{tag}:{kind}", title="Fix login", body=f"{kind} body")
    notices.emit("failed", f"held:{tag}:echo", title="Fix login", meta={"quiet": True})
    rows = [r for r in notices.held(t0 - 1, time.time() + 1, p) if r["subject"].startswith(f"held:{tag}")]
    assert [r["kind"] for r in rows] == ["done", "failed"]  # STARTED is off, the ask got through, an echo never pings
    text = notices.held_text(rows)
    assert text.splitlines() == ["🌙 While it was quiet", "• DONE · Fix login: done body",
                                 "• FAILED · Fix login: failed body"]
    assert notices.held_text(rows * 10, most=12).endswith("\n…and 8 more in the bell.")


def test_quiet_hours_began_at_their_last_start():
    assert notices._quiet_began(datetime(2026, 10, 25, 9, 0, 30), "22:00") == datetime(2026, 10, 24, 22, 0).timestamp()
    assert notices._quiet_began(datetime(2026, 10, 25, 14, 0, 30), "13:00") == datetime(2026, 10, 25, 13, 0).timestamp()


# --- small ones: reset times in your clock, folded logs --------------------------------

def test_a_reset_time_shows_in_the_readers_clock_and_survives_markdown(monkeypatch):
    at = time.time() + 3600
    tag = limits.when_tg(at)
    assert tag == f'<tg-time unix="{int(at)}" format="t">{limits.when_str(at)}</tg-time>'
    assert 'format="wt"' in limits.when_tg(time.time() + 3 * 86400)
    assert telegram._md_to_html(f"resets ~{tag} **soon** <b>") == f"resets ~{tag} <b>soon</b> &lt;b&gt;"
    calls = []
    monkeypatch.setattr(telegram, "tg", lambda method, **p: calls.append(p) or (None if "parse_mode" in p else {"message_id": 1}))
    telegram.send(CHAT, f"resets ~{tag}")
    assert calls[-1]["text"] == f"resets ~{limits.when_str(at)}"            # refused HTML: just the time


def test_logs_come_folded_and_as_typed(monkeypatch):
    sent = []
    monkeypatch.setattr(devserver, "send", lambda chat, text, *a, **k: sent.append((text, k)))
    monkeypatch.setattr(devserver, "_tail", lambda d, n: ["GET / 200", "<b>not bold</b> & co"])
    devserver.handle_logs(CHAT, "")
    assert sent == [("📄 Last 2 log line(s):\n<blockquote expandable>GET / 200\n"
                     "&lt;b&gt;not bold&lt;/b&gt; &amp; co</blockquote>", {"html": True})]
