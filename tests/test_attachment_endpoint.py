"""Both surfaces serve a turn's uploaded screenshots back to the transcript, and
serve nothing else: only image files inside UPLOAD_DIR. Plus the retention that
keeps those files viewable — a finished run prunes by age, not on the spot.
Run: python tests/test_attachment_endpoint.py"""

import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ.setdefault("ALLOWED_CHAT_IDS", "555")
os.environ["BASE_PATH"] = tempfile.mkdtemp()
os.environ.setdefault("BRIDGE_DB", os.path.join(tempfile.mkdtemp(), "t.db"))

from bridge import config, runner  # noqa: E402
from bridge.dashboard import server as dash  # noqa: E402
from bridge.miniapp import server as mini  # noqa: E402

PNG = (b"\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01"
       b"\x08\x06\x00\x00\x00\x1f\x15\xc4\x89")


def _handler():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    h._send = lambda data, code, ctype, cache="no-cache": box.update(
        data=data, code=code, ctype=ctype)
    return h, box


def _upload(job_id, name, data=PNG):
    d = os.path.join(config.UPLOAD_DIR, job_id)
    os.makedirs(d, exist_ok=True)
    p = os.path.join(d, name)
    with open(p, "wb") as f:
        f.write(data)
    return p


def test_serves_uploaded_image():
    p = _upload("job_ok", "shot1.png")
    h, box = _handler()
    h._get_api("/local/attachment", {"path": [p]})
    assert box["code"] == 200 and box["data"] == PNG
    assert box["ctype"] == "image/png"


def test_404_when_upload_cleaned_up():
    p = os.path.join(config.UPLOAD_DIR, "job_gone", "shot1.png")
    h, box = _handler()
    h._get_api("/local/attachment", {"path": [p]})
    assert box["code"] == 404


def test_rejects_path_outside_upload_dir():
    outside = os.path.join(config.BASE_PATH, "private.png")
    with open(outside, "wb") as f:
        f.write(PNG)
    h, box = _handler()
    h._get_api("/local/attachment", {"path": [outside]})
    assert box["code"] == 404


def test_rejects_traversal_out_of_upload_dir():
    outside = os.path.join(config.BASE_PATH, "escaped.png")
    with open(outside, "wb") as f:
        f.write(PNG)
    h, box = _handler()
    h._get_api("/local/attachment",
               {"path": [os.path.join(config.UPLOAD_DIR, "..", "escaped.png")]})
    assert box["code"] == 404


def test_rejects_non_image_inside_upload_dir():
    p = _upload("job_txt", "notes.txt", b"secret")
    h, box = _handler()
    h._get_api("/local/attachment", {"path": [p]})
    assert box["code"] == 404


def test_rejects_blank_path():
    h, box = _handler()
    h._get_api("/local/attachment", {})
    assert box["code"] == 404


def _mini_handler():
    h = mini.Handler.__new__(mini.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    h._send_bytes = lambda data, code, ctype, cache="no-cache": box.update(
        data=data, code=code, ctype=ctype)
    return h, box


def test_miniapp_serves_uploaded_image():
    p = _upload("job_mini", "shot1.png")
    h, box = _mini_handler()
    h._api_attachment(p)
    assert box["code"] == 200 and box["data"] == PNG
    assert box["ctype"] == "image/png"


def test_miniapp_serves_nothing_but_images_under_upload_dir():
    outside = os.path.join(config.BASE_PATH, "mini-private.png")
    with open(outside, "wb") as f:
        f.write(PNG)
    cases = {
        "outside the upload dir": outside,
        "traversal back out of it": os.path.join(config.UPLOAD_DIR, "..", "mini-private.png"),
        "a non-image inside it": _upload("job_mini_txt", "notes.txt", b"secret"),
        "an upload already cleaned up": os.path.join(config.UPLOAD_DIR, "gone", "shot1.png"),
        "no path at all": "",
    }
    for what, path in cases.items():
        h, box = _mini_handler()
        h._api_attachment(path)
        assert box["code"] == 404, what


def test_stored_turn_attachments_reopen_after_a_session_switch():
    """The store keeps bare filenames; a transcript must hand out paths this
    endpoint can serve — otherwise leaving a session and coming back turns the
    screenshots you sent into a paperclip count."""
    from bridge import store
    store.init()
    s = store.create_session(555, "proj", cwd=config.BASE_PATH)
    store.start_turn(s["id"], "job_reopen", "look at this", ["shot1.png"])
    _upload("job_reopen", "shot1.png")

    path = store.transcript(s["id"])["turns"][0]["attachments"][0]
    h, box = _handler()
    h._get_api("/local/attachment", {"path": [path]})
    assert box["code"] == 200 and box["data"] == PNG


def test_prune_keeps_recent_and_drops_expired():
    fresh = _upload("job_fresh", "shot1.png")
    stale = _upload("job_stale", "shot1.png")
    old = time.time() - (config.UPLOAD_KEEP_DAYS + 1) * 86400
    os.utime(os.path.dirname(stale), (old, old))
    runner._prune_uploads()
    assert os.path.isfile(fresh)
    assert not os.path.exists(os.path.dirname(stale))


if __name__ == "__main__":
    fns = [v for k, v in sorted(globals().items())
           if k.startswith("test_") and callable(v)]
    failed = 0
    for fn in fns:
        try:
            fn()
            print(f"PASS {fn.__name__}")
        except Exception as e:  # noqa: BLE001
            failed += 1
            print(f"FAIL {fn.__name__}: {type(e).__name__}: {e}")
    print(f"\n{len(fns) - failed}/{len(fns)} passed")
    raise SystemExit(1 if failed else 0)
