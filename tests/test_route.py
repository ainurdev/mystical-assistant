"""route: the rules that pick Matt Pocock's /command for a prompt, and the next
step once a flow step ends. Facts in, one route out: no model, no network, only a
tmp project dir for the one thing the rules look at (.mystical/tickets/*/*.md). One section drives POST /local/route, the
endpoint behind the SKILL ROUTER switch, the way tests/test_commands.py drives its routes;
the last pins the two run-time fixes in bridge/runner.py (the grill note, _with_images).
Run: python -m pytest tests/test_route.py -v"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import aifeatures, commands, config, route, runner  # noqa: E402
from bridge.dashboard import server as dash  # noqa: E402

NS = "mattpocock-skills:"
CMDS = {NS + s: f"matt's {s}" for s in (
    "ask-matt", "code-review", "diagnosing-bugs", "grill-me", "grill-with-docs", "handoff",
    "implement", "implement-spec", "improve-codebase-architecture", "prototype", "research",
    "retro", "setup-matt-pocock-skills", "tdd", "teach", "to-spec", "to-tickets", "triage",
    "wait-what", "wayfinder")}
CMDS["compact"] = "compact the conversation"
CMDS["code-review"] = "the CLI's builtin review, a different skill"

FEATURE = "add a weekly digest: every friday at 17:00, one message that sums up what each session shipped this week"
TRACEBACK = 'Traceback (most recent call last):\n  File "x.py", line 3'
BUG = "the TURNS tab is empty after a bridge restart, find out why"
REVIEW = "review the changes in the last commit for bugs"
LONG = ("The sidebar lists every session under its project, and when a project has many sessions the names run "
        "together on narrow windows. People keep asking why two rows look identical, so I want to sort out how "
        "those rows read.")


def flow(skill, rest=""):
    """The prompt a flow step was sent as."""
    return f"/{NS}{skill} {rest}".strip()


GRILL = flow("grill-with-docs", "add X")
TICKETS = flow("to-tickets")


@pytest.fixture
def root(tmp_path):
    """An empty project."""
    return str(tmp_path)


def go(root, text="", *, prompts=(), status="done", ctx=None, first=False, cmds=CMDS, off=()):
    return route.pick(text, prompts=list(prompts), last_status=status, ctx_tokens=ctx,
                      first=first, cmds=cmds, root=root, off=frozenset(off))


def tickets(root, *names, feat="feat", at=None):
    """What /to-tickets leaves behind: .mystical/tickets/<feat>/<names>. Returns the dir, relative to root."""
    rel = f".mystical/tickets/{feat}"
    d = os.path.join(root, rel)
    os.makedirs(d)
    for n in names:
        open(os.path.join(d, n), "w").close()
    if at:
        os.utime(d, (at, at))
    return rel


def test_constants():
    assert route.SMART_ZONE == 150_000
    assert route.SUBS == ("autopick", "nextstep", "smartzone")
    assert len(LONG) == 220


# ── typed text → a start route ────────────────────────────────────────────────

@pytest.mark.parametrize("text, first, skill, auto", [
    (FEATURE, True, "grill-with-docs", True),
    (FEATURE, False, "grill-with-docs", False),
    (TRACEBACK, True, "diagnosing-bugs", True),
    (BUG, True, "diagnosing-bugs", True),
    (REVIEW, True, "code-review", False),  # Matt's, never the CLI's builtin of the same name
    ("write it up as a spec", True, "to-spec", False),
    ("break this into tickets", True, "to-tickets", False),
    ("let's do it test-first", True, "tdd", True),
    ("research how other bridges send push notifications", True, "research", True),
    ("prototype three looks for the digest card", True, "prototype", True),
    # the rest of the table, one each: none of them is in the safe set
    ("triage the incoming issues from this week", True, "triage", False),
    ("rewrite the whole thing from scratch", True, "wayfinder", False),
    ("the sidebar code is tangled and needs deeper modules", True, "improve-codebase-architecture", False),
    ("help me understand how the runner streams", True, "teach", False),
    ("write a handoff for the next session", True, "handoff", False),
    # a prompt that starts like a feature beats a weak bug signal, never a hard one
    ("add retry when the upload fails", True, "grill-with-docs", True),
    ("build a page listing failed jobs", True, "grill-with-docs", True),
    ("add a guard because the export crashes with a traceback", True, "diagnosing-bugs", True),
    ("find docs for the stream-json format", True, "research", True),
])
def test_start(root, text, first, skill, auto):
    r = go(root, text, first=first)
    assert (r["name"], r["auto"], r["kind"]) == (NS + skill, auto, "start")
    assert r["desc"] == CMDS[NS + skill]
    assert (r["arg"], r["fresh"]) == ("", False)


def test_review_beats_diagnosing_bugs(root):
    assert go(root, "review the diff, the build is broken")["name"] == NS + "code-review"


def test_the_pick_says_why(root):
    assert go(root, FEATURE)["why"] == "a new feature: settle it before building"
    assert go(root, BUG)["why"] == "something's broken: get a failing loop first"


@pytest.mark.parametrize("text", [
    "/mattpocock-skills:grill-me x", "/compact",
    "/review the changes in the last commit for bugs",  # a rule would take it, but it is already a command
    "  /mattpocock-skills:grill-me add a weekly digest",
    "ok", "", "   ",
    "rename the prototype field in the store", "write docs for the route module",  # a mention, not a request
])
def test_nothing_to_route(root, text):
    assert go(root, text, first=True) is None


def test_alts(root):
    alts = go(root, FEATURE)["alts"]
    assert [a["name"] for a in alts] == [NS + "prototype", NS + "implement", NS + "grill-me"]
    assert set(alts[0]) == {"name", "desc", "why"} and alts[0]["desc"] == CMDS[NS + "prototype"]
    assert [a["name"] for a in go(root, BUG)["alts"]] == [NS + "tdd"]
    assert go(root, "write it up as a spec")["alts"] == []
    without = {k: v for k, v in CMDS.items() if k != NS + "prototype"}
    assert [a["name"] for a in go(root, FEATURE, cmds=without)["alts"]] == [NS + "implement", NS + "grill-me"]


# ── short replies: the 12-character minimum, and the whole-message exceptions ─

def test_a_start_rule_needs_twelve_characters(root):
    assert go(root, "add a field", first=True) is None  # 11
    assert go(root, "add a button", first=True)["name"] == NS + "grill-with-docs"  # 12


@pytest.mark.parametrize("text", ["huh?", "What?", "wait, what", "I don't get it", "i dont understand that."])
def test_wait_what_after_a_finished_turn(root, text):
    r = go(root, text)
    assert (r["name"], r["kind"], r["auto"]) == (NS + "wait-what", "start", False)
    assert r["why"] == "re-pitch the last answer in plain words"
    assert go(root, text, status="error") is None
    assert go(root, text, status=None) is None


# ── inside a grill flow: the text is an answer to the interview ───────────────

@pytest.mark.parametrize("text, skill", [
    ("write it up as a spec", "to-spec"),
    ("break this into tickets", "to-tickets"),
    ("prototype three looks for the card", "prototype"),
    ("write a handoff for the next session", "handoff"),
])
def test_inside_a_grill_flow_the_next_moves_still_fire(root, text, skill):
    assert go(root, text, prompts=[GRILL])["name"] == NS + skill


@pytest.mark.parametrize("prompt", [GRILL, flow("grill-me", "the digest")])
@pytest.mark.parametrize("text", [
    "we need a retry too",                    # grill-with-docs would match
    "the sync fails when the list is empty",  # diagnosing-bugs would match
    "research how others do it",
    "review what we have so far",
    "huh? what does that mean",
    "go with option B",                       # an answer: only a bare go is the way out
    LONG,                                 
])
def test_inside_a_grill_flow_answers_do_not_route(root, prompt, text):
    assert go(root, text, prompts=[prompt]) is None


@pytest.mark.parametrize("prompt", [GRILL, flow("grill-me", "the digest")])
def test_wait_what_fires_inside_a_grill_flow(root, prompt):
    # Matt: use it mid-conversation, inside any other skill
    r = go(root, "huh?", prompts=[prompt])
    assert (r["name"], r["kind"], r["auto"]) == (NS + "wait-what", "start", False)
    assert go(root, "huh?", prompts=[prompt], status="error") is None


@pytest.mark.parametrize("text", ["ok, build it", "go ahead", "Okay. implement this", "let's build it", "Go!",
                                  "yes, go ahead", "sounds good, build it"])
def test_go_ahead_inside_a_grill_flow_routes_to_implement(root, text):
    # the way out of the interview: the answer is "enough, build it", a suggestion, never auto
    r = go(root, text, prompts=[GRILL])
    assert (r["name"], r["kind"], r["auto"]) == (NS + "implement", "start", False)
    assert r["why"] == "build it here, test-first"


def test_go_ahead_means_implement_only_inside_a_grill_flow(root):
    assert go(root, "implement it now")["name"] == NS + "grill-with-docs"
    assert go(root, "implement it now", prompts=[GRILL])["name"] == NS + "implement"


def test_a_later_step_ends_the_grill_flow(root):
    # to-spec came after the grill: the thread is no longer answering the interview
    assert go(root, "we need a retry too", prompts=[GRILL, flow("to-spec")])["name"] == NS + "grill-with-docs"


# ── the pack is not there ─────────────────────────────────────────────────────

@pytest.mark.parametrize("text", [FEATURE, BUG, REVIEW, LONG])
def test_not_installed(root, text):
    # only the CLI's own: its builtin code-review is a different skill and is never picked
    assert go(root, text, first=True, cmds={"compact": "", "code-review": "builtin"}) is None


def test_not_installed_next_step(root):
    only = {k: v for k, v in CMDS.items() if k != NS + "to-spec"}
    assert go(root, "", prompts=[GRILL], cmds=only) is None
    assert go(root, "", prompts=[GRILL], ctx=162_000, cmds=only) is None  # no compact toward a step it can't take


def test_an_uninstalled_rule_is_skipped_not_fatal(root):
    # "review ... fails" would be code-review; with it missing the next rule that fits answers
    only = {k: v for k, v in CMDS.items() if k != NS + "code-review"}
    assert go(root, "review why the build fails", cmds=only)["name"] == NS + "diagnosing-bugs"


# ── auto ──────────────────────────────────────────────────────────────────────

def test_auto_needs_a_first_prompt_or_a_flow_step_that_just_ended(root):
    step = flow("research", "how others do it")
    assert go(root, FEATURE, first=True)["auto"] is True
    assert go(root, FEATURE, prompts=[step])["auto"] is True                    # right after a flow step ended
    assert go(root, FEATURE, prompts=[step], status="error")["auto"] is False   # it did not end well
    assert go(root, FEATURE, prompts=[step], status="stopped")["auto"] is False  # you stopped it: not done
    assert go(root, FEATURE, prompts=[step, "and the old ones"])["auto"] is False  # a follow-up inside the thread
    assert go(root, FEATURE, prompts=["fix the typo in the README"])["auto"] is False  # no flow command at all


def test_off_autopick(root):
    r = go(root, FEATURE, first=True, off={"autopick"})
    assert (r["name"], r["auto"]) == (NS + "grill-with-docs", False)


def test_off_nextstep(root):
    assert go(root, "", prompts=[GRILL], off={"nextstep"}) is None
    assert go(root, FEATURE, off={"nextstep"})["name"] == NS + "grill-with-docs"  # typed routes stay


def test_off_smartzone(root):
    assert go(root, "", prompts=[GRILL], ctx=162_000, off={"smartzone"})["name"] == NS + "to-spec"


# ── the next step, from the last flow command ─────────────────────────────────

def test_next_after_grill(root):
    r = go(root, "", prompts=[GRILL], ctx=90_000)
    assert (r["name"], r["kind"], r["auto"], r["fresh"], r["arg"]) == (NS + "to-spec", "next", False, False, "")
    assert r["why"] == "many sessions of work: write it up"
    assert r["alts"] == [{"name": NS + "implement", "desc": CMDS[NS + "implement"],
                          "why": "or build it here if one session holds it"}]
    assert go(root, "", prompts=[flow("grill-me", "x")])["name"] == NS + "to-spec"
    assert go(root, "  \n", prompts=[GRILL])["name"] == NS + "to-spec"  # nothing typed but whitespace


def test_next_after_grill_past_the_smart_zone_compacts_first(root):
    r = go(root, "", prompts=[GRILL], ctx=162_000)
    assert (r["name"], r["kind"], r["auto"], r["fresh"]) == ("compact", "next", False, False)
    assert r["arg"] == "keep the decisions so far; next: /to-spec"
    assert r["why"] == "162k is past the 150k smart zone"
    assert r["desc"] == CMDS["compact"]


@pytest.mark.parametrize("ctx, name", [(None, NS + "to-spec"), (149_999, NS + "to-spec"),
                                       (150_000, "compact"), (400_000, "compact")])
def test_next_the_smart_zone_starts_at_150k(root, ctx, name):
    assert go(root, "", prompts=[GRILL], ctx=ctx)["name"] == name


def test_next_after_grill_and_a_compact(root):
    r = go(root, "", prompts=[GRILL, "/compact keep the decisions so far; next: /to-spec"], ctx=30_000)
    assert r["name"] == NS + "to-spec"


def test_next_without_compact_listed_goes_straight_to_the_step(root):
    cmds = {k: v for k, v in CMDS.items() if k != "compact"}
    assert go(root, "", prompts=[GRILL], ctx=162_000, cmds=cmds)["name"] == NS + "to-spec"


def test_next_after_an_answered_interview(root):
    # typed answers after the grill command don't hide it
    r = go(root, "", prompts=[GRILL, "weekly, on friday", "yes, one message"])
    assert r["name"] == NS + "to-spec"


def test_next_does_not_outlive_the_flow_commands_turn(root):
    step = flow("diagnosing-bugs", "x")
    assert go(root, "", prompts=[step])["name"] == NS + "retro"
    # typed replies came after it: the flow has moved on, so its next step would be a stale ghost
    assert go(root, "", prompts=[step, "still empty", "ok"]) is None


def test_next_compacts_only_at_a_real_boundary(root):
    assert go(root, "", prompts=[GRILL], ctx=162_000)["name"] == "compact"
    # a grill that ended on a typed answer is mid-interview, not at a boundary
    assert go(root, "", prompts=[GRILL, "weekly"], ctx=162_000)["name"] == NS + "to-spec"


def test_next_has_no_second_compact_right_after_a_compact(root):
    # the context size can still read stale right after compacting
    prompts = [flow("to-spec", "x"), "/compact keep the decisions so far; next: /to-tickets"]
    assert go(root, "", prompts=prompts, ctx=162_000)["name"] == NS + "to-tickets"


def test_next_after_spec(root):
    r = go(root, "", prompts=[flow("to-spec")])
    assert (r["name"], r["kind"], r["fresh"]) == (NS + "to-tickets", "next", False)
    assert r["why"] == "split it into tickets with blockers"


def test_next_after_tickets_opens_the_first_one_in_a_fresh_session(root):
    issues = tickets(root, "01-a.md", "02-b.md", ".DS_Store", "00-notes.txt")  # only *.md are tickets
    r = go(root, "", prompts=[TICKETS])
    assert (r["name"], r["kind"], r["auto"]) == (NS + "implement", "next", False)
    assert (r["arg"], r["fresh"], r["why"]) == (f"{issues}/01-a.md", True, "#01 has no blockers")
    assert r["arg"] == ".mystical/tickets/feat/01-a.md"
    # a fresh session starts clean: no compact first, however big this one is
    assert go(root, "", prompts=[TICKETS], ctx=200_000)["name"] == NS + "implement"


def test_next_after_tickets_names_the_first_ticket_by_its_own_number(root):
    issues = tickets(root, "03-c.md", "04-d.md")  # 01 and 02 are done and gone
    r = go(root, "", prompts=[TICKETS])
    assert (r["arg"], r["why"]) == (f"{issues}/03-c.md", "#03 has no blockers")


def test_next_after_tickets_takes_the_newest_issues_dir(root):
    tickets(root, "01-mid.md", feat="a-mid", at=2_000)
    new = tickets(root, "01-new.md", "02-more.md", feat="b-new", at=3_000)
    tickets(root, "01-old.md", feat="c-old", at=1_000)
    assert go(root, "", prompts=[TICKETS])["arg"] == f"{new}/01-new.md"


def test_next_after_tickets_with_no_ticket_dir(root):
    r = go(root, "", prompts=[TICKETS])
    assert (r["name"], r["arg"], r["fresh"]) == (NS + "implement", "", False)
    assert r["why"] == "pick the first ticket with no blockers"
    assert go(root, "", prompts=[TICKETS], ctx=162_000)["name"] == "compact"  # not fresh: it can compact


def test_next_with_an_unknown_project_has_no_tickets():
    r = go(None, "", prompts=[TICKETS])
    assert (r["name"], r["arg"], r["fresh"]) == (NS + "implement", "", False)
    assert go(None, "", prompts=[flow("implement", ".mystical/tickets/feat/01-a.md")])["name"] == NS + "retro"


def test_next_after_tickets_with_an_empty_issues_dir(root):
    tickets(root)
    r = go(root, "", prompts=[TICKETS])
    assert (r["arg"], r["fresh"]) == ("", False)


def test_next_with_a_root_that_does_not_exist_has_no_tickets():
    r = go("/no/such/dir", "", prompts=[TICKETS])
    assert (r["name"], r["arg"], r["fresh"]) == (NS + "implement", "", False)


def test_next_after_implement_when_the_ticket_dir_is_gone_is_the_retro(root):
    assert go(root, "", prompts=[flow("implement", ".mystical/tickets/gone/01-a.md")])["name"] == NS + "retro"


def test_next_after_implement_with_a_nul_byte_in_the_ticket_path_is_the_retro(root):
    # the path comes from a prompt, and os.listdir raises ValueError on a NUL byte
    assert go(root, "", prompts=[flow("implement", ".mystical/tickets/a\x00b/01-a.md")])["name"] == NS + "retro"


def test_next_after_tickets_in_a_root_with_glob_characters(tmp_path):
    proj = str(tmp_path / "proj[1]")
    issues = tickets(proj, "01-a.md", "02-b.md")
    r = go(proj, "", prompts=[TICKETS])
    assert r["arg"] == f"{issues}/01-a.md"


def test_next_after_tickets_when_an_issues_dir_vanishes_before_its_mtime_is_read(root, monkeypatch):
    new = tickets(root, "01-new.md", feat="a-new", at=3_000)
    tickets(root, "01-gone.md", feat="b-gone", at=4_000)  # the newest, but gone by the time it is measured
    real = os.path.getmtime

    def getmtime(path):
        if "b-gone" in path:
            raise FileNotFoundError(path)
        return real(path)

    monkeypatch.setattr(os.path, "getmtime", getmtime)
    assert go(root, "", prompts=[TICKETS])["arg"] == f"{new}/01-new.md"


def test_next_after_implement_walks_the_tickets_in_order(root):
    issues = tickets(root, "01-a.md", "02-b.md", "03-notes.txt")
    r = go(root, "", prompts=[flow("implement", f"{issues}/01-a.md please, test-first")])
    assert (r["name"], r["kind"], r["fresh"]) == (NS + "implement", "next", True)
    assert (r["arg"], r["why"]) == (f"{issues}/02-b.md", "#02 is next")
    r = go(root, "", prompts=[flow("implement", f"{issues}/02-b.md")])
    assert (r["name"], r["arg"], r["fresh"]) == (NS + "retro", "", False)
    assert r["why"] == "look back: what would have made this easier"


@pytest.mark.parametrize("prompt", [flow("implement", "the digest card"), flow("implement"),
                                    flow("implement-spec"), flow("diagnosing-bugs", "the empty TURNS tab")])
def test_next_retro(root, prompt):
    r = go(root, "", prompts=[prompt])
    assert (r["name"], r["kind"], r["auto"], r["fresh"]) == (NS + "retro", "next", False, False)
    assert r["why"] == "look back: what would have made this easier"


@pytest.mark.parametrize("status", ["error", "running", "stopped", None])
def test_next_only_after_a_turn_that_is_done(root, status):
    assert go(root, "", prompts=[GRILL], status=status) is None


@pytest.mark.parametrize("prompts", [[], ["fix the typo in the README"], ["/compact"],
                                     ["see /mattpocock-skills:grill-with-docs for details"],  # mentioned, not run
                                     [flow("research", "x")], [flow("tdd", "x")]])
def test_next_needs_a_flow_step_that_has_a_next(root, prompts):
    assert go(root, "", prompts=prompts) is None


# ── POST /local/route: the endpoint behind the SKILL ROUTER switch ────────────

def handler():
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    return h, box


def post(monkeypatch, body, *, off=(), listed=CMDS):
    """The endpoint's answer with every switch on except the keys in `off`.
    `listed` ({name: description}) is what the project's `/` list holds."""
    monkeypatch.setattr(aifeatures, "enabled", lambda key: key not in off)
    monkeypatch.setattr(commands, "available", lambda project=None: [
        {"name": n, "description": d, "scope": "plugin"} for n, d in listed.items()])
    h, box = handler()
    h._post_api("/local/route", body)
    assert box["code"] == 200
    return box["obj"]


@pytest.fixture
def repo(tmp_path, monkeypatch):
    """A project the endpoint can resolve (it lives under BASE_PATH) that never ran
    Returns it as the dashboard names projects."""
    base = os.path.realpath(str(tmp_path))
    monkeypatch.setattr(config, "BASE_PATH", base)
    os.mkdir(os.path.join(base, "app"))
    return "/app"


def test_endpoint_routes_a_prompt(monkeypatch):
    got = post(monkeypatch, {"text": FEATURE, "first": True})["route"]
    assert (got["name"], got["desc"], got["auto"]) == (NS + "grill-with-docs", CMDS[NS + "grill-with-docs"], True)
    assert post(monkeypatch, {"text": FEATURE})["route"]["auto"] is False  # not a first prompt: a suggestion


def test_endpoint_reads_the_flow_from_the_prompts_and_how_the_last_turn_ended(monkeypatch):
    body = {"text": "", "prompts": [GRILL], "last_status": "done"}
    assert post(monkeypatch, body)["route"]["name"] == NS + "to-spec"
    assert post(monkeypatch, {**body, "last_status": "error"}) == {"route": None}


def test_endpoint_reads_the_context_size(monkeypatch):
    body = {"text": "", "prompts": [GRILL], "last_status": "done", "ctx_tokens": 162_000}
    assert post(monkeypatch, body)["route"]["name"] == "compact"


def test_endpoint_offers_only_what_the_project_lists(monkeypatch):
    assert post(monkeypatch, {"text": FEATURE}, listed={"compact": "x"}) == {"route": None}


def test_endpoint_lists_the_commands_for_the_resolved_project(monkeypatch, repo, tmp_path):
    asked = []

    def available(project=None):
        asked.append(project)
        return []
    monkeypatch.setattr(aifeatures, "enabled", lambda key: True)
    monkeypatch.setattr(commands, "available", available)
    h, _ = handler()
    h._post_api("/local/route", {"project": repo, "text": FEATURE})
    h._post_api("/local/route", {"project": "/elsewhere", "text": FEATURE})   # not a project here
    assert asked == [os.path.join(os.path.realpath(str(tmp_path)), "app"), None]


def test_endpoint_reads_the_sessions_own_checkout(monkeypatch, repo, tmp_path):
    # a worktree session's tickets, tracker and project skills are in its checkout, not the project's
    base = os.path.realpath(str(tmp_path))
    wt = os.path.join(base, ".worktrees", "app", "feat")
    os.makedirs(wt)
    listed, picked = [], []
    monkeypatch.setattr(aifeatures, "enabled", lambda key: True)
    monkeypatch.setattr(commands, "available", lambda project=None: listed.append(project) or [])
    monkeypatch.setattr(route, "pick", lambda text, **kw: picked.append(kw["root"]))
    h, _ = handler()
    for cwd in (wt, os.path.dirname(base), os.path.join(base, "gone"), None):  # inside; outside BASE_PATH; missing; none
        h._post_api("/local/route", {"project": repo, "cwd": cwd, "text": FEATURE})
    app = os.path.join(base, "app")
    assert listed == picked == [wt, app, app, app]


@pytest.mark.parametrize("off", [("router",), ("router", *route.SUBS)])
def test_router_off_routes_nothing(monkeypatch, off):
    assert post(monkeypatch, {"text": FEATURE, "first": True}, off=off) == {"route": None}


@pytest.mark.parametrize("sub", route.SUBS)
def test_each_sub_switch_that_is_off_reaches_pick(monkeypatch, sub):
    seen = []
    monkeypatch.setattr(route, "pick", lambda text, **kw: seen.append(kw["off"]))
    post(monkeypatch, {"text": FEATURE}, off={sub})
    post(monkeypatch, {"text": FEATURE})
    assert seen == [frozenset({sub}), frozenset()]


def test_the_sub_switches_pick_obeys_are_the_registered_ones():
    """A key in route.SUBS that aifeatures doesn't register would read as off for
    good, and the rule behind it would never fire."""
    subs = {f["key"] for f in aifeatures.FEATURES if f.get("parent") == "router"}
    assert subs - {"ticketruns"} == set(route.SUBS)   # TICKETS is the scheduler's (bridge/tickets.py), no rule's


@pytest.mark.parametrize("prompts", [[None, flow("grill-with-docs", "x")], [GRILL, None, 7]])
def test_prompts_that_are_not_strings_are_dropped(monkeypatch, prompts):
    body = {"text": "", "prompts": prompts, "last_status": "done"}
    assert post(monkeypatch, body)["route"]["name"] == NS + "to-spec"


def test_a_rule_that_raises_is_no_route(monkeypatch):
    def boom(*args, **kwargs):
        raise RuntimeError("boom")
    monkeypatch.setattr(route, "pick", boom)
    assert post(monkeypatch, {"text": FEATURE}) == {"route": None}


def test_a_body_that_cannot_be_read_is_no_route(monkeypatch):
    assert post(monkeypatch, {"text": FEATURE, "prompts": 5}) == {"route": None}


# ── bridge/runner.py: the two run-time fixes every surface's turn picks up ─────

def test_grill_note_rides_every_run_while_grill_cards_is_on(monkeypatch):
    monkeypatch.setattr(aifeatures, "enabled", lambda key: key == "grillcards")
    prompt = runner._compose_system_prompt()
    assert "one AskUserQuestion card" in prompt
    assert runner._GRILL_NOTE in prompt
    assert prompt == runner._compose_system_prompt()    # constant per run: the prompt cache


def test_grill_note_is_left_out_while_grill_cards_is_off(monkeypatch):
    monkeypatch.setattr(aifeatures, "enabled", lambda key: False)
    assert runner._GRILL_NOTE not in runner._compose_system_prompt()


ATTACHED = "The user attached file(s); open them before responding: /u/a.png"


def test_with_images_keeps_a_leading_command_first():
    """Review Focus 1: the CLI runs a skill only when the prompt starts with its /name."""
    got = runner._with_images("/mattpocock-skills:grill-with-docs add X", ["/u/a.png"])
    assert got.startswith("/mattpocock-skills:grill-with-docs ")
    assert "/u/a.png" in got
    assert got.endswith("add X")


@pytest.mark.parametrize("prompt, want", [
    ("hi", ATTACHED + "\n\nhi"),                                             # a plain prompt: the note first, as ever
    ("/mattpocock-skills:retro", "/mattpocock-skills:retro " + ATTACHED),    # a bare command has no args to trail
    ("/compact keep this\n\nand this",
     "/compact " + ATTACHED + "\n\nkeep this\n\nand this"),                  # the args stay as typed
    ("/compact\nkeep this", "/compact " + ATTACHED + "\n\nkeep this"),       # the command may end at a newline
])
def test_with_images_exact_shapes(prompt, want):
    assert runner._with_images(prompt, ["/u/a.png"]) == want


@pytest.mark.parametrize("paths", [None, []])
def test_with_images_without_files_returns_the_prompt_as_typed(paths):
    prompt = "/mattpocock-skills:grill-with-docs add X"
    assert runner._with_images(prompt, paths) == prompt
