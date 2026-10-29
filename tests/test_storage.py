"""SYSTEM ▸ STORAGE (bridge/storage.py): what sessions left on disk, and clearing it.
Run: python -m pytest tests/test_storage.py -v"""

import os
import subprocess
import uuid

import pytest

from bridge import config, movejob, state, storage, store, team

store.init()
CHAT = 555


def _repo(name, commit=False):
    d = os.path.join(config.BASE_PATH, name)
    os.makedirs(d, exist_ok=True)
    subprocess.run(["git", "init", "-q", d], check=True)
    if commit:
        subprocess.run(["git", "-C", d, "-c", "user.email=t@t", "-c", "user.name=t",
                        "commit", "-q", "--allow-empty", "-m", "x"], check=True)
    return "/" + name, d


def _put(path, size=1000):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(b"x" * size)


def _proj(rel):
    return next((p for p in storage.scan()["projects"] if p["project"] == rel), None)


def _turn(rel):
    s = store.create_session(CHAT, rel)
    tid = uuid.uuid4().hex
    store.start_turn(s["id"], tid, "p", None)
    return s["id"], tid


@pytest.fixture(autouse=True)
def _quiet(monkeypatch):
    monkeypatch.setattr(state, "running_sessions", lambda: [])
    monkeypatch.setattr(team, "owned_uploads", lambda: set())
    monkeypatch.setattr(movejob, "files", lambda: [])


def _mystical(d, names=("big/a.png", "small.txt")):
    m = os.path.join(d, ".mystical")
    _put(os.path.join(m, "big", "a.png"), 300_000)
    _put(os.path.join(m, "small.txt"), 10_000)
    for kept in ("learn/0001-x.md", "docs/report.md", ".gitignore", "dev.log", "tasks.json"):
        _put(os.path.join(m, kept), 100)
    return m


# --- scan ----------------------------------------------------------------------

def test_scan_lists_entries_biggest_first_and_keeps_bridge_files_apart():
    rel, d = _repo("st_scan")
    _mystical(d)
    p = _proj(rel)
    assert [e["name"] for e in p["entries"]] == ["big", "small.txt"]
    assert p["entries"][0]["dir"] is True and p["entries"][1]["dir"] is False
    assert {k["name"] for k in p["kept"]} == {"learn", "docs", ".gitignore", "dev.log", "tasks.json"}
    assert p["bytes"] >= 310_000
    assert p["entries"][0]["mtime"] > 0


def test_scan_skips_a_project_with_nothing_to_clear():
    rel, d = _repo("st_empty")
    _put(os.path.join(d, ".mystical", ".gitignore"), 2)
    rel2, _d2 = _repo("st_none")
    assert _proj(rel) is None and _proj(rel2) is None


def test_scan_folds_a_worktree_into_its_project():
    rel, d = _repo("st_wt", commit=True)
    wt = os.path.join(config.BASE_PATH, ".worktrees", "st_wt", "feat-a")
    subprocess.run(["git", "-C", d, "worktree", "add", "-q", "-b", "feat-a", wt], check=True)
    _put(os.path.join(wt, ".mystical", "shots", "x.png"), 50_000)
    _put(os.path.join(wt, ".mystical", "learn", "l.md"), 100)
    p = _proj(rel)
    assert p["worktrees"]["count"] == 1 and p["worktrees"]["bytes"] >= 50_000
    assert p["entries"] == [] and p["bytes"] == p["worktrees"]["bytes"]


def test_scan_gives_a_project_the_pictures_its_turns_took():
    rel, _d = _repo("st_pics")
    sid, tid = _turn(rel)
    _put(os.path.join(config.UPLOAD_DIR, tid, "shot.png"), 40_000)
    _put(os.path.join(config.UPLOAD_DIR, sid, "screen.png"), 40_000)   # a device run's folder is named for its session
    p = _proj(rel)
    assert p["pictures"]["count"] == 2 and p["pictures"]["bytes"] >= 80_000


def test_scan_counts_a_project_running_sessions(monkeypatch):
    rel, d = _repo("st_run")
    _mystical(d)
    sid, _tid = _turn(rel)
    monkeypatch.setattr(state, "running_sessions", lambda: [sid])
    assert _proj(rel)["running"] == 1


def test_scan_lists_only_the_move_files_an_import_parked(monkeypatch):
    parked = {"path": "/s/incoming-legion/mystical-move-a.tar.gz", "name": "mystical-move-a.tar.gz",
              "dir": "~/.bridge_state/incoming-legion", "bytes": 5, "mtime": 1.0}
    mine = {"path": "/u/Downloads/mystical-move-b.tar.gz", "name": "mystical-move-b.tar.gz",
            "dir": "~/Downloads", "bytes": 7, "mtime": 2.0}
    monkeypatch.setattr(movejob, "files", lambda: [mine, parked])
    assert storage.scan()["move_files"] == [{**parked, "from": "legion"}]


# --- clear ---------------------------------------------------------------------

def test_clear_deletes_only_the_named_entries():
    rel, d = _repo("st_named")
    m = _mystical(d)
    got = storage.clear([{"project": rel, "entries": ["big"]}])
    assert not os.path.exists(os.path.join(m, "big"))
    assert os.path.exists(os.path.join(m, "small.txt"))
    assert got["freed"] >= 300_000 and got["errors"] == []


def test_clear_never_deletes_what_the_bridge_keeps():
    rel, d = _repo("st_kept")
    m = _mystical(d)
    got = storage.clear([{"project": rel, "entries": ["learn", "docs", ".gitignore", "dev.log", "tasks.json"]}])
    for kept in ("learn", "docs", ".gitignore", "dev.log", "tasks.json"):
        assert os.path.exists(os.path.join(m, kept))
    assert len(got["errors"]) == 5 and got["freed"] == 0


def test_clear_refuses_names_that_leave_the_folder():
    rel, d = _repo("st_escape")
    _mystical(d)
    _put(os.path.join(d, "src.txt"))
    _put(os.path.join(config.BASE_PATH, "st_escape_outside.txt"))
    got = storage.clear([{"project": rel, "entries": ["../src.txt", "../../st_escape_outside.txt", "big/a.png", "..", ".", "", 5]}])
    assert os.path.exists(os.path.join(d, "src.txt"))
    assert os.path.exists(os.path.join(config.BASE_PATH, "st_escape_outside.txt"))
    assert os.path.exists(os.path.join(d, ".mystical", "big", "a.png"))
    assert len(got["errors"]) == 7 and got["freed"] == 0


def test_clear_unlinks_a_symlink_without_following_it():
    rel, d = _repo("st_link")
    m = _mystical(d)
    target = os.path.join(config.BASE_PATH, "st_link_target")
    _put(os.path.join(target, "keep.txt"))
    os.symlink(target, os.path.join(m, "link"))
    storage.clear([{"project": rel, "entries": ["link"]}])
    assert not os.path.lexists(os.path.join(m, "link"))
    assert os.path.exists(os.path.join(target, "keep.txt"))


def test_clear_refuses_a_mystical_folder_that_is_a_symlink():
    rel, d = _repo("st_mlink")
    target = os.path.join(config.BASE_PATH, "st_mlink_target")
    _put(os.path.join(target, "precious.txt"))
    os.symlink(target, os.path.join(d, ".mystical"))
    got = storage.clear([{"project": rel}])
    assert os.path.exists(os.path.join(target, "precious.txt"))
    assert got["errors"] and got["freed"] == 0


def test_clear_without_names_takes_everything_but_what_the_bridge_keeps():
    rel, d = _repo("st_all")
    m = _mystical(d)
    storage.clear([{"project": rel}])
    assert sorted(os.listdir(m)) == sorted([".gitignore", "dev.log", "docs", "learn", "tasks.json"])


def test_clear_refuses_a_folder_that_is_not_a_listed_project():
    os.makedirs(os.path.join(config.BASE_PATH, "st_plain", ".mystical"), exist_ok=True)   # no .git: not a project
    _put(os.path.join(config.BASE_PATH, "st_plain", ".mystical", "x.txt"))
    _put(os.path.join(config.BASE_PATH, ".mystical", "base.txt"))
    got = storage.clear([{"project": "/st_plain"}, {"project": "/"}, {"project": "/../etc"}, {"project": None}])
    assert os.path.exists(os.path.join(config.BASE_PATH, "st_plain", ".mystical", "x.txt"))
    assert os.path.exists(os.path.join(config.BASE_PATH, ".mystical", "base.txt"))
    assert len(got["errors"]) == 4


def test_clear_pictures_spares_a_running_turn_and_what_teammates_sent(monkeypatch):
    rel, _d = _repo("st_pclear")
    _sid, done = _turn(rel)
    live_sid, live = _turn(rel)
    _sid3, shared = _turn(rel)
    for t in (done, live, shared):
        _put(os.path.join(config.UPLOAD_DIR, t, "a.png"), 20_000)
    monkeypatch.setattr(state, "running_sessions", lambda: [live_sid])   # the bridge's own word, not a turn row
    monkeypatch.setattr(team, "owned_uploads", lambda: {shared})
    got = storage.clear([{"project": rel, "entries": [], "pictures": True}])
    assert not os.path.exists(os.path.join(config.UPLOAD_DIR, done))
    assert os.path.exists(os.path.join(config.UPLOAD_DIR, live))
    assert os.path.exists(os.path.join(config.UPLOAD_DIR, shared))
    assert got["freed"] >= 20_000


def test_clear_worktrees_empties_their_mystical_but_what_the_bridge_keeps():
    rel, d = _repo("st_wtclear", commit=True)
    m = _mystical(d)
    wt = os.path.join(config.BASE_PATH, ".worktrees", "st_wtclear", "feat-b")
    subprocess.run(["git", "-C", d, "worktree", "add", "-q", "-b", "feat-b", wt], check=True)
    _put(os.path.join(wt, ".mystical", "shots", "x.png"), 50_000)
    _put(os.path.join(wt, ".mystical", "learn", "l.md"), 100)
    storage.clear([{"project": rel, "entries": [], "worktrees": True}])
    assert sorted(os.listdir(os.path.join(wt, ".mystical"))) == ["learn"]
    assert os.path.exists(os.path.join(m, "big"))     # entries [] touches nothing of its own


def test_clear_deletes_only_the_move_files_scan_lists(monkeypatch):
    parked = {"path": "/s/incoming-legion/mystical-move-a.tar.gz", "name": "mystical-move-a.tar.gz",
              "dir": "~/.bridge_state/incoming-legion", "bytes": 5, "mtime": 1.0}
    monkeypatch.setattr(movejob, "files", lambda: [parked])
    gone = []
    monkeypatch.setattr(movejob, "delete_file", lambda p: gone.append(p) or {"ok": True})
    got = storage.clear([], move_files=[parked["path"], "/etc/mystical-move-x.tar.gz"])
    assert gone == [parked["path"]]
    assert got["freed"] == 5 and len(got["errors"]) == 1
