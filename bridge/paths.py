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

The routing instructions ride the system prompt as PACK_TEXT, a constant: the
appended prompt sits after the last cache breakpoint, so text that varied by
turn would re-write the whole block at cache-write price. The switch is read every
run, so flipping it applies from the next turn; only the session's origin is
decided once (pack_for) and kept, like the Rivendell note. Unattended runs (Rivendell
jobs, device runs) never get the pack or the plugin: nobody is there to answer a
grill or press a step button, so a path would stall.

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
"""

import json
import os
import re
import sys
import threading
import time

from bridge import aifeatures, config, store

PACK_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "skills", "mattpocock")


def on() -> bool:
    return aifeatures.enabled("router")

PACK_TEXT = "\n".join([
    "Skill paths. Matt Pocock's skills are loaded as /mattpocock-skills:<name>.",
    "On a prompt with no /command in front, before anything else (a tool call, a file read, a question), decide whether one of these paths fits it:",
    "- feature: a new feature or idea, however small (a new command, function, option or behaviour). Start grill-with-docs.",
    "- bug: something broken, failing, empty or slow, or a question why something is broken. Start diagnosing-bugs.",
    "- refactor: tangled code or architecture work. Start improve-codebase-architecture.",
    "- one: research, a prototype, a review, a PR or teaching. Start that one skill (research, prototype, code-review, pr, teach), always by its full name, e.g. mattpocock-skills:code-review, never a same-named skill from another plugin.",
    "If one fits, your first tool call is the Skill tool with that skill (mattpocock-skills:<name>). Don't explore, diagnose, build or ask questions before it: the skill does that. Don't wait for SetPath either: it is a deferred tool, so once the skill has started, load it with ToolSearch and call it with the path and a one-line why.",
    "A path's skill comes before the skills and modes this session injects: start it instead of superpowers brainstorming or systematic-debugging, and don't skip it for ponytail's smallest change or for a clarifying question (a grill asks those).",
    "If none fits (a question about how the code works, an edit spelled out exactly like a rename, a chat reply), just answer or do it, and start nothing.",
    'If the message begins "No path for this message.", start nothing.',
    'When you finish a step of a path and need nothing more from the user, make StepDone the last tool call of your turn: the next step starts when the turn ends (build-here on its own feature branch) and does its own work. After a grill, pass choice "here" if the work fits this one session, or "tickets" if it needs several. Never call StepDone while waiting on the user.',
])

# claude session id -> whether its origin gets the pack, decided at its first run.
_pack_ok: dict[str, bool] = {}


def pack_for(claude_session_id: str) -> str:
    """PACK_TEXT for an attended run of this session while the switch is on, else "".
    The switch is read every run (it applies to the next turn); the origin once."""
    if not on():
        return ""
    if claude_session_id not in _pack_ok:
        try:
            origin = str((store.get_by_claude_session_id(claude_session_id) or {}).get("origin") or "")
        except Exception:  # noqa: BLE001 — the pack never blocks a turn
            origin = ""
        _pack_ok[claude_session_id] = not origin.startswith(("rivendell", "device-run"))
    return PACK_TEXT if _pack_ok[claude_session_id] else ""


# station, skill (None = no skill: the agent just does it), "you" | "auto"
PATHS: dict[str, list[tuple[str, "str | None", str]]] = {
    "feature": [("grill", "grill-with-docs", "you"), ("spec", "to-spec", "auto"),
                ("tickets", "to-tickets", "you"), ("build", None, "auto"),
                ("merge", None, "auto"), ("retro", "retro", "auto")],
    "feature-here": [("grill", "grill-with-docs", "you"), ("build-here", "implement", "auto"),
                     ("retro", "retro", "auto")],
    "bug": [("diagnose", "diagnosing-bugs", "auto"), ("fix", "tdd", "auto"), ("retro", "retro", "auto")],
    "refactor": [("improve", "improve-codebase-architecture", "you"), ("tickets", "to-tickets", "you"),
                 ("build", None, "auto"), ("merge", None, "auto"), ("retro", "retro", "auto")],
}

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


def _save_locked() -> None:
    try:
        tmp = _file() + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(_cache, f, indent=2)
        os.replace(tmp, _file())
    except OSError as e:
        print(f"[paths] persist failed: {e}", file=sys.stderr)


def _stations(flow: dict) -> list:
    if flow["path"] == "one":
        return [(flow["skill"], flow["skill"], "auto")]
    return PATHS[flow["path"]]


def set_path(session_id: str, path: str, why: str, by: str, skill: "str | None" = None,
             done: "list | None" = None) -> dict:
    """`done`: stations already behind it (a path joined mid-way)."""
    skill = (skill or "").removeprefix("mattpocock-skills:") or None   # the pack's full name, as PACK_TEXT asks
    if path != "one" and path not in PATHS:
        raise ValueError(f"unknown path {path!r}")
    if path == "one" and not skill:
        raise ValueError("path 'one' needs a skill")
    with _lock:
        _load_locked()
        _cache[session_id] = {"path": path, "skill": skill, "by": by, "why": why, "auto": True,
                              "at": int(time.time()), "done": list(done or []), "next": None, "last": None}
        _save_locked()
        return dict(_cache[session_id])


def restore(session_id: str, snap: "dict | None") -> None:
    """Put back what get() returned before a set_path (a run that was refused)."""
    if not snap:
        return
    with _lock:
        _load_locked()
        f = _cache.get(session_id)
        if f:
            f.update(snap)
            _save_locked()


def get(session_id: str) -> "dict | None":
    with _lock:
        _load_locked()
        f = _cache.get(session_id)
        if not f:
            return None
        return {k: f[k] for k in ("path", "by", "why", "auto", "at", "done", "next", "skill")}


def set_auto(session_id: str, on: bool) -> None:
    """Hold or release AUTO. Released with a step pending, the step starts now, or
    when a turn running here ends: never in the middle of one."""
    run = store.running_turn_id(session_id) if on else None
    turn = _carried(session_id, run)[0] if run else None
    with _lock:
        _load_locked()
        f = _cache.get(session_id)
        if not f:
            return
        f["auto"] = bool(on)
        if turn and f["next"] and not f["next"].get("started"):
            f["next"]["turn_id"] = turn
        _save_locked()
    if on and not run:
        _go(session_id)


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
        if choice == "here" and f["path"] == "feature" and cur == "grill":
            f["path"] = "feature-here"
            stations = [st[0] for st in _stations(f)]
        f["done"] += [st for st in stations[:stations.index(cur) + 1] if st not in f["done"]]
        rest = [st for st in stations if st not in f["done"]]
        f["next"] = {"station": rest[0], "turn_id": turn_id, "started": False} if rest else None
        f["last"] = turn_id
        _save_locked()
        return rest[0] if rest else None


# Where a typed /x joins: a path's first station, or one a user may enter mid-path.
# Anything else, /tdd and /implement among them, is a one-step path of its own.
_JOINS = {"grill-with-docs": "feature", "to-spec": "feature", "to-tickets": "feature",
          "diagnosing-bugs": "bug", "improve-codebase-architecture": "refactor"}
# Used inside whatever step runs (route.py offers it mid-grill): never a path of its own.
_INSIDE = {"wait-what"}


def path_for_command(skill: str) -> tuple:
    """(path, station) a typed /skill joins, else ("one", skill)."""
    path = _JOINS.get(skill)
    if not path:
        return "one", skill
    return path, next(st for st, sk, _ in PATHS[path] if sk == skill)


# --- starting the next step ---------------------------------------------------

# Stations _start queues a turn for in this session. build starts ticket sessions
# instead while TICKETS is on (tickets.start_build), and merge runs in a session of
# its own once every ticket is done (tickets.start_merge, then advance); with
# TICKETS off both are the user's.
_AUTO_START = {"spec", "tickets", "retro", "fix", "build-here"}
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
        before = [] if path == "one" else [st for st, _, _ in PATHS[path]]
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
    if not skill:
        return False
    from bridge import flowbranch, queue_manager
    sess = store.get_session(session_id) or {}
    texts = [f"/mattpocock-skills:{skill}"]
    # No auto step commits to the default branch: build-here always moves to a feature
    # worktree, an auto FIX when the session sits on the default branch. RETRO only writes notes.
    if station == "build-here" or station == "fix" and flowbranch.on_default(sess):
        moved = _branch_off(session_id, sess, flow, "feat" if station == "build-here" else "fix",
                            chat_id if chat_id is not None else sess.get("chat_id"))
        if not moved:
            return False
        if station == "build-here":
            texts = [f"/mattpocock-skills:implement Work in {moved[1]} on branch {moved[0]}, and commit there."]
        else:   # the diagnosis names the main checkout's paths: pin the fix to its worktree
            texts = [f"/mattpocock-skills:tdd Work in {moved[1]} on branch {moved[0]}, and commit there."]
    if aifeatures.enabled("smartzone") and (sess.get("ctx_tokens") or 0) >= ZONE_TOKENS:   # as route.SMART_ZONE
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
    if not on() or not aifeatures.enabled("nextstep") or waits.waiting(session_id):
        return False
    with _lock:
        _load_locked()
        f = _cache.get(session_id)
        nxt = f["next"] if f else None
        if not nxt or nxt.get("started") or not f["auto"]:
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
                                    f"wip: carry the {slug} investigation" if prefix == "fix" else "")
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
        flow = get(sid)
        nxt = flow and flow["next"]
        if not nxt or nxt.get("started") or nxt["turn_id"] != _carried(sid, job.id)[0]:
            return False
        return _go(sid, job.chat_id, effort)
    except Exception as e:  # noqa: BLE001 — never raise into the turn lifecycle
        print(f"[paths] continue failed: {e}", file=sys.stderr)
        return False


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
            if station not in f["done"]:
                f["done"].append(station)
            rest = [st[0] for st in _stations(f) if st[0] not in f["done"]]
            f["next"] = {"station": rest[0], "turn_id": "", "started": False} if rest else None
            _save_locked()
        return bool(rest) and _go(session_id)
    except Exception as e:  # noqa: BLE001
        print(f"[paths] advance failed: {e}", file=sys.stderr)
        return False
