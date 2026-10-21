"""bridge/logostyle.py: STYLE WITH AI's run. The model is a fake `claude` that
streams a canned answer as stream-json text deltas, cut mid-line on purpose:
what is under test is that each complete line is checked and applied as it
lands, that a bad line changes nothing, and that every run ends (done, failed or
stopped) with the bell told.
Run: python -m pytest tests/test_logostyle.py -v"""

import base64
import json
import os
import stat
import subprocess
import sys
import time

import pytest

from bridge import aifeatures, config, logostyle, notices, project_config, projectmarks, runner

SHEET = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\x00" * 64).decode()


def svg(n):
    return f'<svg xmlns="http://www.w3.org/2000/svg"><title>{n}</title></svg>'.encode()


def repo(base, name, files):
    d = base / name
    d.mkdir(parents=True, exist_ok=True)
    for p, data in files.items():
        (d / p).parent.mkdir(parents=True, exist_ok=True)
        (d / p).write_bytes(data)
    subprocess.run(["git", "init", "-q", str(d)], check=True)
    subprocess.run(["git", "-C", str(d), "add", "-A"], check=True)
    return "/" + name


FAKE = r'''#!{py}
import json, os, sys, time
msg = json.loads(sys.stdin.readline())
d = os.environ["FAKE_DIR"]
open(os.path.join(d, "got.json"), "w").write(json.dumps(msg))
open(os.path.join(d, "argv.json"), "w").write(json.dumps(sys.argv[1:]))
out = open(os.path.join(d, "answer.txt")).read()
pause = float(os.environ.get("FAKE_PAUSE", "0"))
def say(e):
    sys.stdout.write(json.dumps(e) + "\n"); sys.stdout.flush()
say({{"type": "system", "subtype": "init"}})
say({{"type": "stream_event", "event": {{"type": "content_block_delta", "delta": {{"type": "thinking_delta", "thinking": ""}}}}}})
for i in range(0, len(out), 7):                      # small cuts: lines arrive in pieces
    say({{"type": "stream_event", "event": {{"type": "content_block_delta", "delta": {{"type": "text_delta", "text": out[i:i + 7]}}}}}})
    if pause and "\n" in out[i:i + 7]:
        time.sleep(pause)
err = os.environ.get("FAKE_ERROR")
say({{"type": "result", "is_error": bool(err), "result": err or out}})
'''


@pytest.fixture
def world(tmp_path, monkeypatch):
    """Projects in a temp BASE_PATH, the marks in temp files, the switch on, a
    fake claude, and the notices it emits."""
    root = tmp_path / "base"
    root.mkdir()
    monkeypatch.setattr(config, "BASE_PATH", str(root))
    monkeypatch.setattr(projectmarks, "_found", {})
    monkeypatch.setattr(projectmarks, "_read", {})
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "project_config.json"))
    monkeypatch.setattr(projectmarks, "_PATH", str(tmp_path / "project_marks.json"))
    monkeypatch.setattr(aifeatures, "enabled", lambda key: key == "logostyle")
    fake = tmp_path / "claude"
    fake.write_text(FAKE.format(py=sys.executable))
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    monkeypatch.setattr(runner, "claude_bin", lambda: str(fake))
    monkeypatch.setattr(runner, "_run_env", lambda *a, **k: {**os.environ, "FAKE_DIR": str(tmp_path)})
    sent = []
    monkeypatch.setattr(notices, "emit", lambda kind, subject, **kw: sent.append((kind, kw)))
    monkeypatch.setattr(logostyle, "_run", {"state": "idle"})
    return {"base": root, "dir": tmp_path, "sent": sent}


def answer(world, *lines):
    (world["dir"] / "answer.txt").write_text("".join(
        (json.dumps(x) if isinstance(x, dict) else x) + "\n" for x in lines))


def wait():
    for _ in range(200):
        if logostyle.state()["state"] != "running":
            return logostyle.state()
        time.sleep(0.05)
    raise AssertionError("the run never ended")


def keys():
    return {p["rel"]: f"P{i + 1}" for i, p in enumerate(projectmarks.style_candidates()["projects"])}


def test_a_run_applies_each_line_as_it_streams_and_tells_the_bell(world):
    shop = repo(world["base"], "shop", {"public/favicon.svg": svg(1), "src/brand/shop-logo.svg": svg(2)})
    tree = repo(world["base"], "yggdrasil", {"README.md": b"# Yggdrasil\nThe knowledge hub"})
    keep = repo(world["base"], "keepme", {"public/icon.svg": svg(3)})
    k = keys()
    answer(world, "here you go:",
           {"p": k[shop], "pick": "c2", "bg": "dark", "color": "#3168d0", "why": "the  brand's own mark"},
           {"p": k[tree], "pick": "icon:tree-deciduous", "bg": "auto", "color": "#57ab5a", "why": "a world tree"},
           {"p": "P99", "pick": "c1", "why": "no such project"},
           {"p": k[keep], "pick": "c9", "color": "#ac8de7", "why": "keeps its icon"},          # c9: no such candidate
           {"p": "note", "why": "react's logo in shop is a framework's"})
    logostyle.start(SHEET, projectmarks.style_candidates()["sig"])
    s = wait()
    assert s["state"] == "done" and s["error"] is None and s["total"] == 3
    assert {i["rel"]: i["how"] for i in s["items"]} == {shop: ["logo", "background", "colour"],
                                                        tree: ["icon", "colour"], keep: ["colour"]}
    assert next(i for i in s["items"] if i["rel"] == shop)["why"] == "the brand's own mark"
    assert s["note"] == "react's logo in shop is a framework's"
    assert project_config.mark(shop) == {"kind": "logo", "repo": "src/brand/shop-logo.svg", "plate": "dark",
                                          "color": "#3168d0", "source": "style", "styled": "the brand's own mark"}
    assert project_config.mark(tree)["icon"] == "tree-deciduous"
    assert project_config.mark(keep)["repo"] == "public/icon.svg"                       # a bad pick keeps what it wears
    got = json.loads((world["dir"] / "got.json").read_text())["message"]["content"]
    assert got[0]["type"] == "image" and got[0]["source"]["data"] == SHEET
    assert f"{k[shop]} shop" in got[1]["text"] and "c2 src/brand/shop-logo.svg" in got[1]["text"]
    argv = json.loads((world["dir"] / "argv.json").read_text())
    assert argv[argv.index("--tools") + 1] == "" and "--no-session-persistence" in argv
    assert [kind for kind, _ in world["sent"]] == ["styled"]
    assert world["sent"][0][1]["title"] == "3 projects"
    assert world["sent"][0][1]["body"] == "1 new logo · 1 new icon · 1 background · 3 colours"
    assert logostyle.live() is None


def test_start_refuses_a_stale_sheet_a_bad_sheet_and_a_second_run(world):
    repo(world["base"], "shop", {"public/favicon.svg": svg(1)})
    sig = projectmarks.style_candidates()["sig"]
    with pytest.raises(ValueError, match="changed"):
        logostyle.start(SHEET, "stale")
    with pytest.raises(ValueError, match="PNG"):
        logostyle.start(base64.b64encode(b"GIF89a").decode(), sig)
    answer(world, {"p": "P1", "pick": "keep", "color": "#112233", "why": "x"})
    os.environ["FAKE_PAUSE"] = "0.6"
    try:
        logostyle.start(SHEET, sig)
        with pytest.raises(RuntimeError):
            logostyle.start(SHEET, sig)
        assert logostyle.live()["total"] == 1
    finally:
        os.environ.pop("FAKE_PAUSE")
    wait()


def test_the_switch_off_runs_nothing(world, monkeypatch):
    repo(world["base"], "shop", {"public/favicon.svg": svg(1)})
    monkeypatch.setattr(aifeatures, "enabled", lambda key: False)
    with pytest.raises(ValueError, match="off"):
        logostyle.start(SHEET, projectmarks.style_candidates()["sig"])


def test_a_failed_call_says_why_and_keeps_what_landed(world):
    shop = repo(world["base"], "shop", {"public/favicon.svg": svg(1)})
    answer(world, {"p": "P1", "pick": "keep", "color": "#112233", "why": "x"})
    os.environ["FAKE_ERROR"] = "API Error: 529 overloaded"
    try:
        logostyle.start(SHEET, projectmarks.style_candidates()["sig"])
        s = wait()
    finally:
        os.environ.pop("FAKE_ERROR")
    assert s["state"] == "failed" and "529" in s["error"]
    assert project_config.mark(shop)["color"] == "#112233"           # a line that landed stays, Undo takes it back
    assert world["sent"][0][0] == "style_failed" and "529" in world["sent"][0][1]["body"]


def test_stop_ends_the_run_and_drops_what_comes_after(world):
    a = repo(world["base"], "a", {"public/icon.svg": svg(1)})
    b = repo(world["base"], "b", {"public/icon.svg": svg(2)})
    k = keys()
    answer(world, {"p": k[a], "pick": "keep", "color": "#112233", "why": "x"},
           {"p": k[b], "pick": "keep", "color": "#445566", "why": "y"})
    os.environ["FAKE_PAUSE"] = "1.5"
    try:
        logostyle.start(SHEET, projectmarks.style_candidates()["sig"])
        for _ in range(100):
            if logostyle.state()["items"]:
                break
            time.sleep(0.05)
        logostyle.stop()
        s = wait()
    finally:
        os.environ.pop("FAKE_PAUSE")
    assert s["state"] == "stopped" and s["error"] is None
    assert [i["rel"] for i in s["items"]] == [a] and project_config.mark(b) is None
    assert world["sent"] == []                                        # you stopped it: nothing to tell you


def test_the_model_s_none_is_auto(world):
    shop = repo(world["base"], "shop", {"public/favicon.svg": svg(1)})
    answer(world, {"p": "P1", "pick": "keep", "bg": "none", "why": "already right"})
    logostyle.start(SHEET, projectmarks.style_candidates()["sig"])
    s = wait()
    assert s["items"][0]["how"] == [] and project_config.mark(shop) is None      # "none" asked for no plate: AUTO
    argv = json.loads((world["dir"] / "argv.json").read_text())
    assert argv[argv.index("--effort") + 1] == "low"


def test_a_pick_that_is_a_copy_of_what_it_wears_keeps_it(world):
    shop = repo(world["base"], "shop", {"public/favicon.svg": svg(1), "public/icon-512.png": b"\x89PNG\r\n\x1a\n" + b"\x01" * 24,
                                        "src/brand/shop-logo.svg": svg(2)})
    cands = projectmarks.style_candidates()["projects"][0]["cands"]
    now, copy, other = (next(c for c in cands if c["path"] == p) for p in
                        ("public/favicon.svg", "public/icon-512.png", "src/brand/shop-logo.svg"))
    near = "f" * 63 + "0"                                             # 4 bits from all-f: the same picture
    hashes = {now["logo"]: "f" * 64, copy["logo"]: near, other["logo"]: "0" * 64, "nonsense": "zz"}
    answer(world, {"p": "P1", "pick": copy["id"], "color": "#112233", "why": "the bigger copy"})
    logostyle.start(SHEET, projectmarks.style_candidates()["sig"], hashes)
    assert wait()["items"][0]["how"] == ["colour"] and project_config.mark(shop)["repo"] == "public/favicon.svg"
    answer(world, {"p": "P1", "pick": other["id"], "color": "#112233", "why": "its brand"})
    logostyle.start(SHEET, projectmarks.style_candidates()["sig"], hashes)
    assert wait()["items"][0]["how"][0] == "logo" and project_config.mark(shop)["repo"] == "src/brand/shop-logo.svg"


def test_the_last_run_and_its_undo_outlive_a_restart(world, monkeypatch):
    a = repo(world["base"], "a", {"public/icon.svg": svg(1)})
    b = repo(world["base"], "b", {"public/icon.svg": svg(2)})
    k = keys()
    answer(world, {"p": k[a], "pick": "keep", "color": "#112233", "why": "x"}, {"p": k[b], "pick": "keep", "color": "#445566", "why": "y"})
    logostyle.start(SHEET, projectmarks.style_candidates()["sig"])
    rid = wait()["id"]
    monkeypatch.setattr(logostyle, "_run", {"state": "idle"})          # the bridge restarted
    s = logostyle.state()
    assert s["id"] == rid and s["state"] == "done" and [i["undone"] for i in s["items"]] == [False, False]
    projectmarks.undo_style(a)
    assert {i["rel"]: i["undone"] for i in logostyle.state()["items"]} == {a: True, b: False}


def test_nothing_to_style_costs_nothing(world):
    rel = repo(world["base"], "mine", {"public/icon.svg": svg(1)})
    projectmarks.set_mark(rel, {"kind": "icon", "icon": "car"})
    with pytest.raises(ValueError, match="nothing to style"):
        logostyle.start(SHEET, projectmarks.style_candidates()["sig"])
    assert not (world["dir"] / "got.json").exists()


def test_a_call_that_runs_too_long_says_so(world, monkeypatch):
    repo(world["base"], "shop", {"public/favicon.svg": svg(1)})
    answer(world, {"p": "P1", "pick": "keep", "why": "x"})
    monkeypatch.setattr(logostyle, "TIMEOUT_S", 1)
    os.environ["FAKE_PAUSE"] = "3"
    try:
        logostyle.start(SHEET, projectmarks.style_candidates()["sig"])
        s = wait()
    finally:
        os.environ.pop("FAKE_PAUSE")
    assert s["state"] == "failed" and "longer than" in s["error"]
