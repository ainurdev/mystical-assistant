"""What a Rivendell job was about, kept on its session (bridge/rivendell_jobs.py),
and the worker wiring that files it (bridge/rivendell.py): the facts read from an
event, a catch-up row and a claim; the session's title; a newspaper's headline;
the backfill of sessions from before; and the brief both UIs read.
Run: python -m pytest tests/test_rivendell_jobs.py -v
"""

import itertools
import json
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import rivendell, rivendell_jobs, store  # noqa: E402
from bridge.miniapp.server import _session_brief  # noqa: E402

_chat = itertools.count(940_000)

REVIEW_FRAME = {
    "type": "pr-review-request", "requestId": "r1",
    "pullRequest": {"id": "pr-uuid", "repositoryId": "repo-uuid", "number": 81,
                    "title": "feat: per-project worker access",
                    "htmlUrl": "https://github.com/ainurhq/ibgroups_operations/pull/81",
                    "repositoryFullName": "ainurhq/ibgroups_operations"},
}
REVIEW_PROMPT = (
    "You are an experienced software engineer performing a code review for the team.\n\n"
    "Pull request: feat: per-project worker access and removal of the Telegram bot\n"
    "Pull request URL: https://github.com/ainurhq/ibgroups_operations/pull/81\n"
    "Repository: https://github.com/ainurdev/ibgroups_operations\n\nCheck out the pull request branch…")
SUMMARY_PROMPT = (
    'You are writing a short summary of what happened in the project "Rivendell".\n\n'
    "Period: Sat 17 Oct to Sun 18 Oct\n\nTasks finished: 4…")
BRIEF_PROMPT = (
    'You are preparing a brief for the meeting "Weekly sync".\n\n'
    "Since the last meeting (Sat 17 Oct): tasks finished: 4…")
PAPER = {"ear": "31 commits", "lead": {"headline": "Patterna opens its shop window", "deck": "d", "body": ["b"]}}


def _rv_session(prompt: str, *, result: "str | None" = None, title_manual: "str | None" = None) -> str:
    store.init()
    sid = store.create_session(next(_chat), "/", origin="rivendell:t1")["id"]
    store.set_ref(sid, f"t1:req-{sid[:8]}")
    tid = f"turn-{sid[:12]}"
    store.start_turn(sid, tid, prompt, None)
    if result is not None:
        store.append_event(sid, tid, {"type": "result", "result": result})
    store.finish_turn(tid, "done", 0.1, 5)
    if title_manual:
        store.rename(sid, title_manual)
    return sid


# --- facts ----------------------------------------------------------------

def test_facts_from_a_review_event_keep_what_a_person_knows_it_by():
    job = rivendell_jobs.facts("review", "r1", "t1", REVIEW_FRAME, {"prompt": "x"})
    assert job == {"kind": "review", "instance": "t1", "request": "r1",
                   "title": "feat: per-project worker access", "repo": "ainurhq/ibgroups_operations",
                   "number": 81, "html_url": "https://github.com/ainurhq/ibgroups_operations/pull/81",
                   "pr_id": "pr-uuid"}


def test_facts_read_a_catch_up_row_the_same_way():
    """A review that arrived while the bridge was down comes back as a catch-up
    row, whose fields are flat: the same job comes out of it."""
    row = {"id": "r1", "pullRequestId": "pr-uuid", "pullRequestNumber": 81,
           "pullRequestTitle": "feat: per-project worker access",
           "pullRequestHtmlUrl": "https://github.com/ainurhq/ibgroups_operations/pull/81",
           "repositoryFullName": "ainurhq/ibgroups_operations"}
    assert rivendell_jobs.facts("review", "r1", "t1", row) == \
        rivendell_jobs.facts("review", "r1", "t1", REVIEW_FRAME)


def test_facts_take_the_claims_extras_and_drop_the_empty():
    job = rivendell_jobs.facts("video", "v1", "t1", {"kind": "TRANSCRIBE", "file": {"id": "f", "name": "Contract.mov"}},
                               {"kind": "TRANSCRIBE", "language": "en", "file": {"name": "Contract.mov"}})
    assert job == {"kind": "video", "instance": "t1", "request": "v1", "step": "transcribe",
                   "title": "Contract.mov", "language": "en"}
    news = rivendell_jobs.facts("news", "n1", "t1", {"editionDate": "2026-10-18", "user": {"name": "M"}})
    assert news == {"kind": "news", "instance": "t1", "request": "n1", "date": "2026-10-18"}
    todo = rivendell_jobs.facts("todolist", "t9", "t1", {"kind": "RECOMMENDATIONS", "project": {"id": "p", "name": "Rivendell"}})
    assert (todo["step"], todo["title"], todo["project_id"]) == ("recommendations", "Rivendell", "p")


def test_facts_name_a_project_summary_by_its_project_from_an_event_a_row_and_a_claim():
    frame = {"type": "project-summary-request", "requestId": "s1", "project": {"id": "p1", "name": "Rivendell"}}
    row = {"id": "s1", "projectId": "p1", "projectName": "Rivendell"}
    job = {"kind": "project-summary", "instance": "t1", "request": "s1", "title": "Rivendell", "project_id": "p1"}
    assert rivendell_jobs.facts("project-summary", "s1", "t1", frame) == job
    assert rivendell_jobs.facts("project-summary", "s1", "t1", row) == job
    claim = {"requestId": "s1", "status": "IN_PROGRESS", "projectName": "Rivendell", "repositories": []}
    assert rivendell_jobs.facts("project-summary", "s1", "t1", None, claim)["title"] == "Rivendell"


def test_facts_name_a_meeting_brief_by_its_meeting_from_an_event_a_row_and_a_claim():
    frame = {"type": "meeting-brief-request", "requestId": "b1",
             "meeting": {"name": "Weekly sync", "startsAt": "2026-10-20T10:00:00.000Z", "url": "https://r.example/b/abc"}}
    row = {"id": "b1", "meetingName": "Weekly sync", "startsAt": "2026-10-20T10:00:00.000Z",
           "url": "https://r.example/b/abc", "createdAt": "2026-10-20T08:00:00.000Z"}
    job = {"kind": "meeting-brief", "instance": "t1", "request": "b1", "title": "Weekly sync",
           "url": "https://r.example/b/abc", "starts": "2026-10-20T10:00:00.000Z"}
    assert rivendell_jobs.facts("meeting-brief", "b1", "t1", frame) == job        # the brief's page and its meeting's start
    assert rivendell_jobs.facts("meeting-brief", "b1", "t1", row) == job
    claim = {"requestId": "b1", "status": "IN_PROGRESS", "meetingName": "Weekly sync", "startsAt": "2026-10-20T10:00:00.000Z",
             "url": "https://r.example/b/abc", "repositories": []}
    assert rivendell_jobs.facts("meeting-brief", "b1", "t1", None, claim) == job


# --- titles ---------------------------------------------------------------

def test_title_names_each_kind_the_way_rivendell_does():
    t = rivendell_jobs.title
    assert t({"kind": "review", "title": "feat: x"}) == "feat: x"
    assert t({"kind": "review", "repo": "a/b", "number": 3}) == "Review · a/b #3"
    assert t({"kind": "news", "date": "2026-10-18"}) == "Newspaper · Sun 18 Oct"
    assert t({"kind": "todolist", "title": "Rivendell", "step": "recommendations"}) == "Rivendell · recommendations"
    assert t({"kind": "todolist", "title": "Rivendell", "step": "todolist"}) == "Rivendell · todolist"
    assert t({"kind": "changelog", "title": "Mystical"}) == "Mystical · changelog"
    assert t({"kind": "project-summary", "title": "Rivendell"}) == "Rivendell · summary"
    assert t({"kind": "project-summary"}) is None
    assert t({"kind": "meeting-brief", "title": "Weekly sync"}) == "Weekly sync · brief"
    assert t({"kind": "meeting-brief"}) is None
    assert t({"kind": "impl", "title": "Link PRs to tasks"}) == "Link PRs to tasks"
    # Videos and meeting notes keep their runners' titles; no facts, no title.
    assert t({"kind": "video", "title": "Contract.mov"}) is None
    assert t({"kind": "meeting-notes", "title": "Planning"}) is None
    assert t({"kind": "taskdesc"}) is None


def test_headline_reads_the_paper_in_or_out_of_a_fence():
    assert rivendell_jobs.headline(json.dumps(PAPER)) == "Patterna opens its shop window"
    assert rivendell_jobs.headline("```json\n" + json.dumps(PAPER) + "\n```") == "Patterna opens its shop window"
    assert rivendell_jobs.headline("not a paper") is None
    assert rivendell_jobs.headline('{"lead": null}') is None


# --- reading a job back from its prompt (backfill) -------------------------

def test_classify_reads_a_review_back_from_rivendells_template():
    assert rivendell_jobs.classify(REVIEW_PROMPT) == {
        "kind": "review", "title": "feat: per-project worker access and removal of the Telegram bot",
        "html_url": "https://github.com/ainurhq/ibgroups_operations/pull/81",
        "repo": "ainurhq/ibgroups_operations", "number": 81}


def test_classify_knows_every_template_and_leaves_a_custom_prompt_alone():
    c = rivendell_jobs.classify
    assert c("You are the editor of a small daily newspaper with exactly one reader: M.\n\nEdition: 2026-10-18. It covers…") \
        == {"kind": "news", "date": "2026-10-18"}
    assert c("Task: Create webhook for new PRs\nRepository: ainurhq/rivendell — https://github.com/ainurhq/rivendell\n\n…") \
        == {"kind": "impl", "title": "Create webhook for new PRs", "repo": "ainurhq/rivendell"}
    assert c("You are an experienced technical project manager keeping a software project's task board honest.\n"
             "Project: Rivendell (Rivendell project id 5eebb57e)\n") \
        == {"kind": "todolist", "step": "recommendations", "title": "Rivendell"}
    assert c("You are writing the notes of a meeting the way a good meeting assistant does.\n"
             "Meeting: Planning with Acme\nWhen: 2026-10-15 19:00 UTC") == {"kind": "meeting-notes", "title": "Planning with Acme"}
    assert c("You are given the transcript of a recording a client uploaded to the drive we share with them, "
             "and the screens of it (one image per screen change).\nFile: Contract.mov (length unknown).") \
        == {"kind": "video", "title": "Contract.mov", "step": "transcribe"}
    assert c("You are an experienced software engineer implementing a batch of related tasks for the team.\n"
             "Batch: Unorganized (2 tasks)\nRepository: ainurhq/rivendell — https://github.com/ainurhq/rivendell\n") \
        == {"kind": "impl", "title": "Unorganized", "repo": "ainurhq/rivendell"}
    assert c(SUMMARY_PROMPT) == {"kind": "project-summary", "title": "Rivendell"}
    assert c('You are writing a short summary of what happened in the project "Mystical v2.0".\n\nPeriod: …') \
        == {"kind": "project-summary", "title": "Mystical v2.0"}
    # What it carries can sound like another template: a commit titled "writing the changelog".
    assert c(SUMMARY_PROMPT.replace("Tasks finished: 4…", "Commits: writing the changelog, implementing a task")) \
        == {"kind": "project-summary", "title": "Rivendell"}
    assert c(BRIEF_PROMPT) == {"kind": "meeting-brief", "title": "Weekly sync"}
    # A meeting is named by anyone who invites you, so its title can hold another template's words,
    # and what the brief carries can too: the brief's own opening line wins.
    assert c(BRIEF_PROMPT.replace("Weekly sync", "Review: performing a code review")) \
        == {"kind": "meeting-brief", "title": "Review: performing a code review"}
    assert c(BRIEF_PROMPT.replace("tasks finished: 4…", "commits: writing the changelog, implementing a task")) \
        == {"kind": "meeting-brief", "title": "Weekly sync"}
    assert c("fix the login bug") is None
    assert c(None) is None


def test_backfill_files_older_sessions_once_and_keeps_a_hand_set_title():
    review = _rv_session(REVIEW_PROMPT)
    paper = _rv_session("You are the editor of a small daily newspaper.\n\nEdition: 2026-10-18.",
                        result=json.dumps(PAPER))
    mine = _rv_session(REVIEW_PROMPT, title_manual="my name for it")
    odd = _rv_session("a custom prompt nobody templated")
    clip = _rv_session("You are given the transcript of a recording a client uploaded to the drive we share with them, "
                       "and the screens of it.\nFile: Contract.mov (length unknown).")
    assert rivendell_jobs.backfill() >= 5
    got = {sid: store.get_session(sid) for sid in (review, paper, mine, odd, clip)}
    assert store.parse_job(got[review]["job"])["kind"] == "review"
    assert store.parse_job(got[review]["job"])["request"] == f"req-{review[:8]}"
    assert got[review]["title"] == "feat: per-project worker access and removal of the Telegram bot"
    assert got[paper]["title"] == "Patterna opens its shop window"        # the paper's lead headline
    assert got[mine]["title"] == "my name for it"                         # a hand-set title stays
    assert got[clip]["title"] == "Transcribe · Contract.mov"              # what its runner names a video now
    assert "kind" not in store.parse_job(got[odd]["job"])                 # filed, untagged, never rescanned
    assert rivendell_jobs.backfill() == 0


def test_the_brief_both_uis_read_carries_the_job():
    sid = _rv_session(REVIEW_PROMPT)
    store.set_job(sid, {"kind": "review", "number": 81})
    assert _session_brief(store.get_session(sid))["job"] == {"kind": "review", "number": 81}
    other = store.create_session(next(_chat), "proj")["id"]
    assert _session_brief(store.get_session(other))["job"] is None


# --- the worker files it ----------------------------------------------------

def _worker():
    return rivendell.Worker({"id": "t1", "name": "test", "enable": True, "api_url": "http://api.example:3001",
                             "token": "rvd_t", "ws_url": "", "model": "opus", "workdir": "",
                             "review_timeout": 3600, "impl_timeout": 10800})


def test_a_review_event_ends_up_on_its_session_with_the_pr_as_title(monkeypatch):
    monkeypatch.setattr(rivendell.Worker, "_ack", lambda self, key, state: None)
    w = _worker()
    assert w._handle_message(json.dumps(REVIEW_FRAME).encode()) == "review:r1"
    monkeypatch.setattr(w, "_fetch_prompt", lambda kind_path, rid: {"requestId": "r1", "status": "IN_PROGRESS",
                                                                      "prompt": "review it"})
    assert w._claim("review-requests", "r1")["prompt"] == "review it"
    store.init()
    sid = store.create_session(next(_chat), "/", origin="rivendell:t1")["id"]
    w._track("r1", "review", "ainurhq/ibgroups_operations", sid, label=None, link=None)
    s = store.get_session(sid)
    job = store.parse_job(s["job"])
    assert (job["kind"], job["number"], job["pr_id"]) == ("review", 81, "pr-uuid")
    assert "prompt" not in job and "status" not in job
    assert s["title"] == "feat: per-project worker access" and s["title_source"] == "manual"
    assert s["ref"] == "t1:r1"
    assert w._job_src == {} and w._job_claim == {}                        # nothing held once filed


def test_a_project_summary_event_ends_up_on_its_session_named_for_its_project(monkeypatch):
    monkeypatch.setattr(rivendell.Worker, "_ack", lambda self, key, state: None)
    w = _worker()
    frame = {"type": "project-summary-request", "requestId": "s1", "project": {"id": "p1", "name": "Rivendell"}}
    assert w._handle_message(json.dumps(frame).encode()) == "project-summary:s1"
    monkeypatch.setattr(w, "_fetch_prompt", lambda kind_path, rid: {
        "requestId": "s1", "status": "IN_PROGRESS", "prompt": "summarise it", "projectName": "Rivendell",
        "repositories": []})
    assert w._claim("project-summary-requests", "s1")["prompt"] == "summarise it"
    store.init()
    sid = store.create_session(next(_chat), "/", origin="rivendell:t1")["id"]
    w._track("s1", "project-summary", "Rivendell", sid, label=None, link=None)
    s = store.get_session(sid)
    job = store.parse_job(s["job"])
    assert (job["kind"], job["title"], job["project_id"]) == ("project-summary", "Rivendell", "p1")
    assert s["title"] == "Rivendell · summary" and s["ref"] == "t1:s1"


def test_a_meeting_brief_event_ends_up_on_its_session_named_for_its_meeting(monkeypatch):
    monkeypatch.setattr(rivendell.Worker, "_ack", lambda self, key, state: None)
    w = _worker()
    frame = {"type": "meeting-brief-request", "requestId": "b1",
             "meeting": {"name": "Weekly sync", "startsAt": "2026-10-20T10:00:00.000Z", "url": "https://r.example/b/abc"}}
    assert w._handle_message(json.dumps(frame).encode()) == "meeting-brief:b1"
    monkeypatch.setattr(w, "_fetch_prompt", lambda kind_path, rid: {
        "requestId": "b1", "status": "IN_PROGRESS", "prompt": "brief it", "meetingName": "Weekly sync",
        "startsAt": "2026-10-20T10:00:00.000Z", "url": "https://r.example/b/abc", "repositories": []})
    assert w._claim("meeting-brief-requests", "b1")["prompt"] == "brief it"
    store.init()
    sid = store.create_session(next(_chat), "/", origin="rivendell:t1")["id"]
    w._track("b1", "meeting-brief", "Weekly sync", sid, label=None, link=None)
    s = store.get_session(sid)
    job = store.parse_job(s["job"])
    assert (job["kind"], job["title"], job["url"]) == ("meeting-brief", "Weekly sync", "https://r.example/b/abc")
    assert s["title"] == "Weekly sync · brief" and s["ref"] == "t1:b1"


def test_a_posted_result_is_stamped_on_the_job(monkeypatch):
    w = _worker()
    store.init()
    sid = store.create_session(next(_chat), "/", origin="rivendell:t1")["id"]
    store.set_ref(sid, "t1:r7")
    store.set_job(sid, {"kind": "review"})
    monkeypatch.setattr(w, "_api", lambda path, payload=None, headers=None: {})
    monkeypatch.setattr(w, "_ping_done", lambda *a, **k: None)
    w._post_result("review-requests", "r7", False, "run errored")
    job = store.parse_job(store.get_session(sid)["job"])
    assert (job["kind"], job["outcome"], job["error"]) == ("review", "failed", "run errored")
    assert abs(job["at"] - time.time()) < 60


# --- RUN AGAIN ----------------------------------------------------------------

def test_again_call_files_each_kind_with_rivendells_own_route():
    today = time.strftime("%Y-%m-%d")
    a = rivendell.again_call
    assert a({"kind": "review", "pr_id": "p"}) == ("/review-requests", {"pullRequestId": "p"})
    assert a({"kind": "taskdesc", "task_id": "t"}) == ("/task-description-requests", {"taskId": "t"})
    assert a({"kind": "todolist", "project_id": "p", "step": "recommendations"}) == \
        ("/project-todolists", {"projectId": "p", "kind": "RECOMMENDATIONS"})
    assert a({"kind": "news", "date": today}) == ("/news/reprint", {})
    assert a({"kind": "news", "date": "2026-01-01"}) is None              # only today's paper reprints
    assert a({"kind": "review"}) is None                                   # no PR id, nothing to file
    assert a({"kind": "changelog", "project_id": "p"}) is None
    assert a({"kind": "project-summary", "project_id": "p"}) is None       # asked for again on its project's page
    assert a({"kind": "meeting-brief", "title": "Weekly sync"}) is None    # written again on its brief page
    assert a({"kind": "video"}) is None and a({}) is None


def test_rerun_asks_the_instance_the_job_came_from(monkeypatch):
    w = _worker()
    calls = []
    monkeypatch.setattr(w, "_api", lambda path, payload=None, headers=None: calls.append((path, payload)) or {"id": "r9"})
    monkeypatch.setitem(rivendell._workers, "t1", w)
    store.init()
    sid = store.create_session(next(_chat), "/", origin="rivendell:t1")["id"]
    store.set_job(sid, {"kind": "review", "instance": "t1", "pr_id": "pr-uuid"})
    assert rivendell.rerun(sid) == {"id": "r9"}
    assert calls == [("/review-requests", {"pullRequestId": "pr-uuid"})]
    store.set_job(sid, {"kind": "video", "instance": "t1"})
    try:
        rivendell.rerun(sid)
        raise AssertionError("a video can't run again from here")
    except rivendell.TasksError as e:
        assert e.code == "refused"


def test_the_again_route_relays_and_explains(monkeypatch):
    from bridge.dashboard import server as dash
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    monkeypatch.setattr(rivendell, "rerun", lambda sid: {"id": "r9", "sid": sid})
    h._post_api("/local/rivendell/again", {"session_id": "s1"})
    assert box == {"obj": {"ok": True, "request": {"id": "r9", "sid": "s1"}}, "code": 200}
    h._post_api("/local/rivendell/again", {})
    assert box["code"] == 400

    def refuse(sid):
        raise rivendell.TasksError("refused", "Rivendell can't run this job again from here")
    monkeypatch.setattr(rivendell, "rerun", refuse)
    h._post_api("/local/rivendell/again", {"session_id": "s1"})
    assert box == {"obj": {"error": "Rivendell can't run this job again from here", "code": "refused"}, "code": 400}


def test_backfill_takes_rivendells_folders_too():
    """A meeting draft run by hand in .bridge_uploads/meetings is a job the
    dashboard files under Rivendell jobs; the backfill names it like the runner."""
    store.init()
    sid = store.create_session(next(_chat), "/.bridge_uploads/meetings", origin="bridge")["id"]
    store.start_turn(sid, f"turn-{sid[:12]}", "You are writing the notes of a meeting the way a good meeting "
                     "assistant does.\nMeeting: Collaboration in the UAE\nWhen: 2026-10-15", None)
    mine = store.create_session(next(_chat), "/mystical-assistant", origin="dashboard")["id"]
    rivendell_jobs.backfill()
    s = store.get_session(sid)
    assert store.parse_job(s["job"]) == {"kind": "meeting-notes", "title": "Collaboration in the UAE"}
    assert s["title"] == "Meeting notes · Collaboration in the UAE"
    assert store.get_session(mine)["job"] is None                      # your own sessions are never touched


def test_backfill_files_a_terminal_indexed_run_by_its_title_only():
    """A Rivendell run MOVE brought over as a terminal session has no stored
    prompt; its title opens with the template's words. A session of your own
    that merely starts "You are" is left alone, and asked again next boot."""
    store.init()
    run = store.upsert_native_session("native-" + str(next(_chat)), next(_chat), "/", "/x",
                                      title="You are the editor of a small daily newspaper with exactly o")["id"]
    yours = store.create_session(next(_chat), "/", origin="dashboard")["id"]
    store.rename(yours, "You are a helpful reviewer")
    rivendell_jobs.backfill()
    assert store.parse_job(store.get_session(run)["job"]) == {"kind": "news"}
    assert store.get_session(run)["title"] == "You are the editor of a small daily newspaper with exactly o"
    assert store.get_session(yours)["job"] is None


def test_backfill_files_a_project_summary_by_its_prompt_and_by_its_title():
    """Rivendell's summary template opens with a fixed line: a session that kept its prompt is
    filed by it and named as the worker names it now; one MOVE brought over has only its title,
    the prompt's first 60 characters."""
    store.init()
    kept = _rv_session(SUMMARY_PROMPT)
    moved = store.upsert_native_session("native-" + str(next(_chat)), next(_chat), "/", "/x",
                                        title=SUMMARY_PROMPT[:60])["id"]
    rivendell_jobs.backfill()
    assert store.parse_job(store.get_session(kept)["job"])["kind"] == "project-summary"
    assert store.get_session(kept)["title"] == "Rivendell · summary"
    assert store.parse_job(store.get_session(moved)["job"]) == {"kind": "project-summary"}
    assert store.get_session(moved)["title"] == SUMMARY_PROMPT[:60]


def test_backfill_files_a_meeting_brief_by_its_prompt_and_by_its_title():
    """Rivendell's brief template opens with a fixed line: a session that kept its prompt is
    filed by it and named as the worker names it now; one MOVE brought over has only its title,
    the prompt's first 60 characters."""
    store.init()
    kept = _rv_session(BRIEF_PROMPT)
    moved = store.upsert_native_session("native-" + str(next(_chat)), next(_chat), "/", "/x",
                                        title=BRIEF_PROMPT[:60])["id"]
    rivendell_jobs.backfill()
    assert store.parse_job(store.get_session(kept)["job"])["kind"] == "meeting-brief"
    assert store.get_session(kept)["title"] == "Weekly sync · brief"
    assert store.parse_job(store.get_session(moved)["job"]) == {"kind": "meeting-brief"}
    assert store.get_session(moved)["title"] == BRIEF_PROMPT[:60]


def test_a_reattached_batch_keeps_its_job_and_your_name_for_it(monkeypatch):
    """_reattach tracks a queue-mode batch again after a restart: its session
    already has its job, so nothing is refiled and a rename of yours stands."""
    w = _worker()
    store.init()
    sid = store.create_session(next(_chat), "/", origin="rivendell:t1")["id"]
    store.set_job(sid, {"kind": "impl", "title": "Batch A", "outcome": "completed"})
    store.rename(sid, "my batch")
    w._job_src["b1"] = {"batch": {"name": "Something else"}}
    w._track("b1", "impl", "acme/app", sid, label=None, link=None)
    s = store.get_session(sid)
    assert store.parse_job(s["job"]) == {"kind": "impl", "title": "Batch A", "outcome": "completed"}
    assert s["title"] == "my batch"
