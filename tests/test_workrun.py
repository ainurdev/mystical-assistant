"""A run on the work list, against real git: where code goes, and what stops it."""
import os
import subprocess
import threading

import pytest

from bridge import channel, config, experimental, gateway, multi_api, queue_manager, runner, store, worklist as wl, workrun as wr
from bridge import dispatch

CHAT = config.DASH_CHAT_ID


def git(cwd, *args):
    return subprocess.run(["git", "-C", cwd, *args], check=True, capture_output=True, text=True).stdout.strip()


class Job:
    def __init__(self, sid=None, status="done", interrupted=False, result="Did it."):
        self.status, self.interrupted, self.result, self.refusal = status, interrupted, result, None
        self.store_session_id, self.error_msg, self.texts = sid, "", []


@pytest.fixture
def world(tmp_path, monkeypatch):
    base = tmp_path / "base"
    proj = base / "shop"
    proj.mkdir(parents=True)
    p = str(proj)
    subprocess.run(["git", "init", "-q", "-b", "main", p], check=True)
    git(p, "config", "user.name", "T")
    git(p, "config", "user.email", "t@t")
    (proj / ".gitignore").write_text("node_modules/\n.env\n")
    (proj / "a.txt").write_text("one\n")
    git(p, "add", "-A")
    git(p, "commit", "-qm", "first")
    monkeypatch.setattr(config, "BASE_PATH", str(base))
    monkeypatch.setattr(experimental, "_path", lambda: str(tmp_path / "experimental.json"))
    monkeypatch.setattr(experimental, "_cache", None)
    experimental.set_enabled(True)
    store.init()
    s = store.create_session(CHAT, "/shop", cwd=p, permission_mode="acceptEdits")
    started, said, live = [], [], set()

    def start_job(chat_id, prompt, images, **kw):
        started.append({"prompt": prompt, **kw})
        return Job()
    monkeypatch.setattr(runner, "start_streaming_job", start_job)
    monkeypatch.setattr(runner, "live_job", lambda sid: Job(sid) if sid in live else None)
    monkeypatch.setattr(runner, "_notify", lambda *a, **k: said.append(("ping", a, k)))
    monkeypatch.setattr(queue_manager, "enqueue", lambda sid, **kw: said.append(("queued", sid, kw["text"])))
    return {"p": p, "root": os.path.realpath(p), "session": s, "started": started, "said": said, "live": live}


def chat(world):
    return store.get_session(world["session"]["id"])


def begin(world, titles=("first", "second"), **kw):
    wl.add(world["root"], [{"title": t} for t in titles])
    return wr.start(chat(world), None, **kw)


def call(world, **a):
    return wr.tool(chat(world), a)


def item(world, iid):
    return next(i for i in wl.load(world["root"])["items"] if i["id"] == iid)


def copy_of(world, iid):
    return store.parse_member(store.get_session(item(world, iid)["session_id"])["member"])["copy"]


def report(world, iid, state="done"):
    s = store.get_session(item(world, iid)["session_id"])
    channel._helper_turn_ended(Job(s["id"], status="error" if state == "failed" else "done", interrupted=state == "stopped"), s, chat(world))


def work(world, iid, name, text, commit=False):
    c = copy_of(world, iid)
    with open(os.path.join(c["path"], name), "w") as f:
        f.write(text)
    if commit:
        git(c["path"], "add", "-A")
        git(c["path"], "commit", "-qm", "helper's own commit")


def test_only_the_user_can_start_one_and_an_agent_cant(world):
    wl.add(world["root"], [{"title": "x"}])
    with pytest.raises(wl.Refused, match="Only the user"):
        call(world, action="status")
    with pytest.raises(wl.Refused):
        call(world, action="start_item", id="w1")
    assert wl.active_run(wl.load(world["root"])) is None


def test_the_tools_reach_a_manager_through_the_gateway(world):
    assert {"work_list", "work_run"} <= gateway.tool_names(chat(world))
    assert "work_run" not in gateway.tool_names({**chat(world), "parent_session": "x"})


def test_refuses_what_it_cant_do(world):
    with pytest.raises(wl.Refused, match="nothing up next"):
        wr.start(chat(world), None)
    wl.add(world["root"], [{"title": "x"}])
    store.set_session_field(world["session"]["id"], "permission_mode", "plan")
    with pytest.raises(wl.Refused, match="read only"):
        wr.start(chat(world), None)
    store.set_session_field(world["session"]["id"], "permission_mode", "acceptEdits")
    channel.set_config(chat(world), {"helpers": "off"})
    with pytest.raises(wl.Refused, match="switched off"):
        wr.start(chat(world), None)
    channel.set_config(chat(world), {"helpers": "ask"})
    begin(world, titles=("y",))
    wl.add(world["root"], [{"title": "z"}])
    with pytest.raises(wl.Refused, match="already going"):
        wr.start(chat(world), None)


def test_not_a_git_repo_refuses(world, tmp_path):
    plain = tmp_path / "base" / "plain"
    plain.mkdir()
    s = store.create_session(CHAT, "/plain", cwd=str(plain))
    wl.add(str(plain), [{"title": "x"}])
    with pytest.raises(wl.Refused, match="git repository"):
        wr.start(s, None)


def test_the_full_path_leaves_your_branch_alone_until_you_merge(world):
    before = git(world["p"], "rev-parse", "HEAD")
    run = begin(world)
    assert any("manage it" in x[2] for x in world["said"] if x[0] == "queued")
    assert run["branch"] in git(world["p"], "branch", "--list", run["branch"])
    call(world, action="start_item", id="w1")
    assert item(world, "w1")["state"] == "doing"
    work(world, "w1", "b.txt", "from w1\n")
    report(world, "w1")
    assert item(world, "w1")["state"] == "review"
    assert "b.txt" in call(world, action="review_item", id="w1")
    assert "merged" in call(world, action="merge_item", id="w1")
    assert item(world, "w1")["state"] == "done" and item(world, "w1")["commit"]
    assert not os.path.exists(os.path.join(world["p"], "b.txt"))
    assert git(world["p"], "rev-parse", "HEAD") == before

    # The next item starts from the run branch, so it sees the first one's work.
    call(world, action="start_item", id="w2")
    assert os.path.exists(os.path.join(copy_of(world, "w2")["path"], "b.txt"))
    work(world, "w2", "c.txt", "from w2\n", commit=True)
    report(world, "w2")
    call(world, action="merge_item", id="w2")
    log = git(run["path"], "log", "--first-parent", "--format=%s", f"{run['base']}..HEAD").splitlines()
    assert log == ["second", "first"]
    assert "Claude" not in git(run["path"], "log", "--format=%B", f"{run['base']}..HEAD")

    call(world, action="finish", summary="All in.")
    data = wl.load(world["root"])["runs"][0]
    assert data["state"] == "finished"
    with pytest.raises(wl.Refused, match="Only the user"):
        call(world, action="status")
    assert git(world["p"], "rev-parse", "HEAD") == before

    body, status = multi_api.post("worklist/run/land", {"session_id": chat(world)["id"], "run": run["id"]}, CHAT)
    assert status == 200 and body["runs"] == []
    assert os.path.exists(os.path.join(world["p"], "b.txt")) and os.path.exists(os.path.join(world["p"], "c.txt"))
    assert not os.path.isdir(run["path"])
    assert run["branch"] not in git(world["p"], "branch", "--list")


def test_uncommitted_work_stays_out_and_is_mentioned(world):
    with open(os.path.join(world["p"], "a.txt"), "a") as f:
        f.write("mine\n")
    run = begin(world, titles=("x",))
    assert "uncommitted" in next(x[2] for x in world["said"] if x[0] == "queued")
    with open(os.path.join(run["path"], "a.txt")) as f:
        assert "mine" not in f.read()
    with open(os.path.join(world["p"], "a.txt")) as f:
        assert "mine" in f.read()


def test_a_dependency_and_the_limit_hold(world):
    r = world["root"]
    a, b, c = wl.add(r, [{"title": "a"}, {"title": "b"}, {"title": "c"}])
    wl.update(r, [{"id": b["id"], "depends_on": [a["id"]]}])
    wr.start(chat(world), None, parallel=1)
    with pytest.raises(wl.Refused, match="waits for"):
        call(world, action="start_item", id=b["id"])
    call(world, action="start_item", id=a["id"])
    with pytest.raises(wl.Refused, match="the most this run allows"):
        call(world, action="start_item", id=c["id"])
    assert item(world, c["id"])["state"] == "todo"


def test_side_by_side_calls_cant_pass_the_limit(world):
    wl.add(world["root"], [{"title": t} for t in "abcd"])
    wr.start(chat(world), None, parallel=2)
    got = []

    def go(iid):
        try:
            got.append(call(world, action="start_item", id=iid))
        except wl.Refused as e:
            got.append(e)
    ts = [threading.Thread(target=go, args=(f"w{n}",)) for n in range(1, 5)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert sum(1 for i in wl.load(world["root"])["items"] if i["state"] == "doing") == 2


def test_a_conflict_leaves_the_run_branch_clean_and_goes_back_to_the_helper(world):
    run = begin(world)
    call(world, action="start_item", id="w1")
    call(world, action="start_item", id="w2")
    work(world, "w1", "a.txt", "w1 wins\n")
    work(world, "w2", "a.txt", "w2 wins\n")
    report(world, "w1")
    report(world, "w2")
    call(world, action="merge_item", id="w1")
    head = git(run["path"], "rev-parse", "HEAD")
    out = call(world, action="merge_item", id="w2")
    assert "a.txt" in out and "send_back" in out
    assert git(run["path"], "rev-parse", "HEAD") == head
    assert git(run["path"], "status", "--porcelain") in ("",) or "UU" not in git(run["path"], "status", "--porcelain")
    assert item(world, "w2")["state"] == "review"

    call(world, action="send_back", id="w2", text=f"Merge {run['branch']} and resolve a.txt")
    assert item(world, "w2")["state"] == "doing"
    c = copy_of(world, "w2")
    subprocess.run(["git", "-C", c["path"], "merge", run["branch"]], capture_output=True)
    with open(os.path.join(c["path"], "a.txt"), "w") as f:
        f.write("both\n")
    git(c["path"], "add", "-A")
    git(c["path"], "commit", "-qm", "resolved")
    report(world, "w2")
    assert "merged" in call(world, action="merge_item", id="w2")
    with open(os.path.join(run["path"], "a.txt")) as f:
        assert f.read() == "both\n"


def test_linked_dependencies_never_reach_the_run_branch(world):
    nm = os.path.join(world["p"], "node_modules")
    os.makedirs(nm)
    run = begin(world, titles=("x",))
    assert os.path.islink(os.path.join(run["path"], "node_modules"))
    call(world, action="start_item", id="w1")
    assert os.path.islink(os.path.join(copy_of(world, "w1")["path"], "node_modules"))
    work(world, "w1", "b.txt", "x\n")
    report(world, "w1")
    assert "node_modules" not in call(world, action="review_item", id="w1")
    call(world, action="merge_item", id="w1")
    assert "node_modules" not in git(run["path"], "ls-tree", "-r", "--name-only", "HEAD")


def test_a_failed_helper_blocks_its_item_and_the_rest_go_on(world):
    begin(world)
    call(world, action="start_item", id="w1")
    report(world, "w1", state="failed")
    assert item(world, "w1")["state"] == "blocked"
    call(world, action="start_item", id="w2")
    assert item(world, "w2")["state"] == "doing"


def test_blocking_pings_you(world):
    begin(world)
    assert "blocked" in call(world, action="block_item", id="w1", text="Which API key?")
    assert item(world, "w1")["note"] == "Which API key?"
    assert any(x[0] == "ping" for x in world["said"])


def test_restart_drops_the_copy_and_puts_it_back(world):
    begin(world)
    call(world, action="start_item", id="w1")
    path = copy_of(world, "w1")["path"]
    report(world, "w1")
    call(world, action="restart_item", id="w1")
    assert not os.path.isdir(path) and item(world, "w1")["state"] == "todo" and "session_id" not in item(world, "w1")


def test_the_usual_helper_merge_cant_bypass_the_run(world):
    begin(world)
    call(world, action="start_item", id="w1")
    name = item(world, "w1")["helper"]
    report(world, "w1")
    assert "work_run" in channel.merge(chat(world), name)
    assert "work_run" in channel.discard(chat(world), name)
    assert item(world, "w1")["state"] == "review"


def test_a_stuck_manager_is_nudged_then_paused_and_progress_resets_it(world):
    run = begin(world)
    def nudges():
        return [x for x in world["said"] if x[0] == "queued" and "nothing will wake you" in x[2]]
    job = Job(chat(world)["id"])
    for n in range(wr.NUDGES):
        wr.manager_ended(job, chat(world))
        assert len(nudges()) == n + 1
    call(world, action="start_item", id="w1")
    report(world, "w1")
    assert wl.load(world["root"])["runs"][0]["nudges"] == 0
    for _ in range(wr.NUDGES + 1):
        wr.manager_ended(job, chat(world))
    assert wl.load(world["root"])["runs"][0]["state"] == "paused"
    assert any(x[0] == "ping" for x in world["said"])
    assert run["id"]


def test_no_nudge_while_a_helper_runs_or_after_you_stop_it(world):
    begin(world)
    call(world, action="start_item", id="w1")
    world["live"].add(item(world, "w1")["session_id"])
    wr.manager_ended(Job(chat(world)["id"]), chat(world))
    wr.manager_ended(Job(chat(world)["id"], interrupted=True), chat(world))
    assert wl.load(world["root"])["runs"][0]["nudges"] == 0


def test_pausing_stops_new_items_and_resume_carries_on(world):
    run = begin(world)
    body, status = multi_api.post("worklist/run/pause", {"session_id": chat(world)["id"], "run": run["id"]}, CHAT)
    assert status == 200 and body["runs"][0]["state"] == "paused"
    with pytest.raises(wl.Refused, match="paused"):
        call(world, action="start_item", id="w1")
    assert multi_api.post("worklist/run/resume", {"session_id": chat(world)["id"], "run": run["id"]}, CHAT)[1] == 200
    call(world, action="start_item", id="w1")


def test_another_chat_can_take_over(world):
    run = begin(world)
    call(world, action="start_item", id="w1")
    report(world, "w1")
    multi_api.post("worklist/run/pause", {"session_id": chat(world)["id"], "run": run["id"]}, CHAT)
    other = store.create_session(CHAT, "/shop", cwd=world["p"], permission_mode="acceptEdits")
    assert multi_api.post("worklist/run/resume", {"session_id": other["id"], "run": run["id"]}, CHAT)[1] == 200
    assert store.parse_json(chat(world).get("chat_config")).get("_work") is None
    helper = store.get_session(item(world, "w1")["session_id"])
    assert helper["parent_session"] == other["id"]
    assert "merged" in wr.tool(store.get_session(other["id"]), {"action": "merge_item", "id": "w1"})


def test_discard_throws_the_code_away_and_puts_items_back(world):
    run = begin(world)
    call(world, action="start_item", id="w1")
    work(world, "w1", "b.txt", "x\n")
    report(world, "w1")
    call(world, action="merge_item", id="w1")
    call(world, action="finish")
    body, status = multi_api.post("worklist/run/discard", {"session_id": chat(world)["id"], "run": run["id"]}, CHAT)
    assert status == 200 and body["runs"] == []
    assert item(world, "w1")["state"] == "todo" and "discarded" in item(world, "w1")["note"]
    assert not os.path.isdir(run["path"]) and run["branch"] not in git(world["p"], "branch", "--list")


def test_a_conflict_on_landing_leaves_your_branch_as_it_was(world):
    run = begin(world, titles=("x",))
    call(world, action="start_item", id="w1")
    work(world, "w1", "a.txt", "theirs\n")
    report(world, "w1")
    call(world, action="merge_item", id="w1")
    call(world, action="finish")
    with open(os.path.join(world["p"], "a.txt"), "w") as f:
        f.write("mine\n")
    git(world["p"], "commit", "-qam", "mine")
    head = git(world["p"], "rev-parse", "HEAD")
    body, status = multi_api.post("worklist/run/land", {"session_id": chat(world)["id"], "run": run["id"]}, CHAT)
    assert status == 400 and "a.txt" in body["error"]
    assert git(world["p"], "rev-parse", "HEAD") == head and git(world["p"], "status", "--porcelain") == ""


def test_landing_wont_touch_uncommitted_work(world):
    run = begin(world, titles=("x",))
    call(world, action="start_item", id="w1")
    work(world, "w1", "a.txt", "theirs\n")
    report(world, "w1")
    call(world, action="merge_item", id="w1")
    call(world, action="finish")
    with open(os.path.join(world["p"], "a.txt"), "w") as f:
        f.write("uncommitted\n")
    body, status = multi_api.post("worklist/run/land", {"session_id": chat(world)["id"], "run": run["id"]}, CHAT)
    assert status == 400
    with open(os.path.join(world["p"], "a.txt")) as f:
        assert f.read() == "uncommitted\n"


def test_the_telegram_command(world, monkeypatch):
    wl.add(world["root"], [{"title": "Fix it"}])
    monkeypatch.setattr(dispatch.state, "project_key", lambda c: "/shop", raising=False)
    monkeypatch.setattr(store, "latest_session", lambda c, k: chat(world))
    assert "Fix it" in dispatch.handle_work_command(CHAT, "/work")
    assert "1 items" in dispatch.handle_work_command(CHAT, "/work run 3")
    assert "Paused" in dispatch.handle_work_command(CHAT, "/work pause")
    assert "/work" in dispatch.help_text() and "/work run" in dispatch.help_text()
    assert wl.load(world["root"])["runs"][0]["parallel"] == 3


def test_a_helper_committing_the_links_itself_doesnt_get_them_in(world):
    os.makedirs(os.path.join(world["p"], "node_modules"))
    run = begin(world, titles=("x",))
    call(world, action="start_item", id="w1")
    work(world, "w1", "b.txt", "x\n", commit=True)
    assert "node_modules" in git(copy_of(world, "w1")["path"], "ls-tree", "-r", "--name-only", "HEAD")
    report(world, "w1")
    assert "node_modules" not in call(world, action="review_item", id="w1")
    call(world, action="merge_item", id="w1")
    assert "node_modules" not in git(run["path"], "ls-tree", "-r", "--name-only", "HEAD")


def test_an_ordinary_helpers_merge_leaves_the_links_out_too(world):
    os.makedirs(os.path.join(world["p"], "node_modules"))
    copy, why = channel._make_copy(chat(world), world["p"], "abcd")
    assert not why and copy["links"] == ["node_modules"]
    with open(os.path.join(copy["path"], "b.txt"), "w") as f:
        f.write("x\n")
    assert "1 file changed" in channel._diff_stat(copy)


def test_a_manager_whose_shell_was_in_a_merged_copy_can_start_the_next_item(world):
    """Found by a real run: the manager ran tests in w1's copy, w1 merged, and w2 refused to start."""
    begin(world)
    call(world, action="start_item", id="w1")
    gone = copy_of(world, "w1")["path"]
    store.set_work_cwd(world["session"]["id"], gone)
    work(world, "w1", "b.txt", "x\n")
    report(world, "w1")
    call(world, action="merge_item", id="w1")
    assert not os.path.isdir(gone) and chat(world)["work_cwd"] == gone
    call(world, action="start_item", id="w2")
    assert item(world, "w2")["state"] == "doing"
    assert os.path.exists(os.path.join(copy_of(world, "w2")["path"], "b.txt"))


def test_a_manager_inside_another_helpers_copy_still_starts_from_the_run(world):
    begin(world)
    call(world, action="start_item", id="w1")
    store.set_work_cwd(world["session"]["id"], copy_of(world, "w1")["path"])
    call(world, action="start_item", id="w2")
    assert os.path.realpath(copy_of(world, "w2")["top"]) == world["root"]


def test_an_ordinary_helper_survives_a_folder_thats_gone(world):
    store.set_work_cwd(world["session"]["id"], "/nonexistent/helper-x")
    plan, why = channel.plan_tasks(chat(world), [{"brief": "go", "name": "h", "write": True}])
    assert not why
    assert "started" in channel.start(chat(world), plan)[0]


def test_a_new_run_starts_from_your_branch_not_the_last_runs(world):
    """Found by a real run: the manager's shell stayed in the old run's worktree, so the next run
    was built on work that was never merged, and would have landed there too."""
    first = begin(world, titles=("x",))
    call(world, action="finish")
    store.set_work_cwd(world["session"]["id"], first["path"])
    with open(os.path.join(first["path"], "extra.txt"), "w") as f:
        f.write("x")
    git(first["path"], "add", "-A")
    git(first["path"], "commit", "-qm", "only on the first run")
    wl.add(world["root"], [{"title": "y"}])
    second = wr.start(chat(world), None)
    assert os.path.realpath(second["top"]) == world["root"]
    assert second["base"] == git(world["p"], "rev-parse", "HEAD")
    assert not os.path.exists(os.path.join(second["path"], "extra.txt"))


def test_a_chat_in_its_own_worktree_runs_from_there(world, tmp_path):
    own = str(tmp_path / "base" / "own-wt")
    git(world["p"], "worktree", "add", "-q", "-b", "feature", own)
    store.set_work_cwd(world["session"]["id"], own)
    wl.add(world["root"], [{"title": "x"}])
    run = wr.start(chat(world), None)
    assert os.path.realpath(run["top"]) == os.path.realpath(own) and run["into"] == "feature"


def test_a_merged_item_doesnt_claim_to_be_in_your_folder(world, monkeypatch):
    seen = []
    monkeypatch.setattr(channel, "_journal", lambda chat, ev: seen.append(ev))
    begin(world, titles=("x",))
    call(world, action="start_item", id="w1")
    work(world, "w1", "b.txt", "x\n")
    report(world, "w1")
    call(world, action="merge_item", id="w1")
    assert not [e for e in seen if e["type"] == "merge" and e.get("state") == "merged"]
    assert any("merged into mystical/work-" in e.get("text", "") for e in seen)
