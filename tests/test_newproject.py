"""NEW PROJECT's four kinds, the notices that wait for a yes, and the allow-list
for folders outside BASE_PATH (bridge/newproject.py, bridge/roots.py).

Run: python -m pytest tests/test_newproject.py -v
"""

import os
import shutil
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import pytest  # noqa: E402

from bridge import browser, config, newproject, project_config, roots, store  # noqa: E402
from bridge.dashboard import server as dash  # noqa: E402

store.init()
CHAT = 556


@pytest.fixture()
def base(tmp_path, monkeypatch):
    b = os.path.realpath(str(tmp_path / "base"))
    os.makedirs(b)
    monkeypatch.setattr(config, "BASE_PATH", b)
    yield b
    for r in roots.listing():
        roots.remove(r)


@pytest.fixture()
def outside():
    """A folder that is neither under BASE_PATH nor above home."""
    d = os.path.realpath(tempfile.mkdtemp(prefix="np-outside-"))
    yield d
    shutil.rmtree(d, ignore_errors=True)


def _git(cwd, *args):
    subprocess.run(
        ["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", *args],
        check=True,
        capture_output=True,
    )


# -- new ----------------------------------------------------------------------


def test_new_makes_a_repo_under_base(base):
    got = newproject.prepare({"name": "My Thing"})
    assert got["rel"] == "/my-thing" and got["cwd"] == os.path.join(base, "my-thing")
    assert os.path.isdir(os.path.join(base, "my-thing", ".git"))


def test_new_refuses_a_taken_name(base):
    os.makedirs(os.path.join(base, "taken"))
    with pytest.raises(newproject.Refused) as e:
        newproject.prepare({"kind": "new", "name": "taken"})
    assert e.value.code == 409


@pytest.mark.parametrize("name", ["", "..", "///", "."])
def test_new_refuses_a_name_that_is_no_folder(base, name):
    with pytest.raises(newproject.Refused):
        newproject.prepare({"name": name})


# -- folder -------------------------------------------------------------------


def test_folder_that_is_a_repo_is_used_as_it_is(base):
    d = os.path.join(base, "org", "app")
    os.makedirs(d)
    _git(d, "init")
    got = newproject.prepare({"kind": "folder", "path": d})
    assert got == {"rel": "/org/app", "cwd": d, "notes": [], "name": "app"}


def test_folder_without_git_waits_for_a_yes_and_touches_nothing(base):
    d = os.path.join(base, "notes")
    os.makedirs(d)
    open(os.path.join(d, "secret.env"), "w").write("KEY=1")
    got = newproject.prepare(
        {"kind": "folder", "path": "notes"}
    )  # relative: under BASE_PATH
    assert [n["kind"] for n in got["confirm"]] == ["init"] and got["path"] == d
    assert not os.path.exists(os.path.join(d, ".git"))


def test_folder_without_git_is_initialised_once_confirmed_and_files_stay_untracked(
    base,
):
    d = os.path.join(base, "notes")
    os.makedirs(d)
    open(os.path.join(d, "secret.env"), "w").write("KEY=1")
    got = newproject.prepare({"kind": "folder", "path": d, "confirmed": True})
    assert got["rel"] == "/notes" and os.path.isdir(os.path.join(d, ".git"))
    tracked = subprocess.run(
        ["git", "-C", d, "ls-files"], capture_output=True, text=True
    ).stdout
    assert tracked == ""
    assert "/notes" in browser.list_projects()


def test_folder_that_does_not_exist_is_made_without_asking(base):
    got = newproject.prepare({"kind": "folder", "path": "org/fresh"})
    assert got["rel"] == "/org/fresh" and os.path.isdir(
        os.path.join(base, "org", "fresh", ".git")
    )


def test_folder_inside_a_repo_files_under_the_repo_and_runs_in_the_folder(base):
    repo = os.path.join(base, "mono")
    sub = os.path.join(repo, "packages", "core")
    os.makedirs(sub)
    _git(repo, "init")
    got = newproject.prepare({"kind": "folder", "path": sub})
    assert got["rel"] == "/mono" and got["cwd"] == sub


def test_folder_refuses_the_projects_folder_itself_and_a_file(base):
    open(os.path.join(base, "f.txt"), "w").close()
    for path in (base, os.path.join(base, "f.txt")):
        with pytest.raises(newproject.Refused):
            newproject.prepare({"kind": "folder", "path": path, "confirmed": True})


# -- outside BASE_PATH --------------------------------------------------------


def test_outside_folder_waits_for_a_yes_then_joins_the_allow_list(base, outside):
    got = newproject.prepare({"kind": "folder", "path": outside})
    assert [n["kind"] for n in got["confirm"]] == ["outside", "init"]
    assert roots.listing() == [] and not browser.within_base(outside)

    got = newproject.prepare({"kind": "folder", "path": outside, "confirmed": True})
    assert roots.listing() == [outside] and got["cwd"] == outside
    assert browser.within_base(os.path.join(outside, "deeper"))
    assert not browser.within_base(os.path.dirname(outside))  # nothing above it
    # The key resolves the way every os.path.join(BASE_PATH, rel) in the bridge does.
    assert os.path.realpath(os.path.join(base, got["rel"].lstrip("/"))) == outside
    assert dash._abs_project(got["rel"]) == outside
    assert browser.project_exists(got["rel"])
    assert got["rel"] in browser.list_projects()
    assert got["name"] == os.path.basename(outside)


def test_removing_a_root_closes_it_again(base, outside):
    newproject.prepare({"kind": "folder", "path": outside, "confirmed": True})
    assert roots.remove(outside)
    assert not browser.within_base(outside) and roots.listing() == []
    assert os.path.isdir(outside)  # nothing on disk is touched


@pytest.mark.parametrize("path", ["/", "~", os.path.dirname(os.path.expanduser("~"))])
def test_roots_refuse_what_would_make_the_machine_a_project(base, path):
    with pytest.raises(newproject.Refused) as e:
        newproject.prepare({"kind": "folder", "path": path, "confirmed": True})
    assert e.value.code == 403 and roots.listing() == []


def test_roots_refuse_the_folder_above_base_and_the_state_folder(base):
    assert roots.refusal(os.path.dirname(base))
    assert roots.refusal(os.path.dirname(config.BRIDGE_DB))
    assert roots.add(os.path.join(base, "x"))[0] is False  # not a folder
    os.makedirs(os.path.join(base, "x"))
    assert roots.add(os.path.join(base, "x")) == (True, os.path.join(base, "x"))
    assert roots.listing() == []  # inside BASE_PATH: no entry


# -- clone --------------------------------------------------------------------


@pytest.mark.parametrize(
    "raw,url",
    [
        ("owner/repo", "https://github.com/owner/repo.git"),
        ("https://example.com/a/b.git", "https://example.com/a/b.git"),
        ("git@github.com:owner/repo.git", "git@github.com:owner/repo.git"),
    ],
)
def test_clone_url_forms(raw, url):
    assert newproject.clone_url(raw) == url


@pytest.mark.parametrize(
    "raw",
    ["", "--upload-pack=x", "ext::sh -c id", "/etc", "file:///etc", "-o/x", "a b"],
)
def test_clone_url_refuses_what_is_not_a_remote(raw):
    with pytest.raises(newproject.Refused):
        newproject.clone_url(raw)


@pytest.fixture()
def remote(tmp_path, monkeypatch):
    """A repo to clone, reached through a URL the form accepts."""
    src = str(tmp_path / "src" / "widget.git")
    os.makedirs(src)
    _git(src, "init")
    _git(src, "commit", "--allow-empty", "-m", "one")
    url = "https://example.invalid/acme/widget.git"
    real = subprocess.run

    def run(cmd, **kw):
        return real([src if c == url else c for c in cmd], **kw)

    monkeypatch.setattr(newproject.subprocess, "run", run)
    return url


def test_clone_lands_in_base_under_the_repo_name(base, remote):
    got = newproject.prepare({"kind": "clone", "url": remote})
    assert got["rel"] == "/widget" and os.path.isdir(
        os.path.join(base, "widget", ".git")
    )


def test_clone_into_a_named_location(base, remote):
    got = newproject.prepare({"kind": "clone", "url": remote, "path": "org"})
    assert got["rel"] == "/org/widget" and got["cwd"] == os.path.join(
        base, "org", "widget"
    )


def test_clone_outside_base_asks_first_then_allows_only_the_clone(
    base, remote, outside
):
    got = newproject.prepare({"kind": "clone", "url": remote, "path": outside})
    assert [n["kind"] for n in got["confirm"]] == ["outside"]
    assert not os.path.exists(os.path.join(outside, "widget"))
    newproject.prepare(
        {"kind": "clone", "url": remote, "path": outside, "confirmed": True}
    )
    assert roots.listing() == [os.path.join(outside, "widget")]


def test_clone_refuses_a_folder_with_something_in_it(base, remote):
    os.makedirs(os.path.join(base, "widget", "keep"))
    with pytest.raises(newproject.Refused) as e:
        newproject.prepare({"kind": "clone", "url": remote})
    assert e.value.code == 409


def test_a_failed_clone_says_why_and_leaves_nothing(base):
    with pytest.raises(newproject.Refused) as e:
        newproject.prepare(
            {"kind": "clone", "url": "https://127.0.0.1:1/nope/gone.git"}
        )
    assert e.value.code == 502 and "git clone failed" in str(e.value)
    assert not os.path.exists(os.path.join(base, "gone"))


# -- chat ---------------------------------------------------------------------


def test_general_chat_is_a_hidden_folder_with_no_repo_and_is_listed(base):
    newproject.ensure_general()
    d = os.path.join(base, ".mystical-chats", "general-chat")
    assert os.path.isdir(d) and not os.path.exists(os.path.join(d, ".git"))
    rel = "/.mystical-chats/general-chat"
    assert browser.list_projects() == [rel]
    assert project_config.name(rel) == "General chat"
    assert browser.list_dirs(base) == []  # no folder picker shows it


def test_chat_by_name_and_again_is_the_same_folder(base):
    a = newproject.prepare({"kind": "chat", "name": "Trip ideas"})
    b = newproject.prepare({"kind": "chat", "name": "Trip ideas"})
    assert (
        a == b
        and a["rel"] == "/.mystical-chats/trip-ideas"
        and a["name"] == "Trip ideas"
    )


def test_unknown_kind_is_refused(base):
    with pytest.raises(newproject.Refused):
        newproject.prepare({"kind": "teleport"})


# -- the route ----------------------------------------------------------------


def _post(body):
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    h._create_project(CHAT, body)
    return box["obj"], box["code"]


def test_route_returns_the_notice_and_makes_no_session(base):
    d = os.path.join(base, "plain")
    os.makedirs(d)
    obj, code = _post({"kind": "folder", "path": d})
    assert code == 200 and obj["confirm"][0]["kind"] == "init" and "session" not in obj


def test_route_starts_a_session_in_the_folder(base):
    d = os.path.join(base, "plain")
    os.makedirs(d)
    obj, code = _post({"kind": "folder", "path": d, "confirmed": True})
    assert (
        code == 200
        and obj["project"] == {"rel": "/plain", "name": "plain"}
        and obj["job_id"] is None
    )
    assert store.get_session(obj["session"]["id"])["cwd"] == d


def test_route_chat_session_runs_in_the_chat_folder(base):
    obj, _ = _post({"kind": "chat"})
    assert obj["project"]["name"] == "General chat"
    assert store.get_session(obj["session"]["id"])["cwd"] == os.path.join(
        base, ".mystical-chats", "general-chat"
    )


def test_route_says_why_it_refused(base):
    obj, code = _post({"kind": "folder", "path": "/"})
    assert code == 403 and "error" in obj
