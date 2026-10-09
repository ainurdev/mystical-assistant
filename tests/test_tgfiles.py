"""Files sent to the bot (bridge/tgfiles.py and its wiring in dispatch/runner).

The bot used to drop anything that wasn't text. Now a file is downloaded (size
checked first, against Telegram's 20 MB and UPLOAD_MAX_MB), its caption runs as
the prompt with the file attached, and a file with no caption waits for the
chat's next message. The turn finds the file in its own upload dir, where the
dashboard looks.
"""

import io
import os
import threading

import pytest

from bridge import config, dispatch, runner, store, tgfiles


class _Resp(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture
def uploads(tmp_path, monkeypatch):
    d = str(tmp_path / "uploads")
    monkeypatch.setattr(config, "UPLOAD_DIR", d)
    monkeypatch.setattr(config, "UPLOAD_MAX_MB", 10)
    tgfiles._held.clear()
    return d


@pytest.fixture
def bot(uploads, monkeypatch):
    """on_message with the network and the run stubbed, threads run inline."""
    sent, runs = [], []
    monkeypatch.setattr(dispatch, "send", lambda chat, text, kb=None: sent.append(text))
    monkeypatch.setattr(dispatch, "handle_task",
                        lambda chat, text, session, files=None: runs.append((text, files)))

    class Inline:
        def __init__(self, target, args=(), daemon=None):
            self.target, self.args = target, args

        def start(self):
            self.target(*self.args)

    monkeypatch.setattr(dispatch.threading, "Thread", Inline)
    monkeypatch.setattr(dispatch.state, "acquire_run", lambda sid, chat: True)
    monkeypatch.setattr(tgfiles, "tg", lambda method, **kw: {"file_path": "docs/f.bin"})
    monkeypatch.setattr(tgfiles, "urlopen", lambda req, timeout=0: _Resp(b"payload"))
    store.init()
    return sent, runs


def _doc(caption=None, size=7, name="spec.pdf"):
    m = {"chat": {"id": 555}, "message_id": 9,
         "document": {"file_id": "F1", "file_name": name, "file_size": size}}
    if caption is not None:
        m["caption"] = caption
    return m


def test_a_caption_runs_with_the_file(bot):
    sent, runs = bot
    dispatch.on_message(_doc("summarise this"))
    assert len(runs) == 1
    text, files = runs[0]
    assert text == "summarise this"
    assert len(files) == 1 and open(files[0], "rb").read() == b"payload"
    assert files[0].endswith("spec.pdf")


def test_a_file_without_a_caption_waits_for_the_next_message(bot):
    sent, runs = bot
    dispatch.on_message(_doc())
    assert runs == [] and "goes with your next message" in sent[-1]
    dispatch.on_message({"chat": {"id": 555}, "text": "what is in it?"})
    text, files = runs[0]
    assert text == "what is in it?" and len(files) == 1
    dispatch.on_message({"chat": {"id": 555}, "text": "and again"})
    assert runs[1] == ("and again", []), "handed over once"


def test_a_file_too_big_for_a_bot_is_refused_before_downloading(bot, monkeypatch):
    sent, runs = bot
    monkeypatch.setattr(tgfiles, "tg", lambda *a, **k: pytest.fail("no download"))
    dispatch.on_message(_doc("x", size=900 * 1024 * 1024, name="move.tar.gz"))
    assert runs == [] and "20 MB" in sent[-1] and "move.tar.gz" in sent[-1]
    dispatch.on_message(_doc("x", size=15 * 1024 * 1024))
    assert "10 MB attachment limit" in sent[-1]


def test_a_stream_longer_than_its_size_says_is_cut_off(uploads, monkeypatch):
    monkeypatch.setattr(config, "UPLOAD_MAX_MB", 1)
    monkeypatch.setattr(tgfiles, "tg", lambda method, **kw: {"file_path": "x"})
    monkeypatch.setattr(tgfiles, "urlopen",
                        lambda req, timeout=0: _Resp(b"x" * (2 * 1024 * 1024)))
    with pytest.raises(ValueError):
        tgfiles.save({"file_id": "F", "name": "liar.bin", "size": 10})
    assert not any(files for _, _, files in os.walk(uploads))


def test_the_largest_photo_size_is_kept():
    got = tgfiles.incoming({"message_id": 3, "photo": [
        {"file_id": "s", "file_size": 10, "width": 90, "height": 90},
        {"file_id": "l", "file_size": 900, "width": 1280, "height": 960}]})
    assert got == {"file_id": "l", "name": "photo-3.jpg", "size": 900}
    voice = tgfiles.incoming({"message_id": 4, "voice": {"file_id": "v", "mime_type": "audio/ogg"}})
    assert voice["name"] == "voice-4.ogg"
    assert tgfiles.incoming({"message_id": 5, "text": "hi"}) is None


def test_held_files_expire(uploads, monkeypatch):
    p = os.path.join(uploads, "a")
    os.makedirs(uploads)
    open(p, "w").close()
    tgfiles.hold(555, p)
    real = tgfiles.time.time
    monkeypatch.setattr(tgfiles.time, "time", lambda: real() + tgfiles.HOLD_SECS + 1)
    assert tgfiles.take(555) == []


def test_the_turn_finds_its_files_in_its_own_upload_dir(uploads):
    src = os.path.join(uploads, "tg-1", "spec.pdf")
    os.makedirs(os.path.dirname(src))
    open(src, "w").write("x")
    moved = runner.adopt_uploads("turn42", [src])
    assert moved == [os.path.join(uploads, "turn42", "1-spec.pdf")]
    assert not os.path.exists(os.path.dirname(src)), "its empty tg- folder goes too"


def test_help_says_files_work():
    assert "file or photo" in dispatch.HELP


def test_threads_are_real_outside_the_fixture():
    assert dispatch.threading.Thread is threading.Thread
