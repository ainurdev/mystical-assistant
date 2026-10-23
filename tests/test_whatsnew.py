"""bridge/whatsnew.py — what the last update changed, and notes for every install
(docs/superpowers/specs/notif-updates.md). Git runs against throwaway clones, the
tests/test_selfupdate.py way; the feed and the two settings are cleared per test."""

import json
import os
import subprocess
import tempfile
import time
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


def test_first_boot_tells_the_last_day(repo):
    """No last head: the commits of the last day, so the changelog doesn't open empty."""
    with open(os.path.join(repo, "a.txt"), "a") as f:
        f.write("old\n")
    two_days = f"{int(time.time()) - 2 * 86400} +0000"
    subprocess.run(["git", "-C", repo, "commit", "-qam", "older work"], check=True,
                   env={**os.environ, "GIT_AUTHOR_DATE": two_days, "GIT_COMMITTER_DATE": two_days})
    _commit(repo, "x\n", "today: one")
    _commit(repo, "y\n", "today: two")
    whatsnew.boot().join(10)
    [upd] = notices.feed()
    assert upd["title"] == "2 commits pulled" and upd["body"].splitlines() == ["today: two", "today: one"]
    assert store.get_setting("last_head") == g.head_sha(repo)


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


def test_cut_ends_on_a_whole_word():
    s = "Equalizer removed — it's gone from the working indicator choices, which are Status, Nyan Cat, and Orbit"
    assert whatsnew._cut(s, 140) == s
    assert whatsnew._cut(s, 100) == ("Equalizer removed — it's gone from the working indicator choices, "
                                     "which are Status, Nyan Cat, and…")
    assert whatsnew._cut("H" * 60, 40) == "H" * 39 + "…"   # one long word: a hard cut
    assert whatsnew._cut("  short  ", 40) == "short"


def test_summarise_keeps_a_bullet_a_little_over_the_prompts_100(monkeypatch):
    b = "Lead — " + "word " * 22 + "end"   # 120 characters: haiku overshoots "under 100"
    reply = json.dumps({"headline": "H", "bullets": [b], "rest": 0})
    monkeypatch.setattr(whatsnew.runner, "run_blocking", lambda *a, **k: (reply, None, 0, False))
    assert whatsnew._summarise(["s"], 1)["bullets"] == [b]


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


# --- the final review's findings: what other installs would have seen ----------------

def test_notes_in_keeps_a_dash_in_the_title_and_skips_empty_headings():
    text = "## 2026-10-18 · Settings moved — see PLUGINS — Tester\n\nbody\n\n## \n\n## 2026-10-18 · Plain\n"
    a, b = whatsnew.notes_in(text)
    assert a["title"] == "Settings moved — see PLUGINS" and a["author"] == "Tester" and a["body"] == "body"
    assert b["title"] == "Plain"


def test_add_note_round_trips_a_heading_line_in_the_body(repo, origin):
    _run(origin, "config", "receive.denyCurrentBranch", "ignore")
    ok, out = whatsnew.add_note("Steps", "## Step 1\nDo X")
    assert ok, out
    with open(os.path.join(repo, "docs/notes.md")) as f:
        text = f.read()
    assert "\n ## Step 1\nDo X\n" in text                       # escaped in the file …
    (e,) = whatsnew.notes_in(text)
    assert e["title"] == "Steps" and e["body"] == "## Step 1\nDo X"   # … read back as typed, one note
    assert notices.feed()[0]["body"] == "## Step 1\nDo X"        # the author sees what the others will


def test_changelog_skips_merge_commits(repo, origin):
    whatsnew.boot()
    _run(origin, "checkout", "-q", "-b", "topic")
    _commit(origin, "t\n", "feat: topic work")
    _run(origin, "checkout", "-q", "main")
    _run(origin, "merge", "-q", "--no-ff", "-m", "Merge branch 'topic'", "topic")
    assert g.pull(repo)[0]
    whatsnew.boot().join(10)
    row = notices.feed()[0]
    assert row["title"] == "1 commit pulled" and row["body"] == "feat: topic work" and row["meta"]["commits"] == 1


# --- preview: what the update waiting upstream brings, before it is taken ------------

def _note(origin, title="Re-enter the token", body="Paste it once."):
    _write(origin, "docs/notes.md", whatsnew.NOTES_HEADER + f"\n## 2026-10-23 · {title} — Mahziyar\n\n{body}\n")
    _run(origin, "add", "-A")
    _run(origin, "commit", "-qm", f"note: {title}")


def _sha(repo, rev="HEAD"):
    return subprocess.run(["git", "-C", repo, "rev-parse", rev], capture_output=True, text=True,
                          check=True).stdout.strip()


def test_preview_writes_one_coming_row_and_tells_telegram_once(repo, origin, monkeypatch):
    _commit(origin, "two\n", "feat: two — why")
    _note(origin)
    notices.set_prefs({"events": {"updates": {"tg": "always"}}})
    monkeypatch.setattr(config, "ALLOWED_CHAT_IDS", [555])
    sent = []
    monkeypatch.setattr("bridge.telegram.send", lambda chat, text, *a, **k: sent.append(text))
    whatsnew.preview(selfupdate.check()).join(10)
    [row] = notices.changelog()
    assert row["kind"] == "coming" and row["verb"] == "UPDATE READY" and row["read"] is False
    assert row["title"] == "2 commits waiting" and row["body"].splitlines() == ["note: Re-enter the token", "feat: two"]
    m = row["meta"]
    assert m["from"] == g.head_sha(repo) and m["to"] == _sha(origin) and m["commits"] == 2 and m["rest"] == 0
    assert m["notes"] == [{"heading": "2026-10-23 · Re-enter the token — Mahziyar", "title": "Re-enter the token",
                           "body": "Paste it once.", "author": "Mahziyar"}]
    assert sent == ["UPDATE READY · 2 commits waiting\n• note: Re-enter the token\n• feat: two\n"
                    "NOTE · Re-enter the token\n↓ UPDATE on the dashboard pulls it"]
    assert whatsnew.preview(selfupdate.check()) is None           # the same range: nothing to write
    assert len(notices.changelog()) == 1 and len(sent) == 1


def test_preview_rewrites_the_row_in_place_at_most_hourly(repo, origin, monkeypatch):
    _commit(origin, "two\n", "feat: two")
    whatsnew.preview(selfupdate.check()).join(10)
    [first] = notices.changelog()
    _commit(origin, "three\n", "feat: three")
    assert whatsnew.preview(selfupdate.check()) is None           # written under an hour ago
    monkeypatch.setattr(whatsnew, "_COMING_EVERY", 0)
    whatsnew.preview(selfupdate.check()).join(10)
    [row] = notices.changelog()
    assert row["id"] == first["id"] and row["title"] == "2 commits waiting"
    assert row["meta"]["to"] == _sha(origin) and row["body"].splitlines() == ["feat: three", "feat: two"]


def test_preview_keeps_a_pulled_row_for_the_boot_and_drops_a_rewound_one(repo, origin):
    _commit(origin, "two\n", "feat: two")
    whatsnew.preview(selfupdate.check()).join(10)
    assert g.pull(repo)[0]                                         # pulled, its restart still to come
    assert whatsnew.preview(selfupdate.check()) is None
    assert [r["kind"] for r in notices.changelog()] == ["coming"]
    _run(repo, "reset", "-q", "--hard", "HEAD~1")
    _run(origin, "reset", "-q", "--hard", "HEAD~1")                # upstream took it back
    assert whatsnew.preview(selfupdate.check()) is None
    assert notices.changelog() == []


def test_preview_says_nothing_when_nothing_waits(repo):
    assert whatsnew.preview(selfupdate.check()) is None
    assert whatsnew.preview({"repo": False}) is None
    assert notices.changelog() == []


def test_boot_reuses_the_preview_and_quiets_the_note_it_showed(repo, origin, monkeypatch):
    whatsnew.boot()
    _commit(origin, "two\n", "feat: two")
    _note(origin)
    notices.set_prefs({"events": {"updates": {"tg": "always"}}})
    monkeypatch.setattr(config, "ALLOWED_CHAT_IDS", [555])
    sent = []
    monkeypatch.setattr("bridge.telegram.send", lambda chat, text, *a, **k: sent.append(text))
    monkeypatch.setattr(aifeatures, "enabled", lambda k: k == "changelog")
    reply = json.dumps({"headline": "Threads", "bullets": ["Threads — stack into one"], "rest": 1})
    calls = []
    monkeypatch.setattr(whatsnew.runner, "run_blocking", lambda *a, **k: calls.append(1) or (reply, None, 0, False))
    whatsnew.preview(selfupdate.check()).join(10)
    assert g.pull(repo)[0]
    whatsnew.boot().join(10)
    assert len(calls) == 1                                         # the boot took the preview's words
    upd, note = notices.changelog()                                # and the coming row is gone
    assert upd["kind"] == "updated" and upd["title"] == "Threads" and upd["body"] == "Threads — stack into one"
    assert upd["meta"]["rest"] == 1 and upd["meta"]["commits"] == 2 and upd["meta"]["to"] == g.head_sha(repo)
    assert note["kind"] == "note" and note["meta"]["quiet"] is True   # shown before the pull: no second pop
    assert [s.split(" · ")[0] for s in sent] == ["UPDATE READY", "UPDATED"]


def test_update_endpoint_carries_the_waiting_row(repo, origin, monkeypatch):
    from bridge.dashboard import server as dash
    _commit(origin, "two\n", "feat: two")
    real = whatsnew.preview
    monkeypatch.setattr(whatsnew, "preview", lambda info: (t := real(info)) and t.join(10))
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    h._get_api("/local/update", {})
    assert box["obj"]["behind"] == 1 and box["obj"]["coming"]["title"] == "1 commit waiting"
    assert box["obj"]["coming"]["kind"] == "coming"


# --- the review's findings (2026-10-23) ------------------------------------------------

def test_reuse_takes_only_the_models_words_not_the_waiting_fallback(repo, origin):
    whatsnew.boot()
    _commit(origin, "two\n", "feat: two")
    whatsnew.preview(selfupdate.check()).join(10)                  # UPDATE NOTES off: the fallback
    assert notices.coming()["title"] == "1 commit waiting"
    assert g.pull(repo)[0]
    whatsnew.boot().join(10)
    [upd] = notices.changelog()
    assert upd["kind"] == "updated" and upd["title"] == "1 commit pulled"


def test_a_git_read_that_fails_drops_nothing(repo, origin, monkeypatch):
    _commit(origin, "two\n", "feat: two")
    whatsnew.preview(selfupdate.check()).join(10)
    monkeypatch.setattr(whatsnew.git, "head_sha", lambda repo: "")
    assert whatsnew.preview({"repo": True, "behind": 0}) is None
    assert [r["kind"] for r in notices.changelog()] == ["coming"]


def test_a_pulled_row_goes_once_the_running_code_holds_it(repo, origin):
    """The boot that would turn it into UPDATED may never come (a rebase, a branch
    switch): once the code running (last_head) holds it, the row is done."""
    _commit(origin, "two\n", "feat: two")
    whatsnew.preview(selfupdate.check()).join(10)
    assert g.pull(repo)[0]
    store.set_setting("last_head", g.head_sha(repo))
    assert whatsnew.preview(selfupdate.check()) is None
    assert notices.changelog() == []


def test_a_local_commit_does_not_rewrite_the_same_incoming(repo, origin, monkeypatch):
    _commit(origin, "two\n", "feat: two")
    whatsnew.preview(selfupdate.check()).join(10)
    _write(repo, "b.txt", "mine\n")
    _run(repo, "add", "-A")
    _run(repo, "commit", "-qm", "my own work")                     # HEAD moves, what waits doesn't
    monkeypatch.setattr(whatsnew, "_COMING_EVERY", 0)
    assert whatsnew.preview(selfupdate.check()) is None
