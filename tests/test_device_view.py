"""bridge/device_view.py: a teammate's device run as a read-only session, fed from
its own stream by a converter that stores events and does nothing else, and the
guards that keep the session from ever running or resuming on this account.
Run: python -m pytest tests/test_device_view.py -q"""

import base64
import builtins
import io
import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid

import pytest

from bridge import config, device_side, device_view, pubsub, runner, store  # noqa: F401 - device_side loaded before any spy
from bridge.miniapp import server as mini

store.init()
CHAT = config.DASH_CHAT_ID
PNG = b"\x89PNG\r\n\x1a\n" + b"the stream's own picture"
SAFE_ID = re.compile(r"[A-Za-z0-9_-]{1,100}")


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(config, "UPLOAD_DIR", str(tmp_path / "uploads"))
    monkeypatch.setattr(device_view, "_running", {})


def _rid() -> str:
    return str(uuid.uuid4())


def _claim(request="Build and run the iOS app\nthen screenshot it") -> dict:
    """A claim as Rivendell's DeviceRunClaimDto has it, prompt from its template."""
    prompt = ("You are running a device test that Erfan Besharat asked for, on a shared device, as an "
              "isolated user.\n\nRepository: ainurhq/ibgroups_operations at 04dac9b\nTask: IBG-12 · Sign-in\n"
              "Pull request: ainurhq/ibgroups_operations#81\n\nThe request, verbatim:\n---\n"
              f"{request}\n---\n\nThe current folder is a copy of their code. Install what it needs.\n\n"
              "End your answer with one JSON object and nothing after it:\n"
              '{"summary": "<what you did>", "screens": [{"file": "1.png", "caption": "<one line>"}]}')
    return {"requestId": "r", "repository": "ainurhq/ibgroups_operations", "commitSha": "04dac9b",
            "task": {"key": "IBG-12", "title": "Sign-in"},
            "pullRequest": {"repository": "ainurhq/ibgroups_operations", "number": 81},
            "requester": {"name": "Erfan Besharat", "email": "erfan@example.com"}, "prompt": prompt,
            "snapshotUrl": "https://rivendell.example/snap", "gitAuthorName": "Erfan",
            "gitAuthorEmail": "erfan@example.com", "claudeToken": "sk-ant-oat01-NEVERSTORED", "dirty": False}


def _assistant(*blocks) -> dict:
    return {"type": "assistant", "message": {"role": "assistant", "content": list(blocks)},
            "parent_tool_use_id": None, "session_id": "the-teammates-claude-session"}


def _user(*blocks, result=None) -> dict:
    rec = {"type": "user", "message": {"role": "user", "content": list(blocks)},
           "session_id": "the-teammates-claude-session"}
    if result is not None:
        rec["tool_use_result"] = result
    return rec


def _pic(media_type="image/png", data=PNG) -> dict:
    return {"type": "image", "source": {"type": "base64", "media_type": media_type,
                                        "data": base64.b64encode(data).decode()}}


def _line(rec) -> bytes:
    return (json.dumps(rec) + "\n").encode()


def _stage(tmp_path, *recs):
    stage = tmp_path / "stage"
    stage.mkdir()
    (stage / "live.jsonl").write_bytes(b"".join(_line(r) for r in recs))
    return stage


def _events(sid):
    return store.transcript(sid)["events"]


def test_feed_converts_a_real_stream():
    feed = device_view.Feed("/never-written")
    stream = [
        ({"type": "system", "subtype": "init", "cwd": "/Users/mysticalruns/runs/x/code",
          "session_id": "s1", "model": "claude-opus-5-5", "tools": ["Bash"]}, 99.0),
        (_assistant({"type": "text", "text": "I'll boot a simulator."}), 100.0),
        (_assistant({"type": "thinking", "thinking": "Which device?", "signature": "sig"}), 101.0),
        (_assistant({"type": "tool_use", "id": "toolu_01", "name": "Bash",
                     "input": {"command": 'xcrun simctl boot "iPhone 17 Pro"', "description": "Boot"}}), 102.0),
        (_user({"type": "tool_result", "tool_use_id": "toolu_01", "content": "booted", "is_error": False},
               result={"stdout": "booted", "stderr": "", "interrupted": False, "isImage": False}), 103.5),
        (_assistant({"type": "thinking", "thinking": "", "signature": "sig"}), 108.0),   # a long pause, text stripped
        (_assistant({"type": "thinking", "thinking": "", "signature": "sig"}), 109.0),   # a short one: no marker
        (_assistant({"type": "tool_use", "id": "toolu_02", "name": "Task",
                     "input": {"subagent_type": "Explore", "description": "Find the app",
                               "prompt": "Find the Expo app"}}), 110.0),
        ({"type": "result", "subtype": "success", "is_error": False, "duration_ms": 65400, "num_turns": 3,
          "result": "Booted it.", "session_id": "s1", "total_cost_usd": 0.25, "usage": {}}, 111.0),
    ]
    assert [e for rec, now in stream for e in feed.events(rec, now)] == [
        {"type": "text", "text": "I'll boot a simulator."},
        {"type": "thinking", "ms": 1000, "text": "Which device?"},
        {"type": "tool", "name": "Bash", "id": "toolu_01", "summary": 'xcrun simctl boot "iPhone 17 Pro"'},
        {"type": "tool_done", "id": "toolu_01", "ms": 1500, "output": "booted", "is_error": False},
        {"type": "thinking", "ms": 4500},
        {"type": "tool", "name": "Task", "id": "toolu_02", "summary": "Find the Expo app",
         "agent": {"type": "Explore", "title": "Find the app"}},
        {"type": "result", "result": "Booted it.", "cost": 0.25, "elapsed": 65, "is_error": False},
    ]


def test_feed_drops_session_ids(tmp_path, monkeypatch):
    def boom(*a, **k):
        raise AssertionError("a device run stored the teammate's claude session id")
    monkeypatch.setattr(store, "set_claude_session_id", boom)
    run = device_view.Run.open("prod", _rid(), _claim())
    stage = _stage(tmp_path, {"type": "system", "subtype": "init", "session_id": "teammate"},
                   _assistant({"type": "text", "text": "hi"}),
                   {"type": "result", "result": "ok", "session_id": "teammate", "total_cost_usd": 0.1,
                    "duration_ms": 2000, "is_error": False})
    assert run.pump(str(stage)) == 2
    assert not any("session_id" in e for e in _events(run.sid))
    assert store.get_session(run.sid)["claude_session_id"] is None
    run.close("done", {})


def test_feed_never_touches_paths_the_stream_names(tmp_path, monkeypatch):
    secret = tmp_path / "secret.png"
    secret.write_bytes(b"the owner's own file")
    clip = tmp_path / "clip.mp4"
    clip.write_bytes(b"a recording")
    named, touched = {str(secret), str(clip)}, []

    def spy(fn):
        def wrapped(*a, **k):
            touched.extend(os.fspath(x) for x in a if isinstance(x, (str, os.PathLike)))
            return fn(*a, **k)
        return wrapped
    for mod, name in ((os, "open"), (builtins, "open"), (io, "open"), (shutil, "copy"), (shutil, "copy2"),
                      (shutil, "copyfile"), (shutil, "move"), (os, "replace"), (os, "rename"), (os, "link")):
        monkeypatch.setattr(mod, name, spy(getattr(mod, name)))
    up = tmp_path / "up"
    feed = device_view.Feed(str(up))
    stream = [
        _assistant({"type": "tool_use", "id": "toolu_read", "name": "Read", "input": {"file_path": str(secret)}}),
        _user({"type": "tool_result", "tool_use_id": "toolu_read", "content": [_pic()]},
              result={"type": "image", "file": {"base64": "…", "type": "image/png"}}),
        _assistant({"type": "tool_use", "id": "toolu_rec", "name": "mcp__verify__Record", "input": {"notes": "n"}}),
        _user({"type": "tool_result", "tool_use_id": "toolu_rec",
               "content": [{"type": "text", "text": f"{clip}\nCHAPTERS []"}]}),
        _assistant({"type": "tool_use", "id": "toolu_att", "name": "mcp__verify__Attach", "input": {"path": str(secret)}}),
        _user({"type": "tool_result", "tool_use_id": "toolu_att", "content": [{"type": "text", "text": str(secret)}]}),
    ]
    evs = [e for i, rec in enumerate(stream) for e in feed.events(rec, 100.0 + i)]
    assert not named & set(touched)
    assert secret.read_bytes() == b"the owner's own file" and clip.read_bytes() == b"a recording"
    assert os.listdir(up) == ["dr-1.png"] and (up / "dr-1.png").read_bytes() == PNG   # the stream's bytes
    done = [e for e in evs if e["type"] == "tool_done"]
    assert [d.get("images") for d in done] == [[str(up / "dr-1.png")], None, None]
    assert not any("clip" in d for d in done)


def test_feed_sanitises_ids_and_media(tmp_path, monkeypatch):
    up = tmp_path / "up"
    feed = device_view.Feed(str(up))
    tool, = feed.events(_assistant({"type": "tool_use", "id": "../../x", "name": "mcp__playwright__screenshot",
                                    "input": {}}), 100.0)
    assert SAFE_ID.fullmatch(tool["id"]) and tool["id"] != "../../x"
    monkeypatch.setattr(device_view, "_IMG_MAX", len(PNG))
    done, = feed.events(_user({"type": "tool_result", "tool_use_id": "../../x", "content": [
        _pic("image/svg+xml", b"<svg onload='alert(1)'/>"), _pic("image/png", PNG + b"!"),   # one byte over
        {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "!not base64!"}},
        *[_pic()] * 5]}), 101.0)
    assert done["id"] == tool["id"]
    assert done["images"] == [str(up / f"dr-{i}.png") for i in range(1, 5)]   # at most 4 a result
    assert sorted(os.listdir(up)) == [f"dr-{i}.png" for i in range(1, 5)]
    stray, odd = feed.events(_user({"type": "tool_result", "tool_use_id": "../y", "content": "x"},
                                   {"type": "tool_result", "tool_use_id": {"not": "a string"}, "content": "x"}), 102.0)
    assert SAFE_ID.fullmatch(stray["id"]) and SAFE_ID.fullmatch(odd["id"])
    named, = feed.events(_assistant({"type": "tool_use", "id": 7, "name": {"no": "name"}, "input": "x"}), 103.0)
    assert named["name"] == "tool" and SAFE_ID.fullmatch(named["id"])


def test_feed_redacts_tokens():
    feed = device_view.Feed("/never-written")
    evs = feed.events(_assistant({"type": "text", "text": "the token is sk-ant-abc123"},
                                 {"type": "tool_use", "id": "toolu_1", "name": "Bash",
                                  "input": {"command": "env CLAUDE_CODE_OAUTH_TOKEN=xyz make"}}), 100.0)
    evs += feed.events(_user({"type": "tool_result", "tool_use_id": "toolu_1", "content": "sk-ant-oat01-xyz",
                              "is_error": False}), 101.0)
    evs += feed.events({"type": "result", "result": "done, sk-ant-zzz", "total_cost_usd": 0.1,
                        "duration_ms": 1000, "is_error": False}, 102.0)
    assert evs[0]["text"] == "the token is [redacted]"
    assert evs[1]["summary"] == "env [redacted] make"
    assert evs[2]["output"] == "[redacted]" and evs[3]["result"] == "done, [redacted]"
    assert "sk-ant" not in json.dumps(evs)


def test_display_text_swaps_the_report_for_its_summary():
    assert device_view.display_text('All good.\n{"summary": "Built and ran.", "screens": []}') == "All good.\nBuilt and ran."
    assert device_view.display_text('{"summary": "Only this."}') == "Only this."
    assert device_view.display_text('Said {"a": 1} midway.') == 'Said {"a": 1} midway.'      # not trailing
    assert device_view.display_text('{"summary": 3}') == '{"summary": 3}'                   # not a string
    hostile = '{"a":' * 800_000 + "}"                     # 4 MB of starts that each parse a long way
    t0 = time.monotonic()
    assert device_view.display_text(hostile) == hostile
    assert time.monotonic() - t0 < 5


def test_request_text_takes_the_verbatim_block():
    assert device_view.request_text(_claim()["prompt"]) == "Build and run the iOS app\nthen screenshot it"
    assert device_view.request_text(_claim("Check the menu\n---\nand the footer")["prompt"]) == \
        "Check the menu\n---\nand the footer"                 # a "---" line of the asker's stays theirs
    assert device_view.request_text("Just run it.") == "Just run it."


def test_open_makes_a_read_only_session():
    rid = _rid()
    run = device_view.Run.open("prod", rid, _claim("Build and run the iOS app\nthen screenshot it sk-ant-oops"))
    s = store.get_session(run.sid)
    assert (s["origin"], s["ref"], s["chat_id"]) == ("device-run:prod", f"device-run:{rid}", CHAT)
    assert (s["title"], s["title_source"]) == ("Build and run the iOS app", "manual")
    assert s["claude_session_id"] is None
    assert [(t["id"], t["status"], t["prompt"]) for t in store.transcript(run.sid)["turns"]] == [
        (run.tid, "running", "Build and run the iOS app\nthen screenshot it [redacted]")]
    meta = {"request": rid, "instance": "prod", "by": "Erfan Besharat", "repo": "ainurhq/ibgroups_operations",
            "sha": "04dac9b", "pr": 81, "task": {"key": "IBG-12", "title": "Sign-in"}, "outcome": None}
    assert store.parse_device(s["device"]) == meta
    assert mini._session_brief(s)["device"] == meta
    assert "NEVERSTORED" not in json.dumps(store.transcript(run.sid), default=str)
    assert device_view.running_session() == run.sid
    assert run.sid in store.running_session_ids(CHAT)          # the dashboard polls it as working
    run.close("done", {})


def test_pump_reads_new_lines_once_and_keeps_its_offset(tmp_path):
    rid = _rid()
    run = device_view.Run.open("prod", rid, _claim())
    q = pubsub.subscribe(f"session:{run.sid}")
    first = _line(_assistant({"type": "text", "text": "one"})) + _line(_assistant({"type": "text", "text": "two"}))
    third = _line(_assistant({"type": "text", "text": "three"}))
    stage = _stage(tmp_path)
    live = stage / "live.jsonl"
    live.write_bytes(first + third[:10])                  # the third line is still being written
    assert run.pump(str(stage)) == 2
    assert (stage / "live.offset").read_text() == str(len(first))
    assert [(m["seq"], m["text"]) for m in (q.get_nowait(), q.get_nowait())] == [(0, "one"), (1, "two")]
    with live.open("ab") as f:
        f.write(third[10:])
    assert run.pump(str(stage)) == 1
    assert run.pump(str(stage)) == 0
    again = device_view.reopen(rid)                       # a restart: a new Run on the same session
    assert (again.sid, again.tid) == (run.sid, run.tid)
    with live.open("ab") as f:
        f.write(_line(_assistant({"type": "text", "text": "four"})))
    assert again.pump(str(stage)) == 1
    assert [(e["seq"], e["text"]) for e in _events(run.sid)] == [(0, "one"), (1, "two"), (2, "three"), (3, "four")]
    assert device_view.reopen(_rid()) is None
    pubsub.unsubscribe(f"session:{run.sid}", q)
    again.close("done", {})


def test_pump_waits_on_a_missing_or_unreadable_live_file(tmp_path):
    run = device_view.Run.open("prod", _rid(), _claim())
    stage = tmp_path / "stage"
    stage.mkdir()
    assert run.pump(str(stage)) == 0                      # an older helper writes none at all
    live = stage / "live.jsonl"
    live.write_bytes(_line(_assistant({"type": "text", "text": "hi"})))
    live.chmod(0)                                         # root's, for the instant before it hands it over
    assert run.pump(str(stage)) == 0
    assert not (stage / "live.offset").exists()
    live.chmod(0o600)
    assert run.pump(str(stage)) == 1
    run.close("done", {})


def test_pump_skips_garbled_and_overlong_lines(tmp_path, monkeypatch):
    monkeypatch.setattr(device_view, "_LINE_MAX", 200_000)
    run = device_view.Run.open("prod", _rid(), _claim())
    long = _line(_assistant({"type": "text", "text": "x" * 300_000}))
    stage = _stage(tmp_path)
    live = stage / "live.jsonl"
    live.write_bytes(b"not json\n" + b"[" * 100_000 + b"\n" + b'"a string"\n' + b"\xff\xfe\n"
                     + _line({"type": "result", "result": "r", "total_cost_usd": float("nan"),
                              "duration_ms": float("inf"), "is_error": False})
                     + long[:250_000])                     # over the cap and not even finished yet
    assert run.pump(str(stage)) == 1
    with live.open("ab") as f:
        f.write(long[250_000:] + _line(_assistant({"type": "text", "text": "ok"})))
    assert run.pump(str(stage)) == 1
    evs = _events(run.sid)
    assert [(e["type"], e.get("text") or e.get("result")) for e in evs] == [("result", "r"), ("text", "ok")]
    assert (evs[0]["cost"], evs[0]["elapsed"]) == (None, 0)   # NaN would make the transcript unreadable
    run.close("done", {})


def test_close_marks_the_turn_and_outcome(tmp_path):
    run = device_view.Run.open("prod", _rid(), _claim())
    run.close("stopped", {"status": "FAILED", "error": "Stopped by this device's owner.", "screens": []})
    t = store.transcript(run.sid)
    assert [x["status"] for x in t["turns"]] == ["error"]
    assert store.parse_device(t["session"]["device"])["outcome"] == "stopped"
    assert [(e["type"], e.get("text")) for e in t["events"]] == [
        ("text", "Stopped by this device's owner."), ("stopped", None)]
    assert device_view.running_session() is None
    # A run that said something keeps its own words: the report isn't added again.
    talked = device_view.Run.open("prod", _rid(), _claim())
    talked.pump(str(_stage(tmp_path, _assistant({"type": "text", "text": "Built it."}))))
    talked.close("done", {"status": "COMPLETED", "result": "Built and ran.", "screens": []})
    t = store.transcript(talked.sid)
    assert [x["status"] for x in t["turns"]] == ["done"]
    assert [e.get("text") for e in t["events"]] == ["Built it."]
    assert store.parse_device(t["session"]["device"])["outcome"] == "done"


def test_a_close_that_fails_still_ends_the_run_going_now(monkeypatch):
    """STOP RUN and OPEN › follow running_session: a close the store fails
    mustn't leave them on a run that is over until the next restart."""
    run = device_view.Run.open("prod", _rid(), _claim())
    finish = store.finish_turn

    def boom(*a, **k):
        raise RuntimeError("database is locked")
    monkeypatch.setattr(store, "finish_turn", boom)
    with pytest.raises(RuntimeError):
        run.close("done", {})
    assert device_view.running_session() is None
    monkeypatch.setattr(store, "finish_turn", finish)
    run.close("done", {})                                 # no running turn left in the suite's store


def test_screens_and_divider_land_in_the_steps():
    run = device_view.Run.open("prod", _rid(), _claim())
    run.divider("Mystical restarted 17:31 · this run kept going")
    run.screens([("1.png", PNG), ("notes.txt", b"not a picture"), ("2.png", PNG)])
    divider, tool, done = _events(run.sid)
    assert (divider["type"], divider["text"]) == ("divider", "Mystical restarted 17:31 · this run kept going")
    assert (tool["type"], done["type"], done["id"]) == ("tool", "tool_done", tool["id"])
    assert tool["summary"] == "1.png, 2.png"
    up = os.path.join(config.UPLOAD_DIR, run.tid)
    assert done["images"] == [os.path.join(up, "dr-1.png"), os.path.join(up, "dr-2.png")]
    run.close("done", {})


def test_prune_deletes_finished_runs_older_than_7_days():
    week = time.time() + 8 * 86400
    device_view.prune(now=week)                           # whatever earlier tests left finished
    done, failed, going = (device_view.Run.open("prod", _rid(), _claim()) for _ in range(3))
    done.screens([("1.png", PNG)])
    done.close("done", {})
    failed.close("failed", {})
    assert device_view.prune() == 0                       # newer ones stay
    assert device_view.prune(now=week) == 2
    assert store.get_session(done.sid) is None and store.get_session(failed.sid) is None
    assert store.transcript(done.sid)["turns"] == [] and _events(done.sid) == []
    assert not os.path.exists(os.path.join(config.UPLOAD_DIR, done.tid))   # its pictures went too
    assert store.get_session(going.sid)                   # a run still going stays, however old
    going.close("done", {})


def test_orphans_closes_running_turns_not_kept():
    device_view.orphans(set())                            # whatever earlier tests left going
    kept, lost = (device_view.Run.open("prod", _rid(), _claim()) for _ in range(2))
    assert device_view.orphans({kept.request}) == 1
    status = lambda r: store.transcript(r.sid)["turns"][0]["status"]   # noqa: E731
    assert (status(kept), status(lost)) == ("running", "error")
    assert store.parse_device(store.get_session(lost.sid)["device"])["outcome"] == "failed"
    kept.close("done", {})


def test_orphans_ends_only_a_run_whose_own_turn_still_runs():
    """A finished run whose session holds some other running turn (an owner's
    refused one a restart cut short) is no orphan: every boot would otherwise
    turn its done into failed."""
    device_view.orphans(set())                            # whatever earlier tests left going
    done = device_view.Run.open("prod", _rid(), _claim())
    done.close("done", {})
    store.start_turn(done.sid, "stray-" + done.sid, "keep going", None)
    try:
        assert device_view.orphans(set()) == 0
        assert store.transcript(done.sid)["turns"][0]["status"] == "done"
        assert store.parse_device(store.get_session(done.sid)["device"])["outcome"] == "done"
    finally:
        store.finish_turn("stray-" + done.sid, "error", None, 0)


def test_open_survives_a_prune_that_fails(monkeypatch):
    """Last week's views can go at the next run; this run's view can't wait."""
    def boom(*a, **k):
        raise RuntimeError("database is locked")
    monkeypatch.setattr(device_view, "prune", boom)
    run = device_view.Run.open("prod", _rid(), _claim())
    assert device_view.running_session() == run.sid
    run.close("done", {})


def test_a_device_run_is_never_a_projects_latest_session():
    chat = 777_001
    mine = store.create_session(chat, "/")
    store.create_session(chat, "/", origin="device-run:prod")      # newer
    assert store.latest_session(chat, "/")["id"] == mine["id"]
    assert store.ensure_session(chat, "/")["id"] == mine["id"]


def test_runs_are_refused_on_device_run_sessions(monkeypatch):
    from bridge import learn, tailstate, titler
    for mod in (titler, learn, tailstate):                            # no model calls
        monkeypatch.setattr(mod, "kick", lambda *a, **k: None)
    monkeypatch.setattr(runner, "_jobs", {})
    monkeypatch.setattr(runner, "_notify", lambda *a, **k: None)
    monkeypatch.setattr(runner, "_ensure_journal_thread", lambda: None)

    def no_claude(*a, **k):
        raise AssertionError("built a claude argv for a teammate's device run")
    monkeypatch.setattr(runner, "_base_cmd", no_claude)
    spawned, real = [], subprocess.Popen
    monkeypatch.setattr(subprocess, "Popen", lambda argv, *a, **k: spawned.append(argv) or real(argv, *a, **k))
    sid = store.create_session(CHAT, "/", origin="device-run:prod", cwd=config.BASE_PATH)["id"]
    job = runner.start_streaming_job(CHAT, "keep going", [], project=config.BASE_PATH, session_id=sid,
                                     account_slot=2)
    assert job.exited.wait(10)
    end = time.time() + 10
    while time.time() < end and any("_run_streaming" in t.name for t in threading.enumerate()):
        time.sleep(0.02)
    runner._drain_journal()
    assert job.refusal == "This is a teammate's device run on this device. It's read only."
    assert (job.status, job.resume_id, job.account_slot) == ("error", None, None)
    assert not any("claude" in " ".join(map(str, a if isinstance(a, list) else [a])) for a in spawned)
    row = store.get_session(sid)
    assert row["claude_session_id"] is None and row["profile_id"] is None   # nor moved to account 2's profile
    t = store.transcript(sid)
    assert [x["status"] for x in t["turns"]] == ["error"]
    assert {"type": "error", "message": job.refusal} in [{"type": e["type"], "message": e.get("message")}
                                                         for e in t["events"]]
