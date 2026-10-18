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
