"""A teammate's device run (bridge/device_side.py) as a read-only session the
device's owner can watch while it goes.

The root helper writes Claude's stream-json output, line by line, into the run's
stage as <stage>/live.jsonl (bridge/device_setup/mystical_run_helper.py). A Run
follows that file and stores each line as the events a session already shows
(text, thinking, tool, tool_done, result) on a session of origin
"device-run:<instance>" and ref "device-run:<request id>". The dashboard lists it
with the plugins' sessions and polls it like any other, live while its one turn
is running.

The stream is the teammate's: their prompt and their repository's code drive it,
and the file sits in the owner's folder. So its lines go through Feed, made for
this, and never through runner._handle_event, which trusts its stream:
- it stores any line's session_id as the session's claude_session_id, and boot
  recovery would then --resume the teammate's conversation on the owner's
  Claude account;
- it copies the image file a Read names (_save_result_images) and moves the
  file a *__Record result names (_save_result_file), with the owner's
  permissions;
- it needs a registered runner Job, which Rivendell's progress tick would report.
Feed keeps no session id and opens nothing the stream names. Pictures come only
from inline base64, under names it makes itself, an id that isn't plain gives
way to one of its own, a line over 4 MB is skipped, and token-shaped text is
redacted (device_side.redact) before anything is stored.

Read only on every path: runner.start_streaming_job refuses a run in such a
session (REFUSAL), store.claim_orphaned_turns leaves its turn alone, and
store.latest_session never picks it, so nothing resumes it or runs in it on this
device's account. A finished run's view goes after 7 days (prune), pictures
included: it can hold the asker's code and .env values.
"""

import base64
import json
import mimetypes
import os
import re
import shutil
import time
import uuid

from bridge import config, pubsub, store, transcript_jsonl

ORIGIN = "device-run"
REFUSAL = "This is a teammate's device run on this device. It's read only."
_ASK = "The request, verbatim:\n---\n"   # Rivendell's device-run prompt quotes the asker after this
_LINE_MAX = 4 * 1024 * 1024        # a longer stream line is skipped
_IMG_MAX = 8 * 1024 * 1024         # one picture, decoded
_IMGS = 4                          # pictures kept from one tool result
# Never SVG: it is a page that can run script.
_IMG_EXT = {"image/png": ".png", "image/jpeg": ".jpg", "image/gif": ".gif", "image/webp": ".webp"}
_SAFE_ID = re.compile(r"[A-Za-z0-9_-]{1,100}")
_REPORT_MAX = 20000                # Rivendell's result length (device_side._RESULT_MAX)
_JSON = json.JSONDecoder()
_running: "dict[str, str]" = {}    # request id -> session: the run going now (one at a time)


def is_device_run(origin) -> bool:
    """Is this the origin of a teammate's device run's session?"""
    return isinstance(origin, str) and origin.startswith(ORIGIN + ":")


def request_text(prompt: str) -> str:
    """The asker's own words: the block Rivendell's prompt quotes them in, else
    the whole prompt. The last "\\n---" ends the block, so a "---" line of the
    asker's stays theirs.
    shortcut: this reads the wording of Rivendell's device-run-prompt.template.ts;
    take the request from a claim field of its own once Rivendell sends one."""
    _, found, rest = prompt.partition(_ASK)
    end = rest.rfind("\n---")
    return rest[:end] if found and end != -1 else prompt


def display_text(text: str) -> str:
    """The run's words as the owner reads them: the report object the prompt asks
    Claude to end on ({"summary": …, "screens": […]}) reads as its summary. Only an
    object that ends the text counts, and only one within its last _REPORT_MAX
    characters, parsed there alone: each "{" tried is a JSON parse (and a failed
    one counts lines up to where it failed), so over a whole 4 MB line a hostile
    run could make this take hours."""
    if not text.rstrip().endswith("}"):
        return text
    start = max(0, len(text) - _REPORT_MAX)
    tail = text[start:]
    i = tail.find("{")
    while i != -1:
        try:
            obj, end = _JSON.raw_decode(tail, i)
        except (ValueError, RecursionError):
            i = tail.find("{", i + 1)
            continue
        if not tail[end:].strip():
            ok = isinstance(obj, dict) and isinstance(obj.get("summary"), str)
            return text[:start + i] + obj["summary"] if ok else text
        i = tail.find("{", end)
    return text


def _str(v) -> str:
    return v if isinstance(v, str) else ""


def _num(v):
    """A sane number from the stream, else None: a NaN or an Infinity in an event
    would make the transcript's JSON unreadable to the page."""
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) and abs(v) < 1e15 else None


def _dig(d, *keys):
    for k in keys:
        d = d.get(k) if isinstance(d, dict) else None
    return d


def _redact(v):
    """Token-shaped text out of a value, in its lists and objects too."""
    from bridge import device_side   # local: device_side drives the views and imports this module
    if isinstance(v, str):
        return device_side.redact(v)
    if isinstance(v, list):
        return [_redact(x) for x in v]
    if isinstance(v, dict):
        return {k: _redact(x) for k, x in v.items()}
    return v


class Feed:
    """A run's stream records -> the store's events, shaped as runner._handle_event
    shapes them, without the rest of what it does (the module docstring says why).
    shortcut: a step's time is when the bridge read its line, so timings are only
    as fine as the pump's beat; the stream has no clock of its own, so have the
    helper stamp each line if they ever need to be exact."""

    def __init__(self, upload_dir: str):
        self.upload_dir = upload_dir
        self.open: dict = {}     # the stream's tool id -> (the event's id, name, when it started)
        self.last = None         # when the last step landed, for a thinking pause
        self.pics = 0            # pictures named so far

    def events(self, rec: dict, now: float) -> list:
        try:
            out = self._events(rec, now)
        except Exception:  # noqa: BLE001 - a record the shared helpers can't read is dropped, like a garbled line
            return []
        if out:
            self.last = now
        return [_redact(ev) for ev in out]

    def _events(self, rec, now):
        if rec.get("type") == "result":
            ms = _num(rec.get("duration_ms"))
            return [{"type": "result",
                     "result": display_text(_str(rec.get("result")) or _str(rec.get("error"))),
                     "cost": _num(rec.get("total_cost_usd")), "elapsed": int(ms // 1000) if ms else 0,
                     "is_error": bool(rec.get("is_error"))}]
        blocks = _dig(rec, "message", "content")
        out = []
        for b in blocks if isinstance(blocks, list) else []:
            if not isinstance(b, dict):
                continue
            if rec.get("type") == "assistant":
                ev = self._step(b, now)
            elif rec.get("type") == "user" and b.get("type") == "tool_result":
                ev = self._done(b, rec.get("tool_use_result"), now)
            else:
                ev = None
            if ev:
                out.append(ev)
        return out

    def _step(self, b, now):
        kind = b.get("type")
        if kind == "text":
            text = display_text(_str(b.get("text"))).strip()
            return {"type": "text", "text": text} if text else None
        if kind == "thinking":
            ms = int((now - self.last) * 1000) if self.last is not None else 0
            text = _str(b.get("thinking")).strip()
            if not text and ms < transcript_jsonl.THINK_MIN_MS:
                return None
            return {"type": "thinking", "ms": ms, **({"text": text} if text else {})}
        if kind == "tool_use":
            name, inp, raw = _str(b.get("name")) or "tool", b.get("input"), b.get("id")
            ev = {"type": "tool", "name": name, "id": self._id(raw),
                  "summary": transcript_jsonl._summarize_tool(name, inp)}
            if isinstance(raw, str):
                self.open[raw] = (ev["id"], name, now)
            if (meta := transcript_jsonl.agent_meta(name, inp)):
                ev["agent"] = meta
            return ev
        return None

    def _done(self, b, result, now):
        raw = b.get("tool_use_id")
        rid, name, t0 = self.open.pop(raw, (None, None, None)) if isinstance(raw, str) else (None, None, None)
        ev = transcript_jsonl.tool_done(rid or self._id(raw), name,
                                        int((now - t0) * 1000) if t0 is not None else 0, b, result)
        if (pics := self._pictures(b.get("content"))):
            ev["images"] = pics
        return ev

    @staticmethod
    def _id(raw) -> str:
        """The stream's tool id where it is plain, else one of ours: the page keys
        on it, and the runner names files after one, where ../../x would climb out."""
        return raw if isinstance(raw, str) and _SAFE_ID.fullmatch(raw) else uuid.uuid4().hex

    def _pictures(self, content) -> list:
        """A tool result's inline pictures (a screenshot tool's), at most _IMGS."""
        out = []
        for b in content if isinstance(content, list) else []:
            src = b.get("source") if isinstance(b, dict) and b.get("type") == "image" else None
            ext = _IMG_EXT.get(str(_dig(src, "media_type"))) if _dig(src, "type") == "base64" else None
            if ext and len(out) < _IMGS:
                try:
                    data = base64.b64decode(src.get("data"), validate=True)
                except (TypeError, ValueError):
                    continue
                if (path := self.picture(data, ext)):
                    out.append(path)
        return out

    def picture(self, data: bytes, ext: str) -> "str | None":
        """Write one picture into the upload dir as dr-<n><ext>; its path, or None
        when it is empty, over _IMG_MAX or can't be written. A name already there
        (a run taken back after a restart starts counting again) is never
        written over."""
        if not data or len(data) > _IMG_MAX:
            return None
        try:
            os.makedirs(self.upload_dir, exist_ok=True)
            while True:
                self.pics += 1
                path = os.path.join(self.upload_dir, f"dr-{self.pics}{ext}")
                try:
                    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                except FileExistsError:
                    continue
                with os.fdopen(fd, "wb") as f:
                    f.write(data)
                return path
        except OSError:
            return None


class Run:
    """One device run's read-only session and its one turn, which takes the
    session's own id, so the session row alone finds the turn and its pictures
    (UPLOAD_DIR/<turn id>), after a restart too. Made, it is the run going now
    (running_session) until close."""

    def __init__(self, sid: str, request_id: str):
        self.sid = self.tid = sid
        self.request = request_id
        self.feed = Feed(os.path.join(config.UPLOAD_DIR, sid))
        self.offset = None       # how far live.jsonl has been read; live.offset's, at the first pump
        self._skip = False       # inside a line over _LINE_MAX: dropped through its newline
        _running[request_id] = sid

    @classmethod
    def open(cls, instance: str, request_id: str, claim: dict) -> "Run":
        """The session for a run starting now. Only what the view shows is kept
        of the claim, never its claudeToken."""
        ask = _redact(request_text(_str(claim.get("prompt"))))
        sid = store.create_session(config.DASH_CHAT_ID, "/", origin=f"{ORIGIN}:{instance}",
                                   cwd=config.BASE_PATH)["id"]
        store.rename(sid, next((ln.strip() for ln in ask.splitlines() if ln.strip()), "Device run")[:60])
        store.set_ref(sid, f"{ORIGIN}:{request_id}")
        pr, task = _dig(claim, "pullRequest", "number"), claim.get("task")
        store.set_device(sid, {
            "request": request_id, "instance": instance, "by": _str(_dig(claim, "requester", "name")),
            "repo": _str(claim.get("repository")), "sha": _str(claim.get("commitSha")),
            "pr": pr if isinstance(pr, int) and not isinstance(pr, bool) else None,
            "task": {"key": _str(task.get("key")), "title": _str(task.get("title"))}
            if isinstance(task, dict) else None,
            "outcome": None})
        store.start_turn(sid, sid, ask, None)
        prune()
        return cls(sid, request_id)

    @classmethod
    def reopen(cls, request_id: str) -> "Run | None":
        """The session of a run taken back after a restart, or None if it has none."""
        ref = f"{ORIGIN}:{request_id}"
        sid = store.sessions_for_refs([ref]).get(ref)
        return cls(sid, request_id) if sid else None

    def pump(self, stage: str) -> int:
        """Store and publish the whole lines live.jsonl gained since the last pump,
        then note how far it got in <stage>/live.offset, where a run taken back
        after a restart carries on from. No file is nothing yet: root holds it for
        an instant before handing it over, and an older helper writes none.
        -> how many events.
        shortcut: a crash between the store and the offset write repeats at most
        one batch; write the offset with each line if repeats ever show."""
        mark = os.path.join(stage, "live.offset")
        if self.offset is None:
            try:
                with open(mark) as f:
                    self.offset = int(f.read())
            except (OSError, ValueError):
                self.offset = 0
        try:
            f = os.fdopen(os.open(os.path.join(stage, "live.jsonl"), os.O_RDONLY | os.O_NOFOLLOW), "rb")
        except OSError:
            return 0
        n, start = 0, self.offset
        with f:
            f.seek(self.offset)
            while True:
                line = f.readline(_LINE_MAX + 1)
                whole = line.endswith(b"\n")
                if not line or (not whole and len(line) <= _LINE_MAX and not self._skip):
                    break                       # the rest isn't written yet
                self.offset += len(line)
                if self._skip or not whole:
                    self._skip = not whole      # a line over _LINE_MAX goes, through its newline
                    continue
                n += self._take(line)
        if self.offset != start:
            try:
                with open(mark + ".tmp", "w") as f:
                    f.write(str(self.offset))
                os.replace(mark + ".tmp", mark)
            except OSError:
                pass                            # the stage went: the run is over
        return n

    def _take(self, line: bytes) -> int:
        try:
            rec = json.loads(line)
        except (ValueError, RecursionError):
            return 0
        evs = self.feed.events(rec, time.time()) if isinstance(rec, dict) else []
        for ev in evs:
            self._add(ev)
        return len(evs)

    def _add(self, ev: dict) -> None:
        ev = _redact(ev)
        seq = store.append_event(self.sid, self.tid, ev)
        pubsub.publish(f"session:{self.sid}", {**ev, "seq": seq})

    def divider(self, text: str) -> None:
        """One line across the run's steps: a Mystical restart it went on through."""
        self._add({"type": "divider", "text": text})

    def screens(self, files: list) -> None:
        """The screenshots the run handed back, [(name, bytes)], as one step with
        pictures. Only picture types, under names made here."""
        kept = {}
        for name, data in files:
            ext = _IMG_EXT.get(mimetypes.guess_type(name)[0] or "")
            if ext and (path := self.feed.picture(data, ext)):
                kept[name] = path
        if kept:
            rid = uuid.uuid4().hex
            self._add({"type": "tool", "name": "Screenshots", "id": rid, "summary": ", ".join(kept)})
            self._add({"type": "tool_done", "id": rid, "images": list(kept.values())})

    def close(self, outcome: str, body: dict) -> None:
        """End the run: `outcome` is done, failed or stopped, its turn done or
        error. A run whose stream said nothing (an older helper writes none) gets
        the result's summary, or why it failed, as its one text."""
        said = (_str(body.get("result")) or _str(body.get("error"))).strip()
        if said and not any(e.get("type") == "text" and e.get("turn_id") == self.tid
                            for e in store.transcript(self.sid)["events"]):
            self._add({"type": "text", "text": said})
        if outcome == "stopped":
            self._add({"type": "stopped"})
        s = store.get_session(self.sid) or {}
        store.finish_turn(self.tid, "done" if outcome == "done" else "error", None,
                          int(time.time() - s.get("created", time.time())))
        store.set_device(self.sid, {**(store.parse_device(s.get("device")) or {}), "outcome": outcome})
        _running.pop(self.request, None)


reopen = Run.reopen


def running_session() -> "str | None":
    """The session of the device run going now, or None."""
    sids = list(_running.values())
    return sids[-1] if sids else None


def prune(days: int = 7, now: "float | None" = None) -> int:
    """Delete the finished device runs older than `days`, their pictures with
    them: a run's view can hold the asker's code and .env values, so it is kept
    a week, not the month a session list shows. A run still going stays,
    however old. -> how many went."""
    cutoff = (time.time() if now is None else now) - days * 86400
    going = set(store.running_session_ids(config.DASH_CHAT_ID))
    gone = 0
    for s in store.list_sessions_all(config.DASH_CHAT_ID, include_archived=True, max_age_secs=None):
        if is_device_run(s["origin"]) and s["updated"] < cutoff and s["id"] not in going:
            store.delete_session(s["id"])
            shutil.rmtree(os.path.join(config.UPLOAD_DIR, s["id"]), ignore_errors=True)
            gone += 1
    return gone


def orphans(keep: set) -> int:
    """At bridge start: end, failed, every device run still running but the ones
    in `keep` (the request ids whose helper is still going and is taken back),
    so no view says RUNNING forever. -> how many."""
    n = 0
    for sid in store.running_session_ids(config.DASH_CHAT_ID):
        s = store.get_session(sid)
        rid = (s.get("ref") or "").removeprefix(ORIGIN + ":") if s else ""
        if s and is_device_run(s["origin"]) and rid not in keep:
            Run(sid, rid).close("failed", {})
            n += 1
    return n
