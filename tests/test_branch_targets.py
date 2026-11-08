"""The BRANCHES tab's targets: each branch measured and landed against where it
goes (its PR's base, your Target pick, where git says it was made, else the
base), the dry-run merge that says whether it lands clean, and the clean-up
that keeps a worktree's scratch and never pulls a tree out from under a turn.

Run: python -m pytest tests/test_branch_targets.py -v
"""

import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import config, git, project_config, prstatus, store  # noqa: E402
from bridge.dashboard import server as dash  # noqa: E402

store.init()


def _git(cwd, *args):
    subprocess.run(["git", "-C", cwd, *args], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def _commit(d, name, text, msg):
    with open(os.path.join(d, name), "w") as f:
        f.write(text)
    _git(d, "add", "-A")
    _git(d, "commit", "-qm", msg)


def _repo(d=None):
    d = d or tempfile.mkdtemp()
    subprocess.run(["git", "init", "-q", d], check=True)
    for k, v in (("user.email", "t@example.com"), ("user.name", "Tester"), ("commit.gpgsign", "false")):
        _git(d, "config", k, v)
    _commit(d, "a.txt", "one\n", "init")
    return d


def _rows(d, targets=None):
    st = git.branch_status(d, targets)
    return st["base"], {r["name"]: r for r in st["branches"]}


def test_each_branch_is_measured_against_the_branch_it_was_made_from():
    d = _repo()
    base = git.current_branch(d)
    _git(d, "checkout", "-q", "-b", "staging")
    _commit(d, "s.txt", "s", "staging work")
    _commit(d, "s2.txt", "s", "more staging work")
    _git(d, "branch", "feat", "staging")          # reflog: "branch: Created from staging"
    _git(d, "checkout", "-q", "feat")
    _commit(d, "f.txt", "f", "feat work")
    _git(d, "checkout", "-q", base)
    _, rows = _rows(d)
    feat, staging = rows["feat"], rows["staging"]
    assert feat["target"] == "staging" and (feat["ahead"], feat["behind"]) == (1, 0)
    assert feat["clash"] == []                      # a fast-forward always lands clean
    assert staging["target"] == base and (staging["ahead"], staging["behind"]) == (2, 0)
    assert rows[base]["target"] == "" and rows[base]["merged"] is False


def test_a_pick_or_a_pr_base_beats_where_it_was_made():
    d = _repo()
    base = git.current_branch(d)
    _git(d, "checkout", "-q", "-b", "staging")
    _commit(d, "s.txt", "s", "staging work")
    _git(d, "checkout", "-q", "-b", "feat", base)
    _commit(d, "f.txt", "f", "feat work")
    _git(d, "checkout", "-q", base)
    _, rows = _rows(d, {"feat": "staging"})
    assert rows["feat"]["target"] == "staging" and (rows["feat"]["ahead"], rows["feat"]["behind"]) == (1, 1)
    _, rows = _rows(d, {"staging": ""})               # none: a long-lived branch goes nowhere
    assert rows["staging"]["target"] == "" and rows["staging"]["merged"] is False
    _, rows = _rows(d, {"feat": "gone-branch"})       # a target git doesn't know falls back
    assert rows["feat"]["target"] == ""


def test_the_dry_run_names_the_files_a_landing_would_clash_in():
    d = _repo()
    base = git.current_branch(d)
    _git(d, "checkout", "-q", "-b", "clashy")
    _commit(d, "a.txt", "theirs\n", "clashy edit")
    _git(d, "checkout", "-q", "-b", "calm", base)
    _commit(d, "c.txt", "calm\n", "calm edit")
    _git(d, "checkout", "-q", base)
    _commit(d, "a.txt", "ours\n", "base edit")
    _, rows = _rows(d)
    assert rows["clashy"]["clash"] == ["a.txt"]
    assert rows["calm"]["clash"] == []
    assert rows[base]["clash"] is None
    assert git.status(d)["files"] == []               # a dry run touches nothing


def test_a_fresh_branch_is_told_from_one_that_landed():
    d = _repo()
    base = git.current_branch(d)
    _git(d, "branch", "fresh")                        # made, never moved
    _git(d, "checkout", "-q", "-b", "done")
    _commit(d, "d.txt", "d", "done work")
    _git(d, "checkout", "-q", base)
    _git(d, "merge", "-q", "--no-ff", "--no-edit", "done")
    _, rows = _rows(d)
    assert rows["fresh"]["worked"] is False and rows["fresh"]["merged"] is True
    assert rows["done"]["worked"] is True and rows["done"]["merged"] is True


def test_archive_scratch_keeps_a_worktrees_ignored_files():
    d = _repo()
    wt = os.path.join(tempfile.mkdtemp(), "feat-x")
    _git(d, "worktree", "add", "-q", "-b", "feat/x", wt)
    os.makedirs(os.path.join(wt, ".mystical", "shots"))
    with open(os.path.join(wt, ".mystical", "shots", "a.png"), "w") as f:
        f.write("png")
    kept = git.archive_scratch(d, wt)
    assert os.path.realpath(kept) == os.path.realpath(os.path.join(d, ".mystical", "archive", "feat-x"))
    assert os.path.isfile(os.path.join(kept, ".mystical", "shots", "a.png"))
    assert not os.path.exists(os.path.join(wt, ".mystical"))
    os.makedirs(os.path.join(wt, ".superpowers"))
    assert git.archive_scratch(d, wt).endswith("feat-x-2")   # an older archive is never overwritten
    assert git.archive_scratch(d, wt) == ""                   # nothing left to keep
    assert git.archive_scratch(d, d) == ""                    # the repo folder itself never moves


def test_cached_bases_reads_the_last_pr_list_without_gh():
    prstatus._lists.clear()
    assert prstatus.cached_bases("/r") == {}
    prstatus._lists["/r"] = {"at": 0, "ttl": 60, "prs": {
        "feat/a": {"base": "staging"}, "feat/b": {"base": ""}, "feat/c": {"base": "main"}}}
    assert prstatus.cached_bases("/r") == {"feat/a": "staging", "feat/c": "main"}
    prstatus._lists.clear()


def test_branch_target_picks_are_kept_per_repo():
    rel = "/picks_repo"
    assert project_config.branch_targets(rel) == {}
    assert project_config.set_branch_target(rel, "staging", "") == {"staging": ""}
    assert project_config.set_branch_target(rel, "feat/x", "staging") == {"staging": "", "feat/x": "staging"}
    assert project_config.set_branch_target(rel, "staging", None) == {"feat/x": "staging"}
    assert project_config.branch_targets(rel) == {"feat/x": "staging"}
    project_config.set_branch_target(rel, "feat/x", None)
    assert project_config.get(rel) == {}


# --- routes ------------------------------------------------------------------------

def _handler():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


def _project(name):
    d = os.path.join(config.BASE_PATH, name)
    os.makedirs(d, exist_ok=True)
    _repo(d)
    return name, d


def test_the_target_route_checks_both_names_and_keys_the_main_checkout():
    name, d = _project("bt_route_proj")
    _git(d, "branch", "staging")
    _git(d, "branch", "feat/x")
    h, box = _handler()
    h._post_api("/local/git/branch/target", {"project": name, "branch": "feat/x", "target": "staging"})
    assert box["code"] == 200 and box["obj"]["targets"] == {"feat/x": "staging"}
    h._get_api("/local/git/branchstatus", {"project": [name]})
    rows = {r["name"]: r for r in box["obj"]["branches"]}
    assert rows["feat/x"]["target"] == "staging"
    for bad in ({"branch": "nope", "target": "staging"}, {"branch": "feat/x", "target": "nope"},
                {"branch": "feat/x", "target": "feat/x"}, {"branch": "feat/x", "target": 3}):
        h._post_api("/local/git/branch/target", {"project": name, **bad})
        assert box["code"] == 400
    h._post_api("/local/git/branch/target", {"project": name, "branch": "feat/x", "target": None})
    assert box["obj"]["targets"] == {}


def test_worktree_remove_keeps_scratch_and_waits_for_a_running_turn():
    name, d = _project("bt_remove_proj")
    wt = os.path.join(config.BASE_PATH, ".worktrees", name, "feat-y")
    _git(d, "worktree", "add", "-q", "-b", "feat/y", wt)
    os.makedirs(os.path.join(wt, ".mystical"))
    s = store.create_session(config.DASH_CHAT_ID, name, cwd=wt)
    tid = "bt-turn-1"
    store.start_turn(s["id"], tid, "work", None)
    h, box = _handler()
    h._post_api("/local/git/worktree/remove", {"project": name, "path": wt, "archive": True})
    assert box["obj"]["ok"] is False and os.path.isdir(wt)          # a turn runs in it
    store.finish_turn(tid, "done", None, None)
    h._post_api("/local/git/worktree/remove", {"project": name, "path": wt, "archive": True,
                                               "branch": "feat/y", "delete_branch": True})
    assert box["obj"]["ok"] is True and not os.path.exists(wt)
    assert os.path.isdir(os.path.join(box["obj"]["kept"], ".mystical"))
    assert "feat/y" not in git.branches(d)
