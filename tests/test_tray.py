"""The tray companion's logic (linux/tray.py) and the seams between the trays
and bridge/startup.py, which writes their login entries. The GTK half runs in
a Linux desktop container instead (the plan's Task 8); windows/tray.ps1's pure
half is asserted by windows/tray.check.ps1 under pwsh.
Run: python3 -m pytest tests/test_tray.py -q"""

import importlib.util
import os

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "linux_tray", os.path.join(_ROOT, "linux", "tray.py"))
tray = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tray)


def _run(status, jobs=(), watched=False):
    return {"status": status, "jobs": list(jobs), "watched": watched}


def test_the_first_poll_is_a_baseline():
    assert tray.alerts(None, {"a": {"state": "awaiting", "label": "Which DB?"}}, {}) == []


def test_a_session_that_starts_waiting_alerts_once():
    prev = {"a": {"state": "working", "label": "running Bash"}}
    cur = {"a": {"state": "awaiting", "label": "Which DB?"}}
    assert tray.alerts(prev, cur, {"a": "fix login"}) == [
        {"id": "a", "title": "⏸ fix login", "body": "Which DB?"}]
    assert tray.alerts(cur, cur, {"a": "fix login"}) == []      # still waiting: not news


def test_parked_on_a_limit_alerts():
    cur = {"a": {"state": "parked", "label": "usage limit — resuming ~14:00"}}
    assert tray.alerts({}, cur, {"a": "x"}) == [
        {"id": "a", "title": "⏳ x", "body": "usage limit — resuming ~14:00"}]


def test_a_working_session_that_leaves_is_done():
    prev = {"a": {"state": "working", "label": "running Bash"}}
    assert tray.alerts(prev, {}, {"a": "fix login"}) == [
        {"id": "a", "title": "✓ fix login", "body": "finished"}]
    # No title known: "session", never the activity label.
    assert tray.alerts(prev, {}, {})[0]["title"] == "✓ session"


def test_working_into_awaiting_or_parked_is_not_done():
    prev = {"a": {"state": "working"}, "b": {"state": "working"}}
    cur = {"a": {"state": "awaiting"}, "b": {"state": "parked"}}
    assert sorted(n["title"][0] for n in tray.alerts(prev, cur, {})) == ["⏳", "⏸"]


def test_titles_outlive_the_job_that_carried_them():
    titles = {}
    _, prev, _ = tray.step(None, _run({"a": {"state": "working"}},
                                      [{"session_id": "a", "title": "fix login"}]), titles)
    news, _, rows = tray.step(
        prev, _run({"a": {"state": "awaiting", "label": "Which DB?"}}), titles)
    assert news[0]["title"] == "⏸ fix login"
    assert rows == [("a", "fix login")]


def test_waiting_rows_fall_back_to_the_label_and_sort_by_title():
    status = {"b": {"state": "awaiting", "label": "Zed?"}, "a": {"state": "awaiting"},
              "c": {"state": "working"}}
    assert tray.waiting(status, {"b": "alpha"}) == [("b", "alpha"), ("a", "waiting on you")]


def test_watched_moves_state_on_without_alerting():
    titles = {}
    _, prev, _ = tray.step(None, _run({"a": {"state": "working"}}), titles)
    news, prev, _ = tray.step(prev, _run({"a": {"state": "awaiting"}}, watched=True), titles)
    assert news == []
    # The window closes: the question it already rang for must not ring again.
    news, _, _ = tray.step(prev, _run({"a": {"state": "awaiting"}}), titles)
    assert news == []


def test_a_bridge_that_comes_back_starts_a_fresh_baseline():
    titles = {}
    _, prev, _ = tray.step(None, _run({"a": {"state": "working"}}), titles)
    assert tray.step(prev, None, titles) == ([], None, [])               # down
    news, _, _ = tray.step(None, _run({"a": {"state": "awaiting"}}), titles)  # back up
    assert news == []


def test_session_url_carries_the_token_only_when_there_is_one():
    assert tray.session_url(8790, "/?token=abc", "s 1") == \
        "http://localhost:8790/?token=abc&s=s%201&skipboot"
    assert tray.session_url(8790, "/", "s1") == "http://localhost:8790/?s=s1&skipboot"
    assert tray.session_url(8790, None) == "http://localhost:8790/"      # manifest unreachable
    assert tray.session_url(8790, "/?token=abc") == "http://localhost:8790/?token=abc"


def test_a_second_tray_backs_off(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path))
    first = tray.single_instance()
    assert first is not None
    assert tray.single_instance() is None
    first.close()
    again = tray.single_instance()
    assert again is not None
    again.close()


def test_missing_bindings_name_the_packages(monkeypatch):
    def gone():
        raise ImportError("No module named 'gi'")
    monkeypatch.setattr(tray, "bindings", gone)
    why = tray.missing()
    assert "gir1.2-ayatanaappindicator3-0.1" in why and "libayatana-appindicator-gtk3" in why


def test_check_exits_1_and_names_the_packages(monkeypatch, capsys):
    def gone():
        raise ValueError("Namespace AyatanaAppIndicator3 not available")
    monkeypatch.setattr(tray, "bindings", gone)
    assert tray.main(["--check"]) == 1
    assert "gir1.2-notify-0.7" in capsys.readouterr().err
