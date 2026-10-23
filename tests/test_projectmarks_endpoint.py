"""The dashboard routes for project marks: the listing carries them, the
project-settings POST saves one, a logo is served safe to open on its own, and
PICK LOGOS and the stylist's actions reach bridge/projectmarks.py.

Socket-free via Handler.__new__ (the test_rivendell_tasks_endpoint.py pattern).
Run: python -m pytest tests/test_projectmarks_endpoint.py -v"""

import base64
import io
import os
import subprocess
from urllib.parse import parse_qs, urlparse

import pytest

from bridge import config, project_config, projectmarks
from bridge.dashboard import server as dash

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24
SVG = b'<svg xmlns="http://www.w3.org/2000/svg"></svg>'


@pytest.fixture(autouse=True)
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "project_config.json"))
    monkeypatch.setattr(projectmarks, "_PATH", str(tmp_path / "project_marks.json"))


def _dash():
    h = dash.Handler.__new__(dash.Handler)
    box = {"headers": {}}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    h.send_response = lambda code: box.update(code=code)
    h.send_header = lambda k, v: box["headers"].update({k: v})
    h.end_headers = lambda: None
    h.wfile = io.BytesIO()
    box["wfile"] = h.wfile
    return h, box


def dget(path):
    h, box = _dash()
    u = urlparse(path)
    h._get_api(u.path, parse_qs(u.query))
    return box


def dpost(path, body):
    h, box = _dash()
    h._post_api(path, body)
    return box


def _repo(tmp_path):
    d = os.path.join(config.BASE_PATH, tmp_path.name)
    os.makedirs(d, exist_ok=True)
    subprocess.run(["git", "init", "-q", d], check=True)
    return "/" + tmp_path.name


def test_a_saved_mark_comes_back_in_the_projects_listing(tmp_path):
    rel = _repo(tmp_path)
    r = dpost("/local/project/settings", {"project": rel, "mark": {"kind": "icon", "icon": "receipt",
                                                                   "color": "#ff5d5d"}})
    assert r["code"] == 200 and r["obj"]["mark"] == {"kind": "icon", "icon": "receipt", "color": "#ff5d5d"}
    listing = dget("/local/projects")["obj"]
    assert listing["marks"][rel]["icon"] == "receipt"
    r = dpost("/local/project/settings", {"project": rel, "mark": None})       # BACK TO LETTERS
    # kept as your choice, so the repo's icon or PICK LOGOS can't dress it again
    assert r["obj"]["mark"] == {"kind": "letters"} and dget("/local/projects")["obj"]["marks"][rel] == {"kind": "letters"}


def test_a_bad_mark_is_a_400_and_changes_nothing(tmp_path):
    rel = _repo(tmp_path)
    r = dpost("/local/project/settings", {"project": rel, "mark": {"kind": "icon", "icon": "<script>"}})
    assert r["code"] == 400 and "icon" in r["obj"]["error"]
    assert project_config.mark(rel) is None


def test_a_logo_is_served_immutable_and_never_as_a_page(tmp_path):
    rel = _repo(tmp_path)
    m = dpost("/local/project/settings", {"project": rel, "mark": {"kind": "logo"},
                                          "logo_data": base64.b64encode(PNG).decode()})["obj"]["mark"]
    r = dget(f"/local/project-mark/logo/{m['logo']}")
    assert r["code"] == 200 and r["wfile"].getvalue() == PNG
    h = r["headers"]
    assert h["Content-Type"] == "image/png" and h["X-Content-Type-Options"] == "nosniff"
    assert "sandbox" in h["Content-Security-Policy"] and "immutable" in h["Cache-Control"]
    assert dget("/local/project-mark/logo/" + "0" * 64 + ".png")["code"] == 404
    assert dget("/local/project-mark/logo/..%2Fproject_config.json")["code"] == 404


def test_listing_names_the_bridges_own_checkout(tmp_path, monkeypatch):
    # MIDDLE-EARTH draws our own logo in the theme's ink: the listing says which project is ours
    from bridge import selfupdate
    repo = tmp_path / "base" / "mystical-assistant"
    repo.mkdir(parents=True)
    monkeypatch.setattr(config, "BASE_PATH", str(tmp_path / "base"))
    monkeypatch.setattr(selfupdate, "REPO", str(repo))
    assert dash._self_rel() == "/mystical-assistant"
    monkeypatch.setattr(selfupdate, "REPO", str(tmp_path / "elsewhere"))
    assert dash._self_rel() is None


def test_the_listing_wears_a_repos_icon_and_the_strip_lists_its_images(tmp_path, monkeypatch):
    monkeypatch.setattr(projectmarks, "_found", {})
    monkeypatch.setattr(projectmarks, "_read", {})
    rel = _repo(tmp_path)
    d = os.path.join(config.BASE_PATH, rel.lstrip("/"))
    os.makedirs(os.path.join(d, "public"))
    with open(os.path.join(d, "public", "favicon.svg"), "wb") as f:
        f.write(SVG)
    subprocess.run(["git", "-C", d, "add", "-A"], check=True)
    m = dget("/local/projects")["obj"]["marks"][rel]
    assert m["auto"] and m["repo"] == "public/favicon.svg"
    r = dget(f"/local/project-mark/logo/{m['logo']}")
    assert r["code"] == 200 and r["wfile"].getvalue() == SVG
    assert "sandbox" in r["headers"]["Content-Security-Policy"] and r["headers"]["Content-Type"] == "image/svg+xml"
    assert dget(f"/local/project-mark/repo?project={rel}")["obj"] == {
        "images": [{"path": "public/favicon.svg", "logo": m["logo"]}]}
    assert dget("/local/project-mark/repo?project=../../etc")["code"] == 400


def test_the_pick_route_reaches_projectmarks(monkeypatch):
    calls = []
    monkeypatch.setattr(projectmarks, "pick_all", lambda: calls.append("pick") or {"picked": [], "none": []})
    monkeypatch.setattr(projectmarks, "undo_picks", lambda: calls.append("undo") or {"undone": 0})
    assert dpost("/local/project-mark/pick", {"action": "pick"})["obj"] == {"picked": [], "none": []}
    assert dpost("/local/project-mark/pick", {"action": "undo"})["obj"] == {"undone": 0}
    assert dpost("/local/project-mark/pick", {"action": "explode"})["code"] == 400
    assert calls == ["pick", "undo"]


def test_the_style_routes_reach_the_stylist(monkeypatch, tmp_path):
    from bridge import logostyle
    calls = []
    monkeypatch.setattr(logostyle, "start", lambda sheet, sig, hashes, account: calls.append(("start", sheet, sig, account)) or {"state": "running"})
    monkeypatch.setattr(logostyle, "stop", lambda: calls.append(("stop",)) or {"state": "stopped"})
    monkeypatch.setattr(logostyle, "state", lambda: {"state": "idle"})
    monkeypatch.setattr(projectmarks, "undo_style", lambda rel=None: calls.append(("undo", rel)) or {"undone": 1})
    monkeypatch.setattr(projectmarks, "style_candidates", lambda: {"projects": [], "yours": [], "sig": "s"})
    rel = _repo(tmp_path)
    assert dpost("/local/project-mark/style", {"action": "start", "sheet": "AAA", "sig": "s", "account": 2})["obj"] == {"state": "running"}
    assert dpost("/local/project-mark/style", {"action": "stop"})["obj"] == {"state": "stopped"}
    assert dpost("/local/project-mark/style", {"action": "undo"})["obj"] == {"undone": 1}
    assert dpost("/local/project-mark/style", {"action": "undo", "project": rel})["obj"] == {"undone": 1}
    assert dpost("/local/project-mark/style", {"action": "undo", "project": "/../etc"})["code"] == 400
    assert dpost("/local/project-mark/style", {"action": "explode"})["code"] == 400
    assert calls == [("start", "AAA", "s", 2), ("stop",), ("undo", None), ("undo", rel)]
    assert dget("/local/project-mark/style")["obj"] == {"state": "idle"}
    assert dget("/local/project-mark/style/candidates")["obj"]["sig"] == "s"


def test_a_refused_start_says_why(monkeypatch):
    from bridge import logostyle

    def busy(sheet, sig, hashes, account):
        raise RuntimeError("Style with AI is already running")
    monkeypatch.setattr(logostyle, "start", busy)
    assert dpost("/local/project-mark/style", {"action": "start"})["code"] == 409

    def stale(sheet, sig, hashes, account):
        raise ValueError("the projects changed while the sheet was drawn; try again")
    monkeypatch.setattr(logostyle, "start", stale)
    got = dpost("/local/project-mark/style", {"action": "start"})
    assert got["code"] == 400 and "changed" in got["obj"]["error"]
