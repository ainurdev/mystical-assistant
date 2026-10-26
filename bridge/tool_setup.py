"""Set up: the tools a Rivendell transcript runs on, installed when the owner asks.

Rivendell's Pool page (or a file's Transcript tab) sends this Mystical
`{type: 'setup-request', need: 'transcribe'}` when its owner presses Set up. This
installs what's missing with Homebrew (ffmpeg, whisper-cpp), downloads the whisper
model to config.WHISPER_MODEL (into a .part file, checked against its size and
SHA-256, then moved into place), reports each step to POST /plugin/setup-progress,
and redials every Rivendell link so the new X-Mystical-Tools header goes out
(rivendell_video.tools_header). The frame names a need, never a command: this is a
fixed recipe. macOS only for now.
"""
import hashlib
import os
import shutil
import subprocess
import sys
import threading
import time
import urllib.request

from bridge import config

MODEL_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin"
MODEL_BYTES = 1_624_555_275
MODEL_SHA256 = "1fc70f774d38eb169993ac391eea357ef47c88757ef72ee5943879b7e8e2bc69"
REPORT_EVERY = 2.0       # seconds between download reports
HEARTBEAT = 10.0         # a long brew step still reports this often: Rivendell calls 2 minutes of silence a failure
BREW_TIMEOUT = 15 * 60
CHUNK = 1024 * 1024

# (tools() key, Homebrew formula, the step's name)
_FORMULAS = (("ffmpeg", "ffmpeg", "ffmpeg"), ("whisper", "whisper-cpp", "whisper.cpp"))

_lock = threading.Lock()     # one Set up at a time; a second request while one runs is dropped


class SetupError(RuntimeError):
    """Set up can't go on; the message is what the owner reads in Rivendell."""


def run(worker, frame) -> None:
    """Handle a setup-request frame for `worker`'s link. Never raises."""
    if (frame or {}).get("need") != "transcribe" or not _lock.acquire(blocking=False):
        return
    try:
        _transcribe(worker)
    except Exception as e:  # noqa: BLE001 — whatever happens, the owner hears it
        _post(worker, "failed", error=f"Set up stopped: {e}")
    finally:
        _lock.release()


def _transcribe(worker) -> None:
    from bridge import rivendell_video          # local import: keeps the tests' monkeypatching simple
    try:
        if sys.platform != "darwin":
            raise SetupError("Set up works on macOS only for now.")
        _post(worker, "running", "Checking what this machine has")
        have = rivendell_video.tools()
        for key, formula, name in _FORMULAS:
            if not have.get(key):
                _brew(worker, formula, f"Installing {name}")
        if not have.get("model"):
            _download(worker, os.path.expanduser(config.WHISPER_MODEL))
    except SetupError as e:
        _post(worker, "failed", error=str(e))
        return
    _post(worker, "done")
    from bridge import rivendell                # local import: rivendell imports this module's caller side
    rivendell.redial_tools()


def _brew(worker, formula: str, step: str) -> None:
    brew = shutil.which("brew")
    if not brew:
        raise SetupError("Homebrew isn't installed on this machine.")
    _post(worker, "running", step)
    proc = subprocess.Popen([brew, "install", formula], stdout=subprocess.DEVNULL,
                            stderr=subprocess.PIPE, text=True)
    deadline = time.monotonic() + BREW_TIMEOUT
    while True:
        try:
            _, err = proc.communicate(timeout=HEARTBEAT)
            break
        except subprocess.TimeoutExpired:
            if time.monotonic() > deadline:
                proc.kill()
                proc.communicate()
                raise SetupError(f"{step} took longer than {BREW_TIMEOUT // 60} minutes.") from None
            _post(worker, "running", step)      # still going
    if proc.returncode != 0:
        last = (err or "").strip().splitlines()[-1:]
        raise SetupError(f"{step} failed: {last[0] if last else f'brew exited with {proc.returncode}'}")


def _download(worker, dest: str) -> None:
    """The model, into `dest`.part, checked, then moved into place: a cut-off or wrong
    file never sits where whisper-cli (and tools()) would take it for the model."""
    step = "Downloading the whisper model"
    part = f"{dest}.part"
    os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
    digest, done, last = hashlib.sha256(), 0, 0.0
    _post(worker, "running", step, 0, MODEL_BYTES)
    try:
        with urllib.request.urlopen(MODEL_URL, timeout=60) as response, open(part, "wb") as out:
            while True:
                chunk = response.read(CHUNK)
                if not chunk:
                    break
                out.write(chunk)
                digest.update(chunk)
                done += len(chunk)
                if time.monotonic() - last >= REPORT_EVERY:
                    _post(worker, "running", step, done, MODEL_BYTES)
                    last = time.monotonic()
        if done != MODEL_BYTES or digest.hexdigest() != MODEL_SHA256:
            raise SetupError("The download didn't match the expected file.")
        os.replace(part, dest)
    except SetupError:
        _remove(part)
        raise
    except Exception as e:  # noqa: BLE001 — the network, the disk: the owner reads why
        _remove(part)
        raise SetupError(f"The download stopped: {e}") from None


def _remove(path: str) -> None:
    try:
        os.remove(path)
    except OSError:
        pass


def _post(worker, state: str, step: "str | None" = None, done: "int | None" = None,
          total: "int | None" = None, error: "str | None" = None) -> None:
    """Report to Rivendell's /plugin/setup-progress; a report that doesn't land is only logged."""
    body: dict = {"need": "transcribe", "state": state}
    if step:
        body["step"] = step
    if done is not None:
        body["doneBytes"] = done
    if total is not None:
        body["totalBytes"] = total
    if error:
        body["error"] = error[:500]
    try:
        worker._api("/plugin/setup-progress", body)
    except Exception as e:  # noqa: BLE001 — progress is best effort; the install goes on
        print(f"tool_setup: could not report {state}: {e}")
