"""plugins: shelling out to `claude plugin`, with the CLI stubbed."""

import pytest

from bridge import plugins

LIST_JSON = {
    "installed": [
        {"id": "a@mkt", "version": "1.0.0", "scope": "user", "enabled": True,
         "mcpServers": {"z": {}, "y": {}}},
        {"id": "b@mkt", "version": "2.0.0", "scope": "project", "enabled": False},
        {"version": "3.0.0"},  # no id — dropped
    ],
    "available": [
        {"pluginId": "c@mkt", "name": "c", "description": "d", "marketplaceName": "mkt"},
        {"name": "no id"},  # dropped
    ],
}
MKT_JSON = [{"name": "mkt", "source": "github", "repo": "o/r"}]


@pytest.fixture
def cli(monkeypatch):
    """Record argv; reply per subcommand. Nothing reaches the real CLI."""
    calls = []

    def fake(*args):
        calls.append(args)
        if args[:1] == ("marketplace",) and args[1:2] == ("list",):
            return 0, __import__("json").dumps(MKT_JSON), ""
        if args[:1] == ("list",):
            return 0, __import__("json").dumps(LIST_JSON), ""
        return calls_rc[0], "", calls_err[0]

    calls_rc, calls_err = [0], [""]
    monkeypatch.setattr(plugins, "_run", fake)
    return calls, calls_rc, calls_err


def test_listing_flattens_both_calls(cli):
    calls, _, _ = cli
    got = plugins.listing()
    assert got["marketplaces"] == MKT_JSON
    assert got["installed"] == [
        {"id": "a@mkt", "version": "1.0.0", "scope": "user", "enabled": True, "mcp": ["y", "z"]},
        {"id": "b@mkt", "version": "2.0.0", "scope": "project", "enabled": False, "mcp": []},
    ]
    assert got["available"] == [
        {"id": "c@mkt", "name": "c", "description": "d", "marketplace": "mkt"}]
    assert ("list", "--available", "--json") in calls


def test_listing_survives_a_broken_cli(monkeypatch):
    monkeypatch.setattr(plugins, "_run", lambda *a: (127, "", "claude not found on PATH"))
    assert plugins.listing() == {"marketplaces": [], "installed": [], "available": []}


def test_mutations_pass_through_and_report_stderr(cli):
    calls, rc, err = cli
    assert plugins.install("c@mkt", "project") == (True, "")
    assert calls[-1] == ("install", "c@mkt", "--scope", "project")
    assert plugins.add_marketplace("o/r") == (True, "")
    assert calls[-1] == ("marketplace", "add", "o/r")
    assert plugins.set_enabled("a@mkt", False) == (True, "")
    assert calls[-1] == ("disable", "a@mkt")

    rc[0], err[0] = 1, "boom\nlast line wins"
    assert plugins.uninstall("a@mkt") == (False, "last line wins")


@pytest.mark.parametrize("bad", ["", "  ", "--scope", "-x", "x" * 201])
def test_argv_injection_is_refused(cli, bad):
    calls, _, _ = cli
    for ok, msg in (plugins.install(bad), plugins.add_marketplace(bad),
                    plugins.uninstall(bad), plugins.set_enabled(bad, True)):
        assert (ok, msg.startswith("invalid")) == (False, True)
    assert calls == []  # nothing reached the CLI


def test_scope_is_validated(cli):
    calls, _, _ = cli
    assert plugins.install("c@mkt", "everywhere") == (False, "invalid scope")
    assert calls == []
