"""acp_setup: the boot fetch of pinned agent CLIs, and a device-code login run
from Settings (the URL and code relayed, no browser opened here, a TEST after)."""
import json
import os
import sys
import time

import pytest

from bridge import acp_agents, acp_setup

# Prints what Kimi Code's `login` prints (to stderr), then exits with FAKE_RC once
# FAKE_GO exists (or at once without one). Records its env for the assertions.
FAKE_LOGIN = r"""
import json, os, shutil, sys, time
with open(os.environ["FAKE_ENV_OUT"], "w") as f:
    json.dump({"PATH": os.environ["PATH"], "BROWSER": os.environ.get("BROWSER"),
               "xdg": shutil.which("xdg-open"), "home": os.environ.get("KIMI_CODE_HOME")}, f)
sys.stderr.write("\nOpening browser for Kimi device login: https://www.kimi.com/code/authorize_device?user_code=ABCD-1234\n"
                 "If the browser did not open, paste the URL above and enter code: ABCD-1234\n"
                 "Waiting for authorization to complete…\n")
sys.stderr.flush()
go = os.environ.get("FAKE_GO")
while go and not os.path.exists(go):
    time.sleep(0.05)
if os.environ.get("FAKE_RC", "0") != "0":
    sys.stderr.write("Login failed: device code expired\n")
sys.exit(int(os.environ.get("FAKE_RC", "0")))
"""


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(acp_agents, "ACCOUNTS_FILE", str(tmp_path / "agent-accounts.json"))
    monkeypatch.setattr(acp_agents, "OPTIONS_FILE", str(tmp_path / "acp-options.json"))
    monkeypatch.setattr(acp_agents, "HOMES", str(tmp_path / "agent-homes"))
    monkeypatch.setattr(acp_agents, "_options", {})
    monkeypatch.setattr(acp_setup, "NOOPEN", str(tmp_path / "noopen"))
    monkeypatch.setattr(acp_setup, "_logins", {})
    monkeypatch.setattr(acp_setup, "_fetch", {})
    script = tmp_path / "fake_login.py"
    script.write_text(FAKE_LOGIN)
    kimi = dict(acp_agents.preset("kimi"), login_cmd=[sys.executable, str(script)])
    monkeypatch.setattr(acp_agents, "PRESETS",
                        tuple(kimi if p["id"] == "kimi" else p for p in acp_agents.PRESETS))
    monkeypatch.setenv("FAKE_ENV_OUT", str(tmp_path / "env.json"))
    # env_for's allow-list (rule 3) would strip the fake's own knobs.
    monkeypatch.setattr(acp_agents, "_ALLOW", acp_agents._ALLOW | {"FAKE_ENV_OUT", "FAKE_GO", "FAKE_RC"})
    tested = []
    monkeypatch.setattr(acp_agents, "api_test", lambda body: (
        tested.append(body) or ({"ok": True, "options": {"model": [{"value": "k3"}, {"value": "k3.1"}]}}, 200)))
    return tested


def _until(cond, t=10):
    end = time.time() + t
    while time.time() < end:
        if cond():
            return True
        time.sleep(0.05)
    return False


def test_a_login_relays_url_and_code_then_tests_the_account(isolated, tmp_path, monkeypatch):
    go = tmp_path / "go"
    monkeypatch.setenv("FAKE_GO", str(go))
    a = acp_agents.add_account("kimi", "work", "home")
    res, code = acp_setup.api_login({"action": "start", "agent": "kimi", "account": a["id"]})
    assert code == 200
    assert _until(lambda: acp_setup.status("kimi", a["id"])["state"] == "waiting")
    st = acp_setup.status("kimi", a["id"])
    assert st["url"] == "https://www.kimi.com/code/authorize_device?user_code=ABCD-1234"
    assert st["code"] == "ABCD-1234"
    # Starting again while it waits is the same login, not a second CLI.
    assert acp_setup.start("kimi", a["id"])["state"] == "waiting"
    go.write_text("")
    assert _until(lambda: acp_setup.status("kimi", a["id"])["state"] == "ok")
    assert acp_setup.status("kimi", a["id"])["models"] == 2
    assert isolated == [{"agent": "kimi", "account": a["id"]}]
    env = json.loads((tmp_path / "env.json").read_text())
    assert env["home"] == acp_agents.home_dir(a["id"])
    # No browser pops up on this machine: xdg-open is the no-op stub.
    assert env["BROWSER"] == "true" and env["xdg"] == os.path.join(acp_setup.NOOPEN, "xdg-open")


def test_a_failed_login_reports_the_clis_last_lines(isolated, monkeypatch):
    monkeypatch.setenv("FAKE_RC", "1")
    acp_setup.start("kimi", "")
    assert _until(lambda: acp_setup.status("kimi", "")["state"] == "error")
    assert "device code expired" in acp_setup.status("kimi", "")["error"]
    assert isolated == []


def test_cancel_stops_a_waiting_login(isolated, tmp_path, monkeypatch):
    monkeypatch.setenv("FAKE_GO", str(tmp_path / "never"))
    acp_setup.start("kimi", "")
    assert _until(lambda: acp_setup.status("kimi", "")["state"] == "waiting")
    assert acp_setup.cancel("kimi", "")["state"] == "cancelled"
    assert _until(lambda: acp_setup.status("kimi", "")["state"] == "cancelled")
    assert isolated == []


def test_logins_are_refused_where_there_is_nothing_to_sign_in():
    key = acp_agents.add_account("codex", "k", "key", key="sk-abcdefghijklmnop")
    for body in ({"agent": "codex", "account": key["id"]},     # an API key account
                 {"agent": "kimi", "account": key["id"]},      # someone else's account
                 {"agent": "kimi", "account": "a_nope"},
                 {"agent": "gemini", "account": ""},           # no login_cmd
                 {"agent": "nope", "account": ""}):
        res, code = acp_setup.api_login({"action": "start", **body})
        assert code == 400 and res["error"], body
    assert acp_setup.api_login({"action": "status", "agent": "kimi", "account": ""})[0] == {"state": "idle"}
    assert acp_setup.api_login({"action": "frob"})[1] == 400


def test_warm_fetches_pinned_presets_and_reports_failures(monkeypatch):
    def presets(code):
        return tuple(dict(p, warm=[sys.executable, "-c", f"import sys; print('npm ERR! 404'); sys.exit({code})"])
                     if p["id"] == "kimi" else p for p in acp_agents.PRESETS)
    monkeypatch.setattr(acp_agents, "PRESETS", presets(0))
    acp_setup.warm()
    assert _until(lambda: (acp_setup.fetch_state("kimi") or {}).get("state") == "ok")
    monkeypatch.setattr(acp_agents, "PRESETS", presets(3))
    acp_setup.warm()
    assert _until(lambda: (acp_setup.fetch_state("kimi") or {}).get("state") == "error")
    assert "404" in acp_setup.fetch_state("kimi")["error"]
    assert acp_setup.fetch_state("codex") is None      # nothing pinned to fetch


def test_the_listing_says_who_can_sign_in_and_hides_the_commands():
    rows = {p["id"]: p for p in acp_agents.available()}
    assert rows["kimi"]["can_login"] and not rows["codex"]["can_login"]
    assert all("login_cmd" not in p and "warm" not in p and "env" not in p for p in rows.values())
