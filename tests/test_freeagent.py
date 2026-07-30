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
    # setup.sh installs opencode into ~/.opencode/bin, so an off-PATH name only
    # means "absent" once the install-dir probe misses too.
    saved_fallbacks, freeagent._FALLBACKS = freeagent._FALLBACKS, ()
    try:
        _env(GEMINI_API_KEY="k")
        assert freeagent.available() == []
    finally:
        freeagent.OPENCODE_BIN = saved
        freeagent._FALLBACKS = saved_fallbacks
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


# --- saved settings: configuring a rung without touching the environment -----

def _fresh_settings():
    """Point the settings file at an empty path so each test starts blank."""
    freeagent.SETTINGS = os.path.join(tempfile.mkdtemp(), "freeagents.json")
    return freeagent.SETTINGS


def test_a_saved_key_configures_a_provider_with_no_env_var_at_all():
    """The whole point: a key typed into the dashboard, no bridge restart."""
    _fresh_settings()
    freeagent._bin = _fake_bin()
    try:
        _env()
        freeagent.set_setting("GEMINI_API_KEY", "saved-key")
        assert [p["provider"] for p in freeagent.available()] == ["gemini"]
    finally:
        freeagent._bin = None


def test_the_environment_still_wins_over_a_saved_key():
    """Existing deployments configure this by env; that must keep its meaning."""
    _fresh_settings()
    freeagent._bin = _fake_bin()
    try:
        _env(GEMINI_API_KEY="from-env")
        freeagent.set_setting("GEMINI_API_KEY", "saved-key")
        assert freeagent.run_env()["GEMINI_API_KEY"] == "from-env"
        assert freeagent.status()["providers"][1]["source"] == "env"
    finally:
        _env()
        freeagent._bin = None


def test_clearing_a_saved_key_takes_the_rung_away_again():
    _fresh_settings()
    freeagent._bin = _fake_bin()
    try:
        _env()
        freeagent.set_setting("GEMINI_API_KEY", "saved-key")
        freeagent.set_setting("GEMINI_API_KEY", "")
        assert freeagent.available() == []
    finally:
        freeagent._bin = None


def test_saved_keys_are_not_world_readable():
    """They are API keys, so the same bar as the account credentials."""
    path = _fresh_settings()
    freeagent.set_setting("GEMINI_API_KEY", "saved-key")
    mode = os.stat(path).st_mode & 0o777
    assert mode == 0o600, f"provider keys at mode {oct(mode)}"


def test_run_env_carries_saved_keys_to_the_subprocess():
    """available() reading them is not enough — opencode only sees variables."""
    _fresh_settings()
    _env()
    freeagent.set_setting("DASHSCOPE_API_KEY", "qwen-key")
    assert freeagent.run_env()["DASHSCOPE_API_KEY"] == "qwen-key"


def test_settings_reject_a_name_that_is_not_a_provider_setting():
    _fresh_settings()
    try:
        freeagent.set_setting("ANTHROPIC_API_KEY", "nope")
    except ValueError:
        return
    raise AssertionError("expected ValueError")


def test_status_lists_every_rung_including_the_unconfigured_ones():
    """The settings tab is where a rung gets set up, so it has to show them all."""
    _fresh_settings()
    freeagent._bin = _fake_bin()
    try:
        _env()
        st = freeagent.status()
        assert st["installed"] is True
        assert [p["provider"] for p in st["providers"]] == \
            [s["provider"] for s in freeagent.PROVIDERS]
        assert all(p["ready"] is False for p in st["providers"])
        # Ollama authenticates with nothing; naming a local model is the opt-in.
        assert [p["needs"] for p in st["providers"]][-1] == "model"
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


# --- the turn actually runs on the free agent --------------------------------
# The bug this guards: recording runtime='opencode:x' while still spawning
# `claude` would send the turn straight back to the account that just died.

from bridge import runner, store  # noqa: E402

store.init()
CHAT = 555


class _Proc:
    def __init__(self, out="", code=0, err=""):
        self.stdout, self.stderr, self.returncode = out, err, code

    def communicate(self, timeout=None):
        return self.stdout, self.stderr


def _job(runtime="opencode:gemini"):
    s = store.create_session(CHAT, "/fa", cwd="/fa")
    j = runner.Job("j-fa", CHAT, s["id"])
    j.runtime = runtime
    return j


def _spawn(proc):
    """Patch the subprocess call the free-agent path uses; records the argv."""
    seen = {}
    saved = runner.subprocess.run

    def run(cmd, **kw):
        seen["cmd"] = cmd
        seen["kw"] = kw
        return proc

    runner.subprocess.run = run
    return seen, (lambda: setattr(runner.subprocess, "run", saved))


def test_a_free_agent_turn_spawns_opencode_not_claude():
    freeagent._bin = _fake_bin()
    _env(GEMINI_API_KEY="k")
    seen, restore = _spawn(_Proc(out="done"))
    try:
        runner._consume_free_agent(_job(), "keep going", "/fa")
        assert seen["cmd"][0] == freeagent._bin
        assert "run" in seen["cmd"]
    finally:
        restore()
        freeagent._bin = None


def test_a_free_agent_turn_reports_its_output_and_finishes():
    freeagent._bin = _fake_bin()
    _env(GEMINI_API_KEY="k")
    _seen, restore = _spawn(_Proc(out="I refactored the parser."))
    job = _job()
    try:
        runner._consume_free_agent(job, "go", "/fa")
        assert job.status == "done"
        assert "refactored the parser" in (job.result or "")
        # The bridge's event vocabulary, so the dashboard/Mini App render it
        # like any other turn: a `text` event, closed by a `result` event.
        types = [e["type"] for e in job.events]
        assert "text" in types and types[-1] == "result"
        assert job.elapsed is not None
    finally:
        restore()
        freeagent._bin = None


def test_a_nonzero_exit_is_an_error_turn():
    freeagent._bin = _fake_bin()
    _env(GEMINI_API_KEY="k")
    _seen, restore = _spawn(_Proc(out="", code=2, err="model not found"))
    job = _job()
    try:
        runner._consume_free_agent(job, "go", "/fa")
        assert job.status == "error"
        assert "model not found" in (job.error_msg or "")
    finally:
        restore()
        freeagent._bin = None


def test_the_runtime_reaches_the_job_so_the_branch_is_taken():
    """Recording runtime on the turn but not the job would run Claude anyway."""
    seen = {}
    saved = runner._run_streaming
    runner._run_streaming = lambda job, *a, **kw: seen.setdefault("job", job)
    try:
        job = runner.start_streaming_job(CHAT, "go", [], project="/fa",
                                         runtime="opencode:gemini")
        assert job is not None
        assert job.runtime == "opencode:gemini"
    finally:
        runner._run_streaming = saved
        if job is not None:
            runner.state.release_run(job.store_session_id)


def test_an_account_switch_is_not_mistaken_for_a_free_agent():
    saved = runner._run_streaming
    runner._run_streaming = lambda job, *a, **kw: None
    job = None
    try:
        job = runner.start_streaming_job(CHAT, "go", [], project="/fa2",
                                         account_slot=2)
        assert job.runtime == "claude:2"
        assert not (job.runtime or "").startswith("opencode:")
    finally:
        runner._run_streaming = saved
        if job is not None:
            runner.state.release_run(job.store_session_id)


def test_a_claude_session_id_is_never_passed_to_opencode():
    """Different runtimes, different id spaces — --session <claude uuid> is wrong."""
    freeagent._bin = _fake_bin()
    _env(GEMINI_API_KEY="k")
    seen, restore = _spawn(_Proc(out="ok"))
    job = _job()
    job.resume_id = "1a2b3c4d-claude-uuid"
    try:
        runner._consume_free_agent(job, "go", "/fa")
        assert "--session" not in seen["cmd"]
        assert job.resume_id not in seen["cmd"]
    finally:
        restore()
        freeagent._bin = None


def test_the_handoff_prompt_carries_the_task_not_just_a_nudge():
    """A free agent cannot read Claude's transcript — the task must be in the
    prompt, and building it must not call Claude (the quota is gone)."""
    from bridge import ladder
    s = store.create_session(CHAT, "/fa3", cwd="/fa3")
    store.start_turn(s["id"], "t-old", "Refactor the CSV parser", [])
    sent = {}

    def run(chat_id, prompt, atts, **kw):
        sent["prompt"] = prompt
        return "JOB"

    ladder.take(store.get_session(s["id"]), CHAT,
                {"kind": "free", "provider": "gemini", "label": "Gemini"},
                run=run, notify=lambda *a, **kw: None)
    assert "Refactor the CSV parser" in sent["prompt"]


def test_the_handoff_task_is_the_newest_prompt_not_the_oldest():
    """recent_prompts returns newest FIRST — mixing that up briefs the free
    agent to do the session's first task all over again."""
    from bridge import ladder
    s = store.create_session(CHAT, "/fa4", cwd="/fa4")
    store.start_turn(s["id"], "t-1", "Set up the project skeleton", [])
    store.start_turn(s["id"], "t-2", "Now add OAuth login", [])
    sent = {}

    def run(chat_id, prompt, atts, **kw):
        sent["prompt"] = prompt
        return "JOB"

    ladder.take(store.get_session(s["id"]), CHAT,
                {"kind": "free", "provider": "gemini", "label": "Gemini"},
                run=run, notify=lambda *a, **kw: None)
    task_pos = sent["prompt"].find("TASK")
    assert sent["prompt"].find("Now add OAuth login") > task_pos > -1
    assert sent["prompt"].find("Now add OAuth login") \
        < sent["prompt"].find("ALREADY DONE"), "newest prompt must be the TASK"
    assert "Set up the project skeleton" in sent["prompt"]


def test_a_provider_that_is_no_longer_configured_fails_loudly():
    """The key was removed between offering the rung and taking it."""
    freeagent._bin = _fake_bin()
    _env()                                  # no provider keys at all
    job = _job()
    try:
        runner._consume_free_agent(job, "go", "/fa")
        assert job.status == "error"
        assert "gemini" in (job.error_msg or "").lower()
    finally:
        freeagent._bin = None


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
