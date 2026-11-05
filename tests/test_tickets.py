import json
import os

import pytest

from bridge import tickets


def _write(folder, n, title, blocked="None (can start immediately)"):
    with open(os.path.join(folder, f"{n}-x.md"), "w") as f:
        f.write(f"# {n}: {title}\n\n**What to build:** x\n\n**Blocked by:** {blocked}\n\n"
                "**Status:** ready-for-agent\n\n- [ ] ok\n")


def test_parse_numbers_titles_and_none(tmp_path):
    d = str(tmp_path)
    _write(d, "01", "Base")
    _write(d, "02", "Api", "#1")
    _write(d, "03", "Ui", "02 and base")
    _write(d, "04", "Docs", "#02, 3")
    _write(d, "05", "Poly", "None")
    ts = {t.n: t for t in tickets.parse_dir(d)}
    assert ts["01"].title == "Base" and ts["01"].blocked_by == ()
    assert ts["02"].blocked_by == ("01",)
    assert ts["03"].blocked_by == ("02", "01")
    assert ts["04"].blocked_by == ("02", "03")
    assert ts["05"].blocked_by == ()


def test_order_lowest_first(tmp_path):
    d = str(tmp_path)
    _write(d, "01", "A")
    _write(d, "02", "B", "05")
    _write(d, "03", "C")
    _write(d, "05", "E", "01")
    assert tickets.order(tickets.parse_dir(d)) == ["01", "03", "05", "02"]


def test_cycle_names_the_loop(tmp_path):
    d = str(tmp_path)
    _write(d, "01", "A")
    _write(d, "02", "B", "05")
    _write(d, "05", "E", "02")
    with pytest.raises(tickets.TicketError) as e:
        tickets.order(tickets.parse_dir(d))
    assert str(e.value) == "cycle: #02 → #05 → #02"


def test_missing_blocker_named(tmp_path):
    d = str(tmp_path)
    _write(d, "06", "F", "#9")
    with pytest.raises(tickets.TicketError) as e:
        tickets.parse_dir(d)
    assert str(e.value) == "#06 is blocked by #09, which doesn't exist"


def test_set_json_round_trip(tmp_path):
    d = str(tmp_path / "set")
    os.makedirs(d)
    assert tickets.load(d) == {}
    st = {"slug": "f", "parent_session": "s1", "status": "building", "tickets": {}}
    tickets.save(d, st)
    assert tickets.load(d) == st
    assert not os.path.exists(os.path.join(d, "set.json.tmp"))
    tickets.register(d, "proj", "f")
    assert tickets.sets()[0]["folder"] == d
    assert tickets.summary_for("s1")["slug"] == "f"
    assert tickets.summary_for("nope") is None


@pytest.mark.parametrize("line", ["Blocked by: #1, #3", "**Blocked by**: 01 and 3", "- **Blocked by:** 01, 03",
                                  "* blocked by: #1, 03.", "**Blocked by:** #01 (Base), #3 (Ui)."])
def test_blocked_by_variants(tmp_path, line):
    d = str(tmp_path)
    _write(d, "01", "A")
    _write(d, "03", "C")
    with open(os.path.join(d, "04-x.md"), "w") as f:
        f.write(f"# 04: D\n\n{line}\n\n**Status:** ready-for-agent\n")
    t = {t.n: t for t in tickets.parse_dir(d)}["04"]
    assert set(t.blocked_by) == {"01", "03"}


def test_unreadable_blocked_by_raises(tmp_path):
    d = str(tmp_path)
    with open(os.path.join(d, "01-x.md"), "w") as f:
        f.write("# 01: A\n\n**Blocked by:** (see above)\n")
    with pytest.raises(tickets.TicketError, match=r"#01.*see above"):
        tickets.parse_dir(d)


def test_duplicate_number_raises(tmp_path):
    d = str(tmp_path)
    _write(d, "01", "A")
    with open(os.path.join(d, "01-y.md"), "w") as f:
        f.write("# 1: B\n")
    with pytest.raises(tickets.TicketError, match="two tickets are numbered #01"):
        tickets.parse_dir(d)


@pytest.mark.parametrize("body", ["[1]", "not json", '"x"'])
def test_wrong_shape_files_give_none(tmp_path, body):
    d = str(tmp_path)
    with open(os.path.join(d, "set.json"), "w") as f:
        f.write(body)
    assert tickets.load(d) == {}
    tickets.register(d, "p", "s")
    assert tickets.summary_for("zz") is None
    with open(tickets._path(), "w") as f:
        f.write(body)
    assert tickets.summary_for("zz") is None
    with open(tickets._path(), "w") as f:
        json.dump([{"slug": "x"}, 5, {"folder": 3}], f)
    assert tickets.summary_for("zz") is None


def _t4(tmp_path, body):
    d = str(tmp_path)
    _write(d, "01", "A")
    _write(d, "03", "C")
    with open(os.path.join(d, "04-x.md"), "w") as f:
        f.write(body)
    return {t.n: t for t in tickets.parse_dir(d)}["04"]


def test_list_under_empty_label(tmp_path):
    t = _t4(tmp_path, "# 04: D\n\n**Blocked by:**\n- #1\n* 3\n\n- #9\n**Status:** x\n")
    assert set(t.blocked_by) == {"01", "03"}
    t = _t4(tmp_path / "n", "# 04: D\n\n**Blocked by:**\n1. #1\n2. #3\n") if os.makedirs(tmp_path / "n") is None else None
    assert set(t.blocked_by) == {"01", "03"}


def test_comma_in_parenthetical(tmp_path):
    assert _t4(tmp_path, "# 04: D\n\n**Blocked by:** #1 (Base, shared)\n").blocked_by == ("01",)


def test_no_line_and_empty_label_mean_no_blockers(tmp_path):
    assert _t4(tmp_path, "# 04: D\n\nstuff\n").blocked_by == ()
    assert _t4(tmp_path / "e", "# 04: D\n\n**Blocked by:**\n\n**Status:** x\n").blocked_by == () \
        if os.makedirs(tmp_path / "e") is None else None


def test_bad_created_does_not_break_summary(tmp_path):
    d = str(tmp_path)
    tickets.save(d, {"parent_session": "cr", "slug": "good"})
    with open(tickets._path(), "w") as f:
        json.dump([{"folder": "/nope", "created": "x"}, {"folder": d, "created": None},
                   {"folder": d, "created": 5}], f)
    assert tickets.summary_for("cr")["slug"] == "good"


# --- the scheduler: BUILD, 3 at once -----------------------------------------

import subprocess  # noqa: E402
import uuid  # noqa: E402
from types import SimpleNamespace  # noqa: E402

from bridge import aifeatures, config, git, notices, paths, runner, store  # noqa: E402


def _git(cwd, *a):
    return subprocess.run(["git", "-C", cwd, *a], capture_output=True, text=True, check=True).stdout.strip()


class BuiltSet:
    """A repo whose flow session sits on master with ticket files written by the
    flow, and recorders for the runs, worktrees and notices the scheduler makes.
    Git is real; runs and notices are fakes."""

    def __init__(self, root, monkeypatch, graph):
        self.mp, self.main = monkeypatch, os.path.join(root, "proj")
        os.makedirs(self.main)
        for a in (("init", "-q", "-b", "master"), ("config", "user.email", "t@t"), ("config", "user.name", "t")):
            _git(self.main, *a)
        with open(os.path.join(self.main, "README.md"), "w") as f:
            f.write("x\n")
        _git(self.main, "add", "-A")
        _git(self.main, "commit", "-qm", "init")
        self.flow = store.create_session(1, "proj", cwd=self.main)["id"]
        paths.set_path(self.flow, "feature", "new", "claude")
        self.folder = os.path.join(self.main, ".mystical", "tickets", "x")
        os.makedirs(self.folder)
        with open(os.path.join(self.main, ".mystical", ".gitignore"), "w") as f:
            f.write("*\n")
        for n, blocked in graph.items():
            _write(self.folder, n, f"T{n}", blocked or "None")
        self.starts, self.adds, self.kinds = [], [], []
        self.refuse = self.no_turn = False     # the run is refused (busy) / no turn row (cut before it)
        real_add = git.worktree_add

        def add(cwd, path, branch, start="", create=True):
            self.adds.append({"branch": branch, "start": start, "create": create})
            return real_add(cwd, path, branch, start, create)

        def start(chat_id, prompt, image_paths, project=None, session_id=None, origin=None, **kw):
            if self.refuse:
                return None
            self.starts.append({"sid": session_id, "prompt": prompt, "project": project, "origin": origin})
            turn = uuid.uuid4().hex
            if not self.no_turn:
                store.start_turn(session_id, turn, prompt, [])
            paths.on_turn_start(session_id, prompt)
            return SimpleNamespace(id=turn, store_session_id=session_id)

        monkeypatch.setattr(git, "worktree_add", add)
        monkeypatch.setattr(runner, "start_streaming_job", start)
        monkeypatch.setattr(notices, "emit", lambda kind, subject, **kw: self.kinds.append(kind))
        monkeypatch.setattr(config, "BASE_PATH", os.path.join(root, "base"))
        monkeypatch.setattr(tickets, "_path", lambda: os.path.join(root, "ticketsets.json"))

    def switch(self, on):
        self.mp.setattr(aifeatures, "enabled", lambda key: key in ({"router", "ticketruns"} if on else {"router"}))

    def build(self):
        return tickets.start_build(self.flow)

    @property
    def state(self):
        return tickets.load(self.folder)

    def status(self, n):
        return self.state["tickets"][n]["status"]

    def running(self):
        return sorted(n for n, t in self.state["tickets"].items() if t["status"] == "running")

    def path(self, n):
        return os.path.join(self.folder, f"{n}-x.md")

    def sid(self, n):
        return self.state["tickets"][n]["session_id"]

    def start_calls(self, n):
        return sum(s["sid"] == self.sid(n) for s in self.starts)

    def worktree_add_calls(self, n):
        return [a for a in self.adds if a["branch"] == f"tk/x-{n}"]

    def git_log_for(self, n):
        return _git(self.main, "log", "--format=%s", f"tk/x-{n}")

    def job(self, n, status="done"):
        return SimpleNamespace(store_session_id=self.sid(n), id=store.latest_turn_id(self.sid(n)), status=status,
                               interrupted=False, runtime=None, chat_id=1, result="",
                               error_msg="claude exited 1" if status == "error" else None)

    def hand_turn(self, n):
        store.start_turn(self.sid(n), uuid.uuid4().hex, "commit what you have", [])

    def end(self, n, status):
        store.finish_turn(store.latest_turn_id(self.sid(n)), status, 0, 1)
        return tickets.after_turn(self.job(n, status))

    def commit(self, n, file=None):
        wt = self.state["tickets"][n]["worktree"]
        with open(os.path.join(wt, file or f"{n}.txt"), "w") as f:
            f.write(n)
        _git(wt, "add", "-A")
        _git(wt, "commit", "-qm", f"ticket {n}")

    def finish(self, n, commit=True, file=None):
        if commit:
            self.commit(n, file)
        paths.step_done(self.sid(n), store.latest_turn_id(self.sid(n)))
        return self.end(n, "done")

    def fail(self, n):
        return self.end(n, "error")


@pytest.fixture
def make_set(tmp_path, monkeypatch):
    store.init()

    def make(graph, build=True, on=True):
        s = BuiltSet(str(tmp_path), monkeypatch, graph)
        s.switch(on)
        if build:
            assert s.build() == ""
        return s
    return make


FIVE = {n: None for n in ("01", "02", "03", "04", "05")}


def test_at_most_three_run(make_set):
    s = make_set(FIVE)
    assert s.running() == ["01", "02", "03"]
    s.finish("02")
    assert s.running() == ["01", "03", "04"]      # a done ticket frees its slot, lowest number first


def test_dependent_waits_then_bases_on_blocker(make_set):
    s = make_set({"01": None, "04": "#01"})
    assert s.status("04") == "queued"
    s.finish("01")
    assert s.status("01") == "done" and s.status("04") == "running"
    assert s.state["tickets"]["04"]["base"] == "tk/x-01"
    _git(s.main, "merge-base", "--is-ancestor", "tk/x-01", "tk/x-04")     # raises if 04 isn't built on 01


def test_two_blockers_merge_second_in(make_set):
    s = make_set({"02": None, "03": None, "06": "#02, #03"})
    s.finish("02")
    s.finish("03")
    assert s.state["tickets"]["06"]["base"] == "tk/x-02"
    assert "Merge branch 'tk/x-03'" in s.git_log_for("06")
    assert "First resolve" not in s.starts[-1]["prompt"]


def test_a_merge_clash_is_the_first_job(make_set):
    s = make_set({"02": None, "03": None, "06": "#02, #03"})
    s.finish("02", file="same.txt")
    s.finish("03", file="same.txt")
    assert s.status("06") == "running"
    assert s.starts[-1]["prompt"].endswith("\nFirst resolve the merge of tk/x-03 left in this checkout.")


def test_error_marks_fix_and_holds_dependents(make_set):
    s = make_set({"01": None, "04": "#01"})
    s.fail("01")
    assert s.status("01") == "fix" and s.status("04") == "queued"


def test_step_done_without_a_commit_is_fix(make_set):
    s = make_set({"01": None, "04": "#01"})
    s.finish("01", commit=False)
    assert s.status("01") == "fix" and s.status("04") == "queued"


def test_a_turn_without_step_done_keeps_its_slot(make_set):
    s = make_set({"01": None})
    s.commit("01")
    s.end("01", "done")                           # it asked something in prose: waiting on you
    assert s.status("01") == "running"


def test_a_stopped_turn_starts_nothing(make_set):
    s = make_set({"01": None, "02": "#01"})
    s.commit("01")
    paths.step_done(s.sid("01"), store.latest_turn_id(s.sid("01")))
    job = s.job("01")
    job.interrupted = True                        # you pressed Stop: nothing moves by itself
    tickets.after_turn(job)
    assert s.status("01") == "running" and s.status("02") == "queued"


def test_a_parked_limit_is_not_a_fix(make_set, monkeypatch):
    from bridge import limits
    s = make_set({"01": None})
    monkeypatch.setattr(limits, "parked", lambda: {s.sid("01"): {"kind": "limit"}})
    s.fail("01")
    assert s.status("01") == "running"


def test_boot_never_double_starts(make_set):
    s = make_set({"01": None, "04": "#01"})
    paths._cache.clear()                          # a restart: nothing in memory, set.json and the DB stay
    tickets.boot()
    assert s.start_calls("01") == 1 and s.status("01") == "running" and s.status("04") == "queued"


def test_boot_judges_turns_that_ended_unheard(make_set):
    s = make_set({"01": None, "02": None, "04": "#01"})
    s.commit("01")
    paths.step_done(s.sid("01"), store.latest_turn_id(s.sid("01")))
    for n, st in (("01", "done"), ("02", "error")):          # ended while nothing listened
        store.finish_turn(store.latest_turn_id(s.sid(n)), st, 0, 1)
    paths._cache.clear()
    tickets.boot()
    assert (s.status("01"), s.status("02"), s.status("04")) == ("done", "fix", "running")
    assert s.start_calls("01") == s.start_calls("02") == 1


def test_missing_ticket_file_is_held_not_fatal(make_set):
    s = make_set({"01": None, "04": "#01"}, on=False)        # approved while TICKETS was off
    os.remove(s.path("01"))
    s.switch(True)
    tickets.tick(s.folder)
    assert s.status("01") == "missing" and s.status("04") == "queued" and not s.starts


def test_existing_branch_is_reused(make_set):
    s = make_set({"01": None}, build=False)
    _git(s.main, "branch", "tk/x-01")
    assert s.build() == ""
    assert s.worktree_add_calls("01")[0]["create"] is False and s.status("01") == "running"


def test_tick_starts_nothing_when_off(make_set):
    s = make_set(FIVE, on=False)
    assert s.running() == [] and not s.starts


def test_cycle_stops_the_set_with_a_notice(make_set):
    s = make_set({"01": None, "02": "#05", "05": "#02"}, build=False)
    assert s.build().startswith("cycle:") and s.kinds == ["tickets"]
    assert s.state["status"] == "stopped" and not s.starts


def test_first_prompt_title_and_path(make_set):
    s = make_set({"01": None})
    t = s.state["tickets"]["01"]
    assert s.starts == [{"sid": t["session_id"], "project": t["worktree"], "origin": "ticket", "prompt":
                         f"/mattpocock-skills:implement {s.path('01')}\n\nThis is ticket #01 of x. Work on branch "
                         "tk/x-01 in this checkout and commit there. When it is done and the tests pass, "
                         "call StepDone."}]
    sess = store.get_session(t["session_id"])
    assert (sess["title"], sess["cwd"], sess["origin"]) == ("#01 T01", t["worktree"], "ticket")
    assert s.state["feature_branch"] == "feat/x" and _git(t["worktree"], "rev-parse", "--abbrev-ref", "HEAD") == "tk/x-01"
    f = paths.get(t["session_id"])
    assert (f["path"], f["skill"]) == ("one", "implement")


def test_ticket_step_done_starts_no_flow_step(make_set, monkeypatch):
    from bridge import queue_manager
    s = make_set({"01": None})
    q = []
    monkeypatch.setattr(queue_manager, "enqueue", lambda sid, **kw: q.append(kw))
    paths.step_done(s.sid("01"), store.latest_turn_id(s.sid("01")))
    monkeypatch.setattr(aifeatures, "enabled", lambda key: True)       # AUTO NEXT STEPS too
    assert paths.continue_after_turn(s.job("01")) is False and not q


def test_retry_is_a_new_turn_in_its_own_session(make_set):
    s = make_set({"01": None})
    s.finish("01", commit=False)
    tickets.retry(s.folder, "01")
    assert s.status("01") == "running" and s.start_calls("01") == 2 and paths.get(s.sid("01"))["done"] == []
    assert s.starts[-1]["prompt"] == (f"No path for this message.\n\nTry this ticket again: {s.path('01')}\n"
                                      "Work on branch tk/x-01 in this checkout and commit there. When it is done "
                                      "and the tests pass, call StepDone.")
    s.finish("01")
    assert s.status("01") == "done"


def test_merge_starts_once_every_ticket_is_done(make_set, monkeypatch):
    merged = []
    monkeypatch.setattr(tickets, "start_merge", merged.append)
    s = make_set({"01": None, "02": "#01"})
    s.finish("01")
    assert not merged
    s.finish("02")
    assert merged == [s.folder]


def test_other_sessions_are_not_tickets(make_set):
    s = make_set({"01": None})
    job = SimpleNamespace(store_session_id=s.flow, id="x", status="error", interrupted=False)
    assert tickets.after_turn(job) is False and s.status("01") == "running"


def test_turn_end_reaches_the_scheduler(monkeypatch):
    seen = []
    monkeypatch.setattr(tickets, "after_turn", seen.append)
    job = SimpleNamespace(store_session_id=None, id="t", status="done", interrupted=False, runtime=None, chat_id=1)
    runner._continue_after_turn(job)  # noqa: SLF001
    assert seen == [job]


# --- fix round 1 ----------------------------------------------------------------

def test_a_retry_at_the_cap_waits_then_goes_first(make_set):
    s = make_set({"01": None, "02": None, "03": None, "04": "#01", "06": None, "07": None})
    s.fail("03")                                   # 06 takes its slot
    s.fail("06")                                   # 07 takes that one
    assert s.running() == ["01", "02", "07"]
    sid = s.sid("06")
    assert tickets.retry(s.folder, "06") == "3 tickets are running; #06 starts when one finishes."
    assert s.status("06") == "retry" and s.running() == ["01", "02", "07"] and s.start_calls("06") == 1
    s.finish("01")                                 # frees a slot and readies 04; the retry goes first
    assert s.running() == ["02", "06", "07"] and s.status("04") == "queued"
    assert s.sid("06") == sid and s.start_calls("06") == 2
    assert s.starts[-1]["prompt"].startswith(f"No path for this message.\n\nTry this ticket again: {s.path('06')}")


def test_a_refused_retry_keeps_the_step_done_you_recorded(make_set):
    s = make_set({"01": None})
    s.fail("01")
    s.hand_turn("01")                              # you drive it by hand, and that turn calls StepDone
    paths.step_done(s.sid("01"), store.latest_turn_id(s.sid("01")))
    s.refuse = True                                # ...while it still runs, you tap retry
    assert tickets.retry(s.folder, "01") != ""
    assert s.status("01") == "fix" and paths.get(s.sid("01"))["done"] == ["implement"]


def test_a_fix_forgets_its_step_done(make_set):
    s = make_set({"01": None, "04": "#01"})
    s.finish("01", commit=False)                   # said done, committed nothing
    assert s.status("01") == "fix" and paths.get(s.sid("01"))["done"] == []
    s.hand_turn("01")                              # it commits half of it, with no new StepDone
    s.commit("01")
    s.end("01", "done")
    assert s.status("01") == "fix" and s.status("04") == "queued"


def test_a_merged_set_goes_on_to_retro_and_builds_nothing_again(make_set, monkeypatch):
    from bridge import queue_manager
    s = make_set({"01": None}, build=False)
    for t in ("a", "b", "c"):
        paths.step_done(s.flow, t)                 # grill, spec, tickets: build is next
    assert s.build() == ""
    s.finish("01")
    tickets.save(s.folder, {**s.state, "status": "merged"})      # what the merge session ends with
    q = []
    monkeypatch.setattr(queue_manager, "enqueue", lambda sid, **kw: q.append(kw["prompt"]))
    monkeypatch.setattr(aifeatures, "enabled", lambda key: key in ("router", "nextstep", "ticketruns"))
    starts = len(s.starts)
    assert paths.advance(s.flow, "merge") is True
    assert q == ["/mattpocock-skills:retro"] and len(s.starts) == starts
    assert s.build() == "x is already merged" and len(s.starts) == starts


def test_boot_fixes_a_ticket_whose_turn_never_began(make_set):
    s = make_set({"01": None}, build=False)
    s.no_turn = True                               # the restart came between its session and its turn
    assert s.build() == ""
    paths._cache.clear()
    tickets.boot()
    assert s.status("01") == "fix" and s.start_calls("01") == 1


def test_boot_keeps_an_idle_ticket_without_step_done_waiting(make_set):
    s = make_set({"01": None})
    s.commit("01")
    store.finish_turn(store.latest_turn_id(s.sid("01")), "done", 0, 1)    # ended, no StepDone, unheard
    paths._cache.clear()
    tickets.boot()
    assert s.status("01") == "running" and s.start_calls("01") == 1      # waiting on you, as at runtime


def test_build_is_done_on_the_flow_once_every_ticket_is(make_set):
    s = make_set({"01": None, "02": None})
    assert "build" not in paths.get(s.flow)["done"]      # FLOW shows BUILD running while tickets build
    s.finish("01")
    assert "build" not in paths.get(s.flow)["done"]
    s.finish("02")
    assert "build" in paths.get(s.flow)["done"]


def test_boot_leaves_a_parked_ticket_alone(make_set, monkeypatch):
    from bridge import limits
    s = make_set({"01": None})
    store.finish_turn(store.latest_turn_id(s.sid("01")), "error", 0, 1)   # hit the limit and parked
    monkeypatch.setattr(limits, "parked", lambda: {s.sid("01"): {"kind": "limit"}})
    tickets.boot()
    assert s.status("01") == "running"


# --- MERGE, RETRO, clean-up ----------------------------------------------------

def _merges(s):
    return [x for x in s.starts if x["origin"] == "ticket-merge"]


def _finish_all(s, *ns):
    for n in ns:
        s.finish(n)


def _merge_job(s, status="done"):
    sid = s.state["merge_session"]
    store.finish_turn(store.latest_turn_id(sid), status, 0, 1)
    return SimpleNamespace(store_session_id=sid, id=store.latest_turn_id(sid), status=status, interrupted=False,
                           runtime=None, chat_id=1, result="", error_msg=None)


def test_merge_prompt_lists_branches_in_dependency_order(make_set):
    s = make_set({"01": "#03", "02": None, "03": None})
    _finish_all(s, "02", "03", "01")
    (m,) = _merges(s)
    assert m["prompt"] == ("No path for this message.\n\nMerge these branches into feat/x, in this order, each with git merge --no-ff: "
                           "tk/x-02, tk/x-03, tk/x-01\nResolve any clash so both tickets' work survives, run the "
                           "project's full test suite, fix what breaks, and commit. Then call StepDone.")
    sess = store.get_session(m["sid"])
    assert (sess["title"], sess["origin"], sess["cwd"]) == ("Merge x", "ticket-merge", s.state["feature_checkout"])
    assert (s.state["status"], s.state["merge_session"]) == ("merging", m["sid"])
    assert paths.get(m["sid"])["path"] == "one"


def test_start_merge_is_idempotent(make_set):
    s = make_set({"01": None})
    s.finish("01")
    tickets.tick(s.folder)
    tickets.start_merge(s.folder)
    tickets.boot()
    assert len(_merges(s)) == 1


def test_merge_done_enqueues_retro_in_flow_session(make_set, monkeypatch):
    from bridge import queue_manager
    s = make_set({"01": None}, build=False)
    for t in ("a", "b", "c"):
        paths.step_done(s.flow, t)
    assert s.build() == ""
    s.finish("01")
    q = []
    monkeypatch.setattr(queue_manager, "enqueue", lambda sid, **kw: q.append((sid, kw["prompt"])))
    monkeypatch.setattr(aifeatures, "enabled", lambda key: key in ("router", "nextstep", "ticketruns"))
    sid = s.state["merge_session"]
    assert tickets.after_turn(_merge_job(s)) is True       # ended without StepDone: still waiting
    assert s.state["status"] == "merging" and not q
    _merge_for_real(s)
    paths.step_done(sid, store.latest_turn_id(sid))
    assert tickets.after_turn(_merge_job(s)) is True
    assert s.state["status"] == "merged"
    assert q == [(s.flow, "/mattpocock-skills:retro")]


def test_a_merge_error_is_fix_and_retry_runs_it_again(make_set):
    s = make_set({"01": None})
    s.finish("01")
    sid = s.state["merge_session"]
    tickets.after_turn(_merge_job(s, "error"))
    assert s.state["status"] == "fix"
    assert tickets.retry(s.folder, "merge") == ""
    assert s.state["status"] == "merging" and len(_merges(s)) == 2 and s.state["merge_session"] == sid


def _merged_set(s):
    s.finish("01")
    s.finish("02")
    st = s.state
    # 01 merges onto the feature branch; 02 does not
    _git(st["feature_checkout"], "merge", "--no-ff", "-m", "m", "tk/x-01")
    tickets.save(s.folder, {**st, "status": "merged"})
    return st


def test_cleanup_skips_unmerged(make_set):
    s = make_set({"01": None, "02": None})
    st = _merged_set(s)
    skipped = tickets.cleanup(s.folder)
    assert skipped == ["tk/x-02"]
    assert not os.path.isdir(st["tickets"]["01"]["worktree"]) and os.path.isdir(st["tickets"]["02"]["worktree"])
    assert "tk/x-01" not in _git(s.main, "branch", "--format=%(refname:short)").split()
    assert tickets.merged_count(s.state) == 0               # 01's branch is gone now


def test_cleanup_skips_a_dirty_worktree_and_waits_for_merged(make_set):
    s = make_set({"01": None})
    s.finish("01")
    assert tickets.cleanup(s.folder) == ["tk/x-01"]          # not merged yet: nothing is touched
    st = s.state
    _git(st["feature_checkout"], "merge", "--no-ff", "-m", "m", "tk/x-01")
    assert tickets.merged_count(st) == 1
    tickets.save(s.folder, {**st, "status": "merged"})
    with open(os.path.join(st["tickets"]["01"]["worktree"], "wip.txt"), "w") as f:
        f.write("x")
    assert tickets.cleanup(s.folder) == ["tk/x-01"] and os.path.isdir(st["tickets"]["01"]["worktree"])


def _dpost(path, body):
    from bridge.dashboard import server as dash
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    h._post_api(path, body)
    return box


def test_ticket_endpoints_only_take_registered_folders(make_set, tmp_path):
    s = make_set({"01": None})
    for p in ("/local/tickets/retry", "/local/tickets/cleanup"):
        for body in ({"folder": str(tmp_path), "n": "01"}, {"n": "01"}, {"folder": 5}):
            r = _dpost(p, body)
            assert r["code"] == 404 and "error" in r["obj"]
    assert _dpost("/local/tickets/retry", {"folder": s.folder, "n": "01"})["obj"] == {"text": "#01 isn't waiting for a retry"}
    assert _dpost("/local/tickets/cleanup", {"folder": s.folder})["obj"] == {"removed": [], "skipped": ["tk/x-01"]}


def test_get_tickets_lists_sets_with_live_ticket_status(make_set):
    from bridge.dashboard import server as dash
    s = make_set({"01": None, "02": None})
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    h._get_api("/local/tickets", {})
    (one,) = box["obj"]["sets"]
    assert one["folder"] == s.folder and one["merged"] == 2 and one["status"] == "building"
    assert one["tickets"]["01"]["session"] == "running"


def test_a_retry_whose_turn_records_step_done_at_once_still_finishes(make_set, monkeypatch):
    s = make_set({"01": None})
    s.finish("01", commit=False)
    real = runner.start_streaming_job

    def fast(chat_id, prompt, image_paths, session_id=None, **kw):
        job = real(chat_id, prompt, image_paths, session_id=session_id, **kw)
        s.commit("01")
        paths.step_done(session_id, job.id)       # StepDone before start returns
        return job
    monkeypatch.setattr(runner, "start_streaming_job", fast)
    assert tickets.retry(s.folder, "01") == ""
    assert paths.get(s.sid("01"))["done"] == ["implement"]
    assert s.end("01", "done") and s.status("01") == "done"


def test_a_merge_retry_with_fast_step_done_ends_merged(make_set, monkeypatch):
    s = make_set({"01": None})
    s.finish("01")
    sid = s.state["merge_session"]
    tickets.after_turn(_merge_job(s, "error"))
    real = runner.start_streaming_job

    def fast(chat_id, prompt, image_paths, session_id=None, **kw):
        job = real(chat_id, prompt, image_paths, session_id=session_id, **kw)
        _merge_for_real(s)
        paths.step_done(session_id, job.id)
        return job
    monkeypatch.setattr(runner, "start_streaming_job", fast)
    assert tickets.retry(s.folder, "merge") == ""
    tickets.after_turn(_merge_job(s))
    assert s.state["status"] == "merged"
    assert s.starts[-1]["prompt"].startswith("No path for this message.\n\nMerge these")


def test_a_refused_merge_retry_keeps_the_path_state(make_set):
    s = make_set({"01": None})
    s.finish("01")
    sid = s.state["merge_session"]
    paths.step_done(sid, "t1")
    tickets.after_turn(_merge_job(s, "error"))
    s.refuse = True
    assert tickets.retry(s.folder, "merge") == "the bridge refused the run"
    assert paths.get(sid)["done"] == ["merge"] and s.state["status"] == "fix"


def test_a_stopped_set_builds_again_from_its_build_action(make_set, tmp_path):
    s = make_set({"01": None, "02": "#05", "05": "#02"}, build=False)
    assert s.build().startswith("cycle:") and s.state["status"] == "stopped"
    _write(s.folder, "05", "T05")                            # the cycle fixed by hand
    assert _dpost("/local/tickets/build", {"folder": str(tmp_path)})["code"] == 404
    assert _dpost("/local/tickets/build", {"folder": s.folder})["obj"] == {"text": "Building."}
    assert s.state["status"] == "building" and s.running() == ["01", "05"]
    assert _dpost("/local/tickets/build", {"folder": s.folder})["obj"] == {"text": "x is already building"}


def _merge_for_real(s):
    """What the merge session does: every ticket branch onto the feature branch."""
    st = s.state
    for t in st["tickets"].values():
        _git(st["feature_checkout"], "merge", "--no-ff", "-m", "m", t["branch"])


def test_an_old_set_leaves_a_new_path_in_its_flow_session_alone(make_set, monkeypatch):
    import time
    from bridge import queue_manager
    q = []
    monkeypatch.setattr(queue_manager, "enqueue", lambda sid, **kw: q.append(kw["prompt"]))
    s = make_set({"01": None}, build=False)
    for t in ("a", "b", "c"):
        paths.step_done(s.flow, t)                 # build is next
    assert s.build() == ""
    real = time.time
    monkeypatch.setattr(time, "time", lambda: real() + 100)
    paths.set_path(s.flow, "bug", "a new crash", "claude")      # the flow session moved on
    monkeypatch.setattr(time, "time", real)
    monkeypatch.setattr(aifeatures, "enabled", lambda key: key in ("router", "nextstep", "ticketruns"))
    s.finish("01")                                 # BUILD done, merge starts
    _merge_for_real(s)
    sid = s.state["merge_session"]
    paths.step_done(sid, store.latest_turn_id(sid))
    tickets.after_turn(_merge_job(s))
    assert s.state["status"] == "merged"
    f = paths.get(s.flow)
    assert (f["path"], f["done"], f["next"]) == ("bug", [], None) and not q


def test_a_merge_step_done_with_a_branch_left_out_is_fix(make_set, monkeypatch):
    s = make_set({"01": None, "02": None})
    _finish_all(s, "01", "02")
    _git(s.state["feature_checkout"], "merge", "--no-ff", "-m", "m", "tk/x-01")    # 02 left out
    said = []
    monkeypatch.setattr(notices, "emit", lambda kind, subject, **kw: said.append((kind, subject, kw.get("body"))))
    sid = s.state["merge_session"]
    paths.step_done(sid, store.latest_turn_id(sid))
    tickets.after_turn(_merge_job(s))
    assert s.state["status"] == "fix"
    assert said == [("tickets", s.flow, "MERGE called StepDone, but tk/x-02 isn't merged into feat/x yet.")]


def test_ticket_and_merge_sessions_run_claude_whatever_the_projects_default(make_set, monkeypatch):
    from bridge import profiles
    monkeypatch.setattr(profiles, "project_default", lambda project: "kimi-p")
    monkeypatch.setattr(profiles, "get", lambda pid: {"id": pid, "agent": "kimi"} if pid == "kimi-p" else None)
    s = make_set({"01": None})
    assert store.get_session(s.sid("01"))["profile_id"] is None
    s.finish("01")
    assert store.get_session(s.state["merge_session"])["profile_id"] is None


def test_turning_tickets_or_skill_paths_on_resumes_the_sets(monkeypatch):
    import threading
    booted = threading.Event()
    monkeypatch.setattr(aifeatures, "set_enabled", lambda key, on: None)   # nothing persisted
    monkeypatch.setattr(tickets, "boot", booted.set)
    _dpost("/local/aifeatures", {"key": "autopick", "enabled": True})
    _dpost("/local/aifeatures", {"key": "ticketruns", "enabled": False})
    assert not booted.wait(0.2)
    for key in ("ticketruns", "router"):
        booted.clear()
        assert _dpost("/local/aifeatures", {"key": key, "enabled": True})["obj"]["ok"] is True
        assert booted.wait(5), key


def test_the_spec_beside_the_tickets_is_no_ticket(tmp_path):
    d = str(tmp_path)
    _write(d, "01", "A")
    with open(os.path.join(d, "SPEC.md"), "w") as f:
        f.write("# 1: Problem Statement\n\n**Blocked by:** nothing\n")
    assert [t.n for t in tickets.parse_dir(d)] == ["01"]


def test_build_takes_the_folder_this_flow_wrote(make_set):
    s = make_set({"01": None}, build=False)
    store.append_event(s.flow, "t-tk", {"type": "tool", "name": "Write", "summary": s.path("01")})
    other = os.path.join(s.main, ".mystical", "tickets", "y")    # newer, from another session
    os.makedirs(other)
    _write(other, "01", "Not ours")
    os.utime(os.path.join(other, "01-x.md"), (2e9, 2e9))
    assert s.build() == "" and s.state["status"] == "building"
    assert tickets.load(other) == {}
