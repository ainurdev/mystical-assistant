"""telegram: stdlib HTTP client behaviours the `requests` version gave us for
free. Run: python tests/test_telegram.py"""
import io
import json
import os
import urllib.error

import pytest

from bridge import telegram


class _Resp(io.BytesIO):
    def __enter__(self): return self
    def __exit__(self, *a): return False


def _fake_urlopen(captured, body=b'{"ok": true, "result": "yes"}'):
    def opener(req, timeout=None):
        captured["req"] = req
        return _Resp(body)
    return opener


def test_none_params_are_dropped(monkeypatch):
    """requests omitted None values; urlencode would post the string 'None'."""
    cap = {}
    monkeypatch.setattr(telegram, "urlopen", _fake_urlopen(cap))
    telegram.edit(1, 2, "hi", reply_markup=None)
    assert b"reply_markup" not in cap["req"].data
    assert b"text=hi" in cap["req"].data


def test_error_body_is_parsed_not_raised(monkeypatch):
    """Telegram reports failures in a 4xx JSON body — tg() must read it, not blow up."""
    err = urllib.error.HTTPError(
        "u", 400, "Bad Request", {},
        io.BytesIO(json.dumps({"ok": False, "description": "nope"}).encode()))

    def boom(req, timeout=None):
        raise err
    monkeypatch.setattr(telegram, "urlopen", boom)
    assert telegram.tg("sendMessage", chat_id=1) is None


@pytest.mark.parametrize("exc", [
    TimeoutError(),                                    # raised bare while reading
    urllib.error.URLError(TimeoutError()),             # wrapped while connecting
])
def test_long_poll_timeout_is_silent(monkeypatch, exc):
    """An idle long-poll is normal: return [] fast, don't log-and-sleep."""
    def boom(req, timeout=None):
        raise exc
    monkeypatch.setattr(telegram, "urlopen", boom)
    monkeypatch.setattr(telegram.time, "sleep", lambda s: pytest.fail("slept on a normal timeout"))
    assert telegram.get_updates(0) == []


def test_real_network_error_backs_off(monkeypatch):
    def boom(req, timeout=None):
        raise urllib.error.URLError("dns is down")
    slept = []
    monkeypatch.setattr(telegram, "urlopen", boom)
    monkeypatch.setattr(telegram.time, "sleep", slept.append)
    assert telegram.get_updates(0) == []
    assert slept == [3]


if __name__ == "__main__":
    import subprocess
    raise SystemExit(subprocess.call(["pytest", "-q", os.path.abspath(__file__)]))
