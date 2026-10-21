"""The dashboard routes for project marks: the listing carries them, the
project-settings POST saves one, a logo is served safe to open on its own, and
the Rivendell offer's actions reach bridge/projectmarks.py.

Socket-free via Handler.__new__ (the test_rivendell_tasks_endpoint.py pattern).
Run: python -m pytest tests/test_projectmarks_endpoint.py -v"""

import base64
import io
import os
import subprocess
from urllib.parse import parse_qs, urlparse

import pytest

from bridge import config, project_config, projectmarks, rivendell
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
    # kept as your choice, so following Rivendell can't dress it again
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


def test_the_rivendell_marks_routes_reach_projectmarks(tmp_path, monkeypatch):
    rel = _repo(tmp_path)
    calls = []
    monkeypatch.setattr(projectmarks, "state", lambda force=False: calls.append(("state", force)) or {"ok": 1})
    monkeypatch.setattr(projectmarks, "import_all", lambda only=None: calls.append(("import", only)) or {})
    monkeypatch.setattr(projectmarks, "dismiss", lambda: calls.append(("dismiss",)) or {})
    monkeypatch.setattr(projectmarks, "undo", lambda: calls.append(("undo",)) or {})
    monkeypatch.setattr(projectmarks, "set_sync", lambda on: calls.append(("sync", on)) or {})
    monkeypatch.setattr(projectmarks, "link", lambda r, inst, pid: calls.append(("link", r, inst, pid)) or {})
    assert dget("/local/rivendell/marks?force=1")["obj"] == {"ok": 1}
    for body in ({"action": "import"}, {"action": "follow", "project": rel}, {"action": "dismiss"},
                 {"action": "undo"}, {"action": "sync", "on": False},
                 {"action": "link", "project": rel, "instance": "prod", "rv_project": "p1"}):
        assert dpost("/local/rivendell/marks", body)["code"] == 200
    assert calls == [("state", True), ("import", None), ("import", rel), ("dismiss",), ("undo",),
                     ("sync", False), ("link", rel, "prod", "p1")]
    assert dpost("/local/rivendell/marks", {"action": "follow", "project": "../../etc"})["code"] == 400
    assert dpost("/local/rivendell/marks", {"action": "link", "project": "../../etc"})["code"] == 400
    assert dpost("/local/rivendell/marks", {"action": "explode"})["code"] == 400


def test_link_says_what_went_wrong(tmp_path, monkeypatch):
    rel = _repo(tmp_path)
    for err, code in ((ValueError("that isn't one of Rivendell's projects"), 400),
                      (rivendell.TasksError("refused", "Rivendell hasn't synced acme/x from GitHub yet"), 400),
                      (rivendell.TasksError("unreachable", "unreachable: timed out"), 502)):
        def boom(r, inst, pid, err=err):
            raise err
        monkeypatch.setattr(projectmarks, "link", boom)
        r = dpost("/local/rivendell/marks", {"action": "link", "project": rel, "instance": "prod", "rv_project": "p1"})
        assert (r["code"], r["obj"]["error"]) == (code, str(err))


def test_the_gallery_routes_reach_projectmarks_and_send_an_image_safely(tmp_path, monkeypatch):
    rel = _repo(tmp_path)
    monkeypatch.setattr(projectmarks, "gallery", lambda r: {"client": "C", "images": [{"id": "d1"}]})
    assert dget(f"/local/rivendell/gallery?project={rel}")["obj"] == {"client": "C", "images": [{"id": "d1"}]}
    assert dget("/local/rivendell/gallery?project=../../etc")["code"] == 400
    monkeypatch.setattr(projectmarks, "gallery_image", lambda r, doc: (PNG, "image/png") if (r, doc) == (rel, "d1") else None)
    r = dget(f"/local/rivendell/gallery/image?project={rel}&document=d1")
    assert r["code"] == 200 and r["wfile"].getvalue() == PNG
    h = r["headers"]
    assert h["Content-Type"] == "image/png" and h["X-Content-Type-Options"] == "nosniff"
    assert "sandbox" in h["Content-Security-Policy"]
    assert dget(f"/local/rivendell/gallery/image?project={rel}&document=d9")["code"] == 404
    assert dget("/local/rivendell/gallery/image?project=../../etc&document=d1")["code"] == 400


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
    monkeypatch.setattr(logostyle, "start", lambda sheet, sig: calls.append(("start", sheet, sig)) or {"state": "running"})
    monkeypatch.setattr(logostyle, "stop", lambda: calls.append(("stop",)) or {"state": "stopped"})
    monkeypatch.setattr(logostyle, "state", lambda: {"state": "idle"})
    monkeypatch.setattr(projectmarks, "undo_style", lambda rel=None: calls.append(("undo", rel)) or {"undone": 1})
    monkeypatch.setattr(projectmarks, "style_candidates", lambda: {"projects": [], "yours": [], "sig": "s"})
    rel = _repo(tmp_path)
    assert dpost("/local/project-mark/style", {"action": "start", "sheet": "AAA", "sig": "s"})["obj"] == {"state": "running"}
    assert dpost("/local/project-mark/style", {"action": "stop"})["obj"] == {"state": "stopped"}
    assert dpost("/local/project-mark/style", {"action": "undo"})["obj"] == {"undone": 1}
    assert dpost("/local/project-mark/style", {"action": "undo", "project": rel})["obj"] == {"undone": 1}
    assert dpost("/local/project-mark/style", {"action": "undo", "project": "/../etc"})["code"] == 400
    assert dpost("/local/project-mark/style", {"action": "explode"})["code"] == 400
    assert calls == [("start", "AAA", "s"), ("stop",), ("undo", None), ("undo", rel)]
    assert dget("/local/project-mark/style")["obj"] == {"state": "idle"}
    assert dget("/local/project-mark/style/candidates")["obj"]["sig"] == "s"


def test_a_refused_start_says_why(monkeypatch):
    from bridge import logostyle

    def busy(sheet, sig):
        raise RuntimeError("Style with AI is already running")
    monkeypatch.setattr(logostyle, "start", busy)
    assert dpost("/local/project-mark/style", {"action": "start"})["code"] == 409

    def stale(sheet, sig):
        raise ValueError("the projects changed while the sheet was drawn; try again")
    monkeypatch.setattr(logostyle, "start", stale)
    got = dpost("/local/project-mark/style", {"action": "start"})
    assert got["code"] == 400 and "changed" in got["obj"]["error"]
