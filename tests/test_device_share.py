"""What this device is (bridge/device_share.py): the facts a shared device tells
Rivendell in the websocket handshake, and whether it is ready to say so.

Every parser is a pure function and is fed output captured from a real Mac
(2026-10-16, MacBook Pro, Xcode 27.0): the simctl and ioreg captures are in
tests/fixtures/device/ (the ioreg UUID and serial numbers are fake; the simctl
device-type list is cut to two entries). No test touches the real machine: the
probes run through a fake `subprocess.run`, the platform is stubbed to Darwin.
Run: python -m pytest tests/test_device_share.py -v
"""

import base64
import hashlib
import json
import os
import subprocess
import types

import pytest

from bridge import device_share as ds

_FIX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "fixtures", "device")


def _fixture(name):
    with open(os.path.join(_FIX, name), encoding="utf-8") as f:
        return f.read()


DEV = "/Applications/Xcode.app/Contents/Developer"
XCODEBUILD = "Xcode 27.0\nBuild version 27A266a\n"
SIMCTL = _fixture("simctl-runtimes.json")
IOREG = _fixture("ioreg-platform-expert.txt")
UUID = "5E6D4C3B-1A2F-4E8D-9B7C-0F1E2D3C4B5A"        # the fake one in the ioreg fixture
ID = "7c50be1739dfacbb"                              # sha256(UUID)[:16], pinned on purpose

# What each binary says on this Mac. A str is stdout with exit 0, a (rc, str) a
# failure, an exception is raised the way subprocess raises it.
MAC = {
    "xcode-select": DEV + "\n",
    "sw_vers": "27.0.1\n",
    "sysctl": "Apple M5 Pro\n",
    "scutil": "Mahziyar’s MacBook Pro\n",
    "ioreg": IOREG,
    "xcodebuild": XCODEBUILD,
    "xcrun": SIMCTL,
    "node": "v26.11.0\n",
    "pod": "1.17.0\n",
    "dscl": "",
}

FACTS = {"id": ID, "name": "Mahziyar’s MacBook Pro", "os": "macOS", "osVersion": "27.0.1",
         "chip": "M5 Pro", "xcode": "27.0", "iosRuntimes": ["27.0"], "node": "26", "pods": "1.17.0"}
SET_UP = {"user": True, "helper": True, "claude": True}


def fake_run(answers=None):
    """A stand-in for subprocess.run that answers from MAC (plus `answers`) and
    records every call as (cmd, kwargs). A binary missing from the table is a
    KeyError, so a test notices a command it did not expect."""
    table = {**MAC, **(answers or {})}
    calls = []

    def run(cmd, **kw):
        calls.append((cmd, kw))
        a = table[cmd[0]]
        if isinstance(a, BaseException):
            raise a
        rc, out = a if isinstance(a, tuple) else (0, a)
        return subprocess.CompletedProcess(cmd, rc, out, "")

    run.calls = calls
    return run


def _platform(monkeypatch, system="Darwin", node="box.local"):
    monkeypatch.setattr(ds, "platform", types.SimpleNamespace(system=lambda: system, node=lambda: node))


@pytest.fixture(autouse=True)
def mac(monkeypatch):
    """A Mac, and no facts cached from another test."""
    _platform(monkeypatch)
    ds.refresh()
    yield
    ds.refresh()


# --- the parsers, on captured output ---------------------------------------------

def test_xcode_is_the_first_line_of_xcodebuild_version():
    assert ds.parse_xcode(XCODEBUILD) == "27.0"
    assert ds.parse_xcode("Xcode 15.4\nBuild version 15F31d\n") == "15.4"
    assert ds.parse_xcode("xcode-select: error: tool 'xcodebuild' requires Xcode") is None
    assert ds.parse_xcode("") is None and ds.parse_xcode(None) is None


def test_ios_runtimes_are_the_available_ios_ones():
    assert ds.parse_ios_runtimes(SIMCTL) == ["27.0"]

    # The real capture plus what other Macs also list: runtimes of other
    # platforms, an iOS runtime that is not available, and two older available ones.
    d = json.loads(SIMCTL)
    real = d["runtimes"][0]
    more = [dict(real, version=v, platform=p, isAvailable=ok)
            for v, p, ok in (("9.3", "iOS", True), ("26.4", "iOS", True), ("18.0", "iOS", False),
                             ("12.0", "watchOS", True), ("27.0", "tvOS", True), ("2.5", "xrOS", True))]
    d["runtimes"] += more
    # Newest first, numerically (9.3 is older than 26.4): Rivendell keeps the first ten.
    assert ds.parse_ios_runtimes(json.dumps(d)) == ["27.0", "26.4", "9.3"]


@pytest.mark.parametrize("out", [None, "", "not json", "[]", '{"runtimes": null}', '{"runtimes": [1, "x"]}',
                                 '{"runtimes": [{"platform": "iOS", "isAvailable": true}]}'])
def test_ios_runtimes_of_nothing_useful_is_empty(out):
    assert ds.parse_ios_runtimes(out) == []


def test_node_is_the_major_version():
    assert ds.parse_node("v26.11.0\n") == "26"
    assert ds.parse_node("v8.17.0") == "8"
    assert ds.parse_node("") is None and ds.parse_node(None) is None and ds.parse_node("node: not found") is None


def test_chip_drops_the_apple():
    assert ds.parse_chip("Apple M5 Pro\n") == "M5 Pro"
    assert ds.parse_chip("Apple M1") == "M1"
    assert ds.parse_chip("Intel(R) Core(TM) i9-9980HK CPU @ 2.40GHz\n") == "Intel(R) Core(TM) i9-9980HK CPU @ 2.40GHz"
    assert ds.parse_chip("") is None and ds.parse_chip(None) is None


def test_the_platform_uuid_is_read_out_of_ioreg():
    assert ds.parse_uuid(IOREG) == UUID
    assert ds.parse_uuid("no such class") is None and ds.parse_uuid(None) is None


def test_plain_one_line_facts_are_stripped():
    assert ds.parse_text("1.17.0\n") == "1.17.0"
    assert ds.parse_text("27.0.1\n") == "27.0.1"
    assert ds.parse_text("Mahziyar’s MacBook Pro\n") == "Mahziyar’s MacBook Pro"
    assert ds.parse_text("  \n") is None and ds.parse_text(None) is None


# --- developer_dir ----------------------------------------------------------------

def test_the_active_xcode_is_the_developer_dir():
    run = fake_run({"xcode-select": "/Applications/Xcode-beta.app/Contents/Developer\n"})
    assert ds.developer_dir(run) == "/Applications/Xcode-beta.app/Contents/Developer"


def test_command_line_tools_hand_over_to_the_xcode_app(monkeypatch, tmp_path):
    """This Mac: xcode-select points at CommandLineTools while Xcode.app exists."""
    monkeypatch.setattr(ds, "XCODE_DEV", str(tmp_path))
    run = fake_run({"xcode-select": "/Library/Developer/CommandLineTools\n"})
    assert ds.developer_dir(run) == str(tmp_path)


def test_command_line_tools_alone_are_not_a_developer_dir(monkeypatch, tmp_path):
    monkeypatch.setattr(ds, "XCODE_DEV", str(tmp_path / "no-xcode"))
    assert ds.developer_dir(fake_run({"xcode-select": "/Library/Developer/CommandLineTools\n"})) is None


def test_no_active_developer_dir_still_finds_the_xcode_app(monkeypatch, tmp_path):
    monkeypatch.setattr(ds, "XCODE_DEV", str(tmp_path))
    assert ds.developer_dir(fake_run({"xcode-select": (2, "")})) == str(tmp_path)
    assert ds.developer_dir(fake_run({"xcode-select": FileNotFoundError("xcode-select")})) == str(tmp_path)
    monkeypatch.setattr(ds, "XCODE_DEV", str(tmp_path / "no-xcode"))
    assert ds.developer_dir(fake_run({"xcode-select": (2, "")})) is None


# --- device_facts -----------------------------------------------------------------

def test_the_facts_of_this_mac():
    assert ds.device_facts(fake_run()) == FACTS


def test_the_id_is_the_first_16_hex_of_the_sha256_of_the_platform_uuid():
    f = ds.device_facts(fake_run())
    assert f["id"] == ID == hashlib.sha256(UUID.encode()).hexdigest()[:16]


def test_every_binary_runs_with_the_developer_dir_and_a_10_second_timeout():
    run = fake_run()
    ds.device_facts(run)
    assert {c[0] for c, _ in run.calls} == set(MAC) - {"dscl"}
    assert all(kw["timeout"] == 10 for _, kw in run.calls)
    # Everything but xcode-select, which finds the dir, runs under it.
    assert all(kw["env"]["DEVELOPER_DIR"] == DEV for c, kw in run.calls if c[0] != "xcode-select")


def test_a_missing_binary_is_a_missing_fact_not_an_exception():
    run = fake_run({"node": FileNotFoundError("node"),
                    "pod": subprocess.TimeoutExpired("pod", 10),
                    "sysctl": (1, "")})
    f = ds.device_facts(run)
    assert (f["node"], f["pods"], f["chip"]) == (None, None, None)
    assert f["xcode"] == "27.0" and f["iosRuntimes"] == ["27.0"] and f["id"] == ID


def test_without_xcode_nothing_asks_xcodebuild_or_xcrun(monkeypatch, tmp_path):
    """On a Mac with no developer tools those two are shims that pop up an
    'install the command line tools' dialog, so they are never started blind."""
    monkeypatch.setattr(ds, "XCODE_DEV", str(tmp_path / "no-xcode"))
    run = fake_run({"xcode-select": (2, "")})
    f = ds.device_facts(run)
    assert f["xcode"] is None and f["iosRuntimes"] == []
    assert {c[0] for c, _ in run.calls}.isdisjoint({"xcodebuild", "xcrun"})
    assert f["osVersion"] == "27.0.1", "the rest is still read"


def test_the_name_falls_back_to_the_hostname(monkeypatch):
    _platform(monkeypatch, node="box.local")
    assert ds.device_facts(fake_run({"scutil": (1, "")}))["name"] == "box.local"


def test_off_a_mac_there_are_no_facts(monkeypatch):
    _platform(monkeypatch, system="Linux")
    run = fake_run()
    assert ds.device_facts(run) is None
    assert run.calls == [], "not even a probe"


def test_facts_are_cached_for_five_minutes_and_refresh_drops_them(monkeypatch):
    clock = [1000.0]
    monkeypatch.setattr(ds, "time", types.SimpleNamespace(monotonic=lambda: clock[0]))
    run = fake_run()
    ds.device_facts(run)
    one = len(run.calls)
    clock[0] += 299
    ds.device_facts(run)
    assert len(run.calls) == one, "inside the 300 s: answered from the cache"
    clock[0] += 2
    ds.device_facts(run)
    assert len(run.calls) == 2 * one, "past it: probed again"
    ds.refresh()
    ds.device_facts(run)
    assert len(run.calls) == 3 * one, "refresh() forgets them at once"


# --- setup_state ------------------------------------------------------------------

def test_setup_state_is_the_hidden_user_the_helper_and_claude():
    run = fake_run()
    assert ds.setup_state(exists=lambda p: True, run=run) == SET_UP
    assert run.calls[0][0] == ["dscl", ".", "-read", "/Users/mysticalruns"]


def test_each_part_of_the_setup_is_told_apart():
    helper = "/usr/local/libexec/mystical-run-helper"
    claude = "/Users/mysticalruns/.local/bin/claude"
    assert ds.setup_state(exists=lambda p: True, run=fake_run({"dscl": (56, "")})) == \
        {"user": False, "helper": True, "claude": True}
    assert ds.setup_state(exists=lambda p: p == claude, run=fake_run()) == \
        {"user": True, "helper": False, "claude": True}
    assert ds.setup_state(exists=lambda p: p == helper, run=fake_run()) == \
        {"user": True, "helper": True, "claude": False}
    assert ds.setup_state(exists=lambda p: False, run=fake_run({"dscl": FileNotFoundError("dscl")})) == \
        {"user": False, "helper": False, "claude": False}


# --- share_state ------------------------------------------------------------------

def _device(monkeypatch, facts=FACTS, setup=SET_UP):
    """This device is what the arguments say, whatever machine the test runs on."""
    monkeypatch.setattr(ds, "device_facts", lambda *a, **k: facts)
    monkeypatch.setattr(ds, "setup_state", lambda *a, **k: setup)


def _state(monkeypatch, inst=None, facts=FACTS, setup=SET_UP):
    _device(monkeypatch, facts, setup)
    return ds.share_state({} if inst is None else inst)


def test_a_device_that_has_everything_is_ready(monkeypatch):
    s = _state(monkeypatch)
    assert s["state"] == "READY" and s["facts"] == FACTS
    # The order is the order the panel draws them in.
    assert s["checks"] == [
        {"key": "macos", "label": "MACOS 27.0.1", "ok": True},
        {"key": "xcode", "label": "XCODE 27.0", "ok": True},
        {"key": "ios", "label": "IOS 27.0 SIMULATOR", "ok": True},
        {"key": "node", "label": "NODE 26", "ok": True},
        {"key": "pods", "label": "COCOAPODS 1.17.0", "ok": True},
        {"key": "user", "label": "USER MYSTICALRUNS", "ok": True},
    ]


def test_sharing_defaults_to_on_so_an_old_instance_shares(monkeypatch):
    assert _state(monkeypatch, {"name": "production"})["state"] == "READY"
    assert _state(monkeypatch, {"share_device": True})["state"] == "READY"


def test_off_a_mac_the_state_is_not_mac(monkeypatch):
    assert _state(monkeypatch, facts=None) == {"state": "NOT_MAC", "checks": [], "facts": None}


def test_switched_off_the_state_is_off_but_the_checks_still_show(monkeypatch):
    s = _state(monkeypatch, {"share_device": False})
    assert s["state"] == "OFF" and s["facts"] == FACTS and len(s["checks"]) == 6


def test_off_beats_everything_but_not_a_mac(monkeypatch):
    bare = dict(FACTS, xcode=None, iosRuntimes=[])
    assert _state(monkeypatch, {"share_device": False}, facts=bare,
                  setup={"user": False, "helper": False, "claude": False})["state"] == "OFF"
    assert _state(monkeypatch, {"share_device": False}, facts=None)["state"] == "NOT_MAC"


@pytest.mark.parametrize("gone, label", [({"xcode": None}, "XCODE"), ({"iosRuntimes": []}, "IOS SIMULATOR")])
def test_no_xcode_or_no_ios_runtime_is_xcode_missing(monkeypatch, gone, label):
    s = _state(monkeypatch, facts={**FACTS, **gone})
    assert s["state"] == "XCODE_MISSING"
    assert [c["label"] for c in s["checks"] if not c["ok"]] == [label], "a missing version drops out of its label"


def test_xcode_missing_is_reported_before_the_setup_is_asked_for(monkeypatch):
    s = _state(monkeypatch, facts={**FACTS, "xcode": None}, setup={"user": False, "helper": False, "claude": False})
    assert s["state"] == "XCODE_MISSING"


@pytest.mark.parametrize("part", ["user", "helper", "claude"])
def test_any_missing_part_of_the_setup_needs_setup(monkeypatch, part):
    s = _state(monkeypatch, setup={**SET_UP, part: False})
    assert s["state"] == "NEEDS_SETUP"
    assert [c["key"] for c in s["checks"] if not c["ok"]] == ["user"]


def test_node_and_cocoapods_are_shown_but_do_not_hold_a_device_back(monkeypatch):
    s = _state(monkeypatch, facts={**FACTS, "node": None, "pods": None})
    assert s["state"] == "READY"
    assert [(c["label"], c["ok"]) for c in s["checks"] if not c["ok"]] == [("NODE", False), ("COCOAPODS", False)]


def test_the_ios_check_names_the_newest_runtime(monkeypatch):
    s = _state(monkeypatch, facts={**FACTS, "iosRuntimes": ["27.0", "26.4", "9.3"]})
    assert s["checks"][2]["label"] == "IOS 27.0 SIMULATOR"


# --- handshake_headers ------------------------------------------------------------

def _decode(raw):
    """What Node's Buffer.from(raw, 'base64url') reads: the URL-safe alphabet, padding optional."""
    assert "=" not in raw and "+" not in raw and "/" not in raw
    return json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))


def test_a_ready_device_sends_its_facts_in_the_handshake(monkeypatch):
    _device(monkeypatch)
    feature, device = ds.handshake_headers({})
    assert feature == "X-Mystical-Features: device-runs"
    name, _, raw = device.partition(": ")
    assert name == "X-Mystical-Device" and raw.isascii()
    assert _decode(raw) == FACTS


def test_the_device_header_is_url_safe_base64_without_padding(monkeypatch):
    facts = {**FACTS, "name": "~~~???>>>"}          # standard base64 of this name has a + and a /
    std = base64.b64encode(json.dumps(facts, separators=(",", ":")).encode()).decode()
    assert "+" in std and "/" in std, "the sample must need the URL-safe alphabet"
    _device(monkeypatch, facts)
    raw = ds.handshake_headers({})[1].partition(": ")[2]
    assert _decode(raw) == facts


@pytest.mark.parametrize("why, inst, facts, setup", [
    ("not a mac", {}, None, SET_UP),
    ("switched off", {"share_device": False}, FACTS, SET_UP),
    ("no xcode", {}, {**FACTS, "xcode": None}, SET_UP),
    ("needs setup", {}, FACTS, {**SET_UP, "helper": False}),
])
def test_a_device_that_is_not_ready_says_nothing(monkeypatch, why, inst, facts, setup):
    _device(monkeypatch, facts, setup)
    assert ds.handshake_headers(inst) == [], why
