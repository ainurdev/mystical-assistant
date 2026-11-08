"""Automations: what fires them, what they check, and what they run with."""
import os
import stat
import subprocess
import time

import pytest

from bridge import automations as au, config, experimental, multi_api, runner, store


class Job:
    def __init__(self):
        self.status, self.result, self.refusal = "running", "All good.\nmore", None


@pytest.fixture
def world(tmp_path, monkeypatch):
    base = tmp_path / "base"
    proj = base / "shop"
    proj.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(proj)], check=True)
    monkeypatch.setattr(config, "BASE_PATH", str(base))
    monkeypatch.setattr(au, "_path", lambda: str(tmp_path / "auto.json"))
    monkeypatch.setattr(au, "_mem", {})
    monkeypatch.setattr(au, "WATCH_S", 0.01)
    monkeypatch.setattr(experimental, "_path", lambda: str(tmp_path / "experimental.json"))
    monkeypatch.setattr(experimental, "_cache", None)
    monkeypatch.setattr(config, "TOKEN", "")
    experimental.set_enabled(True)
    store.init()
    runs = []

    def start(chat_id, prompt, images, **kw):
        job = Job()
        runs.append({"prompt": prompt, "job": job, **kw})
        return job
    monkeypatch.setattr(runner, "start_streaming_job", start)
    return {"proj": str(proj), "runs": runs}


def timer(**kw):
    return {"kind": "timer", "every": 10, "check": {"kind": "none"}, **kw}


def make(**kw):
    return au.save({"name": "Weather", "prompt": "Check it", "project": "/shop", "trigger": timer(), **kw})


def finish(world, i=-1):
    world["runs"][i]["job"].status = "done"
    deadline = time.time() + 3
    while time.time() < deadline and any(m.get("job") for m in au._mem.values()):
        time.sleep(0.02)


@pytest.mark.parametrize("change,word", [
    ({"name": " "}, "name"), ({"prompt": ""}, "should do"), ({"project": ""}, "project"), ({"project": "../.."}, "project"), ({"project": "/nope"}, "project"),
    ({"trigger": {"kind": "soon"}}, "when"), ({"trigger": timer(every=0)}, "1 minute"), ({"trigger": timer(check={"kind": "command"})}, "command"),
    ({"trigger": timer(check={"kind": "script"})}, "script"), ({"trigger": timer(check={"kind": "script", "script": "/etc/x.sh"})}, "outside"),
    ({"trigger": {"kind": "daily", "count": 0}}, "48"), ({"trigger": {"kind": "daily", "count": 2, "start": "18:00", "end": "09:00"}}, "after"),
    ({"trigger": {"kind": "daily", "count": 1, "start": "25:00"}}, "time like"),
    ({"trigger": {"kind": "once"}}, "date and time"), ({"trigger": {"kind": "once", "at": "soon"}}, "isn't a date"),
    ({"trigger": {"kind": "once", "at": "2030-02-30T09:00"}}, "isn't a date"), ({"trigger": {"kind": "once", "at": "2020-01-01T09:00"}}, "gone by"),
    ({"trigger": {"kind": "path", "paths": []}}, "watch"), ({"trigger": {"kind": "path", "paths": ["/etc"]}}, "outside"),
    ({"trigger": {"kind": "telegram", "command": "two words"}}, "one word"), ({"trigger": {"kind": "telegram", "command": "new"}}, "already"),
])
def test_refusals_say_what_to_change(world, change, word):
    with pytest.raises(au.Refused, match=word):
        make(**change)


def test_a_telegram_command_is_only_used_once(world):
    make(trigger={"kind": "telegram", "command": "standup"})
    with pytest.raises(au.Refused, match="already uses"):
        make(trigger={"kind": "telegram", "command": "/standup"})


def test_slots_are_spaced_through_the_day():
    assert au.slots({"start": "09:00", "end": "18:00", "count": 4}) == [540, 720, 900, 1080]
    assert au.slots({"start": "09:00", "end": "18:00", "count": 1}) == [540]


def _at(h, m=0):
    return au._local_day_start(time.time()) + h * 3600 + m * 60


def test_a_slot_is_due_once_and_a_sleep_catches_up_once():
    t = {"start": "09:00", "end": "18:00", "count": 4}
    assert au.due_slot(t, _at(8), _at(8, 59)) is None
    assert au.due_slot(t, _at(8), _at(9, 1)) == _at(9)
    assert au.due_slot(t, _at(9, 1), _at(9, 2)) is None
    assert au.due_slot(t, _at(8), _at(17)) == _at(15)         # three missed: only the newest


def test_a_slot_missed_long_ago_doesnt_run():
    t = {"start": "01:00", "end": "01:00", "count": 1}
    now = _at(23)
    assert au.due_slot(t, now - 86400 * 3, now) is None


def test_timer_without_a_check_fires_and_waits_for_its_next_turn(world):
    a = make()
    au.tick(time.time() + 5)
    assert not world["runs"]
    au.tick(time.time() + 601)
    deadline = time.time() + 3
    while time.time() < deadline and not world["runs"]:
        time.sleep(0.02)
    assert len(world["runs"]) == 1 and "Check it" in world["runs"][0]["prompt"] and "Nobody is watching" in world["runs"][0]["prompt"]
    assert world["runs"][0]["permission_mode"] == "acceptEdits"
    assert au._load()[0]["id"] == a["id"]
    au.tick(time.time() + 605)                                # not again while it runs, or so soon
    assert len(world["runs"]) == 1
    finish(world)


@pytest.mark.parametrize("command,go", [("exit 0", True), ("exit 1", False), ("echo false", False), ("echo true", True), ("echo hello", True), ("echo true; exit 2", False)])
def test_what_a_check_says(world, command, go):
    assert au.run_check({"project": "/shop", "trigger": timer(check={"kind": "command", "command": command})})["go"] is go


def test_a_script_runs_from_the_project_and_its_words_reach_the_agent(world):
    path = os.path.join(world["proj"], "check.sh")
    open(path, "w").write("#!/bin/sh\npwd\n")
    os.chmod(path, os.stat(path).st_mode | stat.S_IEXEC)
    a = make(trigger=timer(check={"kind": "script", "script": "check.sh"}))
    got = au.run_check(a)
    assert got["go"] and os.path.realpath(world["proj"]) in got["output"]
    au._check_then_fire(a)
    assert "The check printed:" in world["runs"][0]["prompt"]
    finish(world)


def test_a_script_not_written_yet_waits_and_says_so(world):
    a = make(trigger=timer(check={"kind": "script", "script": "later.sh"}))
    assert au.run_check(a)["broken"]
    au._check_then_fire(a)
    assert not world["runs"] and "isn't at later.sh" in au._load()[0]["note"]


def test_a_new_chat_each_run_or_one_that_continues(world):
    a = make()
    s1 = au.fire(a, "x")
    finish(world)
    s2 = au.fire(a, "x")
    finish(world)
    assert s1 != s2 and store.get_session(s1)["title"] == "⏱ Weather" and store.get_session(s1)["cwd"] == world["proj"]
    b = make(name="Same", chat="same")
    s3 = au.fire(next(x for x in au._load() if x["id"] == b["id"]), "x")
    finish(world)
    s4 = au.fire(next(x for x in au._load() if x["id"] == b["id"]), "x")
    finish(world)
    assert s3 == s4


def test_its_permission_mode_goes_on_the_run(world):
    a = make(mode="plan")
    au.fire(a, "x")
    assert world["runs"][0]["permission_mode"] == "plan"
    finish(world)
    assert make(mode="anything")["mode"] == "acceptEdits"


def test_a_path_listener_sees_changes_settle_once_and_not_its_own(world):
    f = os.path.join(world["proj"], "notes.md")
    open(f, "w").write("a")
    a = make(trigger={"kind": "path", "paths": ["notes.md"]})
    now = time.time()
    au.tick(now)                                              # the first look is the baseline
    au.tick(now + au.POLL_S + 1)
    assert not world["runs"]
    open(f, "w").write("changed a lot")
    au.tick(now + 2 * au.POLL_S + 2)
    assert not world["runs"]                                  # still settling
    au.tick(now + 3 * au.POLL_S + 3 + au.QUIET_S)
    assert len(world["runs"]) == 1 and "notes.md" in world["runs"][0]["prompt"]
    open(f, "w").write("the agent wrote here too")            # during its own run
    finish(world)
    t = now + 4 * au.POLL_S + 4 + au.QUIET_S
    au.tick(t)                                                # looks afresh
    au.tick(t + au.POLL_S + 1)
    au.tick(t + 2 * au.POLL_S + 2 + au.QUIET_S)
    assert len(world["runs"]) == 1 and a["enabled"]


def test_a_noisy_folder_is_capped_per_hour(world):
    os.makedirs(os.path.join(world["proj"], "src"))
    a = make(trigger={"kind": "path", "paths": ["src"]})
    rows = au._load()
    rows[0]["runs"] = [{"at": time.time(), "why": "", "session_id": "s", "status": "done"}] * au.PATH_RUNS_PER_HOUR
    au._save(rows)
    now = time.time()
    au._mem[a["id"]] = {"snapshot": {}, "changed": ["x"], "quiet": now - 60, "polled": 0}
    au._tick_path(au._load()[0], now)
    assert not world["runs"] and "Held" in au._load()[0]["note"]


def test_junk_folders_arent_watched(world):
    os.makedirs(os.path.join(world["proj"], "node_modules", "x"))
    open(os.path.join(world["proj"], "node_modules", "x", "a.js"), "w").write("x")
    open(os.path.join(world["proj"], "b.js"), "w").write("x")
    assert [os.path.basename(p) for p in au._snapshot(["."], world["proj"])] == ["b.js"]


def test_a_telegram_command_runs_with_what_you_wrote(world):
    make(trigger={"kind": "telegram", "command": "standup"})
    said = au.on_command(config.DASH_CHAT_ID, "/standup only the bakery")
    assert "running" in said and "only the bakery" in world["runs"][0]["prompt"]
    assert "already running" in au.on_command(config.DASH_CHAT_ID, "/standup")
    finish(world)
    assert au.on_command(config.DASH_CHAT_ID, "/other") is None and au.on_command(config.DASH_CHAT_ID, "hello") is None


def test_only_the_owner_can_fire_or_change_one(world):
    make(trigger={"kind": "telegram", "command": "standup"})
    assert au.on_command(999999, "/standup") is None and not world["runs"]
    assert multi_api.post("automations/toggle", {"id": "x"}, 999999)[1] == 403
    assert multi_api.get("automations", {}, 999999)[1] == 403


def test_off_stays_off_and_on_starts_from_now(world):
    a = make(enabled=False)
    au.tick(time.time() + 9999)
    assert not world["runs"]
    got = au.toggle(a["id"], True)
    assert got["enabled"] and got["last_check"] > time.time() - 5
    make_cmd = make(enabled=False, trigger={"kind": "telegram", "command": "off_one"})
    assert "switched off" in au.on_command(config.DASH_CHAT_ID, "/off_one") and make_cmd["id"]


def test_nothing_runs_with_the_switch_off(world):
    make()
    experimental.set_enabled(False)
    au.tick(time.time() + 9999)
    assert not world["runs"] and multi_api.post("automations/save", {}, config.DASH_CHAT_ID)[1] == 409
    assert au.on_command(config.DASH_CHAT_ID, "/x") is None


def test_an_agent_has_no_tool_to_make_one():
    from bridge import gateway_tools
    assert not [t for t in gateway_tools.HANDLED if "automation" in t]


def test_drafting_a_script_starts_a_chat_that_saves_when_told(world):
    got = au.write_script({"project": "/shop", "description": "Is AAPL down 3%?", "path": "scripts/check.sh"})
    prompt = world["runs"][0]["prompt"]
    assert got["session_id"] and "AAPL" in prompt and "Only when I say to save it" in prompt and os.path.join("scripts", "check.sh") in prompt
    with pytest.raises(au.Refused, match="outside"):
        au.write_script({"project": "/shop", "description": "x", "path": "/etc/x.sh"})


@pytest.fixture
def clock(monkeypatch):
    """Moves time.time itself, as save and toggle read the real clock."""
    real, shift = time.time, [0.0]
    monkeypatch.setattr(time, "time", lambda: real() + shift[0])

    def jump_to(when):
        shift[0] = when - real()
    return jump_to


def stamp(when):
    return time.strftime("%Y-%m-%dT%H:%M", time.localtime(when))


def once(hours=1.0, **kw):
    """A one-time automation due in some hours. Returns it and when it's due, to the minute it holds."""
    at = stamp(time.time() + hours * 3600)
    a = make(trigger={"kind": "once", "at": at}, **kw)
    return a, au.once_at(a["trigger"])


def row(a):
    return next(x for x in au._load() if x["id"] == a["id"])


def test_once_waits_runs_one_time_then_switches_itself_off_keeping_its_history(world, clock):
    a, due = once()
    assert a["enabled"] and a["next_at"] == due
    clock(due - 60)
    au.tick()
    assert not world["runs"]
    clock(due)
    au.tick()
    assert len(world["runs"]) == 1 and "one-time run" in world["runs"][0]["prompt"]
    got = au.public(row(a))
    assert not got["enabled"] and got["next_at"] is None and got["running"] and got["note"] == ""
    finish(world)
    clock(due + 600)
    au.tick()
    assert len(world["runs"]) == 1
    runs = row(a)["runs"]
    assert len(runs) == 1 and runs[0]["status"] == "done"


def test_once_asleep_at_its_time_runs_on_waking_within_the_catch_up(world, clock):
    a, due = once()
    au.tick(due + au.CATCH_UP_S)                              # the last moment that still counts
    assert len(world["runs"]) == 1 and not row(a)["enabled"]
    finish(world)
    au.tick(due + au.CATCH_UP_S + 5)
    assert len(world["runs"]) == 1


def test_once_asleep_past_the_catch_up_doesnt_run_and_says_why(world, clock):
    a, due = once()
    clock(due + au.CATCH_UP_S + 1)
    au.tick()
    got = row(a)
    assert not world["runs"] and not got["enabled"] and "didn't run" in got["note"] and "12 hours" in got["note"]
    au.tick()
    assert not world["runs"]


def test_once_run_now_doesnt_use_up_the_scheduled_run(world, clock):
    a, due = once()
    au.run_now(a["id"])
    finish(world)
    got = row(a)
    assert got["enabled"] and au.next_at(got) == due and not got.get("spent")
    clock(due + 1)                                            # even pressed after its time, before a tick sees it
    au.run_now(a["id"])
    finish(world)
    au.tick()
    assert len(world["runs"]) == 3 and "one-time run" in world["runs"][2]["prompt"]
    finish(world)


def test_once_waits_out_a_run_now_that_spans_its_time(world, clock):
    a, due = once()
    au.run_now(a["id"])
    clock(due + 60)
    au.tick()
    assert len(world["runs"]) == 1 and row(a)["enabled"]      # that run is still going
    finish(world)
    au.tick()
    assert len(world["runs"]) == 2
    finish(world)


def test_once_turned_back_on_after_firing_stays_off_until_given_a_later_time(world, clock):
    a, due = once()
    clock(due + 60)
    au.tick()
    finish(world)
    got = au.toggle(a["id"], True)
    assert not got["enabled"] and "gone by" in got["note"] and got["next_at"] is None
    au.tick()
    assert len(world["runs"]) == 1

    later = stamp(time.time() + 3600)
    got = make(id=a["id"], trigger={"kind": "once", "at": later})
    assert got["enabled"] and got["note"] == "" and got["next_at"] == au.once_at(got["trigger"])
    au.tick()
    assert len(world["runs"]) == 1                            # not yet
    clock(got["next_at"])
    au.tick()
    assert len(world["runs"]) == 2 and not row(a)["enabled"]
    finish(world)


def test_once_whose_time_went_by_while_off_doesnt_run_when_turned_on(world, clock):
    a, due = once()
    au.toggle(a["id"], False)
    clock(due + 60)
    au.tick()
    got = au.toggle(a["id"], True)
    au.tick()
    assert not world["runs"] and not got["enabled"] and "gone by" in got["note"]


def test_once_switched_off_by_you_stays_off_when_only_rescheduled(world, clock):
    a, due = once()
    au.toggle(a["id"], False)
    got = make(id=a["id"], trigger={"kind": "once", "at": stamp(due + 7200)})
    assert not got["enabled"]
    assert au.toggle(a["id"], True)["next_at"] == au.once_at(got["trigger"])


def test_once_can_be_edited_after_it_ran_without_running_again(world, clock):
    a, due = once()
    clock(due)
    au.tick()
    finish(world)
    clock(due + 60)
    same = row(a)["trigger"]
    got = make(id=a["id"], trigger=same, name="Renamed")
    au.tick()
    assert got["name"] == "Renamed" and not got["enabled"] and len(world["runs"]) == 1
    with pytest.raises(au.Refused, match="gone by"):
        make(id=a["id"], trigger={"kind": "once", "at": stamp(due - 3600)})
    assert row(a)["trigger"] == same


def test_once_that_couldnt_start_says_so_and_isnt_retried(world, clock, monkeypatch):
    a, due = once()
    monkeypatch.setattr(runner, "start_streaming_job", lambda *x, **k: None)
    clock(due)
    au.tick()
    got = row(a)
    assert not got["enabled"] and "missed its run" in got["note"] and "busy" in got["note"] and not got["runs"]
    au.tick()
    assert "It missed its run" in row(a)["note"] and row(a)["note"].count("missed") == 1


def test_once_is_local_time(monkeypatch):
    t = {"at": "2030-06-01T09:00"}
    try:
        monkeypatch.setenv("TZ", "UTC")
        time.tzset()
        utc = au.once_at(t)
        monkeypatch.setenv("TZ", "Asia/Tokyo")
        time.tzset()
        assert utc - au.once_at(t) == 9 * 3600
    finally:
        monkeypatch.undo()
        time.tzset()


def test_a_finished_once_turned_into_a_timer_is_a_clean_timer(world, clock):
    a, due = once()
    clock(due)
    au.tick()
    finish(world)
    got = make(id=a["id"], trigger=timer())
    assert "spent" not in got and not got["enabled"]
    assert au.toggle(a["id"], True)["enabled"]
