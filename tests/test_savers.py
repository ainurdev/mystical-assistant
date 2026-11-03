"""Savers (bridge/savers.py): OFF / TRIAL / ON switches for Claude Code's own
cost levers, the coin flip that splits a trial, its scoring, what a run gets,
the routes, and the test-output trim hook (bridge/trimhook.py).
Run: python -m pytest tests/test_savers.py -v"""
import json
import os
import subprocess
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import config, notices, runner, savers, store, trimhook  # noqa: E402
from bridge.dashboard import server as dash  # noqa: E402

store.init()
CHAT = 555


@pytest.fixture(autouse=True)
def _isolate(tmp_path, monkeypatch):
    monkeypatch.setattr(savers, "_path", lambda: str(tmp_path / "savers.json"))
    yield


def _session(n_turns=1, *, result="", tools=(), status="done", tokens=None):
    s = store.create_session(CHAT, "sv", cwd="/tmp/sv")
    for i in range(n_turns):
        tid = f"{s['id']}-t{i}"
        store.start_turn(s["id"], tid, "do it", [])
        if i == 0:
            for name in tools:
                store.append_event(s["id"], tid, {"type": "tool", "name": name})
            store.append_event(s["id"], tid, {"type": "result", "result": result})
            store.set_turn_tokens(tid, tokens)
        store.finish_turn(tid, status, None, 1)
    return s["id"]


def test_everything_starts_off_and_a_run_gets_nothing():
    assert [s["mode"] for s in savers.state()] == ["off", "off", "off"]
    assert savers.for_run("anything") == set()


def test_on_applies_to_every_run_and_says_how():
    savers.set_mode("concise", "on")
    savers.set_mode("subagent_effort", "on")
    on = savers.for_run("x")
    assert on == {"concise", "subagent_effort"}
    assert savers.env(on) == {"CLAUDE_CODE_SUBAGENT_EFFORT": "medium"}
    args = savers.settings_args(on)
    assert args[0] == "--settings" and json.loads(args[1]) == {"outputStyle": "Concise"}


def test_trim_tests_adds_a_bash_pretooluse_hook_that_merges_with_the_rest():
    args = savers.settings_args({"trim_tests"})
    hooks = json.loads(args[1])["hooks"]["PreToolUse"]
    assert hooks[0]["matcher"] == "Bash" and "trimhook.py" in hooks[0]["hooks"][0]["command"]
    stop = ["--settings", json.dumps({"hooks": {"Stop": [{"hooks": []}]}})]
    merged = json.loads(runner._one_settings(["claude"] + stop + args)[-1])
    assert set(merged["hooks"]) == {"Stop", "PreToolUse"}


def test_a_trial_splits_new_sessions_and_leaves_old_ones_out():
    savers.set_mode("concise", "trial")
    drawn = []
    for _ in range(12):
        sid = _session()
        savers.assign(sid)
        drawn.append("concise" in savers.for_run(sid))
        assert savers.arms_for(sid) == (["concise"] if drawn[-1] else [])
    assert True in drawn and False in drawn          # both halves fill
    old = _session(n_turns=3)
    savers.assign(old)
    assert "concise" not in savers.for_run(old)
    assert old not in json.load(open(savers._path()))["arms"]


def test_the_draw_is_fixed_for_a_session():
    savers.set_mode("concise", "trial")
    sid = _session()
    savers.assign(sid)
    first = savers.for_run(sid)
    savers.assign(sid)
    assert savers.for_run(sid) == first


def test_results_compare_the_halves_on_the_first_turn():
    savers.set_mode("concise", "trial")
    d = json.load(open(savers._path()))
    since = d["since"]["concise"]
    long_answer, short_answer = " ".join(["w"] * 100), " ".join(["w"] * 60)
    tok = {"in": 10, "out": 90, "cache_w": 0, "cache_r": 0}
    arms = {}
    for i in range(3):
        on = _session(result=short_answer, tools=("Read", "Edit"), tokens=tok)
        off = _session(result=long_answer, tools=("Read", "Grep", "Edit"), tokens=tok)
        arms[on] = {"concise": [True, since + 1]}
        arms[off] = {"concise": [False, since + 1]}
    d["arms"] = arms
    json.dump(d, open(savers._path(), "w"))
    r = savers.results("concise")
    assert (r["n"], r["on"], r["off"]) == (6, 3, 3)
    assert r["words"] == -40 and r["tools"] == -50 and r["errors_on"] == 0


def test_a_trial_rings_once_when_it_has_its_sessions(monkeypatch):
    monkeypatch.setattr(savers, "TRIAL_N", 2)
    rang = []
    monkeypatch.setattr(notices, "emit", lambda kind, subj, **kw: rang.append((kind, subj)))
    savers.set_mode("trim_tests", "trial")
    for _ in range(2):
        sid = _session(result="ok")
        savers.assign(sid)
    savers.check_done()
    savers.check_done()
    assert rang == [("saver_trial", "trim_tests")]


def test_routes_list_and_set(tmp_path):
    h = dash.Handler.__new__(dash.Handler)
    box: dict = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    h._get_api("/local/savers", {})
    assert [s["key"] for s in box["obj"]["savers"]] == list(savers.KEYS)
    h._post_api("/local/savers", {"key": "concise", "mode": "trial"})
    assert box["obj"]["ok"] and box["obj"]["savers"][0]["mode"] == "trial"
    h._post_api("/local/savers", {"key": "concise", "mode": "sometimes"})
    assert box["code"] == 400


def test_one_shots_use_the_short_cache():
    assert savers.ONE_SHOT_ENV == {"CLAUDE_CODE_PROMPT_CACHE_TTL": "5m"}


# --- the trim hook -------------------------------------------------------------

@pytest.mark.parametrize("cmd", [
    "pytest -q", "python3 -m pytest tests/ -q", "cd web && npx vitest run",
    "~/.cache/venv/bin/python -m pytest tests/test_x.py", "go test ./...", "pnpm test"])
def test_test_runs_get_wrapped(cmd):
    out = trimhook.wrap(cmd, "/b/trimhook.py")
    assert out and out.startswith("( set -o pipefail;") and "--filter" in out


@pytest.mark.parametrize("cmd", [
    "ls -la", "pytest -q | tail -5", "pytest -q > out.txt", "git commit -m 'pytest fix'"])
def test_everything_else_is_left_alone(cmd):
    assert trimhook.wrap(cmd, "/b/trimhook.py") is None


def test_trim_keeps_failures_and_the_summary():
    lines = [f"tests/test_a.py::test_{i} PASSED" for i in range(300)]
    lines[150] = "tests/test_a.py::test_150 FAILED"
    lines += ["E   AssertionError: 1 != 2", "1 failed, 299 passed in 3.2s"]
    out = trimhook.trim(lines)
    assert len(out) < 60
    assert "tests/test_a.py::test_150 FAILED" in out and out[-1] == "1 failed, 299 passed in 3.2s"
    assert any(l.startswith("… ") and "trimmed" in l for l in out)
    assert trimhook.trim(["ok"] * 10) == ["ok"] * 10


def test_the_wrapped_command_keeps_the_tests_exit_status(tmp_path):
    hook = os.path.abspath(trimhook.__file__)
    cmd = trimhook.wrap("pytest-fake", hook).replace("pytest-fake", "python3 -c 'import sys; print(\"x\"); sys.exit(3)'")
    r = subprocess.run(["bash", "-c", cmd], capture_output=True, text=True)
    assert r.returncode == 3 and r.stdout.strip() == "x"


def test_as_a_hook_it_answers_with_the_rewritten_input():
    call = {"tool_name": "Bash", "tool_input": {"command": "pytest -q", "description": "run tests"}}
    r = subprocess.run([sys.executable, "-I", trimhook.__file__], input=json.dumps(call),
                       capture_output=True, text=True)
    out = json.loads(r.stdout)["hookSpecificOutput"]
    assert out["hookEventName"] == "PreToolUse" and "permissionDecision" not in out
    assert out["updatedInput"]["description"] == "run tests" and "--filter" in out["updatedInput"]["command"]
    quiet = subprocess.run([sys.executable, "-I", trimhook.__file__],
                           input=json.dumps({"tool_name": "Bash", "tool_input": {"command": "ls"}}),
                           capture_output=True, text=True)
    assert quiet.stdout == ""
