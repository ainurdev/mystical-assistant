"""The dashboard's MOVE jobs: an export, a read or an import of a move file
(bridge/move.py), run on a thread inside the bridge so a reload or a closed tab
loses nothing. The dock polls GET /local/move/jobs and draws what is here.

- One job at a time. Export and import both drive git and the claude CLI over
  the same repos and ~/.claude.json; two at once would race for nothing.
- READ unpacks a file once into <state>/move-read/ (0700) and dry-runs it there;
  IMPORT replays that folder, so a 1 GB file is decompressed once, not per click.
  The folder holds the file's secrets, so it goes when an import succeeds, when
  another file is read, or on FORGET. A failed or cancelled import keeps it for
  IMPORT AGAIN.
- Finished jobs are kept in <state>/move_jobs.json until dismissed, so an
  import's "what's left" survives the restart it asks for. A job that was still
  running when the bridge stopped comes back failed: it died with the process.
- Not a subprocess: progress is a Python object here, and a child process would
  need a channel back for every tick. Not the CLI either: `mystical export` and
  `mystical import` stay as they were and know nothing of this.

ponytail: the overall % weighs each step by a fixed share, not by measured work,
and time left is elapsed over that %, so the dock says "about". Measure per-step
durations on real moves if the estimate proves misleading.
"""

import glob
import os
import re
import shutil
import threading
import time
import uuid
from collections import deque

from bridge import config, move

# Steps per kind, in the order they run, with the share of the bar each fills.
STEPS = {
    "export": (("repos", .55), ("mcp", .01), ("plugins", .02), ("claude", .04),
               ("history", .30), ("bridge", .08)),
    "read": (("unpack", .85), ("check", .15)),
    "import": (("repos", .70), ("plugins", .08), ("claude", .03), ("mcp", .06),
               ("history", .10), ("bridge", .03)),
}
KEEP = 8                         # finished cards remembered
BUSY = "a move is already running"
BOOT = time.time()               # an import that ended before this has had its restart
_NAME = re.compile(r"^mystical-move-.+\.tar\.gz$")

_lock = threading.Lock()
_jobs: list = []                 # a Job while it runs, its final snapshot after
_loaded = False


def _state() -> str:
    return os.path.dirname(config.BRIDGE_DB)


def read_dir() -> str:
    return os.path.join(_state(), "move-read")


def _tilde(path: str) -> str:
    home = os.path.expanduser("~")
    return "~" + path[len(home):] if path == home or path.startswith(home + os.sep) else path


class Job(move.Progress):
    def __init__(self, kind, title, skip=(), **extra):
        self.id = uuid.uuid4().hex[:12]
        # out/file/skip ride along so a card's RETRY can ask for the same job again.
        self.kind, self.title, self.extra = kind, title, {**extra, "skip": list(skip)}
        self.status, self.error, self.result = "running", None, None
        self.started, self.ended = time.time(), None
        skip = set(skip)
        self.steps = {k: {"key": k, "done": 0, "total": 0,
                          "state": "skipped" if k in skip else "queued"} for k, _ in STEPS[kind]}
        self.cur, self.now, self.read = None, [], (0, 0)
        self.log = deque(maxlen=60)
        self.stop = threading.Event()
        self._mu = threading.Lock()

    # -- move.Progress ------------------------------------------------------
    def step(self, key, total=0):
        with self._mu:
            if self.cur and self.steps[self.cur]["state"] == "running":
                self.steps[self.cur]["state"] = "done"
            s = self.steps.get(key)
            self.cur = key if s and s["state"] != "skipped" else None
            self.now = []
            if self.cur:
                s.update(state="running", total=total, done=0)

    def item(self, label):
        with self._mu:
            if label not in self.now:
                self.now.append(label)

    def tick(self, label=None, n=1):
        with self._mu:
            if self.cur:
                self.steps[self.cur]["done"] += n
            if label in self.now:
                self.now.remove(label)

    def line(self, text):
        with self._mu:
            self.log.extend(t.strip() for t in str(text).splitlines() if t.strip())

    def bytes(self, done, total):
        self.read = (done, total)

    def check(self):
        if self.stop.is_set():
            raise move.Cancelled()

    # -- what the dock reads --------------------------------------------------
    def finish(self, status, error=None):
        if status in ("done", "failed"):     # a cancel is yours: nothing to tell you
            from bridge import notices
            notices.emit("move_done" if status == "done" else "move_failed", f"move:{self.id}",
                         title=self.title, body=str(error or ""), meta={"move": self.kind})
        with self._mu:
            self.status, self.error, self.ended = status, error, time.time()
            for s in self.steps.values():
                if status == "done" and s["state"] != "skipped":
                    s["state"] = "done"
                elif s["state"] == "running":
                    s["state"] = status

    def snapshot(self) -> dict:
        with self._mu:
            share = dict(STEPS[self.kind])
            live = [k for k, _ in STEPS[self.kind] if self.steps[k]["state"] != "skipped"]

            def frac(k):
                s = self.steps[k]
                if s["state"] == "done":
                    return 1.0
                if s["state"] == "queued":
                    return 0.0
                if k == "unpack" and self.read[1]:
                    return self.read[0] / self.read[1]
                return min(s["done"] / s["total"], 1.0) if s["total"] else 0.0

            f = 1.0 if self.status == "done" else \
                sum(share[k] * frac(k) for k in live) / (sum(share[k] for k in live) or 1)
            elapsed = (self.ended or time.time()) - self.started
            if self.kind == "read":
                done = self.read[0]
            else:
                try:
                    done = os.path.getsize(self.extra["out"]) if "out" in self.extra else None
                except OSError:
                    done = None
            return {"id": self.id, "kind": self.kind, "title": self.title, "status": self.status,
                    "pct": round(f * 100, 1), "elapsed": round(elapsed, 1),
                    "eta": round(elapsed / f - elapsed) if self.status == "running" and f >= .03
                    else None,
                    "bytes": done, "total": self.read[1] or None,
                    "rate": round(done / elapsed) if done and elapsed > .5 else None,
                    "steps": [dict(self.steps[k]) for k, _ in STEPS[self.kind]],
                    "now": list(self.now), "log": list(self.log)[-8:], "error": self.error,
                    "result": self.result, "started": self.started, "ended": self.ended,
                    **self.extra}


class _Within(move.Progress):
    """A job's log and cancel, handed to an inner run whose steps aren't the job's
    (READ's dry run reports repos, mcp… but READ's bar has one CHECK step)."""

    def __init__(self, job):
        self.job = job

    def line(self, text):
        self.job.line(text)

    def check(self):
        self.job.check()


# -- the list ------------------------------------------------------------------

def _file() -> str:
    return os.path.join(_state(), "move_jobs.json")


def _load_locked():
    global _loaded
    if _loaded:
        return
    _loaded = True
    for j in move._read_json(_file()) or []:
        if isinstance(j, dict) and j.get("id"):
            if j.get("status") == "running":
                j.update(status="failed", error="the bridge stopped while this ran")
            _jobs.append(j)


def _save_locked():
    snaps = [j.snapshot() if isinstance(j, Job) else j for j in _jobs]
    try:
        move._write_json(_file(), snaps)
    except OSError:
        pass                     # the list is a convenience; the move itself is on disk


def _busy_locked() -> bool:
    return any(isinstance(j, Job) for j in _jobs)


def _start(job, fn) -> dict:
    with _lock:
        _load_locked()
        if _busy_locked():
            return {"error": BUSY}
        _jobs.append(job)
        _save_locked()
    threading.Thread(target=_run, args=(job, fn), daemon=True, name=f"move-{job.kind}").start()
    return job.snapshot()


def _run(job, fn):
    try:
        job.result = fn(job)
        job.finish("done")
    except move.Cancelled:
        job.finish("cancelled")
    except (Exception, SystemExit) as e:      # SystemExit: "not a mystical export"
        job.finish("failed", (str(e) or type(e).__name__)[:400])
    snap = job.snapshot()
    with _lock:
        _jobs[_jobs.index(job)] = snap
        done = [j for j in _jobs if not isinstance(j, Job)]
        for old in done[:-KEEP]:
            _jobs.remove(old)
        _save_locked()


def _left(j) -> list:
    """An import's WHAT'S LEFT, re-read each time: the restart is done once the
    bridge has booted since, the file once it's gone."""
    out = [n for n in (j.get("result") or {}).get("next") or []
           if not (n.get("key") == "restart" and (j.get("ended") or 0) < BOOT)]
    f = j.get("file")
    if f and os.path.isfile(f):
        out.append({"key": "delete", "path": f, "bytes": os.path.getsize(f),
                    "text": "Delete the move file: it holds your .env files and tokens."})
    return out


def jobs() -> list:
    with _lock:
        _load_locked()
        out = [j.snapshot() if isinstance(j, Job) else dict(j) for j in _jobs]
    for j in out:
        if j["kind"] == "import" and j["status"] == "done":
            j["next"] = _left(j)
    return out


# -- starting things -----------------------------------------------------------

def export(out, skip) -> dict:
    out = os.path.abspath(os.path.expanduser(out or "")) if out else \
        move.default_out(move.Machine())
    if not out.endswith(".tar.gz"):
        return {"error": "the file name has to end in .tar.gz"}
    if not os.path.isdir(os.path.dirname(out)):
        return {"error": f"no folder at {_tilde(os.path.dirname(out))}"}
    if os.path.exists(out):
        return {"error": "a file is already there; pick another name"}

    def fn(job):
        path = move.export(out, skip=skip, progress=job, log=job.line)
        return {"path": path, "bytes": os.path.getsize(path)}

    return _start(Job("export", f"→ {_tilde(out)}", skip, out=out), fn)


def read(path) -> dict:
    path = os.path.abspath(os.path.expanduser(path or ""))
    if not os.path.isfile(path):
        return {"error": f"no file at {_tilde(path)}"}

    def fn(job):
        root = read_dir()
        shutil.rmtree(root, ignore_errors=True)
        os.makedirs(root, mode=0o700)
        try:
            job.step("unpack")
            move.unpack(path, os.path.join(root, "x"), progress=job)
            job.step("check")
            got = move.inspect(os.path.join(root, "x"), progress=_Within(job))
        except BaseException:
            shutil.rmtree(root, ignore_errors=True)
            raise
        got.update(file=path, bytes=os.path.getsize(path), at=time.time())
        move._write_json(os.path.join(root, "read.json"), got)
        return {"from": got["from"]}

    return _start(Job("read", os.path.basename(path), file=path), fn)


def read_state():
    """The file READ last unpacked, and what each item in it would do here."""
    got = move._read_json(os.path.join(read_dir(), "read.json"))
    return got if isinstance(got, dict) and os.path.isdir(os.path.join(read_dir(), "x")) else None


def import_(skip) -> dict:
    st = read_state()
    if not st:
        return {"error": "read a move file first"}

    def fn(job):
        got = move.apply(os.path.join(read_dir(), "x"), skip=skip, progress=job, log=job.line)
        shutil.rmtree(read_dir(), ignore_errors=True)      # its secrets are in place now
        return got

    return _start(Job("import", (st.get("from") or {}).get("host") or "move file", skip,
                      file=st.get("file")), fn)


def cancel() -> bool:
    with _lock:
        for j in _jobs:
            if isinstance(j, Job):
                j.stop.set()
                return True
    return False


def dismiss(job_id) -> None:
    with _lock:
        _load_locked()
        _jobs[:] = [j for j in _jobs if isinstance(j, Job) or j.get("id") != job_id]
        _save_locked()


def forget() -> dict:
    with _lock:
        if _busy_locked():
            return {"error": BUSY}
    shutil.rmtree(read_dir(), ignore_errors=True)
    return {"ok": True}


def delete_file(path) -> dict:
    """Only a move file, by name: this is not a general delete."""
    path = os.path.abspath(os.path.expanduser(path or ""))
    if not _NAME.match(os.path.basename(path)) or not os.path.isfile(path):
        return {"error": "only a mystical-move-*.tar.gz file can be deleted here"}
    with _lock:
        if any(isinstance(j, Job) and j.extra.get("file") == path for j in _jobs):
            return {"error": BUSY}
    os.remove(path)
    return {"ok": True}


def files() -> list:
    """Move files where they usually land: home, Downloads, Desktop and the
    bridge's incoming-* folders (where the last move parked its file)."""
    home = os.path.expanduser("~")
    dirs = [home, os.path.join(home, "Downloads"), os.path.join(home, "Desktop"),
            *sorted(glob.glob(os.path.join(_state(), "incoming-*")))]
    out = []
    for d in dirs:
        try:
            names = os.listdir(d)
        except OSError:
            continue
        for n in names:
            full = os.path.join(d, n)
            if _NAME.match(n) and os.path.isfile(full):
                st = os.stat(full)
                out.append({"path": full, "name": n, "dir": _tilde(d), "bytes": st.st_size,
                            "mtime": st.st_mtime})
    return sorted(out, key=lambda f: -f["mtime"])


def plan() -> dict:
    return move.plan()


def post(what, body) -> dict:
    """The dashboard's POST /local/move/<what>."""
    skip = [s for s in body.get("skip") or [] if isinstance(s, str)]
    if what == "export":
        return export(body.get("out"), skip)
    if what == "read":
        return read(body.get("path"))
    if what == "import":
        return import_(skip)
    if what == "cancel":
        return {"ok": cancel()}
    if what == "dismiss":
        dismiss(str(body.get("id") or ""))
        return {"ok": True}
    if what == "forget":
        return forget()
    if what == "delete":
        return delete_file(body.get("path"))
    return {"error": "not found"}
