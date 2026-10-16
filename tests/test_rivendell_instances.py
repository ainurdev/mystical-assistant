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
from bridge.dashboard import server as dash


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


def test_update_without_a_ws_url_keeps_the_stored_one(monkeypatch):
    """Review focus 3: the panel's form lost its ws url field; REPLACE TOKEN must not wipe it."""
    _fresh_db(monkeypatch)
    a = ri.add_instance(name="p", api_url="http://x", token="rvd_original", ws_url="wss://x/agent")
    ri.update_instance(a["id"], name="p", api_url="http://x", token="rvd_new")
    assert ri.raw_instances()[0]["ws_url"] == "wss://x/agent"
    ri.update_instance(a["id"], name="p", api_url="http://x", token="", ws_url="")
    assert ri.raw_instances()[0]["ws_url"] == "", "an explicit empty value still clears it"


def test_an_api_url_edit_without_a_ws_url_drops_the_stored_one(monkeypatch):
    """The stored ws_url pointed at the old host: kept, the worker would keep dialing
    it, and the form has no field to clear it. It is derived from the new URL instead."""
    _fresh_db(monkeypatch)
    a = ri.add_instance(name="p", api_url="http://old:3001", token="t", ws_url="ws://old:3001/agent")
    ri.update_instance(a["id"], name="p", api_url="https://new.example", token="")
    assert ri.raw_instances()[0]["ws_url"] == ""


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


# --- device runs: Share this device and the device-run token ------------------

def test_share_device_defaults_on_and_an_edit_can_switch_it_off(monkeypatch):
    _fresh_db(monkeypatch)
    a = ri.add_instance(name="p", api_url="http://x", token="t")
    assert a["share_device"] is True and ri.raw_instances()[0]["share_device"] is True
    ri.update_instance(a["id"], name="p", api_url="http://x", token="", share_device=False)
    assert ri.raw_instances()[0]["share_device"] is False
    assert ri.instances()[0]["share_device"] is False


def test_an_edit_that_does_not_mention_share_device_leaves_it_alone(monkeypatch):
    """The instance form never sends it; saving the form must not switch sharing back on."""
    _fresh_db(monkeypatch)
    a = ri.add_instance(name="p", api_url="http://x", token="t", share_device=False)
    ri.update_instance(a["id"], name="renamed", api_url="http://x", token="")
    assert ri.raw_instances()[0]["share_device"] is False
    ri.update_instance(a["id"], name="renamed", api_url="http://x", token="", share_device=None)
    assert ri.raw_instances()[0]["share_device"] is False, "null is not an answer either"


def test_an_instance_stored_before_device_runs_shares_by_default_with_no_token(monkeypatch):
    d = _fresh_db(monkeypatch)
    with open(os.path.join(d, "rivendell_instances.json"), "w") as f:
        json.dump({"instances": {"old": {"id": "old", "name": "old", "enable": True,
                                         "api_url": "http://x", "token": "rvd_old"}}}, f)
    got = ri.instances()[0]
    assert got["share_device"] is True and got["device_token"] == ""


def test_device_token_is_masked_and_kept_on_a_blank_edit(monkeypatch):
    _fresh_db(monkeypatch)
    a = ri.add_instance(name="p", api_url="http://x", token="rvd_t", device_token="sk-ant-oat01-supersecret")
    assert a["device_token"] == "…cret", "the panel only ever sees the last 4"
    assert "supersecret" not in json.dumps(ri.instances()), "the full token never leaves"
    assert ri.raw_instances()[0]["device_token"] == "sk-ant-oat01-supersecret"

    ri.update_instance(a["id"], name="p", api_url="http://x", token="", device_token="")
    assert ri.raw_instances()[0]["device_token"] == "sk-ant-oat01-supersecret", "a blank edit keeps it"
    ri.update_instance(a["id"], name="p", api_url="http://x", token="", device_token="sk-ant-oat01-another")
    assert ri.raw_instances()[0]["device_token"] == "sk-ant-oat01-another"


def test_no_device_token_is_a_blank_not_an_error(monkeypatch):
    _fresh_db(monkeypatch)
    a = ri.add_instance(name="p", api_url="http://x", token="t")
    assert a["device_token"] == "" and ri.raw_instances()[0]["device_token"] == ""


def _post(path, body):
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    h._post_api(path, body)
    return box


def test_the_dashboard_route_takes_both_fields_and_a_form_save_keeps_them(monkeypatch):
    _fresh_db(monkeypatch)
    monkeypatch.setattr(dash.rivendell, "reconfigure", lambda: None)   # no worker dials anywhere
    r = _post("/local/rivendell", {"op": "add", "name": "p", "api_url": "http://x", "token": "rvd_t",
                                   "share_device": False, "device_token": "sk-ant-oat01-supersecret"})
    assert r["code"] == 200
    assert r["obj"]["instance"]["share_device"] is False and r["obj"]["instance"]["device_token"] == "…cret"
    assert "supersecret" not in json.dumps(r["obj"])
    iid = ri.raw_instances()[0]["id"]
    assert ri.raw_instances()[0]["device_token"] == "sk-ant-oat01-supersecret"

    # What the instance form sends: no share_device, no device_token.
    r = _post("/local/rivendell", {"op": "update", "id": iid, "name": "p2", "api_url": "http://x", "token": ""})
    assert r["code"] == 200
    raw = ri.raw_instances()[0]
    assert raw["name"] == "p2" and raw["share_device"] is False and raw["device_token"] == "sk-ant-oat01-supersecret"


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
