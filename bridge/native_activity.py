"""Live-activity watcher for native (VS Code / terminal) Claude sessions.

`machine.list_running()` tells us which external sessions are *alive*; this module
tells us which are *working right now* by tailing each one's transcript JSONL:
we track a byte offset and mark a session 'working' when fresh assistant/user
content is appended, then 'idle' once it goes quiet for WORKING_WINDOW seconds.

The bridge's own `claude -p` runs are NOT tracked here (they live in the store /
runner). A background thread polls at _TICK; the derived state is read with a
cheap snapshot() for the running endpoint. Stdlib + machine/transcript_jsonl only
(no bridge.config), so the core stays unit-testable.
"""

import json
import os
import threading
import time

from bridge import machine, transcript_jsonl

WORKING_WINDOW = 3.0   # seconds of quiet after which a session is considered idle
_TICK = 1.0


def _label_for(rec) -> str | None:
    """A short 'what is it doing' label for a freshly-appended record, or None if
    the record is housekeeping (snapshot/queue/mode/...) and shouldn't count as
    live work. Mirrors the slice of the transcript vocabulary the renderers use."""
    if not isinstance(rec, dict) or rec.get("isSidechain"):
        return None
    t = rec.get("type")
    msg = rec.get("message") if isinstance(rec.get("message"), dict) else {}
    content = msg.get("content")
    if t == "assistant":
        for b in (content or []):
            if isinstance(b, dict) and b.get("type") == "tool_use":
                name = b.get("name", "tool")
                return "awaiting your answer" if name == "AskUserQuestion" else name
        return "thinking…"
    if t == "user":
        return "working…"
    return None


class _Tracker:
    """Tails one session's transcript JSONL and derives working/idle."""

    def __init__(self, session_id: str, path: str):
        self.session_id = session_id
        self.path = path
        self.offset = 0
        self.last_write = 0.0
        self.label: str | None = None
        self.state = "idle"
        self._primed = False

    def poll(self, now: float) -> None:
        try:
            size = os.path.getsize(self.path)
        except OSError:
            self.state = "idle"
            return
        if not self._primed:
            # First sighting: skip history so we don't replay it as live, but seed
            # last_write from a recent mtime so a session caught mid-write shows
            # 'working' immediately instead of waiting for its next append.
            self.offset = size
            self._primed = True
            try:
                mtime = os.path.getmtime(self.path)
            except OSError:
                mtime = 0.0
            if 0 <= now - mtime < WORKING_WINDOW:
                self.last_write = mtime
        else:
            if size < self.offset:        # truncated / rotated
                self.offset = 0
            if size > self.offset:
                label, consumed = self._read_new(self.offset, size)
                self.offset += consumed
                if label is not None:
                    self.last_write = now
                    self.label = label
        self.state = "working" if (now - self.last_write) < WORKING_WINDOW else "idle"

    def _read_new(self, start: int, end: int) -> tuple[str | None, int]:
        """Read appended bytes, consuming only up to the last complete line (a
        line still being written is left for the next poll). Returns the label of
        the newest meaningful record, and how many bytes were consumed."""
        try:
            with open(self.path, "rb") as fh:
                fh.seek(start)
                blob = fh.read(end - start)
        except OSError:
            return None, 0
        nl = blob.rfind(b"\n")
        if nl == -1:
            return None, 0
        consumed = nl + 1
        label: str | None = None
        for raw in blob[:consumed].splitlines():
            raw = raw.strip()
            if not raw:
                continue
            try:
                rec = json.loads(raw)
            except (json.JSONDecodeError, ValueError):
                continue
            lab = _label_for(rec)
            if lab is not None:
                label = lab
        return label, consumed


_trackers: dict[str, _Tracker] = {}
_lock = threading.Lock()
_thread: threading.Thread | None = None
_stop = threading.Event()


def _tick(now: float | None = None) -> None:
    """One pass: add trackers for newly-alive sessions, poll them, drop dead ones."""
    now = time.time() if now is None else now
    alive = {r["session_id"] for r in machine.list_running() if r.get("session_id")}
    with _lock:
        for sid in list(_trackers):
            if sid not in alive:
                _trackers.pop(sid, None)
        for sid in alive:
            tr = _trackers.get(sid)
            if tr is None:
                path = transcript_jsonl.find_transcript(sid)
                if not path:
                    continue
                tr = _Tracker(sid, path)
                _trackers[sid] = tr
            tr.poll(now)


def snapshot() -> dict:
    """{session_id: {state, label, last_write}} for every tracked session."""
    with _lock:
        return {sid: {"state": tr.state, "label": tr.label, "last_write": tr.last_write}
                for sid, tr in _trackers.items()}


def working_ids() -> set:
    """Session ids whose native transcript is actively being written right now."""
    with _lock:
        return {sid for sid, tr in _trackers.items() if tr.state == "working"}


def _run() -> None:
    while not _stop.is_set():
        try:
            _tick()
        except Exception:  # noqa: BLE001 — watcher must never crash the bridge
            pass
        _stop.wait(_TICK)


def start() -> None:
    """Launch the background watcher (idempotent)."""
    global _thread
    if _thread is not None and _thread.is_alive():
        return
    _stop.clear()
    _thread = threading.Thread(target=_run, name="native-activity", daemon=True)
    _thread.start()


def stop() -> None:
    _stop.set()
