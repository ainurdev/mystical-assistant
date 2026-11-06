"""The Mystical tools beyond the basics (bridge/gateway_tools.py)."""
import base64
import json
import os
import subprocess
import sys
import threading
import time

import pytest

from bridge import (chat_search, config, experimental, gateway, gateway_tools as gt, profiles, project_config, runner,
                    store, timed_waits)

store.init()
CHAT = config.DASH_CHAT_ID
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")


class FakeJob:
    def __init__(self, sid):
        self.id, self.store_session_id, self.chat_id = f"j{time.time_ns()}", sid, CHAT
        self.events, self.pending, self.tg_live = [], [], False
        self.status = "running"
        self.exited = threading.Event()

    def add(self, ev):
        self.events.append(ev)

    def add_pending(self, e):
        self.pending.append(e)


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(profiles, "PATH", str(tmp_path / "profiles.json"))
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "pc.json"))
    monkeypatch.setattr(experimental, "_path", lambda: str(tmp_path / "experimental.json"))
    monkeypatch.setattr(experimental, "_cache", None)
    monkeypatch.setattr(config, "BASE_PATH", str(tmp_path))
    monkeypatch.setattr(config, "UPLOAD_DIR", str(tmp_path / "up"))
    monkeypatch.setattr(timed_waits, "_path", lambda: str(tmp_path / "tw.json"))
    monkeypatch.setattr(timed_waits, "_waits", {})
    monkeypatch.setattr(timed_waits, "_loaded", False)
    monkeypatch.setattr(timed_waits, "_ensure_thread", lambda: None)
    monkeypatch.setattr(runner, "_notify", lambda *a, **k: None)
    experimental.set_enabled(True)


def _repo(path):
    path.mkdir(exist_ok=True)
    subprocess.run(["git", "init", "-q", str(path)], check=True)
    subprocess.run(["git", "-C", str(path), "config", "user.email", "t@t"], check=True)
    subprocess.run(["git", "-C", str(path), "config", "user.name", "t"], check=True)
    (path / ".gitignore").write_text(".env\n")
    subprocess.run(["git", "-C", str(path), "add", "."], check=True)
    subprocess.run(["git", "-C", str(path), "commit", "-qm", "x"], check=True)
    return path


def _session(tmp_path, agent="claude"):
    r = _repo(tmp_path / "proj")
    pid = profiles.create({"name": f"P{time.time_ns()}", "agent": agent})["id"] if agent != "claude" else None
    return store.create_session(CHAT, "/proj", cwd=str(r), profile_id=pid), r


def text(res):
    return res["content"][0]["text"]


# ---- what's listed ----------------------------------------------------------------

def test_rare_tools_stay_behind_find_tools_and_are_still_callable(tmp_path, monkeypatch):
    s, _ = _session(tmp_path)
    listed = gateway.tool_names(s)
    assert {"show_image", "run_checks", "drive_page", "find_tools"} <= listed
    assert not listed & {"search_chats", "request_secret", "wait_for"}
    tok = gateway.issue(s["id"])
    out, _ = gateway.handle(tok, "tools/call", {"name": "find_tools", "arguments": {"server": "mystical"}})
    assert "request_secret" in text(out) and "search_chats" in text(out)
    # Called directly or through call_tool, it runs.
    res, _ = gateway.handle(tok, "tools/call", {"name": "search_chats", "arguments": {"query": "zzzzz"}})
    assert text(res) == "Nothing matches."
    res, _ = gateway.handle(tok, "tools/call", {"name": "call_tool", "arguments": {"server": "mystical", "tool": "search_chats", "arguments": {"query": "zzzzz"}}})
    assert text(res) == "Nothing matches."
    # Claude has its own screenshot; an agent gets this one.
    res, _ = gateway.handle(tok, "tools/call", {"name": "screenshot", "arguments": {"url": "http://x"}})
    assert res.get("isError")


# ---- figures ----------------------------------------------------------------------

def test_show_image_requires_a_caption_and_copies_into_uploads(tmp_path):
    s, r = _session(tmp_path)
    job = FakeJob(s["id"])
    (r / "a.png").write_bytes(PNG)
    assert gt.call(s, job, "show_image", {"path": str(r / "a.png")}).get("isError")
    assert gt.call(s, job, "show_image", {"path": str(r / "nope.png"), "caption": "x"}).get("isError")
    (r / "x.svg").write_text("<svg/>")
    assert gt.call(s, job, "show_image", {"path": str(r / "x.svg"), "caption": "x"}).get("isError")
    assert not gt.call(s, job, "show_image", {"path": str(r / "a.png"), "caption": "The fix  works"}).get("isError")
    ev = job.events[-1]
    assert ev["type"] == "figure" and ev["kind"] == "shown" and ev["caption"] == "The fix works"
    assert ev["images"][0].startswith(str(tmp_path / "up")) and open(ev["images"][0], "rb").read() == PNG


def test_compare_keeps_both_in_order(tmp_path):
    s, r = _session(tmp_path)
    job = FakeJob(s["id"])
    (r / "b.png").write_bytes(PNG)
    (r / "c.png").write_bytes(PNG)
    gt.call(s, job, "compare_images", {"before": str(r / "b.png"), "after": str(r / "c.png"), "caption": "Now aligned"})
    assert job.events[-1]["kind"] == "compare" and len(job.events[-1]["images"]) == 2


def test_figures_reach_telegram_only_when_the_chat_started_there(tmp_path, monkeypatch):
    from bridge import telegram, tgtopics
    sent = []
    monkeypatch.setattr(telegram, "send_photo", lambda chat, p, caption="", thread=None: sent.append((p, caption)))
    monkeypatch.setattr(tgtopics, "thread_for", lambda c, s: None)
    s, r = _session(tmp_path)
    (r / "a.png").write_bytes(PNG)
    job = FakeJob(s["id"])
    gt.call(s, job, "show_image", {"path": str(r / "a.png"), "caption": "x"})
    assert not sent
    job.tg_live = True
    gt.call(s, job, "show_image", {"path": str(r / "a.png"), "caption": "y"})
    assert sent and sent[0][1] == "y"


# ---- checks -------------------------------------------------------------------------

PYTEST_OUT = """FAILED tests/a.py::one - boom
FAILED tests/b.py::two - boom
2 failed, 30 passed, 1 skipped in 1.2s
"""


def test_parse_pytest_and_others():
    got = gt.parse_output(PYTEST_OUT)
    assert (got["passed"], got["failed"], got["skipped"]) == (30, 2, 1)
    assert got["failures"] == ["tests/a.py::one", "tests/b.py::two"]
    assert gt.parse_output("Tests: 1 failed, 4 passed\n  FAIL src/x.test.ts\n")["failures"] == ["src/x.test.ts"]
    assert gt.parse_output("--- FAIL: TestX (0.1s)\n")["failures"] == ["TestX"]
    assert gt.parse_output("all good")["passed"] is None


def _script(r, body):
    (r / "t.sh").write_text(body)
    return f"sh {r / 't.sh'}"


def test_checks_compare_with_the_known_failures(tmp_path, monkeypatch):
    s, r = _session(tmp_path)
    job = FakeJob(s["id"])
    monkeypatch.setattr(runner, "live_job", lambda sid: job)
    cmd = _script(r, f"cat <<'X'\n{PYTEST_OUT}X\nexit 1\n")
    out = text(gt.call(s, job, "run_checks", {"command": cmd}))
    assert "New failures" in out and "tests/a.py::one" in out
    assert job.events[-1]["type"] == "checks" and job.events[-1]["ok"] is False
    assert job.events[-1]["new"] == ["tests/a.py::one", "tests/b.py::two"]
    gt.call(s, job, "run_checks", {"command": cmd, "baseline": True})
    out = text(gt.call(s, job, "run_checks", {}))    # remembered
    assert "already known" in out and job.events[-1]["ok"] is True and job.events[-1]["new"] == []
    assert job.events[-1]["passed"] == 30
    # A new one on top of the known ones is what fails it.
    cmd2 = _script(r, f"cat <<'X'\nFAILED tests/c.py::three - x\n{PYTEST_OUT}X\nexit 1\n")
    gt.call(s, job, "run_checks", {"command": cmd2})
    assert job.events[-1]["new"] == ["tests/c.py::three"] and job.events[-1]["ok"] is False


def test_a_slow_check_reports_back_as_a_message(tmp_path, monkeypatch):
    from bridge import channel
    monkeypatch.setattr(gt, "_MCP_S", 0.1)
    s, r = _session(tmp_path, agent="claude")
    job = FakeJob(s["id"])
    monkeypatch.setattr(runner, "live_job", lambda sid: job)
    got = []
    monkeypatch.setattr(channel, "_reach", lambda c, t, text: got.append(text) or True)
    out = text(gt.call(s, job, "run_checks", {"command": "sleep 0.6; echo 3 passed"}))
    assert "still running" in out
    end = time.time() + 5
    while time.time() < end and not got:
        time.sleep(0.05)
    assert got and "3 passed" in got[0] and got[0].startswith("⧖")


def test_no_command_says_so(tmp_path):
    s, _ = _session(tmp_path)
    assert "can't tell" in text(gt.call(s, FakeJob(s["id"]), "run_checks", {}))


# ---- report, memory ---------------------------------------------------------------

def test_report_is_a_card_for_a_project_file_only(tmp_path):
    s, r = _session(tmp_path)
    job = FakeJob(s["id"])
    (r / ".mystical").mkdir()
    (r / ".mystical" / "r.md").write_text("# Hi")
    assert not gt.call(s, job, "show_report", {"path": ".mystical/r.md", "title": "Review"}).get("isError")
    assert job.events[-1]["type"] == "report" and job.events[-1]["path"] == ".mystical/r.md"
    assert gt.call(s, job, "show_report", {"path": "/etc/hostname", "title": "x"}).get("isError")


def test_search_and_read_chat(tmp_path):
    s, _ = _session(tmp_path)
    other = store.create_session(CHAT, "/proj", cwd=str(tmp_path))
    store.rename(other["id"], "Old work")
    store.start_turn(other["id"], f"t{time.time_ns()}", "why do we use postgres here", [])
    tid = store.latest_turn_id(other["id"])
    store.append_event(other["id"], tid, {"type": "result", "result": "Because of the JSONB columns."})
    found = chat_search.search(CHAT, "jsonb", exclude=s["id"])
    assert found and found[0]["session_id"] == other["id"] and "JSONB" in found[0]["snippet"]
    assert "Old work" in text(gt.call(s, None, "search_chats", {"query": "postgres"}))
    assert "JSONB" in text(gt.call(s, None, "read_chat", {"id": other["id"][:12]}))
    assert [h["turn"] for h in chat_search.in_chat(other["id"], "postgres")] == [tid]
    assert chat_search.in_chat(other["id"], "x") == []      # too short
    assert chat_search.search(CHAT, "100%_x") == []         # LIKE's wildcards are literal


# ---- waits -------------------------------------------------------------------------

def test_wait_for_time_wakes_and_a_prompt_cancels(tmp_path, monkeypatch):
    from bridge import queue_manager
    s, _ = _session(tmp_path)
    got = []
    monkeypatch.setattr(queue_manager, "enqueue", lambda sid, **k: got.append((sid, k["prompt"])))
    assert "Waiting for" in text(gt.call(s, None, "wait_for", {"kind": "time", "seconds": 1, "then": "check it"}))
    timed_waits._tick()
    assert not got
    timed_waits._waits[s["id"]]["at"] = time.time() - 1
    timed_waits._tick()
    assert got and got[0][0] == s["id"] and "check it" in got[0][1] and got[0][1].startswith("⧖")
    assert timed_waits.pending(s["id"]) is None
    gt.call(s, None, "wait_for", {"kind": "time", "seconds": 5, "then": "x"})
    timed_waits.drop(s["id"])
    assert timed_waits.pending(s["id"]) is None


@pytest.mark.parametrize("a", [{"kind": "pr", "pr": "; rm -rf /", "then": "x"}, {"kind": "port", "port": 99999, "then": "x"},
                               {"kind": "time", "seconds": 10**9, "then": "x"}, {"kind": "nope", "then": "x"},
                               {"kind": "time", "seconds": 5}])
def test_wait_for_refuses_bad_input(tmp_path, a):
    s, _ = _session(tmp_path)
    assert "Waiting for" not in text(gt.call(s, None, "wait_for", a))


def test_wait_for_port(tmp_path):
    import socket
    srv = socket.socket()
    srv.bind(("127.0.0.1", 0))
    srv.listen()
    port = srv.getsockname()[1]
    w = {"kind": "port", "port": port, "since": time.time()}
    assert "answering" in timed_waits._done(w)
    srv.close()
    assert timed_waits._done(w) is None


# ---- secrets -----------------------------------------------------------------------

def test_a_secret_goes_to_env_and_never_into_the_events(tmp_path, monkeypatch):
    s, r = _session(tmp_path, agent="claude")
    job = FakeJob(s["id"])
    done = {}

    def answer():
        while not job.pending:
            time.sleep(0.01)
        entry = job.pending[-1]
        gateway.answer_card(job, entry, [{"value": "sk-very-secret"}])
    threading.Thread(target=answer, daemon=True).start()
    res = gt.call(s, job, "request_secret", {"name": "MY_KEY", "why": "for the API"})
    done["text"] = text(res)
    assert "saved in .env" in done["text"] and "sk-very-secret" not in done["text"]
    assert 'MY_KEY="sk-very-secret"' in (r / ".env").read_text()
    assert oct((r / ".env").stat().st_mode)[-3:] == "600"
    assert "sk-very-secret" not in json.dumps(job.events) and "sk-very-secret" not in json.dumps(job.pending)
    assert {"secret_request", "secret_answered"} <= {e["type"] for e in job.events}
    assert next(e for e in job.events if e["type"] == "secret_answered")["given"] is True


def test_a_refused_secret_doesnt_read_as_saved(tmp_path):
    s, r = _session(tmp_path)
    (r / ".gitignore").write_text("")
    job = FakeJob(s["id"])

    def answer():
        while not job.pending:
            time.sleep(0.01)
        gateway.answer_card(job, job.pending[-1], [{"value": "x"}])
    threading.Thread(target=answer, daemon=True).start()
    res = gt.call(s, job, "request_secret", {"name": "MY_KEY", "why": "y"})
    assert "isn't ignored" in text(res) and not (r / ".env").exists()
    assert next(e for e in job.events if e["type"] == "secret_answered")["given"] is False


def test_secret_replaces_and_refuses(tmp_path):
    r = _repo(tmp_path / "p2")
    assert gt.write_secret(str(r), "A_KEY", "one") is None
    (r / ".env").write_text('A_KEY="old"\nB=2\nexport A_KEY=older\n')
    assert gt.write_secret(str(r), "A_KEY", 'ne"w') is None
    body = (r / ".env").read_text()
    assert body.count("A_KEY") == 1 and 'A_KEY="ne\\"w"' in body and "B=2" in body
    assert "one line" in gt.write_secret(str(r), "A_KEY", "a\nEVIL=1")
    assert "valid" in gt.write_secret(str(r), "lower; rm", "x")
    (r / ".gitignore").write_text("")
    assert "isn't ignored" in gt.write_secret(str(r), "A_KEY", "x")


# ---- drive_page --------------------------------------------------------------------

def test_drive_page_clicks_and_reports_errors(tmp_path):
    if not os.path.isdir(os.path.expanduser("~/.cache/ms-playwright")):
        pytest.skip("no headless chrome")
    import http.server
    page = (b"<!doctype html><title>t</title><button onclick=\"document.title='clicked';"
            b"console.error('boom');throw new Error('kaput')\">Press me</button><img src='/missing.png'>")

    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            code = 200 if self.path == "/" else 404
            self.send_response(code)
            self.end_headers()
            self.wfile.write(page if code == 200 else b"")

        def log_message(self, *a):
            pass
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    s, _ = _session(tmp_path)
    res = gt.call(s, None, "drive_page", {"url": f"http://127.0.0.1:{srv.server_port}/", "steps": [
        {"click": "Press me"}, {"eval": "document.title"}, {"click": "Not there"}, {"shot": "after"}]})
    srv.shutdown()
    t = text(res)
    assert "kaput" in t and "boom" in t and "404" in t and 'clicked "Press me"' in t and '"clicked"' in t
    assert "nothing on the page matches" in t
    assert any(b["type"] == "image" for b in res["content"])
    assert gt.call(s, None, "drive_page", {"url": "file:///etc/passwd"}).get("isError")
