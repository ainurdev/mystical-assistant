"""The runner reads a session's bound profile: model/mode/effort/account/tools
follow it, a fresh session takes the project default, a dead slot refuses."""
import os
import uuid

import pytest

from bridge import accounts, config, models, profiles, project_config, runner, state, store

store.init()
CHAT = 555


@pytest.fixture(autouse=True)
def isolated(monkeypatch, tmp_path):
    monkeypatch.setattr(profiles, "PATH", str(tmp_path / "profiles.json"))
    monkeypatch.setattr(project_config, "_PATH", str(tmp_path / "project_config.json"))
    monkeypatch.setattr(accounts, "list_accounts", lambda: [
        {"slot": 1, "disabled": False}, {"slot": 2, "disabled": False}])
    monkeypatch.setattr(models, "model_ids", lambda: {"claude-opus-5-5", "claude-fable-5-1"})
    monkeypatch.setattr(store, "default_disabled_tools", lambda: [])


def _start(monkeypatch, project=None, **kw):
    from bridge import titler
    seen = {}
    monkeypatch.setattr(runner, "_jobs", {})
    monkeypatch.setattr(titler, "kick", lambda *a, **k: None)
    monkeypatch.setattr(runner, "_run_streaming",
                        lambda job, prompt, images, cwd, model, effort, perm, ponytail:
                        seen.update(model=model, effort=effort, perm=perm))
    job = runner.start_streaming_job(CHAT, "go", [], project=project or config.BASE_PATH, **kw)
    state.release_run(job.store_session_id)
    return job, seen


def _fresh_project():
    """A project nobody has a session in yet: the DB and BASE_PATH are shared
    suite-wide, and ensure_session resumes a project's latest session."""
    d = os.path.join(config.BASE_PATH, f"pr-{uuid.uuid4().hex[:8]}")
    os.makedirs(d)
    return d


def _profile(**kw):
    return profiles.create({"name": "P", "agent": "claude", "account": "2",
                            "model": "claude-fable-5-1", "mode": "plan",
                            "effort": "high", **kw})


def test_a_bound_session_runs_its_profile(monkeypatch):
    p = _profile()
    s = store.create_session(CHAT, "/pr-run", cwd=config.BASE_PATH, profile_id=p["id"])
    job, seen = _start(monkeypatch, session_id=s["id"])
    assert seen == {"model": "claude-fable-5-1", "effort": "high", "perm": "plan"}
    assert job.account_slot == 2 and job.runtime == "claude:2"


def test_a_hand_set_knob_beats_the_profile_and_a_caller_beats_both(monkeypatch):
    p = _profile()
    s = store.create_session(CHAT, "/pr-own", cwd=config.BASE_PATH, profile_id=p["id"])
    store.set_session_field(s["id"], "model", "claude-opus-5-5")
    _, seen = _start(monkeypatch, session_id=s["id"])
    assert seen["model"] == "claude-opus-5-5"
    _, seen = _start(monkeypatch, session_id=s["id"], model="sonnet", account_slot=1)
    assert seen["model"] == "sonnet"


def test_a_fresh_session_takes_the_project_default_and_no_seeded_mode(monkeypatch):
    p = _profile()
    d = _fresh_project()
    profiles.set_project_default(runner.rel(d), p["id"])
    job, seen = _start(monkeypatch, project=d, origin="dashboard")
    row = store.get_session(job.store_session_id)
    assert row["profile_id"] == p["id"] and row["permission_mode"] is None
    assert seen["perm"] == "plan"


def test_a_body_profile_beats_the_project_default_on_creation(monkeypatch):
    a, b = _profile(), _profile(name="Q", effort="low")
    d = _fresh_project()
    profiles.set_project_default(runner.rel(d), a["id"])
    job, seen = _start(monkeypatch, project=d, profile_id=b["id"], origin="dashboard")
    assert store.get_session(job.store_session_id)["profile_id"] == b["id"]
    assert seen["effort"] == "low"


def test_an_unprofiled_fresh_session_still_gets_the_surface_default_mode(monkeypatch):
    job, _ = _start(monkeypatch, project=_fresh_project(), origin="dashboard")
    row = store.get_session(job.store_session_id)
    assert row["profile_id"] is None
    assert row["permission_mode"] == config.NEW_SESSION_PERMISSION_MODE


def test_a_dead_slot_refuses_instead_of_running_elsewhere(monkeypatch):
    p = _profile()
    s = store.create_session(CHAT, "/pr-dead", cwd=config.BASE_PATH, profile_id=p["id"])
    monkeypatch.setattr(accounts, "list_accounts", lambda: [{"slot": 1, "disabled": False}])
    job, _ = _start(monkeypatch, session_id=s["id"])
    assert job.refusal and "account 2" in job.refusal and job.account_slot is None
    # A refusal must not mint+persist a claude_session_id for a session that
    # never ran: the next (post-fix) attempt has to start fresh (--session-id),
    # not --resume a transcript that was never created.
    assert store.get_session(s["id"])["claude_session_id"] is None


def test_run_streaming_refuses_before_spawning_when_job_carries_one(monkeypatch):
    """_run_streaming itself must not spawn once job.refusal is set — covers
    callers other than start_streaming_job (e.g. a resumed job) that could
    carry a refusal through to here."""
    s = store.create_session(CHAT, "/pr-refuse", cwd=config.BASE_PATH)
    store.start_turn(s["id"], "j-refuse", "x", [])
    job = runner.Job("j-refuse", CHAT, s["id"])
    job.refusal = "nope"

    def boom(*a, **k):
        raise AssertionError("must not spawn")
    monkeypatch.setattr(runner.subprocess, "Popen", boom)
    runner._run_streaming(job, "x", [], config.BASE_PATH)
    assert job.status == "error"
    assert {"type": "error", "message": "nope"} in job.events


def test_handle_task_refuses_a_dead_slot_without_running(monkeypatch):
    """The bot's plain-text path (handle_task) must refuse exactly like the
    streaming path: no run_blocking call, just the warning."""
    p = _profile()
    s = store.create_session(CHAT, "/pr-bot-dead", cwd=config.BASE_PATH, profile_id=p["id"])
    monkeypatch.setattr(accounts, "list_accounts", lambda: [{"slot": 1, "disabled": False}])
    sent = []
    monkeypatch.setattr(runner, "send", lambda chat_id, text, *a, **k: sent.append(text))
    monkeypatch.setattr(runner, "typing", lambda *a, **k: None)

    def boom(*a, **k):
        raise AssertionError("must not run")
    monkeypatch.setattr(runner, "run_blocking", boom)
    runner.handle_task(CHAT, "hi", s)
    assert len(sent) == 1
    assert sent[0].startswith("⚠️") and "account 2" in sent[0]


# Every session the bridge makes is bound, so its PROFILE picker never reads
# NO PROFILE while a profile's login runs it.

def test_a_rivendell_run_session_is_bound_to_the_claude_default():
    from bridge import rivendell
    p = _profile()
    sid = rivendell.Worker({"id": "t1", "name": "test", "model": "opus"})._new_session(_fresh_project())
    row = store.get_session(sid)
    assert row["profile_id"] == p["id"] and row["permission_mode"] == "bypassPermissions"


def test_continuing_a_native_session_binds_its_projects_claude_profile(monkeypatch):
    p, own = _profile(), _profile(name="Own", account="1")
    monkeypatch.setattr(runner.transcript_jsonl, "find_transcript", lambda sid: None)
    s = store.create_session(CHAT, "/pr-native", cwd=config.BASE_PATH, origin="terminal")
    runner._adopt_native(store.get_session(s["id"]), "dashboard")
    row = store.get_session(s["id"])
    assert row["profile_id"] == p["id"] and row["origin"] == "bridge"
    picked = store.create_session(CHAT, "/pr-native", origin="terminal", profile_id=own["id"])
    runner._adopt_native(store.get_session(picked["id"]), "dashboard")
    assert store.get_session(picked["id"])["profile_id"] == own["id"]   # one picked stays


def test_a_refused_turn_is_not_auto_resumed(monkeypatch):
    """The same refusal comes back every time: resuming it would only pile up
    nudge turns and pushes, AUTO_RESUME_MAX of them."""
    s = store.create_session(CHAT, "/pr-refused", cwd=config.BASE_PATH)
    store.set_claude_session_id(s["id"], "csid-refused")      # it ran before

    def boom(*a, **k):
        raise AssertionError("must not resume a refused turn")
    monkeypatch.setattr(runner, "start_streaming_job", boom)
    job = runner.Job("j-refused", CHAT, s["id"])
    job.status, job.refusal = "error", "Profile 'P' runs on Claude account 2, which is gone"
    assert runner._maybe_auto_resume(job, config.BASE_PATH, None, None) is False
