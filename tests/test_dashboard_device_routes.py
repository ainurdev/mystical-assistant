"""Settings › Plugins › DEVICE RUNS: the three dashboard routes DeviceRunsPanel
draws and drives (bridge/dashboard/server.py).
  - GET /local/rivendell/devices: per instance, Share this device, where this
    device stands (device_share.share_state), whether a Claude token for device
    runs is saved and its last 4 (never the token), the shared devices on now
    (Rivendell's, cached 30 s, null when it can't say) and the last run here.
  - POST /local/rivendell/devices: Share this device on or off, the token saved
    or forgotten. Real JSON booleans only, since bool("false") is True.
  - POST /local/rivendell/devices/setup: Set up or Remove, then the device is
    looked at afresh and each link whose offer changed redials.

Set up and Remove are real in production: a macOS admin-password prompt, then a
root script that makes or deletes a macOS user. Nothing here may reach them or
any command: an autouse fixture makes device_setup.run, every subprocess
device_setup and device_share could start, and Rivendell refuse, and one reached
fails the test. A setup test installs a recording fake of its own.
Driven socket-free through Handler.__new__ (test_rivendell_tasks_endpoint.py).
Run: python -m pytest tests/test_dashboard_device_routes.py -v
"""

import getpass
import io
import json
import os
import subprocess
import tempfile
import types
import urllib.error

import pytest

from bridge import config, device_ask, device_setup, device_share, rivendell, rivendell_instances
from bridge.dashboard import server as dash

TOKEN = "sk-ant-oat01-device-run-secret-4f2c"
CHECKS = [{"key": "user", "label": "USER MYSTICALRUNS", "ok": True}]
LAST = {"at": 1760607600.0, "by": "Mahdi", "task": "NR-29"}


@pytest.fixture(autouse=True)
def refusing(monkeypatch):
    """Nothing may run. device_setup.run, any command device_setup or
    device_share could start, and any call to Rivendell refuse, and one reached
    fails the test even if something swallowed the error. No worker starts, and
    each test gets an empty instance store."""
    reached = []

    def refuse(what):
        def f(*a, **k):
            reached.append(what)
            raise AssertionError(f"{what} was reached from a device route test: {a!r}")
        return f
    cmd = refuse("a command")
    monkeypatch.setattr(device_setup, "run", refuse("device_setup.run"))
    for mod in (device_setup, device_share):
        monkeypatch.setattr(mod, "subprocess", types.SimpleNamespace(
            run=cmd, Popen=cmd, TimeoutExpired=subprocess.TimeoutExpired,
            SubprocessError=subprocess.SubprocessError))
    # device_share's probes took subprocess.run as a default when it was imported.
    for f in (device_share.developer_dir, device_share.device_facts,
              device_share.share_state, device_share.handshake_headers):
        monkeypatch.setattr(f, "__defaults__", (cmd,))
    monkeypatch.setattr(device_share.setup_state, "__defaults__", (os.path.exists, cmd))
    monkeypatch.setattr(device_ask, "list_devices", refuse("Rivendell"))
    monkeypatch.setattr(rivendell, "_workers", {})
    monkeypatch.setattr(rivendell, "reconfigure", lambda: None)
    monkeypatch.setattr(rivendell, "_device_run", None)         # no teammate's run going here
    d = tempfile.mkdtemp()
    monkeypatch.setattr(config, "BRIDGE_DB", os.path.join(d, "bridge.db"))
    monkeypatch.setattr(config, "RIVENDELL_API_URL", "")
    monkeypatch.setattr(config, "RIVENDELL_TOKEN", "")
    yield
    assert not reached, f"reached from a device route test: {reached}"


@pytest.fixture
def device(monkeypatch):
    """This device as the test says: `share` is its state for a sharing
    instance (OFF for one that isn't), Rivendell has 3 on and 2 free, and the
    last run here was Mahdi's NR-29."""
    box = {"share": "READY", "asked": []}

    def share_state(inst):
        return {"state": box["share"] if inst.get("share_device", True) else "OFF", "checks": CHECKS, "facts": None}
    monkeypatch.setattr(device_share, "share_state", share_state)
    monkeypatch.setattr(device_share, "last_run", lambda: LAST)
    monkeypatch.setattr(device_ask, "list_devices",
                        lambda inst: box["asked"].append(inst["id"]) or {"devices": [], "on": 3, "free": 2})
    return box


def _inst(**kw):
    return rivendell_instances.add_instance(**{
        "name": "production", "api_url": "https://api.rivendell.ainurhq.cloud", "token": "rvd_owner", **kw})


def _dash():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


def dget():
    h, box = _dash()
    h._get_api("/local/rivendell/devices", {})
    return box


def dpost(path, body):
    h, box = _dash()
    h._post_api(path, body)
    return box


def _stored():
    return rivendell_instances.raw_instances()[0]


# --- GET ------------------------------------------------------------------------------------------

def test_get_draws_each_instance_and_never_its_tokens(device):
    a = _inst(device_token=TOKEN)
    _inst(name="staging", enable=False, share_device=False)
    r = dget()
    assert r["code"] == 200
    rows = {row["name"]: row for row in r["obj"]["instances"]}
    p, s = rows["production"], rows["staging"]
    assert {k: p[k] for k in ("id", "api_url", "enable", "share_device", "token_saved", "token_last4")} == {
        "id": a["id"], "api_url": "https://api.rivendell.ainurhq.cloud", "enable": True,
        "share_device": True, "token_saved": True, "token_last4": "4f2c"}
    assert p["status"]["state"] == "off", "no worker runs it here"
    assert p["share"] == {"state": "READY", "checks": CHECKS, "facts": None}
    assert p["shared_on"] == {"on": 3, "free": 2} and p["last_run"] == LAST and p["running"] is False
    assert (s["enable"], s["share_device"], s["token_saved"], s["token_last4"]) == (False, False, False, "")
    assert s["share"]["state"] == "OFF"
    assert s["shared_on"] is None and device["asked"] == [a["id"]], "a switched-off instance never asks Rivendell"
    text = json.dumps(r["obj"])
    assert TOKEN not in text and "rvd_owner" not in text


def test_a_run_going_on_this_device_says_so_in_every_block(monkeypatch, device):
    """STATE reads `running now` while a teammate's run runs here, from whichever
    instance it came (rivendell._device_run: one at a time on the device)."""
    _inst()
    _inst(name="staging")
    monkeypatch.setattr(rivendell, "_device_run", "5b1d2c3e-0000-4000-8000-000000000001")
    assert [row["running"] for row in dget()["obj"]["instances"]] == [True, True]


def test_shared_devices_on_now_is_cached_30_s_and_null_when_rivendell_cant_say(monkeypatch, device):
    a = _inst()
    answers = [{"devices": [], "on": 3, "free": 2}, urllib.error.URLError("connection refused")]

    def list_devices(inst):
        device["asked"].append(inst["id"])
        got = answers.pop(0)
        if isinstance(got, Exception):
            raise got
        return got
    monkeypatch.setattr(device_ask, "list_devices", list_devices)
    assert dget()["obj"]["instances"][0]["shared_on"] == {"on": 3, "free": 2}
    assert dget()["obj"]["instances"][0]["shared_on"] == {"on": 3, "free": 2}
    assert len(device["asked"]) == 1, "the second look is the cached answer"
    at, val = dash._shared_on[a["id"]]
    dash._shared_on[a["id"]] = (at - 31, val)          # 31 s later
    assert dget()["obj"]["instances"][0]["shared_on"] is None
    assert len(device["asked"]) == 2


# --- POST: Share this device and the token -------------------------------------------------------

def test_post_switches_sharing_and_saves_the_token_but_never_echoes_it(monkeypatch, device):
    a = _inst()
    seen = []
    monkeypatch.setattr(rivendell, "reconfigure", lambda: seen.append(_stored()))
    r = dpost("/local/rivendell/devices", {"id": a["id"], "share_device": False, "device_token": f"  {TOKEN}\n"})
    assert r["code"] == 200 and r["obj"]["ok"] is True
    stored = _stored()
    assert stored["share_device"] is False and stored["device_token"] == TOKEN
    assert (stored["name"], stored["enable"], stored["token"]) == ("production", True, "rvd_owner"), "nothing else moves"
    assert [s["share_device"] for s in seen] == [False], "the link redials with the change saved"
    row, = r["obj"]["instances"]
    assert (row["share_device"], row["token_saved"], row["token_last4"]) == (False, True, "4f2c")
    assert TOKEN not in json.dumps(r["obj"])


def test_a_field_left_out_is_kept_and_clear_token_forgets_the_token(device):
    a = _inst(device_token=TOKEN, share_device=False)
    assert dpost("/local/rivendell/devices", {"id": a["id"], "device_token": ""})["code"] == 200
    assert (_stored()["share_device"], _stored()["device_token"]) == (False, TOKEN)
    r = dpost("/local/rivendell/devices", {"id": a["id"], "clear_token": True})
    assert r["code"] == 200 and _stored()["device_token"] == "" and _stored()["share_device"] is False
    assert r["obj"]["instances"][0]["token_saved"] is False


@pytest.mark.parametrize("bad", [
    {"share_device": "false"}, {"share_device": 0}, {"share_device": 1},
    {"clear_token": "true"}, {"clear_token": 1}, {"device_token": 1234}, {"device_token": ["sk-ant"]},
])
def test_post_takes_only_real_booleans_and_a_string_token(monkeypatch, bad):
    a = _inst(device_token=TOKEN)
    monkeypatch.setattr(rivendell, "reconfigure", lambda: pytest.fail("nothing was saved"))
    assert dpost("/local/rivendell/devices", {"id": a["id"], **bad})["code"] == 400
    assert (_stored()["share_device"], _stored()["device_token"]) == (True, TOKEN)


def test_post_for_an_instance_that_isnt_there_is_a_400():
    r = dpost("/local/rivendell/devices", {"id": "nope", "share_device": True})
    assert r["code"] == 400 and r["obj"]["error"] == "no such instance"


# --- POST: Set up and Remove ---------------------------------------------------------------------

def _record_setup(monkeypatch, answer):
    """device_setup.run recording what it was asked; the redial and the fresh look
    recorded in order."""
    done, order = [], []

    def run(action, owner, **kw):
        done.append((action, owner, kw))
        return answer
    monkeypatch.setattr(device_setup, "run", run)
    monkeypatch.setattr(device_share, "refresh", lambda: order.append("refresh"))
    monkeypatch.setattr(rivendell, "redial", lambda: order.append("redial"))
    return done, order


def test_setup_runs_for_this_account_then_looks_again_and_redials(monkeypatch, device):
    _inst()
    device["share"] = "NEEDS_SETUP"
    done, order = _record_setup(monkeypatch, {"ok": True, "checks": [], "error": None})
    monkeypatch.setattr(device_share, "share_state",
                        lambda inst: {"state": "READY" if done else "NEEDS_SETUP", "checks": CHECKS, "facts": None})
    r = dpost("/local/rivendell/devices/setup", {"action": "setup"})
    assert done == [("setup", getpass.getuser(), {})]
    assert order == ["refresh", "redial"], "the device is looked at afresh before the links redial"
    assert r["code"] == 200 and (r["obj"]["ok"], r["obj"]["error"]) == (True, None)
    assert r["obj"]["instances"][0]["share"]["state"] == "READY"


def test_a_cancelled_remove_says_so(monkeypatch, device):
    _inst()
    done, order = _record_setup(monkeypatch, {"ok": False, "error": "Cancelled."})
    r = dpost("/local/rivendell/devices/setup", {"action": "remove"})
    assert [d[0] for d in done] == ["remove"] and order == ["refresh", "redial"]
    assert r["code"] == 200 and (r["obj"]["ok"], r["obj"]["error"]) == (False, "Cancelled.")
    assert r["obj"]["instances"][0]["share"]["state"] == "READY"


@pytest.mark.parametrize("action", [None, "", "install", "setup.sh", ["setup"]])
def test_setup_takes_only_setup_or_remove(action):
    assert dpost("/local/rivendell/devices/setup", {"action": action})["code"] == 400


def test_one_setup_at_a_time():
    assert dash._setup_lock.acquire(blocking=False)
    try:
        r = dpost("/local/rivendell/devices/setup", {"action": "setup"})
    finally:
        dash._setup_lock.release()
    assert r["code"] == 409


# --- the token gate -----------------------------------------------------------------------------

def _post_through_the_gate(path, body, token=None):
    """do_POST as a browser's request reaches it, with or without X-Dash-Token."""
    h, box = _dash()
    raw = json.dumps(body).encode()
    h.path, h.rfile = path, io.BytesIO(raw)
    h.headers = {"Host": f"127.0.0.1:{config.DASH_PORT}", "Content-Length": str(len(raw))}
    if token is not None:
        h.headers["X-Dash-Token"] = token
    h.do_POST()
    return box


@pytest.mark.parametrize("path, body", [
    ("/local/rivendell/devices/setup", {"action": "setup"}),
    ("/local/rivendell/devices", {"id": "x", "share_device": False}),
])
def test_a_post_without_the_dash_token_is_refused(path, body):
    """Refused at the gate every POST passes, before any route runs: the
    refusing device_setup.run is never reached."""
    assert _post_through_the_gate(path, body)["code"] == 401
    assert _post_through_the_gate(path, body, "not-the-token")["code"] == 401


def test_with_the_dash_token_the_setup_post_gets_through(monkeypatch, device):
    _inst()
    done, _ = _record_setup(monkeypatch, {"ok": True, "checks": [], "error": None})
    r = _post_through_the_gate("/local/rivendell/devices/setup", {"action": "setup"}, config.DASH_TOKEN)
    assert r["code"] == 200 and [d[0] for d in done] == ["setup"]
