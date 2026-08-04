"""Images a tool hands back (Playwright, chrome-devtools, Figma…) are written to
the run's upload dir so the transcript can render them.

The event carries paths, never base64 — the event goes into the store and down
every SSE stream, and a screenshot is a megabyte.
Run: `python -m pytest tests/test_tool_images.py`
"""

import base64
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ["BASE_PATH"] = tempfile.mkdtemp()
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ["ALLOWED_CHAT_IDS"] = "555"
os.environ["BRIDGE_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")
os.environ["UPLOAD_DIR"] = tempfile.mkdtemp()

from bridge import config, runner  # noqa: E402

# A 1x1 PNG.
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


def _block(data: bytes, media_type="image/png"):
    return {"type": "image",
            "source": {"type": "base64", "media_type": media_type,
                       "data": base64.b64encode(data).decode()}}


def test_image_block_is_written_and_pathed():
    out = runner._save_result_images("job1", "rid1", [_block(PNG)])   # noqa: SLF001
    assert len(out) == 1
    assert os.path.isfile(out[0])
    assert out[0].startswith(os.path.realpath(config.UPLOAD_DIR)) or \
        out[0].startswith(config.UPLOAD_DIR)
    with open(out[0], "rb") as f:
        assert f.read() == PNG


def test_text_only_result_writes_nothing():
    assert runner._save_result_images(                                # noqa: SLF001
        "job2", "rid", [{"type": "text", "text": "no image here"}]) == []


def test_string_content_is_ignored():
    assert runner._save_result_images("job3", "rid", "plain output") == []   # noqa: SLF001


def test_images_are_capped_per_result():
    blocks = [_block(PNG) for _ in range(10)]
    out = runner._save_result_images("job4", "rid", blocks)           # noqa: SLF001
    assert len(out) == runner._MCP_IMG_MAX                            # noqa: SLF001


def test_oversized_image_is_dropped():
    big = b"\x89PNG" + b"\0" * (runner._MCP_IMG_BYTES + 1)            # noqa: SLF001
    assert runner._save_result_images("job5", "rid", [_block(big)]) == []   # noqa: SLF001


def test_malformed_base64_is_dropped_not_raised():
    bad = {"type": "image",
           "source": {"type": "base64", "media_type": "image/png", "data": "!!!not b64!!!"}}
    assert runner._save_result_images("job6", "rid", [bad]) == []     # noqa: SLF001


def test_non_base64_source_is_ignored():
    url = {"type": "image", "source": {"type": "url", "url": "https://x/y.png"}}
    assert runner._save_result_images("job7", "rid", [url]) == []     # noqa: SLF001


def test_media_type_picks_the_extension():
    out = runner._save_result_images("job8", "rid", [_block(PNG, "image/jpeg")])   # noqa: SLF001
    assert out and out[0].endswith(".jpg") or out[0].endswith(".jpeg")
