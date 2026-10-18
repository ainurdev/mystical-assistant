"""Settings › Plugins › DEVICE RUNS: the three dashboard routes DeviceRunsPanel
draws and drives (bridge/dashboard/server.py).
  - GET /local/rivendell/devices: per instance, Share this device, where this
    device stands (device_share.share_state), the Claude account the runs you
    send use (a slot, null for the default login), the shared devices on now
    (Rivendell's, cached 30 s, null when it can't say) and the last run here.
  - POST /local/rivendell/devices: Share this device on or off, the account
    picked. Real JSON booleans only, since bool("false") is True, and only one
    of this Mystical's account slots, or null.
  - POST /local/rivendell/devices/setup: Set up or Remove, then the device is
    looked at afresh and each link whose offer changed redials. Neither while a
    teammate's run is going on this device.
  - POST /local/device-runs/stop: the owner's STOP RUN on the run going here (its
    read-only session, which the device rows name as running_session).
  - POST /local/sessions/<sid>/retitle, /share and /duplicate refuse a
    teammate's device run.

Set up and Remove are real in production: a macOS admin-password prompt, then a
root script that makes or deletes a macOS user. Nothing here may reach them or
any command: an autouse fixture makes device_setup.run, every subprocess
device_setup and device_share could start, device_side's STOP (sudo) and
Rivendell refuse, and one reached fails the test. A setup test installs a
recording fake of its own. This Mystical's Claude accounts are slots 1 and 2
(accounts.list_accounts, faked: the real one reads the logins on this machine).
Driven socket-free through Handler.__new__ (test_rivendell_tasks_endpoint.py).
Run: python -m pytest tests/test_dashboard_device_routes.py -v
"""

import getpass
import io
import json
import os
import subprocess
import threading
import types
import urllib.error

import pytest

from bridge import (accounts, config, device_ask, device_setup, device_share, device_side, device_view,
                    rivendell, rivendell_instances, store, titler)
from bridge.dashboard import server as dash

CHECKS = [{"key": "user", "label": "USER MYSTICALRUNS", "ok": True}]
LAST = {"at": 1760607600.0, "by": "Mahdi", "task": "NR-29"}
RID = "5b1d2c3e-0000-4000-8000-000000000001"
RUN_GOING = "A teammate's run is going on this device. Set up when it ends."
READ_ONLY = "This is a teammate's device run on this device. It's read only."


@pytest.fixture(autouse=True)
def refusing(monkeypatch, tmp_path):
    """Nothing may run. device_setup.run, any command device_setup or
    device_share could start, and any call to Rivendell refuse, and one reached
    fails the test even if something swallowed the error. No worker starts, and
    each test gets an empty instance store and an empty SHARED DEVICES ON NOW cache."""
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
    # stop_by_owner took subprocess.run as a default when it was imported: replaced whole.
    monkeypatch.setattr(device_side, "stop_by_owner", refuse("device_side.stop_by_owner"))
    monkeypatch.setattr(rivendell, "_workers", {})
    monkeypatch.setattr(rivendell, "reconfigure", lambda: None)
    monkeypatch.setattr(rivendell, "_device_run", None)         # no teammate's run going here
    monkeypatch.setattr(device_side, "_adopted", {})            # nor one a restart didn't end, waiting to be taken back
    monkeypatch.setattr(device_view, "_running", {})            # nor a read-only session of one
    monkeypatch.setattr(config, "BRIDGE_DB", str(tmp_path / "bridge.db"))
    monkeypatch.setattr(dash, "_shared_on", {})
    monkeypatch.setattr(config, "RIVENDELL_API_URL", "")
    monkeypatch.setattr(config, "RIVENDELL_TOKEN", "")
    monkeypatch.setattr(accounts, "list_accounts", lambda: [
        {"slot": 1, "email": "mahdi@example.com", "alias": None, "disabled": False, "default": True, "plan": None},
        {"slot": 2, "email": "mahdi@work.example", "alias": "Work", "disabled": False, "default": False, "plan": None}])
    yield
    assert not reached, f"reached from a device route test: {reached}"


@pytest.fixture
def device(monkeypatch):
    """This device as the test says: `share` is its state for a sharing
    instance (OFF for one that isn't; NOT_MAC off macOS), Rivendell has 3 on and
    2 free, and the last run here was Mahdi's NR-29."""
    box = {"share": "READY", "asked": [], "looked": []}

    def share_state(inst):
        box["looked"].append(inst["id"])
        if box["share"] == "NOT_MAC":
            return {"state": "NOT_MAC", "checks": [], "facts": None, "installed": False}
        return {"state": box["share"] if inst.get("share_device", True) else "OFF", "checks": CHECKS, "facts": None,
                "installed": True}
    monkeypatch.setattr(device_share, "share_state", share_state)
    monkeypatch.setattr(device_share, "device_facts",
                        lambda *a, **k: None if box["share"] == "NOT_MAC" else {"id": "7c50be1739dfacbb"})
    monkeypatch.setattr(device_share, "last_run", lambda: LAST)
    monkeypatch.setattr(device_ask, "list_devices",
                        lambda inst: box["asked"].append(inst["id"]) or {"devices": [], "on": 3, "free": 2})
    return box


@pytest.fixture
def run(monkeypatch, tmp_path):
    """A teammate's run going on this device: its read-only session, filed under
    device-run:<request id> by device_view.Run.open, in this test's own store."""
    monkeypatch.setattr(config, "UPLOAD_DIR", str(tmp_path / "uploads"))
    store.init()
    return device_view.Run.open("prod", RID, {})


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

def test_get_draws_each_enabled_instance_and_never_its_token(device):
    a = _inst()
    rivendell_instances.update_device(a["id"], device_account=2)
    b = _inst(name="staging", share_device=False)
    off = _inst(name="old", enable=False)
    r = dget()
    assert r["code"] == 200
    rows = {row["name"]: row for row in r["obj"]["instances"]}
    assert sorted(rows) == ["production", "staging"], "a switched-off instance isn't drawn"
    assert off["id"] not in device["looked"], "nor looked at: no dscl for it on every poll"
    p, s = rows["production"], rows["staging"]
    assert {k: p[k] for k in ("id", "api_url", "enable", "share_device", "device_account")} == {
        "id": a["id"], "api_url": "https://api.rivendell.ainurhq.cloud", "enable": True,
        "share_device": True, "device_account": 2}
    assert p["status"]["state"] == "off", "no worker runs it here"
    assert p["share"] == {"state": "READY", "checks": CHECKS, "facts": None, "installed": True}
    assert p["last_run"] == LAST and p["running"] is False and p["setup_running"] is False
    assert (s["id"], s["share_device"], s["device_account"]) == (b["id"], False, None)
    assert s["share"]["state"] == "OFF"
    assert p["shared_on"] is None and s["shared_on"] is None and device["asked"] == [], \
        "on a Mac SHARED DEVICES ON NOW isn't drawn, so Rivendell isn't asked: a save never waits on it"
    assert "rvd_owner" not in json.dumps(r["obj"])


def test_off_macos_the_shared_devices_on_now_come_from_rivendell(device):
    a = _inst()
    device["share"] = "NOT_MAC"
    row, = dget()["obj"]["instances"]
    assert row["share"]["state"] == "NOT_MAC" and row["shared_on"] == {"on": 3, "free": 2}
    assert device["asked"] == [a["id"]]


def test_while_a_set_up_runs_every_block_says_so_in_any_tab(device):
    """WAITING FOR YOUR PASSWORD… comes from here, so a reload or another tab
    shows it too, for the up to 15 minutes the script can take."""
    _inst()
    _inst(name="staging")
    assert dash._setup_lock.acquire(blocking=False)
    try:
        assert [row["setup_running"] for row in dget()["obj"]["instances"]] == [True, True]
    finally:
        dash._setup_lock.release()
    assert [row["setup_running"] for row in dget()["obj"]["instances"]] == [False, False]


def test_a_run_going_on_this_device_says_so_in_every_block(monkeypatch, device):
    """STATE reads `running now` while a teammate's run runs here, from whichever
    instance it came (rivendell._device_run: one at a time on the device)."""
    _inst()
    _inst(name="staging")
    monkeypatch.setattr(rivendell, "_device_run", "5b1d2c3e-0000-4000-8000-000000000001")
    assert [row["running"] for row in dget()["obj"]["instances"]] == [True, True]


def test_a_run_going_on_this_device_names_its_read_only_session_in_every_block(device, run):
    """The panel's WATCH and STOP RUN act on this session; null once the run is over."""
    _inst()
    _inst(name="staging")
    assert [row["running_session"] for row in dget()["obj"]["instances"]] == [run.sid, run.sid]
    run.close("done", {})
    assert [row["running_session"] for row in dget()["obj"]["instances"]] == [None, None]


def test_shared_devices_on_now_is_cached_30_s_and_null_when_rivendell_cant_say(monkeypatch, device):
    a = _inst()
    device["share"] = "NOT_MAC"
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


# --- POST: Share this device and the account ---------------------------------------------------

def test_post_switches_sharing_and_picks_the_account(monkeypatch, device):
    a = _inst()
    seen = []
    monkeypatch.setattr(rivendell, "reconfigure", lambda: seen.append(_stored()))
    r = dpost("/local/rivendell/devices", {"id": a["id"], "share_device": False, "device_account": 2})
    assert r["code"] == 200 and r["obj"]["ok"] is True
    stored = _stored()
    assert (stored["share_device"], stored["device_account"]) == (False, 2)
    assert (stored["name"], stored["enable"], stored["token"]) == ("production", True, "rvd_owner"), "nothing else moves"
    assert [s["share_device"] for s in seen] == [False], "the link redials with the change saved"
    row, = r["obj"]["instances"]
    assert (row["share_device"], row["device_account"]) == (False, 2)


def test_a_field_left_out_is_kept_and_a_null_account_is_the_default_login(device):
    a = _inst(share_device=False)
    rivendell_instances.update_device(a["id"], device_account=2)
    for body in ({}, {"share_device": None}):
        assert dpost("/local/rivendell/devices", {"id": a["id"], **body})["code"] == 200
        assert (_stored()["share_device"], _stored()["device_account"]) == (False, 2)
    r = dpost("/local/rivendell/devices", {"id": a["id"], "device_account": None})
    assert r["code"] == 200 and (_stored()["share_device"], _stored()["device_account"]) == (False, None)
    assert r["obj"]["instances"][0]["device_account"] is None


@pytest.mark.parametrize("bad", [
    {"share_device": "false"}, {"share_device": 0}, {"share_device": 1},
    {"device_account": 7}, {"device_account": "2"}, {"device_account": 2.0}, {"device_account": True},
    {"device_account": [2]}, {"device_account": {"slot": 2}},
])
def test_post_takes_only_real_booleans_and_this_mysticals_accounts(monkeypatch, bad):
    a = _inst()
    monkeypatch.setattr(rivendell, "reconfigure", lambda: pytest.fail("nothing was saved"))
    assert dpost("/local/rivendell/devices", {"id": a["id"], **bad})["code"] == 400
    assert (_stored()["share_device"], _stored()["device_account"]) == (True, None)


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
        order.append("run")
        if isinstance(answer, BaseException):
            raise answer
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
    assert order == ["run", "refresh", "redial"], "the device is looked at afresh, then the links redial"
    assert r["code"] == 200 and (r["obj"]["ok"], r["obj"]["error"]) == (True, None)
    assert r["obj"]["instances"][0]["share"]["state"] == "READY"


def test_a_cancelled_remove_says_so(monkeypatch, device):
    _inst()
    done, order = _record_setup(monkeypatch, {"ok": False, "error": "Cancelled."})
    r = dpost("/local/rivendell/devices/setup", {"action": "remove"})
    assert [d[0] for d in done] == ["remove"] and order == ["run", "refresh", "redial"]
    assert r["code"] == 200 and (r["obj"]["ok"], r["obj"]["error"]) == (False, "Cancelled.")
    assert r["obj"]["instances"][0]["share"]["state"] == "READY"


@pytest.mark.parametrize("action", [None, "", "install", "setup.sh", ["setup"]])
def test_setup_takes_only_setup_or_remove(action):
    assert dpost("/local/rivendell/devices/setup", {"action": action})["code"] == 400


def test_off_macos_set_up_is_a_400_and_nothing_runs(device):
    device["share"] = "NOT_MAC"
    r = dpost("/local/rivendell/devices/setup", {"action": "setup"})
    assert r["code"] == 400 and r["obj"]["error"]      # the refusing device_setup.run was never reached


def test_a_set_up_that_crashes_still_looks_again_redials_and_lets_go_of_the_lock(monkeypatch, device):
    _inst()
    done, order = _record_setup(monkeypatch, OSError("osascript went away"))
    with pytest.raises(OSError):
        dpost("/local/rivendell/devices/setup", {"action": "setup"})
    assert order == ["run", "refresh", "redial"] and not dash._setup_lock.locked()


def test_one_setup_at_a_time(device):
    assert dash._setup_lock.acquire(blocking=False)
    try:
        r = dpost("/local/rivendell/devices/setup", {"action": "setup"})
    finally:
        dash._setup_lock.release()
    assert r["code"] == 409


@pytest.mark.parametrize("action", ["setup", "remove"])
def test_set_up_and_remove_wait_while_a_teammates_run_goes_on_here(monkeypatch, device, action):
    """Set up proves the pf wall round the run's user again and may take it down
    for a moment; Remove deletes that user. Refused before anything runs, the
    lock let go; the same call goes through once the run is over."""
    _inst()
    done, order = _record_setup(monkeypatch, {"ok": True, "checks": [], "error": None})
    monkeypatch.setattr(rivendell, "_device_run", RID)
    r = dpost("/local/rivendell/devices/setup", {"action": action})
    assert r["code"] == 409 and r["obj"] == {"error": RUN_GOING}
    assert done == [] and order == [] and not dash._setup_lock.locked()
    monkeypatch.setattr(rivendell, "_device_run", None)
    r = dpost("/local/rivendell/devices/setup", {"action": action})
    assert r["code"] == 200 and [d[0] for d in done] == [action] and order == ["run", "refresh", "redial"]


@pytest.mark.parametrize("action", ["setup", "remove"])
def test_a_run_a_restart_didnt_end_counts_as_going_until_it_is_taken_back(monkeypatch, device, action):
    """After a restart a run whose helper went on is filed for its instance's
    worker (device_side.sweep), holding no _device_run until that worker's first
    READY connect: meanwhile STATE says running now, and Set up and Remove wait."""
    _inst()
    done, order = _record_setup(monkeypatch, {"ok": True, "checks": [], "error": None})
    monkeypatch.setattr(device_side, "_adopted", {"t1": [RID]})
    assert [row["running"] for row in dget()["obj"]["instances"]] == [True]
    r = dpost("/local/rivendell/devices/setup", {"action": action})
    assert r["code"] == 409 and r["obj"] == {"error": RUN_GOING}
    assert done == [] and order == [] and not dash._setup_lock.locked()
    monkeypatch.setattr(device_side, "_adopted", {})             # taken back: _device_run holds it from here
    assert [row["running"] for row in dget()["obj"]["instances"]] == [False]


def test_no_run_is_claimed_while_set_up_runs(monkeypatch, device):
    """Set up holds its lock for up to 15 minutes while the device stays READY:
    all that time the device names itself to nothing (device_side.headers), so
    a run announced meanwhile is never claimed. The lock goes with the Set up."""
    _inst()
    seen = []

    class Worker:
        inst, name = {"id": "t1"}, "production"

        def _api(self, path, *a, **k):
            seen.append(("claimed", path))

    def setup(action, owner, **kw):
        seen.append(("headers", device_side.headers({"id": "t1"})))
        device_side.run(Worker(), RID, popen=lambda *a, **k: pytest.fail("no helper mid-Set up"),
                        call=lambda *a, **k: pytest.fail("nothing to stop"))
        return {"ok": True, "checks": [], "error": None}
    monkeypatch.setattr(device_setup, "run", setup)
    monkeypatch.setattr(device_share, "refresh", lambda: None)
    monkeypatch.setattr(rivendell, "redial", lambda: None)
    r = dpost("/local/rivendell/devices/setup", {"action": "setup"})
    assert r["code"] == 200 and seen == [("headers", None)]
    assert not device_side.setup_lock.locked() and not dash._setup_lock.locked()


@pytest.mark.parametrize("share, code", [("false", 400), (0, 400), ("", 400), (False, 200), (None, 200)])
def test_the_instance_form_takes_only_a_real_boolean_for_share_device_too(share, code):
    a = _inst()
    r = dpost("/local/rivendell", {"op": "update", "id": a["id"], "name": "production",
                                   "api_url": "https://api.rivendell.ainurhq.cloud", "share_device": share})
    assert r["code"] == code, r["obj"]
    assert _stored()["share_device"] is (share is not False), "None keeps it; a refused one changes nothing"


# --- POST: STOP RUN ----------------------------------------------------------------------------

def _record_stops(monkeypatch):
    """device_side.stop_by_owner recording the request ids it is asked to stop;
    `began` is set when one is."""
    stops, began = [], threading.Event()

    def stop_by_owner(request_id):
        stops.append(request_id)
        began.set()
    monkeypatch.setattr(device_side, "stop_by_owner", stop_by_owner)
    return stops, began


def test_stop_stops_the_run_going_here_and_answers_before_the_stop_is_done(monkeypatch, run):
    """The helper's stop can take up to 60 s (stop_by_owner): it runs on a thread
    of its own, and the answer doesn't wait for it."""
    began, let_go, ended, seen = threading.Event(), threading.Event(), threading.Event(), []

    def stop_by_owner(request_id):
        seen.append((request_id, threading.get_ident()))
        began.set()
        let_go.wait(10)
        ended.set()
    monkeypatch.setattr(device_side, "stop_by_owner", stop_by_owner)
    r = dpost("/local/device-runs/stop", {"session": run.sid})
    assert r["code"] == 200 and r["obj"] == {"ok": True}
    assert began.wait(5) and not ended.is_set(), "the answer waited for the stop"
    let_go.set()
    assert ended.wait(5)
    assert [rid for rid, _ in seen] == [RID], "the request id is the one in the session's ref"
    assert seen[0][1] != threading.get_ident()


def test_stopping_what_isnt_the_run_going_here_is_a_404_and_stops_nothing(monkeypatch, run):
    stops, began = _record_stops(monkeypatch)
    over = device_view.Run.open("prod", "7c0e1a2b-0000-4000-8000-000000000002", {})
    over.close("done", {})                                     # a finished run's session is still a device run's
    ordinary = store.create_session(config.DASH_CHAT_ID, "/")["id"]
    for body in ({"session": over.sid}, {"session": ordinary}, {"session": "nope"}, {"session": ""},
                 {"session": None}, {"session": 7}, {"session": [run.sid]}, {"session": {"id": run.sid}}, {}):
        r = dpost("/local/device-runs/stop", body)
        assert r["code"] == 404 and r["obj"] == {"error": "not a device run going on this device"}, body
    assert not began.wait(0.05) and stops == []


def test_with_no_run_going_a_stop_naming_no_session_is_still_a_404(monkeypatch):
    """No run and no session are both None: they mustn't count as a match."""
    stops, began = _record_stops(monkeypatch)
    assert device_view.running_session() is None
    for body in ({}, {"session": None}, {"session": ""}):
        r = dpost("/local/device-runs/stop", body)
        assert r["code"] == 404 and r["obj"] == {"error": "not a device run going on this device"}, body
    assert not began.wait(0.05) and stops == []


# --- POST: Retitle of a session ----------------------------------------------------------------

def test_retitle_refuses_a_teammates_device_run_and_asks_no_model(monkeypatch, run):
    """Titling sends the session's prompt and reply to a model on this device's
    Claude account: the teammate's words don't go there."""
    asked = []
    monkeypatch.setattr(titler, "regenerate", lambda chat, s: asked.append(s["id"]) or True)
    for body in ({}, {"title": "Mine"}):
        r = dpost(f"/local/sessions/{run.sid}/retitle", body)
        assert r["code"] == 409 and r["obj"] == {"error": READ_ONLY}
    assert asked == [] and store.get_session(run.sid)["title"] != "Mine"


def test_retitle_of_an_ordinary_session_still_goes_to_the_model(monkeypatch):
    store.init()
    sid = store.create_session(config.DASH_CHAT_ID, "/")["id"]
    asked = []
    monkeypatch.setattr(titler, "regenerate", lambda chat, s: asked.append(s["id"]) or True)
    r = dpost(f"/local/sessions/{sid}/retitle", {})
    assert r["code"] == 200 and r["obj"] == {"ok": True, "generating": True} and asked == [sid]


# --- POST: Share and Duplicate of a session ---------------------------------------------------

def test_share_and_duplicate_refuse_a_teammates_device_run(monkeypatch, run):
    """The UI hides both, and the bridge refuses them too: a link would show the
    teammate's run, their code and .env values among it, to whoever holds it, and
    a copy would be an ordinary session carrying their run on under this
    account. Revoking links stays open: it can only take one away."""
    made = []
    monkeypatch.setattr(store, "create_share", lambda *a, **k: made.append("share"))
    monkeypatch.setattr(store, "duplicate", lambda *a, **k: made.append("duplicate"))
    for path in (f"/local/sessions/{run.sid}/share", f"/local/sessions/{run.sid}/duplicate"):
        r = dpost(path, {"days": 7})
        assert r["code"] == 409 and r["obj"] == {"error": READ_ONLY}, path
    assert made == []
    r = dpost(f"/local/sessions/{run.sid}/share", {"revoke": True})
    assert r["code"] == 200 and r["obj"]["revoked"] == 0


def test_share_and_duplicate_of_an_ordinary_session_still_go():
    store.init()
    sid = store.create_session(config.DASH_CHAT_ID, "/")["id"]
    r = dpost(f"/local/sessions/{sid}/share", {"days": 7})
    assert r["code"] == 200 and r["obj"]["url"] == f"/share/{r['obj']['token']}"
    r = dpost(f"/local/sessions/{sid}/duplicate", {})
    assert r["code"] == 200 and r["obj"]["session"]["id"] != sid


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
    ("/local/device-runs/stop", {"session": "x"}),
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


def test_with_the_dash_token_the_stop_post_gets_through(monkeypatch, run):
    stops, began = _record_stops(monkeypatch)
    r = _post_through_the_gate("/local/device-runs/stop", {"session": run.sid}, config.DASH_TOKEN)
    assert r["code"] == 200 and began.wait(5) and stops == [RID]
