#!/usr/bin/env python3
"""Screenshot a page with headless Chrome, over CDP. Standard library only.

Chrome's own `--screenshot` flag waits for the network to go idle, and the
dashboard holds an SSE stream open forever, so that flag never returns on it.
This drives the DevTools protocol instead: connect, wait a fixed beat for the
fonts and the first paint, then ask for the pixels.

    python3 shot.py --url 'http://127.0.0.1:8790/?skipboot=1' --out shot.png

`--wait` is the beat in milliseconds; the dashboard needs ~4000 to fill its
panels from the bridge. `--full` captures past the fold.
"""

import argparse
import base64
import glob
import json
import os
import socket
import struct
import subprocess
import tempfile
import time
import urllib.request


def _find_chrome() -> str:
    """The newest cached Playwright headless shell, unless one is named."""
    if os.environ.get("CHROME_HEADLESS_SHELL"):
        return os.environ["CHROME_HEADLESS_SHELL"]
    found = sorted(glob.glob(os.path.expanduser(
        "~/.cache/ms-playwright/chromium_headless_shell-*/"
        "chrome-headless-shell-linux64/chrome-headless-shell"
    )))
    return found[-1] if found else "chrome-headless-shell"


CHROME = _find_chrome()
# Headless Chrome links ALSA it never uses; this env keeps the stub on the path.
CHROME_LD = os.environ.get("CHROME_LD_LIBRARY_PATH", os.path.expanduser("~/.cache/ms-playwright"))


# ---- the smallest websocket client that can carry CDP ------------------------
# Text frames in, text frames out, one message at a time. No continuation
# frames: CDP replies arrive whole, and captureScreenshot's base64 payload is
# just a very large single frame.

class WS:
    def __init__(self, url: str):
        host_port, _, path = url[len("ws://"):].partition("/")
        host, _, port = host_port.partition(":")
        self.sock = socket.create_connection((host, int(port)), timeout=60)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall(
            f"GET /{path} HTTP/1.1\r\nHost: {host_port}\r\nUpgrade: websocket\r\n"
            f"Connection: Upgrade\r\nSec-WebSocket-Key: {key}\r\n"
            f"Sec-WebSocket-Version: 13\r\n\r\n".encode()
        )
        buf = b""
        while b"\r\n\r\n" not in buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise RuntimeError("CDP closed during handshake")
            buf += chunk
        if b" 101 " not in buf.split(b"\r\n", 1)[0]:
            raise RuntimeError(f"CDP refused the upgrade: {buf.split(chr(13).encode())[0]!r}")
        self.rest = buf.split(b"\r\n\r\n", 1)[1]
        self.next_id = 0

    def _read(self, n: int) -> bytes:
        while len(self.rest) < n:
            chunk = self.sock.recv(max(65536, n - len(self.rest)))
            if not chunk:
                raise RuntimeError("CDP closed")
            self.rest += chunk
        out, self.rest = self.rest[:n], self.rest[n:]
        return out

    def send(self, method: str, **params) -> int:
        self.next_id += 1
        payload = json.dumps({"id": self.next_id, "method": method, "params": params}).encode()
        header = bytearray([0x81])
        mask = os.urandom(4)
        n = len(payload)
        if n < 126:
            header.append(0x80 | n)
        elif n < 1 << 16:
            header.append(0x80 | 126)
            header += struct.pack(">H", n)
        else:
            header.append(0x80 | 127)
            header += struct.pack(">Q", n)
        header += mask
        self.sock.sendall(bytes(header) + bytes(b ^ mask[i % 4] for i, b in enumerate(payload)))
        return self.next_id

    def wait(self, msg_id: int) -> dict:
        """Drain events until the reply to `msg_id` shows up."""
        while True:
            head = self._read(2)
            opcode, length = head[0] & 0x0F, head[1] & 0x7F
            if length == 126:
                length = struct.unpack(">H", self._read(2))[0]
            elif length == 127:
                length = struct.unpack(">Q", self._read(8))[0]
            body = self._read(length)
            if opcode == 8:
                raise RuntimeError("CDP closed mid-request")
            if opcode != 1:
                continue
            msg = json.loads(body)
            if msg.get("id") == msg_id:
                if "error" in msg:
                    raise RuntimeError(f"CDP error: {msg['error']}")
                return msg.get("result", {})


def page_target(port: int, timeout: float = 20.0) -> str:
    """Chrome's first page target, once the debugging port answers."""
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/json/list", timeout=2) as r:
                for t in json.load(r):
                    if t.get("type") == "page" and t.get("webSocketDebuggerUrl"):
                        return t["webSocketDebuggerUrl"]
        except Exception:
            pass
        time.sleep(0.2)
    raise RuntimeError(f"no page target on :{port} after {timeout:.0f}s")


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def capture(url: str, out: str, width: int, height: int, wait_ms: int, full: bool,
            js: str = "") -> None:
    port = free_port()
    env = dict(os.environ)
    if CHROME_LD:
        env["LD_LIBRARY_PATH"] = CHROME_LD + os.pathsep + env.get("LD_LIBRARY_PATH", "")
    with tempfile.TemporaryDirectory() as profile:
        proc = subprocess.Popen(
            [CHROME, "--headless", "--no-sandbox", "--disable-gpu", "--hide-scrollbars",
             "--force-device-scale-factor=1", f"--window-size={width},{height}",
             f"--remote-debugging-port={port}", f"--user-data-dir={profile}", url],
            env=env, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            ws = WS(page_target(port))
            time.sleep(wait_ms / 1000)
            if js:
                # After the settle, so it runs against the filled-in UI: this is
                # where a shot opens a modal or swaps real repo names for demo ones.
                ws.wait(ws.send("Runtime.evaluate", expression=js, awaitPromise=True))
                time.sleep(0.6)
            result = ws.wait(ws.send(
                "Page.captureScreenshot", format="png", captureBeyondViewport=full,
            ))
            with open(out, "wb") as f:
                f.write(base64.b64decode(result["data"]))
        finally:
            proc.terminate()
            try:
                proc.wait(timeout=10)
            except subprocess.TimeoutExpired:
                proc.kill()


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--url", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--width", type=int, default=1512)
    ap.add_argument("--height", type=int, default=950)
    ap.add_argument("--wait", type=int, default=4000, help="ms to settle before capturing")
    ap.add_argument("--full", action="store_true", help="capture the whole scroll height")
    ap.add_argument("--eval", default="", metavar="JS",
                    help="JavaScript to run once the page has settled, e.g. --eval \"$(cat demo.js)\"")
    args = ap.parse_args()
    if not os.path.exists(CHROME):
        raise SystemExit(f"no headless chrome at {CHROME} (set CHROME_HEADLESS_SHELL)")
    capture(args.url, args.out, args.width, args.height, args.wait, args.full, args.eval)
    print(f"{args.out} ({os.path.getsize(args.out) / 1024:.0f} KB)")


if __name__ == "__main__":
    main()
