"""The tracker routes on both servers, and the update turn's argv.

Socket-free via Handler.__new__ (the test_design_endpoints.py pattern). The
tracker itself is stubbed at trackers._http; what is under test is the wiring:
the link on project settings, the masked connection list, the task view with
the session's key, and — the one that matters — that an update turn reaches
`claude` with manual mode, the ask rule and its MCP server re-declared.
Run: python -m pytest tests/test_tracker_endpoints.py -v"""

import json
import os
import subprocess
import sys
from urllib.parse import parse_qs, urlparse

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import browser, config, project_config, runner, store, toolsets, trackers  # noqa: E402
from bridge.dashboard import server as dash  # noqa: E402
from bridge.miniapp import server as mini  # noqa: E402

store.init()
CHAT = config.DASH_CHAT_ID


def _dash():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


def dget(path):
    h, box = _dash()
    u = urlparse(path)
    h._get_api(u.path, parse_qs(u.query))
    return box


def dpost(path, body):
    h, box = _dash()
    h._post_api(path, body)
    return box


def _fake_http(table):
    def http(method, url, auth, body=None, timeout=15):
        for frag, ans in table.items():
            if frag in url:
                return json.loads(json.dumps(ans))
        raise trackers.TrackerError("HTTP 404 from test")
    return http


TW = {"/me.json": {"person": {"id": "77", "first-name": "Mah", "last-name": "E"}},
      "/tasks.json?includeCompletedTasks": {"tasks": [
          {"id": 4512, "name": "Fix login redirect", "dueDate": "20260908", "assignees": [{"id": 77}]}],
          "included": {"users": {"77": {"firstName": "Mah", "lastName": "E"}}},
          "meta": {"page": {"hasMore": False}}}}


@pytest.fixture
def repo(tmp_path, monkeypatch):
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "pc.json"))
    monkeypatch.setattr(trackers, "_path", lambda: str(tmp_path / "trackers.json"))
    monkeypatch.setattr(trackers, "_mcp_ready", lambda name: True)
    monkeypatch.setattr(trackers, "_http", _fake_http(TW))
    monkeypatch.setattr(toolsets, "servers", lambda refresh=False: [{"name": "teamwork", "rule": "mcp__teamwork"}])
    trackers.invalidate()
    d = os.path.join(config.BASE_PATH, tmp_path.name)
    os.makedirs(d, exist_ok=True)
    subprocess.run(["git", "init", "-q", "-b", "tw-4512-fix-login", d], check=True)
    # an unborn branch has no name to read; one empty commit births it
    subprocess.run(["git", "-C", d, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q",
                    "--allow-empty", "-m", "init"], check=True)
    return d


def _linked(repo):
    c = trackers.add_connection("teamwork", "ACME", "acme.teamwork.com", "", "tok")
    project_config.set_tracker(browser.rel(repo), f"{c['id']}:901", "ACME board")
    return c


# --- dashboard ---------------------------------------------------------------

def test_connections_are_listed_masked_and_added_or_refused(repo):
    assert dget("/local/trackers")["obj"] == {"connections": []}
    box = dpost("/local/trackers", {"op": "add", "kind": "teamwork", "name": "ACME",
                                    "site": "acme.teamwork.com", "token": "tw-secret"})
    assert box["code"] == 200 and box["obj"]["connection"]["token"] == "…cret"
    assert dget("/local/trackers")["obj"]["connections"][0]["name"] == "ACME"
    box = dpost("/local/trackers", {"op": "add", "kind": "jira", "name": "x", "site": "x.atlassian.net", "token": "t"})
    assert box["code"] == 400 and "email" in box["obj"]["error"]
    assert dpost("/local/trackers", {"op": "frob"})["code"] == 400


def test_project_settings_carry_the_link(repo):
    c = _linked(repo)
    body = dget(f"/local/project/settings?cwd={repo}")["obj"]
    assert body["tracker"] == f"{c['id']}:901" and body["tracker_label"] == "ACME board"
    body = dpost("/local/project/settings", {"cwd": repo, "tracker": ""})["obj"]
    assert body["tracker"] is None and body["tracker_label"] is None
    assert project_config.tracker(browser.rel(repo)) is None


def test_task_view_marks_the_sessions_task(repo):
    _linked(repo)
    sid = store.create_session(CHAT, browser.rel(repo), origin="dashboard", cwd=repo)["id"]
    body = dget(f"/local/tracker/tasks?project={browser.rel(repo)}&session_id={sid}")["obj"]
    assert body["linked"] and body["tasks"][0]["key"] == "tw-4512" and body["session_key"] == "tw-4512"
    assert dget("/local/tracker/tasks?project=/../../etc")["code"] == 400
    assert dget(f"/local/tracker/statuses?project={browser.rel(repo)}&key=tw-4512")["obj"]["statuses"][0] == {
        "id": "complete", "name": "Complete"}


def test_update_route_starts_a_manual_turn_with_the_ask_rule(repo, monkeypatch):
    _linked(repo)
    sid = store.create_session(CHAT, browser.rel(repo), origin="dashboard", cwd=repo)["id"]
    seen = {}

    class J:
        id, store_session_id = "job-1", sid

    def start(chat_id, prompt, images, project, **kw):
        seen.update(chat_id=chat_id, prompt=prompt, project=project, **kw)
        return J()
    monkeypatch.setattr(runner, "start_streaming_job", start)
    box = dpost("/local/tracker/update", {"project": browser.rel(repo), "session_id": sid,
                                          "status_id": "complete", "status_name": "Complete", "note": "brief"})
    assert box["obj"] == {"job_id": "job-1", "session_id": sid}
    assert seen["permission_mode"] == "manual" and seen["mcp_on"] == "teamwork" and seen["session_id"] == sid
    assert seen["extra_args"] == ["--settings", '{"permissions": {"ask": ["mcp__teamwork"]}}']
    assert "task 4512" in seen["prompt"] and "twprojects-complete_task" in seen["prompt"]  # key came off the branch
    assert "Note from me: brief" in seen["prompt"]


def test_update_route_refuses_what_it_cannot_do(repo, monkeypatch):
    assert dpost("/local/tracker/update", {"project": browser.rel(repo), "session_id": "x"})["obj"]["error"] \
        == "no tracker linked to this project"
    _linked(repo)
    assert dpost("/local/tracker/update", {"project": browser.rel(repo), "session_id": "nope"})["code"] == 400
    sid = store.create_session(CHAT, browser.rel(repo), origin="dashboard", cwd=repo)["id"]
    monkeypatch.setattr(toolsets, "servers", lambda refresh=False: [])
    box = dpost("/local/tracker/update", {"project": browser.rel(repo), "session_id": sid})
    assert box["code"] == 400 and "claude mcp add --transport http teamwork" in box["obj"]["error"]
    monkeypatch.setattr(toolsets, "servers", lambda refresh=False: [{"name": "teamwork", "rule": "mcp__teamwork"}])
    monkeypatch.setattr(runner, "start_streaming_job", lambda *a, **k: None)
    box = dpost("/local/tracker/update", {"project": browser.rel(repo), "session_id": sid})
    assert box["code"] == 409 and box["obj"]["error"] == "busy"


# --- mini app ----------------------------------------------------------------

def test_miniapp_reads_the_active_projects_tasks(repo, monkeypatch):
    from bridge import state
    _linked(repo)
    monkeypatch.setattr(state, "project_dir", lambda chat_id: repo)
    h = mini.Handler.__new__(mini.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    h._auth = lambda: CHAT
    h.path = "/api/tracker/tasks"
    h.do_GET()
    assert box["obj"]["tasks"][0]["key"] == "tw-4512" and box["obj"]["session_key"] == ""
    h.path = "/api/tracker/statuses?key=tw-4512"
    h.do_GET()
    assert box["obj"]["statuses"][0]["id"] == "complete"


# --- the argv the update turn actually gets ----------------------------------

def test_update_turn_argv_has_manual_mode_the_ask_rule_and_the_server(repo, monkeypatch):
    sid = store.create_session(CHAT, browser.rel(repo), origin="dashboard", cwd=repo)["id"]
    seen = {}

    class Popen:
        def __init__(self, cmd, **kw):
            seen["cmd"] = cmd
            raise FileNotFoundError
    monkeypatch.setattr(runner.subprocess, "Popen", Popen)
    monkeypatch.setattr(toolsets, "ready", lambda: True)
    monkeypatch.setattr(runner, "_configured_mcp_servers",
                        lambda cwd: {"teamwork": {"type": "http", "url": "https://mcp.ai.teamwork.com"}})
    job = runner.Job("job-argv", CHAT, sid)
    job.resume_id, job.new_session = "11111111-2222-3333-4444-555555555555", True
    job.mcp_on, job.extra_args = "teamwork", ["--settings", '{"permissions": {"ask": ["mcp__teamwork"]}}']
    runner._run_streaming(job, "post it", [], repo, None, None, "manual", None)
    cmd = seen["cmd"]
    assert cmd[cmd.index("--permission-mode") + 1] == "manual"
    assert json.loads(cmd[cmd.index("--settings") + 1]) == {"permissions": {"ask": ["mcp__teamwork"]}}
    assert "teamwork" in json.loads(cmd[cmd.index("--mcp-config") + 1])["mcpServers"]
    assert "--strict-mcp-config" in cmd
    assert job.status == "error"                       # the fake spawn, not the argv


def test_the_digest_rides_the_once_per_session_pack(monkeypatch):
    monkeypatch.setattr(runner, "_graph_pack_for", lambda *a, **k: "")
    monkeypatch.setattr(runner, "_tasks_digest_for", lambda project, cwd: f"DIGEST for {project}")
    sid = "22222222-2222-3333-4444-555555555555"
    first = runner._base_cmd("hi", CHAT, stream=False, claude_session_id=sid, new_session=True, project="/repo")
    assert "DIGEST for /repo" in first[first.index("--append-system-prompt") + 1]
    second = runner._base_cmd("hi", CHAT, stream=False, claude_session_id=sid, project="/repo")
    assert "DIGEST" not in second[second.index("--append-system-prompt") + 1]


def test_an_mcp_call_is_shown_whole_on_its_card():
    d = runner._mcp_detail({"object": {"type": "tasks", "id": 4512}, "content_type": "TEXT",
                            "body": "Fixed the loop.\n\nPR: https://x/1"})
    assert d == 'object: {"type": "tasks", "id": 4512}\ncontent_type: TEXT\nbody:\nFixed the loop.\n\nPR: https://x/1'
