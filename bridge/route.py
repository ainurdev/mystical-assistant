"""Pick Matt Pocock's /command for a prompt, with rules and no model call.

mattpocock/skills splits its skills by who may start them. The user-invoked ones
(grill-with-docs, to-spec, to-tickets, implement, triage, wayfinder, retro, ...)
run only when a prompt *starts* with /name, so Claude can never reach them on its
own. The model-invoked ones (tdd, diagnosing-bugs, research, prototype, ...) it may
reach by description, but in the 2026-11-04 bench Matt's skills fired 0 of 3 times
on unrouted prompts. Mystical sees a prompt before Claude does, so this is the one
place that can put the right command in front. The composer draws the pick where
it will be sent, and once a flow step ends it offers the next one.

Why rules and not a model call. pick() runs after every ~400 ms typing pause and
again each time a turn ends, so it has to be free and instant. A haiku one-shot per
prompt costs about 36k tokens and 8-15 s (bridge/relevance.py), and every routed
prompt would wait on it. The patterns follow ask-matt's own map. A miss costs
nothing (no ghost, the prompt goes as typed) and a wrong hit costs one keystroke:
an auto pick is removed with Backspace, a suggestion is ignored.

Inside a grill the typed text is an answer to the interview: only the moves that
follow a grill fire (to-spec, to-tickets, implement, prototype, handoff) and
wait-what, which Matt means for use inside any other skill.

Next steps stay at a boundary. A step is offered only while its flow command is the
newest prompt (a /compact doesn't count): after a typed reply the flow has moved on
and the ghost would be stale. A grill is the exception, since its interview runs over
several typed turns and ends on one. /compact first is stricter still: the command
must be the very last prompt, because mid-interview is not a boundary and right after
a /compact the context size can still read stale.

Why auto is limited to the safe set. An auto pick goes into the text without a tap,
so it has to be cheap to be wrong about. grill-with-docs, diagnosing-bugs,
research, prototype and tdd stay in this session and leave nothing but local files.
Whatever publishes or hands work on (to-spec, to-tickets, triage, wayfinder,
handoff, implement-spec) or builds (implement) is a dashed suggestion the user
takes with Tab. Even the safe set goes in by itself only on a session's first
prompt or right after a flow step ended: a typed reply deeper in a thread is an
answer, and prefixing a command to it would change what the user said.

Names. The CLI lists the pack as mattpocock-skills:<skill> and has no bare alias,
and its builtin code-review is a different skill, so _resolve never falls back to a
bare name. A skill that isn't listed is skipped, so with the pack off pick() offers
nothing.

A "flow command" is a prompt that starts with /mattpocock-skills:. Flow state is
read from the prompts the caller passes. Pure apart from two lookups under `root`:
.mystical/tickets/*/*.md. Stdlib only.
"""

import glob
import os
import re
from typing import NamedTuple

SMART_ZONE = 150_000  # tokens: past it, a phase boundary offers /compact first
# The sub-switches pick() obeys, each named in `off` when it is turned off. AUTO NEXT
# STEPS isn't one: off, the step doesn't start by itself, so the ghost offers it.
SUBS = ("autopick", "smartzone")

_NS = "mattpocock-skills:"
_MIN = 12      # a start rule needs this many characters to go on
_AUTO = frozenset({"grill-with-docs", "diagnosing-bugs", "research", "prototype", "tdd"})
_GRILLS = ("grill-with-docs", "grill-me")
_IN_GRILL = frozenset({"to-spec", "to-tickets", "implement", "prototype", "handoff"})


def _re(pattern):
    return re.compile(pattern, re.I)


# The grill row's leading verbs: a prompt that starts with one asks for something new.
_FEATURE = (r"(add|build|create|make|implement|i want|we need|let'?s|can we|could we|should we"
            r"|how (can|could|should) we)\b")

# (skill, pattern, why), tried in this order; the first hit wins. code-review sits
# ahead of diagnosing-bugs so "review why it fails" is a review. A hard bug signal is
# a bug whatever the prompt asks for; a weak one only when the prompt doesn't start
# like a feature: "add retry when the upload fails" is one, and auto-picking the
# wrong flow is the costliest miss.
_RULES = (
    ("code-review", _re(r"\breview\b"), "review the diff against the standards and the spec"),
    ("diagnosing-bugs",
     _re(r"traceback|exception|error:|stack trace|\bcrash(es|ed)\b|\bbroken\b|doesn'?t work|not working"
         r"|^(?!" + _FEATURE + r")[\s\S]*?(\bcrash|\bfail(s|ed|ing)?\b|regression|find out why"
         r"|\b(is|are|got) (empty|missing|stuck|wrong)\b)"),
     "something's broken: get a failing loop first"),
    ("triage", _re(r"\btriage\b|incoming issues|bug reports"), "sort what came in before building"),
    ("wayfinder", _re(r"from scratch|greenfield|new app|rewrite (the|it all)|migrate (the whole|everything)"),
     "too big for one session: map it first"),
    ("to-spec", _re(r"\bspec\b|\bprd\b|write (it|this) up"), "write the thread up as a spec"),
    ("to-tickets", _re(r"tickets|break (it|this) (down|into)|split (it|this) into"),
     "split it into tickets with blockers"),
    ("tdd", _re(r"test[- ]first|\btdd\b|red[- ]green"), "build it test-first, one slice at a time"),
    # Both only as a request: "rename the prototype field" and "write docs for X" are mentions.
    ("prototype",
     _re(r"^prototype\b|\bprototype (a|an|the|some|two|three|a few|\d+)\b|mock ?up|what should .{0,40} look like"),
     "answer it with throwaway code first"),
    ("research",
     _re(r"\bresearch\b|look up|(find|read) (the )?docs for|what'?s the latest|compare .{0,30} (to|with|vs)"),
     "read primary sources, leave a cited file"),
    ("improve-codebase-architecture", _re(r"architecture|refactor|tangled|deepen"),
     "find where the code wants deeper modules"),
    ("teach", _re(r"teach me|help me (learn|understand)"), "learn it over a few sessions"),
    ("handoff", _re(r"hand ?off|in a (new|fresh|another) session|for codex"), "write it down for the next session"),
    ("grill-with-docs", _re("^" + _FEATURE + r"|new feature"), "a new feature: settle it before building"),
)

# Two whole-message patterns, short by nature, so _MIN does not apply to them.
# wait-what sits between handoff and grill-with-docs in the table, but it matches
# nothing a row matches, so it is tried before them; _GO_AHEAD is tried only inside a
# grill flow, where the grill-with-docs row (which would also take "build it") is out.
# A bare "go" must be the whole message ("go with option B" is an answer). The \b guards
# only the three phrases: after "Go!" the end of the string is no word boundary.
_WAIT_WHAT = _re(r"^(what\??|huh\??|wait,? what|i don'?t (get|understand)( it| that)?)\W*$")
_GO_AHEAD = _re(r"^((ok(ay)?|yes|yep|sure|sounds good|great|perfect)[,.!]?\s+)?(go( ahead)?\W*$"
                r"|(implement (it|this)|build (it|this)|let'?s (build|do) (it|this))\b)")

# The reason each skill is offered for, wherever it shows up: the table's, plus the
# skills that only a whole-message pattern, an alternate or a next step brings in.
_WHY = {skill: why for skill, _, why in _RULES} | {
    "wait-what": "re-pitch the last answer in plain words",
    "implement": "build it here, test-first",
    "grill-me": "the same interview, without touching the docs",
    "retro": "look back: what would have made this easier",
}


def _pairs(*skills):
    return tuple((s, _WHY[s]) for s in skills)


_ALTS = {"grill-with-docs": _pairs("prototype", "implement", "grill-me"), "diagnosing-bugs": _pairs("tdd")}

_FLOW = re.compile("/" + re.escape(_NS) + r"([\w-]+)\s*(.*)", re.S)
_COMPACT = re.compile(r"/compact\b")
_TICKET = re.compile(r"\.mystical/tickets/[^/\s]+/[^/\s]+\.md")
_NN = re.compile(r"\d+-")


class _Step(NamedTuple):
    """What to offer, before it is checked against the commands that are listed."""
    skill: str
    kind: str
    why: str
    arg: str = ""
    fresh: bool = False
    alts: tuple = ()  # (skill, why) pairs


def _resolve(skill, cmds):
    """The command name to send for `skill`, or None when it isn't listed. compact
    is the CLI's own; everything else is the pack's, never a bare name."""
    name = skill if skill == "compact" else _NS + skill
    return name if name in cmds else None


def _last_flow(prompts):
    """(skill, rest of the prompt) of the newest flow command, else None. A /compact
    prompt is not one, so it never hides the step before it."""
    # shortcut: only the prompts passed in are read (a session's last 6), so a flow
    # command older than that is forgotten and a grill interview past 6 prompts starts
    # routing its answers; upgrade when interviews that long show up, by having the
    # caller pass the session's last flow command along with the prompts.
    for p in reversed(prompts):
        m = _FLOW.match(p)
        if m:
            return m.group(1), m.group(2)
    return None


def _flow_done(prompts, last_status):
    """True when the last prompt was a flow command and its turn finished."""
    return last_status == "done" and bool(prompts) and _FLOW.match(prompts[-1]) is not None


def _boundary(prompts):
    """True when the newest prompt that isn't a /compact is a flow command: the turn
    that just ended is its own, so its next step is due and not a stale ghost."""
    newest = next((p for p in reversed(prompts) if not _COMPACT.match(p)), "")
    return _FLOW.match(newest) is not None


def _hits(t, grill, done):
    """(skill, why) for every rule the typed text hits, in the order they are tried."""
    if grill and _GO_AHEAD.search(t):
        yield "implement", _WHY["implement"]
    if done and _WAIT_WHAT.search(t):
        yield "wait-what", _WHY["wait-what"]
    if len(t) >= _MIN:
        for skill, pattern, why in _RULES:
            if (skill in _IN_GRILL or not grill) and pattern.search(t):
                yield skill, why


def _typed(t, last, done, cmds):
    """The first installed rule the typed text hits, else None."""
    grill = last is not None and last[0] in _GRILLS
    for skill, why in _hits(t, grill, done):
        if _resolve(skill, cmds):
            return _Step(skill, "start", why, alts=_ALTS.get(skill, ()))
    return None


def _md(path):
    """The ticket files in a directory, in file order: NN-*.md, so the SPEC.md beside them is none."""
    try:
        # Ticket order is name order: it relies on Matt's zero-padded NN- names (01-, 02-, ... 10-).
        return sorted(f for f in os.listdir(path) if f.endswith(".md") and _NN.match(f))
    except (OSError, ValueError):  # ValueError: a NUL byte in a path that came from a prompt
        return []


def _mtime(path):
    """A directory's mtime; 0, the oldest, for one that vanished since it was listed."""
    try:
        return os.path.getmtime(path)
    except OSError:
        return 0


def _first_ticket(root):
    """The first ticket in the newest .mystical/tickets/* dir, relative to root, else None."""
    dirs = [d for d in glob.glob(os.path.join(glob.escape(root), ".mystical", "tickets", "*")) if os.path.isdir(d)]
    if not dirs:
        return None
    newest = max(sorted(dirs), key=_mtime)
    names = _md(newest)
    return os.path.relpath(os.path.join(newest, names[0]), root) if names else None


def _next_ticket(root, current):
    """The ticket after `current` (relative to root) in its directory, else None."""
    d, name = os.path.split(current)
    later = [f for f in _md(os.path.join(root, d)) if f > name]
    return f"{d}/{later[0]}" if later else None


def _num(path):
    """The NN of .../NN-slug.md."""
    name = os.path.basename(path)
    return re.match(r"\d*", name).group() or name


def _next(last, root, ticketruns=False):
    """The step after the flow command `last`, or None when that command has none.
    With TICKETS on (`ticketruns`) the bridge builds the tickets, so no ticket step."""
    skill, rest = last
    tickets = bool(root)
    if skill in _GRILLS:
        return _Step("to-spec", "next", "many sessions of work: write it up",
                     alts=(("implement", "or build it here if one session holds it"),))
    if skill == "to-spec":
        return _Step("to-tickets", "next", _WHY["to-tickets"])
    if ticketruns and (skill == "to-tickets" or skill == "implement" and _TICKET.search(rest)):
        return None
    if skill == "to-tickets":
        # shortcut: tickets are walked in file order, one at a time. That honours the
        # blockers-first numbering but ignores a parallel frontier, so upgrade when
        # tickets run side by side.
        first = _first_ticket(root) if tickets else None
        if first:
            return _Step("implement", "next", f"#{_num(first)} has no blockers", first, True)
        return _Step("implement", "next", "pick the first ticket with no blockers")
    if skill == "implement":
        m = _TICKET.search(rest)
        following = _next_ticket(root, m.group()) if tickets and m else None
        if following:
            return _Step("implement", "next", f"#{_num(following)} is next", following, True)
    if skill in ("implement", "implement-spec", "diagnosing-bugs"):
        return _Step("retro", "next", _WHY["retro"])
    return None


def _route(step, cmds, auto=False):
    """The result dict for `step`, or None when its command isn't listed."""
    name = _resolve(step.skill, cmds)
    if name is None:
        return None
    alts = [{"name": n, "desc": cmds[n], "why": why} for s, why in step.alts if (n := _resolve(s, cmds))]
    return {"name": name, "desc": cmds[name], "why": step.why, "auto": auto, "arg": step.arg,
            "fresh": step.fresh, "kind": step.kind, "alts": alts}


def pick(text: str, *, prompts: "list[str]", last_status: "str | None", ctx_tokens: "int | None",
         first: bool, cmds: "dict[str, str]", root: "str | None",
         off: "frozenset[str]" = frozenset(), ticketruns: bool = False) -> "dict | None":
    """The one route to offer for `text` (what is in the composer), or None.

    An empty `text` asks for the next step after a turn that finished. `prompts` are
    the session's last prompts, oldest first; `last_status` is how the last turn
    ended; `first` is True before the session's first turn; `cmds` maps every listed
    command name to its description; `root` is the absolute path of the session's
    checkout (the project's, or its worktree); `off` holds the sub-switches (SUBS)
    that are turned off; `ticketruns` is the TICKETS switch.

    Returns {"name", "desc", "why", "auto", "arg", "fresh", "kind", "alts"}: kind is
    start | next, `arg` goes after the name, `fresh` means open it in a
    new session, and `alts` (at most 3) are {"name", "desc", "why"}.
    """
    t = text.strip()
    if t.startswith("/"):
        return None
    last = _last_flow(prompts)
    done = last_status == "done"
    # No text asks for the next step. It belongs to the turn of the flow command that
    # just ended, so a typed reply since retires it, except in a grill, whose interview
    # spans typed turns.
    if t:
        step = _typed(t, last, done, cmds)
    elif done and last and (last[0] in _GRILLS or _boundary(prompts)):
        step = _next(last, root, ticketruns)
    else:
        step = None
    if step is None or _resolve(step.skill, cmds) is None:
        return None
    skill = step.skill
    # Two things can stand in for the step, compact first: past the smart zone a next
    # step is preceded by /compact, unless it opens a fresh session (which starts clean)
    # or the flow command is not the very last prompt (mid-interview is no boundary, and
    # right after a /compact ctx_tokens can still read stale). Skipped when /compact
    # isn't listed.
    if (step.kind == "next" and not step.fresh and "smartzone" not in off and (ctx_tokens or 0) >= SMART_ZONE
            and _flow_done(prompts, last_status)):
        compact = _route(_Step("compact", "next", f"{ctx_tokens // 1000}k is past the {SMART_ZONE // 1000}k smart zone",
                               f"keep the decisions so far; next: /{skill}"), cmds)
        if compact:
            return compact
    auto = (step.kind == "start" and skill in _AUTO and "autopick" not in off
            and (first or _flow_done(prompts, last_status)))
    return _route(step, cmds, auto)
