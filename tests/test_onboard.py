"""onboard: chat-id polling + .env writer. Run: python tests/test_onboard.py"""
import os

import pytest

from bridge import onboard


def test_poll_returns_first_chat_id():
    calls = {"n": 0}

    def fake_updates(token):
        calls["n"] += 1
        if calls["n"] < 2:
            return {"ok": True, "result": []}
        return {"ok": True, "result": [{"message": {"chat": {"id": 5116773453}}}]}

    cid = onboard.poll_chat_id("tok", get_updates=fake_updates, sleep=0, sleep_fn=lambda s: None)
    assert cid == 5116773453
    assert calls["n"] == 2


def test_poll_gives_up_returns_none():
    cid = onboard.poll_chat_id("tok", get_updates=lambda t: {"result": []},
                               attempts=3, sleep=0, sleep_fn=lambda s: None)
    assert cid is None


def test_poll_handles_edited_message():
    upd = {"result": [{"edited_message": {"chat": {"id": 42}}}]}
    cid = onboard.poll_chat_id("tok", get_updates=lambda t: upd, sleep_fn=lambda s: None)
    assert cid == 42


def test_set_env_appends_then_updates(tmp_path):
    p = tmp_path / ".env"
    onboard.set_env(str(p), "TELEGRAM_BOT_TOKEN", "abc")
    assert 'TELEGRAM_BOT_TOKEN="abc"' in p.read_text()
    onboard.set_env(str(p), "TELEGRAM_BOT_TOKEN", "xyz")
    body = p.read_text()
    assert 'TELEGRAM_BOT_TOKEN="xyz"' in body
    assert body.count("TELEGRAM_BOT_TOKEN=") == 1  # updated, not duplicated


def test_avatar_upload_is_valid_multipart():
    ctype, body = onboard.avatar_upload(b"\xff\xd8JPEGBYTES")
    boundary = ctype.split("boundary=")[1].encode()
    assert body.startswith(b"--" + boundary) and body.endswith(b"--" + boundary + b"--\r\n")
    assert b'{"type":"static","photo":"attach://pic"}' in body
    assert b'name="pic"' in body and b"\xff\xd8JPEGBYTES" in body


def test_profile_texts_fit_telegram_limits():
    assert len(onboard.DESCRIPTION) <= 512
    assert len(onboard.SHORT_DESCRIPTION) <= 120


def test_ensure_profile_only_fills_blanks(monkeypatch):
    calls = []

    def fake_call(token, method, **params):
        calls.append(method)
        return {"ok": True, "result": {
            "getMe": {"id": 7},
            "getUserProfilePhotos": {"total_count": 1},        # already has one
            "getMyDescription": {"description": "hand-written"},
            "getMyShortDescription": {"short_description": ""},  # the only blank
        }.get(method, {})}

    monkeypatch.setattr(onboard, "_call", fake_call)
    monkeypatch.setattr(onboard, "set_avatar", lambda t: pytest.fail("clobbered"))
    assert onboard.ensure_profile("tok", log=lambda m: None) == ["short_description"]
    assert "setMyDescription" not in calls and "setMyShortDescription" in calls


def test_bundled_avatar_is_a_jpeg():
    with open(onboard.AVATAR, "rb") as f:
        assert f.read(3) == b"\xff\xd8\xff"  # what setMyProfilePhoto requires


if __name__ == "__main__":
    import subprocess
    raise SystemExit(subprocess.call(["pytest", "-q", os.path.abspath(__file__)]))
