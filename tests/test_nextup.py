"""bridge.nextup — the next-up board. The expensive half (a read-only agent per
repo) is stubbed; what is tested is everything around it: which repos qualify,
what the cache lets us skip, and that every failure path still yields a list.
Run: python -m pytest tests/test_nextup.py -v"""

import datetime
import itertools
import os
import subprocess
import sys
import tempfile
import time

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import aifeatures, config, freeagent, nextup, runner, store  # noqa: E402

store.init()
# A fresh chat id per test: the store is the suite-wide DB, so sessions from
# an earlier test would otherwise show up as another repo in this one's board.
CHAT = 4242
_chat_seq = itertools.count(CHAT)


def _run(cwd, *args):
    subprocess.run(["git", "-C", cwd, *args], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _mkrepo(name="repo", dirty=False):
    d = os.path.join(tempfile.mkdtemp(), name)
    os.makedirs(d)
    subprocess.run(["git", "init", "-q", d], check=True)
    _run(d, "config", "user.email", "t@example.com")
    _run(d, "config", "user.name", "Tester")
    _run(d, "config", "commit.gpgsign", "false")
    with open(os.path.join(d, "a.txt"), "w") as f:
        f.write("one\n")
    _run(d, "add", "-A")
    _run(d, "commit", "-qm", "first")
    if dirty:
        with open(os.path.join(d, "b.txt"), "w") as f:
            f.write("untracked\n")
    return os.path.realpath(d)


def _session(cwd, *, ago=0.0, status=None, chat=None):
    """A store session pinned to `cwd`, optionally with a finished/dead turn.
    Reads CHAT at call time — the fixture rebinds it per test."""
    s = store.create_session(CHAT if chat is None else chat,
                             "/" + os.path.basename(cwd), cwd=cwd)
    if status:
        store.start_turn(s["id"], s["id"] + "-t", "do the thing", None)
        if status != "running":
            store.finish_turn(s["id"] + "-t", status, None, 1)
    if ago:
        with store.closing(store._connect()) as c:   # backdate: no public setter
            c.execute("UPDATE sessions SET updated=? WHERE id=?",
                      (time.time() - ago, s["id"]))
            c.commit()
    return store.get_session(s["id"])


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    """Own board file, no free rungs, no registry, board switched on. The store
    keeps the suite's DB — repointing BRIDGE_DB here would hand it an empty one."""
    monkeypatch.setattr(sys.modules[__name__], "CHAT", next(_chat_seq))
    monkeypatch.setattr(nextup, "_path", lambda: str(tmp_path / "nextup.json"))
    monkeypatch.setattr(config, "NEXTUP_ENABLE", True)
    monkeypatch.setattr(aifeatures, "_cache", None)
    monkeypatch.setattr(freeagent, "available", lambda: [])
    monkeypatch.setattr(nextup.machine, "list_running", lambda: [])
    yield
    monkeypatch.setattr(aifeatures, "_cache", None)


def _stub_agent(monkeypatch, reply, calls=None):
    def fake(prompt, cwd, chat_id, timeout):
        if calls is not None:
            calls.append(cwd)
        if isinstance(reply, Exception):
            raise reply
        return reply(prompt) if callable(reply) else reply
    monkeypatch.setattr(nextup, "_agent", fake)


# --- which repos qualify -----------------------------------------------------

def test_only_repos_inside_the_activity_window(monkeypatch):
    fresh, old = _mkrepo("fresh"), _mkrepo("old")
    _session(fresh)
    _session(old, ago=config.NEXTUP_DAYS * 86400 + 3600)
    cwds = [r["cwd"] for r in nextup.recent_repos(CHAT)]
    assert fresh in cwds and old not in cwds


def test_repo_cap_is_a_hard_ceiling(monkeypatch):
    monkeypatch.setattr(config, "NEXTUP_MAX_REPOS", 2)
    for i in range(4):
        _session(_mkrepo(f"r{i}"))
    assert len(nextup.recent_repos(CHAT)) == 2


def test_a_directory_that_is_not_a_repo_never_qualifies():
    plain = os.path.realpath(tempfile.mkdtemp())
    _session(plain)
    assert plain not in [r["cwd"] for r in nextup.recent_repos(CHAT)]


# --- facts + cache key -------------------------------------------------------

def test_a_live_session_is_not_reported_as_stalled():
    d = _mkrepo()
    _session(d, status="running")          # in-flight: store lists it as running
    assert nextup.facts(CHAT, d)["stalled"] == []


def test_a_dead_turn_is_reported_as_stalled():
    d = _mkrepo()
    _session(d, status="error")
    assert nextup.facts(CHAT, d)["stalled"][0]["status"] == "error"


def test_cache_key_moves_when_the_worktree_gets_dirty():
    d = _mkrepo()
    before = nextup.cache_key(nextup.facts(CHAT, d))
    with open(os.path.join(d, "new.txt"), "w") as f:
        f.write("x\n")
    assert nextup.cache_key(nextup.facts(CHAT, d)) != before


def test_cache_key_moves_on_a_new_commit():
    d = _mkrepo()
    before = nextup.cache_key(nextup.facts(CHAT, d))
    with open(os.path.join(d, "a.txt"), "w") as f:
        f.write("two\n")
    _run(d, "commit", "-qam", "second")
    assert nextup.cache_key(nextup.facts(CHAT, d)) != before


def test_cache_key_is_stable_when_nothing_moved():
    d = _mkrepo()
    assert nextup.cache_key(nextup.facts(CHAT, d)) == nextup.cache_key(nextup.facts(CHAT, d))


# --- issue triage state ------------------------------------------------------

NOW = 1_700_000_000.0


def _iss(n, title, labels=(), days_idle=0):
    """One issue as bridge.github.issues() hands it over."""
    stamp = datetime.datetime.fromtimestamp(NOW - days_idle * 86400, datetime.timezone.utc)
    return {"number": n, "title": title, "updated": stamp.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "labels": [{"name": x, "color": ""} for x in labels]}


def test_issue_facts_carry_labels_and_age():
    [f] = nextup._issue_facts([_iss(7, "Fix login", ["bug"], days_idle=3)], NOW)
    assert (f["n"], f["title"], f["labels"], f["idle_days"]) == (7, "Fix login", ["bug"], 3)


def test_an_unreadable_timestamp_is_unknown_not_fresh():
    [f] = nextup._issue_facts([{"number": 1, "title": "x", "updated": "not a date"}], NOW)
    assert f["idle_days"] is None


def test_untriaged_issues_come_before_labelled_ones():
    issues = nextup._issue_facts([
        _iss(1, "labelled and old", ["bug"], days_idle=90),
        _iss(2, "never labelled", [], days_idle=1),
        _iss(3, "labelled, older", ["bug"], days_idle=200),
    ], NOW)
    assert [i["n"] for i in nextup._by_triage(issues)] == [2, 3, 1]


def test_the_heuristic_says_why_an_issue_needs_a_decision():
    f = {"stalled": [], "dirty": 0, "ahead": 0, "branch": "main", "files": [],
         "issues": nextup._issue_facts([_iss(4, "never sorted"),
                                        _iss(5, "gone quiet", ["bug"], days_idle=60)], NOW)}
    whys = {i["evidence"]: i["why"] for i in nextup._heuristic(f)}
    assert whys["#4"] == "open issue, never labelled"
    assert whys["#5"] == "open issue, untouched for 60 days"


def test_cache_key_moves_when_an_issue_gets_labelled(monkeypatch):
    d = _mkrepo()
    raw = [_iss(1, "needs triage")]
    monkeypatch.setattr(nextup.github, "issues",
                        lambda cwd: {"open_count": 1, "issues": raw, "slug": "o/r"})
    before = nextup.cache_key(nextup.facts(CHAT, d))
    raw[0]["labels"] = [{"name": "bug", "color": ""}]
    assert nextup.cache_key(nextup.facts(CHAT, d)) != before


# --- refresh, caching, failure -----------------------------------------------

def test_unchanged_repo_is_not_scouted_again(monkeypatch):
    d = _mkrepo(dirty=True)
    _session(d)
    calls: list = []
    _stub_agent(monkeypatch, '[{"title": "Do a thing", "why": "because", '
                             '"effort": "small", "evidence": "a.txt"}]', calls)
    nextup.refresh(CHAT)
    first = len(calls)
    assert first >= 1
    nextup.refresh(CHAT)
    assert len(calls) == first          # second sweep spawned nothing


def test_a_changed_repo_is_scouted_again(monkeypatch):
    d = _mkrepo(dirty=True)
    _session(d)
    calls: list = []
    _stub_agent(monkeypatch, '[{"title": "Do a thing", "why": "because", '
                             '"effort": "small", "evidence": "a.txt"}]', calls)
    nextup.refresh(CHAT)
    first = len(calls)
    with open(os.path.join(d, "c.txt"), "w") as f:
        f.write("more\n")
    nextup.refresh(CHAT)
    assert len(calls) > first


def test_a_scout_that_dies_still_leaves_the_repo_represented(monkeypatch):
    d = _mkrepo(dirty=True)
    _session(d, status="error")
    _stub_agent(monkeypatch, TimeoutError("scout timed out"))
    board = nextup.refresh(CHAT)
    assert board["items"], "a dead scout must not empty the board"
    assert any("Finish" in i["title"] or "uncommitted" in i["title"]
               for i in board["items"])


def test_unparseable_scout_output_falls_back_to_facts(monkeypatch):
    d = _mkrepo(dirty=True)
    _session(d)
    _stub_agent(monkeypatch, "I'm afraid I can't do that.")
    board = nextup.refresh(CHAT)
    assert board["items"] and "uncommitted" in board["items"][0]["title"]


def test_ranking_failure_keeps_the_heuristic_order(monkeypatch):
    stalled, dirty = _mkrepo("stalled", dirty=True), _mkrepo("dirty", dirty=True)
    _session(stalled, status="error")
    _session(dirty)

    def reply(prompt):
        if prompt.startswith("Below are candidate"):   # the ranking call
            raise RuntimeError("ranker is down")
        return "not json"
    _stub_agent(monkeypatch, reply)
    board = nextup.refresh(CHAT)
    assert board["items"][0]["title"].startswith("Finish:")


def test_no_recent_repos_yields_an_empty_board(monkeypatch):
    monkeypatch.setattr(nextup, "recent_repos", lambda chat: [])
    board = nextup.refresh(CHAT)
    assert board["items"] == [] and board["repos"] == []


def test_board_reads_the_cache_without_spawning_anything(monkeypatch):
    d = _mkrepo(dirty=True)
    _session(d)
    _stub_agent(monkeypatch, "not json")
    nextup.refresh(CHAT)
    monkeypatch.setattr(nextup, "_agent", lambda *a, **k: pytest.fail("board() spawned an agent"))
    assert nextup.board(CHAT)["items"]


def test_every_item_carries_what_starting_it_needs(monkeypatch):
    d = _mkrepo(dirty=True)
    _session(d)
    _stub_agent(monkeypatch, "not json")
    for it in nextup.refresh(CHAT)["items"]:
        assert it["cwd"] == d and it["project"] and it["prompt"]
        assert it["title"] in it["prompt"]


# --- routing -----------------------------------------------------------------

def test_claude_is_used_when_no_free_rung_is_configured(monkeypatch):
    seen: dict = {}

    def fake_blocking(chat_id, prompt, **kw):
        seen.update(kw)
        return ("[]", None, None, False)
    monkeypatch.setattr(runner, "run_blocking", fake_blocking)
    nextup._agent("prompt", _mkrepo(), CHAT, 5)
    assert seen["model"] == config.NEXTUP_MODEL
    assert seen["permission_mode"] == "plan"    # read-only: no edits, no shell
    assert seen["skip_pack"] is True


def test_the_free_rung_is_tried_first(monkeypatch):
    d = _mkrepo()
    monkeypatch.setattr(freeagent, "available",
                        lambda: [{"provider": "zen", "model": "big-pickle", "label": "zen"}])
    monkeypatch.setattr(freeagent, "build_cmd",
                        lambda prompt, provider, session, cwd: ["/bin/echo", "[]"])
    monkeypatch.setattr(runner, "run_blocking",
                        lambda *a, **k: pytest.fail("free rung was skipped"))
    assert nextup._agent("prompt", d, CHAT, 5).strip() == "[]"


def test_a_failing_free_rung_falls_back_to_claude(monkeypatch):
    d = _mkrepo()
    monkeypatch.setattr(freeagent, "available",
                        lambda: [{"provider": "zen", "model": "big-pickle", "label": "zen"}])
    monkeypatch.setattr(freeagent, "build_cmd",
                        lambda prompt, provider, session, cwd: ["/bin/false"])
    monkeypatch.setattr(runner, "run_blocking",
                        lambda *a, **k: ("[]", None, None, False))
    assert nextup._agent("prompt", d, CHAT, 5) == "[]"


# --- parsing -----------------------------------------------------------------

def test_parses_a_fenced_array_with_prose_around_it():
    items = nextup._parse_items(
        'Sure!\n```json\n[{"title": "Ship it", "why": "w", "effort": "small", '
        '"evidence": "e"}]\n```\nHope that helps.')
    assert [i["title"] for i in items] == ["Ship it"]


def test_drops_items_without_a_title_and_normalises_effort():
    items = nextup._parse_items('[{"title": "", "why": "x"}, '
                                '{"title": "Real", "effort": "gigantic"}]')
    assert len(items) == 1 and items[0]["effort"] == "medium"


def test_prompt_carries_the_reasoning_not_just_the_title():
    p = nextup.to_prompt({"title": "Land the diff", "why": "it is half done",
                          "evidence": "bridge/git.py"})
    assert "Land the diff" in p and "half done" in p and "bridge/git.py" in p
