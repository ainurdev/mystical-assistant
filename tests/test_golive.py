"""Go live (the rail's ⟳): what's on disk but not running, against a throwaway repo
laid out like this one; building one app; going live once the running turns end."""

import os
import subprocess
import threading
import time
import types

import pytest

from bridge import selfupdate


def _git(cwd, *args):
    return subprocess.run(["git", "-C", cwd, *args], check=True, capture_output=True, text=True).stdout


def _write(repo, rel, text):
    p = os.path.join(repo, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w") as f:
        f.write(text)


def _commit(repo, rel, text, msg):
    _write(repo, rel, text)
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", msg)


def _built(repo, app):
    """What a build leaves: dist/ and its stamp, the tree it was built from (the vite plugin's job)."""
    _write(repo, f"bridge/{app}/web/dist/index.html", "<html></html>")
    _write(repo, f"bridge/{app}/web/dist/.built", selfupdate.snapshot() + "\n")


@pytest.fixture
def repo(tmp_path, monkeypatch):
    r = str(tmp_path / "platform")
    subprocess.run(["git", "init", "-q", "-b", "master", r], check=True)
    for k, v in (("user.email", "t@example.com"), ("user.name", "Tester"), ("commit.gpgsign", "false")):
        _git(r, "config", k, v)
    _write(r, ".gitignore", "dist/\n")
    _write(r, "claude_telegram_bridge.py", "print('bridge')\n")
    _write(r, "bridge/x.py", "X = 1\n")
    _write(r, "bridge/dashboard/web/src/b.ts", "export const b = 1;\n")
    _write(r, "bridge/miniapp/web/src/a.ts", "export const a = 1;\n")
    _write(r, "tests/test_x.py", "def test_x(): pass\n")
    _git(r, "add", "-A")
    _git(r, "commit", "-qm", "init")
    monkeypatch.setattr(selfupdate, "REPO", r)
    monkeypatch.setattr(selfupdate.state, "running_sessions", lambda: [])
    _built(r, "dashboard")
    _built(r, "miniapp")
    selfupdate.boot()
    return r


def _parts(info):
    return {p["key"]: p for p in info["parts"]}


def test_a_tree_just_launched_and_built_has_nothing_behind(repo):
    info = selfupdate.live()
    assert info["repo"] and info["parts"] == [] and info["commits"] == 0
    assert info["running"] == info["disk"] == _git(repo, "rev-parse", "--short", "HEAD").strip()


def test_python_that_lands_after_launch_needs_a_restart(repo):
    _commit(repo, "bridge/x.py", "X = 2\n", "queue: start what a restart left queued")
    p = _parts(selfupdate.live())
    assert list(p) == ["bridge"] and p["bridge"]["act"] == "restart"
    assert [c["subject"] for c in p["bridge"]["commits"]] == ["queue: start what a restart left queued"]
    assert p["bridge"]["dirty"] == 0


def test_a_web_change_needs_its_app_rebuilt_and_no_restart(repo):
    _commit(repo, "bridge/dashboard/web/src/b.ts", "export const b = 2;\n", "sidebar: busy rows lift")
    info = selfupdate.live()
    p = _parts(info)
    assert list(p) == ["dashboard"] and p["dashboard"]["act"] == "rebuild"
    assert p["dashboard"]["commits"][0]["subject"] == "sidebar: busy rows lift"
    assert info["commits"] == 1
    _built(repo, "dashboard")                          # going live rebuilds it: caught up
    assert selfupdate.live()["parts"] == []


def test_one_commit_across_parts_counts_once(repo):
    _write(repo, "bridge/x.py", "X = 3\n")
    _write(repo, "bridge/miniapp/web/src/a.ts", "export const a = 3;\n")
    _git(repo, "add", "-A")
    _git(repo, "commit", "-qm", "both")
    info = selfupdate.live()
    assert sorted(_parts(info)) == ["bridge", "miniapp"] and info["commits"] == 1


def test_tests_and_docs_need_nothing(repo):
    _commit(repo, "tests/test_x.py", "def test_x(): assert 1\n", "test: tighten")
    _commit(repo, "docs/a.md", "# notes\n", "docs: notes")
    assert selfupdate.live()["parts"] == []


def test_an_edit_already_on_disk_at_launch_is_not_new_but_one_after_it_is(repo):
    _write(repo, "bridge/x.py", "X = 'launched with this'\n")      # uncommitted, then the bridge starts
    selfupdate.boot()
    assert selfupdate.live()["parts"] == []
    _git(repo, "commit", "-qam", "commit what was running")         # committing it changes nothing running
    assert selfupdate.live()["parts"] == []
    _write(repo, "bridge/x.py", "X = 'edited since'\n")
    p = _parts(selfupdate.live())["bridge"]
    assert p["dirty"] == 1 and p["files"] == 1    # (the list names commits since launch: that one too)


def test_an_app_with_no_stamp_reads_as_behind(repo):
    os.remove(os.path.join(repo, "bridge/miniapp/web/dist/.built"))  # built before builds stamped
    p = _parts(selfupdate.live())["miniapp"]
    assert p["act"] == "rebuild" and p["unknown"] and p["commits"] == []


def test_an_app_never_built_here_is_left_out(repo):
    """A Mini App turned off (no bot token, MINIAPP_ENABLE=0) has no dist/: nothing served, nothing to update."""
    os.remove(os.path.join(repo, "bridge/miniapp/web/dist/index.html"))
    _commit(repo, "bridge/miniapp/web/src/a.ts", "export const a = 9;\n", "web")
    assert "miniapp" not in _parts(selfupdate.live())


def test_a_stamp_that_isnt_a_sha_never_reaches_git(repo):
    _write(repo, "bridge/dashboard/web/dist/.built", "--output=/tmp/pwned\n")
    assert _parts(selfupdate.live())["dashboard"]["unknown"]
    assert not os.path.exists("/tmp/pwned")


def test_build_rebuilds_one_app_and_times_it(repo, monkeypatch):
    calls = []
    os.makedirs(os.path.join(repo, "bridge/dashboard/web/node_modules"))
    monkeypatch.setattr(selfupdate, "_build", lambda name, web: (calls.append((name, web)), (True, "ok"))[1])
    r = selfupdate.build("dashboard")
    assert r["ok"] and r["output"] == "" and isinstance(r["seconds"], int)
    assert calls == [("Dashboard", os.path.join(repo, "bridge/dashboard/web"))]
    assert not selfupdate.build("nope")["ok"] and len(calls) == 1


def test_build_says_why_when_it_cannot_build(repo, monkeypatch):
    """No node_modules: UPDATE skips quietly, but here the button would stay lit forever."""
    monkeypatch.setattr(selfupdate, "_build", lambda *a: pytest.fail("built without node_modules"))
    r = selfupdate.build("miniapp")
    assert not r["ok"] and "mystical build" in r["output"]


class _Turns:
    """Two running turns, as state and runner report them; end() finishes one."""
    def __init__(self, monkeypatch):
        self.jobs, self.all = {}, {}
        self.start("s1", "j1", 420)
        self.start("s2", "j2", 120)
        monkeypatch.setattr(selfupdate.state, "running_sessions", lambda: [s for s, j in self.jobs.items() if j.status == "running"])
        monkeypatch.setattr(selfupdate.runner, "live_job", lambda s: self.jobs[s] if self.jobs[s].status == "running" else None)
        monkeypatch.setattr(selfupdate.runner, "get_job", self.all.get)
        monkeypatch.setattr(selfupdate.store, "get_session", lambda s: {"title": f"session {s}"})
        monkeypatch.setattr(selfupdate, "_AFTER_EVERY", 0.01)

    def start(self, sid, jid, ago=0):
        self.jobs[sid] = self.all[jid] = types.SimpleNamespace(id=jid, status="running", started=time.time() - ago)

    def end(self, sid):
        self.jobs[sid].status = "done"


def _wait_for(cond, secs=3.0):
    t = time.time() + secs
    while time.time() < t:
        if cond():
            return True
        time.sleep(0.01)
    return False


def test_live_names_the_turns_a_restart_would_stop(repo, monkeypatch):
    _Turns(monkeypatch)
    turns = selfupdate.live()["turns"]
    assert [t["title"] for t in turns] == ["session s1", "session s2"] and turns[0]["started"] < turns[1]["started"]


def test_after_waits_for_the_turns_running_now_then_goes_live(repo, monkeypatch):
    turns = _Turns(monkeypatch)
    built, restarts = [], []
    monkeypatch.setattr(selfupdate, "_build", lambda name, web: (built.append(name), (True, ""))[1])
    monkeypatch.setattr(selfupdate, "restart", lambda *a, **k: restarts.append(True))
    _commit(repo, "bridge/x.py", "X = 4\n", "py")
    _commit(repo, "bridge/dashboard/web/src/b.ts", "export const b = 4;\n", "web")
    for app in ("dashboard", "miniapp"):
        os.makedirs(os.path.join(repo, f"bridge/{app}/web/node_modules"))
    selfupdate.after()
    assert [t["title"] for t in selfupdate.live()["queued"]["turns"]] == ["session s1", "session s2"]
    turns.end("s1")
    turns.start("s1", "j3")                            # s1's next turn doesn't hold it up
    assert _wait_for(lambda: [t["title"] for t in selfupdate.live()["queued"]["turns"]] == ["session s2"])
    assert built == [] and restarts == []
    turns.end("s2")                                    # the last of the turns running at the press
    assert _wait_for(lambda: restarts == [True])
    assert built == ["Dashboard"] and selfupdate.live()["queued"] is None


def test_after_cancelled_goes_nowhere(repo, monkeypatch):
    turns = _Turns(monkeypatch)
    monkeypatch.setattr(selfupdate, "restart", lambda *a, **k: pytest.fail("restarted after a cancel"))
    _commit(repo, "bridge/x.py", "X = 5\n", "py")
    selfupdate.after()
    selfupdate.after(cancel=True)
    assert selfupdate.live()["queued"] is None
    turns.end("s1"); turns.end("s2")
    time.sleep(0.1)


def test_a_build_that_fails_while_waiting_restarts_nothing_and_says_why(repo, monkeypatch):
    turns = _Turns(monkeypatch)
    monkeypatch.setattr(selfupdate, "_build", lambda name, web: (False, "TS2322: Type 'string'"))
    monkeypatch.setattr(selfupdate, "restart", lambda *a, **k: pytest.fail("restarted on a failed build"))
    _commit(repo, "bridge/x.py", "X = 6\n", "py")
    _commit(repo, "bridge/miniapp/web/src/a.ts", "export const a = 6;\n", "web")
    os.makedirs(os.path.join(repo, "bridge/miniapp/web/node_modules"))
    selfupdate.after()
    turns.end("s1"); turns.end("s2")
    assert _wait_for(lambda: selfupdate.live()["error"] is not None)
    err = selfupdate.live()["error"]
    assert err["name"] == "Mini App" and "TS2322" in err["output"] and selfupdate.live()["queued"] is None
    selfupdate.after(cancel=True)                     # CLOSE clears it
    assert selfupdate.live()["error"] is None


def test_a_cancel_mid_build_stops_it_short_of_the_restart(repo, monkeypatch):
    turns = _Turns(monkeypatch)
    _commit(repo, "bridge/x.py", "X = 8\n", "py")
    _commit(repo, "bridge/dashboard/web/src/b.ts", "export const b = 8;\n", "web")
    os.makedirs(os.path.join(repo, "bridge/dashboard/web/node_modules"))
    built = []

    def build(name, web):              # CANCEL lands while this build runs
        built.append(name)
        selfupdate.after(cancel=True)
        return True, ""
    monkeypatch.setattr(selfupdate, "_build", build)
    monkeypatch.setattr(selfupdate, "restart", lambda *a, **k: pytest.fail("restarted after a cancel"))
    selfupdate.after()
    turns.end("s1"); turns.end("s2")
    assert _wait_for(lambda: built == ["Dashboard"])
    time.sleep(0.1)
    assert selfupdate.live()["queued"] is None


def test_a_wait_armed_again_after_a_cancel_goes_live_once(repo, monkeypatch):
    turns = _Turns(monkeypatch)
    monkeypatch.setattr(selfupdate, "_AFTER_EVERY", 0.05)
    restarts = []
    monkeypatch.setattr(selfupdate, "restart", lambda *a, **k: restarts.append(True))
    _commit(repo, "bridge/x.py", "X = 9\n", "py")
    selfupdate.after()
    selfupdate.after(cancel=True)
    selfupdate.after()                 # the first thread wakes to a token that isn't its own
    turns.end("s1"); turns.end("s2")
    assert _wait_for(lambda: restarts == [True])
    time.sleep(0.2)
    assert restarts == [True]


def test_the_wait_stays_queued_until_the_restart_takes_the_process(repo, monkeypatch):
    """The page meets the restart with the boot screen only if its last poll still said queued."""
    turns = _Turns(monkeypatch)
    monkeypatch.setattr(selfupdate, "restart", lambda *a, **k: setattr(selfupdate, "restart_requested", True))
    monkeypatch.setattr(selfupdate, "restart_requested", False)
    _commit(repo, "bridge/x.py", "X = 10\n", "py")
    selfupdate.after()
    turns.end("s1"); turns.end("s2")
    assert _wait_for(lambda: (selfupdate.live()["queued"] or {}).get("restarting"))
    assert selfupdate.live()["queued"]["turns"] == []
    assert not selfupdate.build("dashboard")["ok"]        # nothing builds into a restart on its way
    selfupdate.after(cancel=True)


def test_one_wait_at_a_time(repo, monkeypatch):
    _Turns(monkeypatch)
    starts = []
    real = threading.Thread
    monkeypatch.setattr(selfupdate.threading, "Thread", lambda *a, **k: (starts.append(1), real(*a, **k))[1])
    _commit(repo, "bridge/x.py", "X = 7\n", "py")
    selfupdate.after()
    selfupdate.after()
    assert len(starts) == 1
    selfupdate.after(cancel=True)
