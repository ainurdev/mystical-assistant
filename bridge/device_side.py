"""The device side of device runs: a teammate's run on this shared device.

Rivendell announces a run (`device-run-request`) to the shared devices that are
on; bridge/rivendell.py queues it as kind "device-run", one at a time, and hands
it to run() here:
  1. Claim it (GET .../prompt, with X-Mystical-Device-Id). A 409 is another
     device's claim: dropped quietly, nothing posted.
  2. Tell the owner on Telegram who is testing what on this device.
  3. Stage it in /Users/Shared/Mystical Runs/<id>/, the owner's own 0700 folder:
     job.json, the code snapshot, and the asker's Claude token (0600) last.
  4. Start the root helper (bridge/device_setup/mystical_run_helper.py) with
     sudo -n, in a session of its own, so a bridge restart doesn't take it down
     with the token still staged. It runs Claude as the hidden user mysticalruns
     and hands back out/ (exit.json, claude.json, screens/).
  5. Upload the screenshots the report lists, then any other PNGs, at most 20
     of at most 5 MB each, and post the result.
  6. Remove the stage, token first, on every path.
A cancel (`device-run-cancel`) calls stop(): the helper's stop now, and again on
each beat for as long as that run's start goes on, since a cancel that lands
while the code is unpacking finds no run to stop yet. A cancelled run posts
nothing; Rivendell has closed it.

A bridge that stopped mid-run leaves its stage behind; sweep() clears those at
the next start (rivendell.start), stopping a helper that may still be running,
and report_interrupted() posts each such run FAILED once its instance's device
is connected again (Rivendell takes a device's result only then).
"""

import json
import os
import re
import shutil
import stat
import subprocess
import time
import urllib.error
import urllib.request
from urllib.parse import urlsplit

from bridge import device_share

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
_interrupted: dict = {}   # instance id -> run ids a restart cut short, still to report (sweep, report_interrupted)
_RESTARTED = "The device restarted during the run."


def stage_dir(request_id: str) -> str:
    """Where a run is staged for the helper."""
    return os.path.join(STAGE_ROOT, request_id)


def headers(inst: dict) -> "dict | None":
    """What this device's calls carry, X-Mystical-Device-Id, when it is READY for
    teammates' runs; None when it isn't, and then it takes none."""
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


def _stop(request_id, run):
    try:
        r = run(_helper("stop", request_id), stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=60)
    except (OSError, subprocess.SubprocessError) as e:
        print(f"device run {request_id}: the stop failed: {e}")
        return
    if r.returncode:
        print(f"device run {request_id}: the stop failed: {(r.stderr or '').strip()}")


def parse_report(claude_json: str) -> "tuple[str, list]":
    """The run's report, out of Claude's JSON output: the last JSON object in its
    result text that has a "summary" (the prompt asks Claude to end on one), as
    (summary, [{file, caption}]). With none, the whole result text and []."""
    try:
        text = json.loads(claude_json).get("result")
    except (ValueError, AttributeError):
        text = None
    if not isinstance(text, str):
        return "", []
    found, decoder, i = None, json.JSONDecoder(), text.find("{")
    while i != -1:
        try:
            obj, end = decoder.raw_decode(text, i)
        except ValueError:
            i = text.find("{", i + 1)
            continue
        if isinstance(obj, dict) and isinstance(obj.get("summary"), str):
            found = obj
        i = text.find("{", end)
    if found is None:
        return text, []
    screens = [{"file": s["file"], "caption": s.get("caption") if isinstance(s.get("caption"), str) else ""}
               for s in found.get("screens") or [] if isinstance(s, dict) and isinstance(s.get("file"), str)]
    return found["summary"], screens


def run(worker, request_id: str, popen=subprocess.Popen, call=subprocess.run) -> None:
    """One teammate's device run, start to finish (the module docstring has the
    steps). `popen` starts the helper, `call` stops it: the tests' seams."""
    if not _RUN_ID.fullmatch(request_id or ""):
        print(f"rivendell[{worker.name}]: device run {request_id!r} has no run id; not taking it")
        return     # it names the stage this removes
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
    try:
        try:
            worker._deliver_telegram(f"{claim['requester']['name']} is testing {claim['repository']} on this device.",
                                     None)
            _write_stage(stage, claim, timeout, worker.inst["id"])
            if request_id in _cancelled:
                return
            rc, err, late = _start(request_id, timeout, popen, call)
            body = _result(worker, base, head, stage, rc, err, late, max(1, timeout // 60))
        except Exception as e:  # noqa: BLE001 — still this run's failure, and it is posted
            print(f"rivendell[{worker.name}]: device run {request_id} crashed: {e}")
            body = {"status": "FAILED", "error": f"bridge error: {e}"[:_ERROR_MAX], "screens": []}
        if request_id not in _cancelled:
            _post(worker, base, head, body)
        device_share.record_last_run((claim.get("requester") or {}).get("name") or "",
                                     (claim.get("task") or {}).get("key"))
    finally:
        _drop(stage)
        _cancelled.discard(request_id)


def _write_stage(stage, claim, timeout, instance):
    """The stage the helper checks: the owner's 0700 folder with job.json, the
    code and, last, the token. The code comes from the web only: a file:// URL
    would hand the run one of the owner's own files as its code. job.json also
    names the Rivendell instance (not a secret), for sweep() after a restart."""
    os.mkdir(stage, 0o700)
    os.chmod(stage, 0o700)    # exactly, whatever the umask
    _write(os.path.join(stage, "job.json"), json.dumps({
        "prompt": claim["prompt"], "gitAuthorName": claim.get("gitAuthorName"),
        "gitAuthorEmail": claim.get("gitAuthorEmail"), "developerDir": device_share.developer_dir(),
        "timeoutSeconds": timeout, "instance": instance}).encode())
    url = claim["snapshotUrl"]
    if urlsplit(url).scheme not in ("http", "https"):
        raise ValueError("the code's address isn't a web address")
    with urllib.request.urlopen(url, timeout=60) as r:
        code = r.read(_SNAPSHOT_MAX + 1)
    if len(code) > _SNAPSHOT_MAX:
        raise ValueError("the code is over 9 MB")
    _write(os.path.join(stage, "code.tar.gz"), code)
    _write(os.path.join(stage, "token"), claim["claudeToken"].encode())


def _write(path, data):
    with os.fdopen(os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600), "wb") as f:
        f.write(data)


def _start(request_id, timeout, popen, call):
    """The helper's start, in a session of its own, waited on a beat at a time:
    a cancel, or the run's timeout plus _SLACK, sends its stop, again on each beat
    until it ends. After _GIVE_UP more seconds the bridge stops waiting.
    -> (its exit code, its stderr's last line, whether it ran out of time)."""
    p = popen(_helper("start", request_id), stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
              stderr=subprocess.PIPE, text=True, errors="replace", start_new_session=True)
    deadline = time.monotonic() + timeout + _SLACK
    late, err = False, ""
    while True:
        try:
            err = p.communicate(timeout=_BEAT)[1] or ""
            break
        except subprocess.TimeoutExpired:
            late = late or time.monotonic() >= deadline
            if late or request_id in _cancelled:
                _stop(request_id, call)
            if late and time.monotonic() >= deadline + _GIVE_UP:
                # shortcut: a helper that won't stop is left to end on its own (its stage
                # goes now, so it finds none); kill it outright if hung helpers show up.
                break
    lines = [line.strip() for line in err.splitlines() if line.strip()]
    return p.returncode, (lines[-1].removeprefix("mystical-run-helper: ") if lines else ""), late


def _result(worker, base, head, stage, rc, err, late, minutes):
    """The result body. COMPLETED needs the helper and Claude to have exited 0
    and a summary; its screens go up first."""
    out = os.path.join(stage, "out")
    done = _read_json(os.path.join(out, "exit.json"))
    summary, listed = parse_report(_read(os.path.join(out, "claude.json")))
    if late or done.get("timedOut"):
        error = f"The run timed out after {minutes} min."
    elif rc:
        error = err or f"The run stopped with exit code {rc}."
    elif done.get("code") not in (0, None):
        error = f"The run stopped with exit code {done['code']}."
    elif not summary.strip():
        error = "No report came back."
    else:
        screens, note = _upload(worker, base, head, os.path.join(out, "screens"), listed)
        return {"status": "COMPLETED", "result": summary[:_RESULT_MAX - len(note)] + note, "screens": screens}
    return {"status": "FAILED", "error": error[:_ERROR_MAX], "screens": []}


def _upload(worker, base, head, screens_dir, listed):
    """The screens, PUT as 1, 2, ...: the report's in its order, then any other
    PNGs by name. Only plain files directly in out/screens are read, whatever the
    report names. One Rivendell refuses is left out, as a result naming it would
    be refused whole. -> ([{index, caption}], a note for the summary)."""
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
    screens, over = [], []
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
    note = f"\n\nScreenshots over 5 MB were left out: {', '.join(over)}." if over else ""
    return screens, note


def _post(worker, base, head, body):
    """The result, retried through a network or server hiccup. A 4xx is Rivendell
    refusing this very body, which waiting can't change."""
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


def sweep(run=subprocess.run) -> None:
    """At bridge start: the stages a bridge that stopped mid-run left. The helper
    runs in a session of its own and takes the token when it ends, so a staged
    token means that run may still be going: it is stopped, nobody being left
    to report it. Each run is noted for report_interrupted() under the instance
    its job.json names, then the stage goes, token first: the token can't wait
    for a connection. Only this account's folders named by a run id count,
    never through a link."""
    try:
        names = os.listdir(STAGE_ROOT)
    except OSError:
        return     # not set up
    for name in names:
        stage = stage_dir(name)
        try:
            st = os.lstat(stage)
        except OSError:
            continue
        if not _RUN_ID.fullmatch(name) or not stat.S_ISDIR(st.st_mode) or st.st_uid != os.getuid():
            continue
        if os.path.lexists(os.path.join(stage, "token")):
            _stop(name, run)
        instance = _read_json(os.path.join(stage, "job.json")).get("instance")
        if isinstance(instance, str) and instance:
            _interrupted.setdefault(instance, []).append(name)
        _drop(stage)


def report_interrupted(worker, head: dict) -> None:
    """The runs of this worker's instance a restart cut short (sweep), posted
    FAILED once its device is connected again: Rivendell takes a device's result
    only from a device whose socket is open, so not at bridge start. One try
    each; a failed POST is logged, and its stage went at bridge start anyway."""
    for request_id in _interrupted.pop(worker.inst["id"], []):
        try:
            worker._api(f"/plugin/device-run-requests/{request_id}/result",
                        {"status": "FAILED", "error": _RESTARTED, "screens": []}, headers=head)
        except Exception as e:  # noqa: BLE001 — logged; the run was over either way
            print(f"rivendell[{worker.name}]: device run {request_id} cut short by a restart "
                  f"couldn't be reported: {e}")
