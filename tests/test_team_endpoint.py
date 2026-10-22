"""The dashboard's TEAM routes (/local/rivendell/team*) and the refusals that keep a
session a teammate sent read only. Logic lives in bridge/team.py (tests/test_team.py).
Run: python -m pytest tests/test_team_endpoint.py -q"""

import os

import pytest

from bridge import config, store, team, titler
from bridge.dashboard import server as dash

store.init()


def _dash():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


def dpost(path, body):
    h, box = _dash()
    h._post_api(path, body)
    return box


@pytest.fixture
def theirs():
    """A session a teammate sent, as bridge/team.py files it."""
    return store.create_session(config.DASH_CHAT_ID, "/", origin="team:prod", cwd=config.BASE_PATH)["id"]


def test_retitle_share_and_duplicate_refuse_a_session_a_teammate_sent(monkeypatch, theirs):
    """Titling would send their words to a model on this account, a link would show
    their work to whoever holds it, and a copy would be an ordinary session
    carrying it on here. Revoking links stays open: it only takes one away."""
    made = []
    monkeypatch.setattr(titler, "regenerate", lambda chat, s: made.append("title") or True)
    monkeypatch.setattr(store, "create_share", lambda *a, **k: made.append("share"))
    monkeypatch.setattr(store, "duplicate", lambda *a, **k: made.append("duplicate"))
    for path, body in ((f"/local/sessions/{theirs}/retitle", {}), (f"/local/sessions/{theirs}/retitle", {"title": "Mine"}),
                       (f"/local/sessions/{theirs}/share", {"days": 7}), (f"/local/sessions/{theirs}/duplicate", {})):
        r = dpost(path, body)
        assert r["code"] == 409 and r["obj"] == {"error": team.REFUSAL}, path
    assert made == [] and store.get_session(theirs)["title"] != "Mine"
    r = dpost(f"/local/sessions/{theirs}/share", {"revoke": True})
    assert r["code"] == 200 and r["obj"]["revoked"] == 0


def dget(path, qs=None):
    h, box = _dash()
    h._get_api(path, qs or {})
    return box


def _raw():
    """A handler whose bytes and headers are kept, for the routes that don't answer JSON."""
    import io
    h, box = _dash()
    box.update(headers={}, body=io.BytesIO())
    h.send_response = lambda code: box.update(code=code)
    h.send_header = lambda k, v: box["headers"].__setitem__(k, v)
    h.end_headers = lambda: None
    h.wfile = box["body"]
    return h, box


def test_the_tab_reads_the_overview(monkeypatch):
    monkeypatch.setattr(team, "overview", lambda: {"roster": [], "inbox": [], "outbox": [], "error": None})
    assert dget("/local/rivendell/team") == {"obj": {"roster": [], "inbox": [], "outbox": [], "error": None}, "code": 200}


def test_send_hands_each_kind_through(monkeypatch, tmp_path):
    got = []
    monkeypatch.setattr(team, "send", lambda kind, to, note, **kw: got.append((kind, to, note, kw)) or {"id": "s-1"})
    proj = tmp_path / "proj"
    (proj / "docs").mkdir(parents=True)
    (proj / "docs" / "a.md").write_text("a")
    monkeypatch.setattr(dash, "_worktree_cwd", lambda project, branch: str(proj) if project == "/proj" else None)
    r = dpost("/local/rivendell/team/send", {"kind": "session", "to": "u", "note": "n", "session": "sid", "code": True})
    assert r == {"obj": {"ok": True, "share": {"id": "s-1"}}, "code": 200}
    r = dpost("/local/rivendell/team/send", {"kind": "file", "to": "u", "project": "/proj", "file": "docs/a.md"})
    assert r["code"] == 200
    r = dpost("/local/rivendell/team/send", {"kind": "picture", "to": "u", "path": "/x/shot.png", "pictures": False})
    assert got == [("session", "u", "n", {"session_id": "sid", "pictures": True, "code": True, "path": None}),
                   ("file", "u", "", {"session_id": None, "pictures": True, "code": False,
                                      "path": os.path.realpath(proj / "docs" / "a.md")}),
                   ("picture", "u", "", {"session_id": None, "pictures": False, "code": False, "path": "/x/shot.png"})]


def test_send_refuses_a_file_outside_its_project(monkeypatch, tmp_path):
    monkeypatch.setattr(team, "send", lambda *a, **k: pytest.fail("sent"))
    monkeypatch.setattr(dash, "_worktree_cwd", lambda project, branch: str(tmp_path))
    for rel in ("../outside.txt", "/etc/passwd", ""):
        r = dpost("/local/rivendell/team/send", {"kind": "file", "to": "u", "project": "/proj", "file": rel})
        assert r == {"obj": {"error": "That file isn't in this project."}, "code": 400}, rel


def test_a_refused_send_says_why(monkeypatch):
    def refuse(*a, **k):
        raise team.TeamError("Rivendell can't be reached right now.")
    monkeypatch.setattr(team, "send", refuse)
    r = dpost("/local/rivendell/team/send", {"kind": "session", "to": "u", "session": "sid"})
    assert r == {"obj": {"error": "Rivendell can't be reached right now."}, "code": 400}


def test_a_send_that_crashes_the_route_is_logged_but_a_hang_up_isnt(capsys):
    h, box = _dash()
    h.command, h.path = "POST", "/local/rivendell/team/send?token=secret"
    try:
        raise FileNotFoundError(2, "No such file or directory", "pic-1.png")
    except FileNotFoundError as e:
        h._safe500(e)
    err = capsys.readouterr().err
    assert box["code"] == 500 and box["obj"]["error"].startswith("FileNotFoundError:")
    assert "[dashboard] POST /local/rivendell/team/send failed:" in err and "Traceback" in err and "secret" not in err
    try:
        raise BrokenPipeError()
    except BrokenPipeError as e:
        h._safe500(e)
    assert capsys.readouterr().err == ""


def test_continue_unpack_and_state(monkeypatch):
    monkeypatch.setattr(team, "continue_plan", lambda sid: {"project": None, "id": sid})
    monkeypatch.setattr(team, "unpack", lambda sid, cwd: 3)
    marked = []
    monkeypatch.setattr(team, "mark", lambda sid, state: marked.append((sid, state)))
    assert dpost("/local/rivendell/team/continue", {"id": "s-1"})["obj"] == {"project": None, "id": "s-1"}
    assert dpost("/local/rivendell/team/unpack", {"id": "s-1", "cwd": "/w"})["obj"] == {"ok": True, "files": 3}
    assert dpost("/local/rivendell/team/state", {"id": "s-1", "state": "opened"})["obj"] == {"ok": True}
    assert marked == [("s-1", "opened")]

    def gone(*a):
        raise team.TeamError("That share is gone.")
    monkeypatch.setattr(team, "continue_plan", gone)
    assert dpost("/local/rivendell/team/continue", {"id": "nope"}) == {"obj": {"error": "That share is gone."},
                                                                         "code": 400}


def test_a_received_file_goes_out_only_as_a_download(monkeypatch, tmp_path):
    f = tmp_path / "evil.html"
    f.write_bytes(b"<script>alert(1)</script>")
    monkeypatch.setattr(team, "file_path", lambda sid: (str(f), "evil.html") if sid == "s-1" else None)
    h, box = _raw()
    h._get_api("/local/rivendell/team/file", {"id": ["s-1"]})
    assert box["code"] == 200 and box["body"].getvalue() == b"<script>alert(1)</script>"
    assert box["headers"]["Content-Type"] == "application/octet-stream"
    assert box["headers"]["Content-Disposition"] == 'attachment; filename="evil.html"'
    assert box["headers"]["X-Content-Type-Options"] == "nosniff"
    assert dget("/local/rivendell/team/file", {"id": ["s-2"]}) == {"obj": {"error": "not found"}, "code": 404}


def test_the_transcript_comes_as_markdown(monkeypatch):
    monkeypatch.setattr(team, "transcript_md", lambda sid: "# t\n" if sid == "s-1" else None)
    h, box = _raw()
    h._get_api("/local/rivendell/team/transcript.md", {"id": ["s-1"]})
    assert box["body"].getvalue() == b"# t\n" and box["headers"]["Content-Type"] == "text/markdown; charset=utf-8"
    assert dget("/local/rivendell/team/transcript.md", {"id": ["x"]})["code"] == 404


def test_clone_and_install_answer_with_what_happened_or_why_not(monkeypatch):
    monkeypatch.setattr(team, "clone", lambda share_id: f"/ainurhq/{share_id}")
    steps = [{"dir": ".", "cmd": "pnpm install", "ok": True, "why": None}]
    got = []
    monkeypatch.setattr(team, "install", lambda share_id, cwd: got.append((share_id, cwd)) or steps)
    assert dpost("/local/rivendell/team/clone", {"id": "osanwe"}) == {
        "obj": {"ok": True, "project": "/ainurhq/osanwe", "path": os.path.join(config.BASE_PATH, "ainurhq", "osanwe")},
        "code": 200}
    assert dpost("/local/rivendell/team/install", {"id": "s1", "cwd": "/w"}) == {"obj": {"ok": True, "steps": steps}, "code": 200}
    assert got == [("s1", "/w")]

    def refuse(*a):
        raise team.TeamError("Couldn't clone ainurdev/osanwe: GraphQL: Could not resolve to a Repository")
    monkeypatch.setattr(team, "clone", refuse)
    monkeypatch.setattr(team, "install", refuse)
    for route in ("/local/rivendell/team/clone", "/local/rivendell/team/install"):
        r = dpost(route, {"id": "x"})
        assert r["code"] == 400 and r["obj"]["error"].startswith("Couldn't clone ainurdev/osanwe"), route
