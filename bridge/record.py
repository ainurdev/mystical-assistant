"""A short screen recording of a page, so a UI change can be watched instead of
inferred from one still frame. The companion to screenshot.py -- same chrome,
one more dimension.

Why a node script rather than Python: recording drives CDP's screencast, CDP
needs a websocket, and the stdlib has no websocket client. Hand-rolling RFC 6455
framing to avoid shelling out to a script we already ship is the wrong trade.
node is already the bridge's build dependency (setup.sh installs it, and the web
bundles need it); a box without it gets a plain error here rather than a broken
feature.

Output is webm, never mp4: the only ffmpeg guaranteed present is the one
Playwright ships, built --disable-everything -- mjpeg in, libvpx out, webm
muxed. The codec is that build's: VP8 up to its ffmpeg 1011, VP9 in 1013, which
has no VP8 encoder. rec.mjs carries the timing detail.
shortcut: both surfaces and Telegram played VP8; VP9 was checked to record and to
play in headless Chrome only, so check WebKit (the Mac app) and Telegram if a clip
from ffmpeg 1013 won't play there.
"""

import json
import os
import shutil
import subprocess
import tempfile

REC_JS = os.path.join(os.path.dirname(os.path.abspath(__file__)), "rec.mjs")

# A recording is a UI check, not a film. This bounds the wait, the file that has
# to reach a phone, and the damage a model can do by asking for an hour of video.
MAX_SECONDS = 60


def capture(url: str, seconds: int = 8, width: int = 1200, height: int = 900,
            steps: str = "") -> "tuple[str, str | None, list]":
    """Record `url`; return (webm, final-frame jpg, chapters) in a fresh temp dir
    the caller owns. `seconds` is how long to watch after load; `steps` (optional
    JS, run with awaitPromise) extends that by however long it takes to finish.

    The still exists because nothing that calls this can watch video. Handing
    back only a clip means the caller reports "it works" having seen nothing.

    Chapters are `[{"t": seconds, "text": …}]` for every mark() the step script
    called, empty when it called none. They come back in the return value rather
    than staying on disk because the sidecar sits in this temp dir, and the
    caller moves only the clip out of it."""
    node = shutil.which("node")
    if not node:
        raise RuntimeError("node is not installed, and it is what drives the recorder")
    secs = max(1, min(MAX_SECONDS, int(seconds or 8)))
    out = os.path.join(tempfile.mkdtemp(prefix="rec-"), "clip.webm")
    proc = subprocess.run(
        [node, REC_JS, url, out, str(width), str(height), str(secs * 1000), "{}", steps or ""],
        capture_output=True, text=True, timeout=secs + 120)
    if proc.returncode != 0 or not os.path.exists(out):
        raise RuntimeError((proc.stderr or proc.stdout or "recorder failed").strip()[:300])
    still = os.path.splitext(out)[0] + ".jpg"
    chapters = []
    try:
        with open(out + ".chapters.json") as f:
            chapters = json.load(f)
    except (OSError, ValueError):
        pass            # no marks is the normal case, not a failure
    return out, (still if os.path.exists(still) else None), chapters
