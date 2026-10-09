"""`watched` on /local/running: true while a dashboard page that raises its own
OS alerts has polled within the last 90 s. The tray companions (windows/,
linux/) read it to stay quiet instead of alerting twice.
Run: python3 -m pytest tests/test_running_watched.py -q"""

import time

import pytest

from bridge.dashboard import server as dash


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    monkeypatch.setattr(dash, "_alerts_at", float("-inf"))
    monkeypatch.setattr(dash.runner, "running_snapshot",
                        lambda chat: {"status": {}, "jobs": []})


def _poll(qs):
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    h._get_api("/local/running", qs)
    return box["obj"]


def test_nobody_is_watching_until_an_alerting_page_polls():
    assert _poll({})["watched"] is False


def test_an_alerting_page_marks_it_watched_and_plain_polls_do_not():
    assert _poll({"alerts": ["1"]})["watched"] is True
    # The trays poll without the flag: they read the mark, they never refresh it.
    assert _poll({})["watched"] is True
    assert _poll({"alerts": ["0"]})["watched"] is True


def test_the_mark_lapses_once_the_page_stops_polling(monkeypatch):
    monkeypatch.setattr(dash, "_alerts_at", time.monotonic() - dash._WATCH_S - 1)
    assert _poll({})["watched"] is False


def test_the_snapshot_itself_passes_through():
    assert _poll({})["jobs"] == []
