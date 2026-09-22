"""Unit tests for the rivendell PR-review plugin (bridge/rivendell.py).

Covers the pure/mechanical parts: client-frame masking round-trips through the
server-side decoder (the same code rivendell-api's `ws` library implements),
the RFC 6455 client handshake against a socketpair-backed fake server, event
filtering/dedup, job waiting, and the WS-URL derivation. No network, no Claude.
"""

import base64
import io
import json
import os
import socket
import sys
import tempfile
import threading

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ["BASE_PATH"] = tempfile.mkdtemp()
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ["ALLOWED_CHAT_IDS"] = "555"
os.environ["BRIDGE_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")
os.environ["RIVENDELL_API_URL"] = "http://api.example:3001"
os.environ["RIVENDELL_TOKEN"] = "rvd_testtoken"

from bridge import rivendell, wsutil  # noqa: E402


# --- framing -----------------------------------------------------------------

def test_masked_frame_roundtrips_through_decoder():
    """A client (masked) frame must unmask to the original payload server-side."""
    payload = json.dumps({"type": "pr-review-request", "requestId": "r1"}).encode()
    frame = wsutil.encode_frame(payload, wsutil.OP_TEXT, masked=True)
    assert frame[1] & 0x80, "mask bit must be set on client frames"
    opcode, decoded = wsutil.decode_frame(io.BytesIO(frame))
    assert opcode == wsutil.OP_TEXT
    assert decoded == payload


def test_masked_frame_sizes():
    """Length encodings (7-bit / 16-bit / 64-bit) all survive masking."""
    for size in (5, 200, 70_000):
        payload = os.urandom(size)
        frame = wsutil.encode_frame(payload, wsutil.OP_BINARY, masked=True)
        _, decoded = wsutil.decode_frame(io.BytesIO(frame))
        assert decoded == payload


def test_unmasked_default_unchanged():
    """Default (server) framing stays unmasked — the dashboard terminal path."""
    frame = wsutil.encode_frame(b"hi", wsutil.OP_TEXT)
    assert not frame[1] & 0x80


# --- handshake ---------------------------------------------------------------

def test_client_handshake(monkeypatch):
    """_connect sends a well-formed upgrade (with the bearer header) and
    verifies the Sec-WebSocket-Accept echo."""
    server, client = socket.socketpair()
    monkeypatch.setattr(
        "socket.create_connection", lambda *a, **k: client)
    monkeypatch.setattr(rivendell.config, "RIVENDELL_WS_URL",
                        "ws://api.example:3001/agent")
    # Pinned here, not via os.environ at module import: another test file may
    # have imported bridge.config first, freezing the env before ours applied.
    monkeypatch.setattr(rivendell.config, "RIVENDELL_TOKEN", "rvd_testtoken")

    captured = {}

    def fake_server():
        request = b""
        while b"\r\n\r\n" not in request:
            request += server.recv(4096)
        captured["request"] = request.decode()
        key = [line.split(": ", 1)[1] for line in captured["request"].split("\r\n")
               if line.lower().startswith("sec-websocket-key")][0]
        server.sendall((
            "HTTP/1.1 101 Switching Protocols\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Accept: {wsutil.accept_key(key)}\r\n"
            "\r\n").encode())

    t = threading.Thread(target=fake_server, daemon=True)
    t.start()
    sock, rfile = rivendell._connect()
    t.join(timeout=5)

    assert "GET /agent HTTP/1.1" in captured["request"]
    assert "Authorization: Bearer rvd_testtoken" in captured["request"]
    assert "Upgrade: websocket" in captured["request"]
    key_line = [l for l in captured["request"].split("\r\n")
                if l.startswith("Sec-WebSocket-Key: ")][0]
    assert base64.b64decode(key_line.split(": ", 1)[1])  # valid base64 nonce
    sock.close()
    server.close()


def test_client_handshake_rejects_bad_accept(monkeypatch):
    server, client = socket.socketpair()
    monkeypatch.setattr("socket.create_connection", lambda *a, **k: client)
    monkeypatch.setattr(rivendell.config, "RIVENDELL_WS_URL",
                        "ws://api.example:3001/agent")

    def fake_server():
        request = b""
        while b"\r\n\r\n" not in request:
            request += server.recv(4096)
        server.sendall(b"HTTP/1.1 101 Switching Protocols\r\n"
                       b"Sec-WebSocket-Accept: bogus\r\n\r\n")

    threading.Thread(target=fake_server, daemon=True).start()
    try:
        rivendell._connect()
        raised = False
    except ConnectionError:
        raised = True
    assert raised, "a wrong Sec-WebSocket-Accept must fail the handshake"
    server.close()


# --- event handling ----------------------------------------------------------

def _drain_queue():
    drained = []
    while not rivendell._queue.empty():
        drained.append(rivendell._queue.get_nowait())
    return drained


def test_handle_message_filters_and_dedups():
    rivendell._seen.clear()
    _drain_queue()
    event = json.dumps({"type": "pr-review-request", "requestId": "abc",
                        "pullRequest": {"number": 7}}).encode()
    rivendell._handle_message(event)
    rivendell._handle_message(event)                       # duplicate: dropped
    rivendell._handle_message(b"not json at all")          # noise: ignored
    rivendell._handle_message(json.dumps({"type": "other"}).encode())
    assert _drain_queue() == ["abc"]


# --- job waiting -------------------------------------------------------------

class _StubJob:
    def __init__(self, status, result=None, error_msg=None, texts=()):
        self.status, self.result = status, result
        self.error_msg, self.texts = error_msg, list(texts)
        self.interrupted = False

    def interrupt(self):
        self.interrupted = True
        self.status = "error"


def test_wait_job_done_returns_result():
    ok, text = rivendell._wait_job(_StubJob("done", result="LGTM"))
    assert ok and text == "LGTM"


def test_wait_job_done_falls_back_to_texts():
    ok, text = rivendell._wait_job(_StubJob("done", texts=["a", "b"]))
    assert ok and text == "ab"


def test_wait_job_error_returns_message():
    ok, text = rivendell._wait_job(_StubJob("error", error_msg="boom"))
    assert not ok and text == "boom"


def test_wait_job_timeout_interrupts(monkeypatch):
    monkeypatch.setattr(rivendell.config, "RIVENDELL_REVIEW_TIMEOUT", 0)
    job = _StubJob("running")
    ok, text = rivendell._wait_job(job)
    assert not ok and job.interrupted and "timed out" in text


# --- config ------------------------------------------------------------------

def test_ws_url_derived_from_api_url(monkeypatch):
    """http -> ws with /agent appended, read live from config per attempt."""
    monkeypatch.setattr(rivendell.config, "RIVENDELL_WS_URL", "")
    monkeypatch.setattr(rivendell.config, "RIVENDELL_API_URL",
                        "http://api.example:3001")
    assert rivendell._ws_url() == "ws://api.example:3001/agent"
    monkeypatch.setattr(rivendell.config, "RIVENDELL_API_URL",
                        "https://api.example")
    assert rivendell._ws_url() == "wss://api.example/agent"


def test_ws_url_override_wins(monkeypatch):
    monkeypatch.setattr(rivendell.config, "RIVENDELL_WS_URL", "ws://elsewhere/sock")
    assert rivendell._ws_url() == "ws://elsewhere/sock"


# --- live reconfiguration (dashboard PLUGINS settings) ------------------------

def test_reconfigure_stops_when_disabled(monkeypatch):
    started = []
    monkeypatch.setattr(rivendell.config, "RIVENDELL_ENABLE", False)
    monkeypatch.setattr(rivendell, "start", lambda: started.append(True))
    rivendell._stop.clear()
    rivendell.reconfigure()
    assert rivendell._stop.is_set() and not started
    rivendell._stop.clear()


def test_reconfigure_starts_and_kicks_when_enabled(monkeypatch):
    calls = []
    monkeypatch.setattr(rivendell.config, "RIVENDELL_ENABLE", True)
    monkeypatch.setattr(rivendell, "start", lambda: calls.append("start"))
    monkeypatch.setattr(rivendell, "_drop_connection", lambda: calls.append("drop"))
    rivendell.reconfigure()
    assert calls == ["start", "drop"], "must (re)start then force a reconnect"


if __name__ == "__main__":
    import subprocess
    raise SystemExit(subprocess.call(["pytest", "-q", os.path.abspath(__file__)]))
