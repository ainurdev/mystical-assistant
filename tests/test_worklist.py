"""The work list: what agents and the sidebar can do to it, and what they can't."""
import os
import subprocess

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


def test_an_agent_cant_claim_a_runs_states_or_edit_a_live_one(world):
    r = world["root"]
    item = wl.add(r, [{"title": "x"}])[0]
    with pytest.raises(wl.Refused, match="by hand"):
        wl.update(r, [{"id": item["id"], "state": "doing"}])

    def live(data):
        data["items"][0]["state"] = "doing"
    wl.mutate(r, live)
    with pytest.raises(wl.Refused, match="in a run"):
        wl.update(r, [{"id": item["id"], "state": "done"}])
    with pytest.raises(wl.Refused, match="in a run"):
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


def test_done_is_grouped_by_the_chat_that_asks(world):
    r = world["root"]
    a, b = wl.add(r, [{"title": "a"}, {"title": "b"}])
    wl.update(r, [{"id": a["id"], "state": "done"}], "chat-1")
    wl.update(r, [{"id": b["id"], "state": "done"}], "chat-2")
    groups = {i["id"]: i["group"] for i in wl.view(r, "chat-1")["items"]}
    assert groups == {a["id"]: "here", b["id"]: "done"}


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
