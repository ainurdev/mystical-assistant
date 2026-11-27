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


# A screenshot pasted in the prompt box goes with the answer it was pasted for
# (a question's, a Deny's note): the model is told where it is, the transcript keeps it.

def _question(job, rid):
    runner._handle_control_request(job, {"request_id": rid, "request": {
        "subtype": "can_use_tool", "tool_name": "AskUserQuestion", "input": {"questions": [{
            "question": "Which layout?", "header": "Layout", "multiSelect": False,
            "options": [{"label": "List", "description": ""}, {"label": "Grid", "description": ""}]}]}}})


def test_a_question_answer_points_the_model_at_its_files():
    job = _job("rc-qimg")
    _question(job, "q1")
    assert job.respond("q1", answers=[{"header": "Layout", "labels": ["Grid"]}], images=["/up/a/1-shot.png"])
    msg = json.loads(job.proc.stdin.data[-1])["response"]["response"]["message"]
    assert "/up/a/1-shot.png" in msg and "Grid" in msg
    ev = [e for e in job.events if e["type"] == "question_answered"][-1]
    assert ev["images"] == ["/up/a/1-shot.png"]


def test_a_deny_note_carries_its_files():
    job = _job("rc-dimg")
    _ask(job, "r7", "Bash", {"command": "git push origin master"})
    assert job.respond("r7", behavior="deny", message="push to staging", images=["/up/b/1-shot.png"])
    msg = json.loads(job.proc.stdin.data[-1])["response"]["response"]["message"]
    assert "/up/b/1-shot.png" in msg and "push to staging" in msg
    ev = [e for e in job.events if e["type"] == "permission_resolved"][-1]
    assert ev["images"] == ["/up/b/1-shot.png"]


PNG = "data:image/png;name=shot.png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=="


def test_the_route_saves_an_answers_screenshot(monkeypatch, tmp_path):
    from bridge import config
    from bridge.dashboard.server import Handler as Dash
    monkeypatch.setattr(config, "UPLOAD_DIR", str(tmp_path))
    job = _job("rc-route-img")
    _question(job, "q2")
    obj, code = _route(object.__new__(Dash), job, {"request_id": "q2", "images": [PNG],
                                                   "answers": [{"header": "Layout", "labels": []}]})
    assert code == 200
    saved = [p for p in tmp_path.rglob("*") if p.is_file()]
    assert [p.name for p in saved] == ["1-shot.png"]
    assert str(saved[0]) in json.loads(job.proc.stdin.data[-1])["response"]["response"]["message"]


def test_a_screenshot_alone_is_a_deny_note(monkeypatch, tmp_path):
    from bridge import config
    from bridge.dashboard.server import Handler as Dash
    monkeypatch.setattr(config, "UPLOAD_DIR", str(tmp_path))
    job = _job("rc-route-deny")
    _ask(job, "r8", "Bash", {"command": "rm -rf dist"})
    obj, code = _route(object.__new__(Dash), job, {"request_id": "r8", "behavior": "deny", "images": [PNG]})
    assert code == 200 and obj["noted"] is True


def test_a_late_answer_leaves_no_files(monkeypatch, tmp_path):
    from bridge import config
    from bridge.dashboard.server import Handler as Dash
    monkeypatch.setattr(config, "UPLOAD_DIR", str(tmp_path))
    obj, code = _route(object.__new__(Dash), _job("rc-route-gone"), {"request_id": "gone", "images": [PNG]})
    assert code == 409 and not [p for p in tmp_path.rglob("*") if p.is_file()]


def test_an_agents_own_question_card_names_its_files_too():
    import threading
    from bridge import gateway

    class J:   # enough of a job for answer_card
        cwd = None
        events: list = []
        add = events.append
    rid = "gw-rc-img"
    gateway._cards[rid] = {"done": threading.Event(), "answers": None, "text": None,
                           "on_answer": lambda answers: "The user answered your card: " + answers[0]["labels"][0]}
    try:
        gateway.answer_card(J(), {"request_id": rid, "kind": "question"}, [{"header": "Pick", "labels": ["B"]}],
                            images=["/up/c/1-shot.png"])
        text = gateway._cards[rid]["text"]
        assert "/up/c/1-shot.png" in text and text.endswith("The user answered your card: B")
        assert J.events[-1]["images"] == ["/up/c/1-shot.png"]
    finally:
        gateway._cards.pop(rid, None)
