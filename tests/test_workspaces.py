"""bridge/workspaces.py and its dashboard routes: DEFAULT is always there and
always first, a project lives in one workspace, deleting a workspace hands its
projects back to DEFAULT, and a picture is stored by its hash, refused when it
isn't one, and dropped once nothing wears it.

Socket-free via Handler.__new__ (the test_projectmarks_endpoint.py pattern).
Run: python -m pytest tests/test_workspaces.py -v"""

import base64
import io
import json
from urllib.parse import parse_qs, urlparse

import pytest

from bridge import workspaces
from bridge.dashboard import server as dash

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 24
PNG2 = b"\x89PNG\r\n\x1a\n" + b"\x01" * 24
b64 = lambda b: base64.b64encode(b).decode()


@pytest.fixture(autouse=True)
def store(tmp_path, monkeypatch):
    monkeypatch.setattr(workspaces, "_PATH", str(tmp_path / "workspaces.json"))
    return tmp_path / "workspaces.json"


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


PERSONAL = {"id": "w-pers1", "name": "Personal", "image": None}


def test_nothing_stored_is_one_default_workspace_and_no_assignments():
    assert workspaces.listing() == {
        "workspaces": [{"id": "default", "name": "Default", "image": None}], "assign": {}}


def test_a_workspace_takes_projects_and_default_stays_first():
    got = workspaces.save([PERSONAL], {"/awesome": "w-pers1", "/finance": "w-pers1", "/x": "default"})
    assert [w["id"] for w in got["workspaces"]] == ["default", "w-pers1"]
    assert got["assign"] == {"/awesome": "w-pers1", "/finance": "w-pers1"}, "default means unassigned"
    assert workspaces.listing() == got


def test_default_can_be_renamed_but_not_dropped():
    got = workspaces.save([PERSONAL, {"id": "default", "name": "  Work  ", "image": None}], {})
    assert got["workspaces"][0] == {"id": "default", "name": "Work", "image": None}
    assert workspaces.save([PERSONAL], {})["workspaces"][0]["id"] == "default"


def test_deleting_a_workspace_hands_its_projects_back_to_default(store):
    workspaces.save([PERSONAL], {"/awesome": "w-pers1"})
    assert workspaces.save([], {"/awesome": "w-pers1"})["assign"] == {}
    # and a stale assignment left in the file never shows
    store.write_text(json.dumps({"workspaces": [], "assign": {"/a": "w-gone1"}}))
    assert workspaces.listing()["assign"] == {}


@pytest.mark.parametrize("bad, why", [
    ([{"id": "../x", "name": "a"}], "bad workspace id"),
    ([{"id": "w-pers1", "name": "  "}], "needs a name"),
    ([PERSONAL, PERSONAL], "twice"),
    ([{**PERSONAL, "image": "f" * 64 + ".png"}], "isn't stored"),
    ("nope", "must be a list"),
])
def test_bad_sets_are_refused(bad, why):
    with pytest.raises(ValueError, match=why):
        workspaces.save(bad, {})


def test_a_picture_is_stored_by_hash_served_and_dropped_when_unworn():
    got = workspaces.save([PERSONAL], {}, {"w-pers1": b64(PNG)})
    name = got["workspaces"][1]["image"]
    assert name.endswith(".png") and len(name) == 64 + 4
    assert workspaces.image(name) == (PNG, "image/png")

    # Kept by name on the next save; a new one replaces it and the old one goes.
    assert workspaces.save([{**PERSONAL, "image": name}], {})["workspaces"][1]["image"] == name
    new = workspaces.save([{**PERSONAL, "image": name}], {}, {"w-pers1": b64(PNG2)})["workspaces"][1]["image"]
    assert new != name and workspaces.image(name) is None

    with pytest.raises(ValueError, match="PNG, JPEG"):
        workspaces.save([PERSONAL], {}, {"w-pers1": b64(b"not a picture")})
    assert workspaces.image("../workspaces.json") is None


def test_routes_list_save_and_serve():
    assert dget("/local/workspaces")["obj"]["workspaces"][0]["id"] == "default"
    r = dpost("/local/workspaces", {"workspaces": [PERSONAL], "assign": {"/finance": "w-pers1"},
                                    "images": {"w-pers1": b64(PNG)}})
    assert r["code"] == 200 and r["obj"]["assign"] == {"/finance": "w-pers1"}
    pic = dget(f"/local/workspaces/image/{r['obj']['workspaces'][1]['image']}")
    assert pic["code"] == 200 and pic["wfile"].getvalue() == PNG
    assert dget("/local/workspaces/image/" + "0" * 64 + ".png")["code"] == 404
    assert dpost("/local/workspaces", {"workspaces": "x", "assign": {}})["code"] == 400
