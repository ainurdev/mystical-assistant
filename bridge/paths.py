"""SKILL PATHS: Matt Pocock's skill pack, loaded into every run while the
`router` AI switch is on.

The pack is vendored under bridge/skills/mattpocock instead of installed as a
plugin: one switch turns it on, there is nothing to install per account, and
every account runs the same files. `claude --plugin-dir` loads it per run.

The flag is added inside runner._base_cmd, not passed as extra_args, because
resumed, queued and recovered runs lose extra_args and would drop the pack
mid-session. Checked by hand: when the plugin is also installed, the CLI logs
'from --plugin-dir overrides installed version' and runs one copy, so the
installed one needs no disabling.

The routing instructions ride the system prompt as pack_text(), built from the FLOWS
settings alone (NO KIND, the flows that are on, their grills): the appended prompt sits
after the last cache breakpoint, so text that varied by turn would re-write the whole
block at cache-write price. It changes only when a setting does. The switch is read every
run, so flipping it applies from the next turn; only the session's origin is
decided once (pack_for) and kept, like the Rivendell note. Unattended runs (Rivendell
jobs, device runs) never get the pack or the plugin: nobody is there to answer a
grill or press a step button, so a path would stall.

The paths are the six Flows (ADR 0003): DESIGN, BUILD, REFACTOR, FIX, SHIP and ASK,
plus `one` for a single skill and for ticket and merge sessions. DESIGN and BUILD each
come as tickets (the flow's id) or here (`-here`), and the grill's StepDone choice
picks, as feature and feature-here did. DESIGN's design step is /design-first, told
that building is the next step's job, so its Approve is a StepDone. SHIP and ASK are
one step, the turn itself, which ends at its clean end like a PONYTAIL step. Records
and SetPath calls from before carry the old names (OLD); they load as their flow.

Flow state (which path a session is on, which stations are done) is a small JSON
file, flows.json, beside the bridge DB, written atomically like waits.json. It is
a file rather than a table so a path survives a bridge restart without a schema
change, and a worktree's pinned BRIDGE_DB keeps its flows off the live ones.
step_done is idempotent per turn_id: a turn can be retried, resumed or replayed
after a restart, and the same turn must never advance the path twice. The turn
that finished a station is remembered (`last`) and a repeat returns the same answer;
a resume nudge's turn counts as the turn it resumes. A turn sent as
/mattpocock-skills:x keeps the path only when x is its next station, else x's own
path replaces it (on_turn_start), and its StepDone marks x's station: an old path
never takes over an unrelated step. The step StepDone records starts once (`next`
`started`), at the first clean end of its turn or of a resume of it, or when AUTO is
released. No auto step commits to the default branch: build-here, and a FIX on it,
move the session into a worktree of its own first (flowbranch).

REVIEW and AUDIT are the ponytail plugin's /ponytail-review and /ponytail-audit, so they
are stations only while the PONYTAIL switch is on (its plugin is told `off` otherwise,
and the prompt box hides the same two verbs). REVIEW reads the work this path did and
follows the work that makes a diff (build here, FIX's fix); AUDIT reads the whole repo
and ends the paths that change a lot of it. On ticket paths each ticket reviews its own
diff before its StepDone (tickets._prompt), and the REVIEW after MERGE is the council's
(below): the same word, told apart by its skill (None there). Ponytail's skills know nothing of
StepDone, so the clean end of a turn sent as their command, while the path is on that
step, is the step's end (_end_pony_step); one that calls StepDone anyway moves once.

A session may override three SETTINGS switches for itself, from the prompt box's FLOW
chip: AUTO NEXT STEPS, AUTO PICKS and SMART ZONE (OPTIONS). The overrides live in the
flow record and outlive a new path in the same session; a new session follows SETTINGS.
A record from before them kept `auto`, True by default and False once held: a held one
loads as an override of AUTO NEXT STEPS. skip_to marks the steps before a target done
and `skipped`, sparing the one a running turn works on, then the target starts as any
next step would.

REVIEW follows MERGE on the paths that merge tickets, while REVIEW AFTER MERGE and
TICKETS are on. It has no skill and no turn here: the council reads the merged work in
the merge session (tickets.start_review), and its pass is the step's end
(tickets.council_passed, then advance). A council that stops leaves the step open, and
it waits on you. Whether a flow has the step is settled when its MERGE ends, so
shipping the step, or switching it later, never puts one into a flow already past
MERGE. stations() gives the steps as they stand, and FLOW draws those.
"""

import json
import os
import re
import sys
import threading
import time
from typing import NamedTuple

from bridge import aifeatures, config, store

PACK_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "skills", "mattpocock")


def on() -> bool:
    return aifeatures.enabled("router")

# The routing text's parts. pack_text() puts them together from the FLOWS settings.
_INTRO = "Skill paths. Matt Pocock's skills are loaded as /mattpocock-skills:<name>."
_ASK = ("On a prompt with no /command in front, before anything else (a tool call, a file read, a question), "
        "decide whether one of these paths fits it:")
# The flows Claude may pick, in order: what each is for, and its first skill (the grill's).
# SHIP and ASK are never Claude's: their one step is the turn itself.
_PICKS = {
    "design": ("a change to how something looks (a screen, a layout, a component) to draw before it is built",
               "Start grill-with-docs."),
    "build": ("a new feature or idea, however small (a new command, function, option or behaviour)",
              "Start grill-with-docs."),
    "fix": ("something broken, failing, empty or slow, or a question why something is broken",
            "Start diagnosing-bugs."),
    "refactor": ("tangled code or architecture work", "Start improve-codebase-architecture."),
}
# With the grill switched off (flowsettings): DESIGN starts at its design, BUILD builds here,
# started by the bridge at the turn's end so it moves onto its own branch first (claude_path).
_NO_GRILL = {
    "design": "Start the design-first skill (named just design-first, not mattpocock-skills:), then call SetPath with path design; when the user approves the design, "
              "call StepDone instead of building.",
    "build": "Don't start a skill or build in this turn: call SetPath with path build and end your turn; "
             "the build starts on its own branch when the turn ends.",
}
_ONE = ("- one: research, a prototype, a review, a PR or teaching. Start that one skill (research, prototype, "
        "code-review, pr, teach), always by its full name, e.g. mattpocock-skills:code-review, never a "
        "same-named skill from another plugin.")
_FIRST = ("If one fits, your first tool call is the Skill tool with that skill (mattpocock-skills:<name>). "
          "Don't explore, diagnose, build or ask questions before it: the skill does that. Don't wait for "
          "SetPath either: it is a deferred tool, so once the skill has started, load it with ToolSearch and "
          "call it with the path and a one-line why.")
_FIRST_SETPATH = " A path whose line says SetPath instead: load SetPath with ToolSearch and call it first."
_ROUTE_TAIL = [
    "A path's skill comes before the skills and modes this session injects: start it instead of superpowers "
    "brainstorming or systematic-debugging, and don't skip it for ponytail's smallest change or for a "
    "clarifying question (a grill asks those).",
    "If none fits (a question about how the code works, an edit spelled out exactly like a rename, a chat "
    "reply), just answer or do it, and start nothing.",
    'If the message begins "No path for this message.", start nothing.',
]
_STEPDONE = ('When you finish a step of a path and need nothing more from the user, make StepDone the last tool '
             'call of your turn: the next step starts when the turn ends (build-here on its own feature branch) '
             'and does its own work. After a grill, pass choice "here" if the work fits this one session, or '
             '"tickets" if it needs several. Never call StepDone while waiting on the user.')


def pack_text() -> str:
    """The routing text, from the FLOWS settings only: NO KIND, which of DESIGN, BUILD,
    REFACTOR and FIX are on, and their grills. Nothing per turn goes in, so the text, and
    the cache write it costs, change only when a setting does. AS TYPED keeps the StepDone line."""
    from bridge import flowsettings   # local import: flowsettings reads PATHS
    if flowsettings.nokind() == "typed":
        return "\n".join([_INTRO, _STEPDONE])
    lines, setpath = [], False
    for fl, (what, start) in _PICKS.items():
        if not flowsettings.flow_on(fl):
            continue
        if fl in _NO_GRILL and not flowsettings.steps(fl)["grill"]:
            start, setpath = _NO_GRILL[fl], setpath or fl == "build"
        lines.append(f"- {fl}: {what}. {start}")
    return "\n".join([_INTRO, _ASK, *lines, _ONE, _FIRST + (_FIRST_SETPATH if setpath else ""),
                      *_ROUTE_TAIL, _STEPDONE])


# claude session id -> whether its origin gets the pack, decided at its first run.
_pack_ok: dict[str, bool] = {}


def pack_for(claude_session_id: str) -> str:
    """pack_text() for an attended run of this session while the switch is on, else "".
    The switch is read every run (it applies to the next turn); the origin once."""
    if not on():
        return ""
    if claude_session_id not in _pack_ok:
        try:
            origin = str((store.get_by_claude_session_id(claude_session_id) or {}).get("origin") or "")
        except Exception:  # noqa: BLE001 — the pack never blocks a turn
            origin = ""
        _pack_ok[claude_session_id] = not origin.startswith(("rivendell", "device-run"))
    return pack_text() if _pack_ok[claude_session_id] else ""


class Step(NamedTuple):
    station: str
    skill: "str | None"   # None = no skill: the agent just does it, or the turn itself (SHIP, ASK)
    who: str              # "you": it waits on you · "auto": it runs by itself
    fixed: bool           # always runs (the step its flow exists for), else it can be switched off
    own: bool = False     # runs in sessions of its own (a ticket set's BUILD and MERGE)


def _tickets(fixed: bool) -> list:
    """build as tickets: spec › tickets › build › merge, then the council's REVIEW."""
    return [Step("spec", "to-spec", "auto", fixed), Step("tickets", "to-tickets", "you", fixed),
            Step("build", None, "auto", fixed, True), Step("merge", None, "auto", fixed, True),
            Step("review", None, "auto", False)]


_GRILL, _RETRO = Step("grill", "grill-with-docs", "you", False), Step("retro", "retro", "auto", False)
_AUDIT = Step("audit", "ponytail-audit", "auto", False)
_REVIEW = Step("review", "ponytail-review", "auto", False)
_DESIGN = Step("design", "design-first", "you", True)   # ends at Approve: StepDone, not a build


def _here(fixed: bool) -> Step:
    return Step("build-here", "implement", "auto", fixed)


# The six Flows (ADR 0003), plus `one` (a single skill, ticket and merge sessions) outside
# this table. DESIGN and BUILD come as tickets (the id) or here (-here): the grill's
# StepDone choice picks, tickets without one. FLOWS names the six for the user.
PATHS: dict[str, list[Step]] = {
    "design": [_GRILL, _DESIGN, *_tickets(False), _RETRO],
    "design-here": [_GRILL, _DESIGN, _here(False), _REVIEW, _RETRO],
    "build": [_GRILL, *_tickets(True), _RETRO, _AUDIT],
    "build-here": [_GRILL, _here(True), _REVIEW, _RETRO, _AUDIT],
    "refactor": [Step("improve", "improve-codebase-architecture", "you", True), *_tickets(True)[1:],
                 _RETRO, _AUDIT],
    "fix": [Step("diagnose", "diagnosing-bugs", "auto", True), _REVIEW, _RETRO],   # diagnosing-bugs fixes and tests
    "ship": [Step("ship", None, "auto", True)],      # the turn itself: merge, check, clean up
    "ask": [Step("answer", None, "auto", True)],     # the turn itself
}
FLOWS = ("design", "build", "refactor", "fix", "ship", "ask")
# Names from before the six flows: records still carry them, and runs in flight across the update.
OLD = {"feature": "build", "feature-here": "build-here", "bug": "fix"}
# Stations that are the ponytail plugin's (PONYTAIL on only): the argument each one's turn gets.
_PONY = {"review": "the work on this path: this branch's commits since it left the default branch, "
                   "and anything uncommitted",
         "audit": ""}
_PONY_RE = re.compile(r"\s*/(?:ponytail:)?ponytail-(review|audit)\b")
# The SETTINGS switches one session may override from the prompt box (AUTO NEXT STEPS, AUTO PICKS, SMART ZONE).
OPTIONS = ("nextstep", "autopick", "smartzone")
_STORED = ("path", "skill", "by", "why", "at", "done", "skipped", "next", "overrides")

_lock = threading.Lock()
_cache: dict = {}  # session id -> flow; emptied by tests to simulate a reload


def _file() -> str:
    return os.path.join(os.path.dirname(config.BRIDGE_DB), "flows.json")


def _load_locked() -> None:
    if _cache:
        return
    try:
        with open(_file(), encoding="utf-8") as f:
            _cache.update(json.load(f) or {})
    except (OSError, ValueError):
        pass
    for f in _cache.values():   # from before overrides: `auto` was True, or False once held
        if "overrides" not in f:
            f["overrides"] = {} if f.pop("auto", True) else {"nextstep": False}
        f.setdefault("skipped", [])
        f["path"] = OLD.get(f["path"], f["path"])


def _save_locked() -> None:
    try:
        tmp = _file() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(_cache, f, indent=2)
        os.replace(tmp, _file())
    except OSError as e:
        print(f"[paths] persist failed: {e}", file=sys.stderr)


def review_on() -> bool:
    """REVIEW AFTER MERGE. Only a ticket set's MERGE leads to it, so TICKETS must be on too."""
    return aifeatures.enabled("ticketruns") and aifeatures.enabled("mergereview")


def _stations(flow: dict) -> list:
    if flow["path"] == "one":
        return [(flow["skill"], flow["skill"], "auto")]
    pony = aifeatures.enabled("ponytail")
    # Ponytail's steps only while PONYTAIL is on; the council's REVIEW has no skill.
    sts = [st[:3] for st in PATHS[flow["path"]] if pony or not (st.skill or "").startswith("ponytail-")]
    if not any(st == ("review", None, "auto") for st in sts):
        return sts
    # Whether the council's REVIEW follows is settled when MERGE ends: until then the switches
    # say, after it what the flow recorded (a flow past MERGE from before the step grows none).
    if "merge" in flow["done"]:
        has = "review" in flow["done"] or (flow.get("next") or {}).get("station") == "review"
    else:
        has = review_on()
    return sts if has else [st for st in sts if st[0] != "review"]


def _eff(flow: dict, key: str) -> bool:
    """A switch as this session has it: its own override, else SETTINGS'."""
    own = flow.get("overrides") or {}
    return bool(own[key]) if key in own else aifeatures.enabled(key)


def set_path(session_id: str, path: str, why: str, by: str, skill: "str | None" = None,
             done: "list | None" = None) -> dict:
    """`done`: stations already behind it (a path joined mid-way)."""
    skill = (skill or "").removeprefix("mattpocock-skills:") or None   # the pack's full name, as pack_text() asks
    path = OLD.get(path, path)
    if path != "one" and path not in PATHS:
        raise ValueError(f"unknown path {path!r}")
    if path == "one" and not skill:
        raise ValueError("path 'one' needs a skill")
    with _lock:
        _load_locked()
        old = _cache.get(session_id) or {}
        own = dict(old.get("overrides") or {})   # the session's, not the path's
        # `at` names this path to its ticket set (flow_at): a path replaced in the same second must differ.
        _cache[session_id] = {"path": path, "skill": skill, "by": by, "why": why, "overrides": own,
                              "at": max(int(time.time()), (old.get("at") or 0) + 1), "done": list(done or []), "skipped": [],
                              "next": None, "last": None}
        _save_locked()
        return dict(_cache[session_id])


def claude_path(session_id: str, path: str, why: str, skill: "str | None", turn_id: str) -> dict:
    """SetPath: the path Claude picked. A DESIGN or BUILD whose grill is switched off
    goes as its here form with the grill behind it. DESIGN's design is this turn's work
    (pack_text tells Claude to start it); BUILD's build is recorded as the next step of
    this turn, so it starts at the turn's end and moves onto its own branch first, never
    building on the default branch inside the picking turn."""
    from bridge import flowsettings   # local import: flowsettings reads PATHS
    name = OLD.get(path, path)
    if name not in ("design", "build") or flowsettings.steps(name)["grill"]:
        return set_path(session_id, path, why, "claude", skill)
    f = set_path(session_id, name + "-here", why, "claude", None, ["grill"])
    if name == "build":
        turn = _carried(session_id, turn_id)[0] if turn_id else ""
        with _lock:
            _cache[session_id]["next"] = f["next"] = {"station": "build-here", "turn_id": turn, "started": False}
            _save_locked()
    return f


def restore(session_id: str, snap: "dict | None") -> None:
    """Put back what get() returned before a set_path (a run that was refused)."""
    if not snap:
        return
    with _lock:
        _load_locked()
        f = _cache.get(session_id)
        if f:
            f.update({k: v for k, v in snap.items() if k in _STORED})
            _save_locked()


def get(session_id: str) -> "dict | None":
    """The session's path; `auto` is AUTO NEXT STEPS as this session has it, and
    `stations` the path's steps as (station, skill, "you" | "auto")."""
    with _lock:
        _load_locked()
        f = _cache.get(session_id)
        if not f:
            return None
        return {**{k: f[k] for k in ("path", "by", "why", "at", "done", "next", "skill")},
                "auto": _eff(f, "nextstep"), "overrides": dict(f.get("overrides") or {}),
                "skipped": list(f.get("skipped") or []), "stations": [list(st) for st in _stations(f)]}


def pending(session_id: str) -> "tuple[str, str] | None":
    """(skill, argument) of the step this path waits to start, for the router."""
    f = get(session_id)
    nxt = (f or {}).get("next") or {}
    if not nxt or nxt.get("started"):
        return None
    skill = next((sk for st, sk, _ in f["stations"] if st == nxt["station"]), None)
    return (skill, _PONY.get(nxt["station"], "")) if skill else None


def set_option(session_id: str, key: str, on: "bool | None") -> None:
    """Override a SETTINGS switch for this session (None follows SETTINGS again).
    AUTO NEXT STEPS released with a step pending starts it now, or when a turn
    running here ends: never in the middle of one."""
    if key not in OPTIONS:
        raise ValueError(f"{key!r} isn't a switch a session sets")
    _set(session_id, lambda own: own.pop(key, None) if on is None else own.update({key: bool(on)}))


def stations(session_id: str) -> list:
    """The path's steps as they stand now, each [step, skill, "you" | "auto"]: what FLOW
    draws. Worked out on every read, never stored."""
    with _lock:
        _load_locked()
        f = _cache.get(session_id)
        return [list(st) for st in _stations(f)] if f else []


def set_auto(session_id: str, on: bool) -> None:
    """Hold or release AUTO for this session (the SESSION tab's switch)."""
    set_option(session_id, "nextstep", bool(on))


def reset(session_id: str) -> None:
    """Every switch follows SETTINGS again."""
    _set(session_id, lambda own: own.clear())


def _set(session_id: str, edit) -> None:
    run = store.running_turn_id(session_id)
    turn = _carried(session_id, run)[0] if run else None
    with _lock:
        _load_locked()
        f = _cache.get(session_id)
        if not f:
            return
        was = _eff(f, "nextstep")
        edit(f.setdefault("overrides", {}))
        on = _eff(f, "nextstep") and not was
        if on and turn and f["next"] and not f["next"].get("started"):
            f["next"]["turn_id"] = turn
        _save_locked()
    if on and not run:
        _go(session_id)


def skip_to(session_id: str, target: str) -> str:
    """Skip every step before `target` ("" = the rest of the path), sparing the one a
    running turn works on; `target` is then the next step and starts as one would.
    "" when done, else why not."""
    run = store.running_turn_id(session_id)
    turn = _carried(session_id, run)[0] if run else None
    with _lock:
        _load_locked()
        f = _cache.get(session_id)
        if not f:
            return "no path is running in this session"
        rest = [st for st, _, _ in _stations(f) if st not in f["done"]]
        if target and target not in rest:
            return f"{target!r} isn't a step still to come"
        until = rest.index(target) if target else len(rest)
        gone = rest[1 if run else 0:until]   # a running turn works on the first one
        f["done"] += gone
        f["skipped"] = list(f.get("skipped") or []) + gone
        if target:
            f["next"] = {"station": target, "turn_id": turn or "", "started": False}
        elif not run:
            f["next"] = None
        _save_locked()
    if target and not run:
        _go(session_id)
    return ""


_CMD = re.compile(r"\s*/mattpocock-skills:([\w-]+)")
# The first character of every resume nudge (recovery.CONTINUED and NUDGE, limits.NUDGE
# and SERVER_NUDGE, runner.RESUME_NUDGE, TIMEOUT_NUDGE and the AUTH ones, ladder's
# ACCOUNT_NUDGE), as goals._BRIDGE_PROMPTS reads them.
_RESUME = "⏮"


def _command(prompt: "str | None") -> "str | None":
    """x of a prompt that leads with /mattpocock-skills:x, else None."""
    m = _CMD.match(prompt or "")
    return m.group(1) if m else None


def _carried(session_id: str, turn_id: str) -> tuple:
    """(id, prompt) of the turn `turn_id` carries on: itself, or for a resume nudge
    the turn the nudges right before it resume (a restart, a limit or an error cut it)."""
    rows = store.recent_turns(session_id, 20)
    i = next((k for k, r in enumerate(rows) if r["id"] == turn_id), None)
    if i is None:
        return turn_id, store.turn_prompt(turn_id) or ""
    for r in rows[i:]:
        if not (r["prompt"] or "").startswith(_RESUME):
            return r["id"], r["prompt"] or ""
    return turn_id, ""


def step_done(session_id: str, turn_id: str, choice: "str | None" = None) -> "str | None":
    """Mark the station this turn worked on done: the one its own /mattpocock-skills:x
    names when x is a station of the path (the ones before it too), else the first one
    not done. Return the next station, or None at the end. A resume nudge's turn counts
    as the turn it resumes, so a StepDone said again there moves nothing."""
    turn_id, prompt = _carried(session_id, turn_id)
    skill = _command(prompt)
    with _lock:
        _load_locked()
        f = _cache.get(session_id)
        if not f:
            return None
        if f["last"] == turn_id:
            return (f["next"] or {}).get("station")
        stations = [st[0] for st in _stations(f)]
        named = next((st for st, sk, _ in _stations(f) if skill and sk == skill), None)
        if named in f["done"]:
            return (f["next"] or {}).get("station")   # a re-run of a finished step moves nothing
        cur = named or next((st for st in stations if st not in f["done"]), None)
        if cur is None:
            return None
        if choice == "here" and f["path"] in ("build", "design") and cur == "grill":
            f["path"] += "-here"
            stations = [st[0] for st in _stations(f)]
        f["done"] += [st for st in stations[:stations.index(cur) + 1] if st not in f["done"]]
        rest = [st for st in stations if st not in f["done"]]
        f["next"] = {"station": rest[0], "turn_id": turn_id, "started": False} if rest else None
        f["last"] = turn_id
        _save_locked()
        return rest[0] if rest else None


# Where a typed /x joins: a path's first station, or one a user may enter mid-path.
# Anything else, /tdd and /implement among them, is a one-step path of its own.
_JOINS = {"grill-with-docs": "build", "to-spec": "build", "to-tickets": "build",
          "diagnosing-bugs": "fix", "improve-codebase-architecture": "refactor"}
# Used inside whatever step runs (route.py offers it mid-grill): never a path of its own.
_INSIDE = {"wait-what"}


def path_for_command(skill: str) -> tuple:
    """(path, station) a typed /skill joins, else ("one", skill)."""
    path = _JOINS.get(skill)
    if not path:
        return "one", skill
    return path, next(st.station for st in PATHS[path] if st.skill == skill)


# --- a flow the prompt box sends ---------------------------------------------

# Esc's line, and SHIP's and ASK's: pack_text() tells Claude to start no path behind it.
NO_PATH = "No path for this message.\n\n"
BY = {"you": "you picked", "guess": "the box guessed"}


def flow_refusal(flow: str, by: str, prompt: str, agent: str) -> str:
    """Why a send can't start `flow` ("" = it can): checked where the send comes in."""
    from bridge import flowsettings   # local import: flowsettings reads PATHS
    if not on():
        return "flows are off: FLOWS is off in the prompt box's gear"
    if flow not in FLOWS:
        return f"unknown flow {flow!r}"
    if not flowsettings.flow_on(flow):
        return f"{flow.upper()} is switched off in FLOWS"
    if by not in BY:
        return f"by must be one of {', '.join(BY)}"
    if prompt.startswith("/"):
        return "a prompt that starts with / goes as typed, with no flow"
    if agent != "claude":
        return "flows are Claude's: this session runs another agent"
    return ""


def start_flow(session_id: str, flow: str, by: str, prompt: str) -> str:
    """The prompt box's flow starts with this turn: recorded for the session in place of
    any running flow, and the prompt returned with its first step's command in front
    (SHIP and ASK: the no-path line, so Claude moves them into no other flow). The
    flow already running keeps it: nothing recorded, nothing in front. A prompt queued
    before FLOWS, or its flow, went off goes as typed."""
    from bridge import flowsettings   # local import: flowsettings reads PATHS
    if not on() or not flowsettings.flow_on(flow):
        return prompt
    f = get(session_id)
    if f and f["path"].removesuffix("-here") == flow and any(st[0] not in f["done"] for st in f["stations"]):
        return prompt
    set_path(session_id, flow, f"{BY[by]} {flow.upper()}", by)
    skill = PATHS[flow][0].skill
    return f"/mattpocock-skills:{skill} {prompt}" if skill else NO_PATH + prompt


# --- starting the next step ---------------------------------------------------

# Stations _start queues a turn for in this session. build starts ticket sessions
# instead while TICKETS is on (tickets.start_build), and merge runs in a session of
# its own once every ticket is done (tickets.start_merge, then advance); with
# TICKETS off both are the user's. A REVIEW with no skill is the council's, in that
# merge session (tickets.start_review); one with a skill is ponytail's turn here.
_AUTO_START = {"spec", "tickets", "retro", "build-here", "review", "audit", "design"}
# The design step's turn: /design-first draws, and the build step builds (it may be switched off).
DESIGN_TEXT = ("/design-first the change the grill above settled. This is a flow's design step: building "
               "is the next step's job, so when the user approves, call StepDone instead of implementing.")
# The steps that are the turn itself (SHIP, ASK): its clean end is the step's end.
_TURN_STEPS = {"ship", "answer"}
ZONE_TOKENS = 150_000


def on_turn_start(session_id: str, prompt: str) -> None:
    """A turn sent as /mattpocock-skills:<x> (typed, auto-picked or queued by the flow)
    keeps the session's path when x is its next station. Otherwise x's own path replaces
    it, joined at x with the stations before x done, so a stale path can't take over an
    unrelated step. Only while SKILL PATHS is on."""
    try:
        skill = _command(prompt)
        if not skill or skill in _INSIDE or not on():
            return
        f = get(session_id)
        if f and next((sk for st, sk, _ in _stations(f) if st not in f["done"]), None) == skill:
            return
        from bridge import route
        path, station = path_for_command(skill)
        before = [] if path == "one" else [st.station for st in PATHS[path]]
        set_path(session_id, path, route._WHY.get(skill) or f"started with /{skill}", "rule",  # noqa: SLF001
                 skill if path == "one" else None, before[:before.index(station)] if before else [])
    except Exception as e:  # noqa: BLE001 — never break a turn start
        print(f"[paths] on_turn_start failed: {e}", file=sys.stderr)


def _start(session_id: str, station: str, chat_id=None, effort=None) -> bool:
    flow = get(session_id)
    if flow and station == "build" and aifeatures.enabled("ticketruns"):
        from bridge import tickets  # local import: tickets imports paths
        return not tickets.start_build(session_id)
    if not flow or station not in _AUTO_START:
        return False
    skill = next((sk for st, sk, _ in _stations(_cache[session_id]) if st == station), None)
    if station == "review" and not skill:
        from bridge import tickets  # local import: tickets imports paths
        return tickets.start_review(session_id)
    if not skill:
        return False
    from bridge import queue_manager
    sess = store.get_session(session_id) or {}
    texts = [f"/{skill} {_PONY[station]}".strip() if station in _PONY
             else DESIGN_TEXT if station == "design" else f"/mattpocock-skills:{skill}"]
    # No auto step commits to the default branch: build-here always moves to a feature
    # worktree, and RETRO only writes notes.
    if station == "build-here":
        moved = _branch_off(session_id, sess, flow, "feat", chat_id if chat_id is not None else sess.get("chat_id"))
        if not moved:
            return False
        texts = [f"/mattpocock-skills:implement Work in {moved[1]} on branch {moved[0]}, and commit there."]
    if _eff(flow, "smartzone") and (sess.get("ctx_tokens") or 0) >= ZONE_TOKENS:   # as route.SMART_ZONE
        texts.insert(0, f"/compact Keep the decisions so far; the next step is {station}.")
    for text in texts:
        queue_manager.enqueue(
            session_id, text=text, prompt=text, images=[], model=None,
            effort=effort, permission_mode=None, width=None, sel=[], surface="flow",
            chat_id=chat_id if chat_id is not None else sess.get("chat_id"),
            project=sess.get("project") or "")
    return True


def _go(session_id: str, chat_id=None, effort=None) -> bool:
    """Start the recorded next step, once: SKILL PATHS and AUTO NEXT STEPS on, AUTO not
    held, no wait on another session (its wake-up is the next turn). A step that can't
    start stays pending for the next release or resume. True = started."""
    from bridge import waits
    if not on() or waits.waiting(session_id):
        return False
    with _lock:
        _load_locked()
        f = _cache.get(session_id)
        nxt = f["next"] if f else None
        if not nxt or nxt.get("started") or not _eff(f, "nextstep"):
            return False
        nxt["started"] = True
        _save_locked()
    if _start(session_id, nxt["station"], chat_id, effort):
        return True
    with _lock:
        if (_cache.get(session_id) or {}).get("next") is nxt:
            nxt["started"] = False
            _save_locked()
    return False


def _branch_off(session_id: str, sess: dict, flow: dict, prefix: str, chat_id) -> "tuple | None":
    """(branch, checkout) the step works in: `<prefix>/<slug>` in its own worktree, the
    flow's own files carried there and committed, and the session moved in, so the
    step's commits land there. None when the files couldn't move: they are back where
    they were, the user is told, and the step waits."""
    from bridge import flowbranch, runner
    slug = flowbranch.feature_slug(sess.get("title") or "")
    branch = f"{prefix}/{slug}"
    try:
        branch, co = flowbranch.ensure_feature_branch(sess, slug, prefix)
        flowbranch.carry_and_commit(flowbranch._checkout(sess), co,  # noqa: SLF001
                                    flowbranch.flow_files(session_id, flow["at"]), slug,
                                    ours=flowbranch.added_lines(session_id, flow["at"]))
    except Exception as e:  # noqa: BLE001 — the step waits for the user instead
        print(f"[paths] {branch} stopped: {e}", file=sys.stderr)
        runner._notify(chat_id, f"Couldn't move this flow's files to {branch}: {e}. "  # noqa: SLF001
                                "They are back where they were.")
        return None
    store.set_cwd(session_id, co)
    store.set_work_cwd(session_id, None)   # the branch label reads the cwd from here (_session_brief)
    return branch, co


def continue_after_turn(job, effort=None) -> bool:
    """Called once per finished turn: start the next step StepDone recorded, when this
    turn recorded it or resumes the turn that did (the first clean end of either).
    True = started."""
    try:
        sid = job.store_session_id
        if not sid or job.status != "done" or job.interrupted or (job.runtime or "").startswith("acp:"):
            return False
        _end_pony_step(sid, job.id)
        flow = get(sid)
        nxt = flow and flow["next"]
        if not nxt or nxt.get("started") or nxt["turn_id"] != _carried(sid, job.id)[0]:
            return False
        return _go(sid, job.chat_id, effort)
    except Exception as e:  # noqa: BLE001 — never raise into the turn lifecycle
        print(f"[paths] continue failed: {e}", file=sys.stderr)
        return False


def _end_pony_step(session_id: str, turn_id: str) -> None:
    """A turn sent as /ponytail-review or /ponytail-audit ended cleanly: when the path is
    on that step, it's done (ponytail's skills never call StepDone; one that does moves once).
    So is a SHIP or ASK step at any clean end: that step is the turn itself."""
    f = get(session_id)
    rest = [(st, sk) for st, sk, _ in f["stations"] if st not in f["done"]] if f else []
    if not rest:
        return
    m = _PONY_RE.match(_carried(session_id, turn_id)[1] or "")
    if rest[0][0] in _TURN_STEPS or m and rest[0] == (m.group(1), f"ponytail-{m.group(1)}"):   # not the council's REVIEW
        step_done(session_id, turn_id)


def mark_done(session_id: str, station: str, at: "int | None" = None) -> None:
    """`station` is done without a turn of its own here (BUILD runs in ticket
    sessions): mark it, start nothing. Idempotent; step_done counts turns instead.
    `at`: only while the session is still on the path that began then."""
    with _lock:
        _load_locked()
        f = _cache.get(session_id)
        if f and (at is None or f["at"] == at) and station not in f["done"]:
            f["done"].append(station)
            _save_locked()


def advance(session_id: str, station: str, at: "int | None" = None) -> bool:
    """`station` finished elsewhere (MERGE in its own session): mark it done here,
    whatever the switches say, then start this flow's next step if they allow it.
    `at`: only while the session is still on the path that began then."""
    try:
        with _lock:
            _load_locked()
            f = _cache.get(session_id)
            if not f or at is not None and f["at"] != at:
                return False
            stations = [st[0] for st in _stations(f)]   # before the mark: MERGE's own end settles REVIEW
            if station not in f["done"]:
                f["done"].append(station)
            rest = [st for st in stations if st not in f["done"]]
            f["next"] = {"station": rest[0], "turn_id": "", "started": False} if rest else None
            _save_locked()
        return bool(rest) and _go(session_id)
    except Exception as e:  # noqa: BLE001
        print(f"[paths] advance failed: {e}", file=sys.stderr)
        return False
