"""The asking side of device runs (bridge/device_ask.py): the snapshot of a
checkout, filing a run on Rivendell, cancelling it, and the hand-back of how it
ended: a turn in the chat that asked, a Device run section in the PR, and
Rivendell told it was delivered.

Nothing here reaches a real process, gh, Rivendell, Telegram, the queue or the
web: every default refuses and fails the test (the `guard` fixture). The one
exception is git in the snapshot tests, run for real by the `git` fixture, only
inside the test's temp dir and with HOME and git's global config pointed there.
Run: python -m pytest tests/test_device_ask.py -v
"""

import gzip
import io
import json
import os
import re
import socket
import stat
import subprocess
import tarfile
import threading
import time
import types
import urllib.error
import urllib.request
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from bridge import (config, device_ask as da, github, queue_manager, rivendell, rivendell_instances,
                    store, telegram)
from bridge.dashboard import server as dash

RID = "0f8e7d6c-5b4a-4392-8170-6e5d4c3b2a19"
RID2 = "1a2b3c4d-5e6f-4a1b-9c2d-3e4f5a6b7c8d"
RID3 = "2b3c4d5e-6f70-4b1c-8d2e-4f5a6b7c8d9e"
DEVICE = "7c50be1739dfacbb"
MAC = "Mahziyar's MacBook Pro"
FILE = "/plugin/device-run-requests"
INST = {"id": "t1", "name": "test", "enable": True, "api_url": "http://api.example",
        "token": "rvd_bridge_token", "device_token": "sk-ant-oat01-mahdis-device-token"}
SNAP = {"tar_gz": b"\x1f\x8b the code", "repository": "ainurhq/app", "commitSha": "4e1c9a2", "dirty": True,
        "gitAuthorName": "Mahdi", "gitAuthorEmail": "mahdi@example.com"}
PNG = b"\x89PNG\r\n\x1a\n"
URL1 = "https://api.example/public/device-run-screens/s1"
URL2 = "https://api.example/public/device-run-screens/s2"
START, END = "<!-- mystical:device-run -->", "<!-- /mystical:device-run -->"
REPORT = "The app builds and opens. Tapping a lesson opens its sheet without the crash."
FRAME = {"requestId": RID, "status": "COMPLETED", "device": {"id": DEVICE, "name": MAC}, "result": REPORT,
         "error": None, "screens": [{"id": "s1", "index": 1, "caption": "Home", "url": URL1},
                                    {"id": "s2", "index": 2, "caption": "The lesson sheet", "url": URL2}],
         "task": {"key": "NR-31", "title": "Lesson sheet", "url": "https://rivendell.example/tasks/1"},
         "pullRequest": {"repository": "ainurhq/app", "number": 57}, "minutes": 7}
HEAD = f"The device run you sent finished on {MAC} (7 min): Done."
TEXT = f"{HEAD}\n\n{REPORT}\n\nIt is posted on NR-31. The PR description has it too."
SECTION = (f"### Device run on {MAC}\n\n{REPORT}\n\n"
           f"![Home]({URL1})\n![The lesson sheet]({URL2})")
_REAL_POPEN = subprocess.Popen


@pytest.fixture(autouse=True)
def guard(monkeypatch, tmp_path):
    """Every default that leaves the process refuses, and one reached (on any
    thread) fails the test. Telegram and the queue are recorded instead. The run
    records and the uploads live in the test's temp dir, and the only Rivendell
    instance is INST."""
    reached = []

    def refuse(*a, **kw):
        reached.append(a)
        raise AssertionError("reached without a fake: %r" % (a,))
    monkeypatch.setattr(da.snapshot, "__defaults__", (refuse,))
    monkeypatch.setattr(subprocess, "run", refuse)
    monkeypatch.setattr(subprocess, "Popen", refuse)
    monkeypatch.setattr(github, "_run", refuse)
    monkeypatch.setattr(rivendell.Worker, "_api", refuse)
    monkeypatch.setattr(rivendell.Worker, "_api_put_bytes", refuse)
    monkeypatch.setattr(urllib.request, "urlopen", refuse)
    sent = types.SimpleNamespace(telegram=[], turns=[])
    monkeypatch.setattr(telegram, "send", lambda chat, text, reply_markup=None: sent.telegram.append((chat, text)))
    monkeypatch.setattr(queue_manager, "enqueue", lambda sid, **kw: sent.turns.append((sid, kw)) or "q1")
    monkeypatch.setattr(da, "_path", lambda: str(tmp_path / "device_runs.json"))
    monkeypatch.setattr(config, "UPLOAD_DIR", str(tmp_path / "uploads"))
    monkeypatch.setattr(rivendell_instances, "raw_instances", lambda: [dict(INST)])
    store.init()                      # conftest's temp DB; idempotent
    da._busy.clear()
    yield sent
    assert not reached, "reached without a fake: %r" % reached


@pytest.fixture
def riv(monkeypatch):
    """Rivendell as rivendell.Worker reaches it: each call is recorded as
    (instance id, bearer token, path, body); `answers` and `errors` are by path."""
    r = types.SimpleNamespace(calls=[], puts=[], errors={}, answers={
        FILE: {"id": RID, "sharedDevicesOnline": 1, "device": {"id": DEVICE, "name": MAC}}})

    def api(worker, path, payload=None, headers=None):
        r.calls.append((worker.inst["id"], worker.token, path, payload))
        if path in r.errors:
            raise r.errors[path]
        return r.answers.get(path, {})

    def put(worker, path, data, content_type, headers=None):
        r.puts.append((worker.token, path, data, content_type))
        if path in r.errors:
            raise r.errors[path]
    monkeypatch.setattr(rivendell.Worker, "_api", api)
    monkeypatch.setattr(rivendell.Worker, "_api_put_bytes", put)
    r.paths = lambda: [c[2] for c in r.calls]
    return r


@pytest.fixture
def chat(tmp_path):
    """A chat's session, bound to a Claude session id as a run binds it."""
    store.init()
    s = store.create_session(555, "ainurhq/app", cwd=str(tmp_path / "app"))
    csid = str(uuid.uuid4())
    store.set_claude_session_id(s["id"], csid)
    return types.SimpleNamespace(id=s["id"], csid=csid, cwd=s["cwd"])


@pytest.fixture
def snap(monkeypatch):
    """snapshot() as a stub: the folders it was asked for."""
    folders = []

    def fake(folder, run=None):
        folders.append(folder)
        return dict(SNAP)
    monkeypatch.setattr(da, "snapshot", fake)
    return folders


class Reply:
    def __init__(self, data):
        self.data = data

    def read(self, n=-1):
        return self.data if n < 0 else self.data[:n]

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture
def web(monkeypatch):
    """Screen downloads: each URL answers a PNG ending in its own URL."""
    fetched = []

    def urlopen(url, timeout=None):
        fetched.append(url)
        return Reply(PNG + url.encode())
    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    return fetched


class Gh:
    """`gh` as github._run runs it: `pr view` answers `body`, `pr edit` keeps the
    file it was handed. Anything else is a call no test expects."""

    def __init__(self, body=""):
        self.body, self.calls, self.written = body, [], None

    def __call__(self, *args, cwd=None, timeout=15):
        self.calls.append((args, timeout))
        if args[:3] == ("gh", "pr", "view"):
            return 0, self.body + "\n", ""
        if args[:3] == ("gh", "pr", "edit"):
            with open(args[args.index("--body-file") + 1], encoding="utf-8") as f:
                self.written = f.read()
            return 0, "", ""
        raise AssertionError("unexpected gh call: %r" % (args,))


def _record(session, **kw):
    return {"instance": "t1", "session": session, "task": "NR-31", "pr": None, "device": None,
            "started_on": None, **kw}


def _wait_until(pred, timeout=5.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        if pred():
            return
        time.sleep(0.01)
    raise AssertionError("condition not met in time")


# --- snapshot: real git, inside tmp_path only ----------------------------------------------------

@pytest.fixture
def git(tmp_path, monkeypatch):
    """A runner for snapshot() that runs real git, only as `git -C <a folder in
    tmp_path>`, with HOME, the global and XDG config pointed into tmp_path and the
    system config off, so the developer's git config is never read or written."""
    home = tmp_path / "home"
    home.mkdir()
    for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_COMMON_DIR"):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("HOME", str(home))
    monkeypatch.setenv("GIT_CONFIG_GLOBAL", str(home / ".gitconfig"))
    monkeypatch.setenv("XDG_CONFIG_HOME", str(home / ".config"))
    monkeypatch.setenv("GIT_CONFIG_NOSYSTEM", "1")
    root = os.path.realpath(tmp_path) + os.sep
    calls = []

    def run(argv, **kw):
        assert argv[:2] == ["git", "-C"] and os.path.realpath(argv[2]).startswith(root), argv
        calls.append(argv)
        with _REAL_POPEN(argv, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE) as p:
            out, err = p.communicate(timeout=60)
        return subprocess.CompletedProcess(argv, p.returncode, out, err)
    run.calls = calls
    return run


def _repo(git, path, origin="git@github.com:ainurhq/app.git"):
    """A checkout with one commit (app.txt "v1"), Mahdi's identity and `origin`."""
    path.mkdir()

    def g(*args):
        return git(["git", "-C", str(path), *args])
    assert g("init", "-q").returncode == 0
    g("config", "user.name", "Mahdi")
    g("config", "user.email", "mahdi@example.com")
    g("config", "commit.gpgsign", "false")
    if origin:
        g("remote", "add", "origin", origin)
    (path / "app.txt").write_text("v1\n")
    g("add", "app.txt")
    assert g("commit", "-q", "-m", "first").returncode == 0
    return g


def _untar(tar_gz):
    """Every member by name: a file's bytes, None for anything else (a link, a folder)."""
    with tarfile.open(fileobj=io.BytesIO(gzip.decompress(tar_gz))) as t:
        return {m.name: t.extractfile(m).read() if m.isfile() else None for m in t.getmembers()}


def test_a_checkout_with_changes_packs_them_with_its_env_files(git, tmp_path):
    repo = tmp_path / "app"
    g = _repo(git, repo)
    (repo / "app.txt").write_text("v2, not committed yet\n")
    (repo / ".env").write_text("API_KEY=dev\n")
    (repo / ".env.local").write_text("LOCAL=1\n")
    (repo / "notes.txt").write_text("untracked, and no env file\n")
    (repo / "sub").mkdir()
    (repo / "sub" / ".env").write_text("NESTED=1\n")
    (tmp_path / "elsewhere").write_text("a file outside the checkout\n")
    os.symlink(tmp_path / "elsewhere", repo / ".env.link")

    got = da.snapshot(str(repo / "sub"), run=git)      # from a subfolder: the whole checkout goes

    files = _untar(got["tar_gz"])
    assert files["app.txt"] == b"v2, not committed yet\n"
    assert files[".env"] == b"API_KEY=dev\n" and files[".env.local"] == b"LOCAL=1\n"
    assert not {"notes.txt", "sub/.env", ".env.link"} & set(files), "root .env* files only, and no links"
    head = g("rev-parse", "HEAD").stdout.decode().strip()
    assert {k: v for k, v in got.items() if k != "tar_gz"} == {
        "repository": "ainurhq/app", "commitSha": head, "dirty": True,
        "gitAuthorName": "Mahdi", "gitAuthorEmail": "mahdi@example.com"}


def test_a_clean_checkout_packs_its_head(git, tmp_path):
    _repo(git, tmp_path / "app", origin="https://github.com/ainurhq/app")
    got = da.snapshot(str(tmp_path / "app"), run=git)
    assert _untar(got["tar_gz"]) == {"app.txt": b"v1\n"}
    assert got["dirty"] is False and got["repository"] == "ainurhq/app"


@pytest.mark.parametrize("where", ["a folder", "missing", "empty"])
def test_a_folder_that_isnt_a_git_checkout_is_refused(git, tmp_path, where):
    (tmp_path / "plain").mkdir()
    folder = {"a folder": str(tmp_path / "plain"), "missing": str(tmp_path / "nope"), "empty": ""}[where]
    with pytest.raises(da.DeviceAskError, match=r"^This folder isn't a git checkout\.$"):
        da.snapshot(folder, run=git)
    if where != "a folder":
        assert git.calls == [], "nothing to ask git about"


@pytest.mark.parametrize("origin", ["git@gitlab.com:ainurhq/app.git", None])
def test_an_origin_that_isnt_github_is_refused(git, tmp_path, origin):
    _repo(git, tmp_path / "app", origin=origin)
    with pytest.raises(da.DeviceAskError, match=r"^Its origin isn't a GitHub repository\.$"):
        da.snapshot(str(tmp_path / "app"), run=git)


def test_a_pack_over_the_limit_is_refused(git, tmp_path, monkeypatch):
    g = _repo(git, tmp_path / "app")
    (tmp_path / "app" / "big.bin").write_bytes(os.urandom(4096))
    g("add", "big.bin")
    g("commit", "-q", "-m", "big")
    monkeypatch.setattr(da, "_SNAPSHOT_MAX", 1024)
    with pytest.raises(da.DeviceAskError, match=r"^Your code packs to \d+\.\d MB; device runs take up to 9 MB\.$"):
        da.snapshot(str(tmp_path / "app"), run=git)


# --- start ----------------------------------------------------------------------------------------

def test_start_files_the_run_with_the_instances_token_and_uploads_the_code(riv, snap, chat):
    got = da.start(chat.csid, "Test the lesson planner on the iOS simulator", "NR-31", None, DEVICE, None)

    assert got == {"id": RID, "device": MAC, "sentence": f"Sent to {MAC}."}
    assert snap == [chat.cwd], "this session's own folder by default"
    assert riv.calls == [("t1", "rvd_bridge_token", FILE, {
        "request": "Test the lesson planner on the iOS simulator", "repositoryFullName": "ainurhq/app",
        "commitSha": "4e1c9a2", "dirty": True, "gitAuthorName": "Mahdi", "gitAuthorEmail": "mahdi@example.com",
        "claudeToken": INST["device_token"], "taskKey": "NR-31", "deviceId": DEVICE})]
    assert riv.puts == [("rvd_bridge_token", f"{FILE}/{RID}/code", SNAP["tar_gz"], "application/octet-stream")]
    assert da._runs() == {RID: _record(chat.id, device=MAC)}
    assert stat.S_IMODE(os.stat(da._path()).st_mode) == 0o600
    assert INST["device_token"] not in open(da._path()).read()


@pytest.mark.parametrize("created, device, sentence", [
    ({"sharedDevicesOnline": 1, "device": {"id": DEVICE, "name": MAC}}, DEVICE, f"Sent to {MAC}."),
    ({"sharedDevicesOnline": 3, "device": None}, None, "Sent to the shared devices (3 on)."),
    ({"sharedDevicesOnline": 0, "device": None}, None, "No shared device is on; it starts when one connects."),
])
def test_start_says_where_the_run_went(riv, snap, chat, created, device, sentence):
    riv.answers[FILE] = {"id": RID, **created}
    assert da.start(chat.csid, "Test it", "NR-31", None, device, None)["sentence"] == sentence


@pytest.mark.parametrize("given, repository", [("ainurhq/web#57", "ainurhq/web"), ("#57", "ainurhq/app"),
                                               ("https://github.com/ainurhq/web/pull/57", "ainurhq/web")])
def test_start_takes_a_pull_request_in_each_form(riv, snap, chat, given, repository):
    assert da.start(chat.csid, "Test it", None, given, None, "/tmp/x")["id"] == RID
    assert snap == ["/tmp/x"]
    assert riv.calls[0][3]["pullRequest"] == {"repository": repository, "number": 57}
    assert "taskKey" not in riv.calls[0][3] and "deviceId" not in riv.calls[0][3]
    assert da._runs()[RID]["pr"] == f"{repository}#57"


def test_start_without_a_device_token_says_where_to_save_one(riv, snap, chat, monkeypatch):
    monkeypatch.setattr(rivendell_instances, "raw_instances", lambda: [{**INST, "device_token": ""}])
    got = da.start(chat.csid, "Test it", "NR-31", None, None, None)
    assert got == {"id": None, "device": None,
                   "sentence": "Save your Claude token for device runs in Settings › Plugins first."}
    assert riv.calls == [] and snap == []


@pytest.mark.parametrize("task, pr", [(None, None), ("not a key", None), (None, "57 please")])
def test_start_needs_a_task_key_or_a_pull_request(riv, snap, chat, task, pr):
    got = da.start(chat.csid, "Test it", task, pr, None, None)
    assert got["id"] is None and got["sentence"]
    assert riv.calls == [] and snap == []


def test_a_snapshot_that_fails_files_nothing(riv, chat, monkeypatch):
    def refused(folder, run=None):
        raise da.DeviceAskError("Its origin isn't a GitHub repository.")
    monkeypatch.setattr(da, "snapshot", refused)
    got = da.start(chat.csid, "Test it", "NR-31", None, None, None)
    assert got["sentence"] == "Its origin isn't a GitHub repository."
    assert riv.calls == [] and riv.puts == [] and da._runs() == {}


def test_a_refused_task_is_never_said_to_exist(riv, snap, chat):
    riv.errors[FILE] = urllib.error.HTTPError("http://api" + FILE, 403, "Forbidden", None, None)
    got = da.start(chat.csid, "Test it", "NR-404", None, None, None)
    assert got["sentence"] == "Rivendell refused: you can't see that task or pull request, or it doesn't exist."
    assert riv.puts == [] and da._runs() == {}


def test_an_upload_that_fails_calls_the_run_off(riv, snap, chat):
    """No run may sit waiting with the token for code that never came."""
    riv.errors[f"{FILE}/{RID}/code"] = urllib.error.URLError("timed out")
    got = da.start(chat.csid, "Test it", "NR-31", None, None, None)
    assert got["id"] is None and got["sentence"].startswith("The code didn't upload")
    assert riv.paths() == [FILE, f"{FILE}/{RID}/cancel", f"{FILE}/{RID}/delivered"]
    assert da._runs() == {}


# --- the device list, and cancel ----------------------------------------------------------------

def test_the_device_list_reads_one_line_each(riv):
    since = (datetime.now(timezone.utc) - timedelta(minutes=6, seconds=5)).isoformat().replace("+00:00", "Z")

    def device(id, name, state, version, running=None):
        return {"id": id, "name": name, "ownerName": "x", "os": "macOS", "osVersion": version, "chip": "M5",
                "tools": {"xcode": version, "iosRuntimes": [version], "node": "26", "pods": "1.16"},
                "state": state, "lastSeenAt": since, "running": running, "waiting": 0}
    riv.answers["/plugin/devices"] = {"on": 2, "free": 1, "devices": [
        {**device(DEVICE, MAC, "FREE", "27.0"), "tools": {"xcode": "27.0", "iosRuntimes": ["27.0", "26.4"],
                                                          "node": None, "pods": None}},
        device("a" * 16, "Erfan's MacBook Air", "BUSY", "27.0", {
            "requesterName": "Payam", "taskKey": "EFAS-12", "task": None, "repository": "ainurhq/efas",
            "since": since}),
        device("b" * 16, "Payam's Mac mini", "OFF", "26.4")]}
    assert da.list_text() == "\n".join([
        f"{MAC} — free · macOS 27.0 · Xcode 27.0 · iOS 27.0, 26.4 · id: {DEVICE}",
        "Erfan's MacBook Air — busy · macOS 27.0 · Xcode 27.0 · iOS 27.0 · Payam's EFAS-12 run, 6 min in"
        f" · yours would go next · id: {'a' * 16}",
        f"Payam's Mac mini — off · macOS 26.4 · Xcode 26.4 · iOS 26.4 · id: {'b' * 16}",
        "2 on, 1 free."])
    assert riv.calls == [("t1", "rvd_bridge_token", "/plugin/devices", None)]


def test_cancel_without_an_id_stops_this_chats_newest_run(riv, chat):
    da._save_run(RID, _record(chat.id))
    da._save_run(RID2, _record(chat.id, started_on=MAC))
    da._save_run(RID3, _record("another chat"))
    got = da.cancel(None, chat.csid)
    assert got == {"id": RID2, "sentence": f"Stopped the device run on {MAC}."}
    assert riv.paths() == [f"{FILE}/{RID2}/cancel"]


# --- on_update and catch_up ---------------------------------------------------------------------

def test_a_finished_run_comes_back_as_a_turn_with_its_screens_and_into_the_pr(riv, chat, guard, web, monkeypatch):
    da._save_run(RID, _record(chat.id, started_on=MAC))
    gh = Gh(body=f"Fixes the sheet.\n\n{START}\n### Device run on Old Mac\n\nold\n{END}\n\nCloses #12.")
    monkeypatch.setattr(github, "_run", gh)

    da.on_update(rivendell.Worker(INST), FRAME)

    up = os.path.join(config.UPLOAD_DIR, f"device-run-{RID}")
    images = [os.path.join(up, "1.png"), os.path.join(up, "2.png")]
    assert guard.turns == [(chat.id, {
        "text": TEXT, "prompt": TEXT, "images": images, "model": None, "effort": None, "permission_mode": None,
        "width": None, "sel": [], "surface": "rivendell", "chat_id": 555, "project": "ainurhq/app"})]
    assert [open(p, "rb").read() for p in images] == [PNG + URL1.encode(), PNG + URL2.encode()]
    assert gh.calls[0] == (("gh", "pr", "view", "57", "-R", "ainurhq/app", "--json", "body", "-q", ".body"), 15)
    (edit, timeout), = gh.calls[1:]
    assert edit[:7] == ("gh", "pr", "edit", "57", "-R", "ainurhq/app", "--body-file") and timeout == 40
    assert gh.written == f"Fixes the sheet.\n\n{START}\n{SECTION}\n{END}\n\nCloses #12.", "the last run's is replaced"
    assert not os.path.exists(edit[7]), "the body file goes"
    assert riv.paths() == [f"{FILE}/{RID}/delivered"]
    assert da._runs() == {} and guard.telegram == []


@pytest.mark.parametrize("body, out", [("Fixes the sheet.", f"Fixes the sheet.\n\n{START}\nnew\n{END}"),
                                       ("", f"{START}\nnew\n{END}")])
def test_a_first_pr_section_goes_after_a_blank_line(body, out):
    assert da.pr_section(body, "new") == out


def test_a_pr_section_replaces_the_last_runs_and_nothing_else():
    body = f"Intro\n\n{START}\nold\n{END}\n\nOutro"
    assert da.pr_section(body, "new") == f"Intro\n\n{START}\nnew\n{END}\n\nOutro"


def test_html_and_pictures_from_the_run_show_as_text_in_the_pr(riv, chat, guard, web, monkeypatch):
    """The report is a teammate's machine talking: its HTML can't render in the
    PR, the only pictures there are the run's own screens, and token-shaped text
    is redacted in the PR and in the turn."""
    da._save_run(RID, _record(chat.id))
    gh = Gh(body="Fixes the sheet.")
    monkeypatch.setattr(github, "_run", gh)
    frame = {**FRAME, "result": 'It works <img src="https://evil.example/x.png"> & '
                                '![pixel](https://evil.example/p.png) CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-secret',
             "screens": [{"id": "s1", "index": 1, "caption": "Home](https://evil.example/c.png) ![x", "url": URL1},
                         {"id": "s9", "index": 2, "caption": "local", "url": "file:///etc/passwd"}]}

    da.on_update(rivendell.Worker(INST), frame)

    section = gh.written.split(START, 1)[1]
    assert "<img" not in section and '&lt;img src="https://evil.example/x.png"&gt; &amp;' in section
    images = re.findall(r"(?<!\\)!\[(?:\\.|[^\]\\])*\]\(([^)\s]*)\)", section)
    assert images == [URL1], "the run's own screen, and nothing else, shows as a picture"
    assert "sk-ant-" not in gh.written and "[redacted]" in section
    assert web == [URL1], "a screen that isn't on the web is never read"
    (_, turn), = guard.turns
    assert "sk-ant-" not in turn["text"] and "[redacted]" in turn["text"]
    assert len(turn["images"]) == 1


def test_a_run_whose_chat_is_gone_is_told_on_telegram_and_still_lands_in_the_pr(riv, guard, web, monkeypatch):
    da._save_run(RID, _record("a session that is gone", started_on=MAC))
    gh = Gh(body="Fixes the sheet.")
    monkeypatch.setattr(github, "_run", gh)

    da.on_update(rivendell.Worker(INST), FRAME)

    assert guard.turns == []
    assert guard.telegram == [(config.DASH_CHAT_ID, HEAD)]
    assert gh.written == f"Fixes the sheet.\n\n{START}\n{SECTION}\n{END}"
    assert riv.paths() == [f"{FILE}/{RID}/delivered"] and da._runs() == {}


def test_running_is_a_telegram_notice_and_no_turn(riv, chat, guard):
    da._save_run(RID, _record(chat.id))
    da.on_update(rivendell.Worker(INST), {**FRAME, "status": "RUNNING", "result": None, "screens": [],
                                          "minutes": None})
    assert guard.telegram == [(config.DASH_CHAT_ID, f"Started on {MAC}: NR-31.")]
    assert guard.turns == [] and riv.calls == []
    assert da._runs()[RID]["started_on"] == MAC


@pytest.mark.parametrize("record", [None, _record("s", instance="another")])
def test_an_update_for_a_run_this_mystical_didnt_send_is_left_alone(riv, guard, record):
    if record:
        da._save_run(RID, record)
    da.on_update(rivendell.Worker(INST), FRAME)
    assert guard.turns == [] and guard.telegram == [] and riv.calls == []


def test_catch_up_hands_back_each_run_that_ended_while_away(riv, chat, guard):
    for rid in (RID, RID2):
        da._save_run(rid, _record(chat.id, task=None, pr=None))
    ended = {**FRAME, "screens": [], "task": None, "pullRequest": None}
    riv.answers[f"{FILE}/mine?undelivered=1"] = [{**ended, "requestId": RID},
                                                 {**ended, "requestId": RID2, "status": "FAILED",
                                                  "result": None, "error": "The run timed out after 180 min."}]

    da.catch_up(rivendell.Worker(INST))

    assert [kw["text"] for _, kw in guard.turns] == [
        f"{HEAD}\n\n{REPORT}",
        f"The device run you sent finished on {MAC} (7 min): Failed.\n\nThe run timed out after 180 min."]
    assert riv.paths() == [f"{FILE}/mine?undelivered=1", f"{FILE}/{RID}/delivered", f"{FILE}/{RID2}/delivered"]
    assert da._runs() == {}


# --- the hooks: the Rivendell worker and the dashboard -----------------------------------------

def test_an_update_frame_is_handed_back_off_the_listener(monkeypatch):
    """The hand-back downloads screens and runs gh: the listener must not wait on it."""
    got, release = [], threading.Event()
    monkeypatch.setattr(da, "on_update", lambda worker, frame: got.append(frame) or release.wait(5))
    began = time.monotonic()
    try:
        frame = json.dumps({"type": "device-run-update", **FRAME}).encode()
        assert rivendell.Worker(INST)._handle_message(frame) is None
        assert time.monotonic() - began < 1, "it returned while the hand-back was still going"
        _wait_until(lambda: got and got[0]["requestId"] == RID)
    finally:
        release.set()


@pytest.mark.parametrize("token, times", [("sk-ant-oat01-x", 1), ("", 0)])
def test_each_connect_catches_up_on_outcomes_only_with_a_device_token(monkeypatch, token, times):
    server, client = socket.socketpair()
    w = rivendell.Worker({**INST, "device_token": token})
    caught = []
    monkeypatch.setattr(da, "catch_up", lambda worker: caught.append(worker))
    monkeypatch.setattr(w, "_connect", lambda: (client, client.makefile("rb")))
    monkeypatch.setattr(w, "_catch_up", lambda: 0)
    t = threading.Thread(target=w._listen, daemon=True)
    t.start()
    try:
        _wait_until(lambda: w.status == "connected" and len(caught) == times)
        time.sleep(0.2)
    finally:
        w.stop()
        t.join(2)
        server.close()
    assert caught == [w] * times


def _post(path, body):
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    h._post_api(path, body)
    return box


def test_the_dashboard_routes_hand_the_tools_to_device_ask(monkeypatch):
    seen = []
    monkeypatch.setattr(da, "list_text", lambda: "2 on, 1 free.")
    monkeypatch.setattr(da, "start", lambda *a: seen.append(("start", a)) or {
        "id": RID, "device": MAC, "sentence": f"Sent to {MAC}."})
    monkeypatch.setattr(da, "cancel", lambda *a: seen.append(("cancel", a)) or {
        "id": RID, "sentence": "Stopped the device run."})

    assert _post("/local/device-runs/list", {"claude_session_id": "c"}) == {"obj": {"text": "2 on, 1 free."},
                                                                          "code": 200}
    assert _post("/local/device-runs/start", {"claude_session_id": "c", "request": "Test it", "task": "NR-31",
                                              "pullRequest": "#57", "device": DEVICE, "folder": "/x"}) == {
        "obj": {"text": f"Sent to {MAC}.\nid: {RID}"}, "code": 200}
    assert _post("/local/device-runs/cancel", {"claude_session_id": "c", "run": RID}) == {
        "obj": {"text": "Stopped the device run."}, "code": 200}
    assert seen == [("start", ("c", "Test it", "NR-31", "#57", DEVICE, "/x")), ("cancel", (RID, "c"))]
