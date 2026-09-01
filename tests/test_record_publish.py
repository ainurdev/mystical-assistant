"""A recording the Record tool made has to reach the transcript, and nothing else
may ride that path: the runner moves the clip out of the tool's temp dir into the
run's uploads, but only for that tool, and only if it really is a video.
Run: python tests/test_record_publish.py"""

import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ["BASE_PATH"] = tempfile.mkdtemp()
os.environ.setdefault("BRIDGE_DB", os.path.join(tempfile.mkdtemp(), "t.db"))

from bridge import config, runner  # noqa: E402

WEBM = b"\x1a\x45\xdf\xa3" + b"\x00" * 32


def _clip(name="clip.webm", data=WEBM):
    p = os.path.join(tempfile.mkdtemp(prefix="rec-"), name)
    with open(p, "wb") as f:
        f.write(data)
    return p


def _content(path):
    return [{"type": "text", "text": f"{path}\nRecorded http://x/ — the clip is in the chat."}]


def test_moves_clip_into_the_runs_uploads():
    src = _clip()
    got = runner._save_result_video("job_rec", "mcp__verify__Record", _content(src))
    assert got and os.path.isfile(got), got
    assert got.startswith(os.path.join(config.UPLOAD_DIR, "job_rec") + os.sep)
    assert open(got, "rb").read() == WEBM
    assert not os.path.exists(src), "the temp copy should be moved, not left behind"


def test_two_clips_in_one_turn_do_not_collide():
    a = runner._save_result_video("job_two", "mcp__verify__Record", _content(_clip()))
    b = runner._save_result_video("job_two", "mcp__verify__Record", _content(_clip()))
    assert a and b and a != b


def test_ignores_every_other_tool():
    """The gate is the tool name — otherwise any tool that happened to print a
    path to a video on this disk could publish it into the chat."""
    src = _clip()
    for name in ("mcp__verify__Screenshot", "Bash", "Read", None, "Record_x"):
        assert runner._save_result_video("job_no", name, _content(src)) is None
    assert os.path.exists(src)


def test_ignores_a_path_that_is_not_video():
    for bad in (_clip("notes.txt", b"secret"), _clip("shot.png", b"\x89PNG")):
        assert runner._save_result_video("job_bad", "mcp__verify__Record", _content(bad)) is None
        assert os.path.exists(bad)


def test_ignores_a_path_that_is_not_there():
    gone = os.path.join(tempfile.mkdtemp(), "missing.webm")
    assert runner._save_result_video("job_gone", "mcp__verify__Record", _content(gone)) is None


def test_ignores_a_failure_message():
    """A failed recording returns prose, not a path — nothing should be moved."""
    content = [{"type": "text", "text": "Recording failed: node is not installed"}]
    assert runner._save_result_video("job_fail", "mcp__verify__Record", content) is None


if __name__ == "__main__":
    for n, f in sorted(globals().items()):
        if n.startswith("test_"):
            f()
            print(f"ok {n}")
