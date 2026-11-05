"""A session whose project folder is gone (moved, renamed, deleted): it stays in the
lists under its project, marked, and MOVE TO PROJECT puts it in one of yours. A run
never borrows another project's folder for it (2026-11-05: nr-kantoor moved into a
backup folder, and its session's next turn ran in osanwe, the project the composer
had open). A removed worktree still falls back to its project's own folder.
Run: python -m pytest tests/test_session_folder_gone.py -q"""

import os
import time
import uuid

from bridge import browser, config, runner, state, store, team, titler
from bridge.dashboard import server as dash

store.init()
CHAT = config.DASH_CHAT_ID


def _dash():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


def dget(path, qs=None):
    h, box = _dash()
    h._get_api(path, qs or {})
    return box


def dpost(path, body):
    h, box = _dash()
    h._post_api(path, body)
    return box


def _proj(name=None) -> str:
    rel = f"/org/{name or 'p-' + uuid.uuid4().hex[:8]}"
    os.makedirs(os.path.join(config.BASE_PATH, rel.lstrip("/")), exist_ok=True)
    return rel


def _gone(rel=None) -> str:
    """A project rel whose folder isn't there (any more)."""
    return rel or f"/org/gone-{uuid.uuid4().hex[:8]}"


def _abs(rel: str) -> str:
    return os.path.join(config.BASE_PATH, rel.lstrip("/"))


def _run(monkeypatch, sid, project=None):
    """Start a run on `sid` the way the dashboard does, the composer showing `project`; return
    (job, the folder _run_streaming got)."""
    got = []
    monkeypatch.setattr(titler, "kick", lambda *a, **k: None)
    monkeypatch.setattr(runner, "_ensure_journal_thread", lambda: None)   # no writer left behind for later tests
    monkeypatch.setattr(runner, "_jobs", {})
    monkeypatch.setattr(runner, "_run_streaming", lambda job, prompt, paths, cwd, *a: got.append(cwd))
    job = runner.start_streaming_job(CHAT, "go on", [], project, session_id=sid, origin="dashboard")
    for _ in range(200):
        if got:
            break
        time.sleep(0.01)
    state.release_run(sid)
    return job, got[0]


def test_gone_is_a_real_project_that_moved_not_base_home_or_a_worktree():
    assert browser.gone(_gone("/org/nr-kantoor"))
    assert not browser.gone(_proj())
    for rel in ("/", "", "~", "~/old-thing", "/.worktrees/repo/feat-x"):
        assert not browser.gone(rel), rel


def test_a_session_of_a_moved_project_stays_listed_and_marked(monkeypatch):
    moved = store.create_session(CHAT, _gone(), origin="dashboard", cwd=_abs(_gone()))["id"]
    here = store.create_session(CHAT, _proj(), origin="dashboard")["id"]
    worktree = store.create_session(CHAT, "/.worktrees/repo/feat-gone", origin="dashboard")["id"]
    rows = {s["id"]: s for s in dget("/local/sessions")["obj"]["sessions"]}
    assert rows[moved]["missing"] is True and rows[here]["missing"] is False
    assert worktree not in rows                               # a removed worktree stays out, as before


def test_a_run_never_borrows_the_open_projects_folder(monkeypatch):
    """Its own folder gone and its project gone: refused, with where it was and what to do."""
    gone = _gone()
    sid = store.create_session(CHAT, gone, origin="dashboard", cwd=_abs(gone))["id"]
    job, cwd = _run(monkeypatch, sid, project=_abs(_proj()))
    assert job.refusal and "folder is gone" in job.refusal and gone.split("/")[-1] in job.refusal
    assert "Move to project…" in job.refusal
    assert cwd == config.BASE_PATH                            # bookkeeping only: nothing spawns on a refusal
    assert store.get_session(sid)["cwd"] == _abs(gone)        # not rewritten to wherever it would have run


def test_a_removed_worktree_runs_in_its_projects_own_folder_not_the_open_one(monkeypatch):
    mine = _proj()
    sid = store.create_session(CHAT, mine, origin="dashboard", cwd=_abs("/.worktrees/x/removed-zzz"))["id"]
    job, cwd = _run(monkeypatch, sid, project=_abs(_proj()))
    assert job.refusal is None and cwd == os.path.realpath(_abs(mine))


def test_move_to_project_takes_the_session_and_its_paths_along(monkeypatch):
    gone, dest = _gone(), _proj()
    sid = store.create_session(CHAT, gone, origin="dashboard", cwd=_abs(gone))["id"]
    tid = uuid.uuid4().hex
    store.start_turn(sid, tid, f"look at {_abs(gone)}/src", [])
    r = dpost(f"/local/sessions/{sid}/move", {"project": dest})
    assert r["code"] == 200 and r["obj"]["session"]["project"] == dest and r["obj"]["session"]["missing"] is False
    s = store.get_session(sid)
    assert s["project"] == dest and s["cwd"] == os.path.realpath(_abs(dest))
    assert store.transcript(sid)["turns"][0]["prompt"] == f"look at {os.path.realpath(_abs(dest))}/src"


def test_move_to_project_refuses_what_isnt_a_project_and_a_teammates_session():
    sid = store.create_session(CHAT, _gone(), origin="dashboard")["id"]
    for bad in (_gone(), "/", "../../etc", None):
        assert dpost(f"/local/sessions/{sid}/move", {"project": bad})["code"] == 400, bad
    theirs = store.create_session(CHAT, "/", origin="team:prod", cwd=config.BASE_PATH)["id"]
    assert dpost(f"/local/sessions/{theirs}/move", {"project": _proj()}) == {"code": 409, "obj": {"error": team.REFUSAL}}
    assert dpost("/local/sessions/nope/move", {"project": _proj()})["code"] == 404


def test_continue_here_route_makes_the_session_and_answers_its_brief(monkeypatch):
    rel = _proj()
    made = store.create_session(CHAT, rel, origin="dashboard", cwd=_abs(rel))["id"]
    seen = []
    monkeypatch.setattr(team, "adopt", lambda share, project, cwd=None: seen.append((share, project, cwd)) or made)
    r = dpost("/local/rivendell/team/adopt", {"id": "s1", "project": rel, "cwd": "/somewhere"})
    assert r["code"] == 200 and r["obj"]["session"]["id"] == made and seen == [("s1", rel, "/somewhere")]

    def boom(*a, **k):
        raise team.TeamError("That share is gone.")
    monkeypatch.setattr(team, "adopt", boom)
    assert dpost("/local/rivendell/team/adopt", {"id": "s1", "project": rel}) == {
        "code": 400, "obj": {"error": "That share is gone."}}


def test_the_team_tab_lists_what_is_still_coming_in(monkeypatch):
    monkeypatch.setattr(team, "receiving", lambda: [{"id": "s1", "title": "Big", "from": "Mahdi", "stage": "download", "pct": 40}])
    monkeypatch.setattr(team, "_cached", lambda key, path: [])
    assert dget("/local/rivendell/team")["obj"]["receiving"] == [
        {"id": "s1", "title": "Big", "from": "Mahdi", "stage": "download", "pct": 40}]
