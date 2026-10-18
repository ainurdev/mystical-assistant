"""bridge/whatsnew.py — what the last update changed, and notes for every install
(docs/superpowers/specs/notif-updates.md). Git runs against throwaway clones, the
tests/test_selfupdate.py way; the feed and the two settings are cleared per test."""

import json
import os
import subprocess
import tempfile
from contextlib import closing

import pytest

from bridge import aifeatures, config, git as g, notices, selfupdate, store, whatsnew


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
    _run(clone, "config", "commit.gpgsign", "false")
    return origin, clone


def _commit(repo, text, msg):
    with open(os.path.join(repo, "a.txt"), "a") as f:
        f.write(text)
    _run(repo, "add", "-A")
    _run(repo, "commit", "-qm", msg)


def _write(repo, rel, text):
    path = os.path.join(repo, rel)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(text)


@pytest.fixture(autouse=True)
def _clean(monkeypatch):
    store.init()
    with closing(store._connect()) as c:
        c.execute("DELETE FROM notices")
    for key in ("notify_prefs", "last_head", "notes_seen"):
        store.set_setting(key, None)
    monkeypatch.setattr(notices, "_last_seen", float("-inf"))
    monkeypatch.setattr(config, "NOTIFY_ENABLE", True)
    monkeypatch.setattr(aifeatures, "enabled", lambda key: False)   # no one-shot unless a test says so
    yield


@pytest.fixture
def _pair():
    return _clone_with_upstream()


@pytest.fixture
def origin(_pair):
    return _pair[0]


@pytest.fixture
def repo(_pair, monkeypatch):
    monkeypatch.setattr(selfupdate, "REPO", _pair[1])
    return _pair[1]


# --- the notes file -----------------------------------------------------------------

def test_notes_in_parses_headings_bodies_and_authors():
    text = (whatsnew.NOTES_HEADER + "\n## 2026-10-18 · Re-enter the token — Mahziyar Erfani\n\n"
            "Line one.\nLine two.\n\n## 2026-10-19 · Second\n\nShort.\n")
    a, b = whatsnew.notes_in(text)
    assert a == {"heading": "2026-10-18 · Re-enter the token — Mahziyar Erfani", "date": "2026-10-18",
                 "title": "Re-enter the token", "author": "Mahziyar Erfani", "body": "Line one.\nLine two."}
    assert b["title"] == "Second" and b["author"] == "" and b["body"] == "Short."


def test_notes_in_hand_written_and_empty():
    text = "# Notes\n\n## Just a heading\n\n## 2026-10-18 · Empty one\n### not an entry\n"
    a, b = whatsnew.notes_in(text)
    assert a == {"heading": "Just a heading", "date": "", "title": "Just a heading", "author": "", "body": ""}
    assert b["title"] == "Empty one" and b["body"] == "### not an entry"
    assert whatsnew.notes_in("") == []


def test_file_at_reads_a_committed_version_and_empty_when_missing(repo):
    _commit(repo, "x\n", "feat: more")           # a.txt now "one\nx\n"
    first = subprocess.run(["git", "-C", repo, "rev-list", "--max-parents=0", "HEAD"],
                           capture_output=True, text=True, check=True).stdout.strip()
    assert g.file_at(repo, first, "a.txt") == "one\n"
    assert g.file_at(repo, "HEAD", "a.txt") == "one\nx\n"
    assert g.file_at(repo, "HEAD", "docs/notes.md") == "" and g.file_at(repo, "nope", "a.txt") == ""


# --- boot: the range since the last boot --------------------------------------------

def test_first_boot_records_head_and_says_nothing(repo):
    assert whatsnew.boot() is None
    assert store.get_setting("last_head") == g.head_sha(repo) and notices.feed() == []


def test_boot_announces_pulled_commits_and_new_notes(repo, origin):
    whatsnew.boot()
    _commit(origin, "two\n", "notifications: the bell counts unread only — the chip tallied every row")
    _commit(origin, "three\n", "git: HANDLE IN A NEW SESSION opens on the tree whose push failed")
    _write(origin, "docs/notes.md", whatsnew.NOTES_HEADER
           + "\n## 2026-10-18 · Re-enter the token — Mahziyar\n\nPaste it once.\n")
    _run(origin, "add", "-A")
    _run(origin, "commit", "-qm", "note: Re-enter the token")
    assert g.pull(repo)[0]
    t = whatsnew.boot()
    t.join(10)
    note, upd = sorted(notices.feed(), key=lambda r: r["kind"])
    assert note["kind"] == "note" and note["subject"] == "note:2026-10-18 · Re-enter the token — Mahziyar"
    assert note["title"] == "Re-enter the token" and note["body"] == "Paste it once."
    assert note["meta"]["author"] == "Mahziyar" and note["read"] is False
    assert upd["title"] == "3 commits pulled" and upd["subject"] == f"update:{g.head_sha(repo)}"
    assert upd["body"].splitlines() == ["note: Re-enter the token",
                                        "git: HANDLE IN A NEW SESSION opens on the tree whose push failed",
                                        "notifications: the bell counts unread only"]
    assert upd["meta"]["commits"] == 3 and upd["meta"]["rest"] == 0 and upd["meta"]["branch"] == "main"
    assert upd["meta"]["url"] is None                      # a /tmp origin is not github
    assert json.loads(store.get_setting("notes_seen")) == ["2026-10-18 · Re-enter the token — Mahziyar"]


def test_boot_is_silent_on_same_head_and_branch_switch(repo):
    whatsnew.boot()
    assert whatsnew.boot() is None                         # nothing moved
    _commit(repo, "m\n", "main work")
    whatsnew.boot().join(10)                               # one row for the commit on main
    _run(repo, "checkout", "-q", "-b", "side", "HEAD~1")
    _commit(repo, "s\n", "side work")                      # not a descendant of the recorded head
    assert whatsnew.boot() is None
    assert store.get_setting("last_head") == g.head_sha(repo)
    assert [r["title"] for r in notices.feed()] == ["1 commit pulled"]


def test_fallback_and_rest_count():
    subs = [f"area: thing {i} — because" for i in range(7)]
    d = whatsnew._fallback(subs, 9)
    assert d["headline"] == "9 commits pulled" and d["rest"] == 4
    assert d["bullets"] == [f"area: thing {i}" for i in range(5)]
    assert whatsnew._fallback(["x"], 1)["headline"] == "1 commit pulled"


def test_summarise_tolerates_wrapped_json_and_overlong(monkeypatch):
    reply = ('Here you go:\n{"headline": "' + "H" * 60 + '", "bullets": '
             + json.dumps([f"L{i} — d" for i in range(7)]) + ', "rest": "x"}')
    monkeypatch.setattr(whatsnew.runner, "run_blocking", lambda *a, **k: (reply, None, 0, False))
    d = whatsnew._summarise(["s"] * 9, 9)
    assert len(d["headline"]) == 40 and len(d["bullets"]) == 5 and d["rest"] == 4
    monkeypatch.setattr(whatsnew.runner, "run_blocking", lambda *a, **k: ("not json", None, 0, False))
    assert whatsnew._summarise(["s"], 1) is None
    monkeypatch.setattr(whatsnew.runner, "run_blocking", lambda *a, **k: ("", None, 0, True))
    assert whatsnew._summarise(["s"], 1) is None


def test_boot_falls_back_when_one_shot_fails(repo, origin, monkeypatch):
    whatsnew.boot()
    _commit(origin, "two\n", "feat: two — why")
    g.pull(repo)
    monkeypatch.setattr(aifeatures, "enabled", lambda k: k == "changelog")
    calls = []
    monkeypatch.setattr(whatsnew.runner, "run_blocking",
                        lambda *a, **k: calls.append(k) or ("garbage", None, 0, False))
    whatsnew.boot().join(10)
    assert calls and calls[0]["model"] == "haiku" and calls[0]["cwd"] == repo
    assert notices.feed()[0]["title"] == "1 commit pulled" and notices.feed()[0]["body"] == "feat: two"


def test_boot_sends_telegram_when_routed(repo, origin, monkeypatch):
    whatsnew.boot()
    _commit(origin, "two\n", "feat: two")
    g.pull(repo)
    notices.set_prefs({"events": {"updates": {"tg": "always"}}})
    monkeypatch.setattr(config, "ALLOWED_CHAT_IDS", [555])
    sent = []
    monkeypatch.setattr("bridge.telegram.send", lambda chat, text, *a, **k: sent.append((chat, text)))
    whatsnew.boot().join(10)
    assert sent == [(555, "UPDATED · 1 commit pulled\n• feat: two")]


def test_compare_url_only_for_github(repo):
    _run(repo, "remote", "set-url", "origin", "git@github.com:ainurdev/mystical-assistant.git")
    assert whatsnew._compare_url("a" * 40, "b" * 40) == \
        "https://github.com/ainurdev/mystical-assistant/compare/aaaaaaa...bbbbbbb"
    _run(repo, "remote", "set-url", "origin", "/tmp/elsewhere")
    assert whatsnew._compare_url("a" * 40, "b" * 40) is None


# --- add_note: write, commit that file, push, or roll back --------------------------

def test_add_note_appends_commits_pushes_and_emits_read_and_quiet(repo, origin, monkeypatch):
    _run(origin, "config", "receive.denyCurrentBranch", "ignore")
    monkeypatch.setattr(whatsnew.time, "strftime", lambda *a: "2026-10-18")
    ok, out = whatsnew.add_note("Re-enter the token", "Paste it once.\r\nThen restart.")
    assert ok, out
    with open(os.path.join(repo, "docs/notes.md")) as f:
        assert f.read() == (whatsnew.NOTES_HEADER + "\n## 2026-10-18 · Re-enter the token — Tester\n\n"
                            "Paste it once.\nThen restart.\n")
    st = g.status(repo)
    assert st["dirty"] == 0 and st["ahead"] == 0
    last = subprocess.run(["git", "-C", repo, "log", "-1", "--format=%s"], capture_output=True, text=True)
    assert last.stdout.strip() == "note: Re-enter the token"
    row = notices.feed()[0]
    assert row["kind"] == "note" and row["read"] is True
    assert row["meta"] == {"author": "Tester", "date": "2026-10-18", "quiet": True}
    assert json.loads(store.get_setting("notes_seen")) == ["2026-10-18 · Re-enter the token — Tester"]


def test_add_note_commits_only_the_notes_file(repo, origin):
    _run(origin, "config", "receive.denyCurrentBranch", "ignore")
    _write(repo, "a.txt", "dirty\n")
    ok, out = whatsnew.add_note("T", "")
    assert ok, out
    assert [f["path"] for f in g.status(repo)["files"]] == ["a.txt"]      # still dirty, uncommitted
    with open(os.path.join(repo, "docs/notes.md")) as f:
        assert f.read().endswith("\n## " + whatsnew.time.strftime("%Y-%m-%d") + " · T — Tester\n")


def test_add_note_rolls_back_a_refused_push(repo, origin):
    # origin refuses a push to its checked-out branch; the file had a hand edit already
    _write(repo, "docs/notes.md", whatsnew.NOTES_HEADER + "\nhand edit\n")
    head = g.head_sha(repo)
    ok, out = whatsnew.add_note("T", "b")
    assert ok is False and out
    assert g.head_sha(repo) == head
    with open(os.path.join(repo, "docs/notes.md")) as f:
        assert f.read() == whatsnew.NOTES_HEADER + "\nhand edit\n"
    assert [f["path"] for f in g.status(repo)["files"]] == ["docs/notes.md"]   # the hand edit, unstaged
    assert notices.feed() == [] and store.get_setting("notes_seen") in (None, "[]")


def test_add_note_rollback_removes_a_file_it_created(repo, origin):
    ok, _ = whatsnew.add_note("T", "b")
    assert ok is False
    assert not os.path.exists(os.path.join(repo, "docs/notes.md")) and g.status(repo)["dirty"] == 0


def test_boot_does_not_repeat_your_own_note(repo, origin):
    _run(origin, "config", "receive.denyCurrentBranch", "ignore")
    whatsnew.boot()
    ok, out = whatsnew.add_note("Mine", "x")
    assert ok, out
    whatsnew.boot().join(10)                              # last_head..HEAD now holds the note commit
    assert [r["kind"] for r in notices.feed()] == ["updated", "note"]
