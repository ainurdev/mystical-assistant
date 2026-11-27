"""The work list: what agents and the sidebar can do to it, and what they can't."""
import os
import subprocess

from types import SimpleNamespace

import pytest

from bridge import config, experimental, gateway, multi_api, store, worklist as wl

CHAT = config.DASH_CHAT_ID


@pytest.fixture
def world(tmp_path, monkeypatch):
    base = tmp_path / "base"
    proj = base / "shop"
    proj.mkdir(parents=True)
    subprocess.run(["git", "init", "-q", str(proj)], check=True)
    monkeypatch.setattr(config, "BASE_PATH", str(base))
    monkeypatch.setattr(experimental, "_path", lambda: str(tmp_path / "experimental.json"))
    monkeypatch.setattr(experimental, "_cache", None)
    experimental.set_enabled(True)
    store.init()
    s = store.create_session(CHAT, "/shop", cwd=str(proj))
    return {"root": os.path.realpath(str(proj)), "session": s}


def titles(root):
    return [i["title"] for i in wl.load(root)["items"]]


def test_ids_stay_unique_after_a_removal(world):
    r = world["root"]
    a, b = wl.add(r, [{"title": "one"}, {"title": "two"}])
    wl.remove(r, [b["id"]])
    assert wl.add(r, [{"title": "three"}])[0]["id"] not in (a["id"], b["id"])


def test_it_needs_a_title_and_a_real_link(world):
    r = world["root"]
    with pytest.raises(wl.Refused):
        wl.add(r, [{"title": "  "}])
    item = wl.add(r, [{"title": "x", "source": {"kind": "jira", "ref": "A-1", "url": "javascript:alert(1)"}}])[0]
    assert item["source"] == {"kind": "jira", "ref": "A-1", "url": ""}


def test_the_list_lives_at_the_main_checkout_from_a_worktree(world, tmp_path):
    r = world["root"]
    subprocess.run(["git", "-C", r, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"], check=True)
    other = str(tmp_path / "base" / "shop-wt")
    subprocess.run(["git", "-C", r, "worktree", "add", "-q", "-b", "w", other], check=True)
    assert wl.root_of(other) == r


def test_an_agent_cant_claim_a_flows_states_or_edit_a_live_one(world):
    r = world["root"]
    item = wl.add(r, [{"title": "x"}])[0]
    with pytest.raises(wl.Refused, match="by hand"):
        wl.update(r, [{"id": item["id"], "state": "doing"}])

    def live(data):
        data["items"][0]["state"] = "doing"
    wl.mutate(r, live)
    with pytest.raises(wl.Refused, match="in its session"):
        wl.update(r, [{"id": item["id"], "state": "done"}])
    with pytest.raises(wl.Refused, match="in its session"):
        wl.remove(r, [item["id"]])


def test_replace_keeps_state_by_id_or_ref_and_keeps_the_record(world):
    r = world["root"]
    a, b, c, d = wl.add(r, [{"title": "a", "source": {"ref": "A-1"}}, {"title": "b"}, {"title": "c"}, {"title": "d"}])
    wl.update(r, [{"id": a["id"], "state": "blocked", "note": "waiting"}, {"id": d["id"], "state": "done"}])
    got = wl.replace(r, [{"title": "a renamed", "source": {"ref": "A-1"}}, {"id": b["id"], "title": "b"}, {"title": "new"}])
    assert got == {"added": 1, "kept": 2, "removed": 1}
    items = {i["title"]: i for i in wl.load(r)["items"]}
    assert items["a renamed"]["state"] == "blocked" and items["a renamed"]["id"] == a["id"]
    assert "c" not in items and items["d"]["state"] == "done"
    wl.replace(r, [], clear_done=True)
    assert titles(r) == []


def test_removing_an_item_clears_it_from_dependencies(world):
    r = world["root"]
    a = wl.add(r, [{"title": "a"}])[0]
    b = wl.add(r, [{"title": "b", "depends_on": [a["id"], "nope"]}])[0]
    assert b["depends_on"] == [a["id"]]
    wl.remove(r, [a["id"]])
    assert wl.load(r)["items"][0]["depends_on"] == []


def test_items_group_as_the_panel_draws_them(world):
    r = world["root"]
    a, b, c = wl.add(r, [{"title": "a"}, {"title": "b"}, {"title": "c"}])
    wl.update(r, [{"id": a["id"], "state": "done"}, {"id": b["id"], "state": "blocked"}])
    groups = {i["id"]: i["group"] for i in wl.view(r)["items"]}
    assert groups == {a["id"]: "done", b["id"]: "needs", c["id"]: "next"}


# --- a task starts a flow ------------------------------------------------------

@pytest.fixture
def started(world, monkeypatch):
    """Runs and flows faked: each start is recorded, and its flow recorded as start_flow would."""
    from bridge import paths, runner
    r = world["root"]
    subprocess.run(["git", "-C", r, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "x"], check=True)
    monkeypatch.setattr(paths, "_file", lambda: os.path.join(os.path.dirname(r), "flows.json"))
    paths._cache.clear()
    runs = []

    def start(chat_id, prompt, images, project=None, session_id=None, origin=None, flow=None, flow_by=None, **kw):
        runs.append({"sid": session_id, "prompt": prompt, "project": project, "flow": flow})
        paths.set_path(session_id, flow, "you picked", "you")
        return SimpleNamespace(refusal=None)
    monkeypatch.setattr(runner, "start_streaming_job", start)
    return runs


def test_start_opens_the_tasks_own_session_on_its_flow(world, started):
    from bridge import paths
    r = world["root"]
    item = wl.add(r, [{"title": "Bell toast shows twice", "detail": "on answer"}])[0]
    got = wl.start(r, item["id"], "build", world["session"]["id"])
    assert got["state"] == "doing" and got["branch"] == "feat/bell-toast-shows-twice"
    (run,) = started
    s = store.get_session(got["session_id"])
    assert (run["sid"], run["flow"], s["origin"], s["title"]) == (got["session_id"], "build", "work", "Bell toast shows twice")
    assert run["prompt"].startswith("Bell toast shows twice\n\non answer") and item["id"] in run["prompt"]
    assert paths.get(got["session_id"])["branch"] == "feat/bell-toast-shows-twice"
    with pytest.raises(wl.Refused, match="only a task not started"):
        wl.start(r, item["id"], "build", world["session"]["id"])
    with pytest.raises(wl.Refused, match="build, fix or design"):
        wl.start(r, wl.add(r, [{"title": "y"}])[0]["id"], "ship", world["session"]["id"])


def test_a_tasks_session_files_under_its_project_and_takes_its_profile(world, started, monkeypatch):
    from bridge import profiles
    asked = []
    monkeypatch.setattr(profiles, "claude_default", lambda project: asked.append(project) or None)
    r = world["root"]
    got = wl.start(r, wl.add(r, [{"title": "x"}])[0]["id"], "build", world["session"]["id"])
    assert store.get_session(got["session_id"])["project"] == "/shop" and asked == ["/shop"]


def test_a_fix_starts_on_its_own_branch_never_the_default_one(world, started):
    r = world["root"]
    got = wl.start(r, wl.add(r, [{"title": "Login loops"}])[0]["id"], "fix", world["session"]["id"])
    assert got["branch"] == "fix/login-loops" and started[0]["project"] != r
    out = subprocess.run(["git", "-C", started[0]["project"], "rev-parse", "--abbrev-ref", "HEAD"], capture_output=True, text=True)
    assert out.stdout.strip() == "fix/login-loops"


def test_a_started_tasks_state_follows_its_flow(world, started, monkeypatch):
    from bridge import paths, tickets
    r = world["root"]
    got = wl.start(r, wl.add(r, [{"title": "x"}])[0]["id"], "build", world["session"]["id"])
    sets = {}
    monkeypatch.setattr(tickets, "summary_for", lambda sid: sets.get(sid))
    live = lambda: wl.view(r)["items"][0]  # noqa: E731
    assert (live()["state"], live()["now"]) == ("doing", "Grilling the plan")
    sets[got["session_id"]] = {"status": "approve", "tickets": {"01": {"title": "a"}, "02": {"title": "b"}}}
    assert (live()["group"], live()["now"]) == ("needs", "2 parts wait for your approval")
    sets[got["session_id"]] = {"status": "building", "merge_session": "",
                               "tickets": {"01": {"title": "a", "status": "done", "session_id": "p1"},
                                           "02": {"title": "b", "status": "running", "session_id": "p2"}}}
    i = live()
    assert (i["state"], i["now"], [p["n"] for p in i["parts"]], i["sessions"]) == ("doing", "Building #2", ["1", "2"], [got["session_id"], "p1", "p2"])
    sets[got["session_id"]]["status"] = "merging"
    assert live()["group"] == "building" and live()["state"] == "review"
    assert wl.load(r)["items"][0]["state"] == "doing"       # read live; written at a turn's end
    paths._cache[got["session_id"]]["end"] = 1                # the flow's last step is done
    wl.after_turn(SimpleNamespace(store_session_id=world["session"]["id"]))   # not a task's session: nothing read
    assert wl.load(r)["items"][0]["state"] == "doing"
    wl.after_turn(SimpleNamespace(store_session_id=got["session_id"]))
    assert wl.load(r)["items"][0]["state"] == "done"


def test_a_task_after_another_starts_only_once_armed_and_its_blocker_is_done(world, started):
    r = world["root"]
    a = wl.add(r, [{"title": "a"}])[0]
    b, c = wl.add(r, [{"title": "b", "depends_on": [a["id"]]}, {"title": "c", "depends_on": [a["id"]]}])
    got = wl.start(r, b["id"], "design", world["session"]["id"])
    assert got["state"] == "todo" and got["armed"] and not started
    wl.sync(r)
    assert not started
    multi_api.post("worklist/update", {"session_id": world["session"]["id"], "items": [{"id": a["id"], "state": "done"}]}, CHAT)
    items = {i["id"]: i for i in wl.load(r)["items"]}            # marked done by hand: what waited starts
    assert [x["flow"] for x in started] == ["design"] and items[b["id"]]["state"] == "doing"
    assert items[c["id"]]["state"] == "todo"                  # an agent's dependency starts nothing


def test_a_task_waiting_on_another_starts_at_its_merge_not_its_retro(world, started, monkeypatch):
    from bridge import tickets
    r = world["root"]
    a = wl.start(r, wl.add(r, [{"title": "a"}])[0]["id"], "build", world["session"]["id"])
    b = wl.add(r, [{"title": "b", "depends_on": [a["id"]]}])[0]
    wl.start(r, b["id"], "build", world["session"]["id"])
    monkeypatch.setattr(tickets, "summary_for", lambda sid: {"status": "merged", "tickets": {}} if sid == a["session_id"] else None)
    wl.sync(r)
    assert len(started) == 2 and wl.load(r)["items"][1]["state"] == "doing"


def test_a_fix_on_its_review_step_is_in_review(world, started):
    from bridge import paths
    r = world["root"]
    got = wl.start(r, wl.add(r, [{"title": "Login loops"}])[0]["id"], "fix", world["session"]["id"])
    paths.mark_done(got["session_id"], "diagnose")
    assert (wl.view(r)["items"][0]["state"], wl.view(r)["items"][0]["now"]) == ("review", "Reviewing")


def test_a_task_that_cant_start_goes_back_with_why(world, started, monkeypatch):
    from bridge import runner
    r = world["root"]
    monkeypatch.setattr(runner, "start_streaming_job", lambda *a, **kw: None)
    item = wl.add(r, [{"title": "x"}])[0]
    got = wl.start(r, item["id"], "build", world["session"]["id"])
    assert got["note"].startswith("Didn't start") and got["session_id"]


def test_a_chats_agent_has_the_tool_and_a_helper_doesnt(world):
    s = world["session"]
    assert "work_list" in gateway.tool_names(s)
    assert "work_list" not in gateway.tool_names({**s, "parent_session": "x"})


def test_the_tool_fills_and_reads_the_list(world):
    s = world["session"]
    out = wl.tool(s, {"action": "add", "items": [{"title": "Fix login", "source": {"kind": "rivendell", "ref": "MA-12"}}]})
    assert "w1" in out and "Fix login" in out and "MA-12" in out
    assert "Fix login" in wl.tool(s, {"action": "read"})
    with pytest.raises(wl.Refused):
        wl.tool(s, {"action": "explode"})


def test_routes_are_the_same_for_both_apps(world):
    s = world["session"]
    body, status = multi_api.post("worklist/add", {"session_id": s["id"], "items": [{"title": "x"}]}, CHAT)
    assert status == 200 and body["items"][0]["group"] == "next"
    body, status = multi_api.post("worklist/start", {"session_id": s["id"], "id": "w1", "kind": "nope"}, CHAT)
    assert status == 400 and "build, fix or design" in body["error"]
    body, status = multi_api.get("worklist", {"session": [s["id"]]}, CHAT)
    assert status == 200 and body["items"][0]["title"] == "x"
    assert multi_api.post("worklist/add", {"session_id": s["id"], "items": []}, CHAT)[1] == 400


def test_someone_elses_chat_gets_nothing(world):
    s = world["session"]
    assert multi_api.get("worklist", {"session": [s["id"]]}, 999)[1] == 404
    assert multi_api.post("worklist/add", {"session_id": s["id"], "items": [{"title": "x"}]}, 999)[1] == 400


def test_the_switch_being_off_stops_it(world):
    experimental.set_enabled(False)
    assert multi_api.get("worklist", {}, CHAT)[1] == 409
    assert multi_api.post("worklist/add", {}, CHAT)[1] == 409


def test_the_panel_cant_clear_the_file(world):
    from bridge import mystical_dir
    wl.add(world["root"], [{"title": "x"}])
    with pytest.raises(ValueError):
        mystical_dir.delete(world["root"], "worklist.json")
