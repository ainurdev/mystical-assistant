"""Unit tests for the free-agent runtime adapter (bridge/freeagent.py).

The free agent is opencode driven headlessly, with several providers behind it
(zen free models, Gemini, Qwen, local Ollama). Nothing here touches the network
or spawns opencode: the contract under test is which providers get offered, the
argv we would run, and the briefing that carries the task across runtimes.
"""

import os
import stat
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

os.environ["BASE_PATH"] = tempfile.mkdtemp()
os.environ.setdefault("TELEGRAM_BOT_TOKEN", "12345:TESTTOKEN")
os.environ["ALLOWED_CHAT_IDS"] = "555"
os.environ["BRIDGE_DB"] = os.path.join(tempfile.mkdtemp(), "t.db")

from bridge import freeagent  # noqa: E402


def _fake_bin(name="opencode"):
    """An executable stand-in for the opencode launcher."""
    d = tempfile.mkdtemp()
    p = os.path.join(d, name)
    with open(p, "w") as f:
        f.write("#!/bin/sh\nexit 0\n")
    os.chmod(p, os.stat(p).st_mode | stat.S_IEXEC)
    return p


def _env(**keys):
    """Set freeagent's provider env, clearing anything not named."""
    for spec in freeagent.PROVIDERS:
        os.environ.pop(spec["env"], None)
    for k, v in keys.items():
        os.environ[k] = v


# --- available(): which rungs the ladder may offer ---------------------------

def test_no_opencode_binary_means_no_free_agent():
    """The rung must simply not appear rather than failing at handover time."""
    freeagent._bin = None
    saved, freeagent.OPENCODE_BIN = freeagent.OPENCODE_BIN, "definitely-not-here"
    try:
        _env(GEMINI_API_KEY="k")
        assert freeagent.available() == []
    finally:
        freeagent.OPENCODE_BIN = saved
        freeagent._bin = None


def test_a_provider_with_no_key_configured_is_not_offered():
    freeagent._bin = _fake_bin()
    try:
        _env()
        assert freeagent.available() == []
    finally:
        freeagent._bin = None


def test_a_configured_provider_is_offered():
    freeagent._bin = _fake_bin()
    try:
        _env(GEMINI_API_KEY="k")
        got = freeagent.available()
        assert [p["provider"] for p in got] == ["gemini"]
        assert got[0]["model"] and got[0]["label"]
    finally:
        freeagent._bin = None


def test_providers_come_back_in_ladder_order_not_env_order():
    """Free-est first: a zen free model outranks a metered API key."""
    freeagent._bin = _fake_bin()
    try:
        _env(GEMINI_API_KEY="k", OPENCODE_API_KEY="z")
        assert [p["provider"] for p in freeagent.available()] == ["zen", "gemini"]
    finally:
        freeagent._bin = None


def test_ollama_is_opt_in_by_model_not_by_key():
    """Local inference has no API key — naming a model is the opt-in."""
    freeagent._bin = _fake_bin()
    try:
        _env(OLLAMA_MODEL="qwen3-coder")
        got = freeagent.available()
        assert [p["provider"] for p in got] == ["ollama"]
        assert got[0]["model"] == "qwen3-coder"
    finally:
        freeagent._bin = None


# --- build_cmd(): the argv we hand to opencode -------------------------------

def test_cmd_runs_headless_with_auto_approval_and_a_model():
    freeagent._bin = _fake_bin()
    try:
        cmd = freeagent.build_cmd("do the thing",
                                  provider={"provider": "gemini",
                                            "model": "gemini-3-flash"},
                                  session="s1", cwd="/tmp/proj")
        assert cmd[0] == freeagent._bin
        assert cmd[1] == "run"
        assert "do the thing" in cmd
        assert "--model" in cmd
        assert cmd[cmd.index("--model") + 1] == "gemini/gemini-3-flash"
        assert "--auto" in cmd, "a handed-off turn cannot answer permission prompts"
    finally:
        freeagent._bin = None


def test_cmd_continues_an_existing_opencode_session():
    freeagent._bin = _fake_bin()
    try:
        cmd = freeagent.build_cmd("more", provider={"provider": "ollama",
                                                    "model": "m"},
                                  session="oc-123", cwd="/tmp/proj")
        assert "--session" in cmd
        assert cmd[cmd.index("--session") + 1] == "oc-123"
    finally:
        freeagent._bin = None


def test_cmd_omits_session_on_the_first_turn():
    freeagent._bin = _fake_bin()
    try:
        cmd = freeagent.build_cmd("first", provider={"provider": "ollama",
                                                     "model": "m"},
                                  session=None, cwd="/tmp/proj")
        assert "--session" not in cmd
    finally:
        freeagent._bin = None


# --- briefing(): carrying the task across runtimes ---------------------------

def test_briefing_states_the_task_and_forbids_starting_over():
    text = freeagent.briefing("Refactor the parser", ["did A", "did B"])
    assert "Refactor the parser" in text
    assert "did B" in text
    assert "start over" in text.lower()


def test_briefing_survives_having_no_history_to_summarize():
    text = freeagent.briefing("Fix the bug", [])
    assert "Fix the bug" in text


if __name__ == "__main__":
    import traceback
    fails = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print(f"ok   {name}")
            except Exception:  # noqa: BLE001
                fails += 1
                print(f"FAIL {name}")
                traceback.print_exc()
    print(f"\n{fails} failure(s)")
    sys.exit(1 if fails else 0)
