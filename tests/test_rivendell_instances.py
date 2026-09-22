"""Unit tests for the rivendell instance store (bridge/rivendell_instances.py).

The keyed config the PR-review plugin runs one worker per: create/edit/remove,
validation, token masking + keep-on-blank-edit, the namespaced origin, and the
one-time migration that seeds a "production" instance from the flat .env
RIVENDELL_* values a bridge already had.
"""

import json
import os
import tempfile

from bridge import rivendell_instances as ri


def _fresh_db(monkeypatch):
    """Point the store at an empty temp dir and make sure nothing seeds from a
    developer's real RIVENDELL_* env, so each test starts from zero."""
    d = tempfile.mkdtemp()
    monkeypatch.setattr(ri.config, "BRIDGE_DB", os.path.join(d, "bridge.db"))
    monkeypatch.setattr(ri.config, "RIVENDELL_API_URL", "")
    monkeypatch.setattr(ri.config, "RIVENDELL_TOKEN", "")
    return d


# --- CRUD --------------------------------------------------------------------

def test_add_lists_masked_and_keeps_token(monkeypatch):
    _fresh_db(monkeypatch)
    inst = ri.add_instance(name="production", api_url="http://localhost:3001",
                           token="rvd_supersecret")
    assert inst["name"] == "production"
    assert inst["api_url"] == "http://localhost:3001"
    assert inst["token"] == "…cret", "the panel only ever sees the last 4"
    assert inst["origin"] == "rivendell:production"

    listed = ri.instances()
    assert [i["name"] for i in listed] == ["production"]
    assert "supersecret" not in json.dumps(listed), "the full token never leaves"
    # The worker view keeps the real token.
    assert ri.raw_instances()[0]["token"] == "rvd_supersecret"


def test_url_is_normalised(monkeypatch):
    _fresh_db(monkeypatch)
    inst = ri.add_instance(name="p", api_url="localhost:3001/", token="t")
    assert inst["api_url"] == "http://localhost:3001", "scheme added, slash trimmed"


def test_defaults_filled(monkeypatch):
    _fresh_db(monkeypatch)
    inst = ri.add_instance(name="p", api_url="http://x", token="t")
    assert inst["model"] == "opus"
    assert inst["review_timeout"] == 3600 and inst["impl_timeout"] == 10800
    assert inst["enable"] is True


def test_add_rejects_missing_fields(monkeypatch):
    _fresh_db(monkeypatch)
    for bad in (dict(name="", api_url="http://x", token="t"),
                dict(name="p", api_url="", token="t"),
                dict(name="p", api_url="http://x", token="")):
        try:
            ri.add_instance(**bad)
            raised = False
        except ri.RivendellError:
            raised = True
        assert raised, f"expected rejection for {bad}"


def test_timeout_bounds(monkeypatch):
    _fresh_db(monkeypatch)
    try:
        ri.add_instance(name="p", api_url="http://x", token="t", review_timeout=5)
        raised = False
    except ri.RivendellError:
        raised = True
    assert raised, "a review timeout under the minimum must be rejected"


def test_update_keeps_token_when_blank(monkeypatch):
    _fresh_db(monkeypatch)
    a = ri.add_instance(name="p", api_url="http://x", token="rvd_original")
    ri.update_instance(a["id"], name="renamed", api_url="http://y", token="")
    raw = ri.raw_instances()[0]
    assert raw["name"] == "renamed" and raw["api_url"] == "http://y"
    assert raw["token"] == "rvd_original", "a blank token on edit keeps the old one"


def test_update_replaces_token_when_given(monkeypatch):
    _fresh_db(monkeypatch)
    a = ri.add_instance(name="p", api_url="http://x", token="rvd_old")
    ri.update_instance(a["id"], name="p", api_url="http://x", token="rvd_new")
    assert ri.raw_instances()[0]["token"] == "rvd_new"


def test_update_unknown_raises(monkeypatch):
    _fresh_db(monkeypatch)
    try:
        ri.update_instance("nope", name="p", api_url="http://x", token="t")
        raised = False
    except ri.RivendellError:
        raised = True
    assert raised


def test_remove(monkeypatch):
    _fresh_db(monkeypatch)
    a = ri.add_instance(name="p", api_url="http://x", token="t")
    assert ri.remove_instance(a["id"]) is True
    assert ri.instances() == []
    assert ri.remove_instance(a["id"]) is False, "removing twice is a no-op"


def test_two_instances_are_independent(monkeypatch):
    _fresh_db(monkeypatch)
    ri.add_instance(name="production", api_url="http://prod", token="t1")
    ri.add_instance(name="local", api_url="http://localhost:3001", token="t2")
    got = {i["name"]: i for i in ri.instances()}
    assert set(got) == {"production", "local"}
    assert got["production"]["origin"] == "rivendell:production"
    assert got["local"]["origin"] == "rivendell:local"


# --- migration ---------------------------------------------------------------

def test_env_seeds_one_production_instance(monkeypatch):
    """First read with no file but RIVENDELL_* set migrates them into a single
    'production' instance, persisted so it is a one-time event."""
    d = tempfile.mkdtemp()
    monkeypatch.setattr(ri.config, "BRIDGE_DB", os.path.join(d, "bridge.db"))
    monkeypatch.setattr(ri.config, "RIVENDELL_API_URL", "http://prod:3001")
    monkeypatch.setattr(ri.config, "RIVENDELL_TOKEN", "rvd_prod")
    monkeypatch.setattr(ri.config, "RIVENDELL_ENABLE", True)
    monkeypatch.setattr(ri.config, "RIVENDELL_WS_URL", "")
    monkeypatch.setattr(ri.config, "RIVENDELL_MODEL", "opus")
    monkeypatch.setattr(ri.config, "RIVENDELL_WORKDIR", "")
    monkeypatch.setattr(ri.config, "RIVENDELL_REVIEW_TIMEOUT", 3600)
    monkeypatch.setattr(ri.config, "RIVENDELL_IMPL_TIMEOUT", 10800)

    got = ri.instances()
    assert [i["name"] for i in got] == ["production"]
    assert got[0]["id"] == "production" and got[0]["enable"] is True
    assert got[0]["api_url"] == "http://prod:3001"
    assert os.path.exists(ri._path()), "the seed is persisted, not recomputed"

    # A later removal is not undone by the seed re-running.
    ri.remove_instance("production")
    assert ri.instances() == []


def test_no_seed_without_env(monkeypatch):
    _fresh_db(monkeypatch)
    assert ri.instances() == []
    assert not os.path.exists(ri._path()), "nothing to migrate -> no file written"
