"""onboard: chat-id polling + .env writer. Run: python tests/test_onboard.py"""
import os

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


if __name__ == "__main__":
    import subprocess
    raise SystemExit(subprocess.call(["pytest", "-q", os.path.abspath(__file__)]))
