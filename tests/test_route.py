"""route: the rules that pick Matt Pocock's /command for a prompt, and the next
step once a flow step ends. Facts in, one route out: no model, no network, only a
tmp project dir for the two things the rules look at (docs/agents/issue-tracker.md
and .scratch/*/issues/*.md).
Run: python -m pytest tests/test_route.py -v"""

import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge import route  # noqa: E402

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
    """A project that ran /setup-matt-pocock-skills: the tracker file the setup nudge looks for."""
    f = tmp_path / "docs" / "agents" / "issue-tracker.md"
    f.parent.mkdir(parents=True)
    f.write_text("tracker\n")
    return str(tmp_path)


@pytest.fixture
def bare(tmp_path):
    """A project that never ran it."""
    return str(tmp_path)


def go(root, text="", *, prompts=(), status="done", ctx=None, first=False, cmds=CMDS, off=()):
    return route.pick(text, prompts=list(prompts), last_status=status, ctx_tokens=ctx,
                      first=first, cmds=cmds, root=root, off=frozenset(off))


def tickets(root, *names, feat="feat", at=None):
    """What /to-tickets leaves behind: .scratch/<feat>/issues/<names>. Returns the dir, relative to root."""
    rel = f".scratch/{feat}/issues"
    d = os.path.join(root, rel)
    os.makedirs(d)
    for n in names:
        open(os.path.join(d, n), "w").close()
    if at:
        os.utime(d, (at, at))
    return rel


def test_constants():
    assert route.SMART_ZONE == 150_000
    assert route.SUBS == ("askmatt", "autopick", "nextstep", "tickets", "smartzone", "setupnudge")
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


# ── Ask Matt ──────────────────────────────────────────────────────────────────

def test_ask_matt_when_nothing_fits_a_long_prompt(root):
    r = go(root, LONG, first=True)
    assert (r["name"], r["kind"], r["auto"]) == (NS + "ask-matt", "ask", False)
    assert r["why"] == "no clear fit: /ask-matt reads the whole map"
    assert r["alts"] == []


def test_ask_matt_starts_at_two_hundred_characters(root):
    assert go(root, "q" * 199) is None
    assert go(root, "q" * 200)["kind"] == "ask"


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
    LONG,                                     # a long answer is not an Ask Matt prompt
])
def test_inside_a_grill_flow_answers_do_not_route(root, prompt, text):
    assert go(root, text, prompts=[prompt]) is None


@pytest.mark.parametrize("prompt", [GRILL, flow("grill-me", "the digest")])
def test_wait_what_fires_inside_a_grill_flow(root, prompt):
    # Matt: use it mid-conversation, inside any other skill
    r = go(root, "huh?", prompts=[prompt])
    assert (r["name"], r["kind"], r["auto"]) == (NS + "wait-what", "start", False)
    assert go(root, "huh?", prompts=[prompt], status="error") is None


@pytest.mark.parametrize("text", ["ok, build it", "go ahead", "Okay. implement this", "let's build it", "Go!"])
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


# ── setup nudge ───────────────────────────────────────────────────────────────

def test_setup_nudge(bare):
    r = go(bare, FEATURE, first=True)
    assert (r["name"], r["kind"], r["auto"]) == (NS + "setup-matt-pocock-skills", "setup", False)
    assert (r["fresh"], r["arg"]) == (False, "")
    assert r["why"] == "once per repo: tracker, labels, docs (then /grill-with-docs)"
    assert r["why"].endswith("(then /grill-with-docs)")


@pytest.mark.parametrize("text, skill", [
    ("write it up as a spec", "to-spec"),
    ("break this into tickets", "to-tickets"),
    ("triage the incoming issues from this week", "triage"),
    ("rewrite the whole thing from scratch", "wayfinder"),
])
def test_setup_nudge_before_each_engineering_route(bare, text, skill):
    r = go(bare, text)
    assert (r["name"], r["kind"]) == (NS + "setup-matt-pocock-skills", "setup")
    assert r["why"].endswith(f"(then /{skill})")


def test_setup_nudge_before_implement_and_the_next_step(bare):
    assert go(bare, "go ahead", prompts=[GRILL])["why"].endswith("(then /implement)")
    r = go(bare, "", prompts=[GRILL])
    assert (r["name"], r["kind"]) == (NS + "setup-matt-pocock-skills", "setup")
    assert r["why"].endswith("(then /to-spec)")


@pytest.mark.parametrize("text, kind, skill", [
    (BUG, "start", "diagnosing-bugs"),
    (REVIEW, "start", "code-review"),
    ("research how other bridges send push notifications", "start", "research"),
    (LONG, "ask", "ask-matt"),
])
def test_no_setup_nudge_for_the_rest(bare, text, kind, skill):
    r = go(bare, text)
    assert (r["name"], r["kind"]) == (NS + skill, kind)


def test_no_setup_nudge_when_the_project_is_unknown():
    assert go(None, FEATURE, first=True)["name"] == NS + "grill-with-docs"


def test_setup_nudge_missing_from_the_pack_leaves_the_route(bare):
    only = {k: v for k, v in CMDS.items() if k != NS + "setup-matt-pocock-skills"}
    assert go(bare, FEATURE, cmds=only)["name"] == NS + "grill-with-docs"


# ── auto ──────────────────────────────────────────────────────────────────────

def test_auto_needs_a_first_prompt_or_a_flow_step_that_just_ended(root):
    step = flow("research", "how others do it")
    assert go(root, FEATURE, first=True)["auto"] is True
    assert go(root, FEATURE, prompts=[step])["auto"] is True                    # right after a flow step ended
    assert go(root, FEATURE, prompts=[step], status="error")["auto"] is False   # it did not end well
    assert go(root, FEATURE, prompts=[step, "and the old ones"])["auto"] is False  # a follow-up inside the thread
    assert go(root, FEATURE, prompts=["fix the typo in the README"])["auto"] is False  # no flow command at all


# ── the six switches ──────────────────────────────────────────────────────────

def test_off_askmatt(root):
    assert go(root, LONG, off={"askmatt"}) is None


def test_off_autopick(root):
    r = go(root, FEATURE, first=True, off={"autopick"})
    assert (r["name"], r["auto"]) == (NS + "grill-with-docs", False)


def test_off_nextstep(root):
    assert go(root, "", prompts=[GRILL], off={"nextstep"}) is None
    assert go(root, FEATURE, off={"nextstep"})["name"] == NS + "grill-with-docs"  # typed routes stay


def test_off_tickets(root):
    issues = tickets(root, "01-a.md", "02-b.md")
    r = go(root, "", prompts=[TICKETS], off={"tickets"})
    assert (r["name"], r["arg"], r["fresh"]) == (NS + "implement", "", False)
    assert r["why"] == "pick the first ticket with no blockers"
    r = go(root, "", prompts=[flow("implement", f"{issues}/01-a.md")], off={"tickets"})
    assert r["name"] == NS + "retro"  # after an implement, straight to the look back


def test_off_smartzone(root):
    assert go(root, "", prompts=[GRILL], ctx=162_000, off={"smartzone"})["name"] == NS + "to-spec"


def test_off_setupnudge(bare):
    assert go(bare, FEATURE, off={"setupnudge"})["name"] == NS + "grill-with-docs"


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


def test_next_compact_comes_before_the_setup_nudge(bare):
    assert go(bare, "", prompts=[GRILL], ctx=162_000)["name"] == "compact"


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
    assert r["arg"] == ".scratch/feat/issues/01-a.md"
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


def test_next_after_tickets_with_no_scratch_dir(root):
    r = go(root, "", prompts=[TICKETS])
    assert (r["name"], r["arg"], r["fresh"]) == (NS + "implement", "", False)
    assert r["why"] == "pick the first ticket with no blockers"
    assert go(root, "", prompts=[TICKETS], ctx=162_000)["name"] == "compact"  # not fresh: it can compact


def test_next_with_an_unknown_project_has_no_tickets():
    r = go(None, "", prompts=[TICKETS])
    assert (r["name"], r["arg"], r["fresh"]) == (NS + "implement", "", False)
    assert go(None, "", prompts=[flow("implement", ".scratch/feat/issues/01-a.md")])["name"] == NS + "retro"


def test_next_after_tickets_with_an_empty_issues_dir(root):
    tickets(root)
    r = go(root, "", prompts=[TICKETS])
    assert (r["arg"], r["fresh"]) == ("", False)


def test_next_with_a_root_that_does_not_exist_has_no_tickets():
    # nothing there can hold a tracker either, so the setup nudge is off to let the step through
    r = go("/no/such/dir", "", prompts=[TICKETS], off={"setupnudge"})
    assert (r["name"], r["arg"], r["fresh"]) == (NS + "implement", "", False)


def test_next_after_implement_when_the_ticket_dir_is_gone_is_the_retro(root):
    assert go(root, "", prompts=[flow("implement", ".scratch/gone/issues/01-a.md")])["name"] == NS + "retro"


def test_next_after_implement_with_a_nul_byte_in_the_ticket_path_is_the_retro(root):
    # the path comes from a prompt, and os.listdir raises ValueError on a NUL byte
    assert go(root, "", prompts=[flow("implement", ".scratch/a\x00b/issues/01-a.md")])["name"] == NS + "retro"


def test_next_after_tickets_in_a_root_with_glob_characters(tmp_path):
    proj = str(tmp_path / "proj[1]")
    issues = tickets(proj, "01-a.md", "02-b.md")
    r = go(proj, "", prompts=[TICKETS], off={"setupnudge"})  # the tracker is not what is under test
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


@pytest.mark.parametrize("status", ["error", "running", None])
def test_next_only_after_a_turn_that_is_done(root, status):
    assert go(root, "", prompts=[GRILL], status=status) is None


@pytest.mark.parametrize("prompts", [[], ["fix the typo in the README"], ["/compact"],
                                     ["see /mattpocock-skills:grill-with-docs for details"],  # mentioned, not run
                                     [flow("research", "x")], [flow("tdd", "x")]])
def test_next_needs_a_flow_step_that_has_a_next(root, prompts):
    assert go(root, "", prompts=prompts) is None
