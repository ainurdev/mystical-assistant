"""Spin-offs: work a chat turned up, each item started in its own project's session from the card."""
import os
import subprocess
import time
from types import SimpleNamespace

import pytest

from bridge import config, experimental, gateway, multi_api, spinoffs, store, worklist as wl

CHAT = config.DASH_CHAT_ID


def _repo(base, rel, url=None):
    p = os.path.join(base, rel)
    os.makedirs(p)
    subprocess.run(["git", "init", "-q", p], check=True)
    if url:
        subprocess.run(["git", "-C", p, "remote", "add", "origin", url], check=True)
    subprocess.run(["git", "-C", p, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"], check=True)
    return os.path.realpath(p)


class Job:
    def __init__(self):
        self.id, self.events = f"j{time.time_ns()}", []

    def add(self, e):
        self.events.append(e)


@pytest.fixture
def world(tmp_path, monkeypatch):
    base = os.path.realpath(str(tmp_path / "base"))
    shop = _repo(base, "shop", "git@github.com:acme/shop.git")
    riv = _repo(base, "ainur/rivendell", "https://github.com/ainurdev/rivendell.git")
    monkeypatch.setattr(config, "BASE_PATH", base)
    monkeypatch.setattr(experimental, "_path", lambda: str(tmp_path / "experimental.json"))
    monkeypatch.setattr(experimental, "_cache", None)
    experimental.set_enabled(True)
    monkeypatch.setattr(spinoffs, "_owners", lambda: {"ainurdev", "mhz"})
    store.init()
    s = store.create_session(CHAT, "/shop", cwd=shop)
    store.rename(s["id"], "Check Sentry issues")
    return SimpleNamespace(base=base, shop=shop, riv=riv, s=store.get_session(s["id"]))


def offer(w, items, job=None):
    job = job or Job()
    res = spinoffs.offer(w.s, job, {"items": items})
    return res, job


def rows(w):
    (card,) = spinoffs.view(w.s["id"])["cards"]
    return card["rows"]


SENTRY = {"kind": "sentry", "ref": "RIVENDELL-4Q2", "url": "https://sentry.io/issues/1/"}


def test_a_turn_leaves_a_card_with_each_row_guessed_onto_a_project(world):
    res, job = offer(world, [
        {"title": "Board sync reads a card with no list", "brief": "null in applyCard", "project": "ainurdev/rivendell",
         "flow": "fix", "sources": [SENTRY]},
        {"title": "Voucher lost on return", "project": "https://github.com/acme/shop", "flow": "build"},
        {"title": "Lesson plan 500", "project": "shop"},
        {"title": "Hydration mismatch", "project": "mhz/reports-web", "flow": "fix"},
        {"title": "Someone else's", "project": "stranger/thing"},
    ])
    assert not res.get("isError") and "Lead your reply with one line" in res["content"][0]["text"]
    (ev,) = job.events
    assert ev == {"type": "spinoffs", "card": "c1"}
    got = [(r["title"], r["project"], r["flow"], r["clone"], r["state"]) for r in rows(world)]
    assert got == [
        ("Board sync reads a card with no list", "/ainur/rivendell", "fix", "", "open"),
        ("Voucher lost on return", "/shop", "build", "", "open"),
        ("Lesson plan 500", "/shop", "build", "", "open"),
        ("Hydration mismatch", "", "fix", "https://github.com/mhz/reports-web", "open"),   # yours, not here: Clone & start
        ("Someone else's", "", "build", "", "open"),                                         # not yours: never cloned
    ]
    assert rows(world)[0]["sources"] == [SENTRY] and rows(world)[0]["brief"] == "null in applyCard"


def test_a_card_needs_a_turn_and_titled_rows_and_an_after_that_points_back(world):
    assert spinoffs.offer(world.s, None, {"items": [{"title": "x"}]})["isError"]
    assert offer(world, [])[0]["isError"]
    assert offer(world, [{"title": "  "}])[0]["isError"]
    res, job = offer(world, [{"title": "a"}, {"title": "b", "after": 2}])
    assert res["isError"] and "earlier" in res["content"][0]["text"] and not job.events


def test_a_chats_agent_has_the_tool_and_a_helper_doesnt(world):
    assert "spin_off" in gateway.tool_names(world.s)
    assert "spin_off" not in gateway.tool_names({**world.s, "parent_session": "x"})
    experimental.set_enabled(False)       # nothing could act on its card
    assert "spin_off" not in gateway.tool_names(world.s)


def test_a_source_already_on_a_work_list_is_a_repeat_that_links_there(world):
    other = store.create_session(CHAT, "/ainur/rivendell", cwd=world.riv)
    store.rename(other["id"], "Fix the board sync null")
    (item,) = wl.add(world.riv, [{"title": "Board sync null", "source": {"kind": "sentry", "ref": "RIVENDELL-4Q2"}}])
    wl.mutate(world.riv, lambda d: d["items"][0].update(session_id=other["id"], state="doing"))
    res, _ = offer(world, [{"title": "Board sync reads a card with no list", "project": "ainurdev/rivendell", "sources": [SENTRY]},
                           {"title": "Something new", "project": "shop", "sources": [{"kind": "sentry", "ref": "SHOP-1"}]}])
    assert "Item 1 is already on the work list of /ainur/rivendell, as w1" in res["content"][0]["text"]
    first, second = rows(world)
    assert first["repeat"]["session"] == other["id"] and first["repeat"]["title"] == "Fix the board sync null"
    assert first["repeat"]["task"] == item["id"] and second["repeat"] is None


# --- START and PARK --------------------------------------------------------------

@pytest.fixture
def runs(world, monkeypatch, tmp_path):
    """Runs and flows faked: each start recorded, its flow recorded as start_flow would."""
    from bridge import paths, runner
    monkeypatch.setattr(paths, "_file", lambda: str(tmp_path / "flows.json"))
    paths._cache.clear()
    got = []

    def start(chat_id, prompt, images, project=None, session_id=None, origin=None, flow=None, flow_by=None, **kw):
        got.append({"sid": session_id, "prompt": prompt, "project": project, "flow": flow, **kw})
        paths.set_path(session_id, flow, "you picked", "you")
        return SimpleNamespace(refusal=None)
    monkeypatch.setattr(runner, "start_streaming_job", start)
    return got


def tap(w, path, rows, chat=CHAT):
    return multi_api.post(f"spinoffs/{path}", {"session_id": w.s["id"], "card": "c1", "rows": rows}, chat)


ISSUES = [
    {"title": "Board sync reads a card with no list", "brief": "applyCard gets null", "project": "ainurdev/rivendell",
     "flow": "fix", "sources": [SENTRY, {"kind": "sentry", "ref": "RIVENDELL-4Q5"}]},
    {"title": "Voucher lost on return", "project": "shop", "flow": "build"},
    {"title": "Lesson plan 500", "project": "shop", "flow": "fix"},
]


def test_start_files_each_row_on_its_own_projects_list_and_opens_its_session_there(world, runs):
    offer(world, ISSUES)
    body, status = tap(world, "start", [{"n": 1}, {"n": 2, "flow": "design"}])
    assert status == 200
    (task,) = wl.load(world.riv)["items"]
    assert (task["title"], task["state"], task["source"]["ref"]) == ("Board sync reads a card with no list", "doing", "RIVENDELL-4Q2")
    spun = store.get_session(task["session_id"])
    assert (spun["project"], spun["origin"], spun["title"]) == ("/ainur/rivendell", "work", "Board sync reads a card with no list")
    assert store.parse_json(spun["spun_from"]) == {"session": world.s["id"], "keys": ["RIVENDELL-4Q2", "RIVENDELL-4Q5"]}
    from bridge.miniapp import server as ms
    assert ms._session_brief(spun)["spun_from"] == {"session": world.s["id"], "keys": ["RIVENDELL-4Q2", "RIVENDELL-4Q5"]}
    assert ms._session_brief(world.s)["spun_from"] is None       # what both apps' lists carry
    first = runs[0]
    assert first["sid"] == spun["id"] and first["flow"] == "fix" and first["sent_by"] == "mystical:spinoff"
    assert first["prompt"].startswith("Board sync reads a card with no list\n\napplyCard gets null")
    assert "“Check Sentry issues” in shop" in first["prompt"] and "RIVENDELL-4Q5" in first["prompt"]
    assert [r["flow"] for r in runs] == ["fix", "design"]       # the card's flow, as you changed it
    states = [(r["state"], bool(r["session"])) for r in body["cards"][0]["rows"]]
    assert states == [("started", True), ("started", True), ("open", False)]   # the untouched row stays
    assert body["cards"][0]["rows"][0]["session"] == spun["id"]


def test_park_files_the_task_unstarted_and_its_start_later_is_still_a_spin_off(world, runs):
    offer(world, ISSUES)
    body, status = tap(world, "park", [{"n": 3}])
    assert status == 200 and not runs and body["cards"][0]["rows"][2]["state"] == "parked"
    (task,) = wl.load(world.shop)["items"]
    assert task["state"] == "todo" and task["from"]["session"] == world.s["id"]
    got = wl.start(world.shop, task["id"], "fix", world.s["id"])     # its Start in the WORK panel, any time later
    assert runs[0]["sent_by"] == "mystical:spinoff"
    assert store.parse_json(store.get_session(got["session_id"])["spun_from"])["session"] == world.s["id"]


def test_a_row_is_tapped_once_and_a_repeat_or_a_row_with_no_project_never_starts(world, runs):
    offer(world, ISSUES + [{"title": "Nowhere", "project": "stranger/thing"}])
    tap(world, "start", [{"n": 1}])
    body, status = tap(world, "start", [{"n": 1}])
    assert status == 400 and "already" in body["error"]
    body, status = tap(world, "start", [{"n": 4}])
    assert status == 400 and "project" in body["error"] and len(runs) == 1
    body, status = tap(world, "start", [{"n": 4, "project": "/shop"}])         # you picked one
    assert status == 200 and len(runs) == 2
    offer(world, [{"title": "Again", "project": "ainurdev/rivendell", "sources": [SENTRY]}])
    body, status = multi_api.post("spinoffs/start", {"session_id": world.s["id"], "card": "c2", "rows": [{"n": 1}]}, CHAT)
    assert status == 200 and len(runs) == 2 and body["cards"][1]["rows"][0]["repeat"]["task"] == "w1"   # passed by: it links there


def test_someone_elses_chat_cant_tap_and_the_switch_being_off_stops_it(world, runs):
    offer(world, ISSUES)
    assert tap(world, "start", [{"n": 1}], chat=999)[1] == 404
    assert multi_api.get("spinoffs", {"session": [world.s["id"]]}, 999)[1] == 404
    experimental.set_enabled(False)
    assert tap(world, "start", [{"n": 1}])[1] == 409 and not runs


def test_a_chain_across_repos_waits_and_starts_with_what_the_one_before_left(world, runs):
    from bridge import paths
    offer(world, [ISSUES[0], {"title": "Retry board sync on 5xx", "project": "shop", "flow": "build", "after": 1}])
    body, _ = tap(world, "start", [{"n": 1}, {"n": 2}])
    assert [r["state"] for r in body["cards"][0]["rows"]] == ["started", "waiting"] and len(runs) == 1
    first = wl.load(world.riv)["items"][0]
    turn = f"t{time.time_ns()}"     # one DB for every test on a worker: ids are unique
    store.start_turn(first["session_id"], turn, "fix it", None)
    store.append_event(first["session_id"], turn, {"type": "result", "result": "Fixed: applyCard skips a card with no list."})
    wl.after_turn(SimpleNamespace(store_session_id=first["session_id"]))    # a turn ends, its flow still going
    assert len(runs) == 1
    paths._cache[first["session_id"]]["end"] = 1                            # its flow's last step is done
    wl.after_turn(SimpleNamespace(store_session_id=first["session_id"]))
    assert len(runs) == 2
    later = runs[1]["prompt"]
    assert later.startswith("Retry board sync on 5xx") and "It follows “Board sync reads a card with no list” in rivendell" in later
    assert f"on branch {first['branch']}" in later and "Fixed: applyCard skips a card with no list." in later
    assert spinoffs.view(world.s["id"])["cards"][0]["rows"][1]["state"] == "started"


def test_the_chats_next_prompt_names_what_was_spun_off_once(world, runs):
    offer(world, ISSUES)
    tap(world, "start", [{"n": 1}])
    tap(world, "park", [{"n": 3}])
    line = spinoffs.pop_line(world.s["id"])
    assert "“Board sync reads a card with no list” in rivendell (fix, started)" in line
    assert "“Lesson plan 500” in shop (fix, parked on its work list)" in line and "don't do it here" in line
    assert spinoffs.pop_line(world.s["id"]) == ""


def _settled(w, n, timeout=10.0):
    end = time.time() + timeout
    while time.time() < end:
        row = spinoffs.view(w.s["id"])["cards"][0]["rows"][n - 1]
        if row["state"] != "cloning":
            return row
        time.sleep(0.05)
    raise AssertionError("still cloning")


def test_clone_and_start_clones_your_own_repo_then_starts_it_there(world, runs, monkeypatch):
    from bridge import newproject
    cloned = []

    def prepare(body):
        cloned.append(body["url"])
        return {"rel": "/reports-web", "cwd": _repo(world.base, "reports-web", body["url"] + ".git"), "notes": []}
    monkeypatch.setattr(newproject, "prepare", prepare)
    offer(world, [{"title": "Hydration mismatch", "project": "mhz/reports-web", "flow": "fix"}])
    body, status = tap(world, "start", [{"n": 1, "project": "clone"}])
    assert status == 200
    row = _settled(world, 1)
    assert cloned == ["https://github.com/mhz/reports-web"] and row["state"] == "started" and row["project"] == "/reports-web"
    assert store.get_session(row["session"])["project"] == "/reports-web"


def test_a_clone_is_refused_once_its_owner_isnt_yours_and_says_why(world, runs, monkeypatch):
    from bridge import newproject
    monkeypatch.setattr(newproject, "prepare", lambda body: pytest.fail("cloned a stranger's repo"))
    offer(world, [{"title": "Hydration mismatch", "project": "mhz/reports-web"}])
    monkeypatch.setattr(spinoffs, "_owners", lambda: {"ainurdev"})        # you left that org since
    tap(world, "start", [{"n": 1, "project": "clone"}])
    row = _settled(world, 1)
    assert row["state"] == "failed" and "your own GitHub accounts and orgs" in row["note"] and not runs
    assert tap(world, "park", [{"n": 1, "project": "clone"}])[1] == 400    # parking needs a checkout


def test_the_phones_start_all_leaves_repeats_and_clones_to_the_dashboard(world, runs, monkeypatch):
    from bridge import newproject
    monkeypatch.setattr(newproject, "prepare", lambda body: pytest.fail("the phone cloned"))
    wl.add(world.riv, [{"title": "Board sync null", "source": SENTRY}])
    offer(world, [{"title": "Board sync", "project": "ainurdev/rivendell", "sources": [SENTRY]},
                  {"title": "Hydration", "project": "mhz/reports-web"}, ISSUES[1], ISSUES[2], {"title": "Nowhere"}])
    assert spinoffs.start_all(world.s, "c1") == 2
    assert [r["state"] for r in spinoffs.view(world.s["id"])["cards"][0]["rows"]] == ["open", "open", "started", "started", "open"]
    with pytest.raises(spinoffs.Refused):
        spinoffs.start_all(world.s, "c1")


def test_the_line_rides_on_the_run_not_on_the_prompt_you_see(world, monkeypatch):
    from bridge import runner, titler
    offer(world, ISSUES)
    tap(world, "park", [{"n": 2}])
    ran = []
    monkeypatch.setattr(runner, "_run_streaming", lambda job, prompt, *a: ran.append(prompt))
    monkeypatch.setattr(runner, "_ensure_journal_thread", lambda: None)
    monkeypatch.setattr(runner, "_jobs", {})
    monkeypatch.setattr(titler, "kick", lambda *a, **k: None)
    runner.start_streaming_job(CHAT, "what's left?", [], session_id=world.s["id"], origin="dashboard")
    for _ in range(200):
        if ran:
            break
        time.sleep(0.01)
    runner.state.release_run(world.s["id"])
    assert ran[0].startswith("what's left?\n\n[mystical] Since your last turn the user spun off") and "Voucher lost on return" in ran[0]
    assert store.transcript(world.s["id"])["turns"][-1]["prompt"] == "what's left?"


def test_agents_are_told_to_offer_found_work_as_their_last_step():
    from bridge import prompt_pack, runner
    for text in (prompt_pack.SHOW, runner._EXPERIMENTAL_NOTE):
        assert "spin_off" in text and "last step" in text and "don't list them again" in text


# --- the phone ------------------------------------------------------------------------

def test_telegram_gets_one_line_under_the_reply_with_start_all_and_the_session(world, monkeypatch):
    import threading
    from bridge import state, telegram, tglive
    offer(world, ISSUES + [{"title": "Nowhere"}])
    assert spinoffs.phone(world.s["id"], "c1") == ("Spin-offs: 4 for 2 projects", 3)
    sent = []
    monkeypatch.setattr(telegram, "send", lambda chat, text, kb=None, *a, **k: sent.append((text, kb)) or {"message_id": 1})
    monkeypatch.setattr(state, "miniapp_url", "https://panel.example")
    job = SimpleNamespace(id="j1", store_session_id=world.s["id"], events=[{"type": "spinoffs", "card": "c1"}],
                          _lock=threading.Lock(), status="done", result="9 new issues across 2 projects.", interrupted=False,
                          started=time.time(), told=False)
    tglive._finish(job, CHAT, None, None)
    ((text, kb),) = sent
    assert text.startswith("9 new issues across 2 projects.\n\n⑂ Spin-offs: 4 for 2 projects\n\n— ")
    (start,), (panel,) = kb["inline_keyboard"]
    assert (start["text"], start["callback_data"]) == ("▶ Start all 3", f"so:{world.s['id']}:c1")
    assert panel["text"] == "Open session ↗" and world.s["id"] in panel["web_app"]["url"]


def test_start_all_from_telegram_is_yours_only_and_the_button_goes(world, runs, monkeypatch):
    from bridge import dispatch
    said, marks = [], []
    monkeypatch.setattr(dispatch, "answer_cb", lambda cid, text="": said.append(text))
    monkeypatch.setattr(dispatch, "edit_markup", lambda chat, mid, kb: marks.append(kb))
    offer(world, ISSUES)

    def press(by):
        n = len(said)
        dispatch.handle_callback({"id": "cb", "data": f"so:{world.s['id']}:c1", "from": {"id": by},
                                  "message": {"chat": {"id": CHAT}, "message_id": 7}})
        end = time.time() + 5
        while len(said) == n and time.time() < end:
            time.sleep(0.01)
    press(999)
    assert said == [""] and not runs and not marks                # someone else in a group: nothing
    press(CHAT)
    assert said[-1] == "Spun off 3: each in its own session." and len(runs) == 3
    press(CHAT)
    assert said[-1] == "Nothing on the card is left to start." and len(runs) == 3


# --- found in review -------------------------------------------------------------------

def test_a_project_named_by_its_key_or_folder_goes_there_not_to_the_first_one(world):
    offer(world, [{"title": "a", "project": "/ainur/rivendell"}, {"title": "b", "project": world.riv},
                  {"title": "c", "project": "/shop/"}, {"title": "d", "project": "/nowhere"}])
    assert [r["project"] for r in rows(world)] == ["/ainur/rivendell", "/ainur/rivendell", "/shop", ""]


def test_a_chain_after_a_repeat_waits_on_the_task_that_has_it(world, runs):
    wl.add(world.riv, [{"title": "Board sync null", "source": SENTRY}])
    offer(world, [{"title": "Board sync", "project": "ainurdev/rivendell", "sources": [SENTRY]},
                  {"title": "Retry on 5xx", "project": "shop", "flow": "build", "after": 1}])
    body, status = tap(world, "start", [{"n": 2}])
    assert status == 200 and not runs and body["cards"][0]["rows"][1]["state"] == "waiting"
    assert wl.load(world.shop)["items"][0]["after"] == {"root": world.riv, "id": "w1"}


def test_a_chain_after_a_row_being_cloned_waits_for_the_clone_and_the_phone_leaves_it(world, runs):
    offer(world, [{"title": "Hydration", "project": "mhz/reports-web"}, {"title": "Then this", "project": "shop", "after": 1}])
    body, status = tap(world, "start", [{"n": 1, "project": "clone"}, {"n": 2}])
    assert status == 400 and "item 1" in body["error"] and not runs
    with pytest.raises(spinoffs.Refused):        # nothing else the phone could start: its blocker is the dashboard's
        spinoffs.start_all(world.s, "c1")


def test_a_row_that_turned_into_a_repeat_since_the_offer_is_passed_by_and_links_there(world, runs):
    offer(world, ISSUES)
    wl.add(world.riv, [{"title": "Board sync null", "source": SENTRY}])     # another chat filed it meanwhile
    body, status = tap(world, "start", [{"n": 1}, {"n": 2}])
    assert status == 200 and len(runs) == 1
    first, second = body["cards"][0]["rows"][:2]
    assert first["repeat"]["task"] == "w1" and first["state"] == "open" and second["state"] == "started"


def test_a_clone_cut_off_by_a_restart_can_be_tried_again(world, runs):
    offer(world, [{"title": "Hydration", "project": "mhz/reports-web"}])
    spinoffs._mutate(world.s["id"], lambda d: d["cards"][0]["rows"][0].update(state="cloning", boot="an-earlier-bridge"))
    row = rows(world)[0]
    assert row["state"] == "failed" and "restart" in row["note"]


def test_the_phones_tap_needs_the_experimental_switch(world, runs, monkeypatch):
    from bridge import dispatch
    said = []
    monkeypatch.setattr(dispatch, "answer_cb", lambda cid, text="": said.append(text))
    monkeypatch.setattr(dispatch, "edit_markup", lambda *a: None)
    offer(world, ISSUES)
    experimental.set_enabled(False)
    dispatch._spinoff_callback({"id": "cb", "from": {"id": CHAT}}, CHAT, 7, f"so:{world.s['id']}:c1")
    assert not runs and "experimental" in said[0].lower()


def test_your_accounts_count_even_when_one_login_is_broken(monkeypatch):
    calls = {"auth": SimpleNamespace(returncode=1, stdout="github.com\n  ✓ Logged in to github.com account mhz (keyring)\n"
                                                         "  X Failed to log in to github.com account old-me (keyring)\n", stderr=""),
             "api": SimpleNamespace(returncode=0, stdout="AinurDev\nnationalerijschool\n", stderr="")}
    monkeypatch.setattr(spinoffs.subprocess, "run", lambda args, **kw: calls["auth" if args[1] == "auth" else "api"])
    monkeypatch.setattr(spinoffs, "_owners_cache", None)
    assert spinoffs._owners() == {"mhz", "old-me", "ainurdev", "nationalerijschool"}


def test_a_chat_with_no_cards_or_an_odd_id_gets_no_line():
    assert spinoffs.pop_line("f" * 32) == "" and spinoffs.pop_line("device:abc/../x") == ""
