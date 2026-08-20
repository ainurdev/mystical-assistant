"""mcp: shelling out to `claude mcp`, with the CLI stubbed.

The pty-backed login is exercised against a stand-in script rather than the real
CLI -- what matters is that the flow survives a terminal (the real one refuses a
pipe outright) and that a doubled OSC-8 hyperlink comes back as one URL.
"""

import sys
import textwrap

import pytest

from bridge import mcp, toolsets

SAMPLE = [{"name": "attio", "rule": "mcp__attio"},
          {"name": "plugin:cf:obs", "rule": "mcp__plugin_cf_obs"}]


@pytest.fixture
def cli(monkeypatch):
    """Record argv; the CLI always succeeds unless a test says otherwise."""
    calls, rc, err = [], [0], [""]

    def fake(*args):
        calls.append(args)
        return rc[0], "", err[0]

    monkeypatch.setattr(mcp, "_run", fake)
    monkeypatch.setattr(toolsets, "invalidate", lambda: calls.append(("invalidated",)))
    return calls, rc, err


def test_http_server_add_passes_transport_and_scope(cli):
    calls, _, _ = cli
    assert mcp.add("attio", "https://mcp.attio.com/mcp", "http", "user") == (True, "")
    assert calls[0] == ("add", "--transport", "http", "--scope", "user",
                        "attio", "https://mcp.attio.com/mcp")
    assert ("invalidated",) in calls          # the cached list is now wrong


def test_stdio_server_add_splits_the_command_after_a_dash_dash(cli):
    calls, _, _ = cli
    assert mcp.add("pw", "npx -y @playwright/mcp@latest", "stdio", "local")[0]
    assert calls[0] == ("add", "--scope", "local", "pw",
                        "--", "npx", "-y", "@playwright/mcp@latest")


def test_bad_input_never_reaches_the_cli(cli):
    calls, _, _ = cli
    # A leading dash is the one thing argv can misread as a flag; a URL is
    # required for http, and quotes have to balance for a stdio command.
    assert mcp.add("-rf", "https://x.dev/mcp")[0] is False
    assert mcp.add("a b", "https://x.dev/mcp")[0] is False
    assert mcp.add("ok", "mcp.attio.com", "http")[0] is False
    assert mcp.add("ok", "https://x.dev/mcp", "carrier-pigeon")[0] is False
    assert mcp.add("ok", "https://x.dev/mcp", "http", "everywhere")[0] is False
    assert mcp.add("ok", 'npx "unbalanced', "stdio")[0] is False
    assert mcp.remove("--scope")[0] is False
    assert calls == []


def test_a_failure_returns_the_clis_own_last_line(cli):
    calls, rc, err = cli
    rc[0], err[0] = 1, "boom\nNo MCP server found with name: nope"
    ok, msg = mcp.remove("nope")
    assert not ok and msg == "No MCP server found with name: nope"
    assert ("invalidated",) not in calls      # nothing changed, cache still good


def test_logout_clears_credentials_by_name(cli):
    calls, _, _ = cli
    assert mcp.logout("attio") == (True, "")
    assert calls[0] == ("logout", "attio")


# ---- the pty-backed login ---------------------------------------------------

def _stub(tmp_path, body: str) -> str:
    """A fake `claude` that plays the login half of the real CLI."""
    p = tmp_path / "fake-claude"
    p.write_text("#!/usr/bin/env python3\n" + textwrap.dedent(body))
    p.chmod(0o755)
    return str(p)


LOGIN_STUB = """
    import os, sys
    # Refuse a pipe, exactly as the real CLI does — this is what forces the pty.
    if not os.isatty(0):
        print("stdin isn't a terminal, so authentication can't be completed here.")
        sys.exit(1)
    url = "https://auth.example.com/authorize?state=abc"
    # An OSC-8 hyperlink whose plain-text half arrives doubled.
    sys.stdout.write("Visit this URL to authorize:\\n  \\x1b]8;;%s\\x1b\\\\%s%s\\x1b]8;;\\x1b\\\\\\n" % (url, url, url))
    sys.stdout.write("Or paste the redirect URL here: ")
    sys.stdout.flush()
    line = sys.stdin.readline().strip()
    if "code=" in line:
        sys.exit(0)
    print("Couldn't complete authentication for \\"x\\": no code")
    sys.exit(0)
"""


@pytest.fixture
def stub_login(monkeypatch, tmp_path):
    """Real pty plumbing, our stub script in place of `claude mcp login`."""
    script = _stub(tmp_path, LOGIN_STUB)
    real = mcp.subprocess.Popen
    monkeypatch.setattr(mcp.subprocess, "Popen",
                        lambda argv, **kw: real([sys.executable, script], **kw))
    monkeypatch.setattr(toolsets, "servers", lambda refresh=False: SAMPLE)
    monkeypatch.setattr(toolsets, "invalidate", lambda: None)
    yield
    mcp.cancel_login()


def test_login_returns_one_url_from_a_doubled_hyperlink(stub_login):
    got = mcp.begin_login("attio", timeout=10)
    assert got == {"name": "attio", "url": "https://auth.example.com/authorize?state=abc"}
    assert mcp.pending()["name"] == "attio"


def test_a_pasted_redirect_url_completes_the_login(stub_login):
    mcp.begin_login("attio", timeout=10)
    assert mcp.submit_login("https://localhost:3118/callback?code=xyz&state=abc") == (True, "")
    assert mcp.pending() is None              # cleared once it finished


def test_a_redirect_url_without_a_code_reports_the_clis_complaint(stub_login):
    mcp.begin_login("attio", timeout=10)
    ok, err = mcp.submit_login("https://localhost:3118/callback?state=abc")
    assert not ok and "Couldn't complete authentication" in err


def test_nonsense_in_the_paste_box_never_reaches_the_cli(stub_login):
    mcp.begin_login("attio", timeout=10)
    ok, err = mcp.submit_login("xyz")
    assert not ok and "redirect URL" in err
    assert mcp.pending() is not None          # still waiting, not torn down


def test_login_refuses_a_server_that_isnt_configured(stub_login):
    assert mcp.begin_login("nope")["error"] == "no such server"


def test_only_one_login_is_ever_in_flight(stub_login):
    mcp.begin_login("attio", timeout=10)
    first = mcp._login
    mcp.begin_login("plugin:cf:obs", timeout=10)
    assert mcp._login is not first
    assert first.proc.poll() is not None       # the abandoned one was killed
    assert mcp.pending()["name"] == "plugin:cf:obs"


def test_the_parsed_list_says_what_each_server_connects_to():
    row = toolsets._parse("attio: https://mcp.attio.com/mcp (HTTP) - ✔ Connected")[0]
    assert row["target"] == "https://mcp.attio.com/mcp (HTTP)"
