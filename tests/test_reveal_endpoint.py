"""Right-click › Show in Finder (POST /local/files/reveal). The bridge points the OS
file manager at a path the browser sent, so the path is checked first: absolute, on
disk, and really inside the roots the dashboard already serves files from (BASE_PATH,
which holds UPLOAD_DIR). The command is an argv, never a shell, and on a Mac never
plain `open`, which would launch the file instead of showing it.
Run: python3 -m pytest tests/test_reveal_endpoint.py -q"""

import os
import subprocess
import sys
import tempfile

import pytest

from bridge import config, startup
from bridge.dashboard import server as dash


def _file(*parts):
    p = os.path.join(*parts)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f:
        f.write(b"x")
    return p


def test_a_file_in_the_workspace_is_allowed():
    p = _file(config.BASE_PATH, "reveal_proj", "src", "a.ts")
    assert dash._reveal_target(p) == os.path.realpath(p)


def test_a_folder_in_the_workspace_is_allowed():
    d = os.path.join(config.BASE_PATH, "reveal_dir", "src")
    os.makedirs(d, exist_ok=True)
    assert dash._reveal_target(d) == os.path.realpath(d)


def test_an_attachment_is_allowed():
    p = _file(config.UPLOAD_DIR, "reveal_job", "shot1.png")
    assert dash._reveal_target(p) == os.path.realpath(p)


@pytest.mark.parametrize("bad", [None, 3, ["/x"], "", "reveal_proj/src/a.ts", "/a\x00b"])
def test_junk_is_refused(bad):
    assert dash._reveal_target(bad) is None


def test_a_relative_path_is_refused_even_where_it_resolves(monkeypatch):
    _file(config.BASE_PATH, "reveal_rel", "a.ts")
    monkeypatch.chdir(config.BASE_PATH)
    assert dash._reveal_target("reveal_rel/a.ts") is None


def test_a_missing_file_is_refused():
    assert dash._reveal_target(os.path.join(config.BASE_PATH, "reveal_gone.png")) is None


def test_a_file_outside_the_workspace_is_refused():
    assert dash._reveal_target(_file(tempfile.mkdtemp(), "secret.txt")) is None


def test_dotdot_out_of_the_workspace_is_refused():
    outside = tempfile.mkdtemp()      # a sibling of BASE_PATH
    _file(outside, "x.txt")
    sneaky = os.path.join(config.BASE_PATH, "..", os.path.basename(outside), "x.txt")
    assert os.path.exists(sneaky) and dash._reveal_target(sneaky) is None


def test_a_symlink_out_of_the_workspace_is_refused():
    link = os.path.join(config.BASE_PATH, "reveal_link.txt")
    os.symlink(_file(tempfile.mkdtemp(), "x.txt"), link)
    assert dash._reveal_target(link) is None


def test_a_sibling_sharing_the_workspace_prefix_is_refused():
    assert dash._reveal_target(_file(config.BASE_PATH + "-evil", "x.txt")) is None


def test_mac_selects_it_in_finder(monkeypatch):
    monkeypatch.setattr(sys, "platform", "darwin")
    assert dash._reveal_argv("/w/a b.png") == ["open", "-R", "/w/a b.png"]


def test_linux_opens_the_containing_folder(monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(startup, "_wsl", lambda: False)
    assert dash._reveal_argv("/w/src/a.ts") == ["xdg-open", "/w/src"]


def test_wsl_selects_it_in_explorer_by_its_windows_path(monkeypatch):
    monkeypatch.setattr(sys, "platform", "linux")
    monkeypatch.setattr(startup, "_wsl", lambda: True)
    win = r"\\wsl.localhost\Ubuntu\w\a b.png"
    asked = []
    monkeypatch.setattr(dash.subprocess, "run", lambda argv, **kw: asked.append(argv)
                        or subprocess.CompletedProcess(argv, 0, stdout=win + "\n", stderr=""))
    assert dash._reveal_argv("/w/a b.png") == ["/mnt/c/Windows/explorer.exe", "/select,", win]
    assert asked == [["wslpath", "-w", "/w/a b.png"]]


def _handler(monkeypatch):
    h = dash.Handler.__new__(dash.Handler)
    box = {"spawned": []}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    monkeypatch.setattr(dash.subprocess, "Popen",
                        lambda argv, **kw: box["spawned"].append((argv, kw)))
    return h, box


def test_the_route_starts_the_file_manager_without_a_shell(monkeypatch):
    p = _file(config.BASE_PATH, "reveal_route", "a.png")
    monkeypatch.setattr(sys, "platform", "darwin")
    h, box = _handler(monkeypatch)
    h._post_api("/local/files/reveal", {"path": p})
    assert box["code"] == 200 and box["obj"] == {"ok": True}
    [(argv, kw)] = box["spawned"]
    assert argv == ["open", "-R", os.path.realpath(p)] and not kw.get("shell")


def test_the_route_refuses_without_starting_anything(monkeypatch):
    h, box = _handler(monkeypatch)
    h._post_api("/local/files/reveal", {"path": _file(tempfile.mkdtemp(), "x.png")})
    assert box["code"] == 404 and box["spawned"] == []
