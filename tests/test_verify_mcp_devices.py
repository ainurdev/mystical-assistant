"""verify_mcp's device-run tools: ListDevices, RunOnDevice and CancelDeviceRun
post to the dashboard's /local/device-runs/*, which holds the Rivendell token and
the session's checkout (bridge/device_ask.py), and hand its text back as one block.

Nothing here reaches the network or a process: urlopen and subprocess refuse by
default, and each test that posts hands in its own urlopen.
Run: python -m pytest tests/test_verify_mcp_devices.py -v
"""

import json
import subprocess
import urllib.request

import pytest

from bridge import verify_mcp

LIST = ('List the shared devices (Macs for now) your team can run a test on, with which are free. '
        'Before RunOnDevice, call this and ask the user which device with AskUserQuestion: '
        '"First free device (Recommended)" first, then each free device, then the busy ones, with the '
        'description from this list; devices that are off are not options. With none on, offer '
        '"Queue it for the next device (Recommended)" and "Don\'t send it".')
RUN = ("Send a test to a shared device: it builds and runs this checkout's app in the iOS Simulator as "
       "an isolated user, under your own Claude account, and posts the report and screenshots on the "
       "task, the PR and back in this chat. Needs a task key (like NR-31) or a pull request; ask the user "
       "when they named neither.")
CANCEL = "Stop a device run you sent. Without an id, stops the newest one this chat sent."


@pytest.fixture(autouse=True)
def nothing_real(monkeypatch):
    """No test here may reach the network or start a process unless it hands in its own fake."""
    reached = []

    def refuse(*a, **kw):
        reached.append(a)
        raise AssertionError("reached without a fake: %r" % (a,))
    monkeypatch.setattr(urllib.request, "urlopen", refuse)
    monkeypatch.setattr(subprocess, "run", refuse)
    monkeypatch.setattr(subprocess, "Popen", refuse)
    yield
    assert not reached, "reached without a fake: %r" % reached


class _Resp:
    def __init__(self, payload):
        self._b = json.dumps(payload).encode()

    def read(self, *a):
        return self._b

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


@pytest.fixture
def dash(monkeypatch):
    """The environment a run hands the MCP, and the dashboard answering `answer`."""
    monkeypatch.setenv("MYSTICAL_DASH", "http://127.0.0.1:8790")
    monkeypatch.setenv("MYSTICAL_DASH_TOKEN", "sekrit")
    monkeypatch.setenv("MYSTICAL_CLAUDE_SESSION_ID", "csid-1")
    seen = {"answer": {"text": "ok"}}

    def urlopen(req, timeout=None):
        seen.update(url=req.full_url, method=req.get_method(), token=req.get_header("X-dash-token"),
                    body=json.loads(req.data))
        return _Resp(seen["answer"])
    monkeypatch.setattr(urllib.request, "urlopen", urlopen)
    return seen


def test_the_device_tools_are_listed_with_what_claude_must_do():
    out = verify_mcp._handle({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})
    tools = {t["name"]: t for t in out["result"]["tools"]}
    assert tools["ListDevices"]["description"] == LIST
    assert tools["RunOnDevice"]["description"] == RUN
    assert tools["CancelDeviceRun"]["description"] == CANCEL
    run = tools["RunOnDevice"]["inputSchema"]
    assert run["required"] == ["request"]
    assert set(run["properties"]) == {"request", "task", "pullRequest", "device", "folder"}
    assert all(p["type"] == "string" for p in run["properties"].values())
    assert set(tools["CancelDeviceRun"]["inputSchema"]["properties"]) == {"run"}


def test_run_on_device_posts_start_with_the_session_from_the_environment(dash):
    dash["answer"] = {"text": "Sent to Mahziyar's MacBook Pro.\nid: r1"}
    out = verify_mcp._call("RunOnDevice", {"request": "Test the lesson planner", "task": "NR-31",
                                           "claude_session_id": "another chat's"})
    assert out == [{"type": "text", "text": "Sent to Mahziyar's MacBook Pro.\nid: r1"}]
    assert dash["url"] == "http://127.0.0.1:8790/local/device-runs/start"
    assert dash["method"] == "POST" and dash["token"] == "sekrit"
    assert dash["body"] == {"claude_session_id": "csid-1", "request": "Test the lesson planner",
                            "task": "NR-31"}, "the session is the run's own, whatever the arguments say"


@pytest.mark.parametrize("tool, route, args", [("ListDevices", "list", {}),
                                                ("CancelDeviceRun", "cancel", {"run": "r1"})])
def test_the_other_device_tools_post_their_own_routes(dash, tool, route, args):
    assert verify_mcp._call(tool, args) == [{"type": "text", "text": "ok"}]
    assert dash["url"] == "http://127.0.0.1:8790/local/device-runs/" + route
    assert dash["body"] == {"claude_session_id": "csid-1", **args}


def test_without_a_dashboard_the_device_tools_say_so(monkeypatch):
    monkeypatch.delenv("MYSTICAL_DASH", raising=False)
    (block,) = verify_mcp._call("RunOnDevice", {"request": "Test it", "task": "NR-31"})
    assert block["type"] == "text" and "dashboard is not running" in block["text"]
