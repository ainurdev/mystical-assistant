"""fetch/incoming/pull against a throwaway clone (no network).
Run: python tests/test_selfupdate.py"""

import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ.setdefault("BASE_PATH", "/tmp")
os.environ.setdefault("BRIDGE_DB", os.path.join(tempfile.mkdtemp(), "t.db"))

from bridge import git as g, selfupdate  # noqa: E402
from bridge.dashboard import server as dash  # noqa: E402


def _run(cwd, *args):
    subprocess.run(["git", "-C", cwd, *args], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _clone_with_upstream():
    """(origin, clone) — a bare-less origin repo with one commit, plus a clone."""
    origin = tempfile.mkdtemp()
    subprocess.run(["git", "init", "-q", "-b", "main", origin], check=True)
    _run(origin, "config", "user.email", "t@example.com")
    _run(origin, "config", "user.name", "Tester")
    _run(origin, "config", "commit.gpgsign", "false")
    with open(os.path.join(origin, "a.txt"), "w") as f:
        f.write("one\n")
    _run(origin, "add", "-A")
    _run(origin, "commit", "-qm", "init")
    clone = os.path.join(tempfile.mkdtemp(), "clone")
    subprocess.run(["git", "clone", "-q", origin, clone], check=True)
    _run(clone, "config", "user.email", "t@example.com")
    _run(clone, "config", "user.name", "Tester")
    return origin, clone


def _commit(origin, text, msg):
    with open(os.path.join(origin, "a.txt"), "a") as f:
        f.write(text)
    _run(origin, "add", "-A")
    _run(origin, "commit", "-qm", msg)


def test_up_to_date_has_no_incoming():
    _origin, clone = _clone_with_upstream()
    assert g.fetch(clone) is True
    assert g.status(clone)["behind"] == 0
    assert g.incoming(clone) == []


def test_incoming_lists_new_commits_and_pull_applies_them():
    origin, clone = _clone_with_upstream()
    _commit(origin, "two\n", "feat: second")
    _commit(origin, "three\n", "fix: third")
    assert g.fetch(clone) is True
    assert g.status(clone)["behind"] == 2
    subjects = [c["subject"] for c in g.incoming(clone)]
    assert subjects == ["fix: third", "feat: second"]   # newest first
    assert all(c["sha"] for c in g.incoming(clone))
    ok, _out = g.pull(clone)
    assert ok is True
    assert g.status(clone)["behind"] == 0 and g.incoming(clone) == []


def test_pull_refuses_to_clobber_diverged_history():
    origin, clone = _clone_with_upstream()
    _commit(origin, "two\n", "feat: upstream")
    _commit(clone, "local\n", "feat: local")           # diverged: not a fast-forward
    g.fetch(clone)
    ok, out = g.pull(clone)
    assert ok is False and out                          # git's own message is surfaced


def test_publish_commits_local_work_and_pushes_it():
    origin, clone = _clone_with_upstream()
    _run(origin, "config", "receive.denyCurrentBranch", "ignore")  # origin isn't bare
    with open(os.path.join(clone, "b.txt"), "w") as f:
        f.write("local work\n")
    selfupdate.REPO = clone
    assert selfupdate.check()["dirty"] == 1
    ok, out = selfupdate.publish("feat: local work")
    assert ok is True, out
    after = selfupdate.check()
    assert after["dirty"] == 0 and after["ahead"] == 0 and after["behind"] == 0


def test_publish_pushes_an_already_committed_branch():
    origin, clone = _clone_with_upstream()
    _run(origin, "config", "receive.denyCurrentBranch", "ignore")
    _commit(clone, "committed\n", "feat: already committed")
    selfupdate.REPO = clone
    assert selfupdate.check()["ahead"] == 1
    ok, out = selfupdate.publish("")          # nothing to commit — push only
    assert ok is True, out
    assert selfupdate.check()["ahead"] == 0


def test_restart_endpoint_arms_a_restart():
    """POST /local/restart re-execs the bridge and nothing else — no pull, no
    build. Stubbed: the real one SIGINTs this process."""
    called = []
    saved = selfupdate.restart
    selfupdate.restart = lambda *a, **k: called.append(True)
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    try:
        h._post_api("/local/restart", {})
    finally:
        selfupdate.restart = saved
    assert called == [True]
    assert box["code"] == 200 and box["obj"] == {"ok": True}


def test_no_upstream_yields_nothing():
    d = tempfile.mkdtemp()
    subprocess.run(["git", "init", "-q", d], check=True)
    assert g.incoming(d) == []


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items())
           if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL {fn.__name__}: {type(e).__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    raise SystemExit(1 if failed else 0)
