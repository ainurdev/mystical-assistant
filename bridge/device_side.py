"""The device side of device runs: a teammate's run on this shared device.

Rivendell announces a run (`device-run-request`) to the shared devices that are
on; bridge/rivendell.py queues it as kind "device-run", one at a time, and hands
it to run() here:
  1. Claim it (GET .../prompt, with X-Mystical-Device-Id). A 409 is another
     device's claim: dropped quietly, nothing posted.
  2. Check that /Users/Shared/Mystical Runs is the owner's own folder (anyone
     can plant that name in /Users/Shared), then tell the owner who is testing
     what on this device: a row in the bell, and Telegram only where Settings ▸
     NOTIFY routes "Started elsewhere" (bridge/notices.py), like every ping.
     The run gets its view: a read-only session the owner can watch
     (bridge/device_view.py).
  3. Stage it in /Users/Shared/Mystical Runs/<id>/, the owner's own 0700 folder:
     job.json, the code snapshot, and the asker's Claude token (0600) last.
  4. Start the root helper (bridge/device_setup/mystical_run_helper.py) with
     sudo -n, in a session of its own, so a bridge restart doesn't kill it
     before its clean-up. It takes the token off the disk as soon as it has read
     it, runs Claude as the hidden user mysticalruns, writes Claude's steps into
     the stage's live.jsonl as they happen, and hands back out/ (exit.json,
     claude.json, screens/). Each beat the view takes what live.jsonl gained (a
     helper from before the live view writes none: the view then shows the
     summary once the run ends).
  5. Upload the screenshots the report lists, then any other PNGs, at most 20
     of at most 5 MB each (the view shows them too), and post the result,
     token-shaped text redacted.
  6. Remove the stage, token first, on every path. The view ends done, failed,
     stopped (by the owner) or cancelled (by Rivendell, so no report went
     back), and the bell gets the run's second row (rv_ended).
A cancel (`device-run-cancel`) calls stop(): the helper's stop now, and again on
each beat for as long as that run's start goes on, since a cancel that lands
while the code is unpacking finds no run to stop yet. A cancelled run posts
nothing; Rivendell has closed it. The owner's STOP RUN (stop_by_owner) is the
same stop, sent the same way; that run is posted FAILED "Stopped by this
device's owner." once, unless it finished first: then its report goes as it is.
It has a mark of its own, as the helper would report the killed Claude's exit
code.

The view is only there for the owner to watch, and the run never depends on it:
every call into it goes through _view(), so an error there is logged and never
fails or holds up the run, its result or its clean-up.

A Mystical restart (an update, `mystical restart`) re-execs the bridge in place,
and the helper, in its own session, runs on. At the next start (rivendell.start)
sweep() takes back each stage whose helper ps still lists (helper_alive), or
whose results the helper already handed back (out/exit.json: the restart came
while they were uploaded or posted): the stage is kept and filed under its
job.json's instance. That instance's worker takes it at its first READY
connect, before any new run (take_adopted), and resume() watches it to its end
as run() would: the view reopened past a "Mystical restarted HH:MM · this run
kept going" line, the same beats, stops and timeout, and the run's own result
posted once (Rivendell answers a second post, should the bridge before have
made it, with 409, which _post takes as final). A stage whose helper is gone
(a reboot, a crash) is told to stop, which does nothing unless that run holds
the helper's lock, and goes; report_interrupted() posts each such run FAILED
once its instance's device is connected again (Rivendell takes a device's
result only then). Every other view still RUNNING ends failed
(device_view.orphans).
"""

import json
import os
import re
import shutil
import stat
import subprocess
import threading
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from bridge import device_share, device_view, notices

STAGE_ROOT = "/Users/Shared/Mystical Runs"    # test seam: tests point it at a temp dir
_RUN_ID = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}")
_SNAPSHOT_MAX = 9 * 1024 * 1024     # a run's code, gzipped
_SCREEN_MAX = 5 * 1024 * 1024       # one screen; Rivendell takes no more
_SCREENS_MAX = 20
_READ_MAX = 16 * 1024 * 1024        # what is read of the run's claude.json
_RESULT_MAX, _ERROR_MAX, _CAPTION_MAX = 20000, 5000, 200   # Rivendell's lengths: longer is a 400
_BEAT = 2.0          # seconds between looks at a cancel while the helper runs
_SLACK = 120         # seconds the helper gets past the run's own timeout before it is stopped
_GIVE_UP = 60        # seconds of stops after that before the bridge stops waiting for it
_RETRIES = (2, 10, 30)   # the result POST, as rivendell._RESULT_RETRIES: a finished run is expensive

_cancelled: set = set()   # run ids a cancel came in for (set operations are atomic under the GIL)
_owner_stopped: set = set()   # run ids the device's owner stopped (stop_by_owner)
_interrupted: dict = {}   # instance id -> run ids a restart cut short, still to report (sweep, report_interrupted)
_adopted: dict = {}       # instance id -> run ids a restart didn't end, to watch (sweep, take_adopted)
# Held while Set up or Remove runs (the dashboard's setup route), one at a time: the
# device takes no run meanwhile (headers).
setup_lock = threading.Lock()
_RESTARTED = "The device restarted during the run."
_OWNER_STOPPED = "Stopped by this device's owner."
_UNREPORTED = "The run ended before it handed back its results."
_SECRET = re.compile(r"sk-ant-[A-Za-z0-9_.-]+|CLAUDE_CODE_OAUTH_TOKEN=\S+")


def redact(text: str) -> str:
    """Token-shaped text out. A prompt-injected run can write the Claude token it
    runs under into its report; this keeps it out of the result posted here, and
    out of the asking side's chat turn and PR section (bridge/device_ask.py)."""
    return _SECRET.sub("[redacted]", text)


def stage_dir(request_id: str) -> str:
    """Where a run is staged for the helper."""
    return os.path.join(STAGE_ROOT, request_id)


def staged_job(request_id: str) -> dict:
    """What a staged run's job.json says, {} when there is none to read: after a
    restart, what is known of a run taken back (its repository, for one)."""
    return _read_json(os.path.join(stage_dir(request_id), "job.json"))


def _root_is_ours() -> bool:
    """Whether STAGE_ROOT is what Set up made: a real folder of this account's
    that group and others can't write. It sits in world-writable /Users/Shared,
    where anyone could plant that name first, as a link into this account's home
    or a folder of their own; once it is ours, the sticky bit there keeps anyone
    else from swapping it."""
    try:
        st = os.lstat(STAGE_ROOT)
    except OSError:
        return False
    return stat.S_ISDIR(st.st_mode) and st.st_uid == os.getuid() and not st.st_mode & 0o022


def headers(inst: dict) -> "dict | None":
    """What this device's calls carry, X-Mystical-Device-Id, when it is READY for
    teammates' runs; None when it isn't, and then it takes none. Nor while Set up
    or Remove runs (setup_lock), though the device stays READY: Set up may take
    the run user's wall down for a moment and Remove deletes that user, so no
    run is claimed, acked or taken back then."""
    if setup_lock.locked():
        return None
    s = device_share.share_state(inst)
    device = s["facts"]["id"] if s["state"] == "READY" else None
    return {"X-Mystical-Device-Id": device} if device else None


def _helper(action: str, request_id: str) -> list:
    return ["/usr/bin/sudo", "-n", device_share.HELPER, action, request_id]


def stop(request_id: str, run=subprocess.run) -> None:
    """A cancel: the helper's stop, now. run() stops it again on each beat while
    that run's start goes on."""
    if not _RUN_ID.fullmatch(request_id or ""):
        return
    _cancelled.add(request_id)
    _stop(request_id, run)


def stop_by_owner(request_id: str, run=subprocess.run) -> None:
    """STOP RUN, from the device's owner: the helper's stop now, and again on
    each beat while the run goes on, as for a cancel. Unlike a cancel's, the run
    is then posted FAILED, saying its owner stopped it, once."""
    if not _RUN_ID.fullmatch(request_id or ""):
        return
    _owner_stopped.add(request_id)
    _stop(request_id, run)


def _stop(request_id, run):
    try:
        r = run(_helper("stop", request_id), stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError) as e:
        print(f"device run {request_id}: the stop failed: {e}")
        return
    if r.returncode:
        print(f"device run {request_id}: the stop failed: {(r.stderr or '').strip()}")


def helper_alive(request_id: str, run=subprocess.run) -> "bool | None":
    """Whether this run's helper still goes: ps lists it (or the sudo that
    started it) as `… mystical-run-helper start <id>`. None when ps can't tell
    (it failed, timed out or exited non-zero): sweep() then counts the run as
    gone, as a restart ended every run before, and resume() keeps watching, as
    ending the watch would drop a stage its helper still runs from."""
    try:
        r = run(["/bin/ps", "-axo", "command="], stdin=subprocess.DEVNULL, capture_output=True, text=True,
                errors="replace", timeout=30)
    except (OSError, subprocess.SubprocessError) as e:
        print(f"device run {request_id}: ps couldn't be read: {e}")
        return None
    if r.returncode:
        print(f"device run {request_id}: ps couldn't be read: it exited {r.returncode}")
        return None
    return any(line.rstrip().endswith(f"mystical-run-helper start {request_id}")
               for line in (r.stdout or "").splitlines())


def take_adopted(instance: str) -> list:
    """The runs of this instance that sweep() took back, each handed out once,
    for the instance's worker to watch to their end (resume)."""
    return _adopted.pop(instance, [])


def _view(obj, call: str, *args):
    """obj.call(*args) on a run's view (bridge/device_view.py), or None. The
    view is the owner's to watch: an error there is logged, and never fails or
    holds up the teammate's run, its result or its clean-up. No view, no call."""
    if obj is None:
        return None
    try:
        return getattr(obj, call)(*args)
    except Exception as e:  # noqa: BLE001 — the run goes on without its view
        print(f"device runs: the view's {call} failed: {e}")
        return None


def parse_report(claude_json: str) -> "tuple[str, list]":
    """The run's report, out of Claude's JSON output: the last JSON object in its
    result text that has a "summary" (the prompt asks Claude to end on one), as
    (summary, [{file, caption}]). With none, the whole result text and []. Only
    the text's last _RESULT_MAX characters are looked in, parsed there alone:
    each "{" tried is a JSON parse, and a failed one counts the lines up to where
    it failed, so over all 16 MB a run can hand back that could take a day."""
    try:
        text = json.loads(claude_json).get("result")
    except (ValueError, AttributeError, RecursionError):
        text = None
    if not isinstance(text, str):
        return "", []
    tail = text[-_RESULT_MAX:]
    found, decoder, i = None, json.JSONDecoder(), tail.find("{")
    while i != -1:
        try:
            obj, end = decoder.raw_decode(tail, i)
        except (ValueError, RecursionError):
            i = tail.find("{", i + 1)
            continue
        if isinstance(obj, dict) and isinstance(obj.get("summary"), str):
            found = obj
        i = tail.find("{", end)
    if found is None:
        return text, []
    screens = [{"file": s["file"], "caption": s.get("caption") if isinstance(s.get("caption"), str) else ""}
               for s in found.get("screens") or [] if isinstance(s, dict) and isinstance(s.get("file"), str)]
    return found["summary"], screens


def run(worker, request_id: str, popen=subprocess.Popen, call=subprocess.run) -> None:
    """One teammate's device run, start to finish (the module docstring has the
    steps). `popen` starts the helper, `call` stops it: the tests' seams. A
    cancel or an owner's stop noted for it is forgotten however it ends."""
    try:
        _run(worker, request_id, popen, call)
    finally:
        _cancelled.discard(request_id)
        _owner_stopped.discard(request_id)


def _dig(d, *keys):
    """d[k1][k2]…, or None where a level isn't an object: a claim needn't be the
    shape the Contract says."""
    for k in keys:
        d = d.get(k) if isinstance(d, dict) else None
    return d


def _run(worker, request_id, popen, call):
    if not _RUN_ID.fullmatch(request_id or ""):
        print(f"rivendell[{worker.name}]: device run {request_id!r} has no run id; not taking it")
        return     # it names the stage this removes
    if request_id in _cancelled:
        print(f"rivendell[{worker.name}]: device run {request_id} was cancelled while it waited")
        return     # never claimed, never staged
    head = headers(worker.inst)
    if head is None:
        return     # not READY any more: another device can take it
    base = f"/plugin/device-run-requests/{request_id}"
    try:
        claim = worker._api(base + "/prompt", headers=head)
    except Exception as e:  # noqa: BLE001 — every claim failure ends here
        if isinstance(e, urllib.error.HTTPError) and e.code == 409:
            print(f"rivendell[{worker.name}]: device run {request_id} is another device's")
            return
        print(f"rivendell[{worker.name}]: device run {request_id}: the claim failed: {e}")
        _post(worker, base, head, {"status": "FAILED", "error": f"The claim failed: {e}"[:_ERROR_MAX], "screens": []})
        return
    stage = stage_dir(request_id)
    timeout = int(worker.inst.get("impl_timeout", 10800))
    view = began = body = None
    try:
        try:
            if not _root_is_ours():
                raise ValueError("this device's runs folder isn't its owner's own, so nothing was staged")
            said = f"{claim['requester']['name']} is testing {claim['repository']} on this device."
            worker._note("rv_started", request_id, claim["repository"], said, job_kind="device-run")
            if notices.telegram_ok("rv_started"):
                worker._deliver_telegram(said, None)
            began = time.time()
            view = _view(device_view.Run, "open", worker.inst["id"], request_id, claim)
            _write_stage(stage, claim, timeout, worker.inst["id"])
            if request_id in _cancelled:
                return
            rc, err, late = _start(request_id, timeout, popen, call, view)
            body = _result(worker, base, head, stage, rc, err, late, max(1, timeout // 60), view)
        except Exception as e:  # noqa: BLE001 — still this run's failure, and it is posted
            print(f"rivendell[{worker.name}]: device run {request_id} crashed: {e}")
            body = {"status": "FAILED", "error": f"bridge error: {e}"[:_ERROR_MAX], "screens": []}
        body = _report(worker, base, head, request_id, body)
        device_share.record_last_run(_dig(claim, "requester", "name") or "", _dig(claim, "task", "key"))
    finally:
        if _root_is_ours():    # never remove anything through a root someone else planted
            _drop(stage)
        if began is not None:
            _ended(worker, request_id, _dig(claim, "requester", "name"), began, view, body)


def _report(worker, base, head, request_id, body):
    """The result, posted: FAILED saying so for a run its owner stopped, unless
    it finished first (STOP RUN stays on offer until the view closes, after the
    post), and nothing for one Rivendell cancelled, as Rivendell has closed it.
    -> the body."""
    if request_id in _owner_stopped and body.get("status") != "COMPLETED":
        body = {"status": "FAILED", "error": _OWNER_STOPPED, "screens": []}
    if request_id not in _cancelled:
        _post(worker, base, head, body)
    return body


def _ended(worker, request_id, name, began, view, body):
    """A run's view closed, as what went back to the asker says: cancelled (by
    Rivendell: nothing was posted, whatever the run made), done, stopped by its
    owner, or failed. Then the bell's second row for it, after rv_started:
    Telegram only where NOTIFY routes "Started elsewhere"."""
    outcome = ("cancelled" if request_id in _cancelled
               else "done" if (body or {}).get("status") == "COMPLETED"
               else "stopped" if request_id in _owner_stopped else "failed")
    _view(view, "close", outcome, body or {})
    title = f"{name or 'A teammate'}'s run on this device ended"
    said = f"{outcome.capitalize()} after {max(1, round((time.time() - began) / 60))} min."
    worker._note("rv_ended", request_id, title, said, job_kind="device-run")
    if notices.telegram_ok("rv_ended"):
        worker._deliver_telegram(f"{title}. {said}", None)


def _write_stage(stage, claim, timeout, instance):
    """The stage the helper checks: the owner's 0700 folder with job.json, the
    code and, last, the token. The code comes from the web only: a file:// URL
    would hand the run one of the owner's own files as its code. job.json also
    names the Rivendell instance, the asker, the task and the repository (none a
    secret), for sweep(), resume() and the worker's RUNNING row after a restart
    (staged_job). The claim lets go of the token here:
    from now on only the stage holds it, until the helper reads it and takes it
    off the disk."""
    token = claim.pop("claudeToken")
    os.mkdir(stage, 0o700)
    os.chmod(stage, 0o700)    # exactly, whatever the umask
    _write(os.path.join(stage, "job.json"), json.dumps({
        "prompt": claim["prompt"], "gitAuthorName": claim.get("gitAuthorName"),
        "gitAuthorEmail": claim.get("gitAuthorEmail"), "developerDir": device_share.developer_dir(),
        "timeoutSeconds": timeout, "instance": instance, "requester": _dig(claim, "requester", "name"),
        "task": _dig(claim, "task", "key"), "repository": claim["repository"]}).encode())
    url = claim["snapshotUrl"]
    if urlsplit(url).scheme not in ("http", "https"):
        raise ValueError("the code's address isn't a web address")
    with urllib.request.urlopen(url, timeout=60) as r:
        code = r.read(_SNAPSHOT_MAX + 1)
    if len(code) > _SNAPSHOT_MAX:
        raise ValueError("the code is over 9 MB")
    _write(os.path.join(stage, "code.tar.gz"), code)
    _write(os.path.join(stage, "token"), token.encode())


def _write(path, data):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), "wb") as f:
        f.write(data)


def _start(request_id, timeout, popen, call, view):
    """The helper's start, in a session of its own, waited on a beat at a time.
    Each beat the run's view takes what live.jsonl gained, and a cancel, the
    owner's stop, or the run's timeout plus _SLACK, sends the helper's stop, again
    on each beat until it ends. After _GIVE_UP more seconds the bridge stops
    waiting. -> (its exit code, its stderr's last line, whether it ran out of time)."""
    p = popen(_helper("start", request_id), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
              stderr=subprocess.PIPE, text=True, errors="replace", start_new_session=True)
    stage = stage_dir(request_id)
    deadline = time.monotonic() + timeout + _SLACK
    late, err = False, ""
    while True:
        try:
            err = p.communicate(timeout=_BEAT)[1] or ""
            break
        except subprocess.TimeoutExpired:
            _view(view, "pump", stage)
            late = late or time.monotonic() >= deadline
            if late or request_id in _cancelled or request_id in _owner_stopped:
                _stop(request_id, call)
            if late and time.monotonic() >= deadline + _GIVE_UP:
                # shortcut: a helper that won't stop is left to end on its own (its stage
                # goes now, so it finds none); kill it outright if hung helpers show up.
                break
    _view(view, "pump", stage)
    lines = [line.strip() for line in err.splitlines() if line.strip()]
    return p.returncode, (lines[-1].removeprefix("mystical-run-helper: ") if lines else ""), late


def _result(worker, base, head, stage, rc, err, late, minutes, view):
    """The result body. COMPLETED needs the helper and Claude to have exited 0,
    out/ handed back and a summary; its screens go up first, and into the view."""
    out = os.path.join(stage, "out")
    done = _read_json(os.path.join(out, "exit.json"))
    summary, listed = parse_report(_read(os.path.join(out, "claude.json")))
    if late or done.get("timedOut"):
        error = f"The run timed out after {minutes} min."
    elif rc:
        error = err or f"The run stopped with exit code {rc}."
    elif not done:
        error = _UNREPORTED    # exit 0 follows a hand-back: a taken-back run's helper was killed or refused
    elif done.get("code") not in (0, None):
        error = f"The run stopped with exit code {done['code']}."
    elif not summary.strip():
        error = "No report came back."
    else:
        screens, note = _upload(worker, base, head, os.path.join(out, "screens"), listed, view)
        return {"status": "COMPLETED", "result": summary[:_RESULT_MAX - len(note)] + note, "screens": screens}
    return {"status": "FAILED", "error": error[:_ERROR_MAX], "screens": []}


def _upload(worker, base, head, screens_dir, listed, view):
    """The screens, PUT as 1, 2, ...: the report's in its order, then any other
    PNGs by name. Only plain files directly in out/screens are read, whatever the
    report names. One Rivendell refuses is left out, as a result naming it would
    be refused whole. The ones that went up show in the run's view too.
    -> ([{index, caption}], a note for the summary)."""
    try:
        sizes = {e.name: e.stat(follow_symlinks=False).st_size
                 for e in os.scandir(screens_dir) if e.is_file(follow_symlinks=False)}
    except OSError:
        sizes = {}
    order = {}
    for s in listed:
        if s["file"] in sizes:
            order.setdefault(s["file"], s["caption"])
    for name in sorted(sizes):
        if name.lower().endswith(".png"):
            order.setdefault(name, "")
    screens, over, shown = [], [], []
    for name, caption in order.items():
        if sizes[name] > _SCREEN_MAX:
            over.append(name)
            continue
        if len(screens) == _SCREENS_MAX:
            continue
        with os.fdopen(os.open(os.path.join(screens_dir, name), os.O_RDONLY | os.O_NOFOLLOW), "rb") as f:
            data = f.read()
        index = len(screens) + 1
        try:
            worker._api_put_bytes(f"{base}/screens/{index}", data, "application/octet-stream", headers=head)
        except Exception as e:  # noqa: BLE001 — the result just goes without it
            print(f"rivendell[{worker.name}]: screen {name} of {base} didn't upload: {e}")
            continue
        screens.append({"index": index, "caption": caption[:_CAPTION_MAX]})
        shown.append((name, data))
    _view(view, "screens", shown)
    note = f"\n\nScreenshots over 5 MB were left out: {', '.join(over)}." if over else ""
    return screens, note


def _post(worker, base, head, body):
    """The result, retried through a network or server hiccup. A 4xx is Rivendell
    refusing this very body, which waiting can't change. The summary, the error
    and every caption go redacted, cut to Rivendell's lengths again ("[redacted]"
    can be longer than what it replaced)."""
    body = dict(body)
    for key, cap in (("result", _RESULT_MAX), ("error", _ERROR_MAX)):
        if isinstance(body.get(key), str):
            body[key] = redact(body[key])[:cap]
    body["screens"] = [{**s, "caption": redact(s["caption"])[:_CAPTION_MAX]} for s in body.get("screens") or []]
    for delay in (*_RETRIES, None):
        try:
            worker._api(base + "/result", body, headers=head)
            return
        except Exception as e:  # noqa: BLE001 — retried; loud on the last
            code = e.code if isinstance(e, urllib.error.HTTPError) else None
            if delay is None or (code is not None and 400 <= code < 500 and code not in (408, 429)):
                print(f"rivendell[{worker.name}]: the result POST failed for {base}: {e}")
                return
            time.sleep(delay)


def _read(path):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            return f.read(_READ_MAX)
    except OSError:
        return ""


def _read_json(path):
    try:
        d = json.loads(_read(path))
    except ValueError:
        return {}
    return d if isinstance(d, dict) else {}


def _drop(stage):
    """A stage, its token first: whatever else can't go, that must."""
    try:
        os.unlink(os.path.join(stage, "token"))
    except OSError:
        pass
    shutil.rmtree(stage, ignore_errors=True)


def sweep(run=subprocess.run, alive=helper_alive) -> None:
    """At bridge start: the stages a bridge that stopped mid-run left. The helper
    runs in a session of its own, so a stale stage's run may still be going, with
    or without a token on disk (the helper takes it off as it starts). One whose
    helper still goes (`alive`), or already handed back its results
    (out/exit.json: the bridge stopped while it uploaded or posted them), is
    taken back: kept, and filed under the instance its job.json names, for that
    worker to watch to its end and post its own result (take_adopted, resume).
    Every other one is told to stop, which does nothing unless that run holds
    the helper's lock, nobody being left to report it; it is noted for
    report_interrupted() under its instance, then the stage goes, token first.
    Last, every view still RUNNING but the ones taken back ends
    (device_view.orphans), a view whose stage went long ago too.
    Only a stage root that is this account's own is looked in, and only its
    folders named by a run id count, never through a link."""
    try:
        _sweep(run, alive)
    finally:
        _view(device_view, "orphans", {rid for ids in _adopted.values() for rid in ids})


def _sweep(run, alive):
    if not os.path.lexists(STAGE_ROOT):
        return     # not set up
    if not _root_is_ours():
        print(f"device runs: {STAGE_ROOT} isn't this account's own folder; the boot clean-up leaves it alone")
        return
    try:
        names = os.listdir(STAGE_ROOT)
    except OSError:
        return
    for name in names:
        stage = stage_dir(name)
        try:
            st = os.lstat(stage)
        except OSError:
            continue
        if not _RUN_ID.fullmatch(name) or not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid():
            continue
        instance = _read_json(os.path.join(stage, "job.json")).get("instance")
        named = isinstance(instance, str) and instance
        handed_back = os.path.exists(os.path.join(stage, "out", "exit.json"))
        if named and (handed_back or alive(name)):    # None, ps can't tell, counts as gone
            _adopted.setdefault(instance, []).append(name)
            continue
        _stop(name, run)
        if named:
            _interrupted.setdefault(instance, []).append(name)
        _drop(stage)


def resume(worker, request_id: str, call=subprocess.run, alive=helper_alive) -> None:
    """A run sweep() took back, its helper still going after a restart or its
    results already handed back, seen to its end as run() would: its view
    reopened past a divider, a beat at a time until `alive` says the helper is
    gone (at once, for one that had handed back and exited), not while it can't
    tell (the view takes what live.jsonl gained, and a cancel, the owner's stop,
    or the timeout counted from job.json's time, sends the stop), then the
    result posted once, the last run noted, the view closed, the bell rung and
    the stage dropped. The helper's stderr went with the bridge that started
    it, so one that ended without handing back says only that.
    shortcut: the helper's sudo stays a child of this process (the restart
    re-exec'd it in place), and once it exits nobody reaps it: a harmless zombie
    until the bridge next really starts; reap it if they ever pile up."""
    try:
        _resume(worker, request_id, call, alive)
    finally:
        _cancelled.discard(request_id)
        _owner_stopped.discard(request_id)


def _resume(worker, request_id, call, alive):
    stage = stage_dir(request_id)
    job = _read_json(os.path.join(stage, "job.json"))
    try:
        began = os.lstat(os.path.join(stage, "job.json")).st_mtime    # staged just before the helper started
    except OSError:
        began = time.time()
    head, base = headers(worker.inst), f"/plugin/device-run-requests/{request_id}"
    view = _view(device_view, "reopen", request_id)
    _view(view, "divider", f"Mystical restarted {time.strftime('%H:%M')} · this run kept going")
    body = None
    try:
        try:
            timeout = int(job.get("timeoutSeconds") or worker.inst.get("impl_timeout", 10800))
            deadline, late = began + timeout + _SLACK, False
            while alive(request_id) is not False:    # None, ps can't tell: watch on, the deadline still bounds it
                _view(view, "pump", stage)
                late = late or time.time() >= deadline
                if late or request_id in _cancelled or request_id in _owner_stopped:
                    _stop(request_id, call)
                if late and time.time() >= deadline + _GIVE_UP:
                    break    # as in _start: left to end on its own
                time.sleep(_BEAT)
            _view(view, "pump", stage)
            body = _result(worker, base, head, stage, 0, "", late, max(1, timeout // 60), view)
        except Exception as e:  # noqa: BLE001 — still this run's failure, and it is posted
            print(f"rivendell[{worker.name}]: device run {request_id} crashed: {e}")
            body = {"status": "FAILED", "error": f"bridge error: {e}"[:_ERROR_MAX], "screens": []}
        body = _report(worker, base, head, request_id, body)
        device_share.record_last_run(job.get("requester") or "", job.get("task"))
    finally:
        if _root_is_ours():    # never remove anything through a root someone else planted
            _drop(stage)
        _ended(worker, request_id, job.get("requester"), began, view, body)


def report_interrupted(worker, head: dict) -> None:
    """The runs of this worker's instance a restart cut short (sweep), posted
    FAILED once its device is connected again: Rivendell takes a device's result
    only from a device whose socket is open, so not at bridge start. Each is kept
    until a post lands, or Rivendell answers 409 (the run has ended there), and
    is tried again on each READY connect; a failed post is logged. The stages
    went at bridge start."""
    ids = _interrupted.get(worker.inst["id"])
    for request_id in list(ids or ()):
        try:
            worker._api(f"/plugin/device-run-requests/{request_id}/result",
                        {"status": "FAILED", "error": _RESTARTED, "screens": []}, headers=head)
        except Exception as e:  # noqa: BLE001 — logged, and kept for the next connect
            if not (isinstance(e, urllib.error.HTTPError) and e.code == 409):
                print(f"rivendell[{worker.name}]: device run {request_id} cut short by a restart "
                      f"couldn't be reported yet: {e}")
                continue
        ids.remove(request_id)
    if ids == []:
        _interrupted.pop(worker.inst["id"], None)
