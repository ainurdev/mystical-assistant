import gzip
import json
import threading
import urllib.request

import pytest

from bridge import inspector


@pytest.fixture(autouse=True)
def _clean():
    inspector.clear()
    yield
    inspector.stop()
    inspector.clear()


def test_off_by_default_and_hands_out_no_base_url():
    assert not inspector.running()
    assert inspector.base_url() is None


def test_request_summary_counts_without_storing_the_conversation():
    body = json.dumps({
        "model": "claude-opus-5", "max_tokens": 32000, "stream": True,
        "thinking": {"type": "enabled"},
        "system": [{"type": "text", "text": "x" * 100}],
        "messages": [{"role": "user", "content": "secret plan"}],
        "tools": [{"name": "Bash"}, {"name": "Read"}],
    }).encode()
    got = inspector._summarize_request(body)
    assert got == {"model": "claude-opus-5", "max_tokens": 32000, "stream": True,
                   "messages": 1, "tools": 2, "system_chars": 100, "thinking": True}
    assert "secret plan" not in json.dumps(got)


def test_sse_summary_reads_events_usage_and_stop_reason():
    stream = (
        b"event: message_start\n"
        b'data: {"message":{"usage":{"input_tokens":10,"cache_read_input_tokens":900}}}\n\n'
        b"event: content_block_delta\n"
        b'data: {"delta":{"text":"hi"}}\n\n'
        b"event: content_block_delta\n"
        b'data: {"delta":{"text":"!"}}\n\n'
        b"event: message_delta\n"
        b'data: {"delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":42}}\n\n'
    )
    got = inspector._summarize_sse([stream])
    assert got["events"] == {"message_start": 1, "content_block_delta": 2, "message_delta": 1}
    assert got["usage"]["input_tokens"] == 10
    assert got["usage"]["cache_read_input_tokens"] == 900
    assert got["usage"]["output_tokens"] == 42          # merged across frames
    assert got["stop_reason"] == "end_turn"


def test_gzipped_bodies_are_inflated_for_the_summary_only():
    # The API gzips its SSE stream; without this the whole log reads as empty.
    raw = b"event: ping\ndata: {}\n\n"
    assert inspector._decode(gzip.compress(raw), "gzip") == raw
    assert inspector._decode(raw, "") == raw
    assert inspector._decode(b"not actually gzip", "gzip") == b""   # never raises


def test_credentials_are_dropped_before_anything_is_stored():
    kept = inspector._safe_headers([
        ("Authorization", "Bearer sk-ant-oat-secret"),
        ("x-api-key", "sk-ant-secret"),
        ("Cookie", "session=secret"),
        ("anthropic-version", "2023-06-01"),
    ])
    assert kept == {"anthropic-version": "2023-06-01"}
    assert "secret" not in json.dumps(kept)


def test_proxy_forwards_verbatim_and_records_the_exchange():
    """A real round trip against a stand-in upstream: the caller must get the
    upstream's exact bytes back, and the call must land in the log."""
    import http.server

    seen = {}

    class Upstream(http.server.BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, *_a):
            pass

        def do_POST(self):
            n = int(self.headers.get("Content-Length") or 0)
            seen["body"] = self.rfile.read(n)
            seen["auth"] = self.headers.get("Authorization")
            payload = gzip.compress(b'event: ping\ndata: {"usage":{"output_tokens":7}}\n\n')
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Content-Encoding", "gzip")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

    up = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
    threading.Thread(target=up.serve_forever, daemon=True).start()
    inspector.UPSTREAM, original = f"http://127.0.0.1:{up.server_address[1]}", inspector.UPSTREAM
    try:
        base = inspector.start()
        sent = json.dumps({"model": "claude-opus-5", "messages": [{"role": "user"}]}).encode()
        req = urllib.request.Request(f"{base}/v1/messages", data=sent, method="POST",
                                     headers={"Authorization": "Bearer sk-ant-secret",
                                              "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=10) as r:
            body = r.read()
            assert r.status == 200
        # Verbatim both ways: upstream saw our body and our credential, and we
        # got its still-gzipped bytes back untouched.
        assert seen["body"] == sent
        assert seen["auth"] == "Bearer sk-ant-secret"
        assert gzip.decompress(body).startswith(b"event: ping")
    finally:
        inspector.UPSTREAM = original
        up.shutdown()
        up.server_close()

    (entry,) = inspector.entries()
    assert entry["status"] == 200 and entry["path"] == "/v1/messages"
    assert entry["request"]["model"] == "claude-opus-5"
    assert entry["sse"]["events"] == {"ping": 1}
    assert entry["sse"]["usage"]["output_tokens"] == 7
    assert "Authorization" not in entry["request_headers"]
    assert "secret" not in json.dumps(entry)
