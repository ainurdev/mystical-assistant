"""The dashboard's TEAM routes (/local/rivendell/team*) and the refusals that keep a
session a teammate sent read only. Logic lives in bridge/team.py (tests/test_team.py).
Run: python -m pytest tests/test_team_endpoint.py -q"""

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
