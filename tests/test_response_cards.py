"""Response cards (the asks that wait on you, docked on the prompt box): a
permission card carries what it asks about in full — a Bash command past 120
chars, a plan's markdown — and a Deny can say what to do instead.
Spec: .mystical/design-drafts/response-cards/SPEC.md.
Run: python -m pytest tests/test_response_cards.py -q"""

import json

from bridge import runner


class _Stdin:
    def __init__(self):
        self.data = []

    def write(self, s):
        self.data.append(s)

    def flush(self):
        pass


class _Proc:
    def __init__(self):
        self.stdin = _Stdin()

    def poll(self):
        return None


def _job(jid="rc1"):
    job = runner.Job(jid, 555)
    job.proc = _Proc()
    return job


def _ask(job, rid, tool, inp):
    runner._handle_control_request(job, {"request_id": rid, "request": {
        "subtype": "can_use_tool", "tool_name": tool, "input": inp}})
    return [e for e in job.events if e["type"] == "permission"][-1]


def test_a_long_command_rides_in_full():
    cmd = "git -C /Users/x/Projects/mystical-assistant push origin master && " + "gh pr create --fill --base master " * 6
    ev = _ask(_job(), "r1", "Bash", {"command": cmd})
    assert len(ev["summary"]) == 120 and ev["detail"] == cmd


def test_a_short_command_needs_no_detail():
    ev = _ask(_job(), "r2", "Bash", {"command": "git push"})
    assert ev["summary"] == "git push" and "detail" not in ev


def test_a_plan_card_carries_the_plan():
    plan = "## Step through cards\n\n1. **QuestionCard** — one page per question.\n2. Keys."
    ev = _ask(_job(), "r3", "ExitPlanMode", {"plan": plan})
    assert ev["detail"] == plan


def test_a_deny_note_reaches_the_model():
    job = _job()
    _ask(job, "r4", "Bash", {"command": "rm -rf build"})
    assert job.respond("r4", behavior="deny", message="keep build/, clean dist/ instead")
    resp = json.loads(job.proc.stdin.data[-1])["response"]["response"]
    assert resp == {"behavior": "deny", "message": "keep build/, clean dist/ instead"}


def _route(handler, job, body):
    out = []
    handler._json = lambda obj, code=200: out.append((obj, code))
    saved = dict(runner._jobs)
    runner._jobs.clear()
    runner._register(job)
    try:
        if hasattr(handler, "_api_run_respond"):
            handler._owned_job = lambda chat, jid: runner.get_job(jid)
            handler._api_run_respond(555, job.id, body)
        else:
            handler._respond(job.id, body)
    finally:
        runner._jobs.clear()
        runner._jobs.update(saved)
    return out[-1]


def test_both_routes_pass_the_note_and_say_so():
    from bridge.dashboard.server import Handler as Dash
    from bridge.miniapp.server import Handler as Mini
    for H in (Dash, Mini):
        job = _job("rc-" + H.__module__)
        _ask(job, "r5", "Bash", {"command": "git push --force"})
        obj, code = _route(object.__new__(H), job, {"request_id": "r5", "behavior": "deny", "message": "  push without --force  "})
        assert code == 200 and obj["noted"] is True, H.__module__
        resp = json.loads(job.proc.stdin.data[-1])["response"]["response"]
        assert resp["message"] == "push without --force", H.__module__


def test_an_allow_never_carries_a_note():
    from bridge.dashboard.server import Handler as Dash
    job = _job("rc-allow")
    _ask(job, "r6", "Bash", {"command": "ls"})
    obj, code = _route(object.__new__(Dash), job, {"request_id": "r6", "behavior": "allow", "message": "x"})
    assert code == 200 and obj["noted"] is False
    assert json.loads(job.proc.stdin.data[-1])["response"]["response"]["behavior"] == "allow"
