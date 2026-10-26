"""Set up (bridge/tool_setup.py): the tools a Rivendell transcript runs on, installed
when the owner asks from Rivendell. Everything outside is faked: brew, the download,
the progress route and the redial."""
import hashlib
import io
import os

import pytest

from bridge import tool_setup

FRAME = {"type": "setup-request", "need": "transcribe"}


class Recorder:
    """A worker as Set up uses it: only its _api, which records each progress report."""

    def __init__(self):
        self.posts = []

    def _api(self, path, payload=None, headers=None):
        assert path == "/plugin/setup-progress"
        self.posts.append(payload)


class FakeBrew:
    calls: list = []

    def __init__(self, args, **kw):
        FakeBrew.calls.append(args)
        self.returncode = 0

    def communicate(self, timeout=None):
        return "", ""

    def kill(self):
        pass


def stream(data, fail_after=None):
    """urlopen's answer: `data` four bytes at a time, raising once `fail_after` bytes are read."""
    class Response(io.BytesIO):
        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self, n=-1):
            if fail_after is not None and self.tell() >= fail_after:
                raise OSError("connection reset")
            return super().read(4)

    return lambda url, timeout=None: Response(data)


@pytest.fixture
def mac(monkeypatch, tmp_path):
    """A Mac with Homebrew and no model yet; returns the model's path and the redials."""
    monkeypatch.setattr(tool_setup.sys, "platform", "darwin")
    model = tmp_path / "whisper-cpp" / "ggml-large-v3-turbo.bin"
    monkeypatch.setattr(tool_setup.config, "WHISPER_MODEL", str(model))
    monkeypatch.setattr(tool_setup.shutil, "which", lambda name: "/opt/homebrew/bin/brew" if name == "brew" else None)
    redials = []
    monkeypatch.setattr("bridge.rivendell.redial_tools", lambda: redials.append(True))
    FakeBrew.calls = []
    monkeypatch.setattr(tool_setup.subprocess, "Popen", FakeBrew)
    return model, redials


def have(monkeypatch, ffmpeg=True, whisper=True, model=True):
    monkeypatch.setattr("bridge.rivendell_video.tools", lambda: {"ffmpeg": ffmpeg, "whisper": whisper, "model": model})


def test_skips_whats_there(mac, monkeypatch):
    have(monkeypatch)
    w = Recorder()
    tool_setup.run(w, FRAME)
    assert [p["state"] for p in w.posts] == ["running", "done"]
    assert FakeBrew.calls == []
    assert mac[1] == [True]          # redialed, so Rivendell sees the tools


def test_installs_whats_missing(mac, monkeypatch):
    have(monkeypatch, whisper=False)
    w = Recorder()
    tool_setup.run(w, FRAME)
    assert FakeBrew.calls == [["/opt/homebrew/bin/brew", "install", "whisper-cpp"]]
    assert any(p.get("step") == "Installing whisper.cpp" for p in w.posts)
    assert w.posts[-1]["state"] == "done"


def test_downloads_and_checks_the_model(mac, monkeypatch):
    model, _ = mac
    data = b"ggml model bytes" * 10
    monkeypatch.setattr(tool_setup, "MODEL_BYTES", len(data))
    monkeypatch.setattr(tool_setup, "MODEL_SHA256", hashlib.sha256(data).hexdigest())
    monkeypatch.setattr(tool_setup, "REPORT_EVERY", 0)
    monkeypatch.setattr(tool_setup.urllib.request, "urlopen", stream(data))
    have(monkeypatch, model=False)
    w = Recorder()
    tool_setup.run(w, FRAME)
    assert model.read_bytes() == data
    assert not os.path.exists(f"{model}.part")
    assert w.posts[-1]["state"] == "done"
    sizes = [p["doneBytes"] for p in w.posts if "doneBytes" in p]
    assert sizes[0] == 0 and max(sizes) == len(data)
    assert {p["totalBytes"] for p in w.posts if "doneBytes" in p} == {len(data)}


def test_a_failed_download_leaves_no_model_behind(mac, monkeypatch):
    model, redials = mac
    data = b"x" * 100
    monkeypatch.setattr(tool_setup, "MODEL_BYTES", len(data))
    monkeypatch.setattr(tool_setup.urllib.request, "urlopen", stream(data, fail_after=40))
    have(monkeypatch, model=False)
    w = Recorder()
    tool_setup.run(w, FRAME)
    assert not model.exists() and not os.path.exists(f"{model}.part")
    assert w.posts[-1]["state"] == "failed"
    assert w.posts[-1]["error"].startswith("The download stopped")
    assert redials == []


def test_a_wrong_file_is_refused(mac, monkeypatch):
    model, _ = mac
    data = b"not the model"
    monkeypatch.setattr(tool_setup, "MODEL_BYTES", len(data))
    monkeypatch.setattr(tool_setup.urllib.request, "urlopen", stream(data))
    have(monkeypatch, model=False)
    w = Recorder()
    tool_setup.run(w, FRAME)
    assert not model.exists() and not os.path.exists(f"{model}.part")
    assert w.posts[-1] == {"need": "transcribe", "state": "failed", "error": "The download didn't match the expected file."}


def test_not_on_macos(mac, monkeypatch):
    monkeypatch.setattr(tool_setup.sys, "platform", "linux")
    have(monkeypatch, whisper=False)
    w = Recorder()
    tool_setup.run(w, FRAME)
    assert w.posts[-1] == {"need": "transcribe", "state": "failed", "error": "Set up works on macOS only for now."}


def test_no_homebrew(mac, monkeypatch):
    monkeypatch.setattr(tool_setup.shutil, "which", lambda name: None)
    have(monkeypatch, ffmpeg=False)
    w = Recorder()
    tool_setup.run(w, FRAME)
    assert w.posts[-1]["error"] == "Homebrew isn't installed on this machine."
    assert FakeBrew.calls == []


def test_one_set_up_at_a_time(mac, monkeypatch):
    have(monkeypatch)
    w = Recorder()
    assert tool_setup._lock.acquire(blocking=False)
    try:
        tool_setup.run(w, FRAME)        # a second frame while one runs
    finally:
        tool_setup._lock.release()
    assert w.posts == []


def test_only_the_transcribe_need(mac, monkeypatch):
    have(monkeypatch)
    w = Recorder()
    tool_setup.run(w, {"type": "setup-request", "need": "rm -rf /"})
    assert w.posts == []
