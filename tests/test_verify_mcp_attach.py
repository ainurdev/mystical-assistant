"""verify_mcp Attach: the result names the picture's size and says when it will
not read on the human's screen (a 1x capture, a whole-page poster).
Run: `python tests/test_verify_mcp_attach.py`  (or pytest)
"""

import os
import struct
import sys
import tempfile
import zlib

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ["BASE_PATH"] = tempfile.mkdtemp()
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ["BRIDGE_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")

from bridge import verify_mcp  # noqa: E402

TMP = tempfile.mkdtemp()


def _png(w, h):
    def chunk(tag, body):
        return struct.pack(">I", len(body)) + tag + body + struct.pack(">I", zlib.crc32(tag + body))
    raw = zlib.compress(b"".join(b"\x00" + b"\x00" * (w * 3) for _ in range(h)))
    p = os.path.join(TMP, f"{w}x{h}.png")
    with open(p, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
                + chunk(b"IDAT", raw) + chunk(b"IEND", b""))
    return p


def _jpeg(w, h):
    """A JPEG header with an APP0 and a baseline SOF0 -- enough to read the size."""
    p = os.path.join(TMP, f"{w}x{h}.jpg")
    app0 = b"\xff\xe0" + struct.pack(">H", 16) + b"JFIF\x00\x01\x01\x00\x00\x01\x00\x01\x00\x00"
    sof0 = b"\xff\xc0" + struct.pack(">HBHHB", 11, 8, h, w, 1) + b"\x01\x11\x00"
    with open(p, "wb") as f:
        f.write(b"\xff\xd8" + app0 + sof0 + b"\xff\xd9")
    return p


def test_sizes_read_off_headers():
    assert verify_mcp.image_size(_png(2240, 1886)) == (2240, 1886)
    assert verify_mcp.image_size(_jpeg(1574, 540)) == (1574, 540)
    txt = os.path.join(TMP, "x.png")
    open(txt, "wb").write(b"not a png")
    assert verify_mcp.image_size(txt) is None


def test_attach_names_the_size_and_the_poster_problem():
    out = verify_mcp._attach({"path": _png(2240, 1886)})
    assert out.splitlines()[0] == _png(2240, 1886)     # first line stays the path the runner reads
    assert "2240x1886 px" in out
    assert "crop" in out and "1600px" in out


def test_attach_flags_a_1x_capture():
    out = verify_mcp._attach({"path": _png(787, 270)})
    assert "787x270 px" in out and "low-res" in out and "2x" in out


def test_attach_is_quiet_about_a_good_crop():
    out = verify_mcp._attach({"path": _jpeg(1574, 540)})
    assert out.endswith("1574x540 px.")


def test_attach_still_refuses_non_media():
    p = os.path.join(TMP, "notes.txt")
    open(p, "w").write("hi")
    assert verify_mcp._attach({"path": p}).startswith("Not an image or video")


if __name__ == "__main__":
    for k, v in list(globals().items()):
        if k.startswith("test_"):
            v()
            print("ok", k)
