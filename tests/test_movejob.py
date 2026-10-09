"""The dashboard's MOVE jobs (bridge/movejob.py) and their /local/move/* routes.

move.py's own work is covered by test_move.py; here it is swapped for fakes
that report progress the way it does, so these tests are about the runner: one
job at a time, on a thread, cancellable, its list surviving a restart, and the
routes refusing what they should.
"""

import json
import os
import threading
import time

import pytest

from bridge import config, move, movejob
from bridge.dashboard import server as dash


@pytest.fixture(autouse=True)
def state(tmp_path, monkeypatch):
    """A state dir of our own and an empty job list for every test."""
    monkeypatch.setattr(config, "BRIDGE_DB", str(tmp_path / "state" / "bridge.db"))
    os.makedirs(tmp_path / "state")
    monkeypatch.setattr(movejob, "_jobs", [])
    monkeypatch.setattr(movejob, "_loaded", False)
    return tmp_path / "state"


def _wait(status="running", timeout=5.0):
    """The newest job, once it has left `status`."""
    end = time.time() + timeout
    while time.time() < end:
        j = movejob.jobs()[-1]
        if j["status"] != status:
            return j
        time.sleep(.02)
    raise AssertionError(f"job still {status}")


def _fake_export(monkeypatch, gate=None):
    def export(out, skip=(), progress=None, log=print, **kw):
        progress.step("repos", 2)
        for r in ("a", "b"):
            progress.check()
            progress.item(r)
            log(f"  {r}")
            progress.tick(r)
        if gate:
            while not gate.wait(.01):
                progress.check()
        for k in ("mcp", "plugins", "claude", "bridge"):
            progress.step(k, 1)
            progress.tick()
        with open(out, "wb") as f:
            f.write(b"x" * 10)
        return out
    monkeypatch.setattr(move, "export", export)


def test_an_export_runs_on_a_thread_and_ends_done(tmp_path, monkeypatch):
    _fake_export(monkeypatch)
    out = str(tmp_path / "m.tar.gz")
    got = movejob.export(out, ["history"])
    assert got["status"] == "running" and got["kind"] == "export"
    j = _wait()
    assert j["status"] == "done" and j["pct"] == 100
    assert j["result"] == {"path": out, "bytes": 10}
    states = {s["key"]: s["state"] for s in j["steps"]}
    assert states["history"] == "skipped" and states["repos"] == "done"
    assert j["log"] == ["a", "b"]


def test_one_job_at_a_time_and_cancel_stops_it(tmp_path, monkeypatch):
    gate = threading.Event()
    _fake_export(monkeypatch, gate)
    movejob.export(str(tmp_path / "a.tar.gz"), [])
    time.sleep(.1)
    running = movejob.jobs()[-1]
    assert running["steps"][0]["done"] == 2 and running["pct"] > 0
    assert movejob.export(str(tmp_path / "b.tar.gz"), []) == {"error": movejob.BUSY}
    assert movejob.cancel() is True
    j = _wait()
    assert j["status"] == "cancelled"
    assert [s["state"] for s in j["steps"]][:2] == ["cancelled", "queued"]


def test_a_failure_is_kept_with_its_reason(tmp_path, monkeypatch):
    def export(out, **kw):
        raise OSError(28, "No space left on device")
    monkeypatch.setattr(move, "export", export)
    movejob.export(str(tmp_path / "m.tar.gz"), [])
    j = _wait()
    assert j["status"] == "failed" and "No space left" in j["error"]


def test_the_list_survives_a_restart_and_a_running_job_comes_back_failed(state, monkeypatch):
    (state / "move_jobs.json").write_text(json.dumps([
        {"id": "a", "kind": "export", "status": "done", "steps": []},
        {"id": "b", "kind": "import", "status": "running", "steps": []}]))
    got = {j["id"]: j for j in movejob.jobs()}
    assert got["a"]["status"] == "done"
    assert got["b"]["status"] == "failed" and "stopped" in got["b"]["error"]
    movejob.dismiss("a")
    assert [j["id"] for j in json.loads((state / "move_jobs.json").read_text())] == ["b"]


def test_an_imports_whats_left_drops_the_restart_once_the_bridge_has_rebooted(tmp_path, monkeypatch):
    f = tmp_path / "mystical-move-old-1.tar.gz"
    f.write_bytes(b"x" * 3)
    nxt = [{"key": "restart", "text": "r"}, {"key": "mcp", "text": "m", "items": ["docs"]}]
    before = {"id": "x", "kind": "import", "status": "done", "ended": movejob.BOOT - 60,
              "file": str(f), "result": {"next": nxt}, "steps": []}
    after = dict(before, id="y", ended=movejob.BOOT + 60)
    monkeypatch.setattr(movejob, "_jobs", [before, after])
    monkeypatch.setattr(movejob, "_loaded", True)
    got = {j["id"]: [n["key"] for n in j["next"]] for j in movejob.jobs()}
    assert got == {"x": ["mcp", "delete"], "y": ["restart", "mcp", "delete"]}
    f.unlink()
    assert [n["key"] for n in movejob.jobs()[0]["next"]] == ["mcp"], "a deleted file isn't left"


def test_read_unpacks_once_privately_and_import_clears_it(tmp_path, monkeypatch):
    src = tmp_path / "mystical-move-old-2.tar.gz"
    src.write_bytes(b"x" * 100)

    def unpack(path, dest, progress=None):
        os.makedirs(dest)
        progress.bytes(100, 100)
        return {"from": {"host": "old"}}
    monkeypatch.setattr(move, "unpack", unpack)
    monkeypatch.setattr(move, "inspect", lambda root, progress=None: {
        "from": {"host": "Old"}, "sections": [{"key": "repos", "items": []}], "report": {}})
    applied = {}

    def apply(root, skip=(), progress=None, log=print):
        applied.update(root=root, skip=list(skip))
        return {"report": {}, "park": "/p", "next": []}
    monkeypatch.setattr(move, "apply", apply)

    assert movejob.import_([]) == {"error": "read a move file first"}
    movejob.read(str(src))
    j = _wait()
    assert j["status"] == "done" and j["pct"] == 100
    assert oct(os.stat(movejob.read_dir()).st_mode & 0o777) == "0o700"
    st = movejob.read_state()
    assert st["file"] == str(src) and st["from"]["host"] == "Old"
    movejob.import_(["repos:solo"])
    j = _wait()
    assert j["status"] == "done" and j["title"] == "Old"
    assert applied == {"root": os.path.join(movejob.read_dir(), "x"), "skip": ["repos:solo"]}
    assert not os.path.exists(movejob.read_dir()), "the unpacked secrets go once imported"
    assert [n["key"] for n in j["next"]] == ["delete"]


def test_export_refuses_a_bad_target(tmp_path):
    assert "tar.gz" in movejob.export(str(tmp_path / "m.zip"), [])["error"]
    assert "no folder" in movejob.export(str(tmp_path / "nope" / "m.tar.gz"), [])["error"]
    (tmp_path / "m.tar.gz").write_text("")
    assert "already there" in movejob.export(str(tmp_path / "m.tar.gz"), [])["error"]


def test_delete_only_takes_a_move_file(tmp_path):
    other = tmp_path / "notes.tar.gz"
    other.write_text("")
    assert "error" in movejob.delete_file(str(other))
    assert other.exists()
    mv = tmp_path / "mystical-move-old-3.tar.gz"
    mv.write_text("")
    assert movejob.delete_file(str(mv)) == {"ok": True}
    assert not mv.exists()


# --- the routes ---------------------------------------------------------------

def _dash():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


def test_routes_read_and_refuse(tmp_path):
    h, box = _dash()
    h._get_api("/local/move/jobs", {})
    assert box == {"obj": {"jobs": []}, "code": 200}
    h._get_api("/local/move/read", {})
    assert box["obj"] == {"read": None}
    h._post_api("/local/move/nope", {})
    assert box["code"] == 404
    h._post_api("/local/move/delete", {"path": "/etc/hosts"})
    assert box["code"] == 400
    h._post_api("/local/move/cancel", {})
    assert box == {"obj": {"ok": False}, "code": 200}
