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
turn would re-write the whole block at cache-write price. Whether a session gets
it is decided once per session (pack_for) and kept, like the Rivendell note, so
flipping the switch or a session's origin mid-run can't change a running
session's prompt. Unattended runs (Rivendell jobs, device runs) never get it:
nobody is there to answer a grill or press a step button, so a path would stall.

Flow state (which path a session is on, which stations are done) is a small JSON
file, flows.json, beside the bridge DB, written atomically like waits.json. It is
a file rather than a table so a path survives a bridge restart without a schema
change, and a worktree's pinned BRIDGE_DB keeps its flows off the live ones.
step_done is idempotent per turn_id: a turn can be retried, resumed or replayed
after a restart, and the same turn must never advance the path twice. The turn
that finished a station is remembered (`last`) and a repeat returns the same answer.
"""

import json
import os
import sys
import threading
import time

from bridge import aifeatures, config, store

PACK_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "skills", "mattpocock")
PLUGIN_ID = "mattpocock-skills@claude-plugins-official"


def on() -> bool:
    return aifeatures.enabled("router")

PACK_TEXT = "\n".join([
    "Skill paths. Matt Pocock's skills are loaded as /mattpocock-skills:<name>.",
    "When a prompt has no /command in front, first decide whether one of these paths fits it:",
    "- feature: a new feature or idea. Start grill-with-docs.",
    "- bug: something broken, failing or slow. Start diagnosing-bugs.",
    "- refactor: tangled code or architecture work. Start improve-codebase-architecture.",
    "- one: research, a prototype, a review, a PR or teaching. Start that one skill (research, prototype, code-review, pr, teach).",
    "If one fits, call SetPath with the path and a one-line why, then start its skill with the Skill tool.",
    "If none fits (a plain question, a small edit, a chat reply), just answer and start nothing.",
    'If the message begins "No path for this message.", start nothing.',
    'When you finish a step of a path and need nothing more from the user, call StepDone. After a grill, pass choice "here" if the work fits this one session, or "tickets" if it needs several. Never call StepDone while waiting on the user.',
    "Tickets: the tracker is local files. Write one ticket per file to .mystical/tickets/<feature-slug>/<NN>-<slug>.md in this checkout, using the local ticket template, numbered from 01 in dependency order. Triage labels: needs-triage, needs-info, ready-for-agent, ready-for-human, wontfix.",
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


def set_path(session_id: str, path: str, why: str, by: str, skill: "str | None" = None) -> dict:
    if path != "one" and path not in PATHS:
        raise ValueError(f"unknown path {path!r}")
    if path == "one" and not skill:
        raise ValueError("path 'one' needs a skill")
    with _lock:
        _load_locked()
        _cache[session_id] = {"path": path, "skill": skill, "by": by, "why": why, "auto": True,
                              "at": int(time.time()), "done": [], "next": None, "last": None}
        _save_locked()
        return dict(_cache[session_id])


def get(session_id: str) -> "dict | None":
    with _lock:
        _load_locked()
        f = _cache.get(session_id)
        if not f:
            return None
        return {k: f[k] for k in ("path", "by", "why", "auto", "at", "done", "next")}


def set_auto(session_id: str, on: bool) -> None:
    with _lock:
        _load_locked()
        if session_id in _cache:
            _cache[session_id]["auto"] = bool(on)
            _save_locked()


def step_done(session_id: str, turn_id: str, choice: "str | None" = None) -> "str | None":
    """Mark the current station done; return the next station, or None at the end."""
    with _lock:
        _load_locked()
        f = _cache.get(session_id)
        if not f:
            return None
        if f["last"] == turn_id:
            return (f["next"] or {}).get("station")
        stations = [st[0] for st in _stations(f)]
        cur = next((st for st in stations if st not in f["done"]), None)
        if cur is None:
            return None
        if choice == "here" and f["path"] == "feature" and cur == "grill":
            f["path"] = "feature-here"
            stations = [st[0] for st in _stations(f)]
        f["done"].append(cur)
        rest = [st for st in stations if st not in f["done"]]
        f["next"] = {"station": rest[0], "turn_id": turn_id} if rest else None
        f["last"] = turn_id
        _save_locked()
        return rest[0] if rest else None


def path_for_command(skill: str) -> tuple:
    """(path, station) a typed flow command joins: first path holding that skill, else a one-skill path."""
    for name, stations in PATHS.items():
        for station, sk, _ in stations:
            if sk == skill:
                return name, station
    return "one", skill


# --- starting the next step ---------------------------------------------------

# Stations that start a turn by themselves. build/merge wait for tickets (a later
# task) and build-here for its own, so they return False: the user moves them (YOU).
_AUTO_START = {"spec", "tickets", "retro", "fix"}
ZONE_TOKENS = 150_000


def on_turn_start(session_id: str, prompt: str) -> None:
    """A typed /mattpocock-skills:<x> in a session without a path joins the path holding x."""
    try:
        head = (prompt or "").lstrip()
        if not head.startswith("/mattpocock-skills:") or get(session_id):
            return
        skill = head[len("/mattpocock-skills:"):].split(None, 1)[0]
        if not skill:
            return
        from bridge import route
        path, _ = path_for_command(skill)
        set_path(session_id, path, route._WHY.get(skill) or f"started with /{skill}", "rule",  # noqa: SLF001
                 skill if path == "one" else None)
    except Exception as e:  # noqa: BLE001 — never break a turn start
        print(f"[paths] on_turn_start failed: {e}", file=sys.stderr)


def _start(session_id: str, station: str, chat_id=None, effort=None) -> bool:
    flow = get(session_id)
    if not flow or station not in _AUTO_START:
        return False
    skill = next((sk for st, sk, _ in _stations(_cache[session_id]) if st == station), None)
    if not skill:
        return False
    from bridge import queue_manager
    sess = store.get_session(session_id) or {}
    texts = [f"/mattpocock-skills:{skill}"]
    if aifeatures.enabled("smartzone") and (sess.get("ctx_tokens") or 0) > ZONE_TOKENS:
        texts.insert(0, f"/compact Keep the decisions so far; the next step is {station}.")
    for text in texts:
        queue_manager.enqueue(
            session_id, text=text, prompt=text, images=[], model=None,
            effort=effort, permission_mode=None, width=None, sel=[], surface="flow",
            chat_id=chat_id if chat_id is not None else sess.get("chat_id"),
            project=sess.get("project") or "")
    return True


def continue_after_turn(job, effort=None) -> bool:
    """Called once per finished turn: start the next step StepDone recorded in
    THIS turn (its turn id is the job's id), if the flow is on auto. True = started."""
    try:
        sid = job.store_session_id
        if not sid or job.status != "done" or job.interrupted or (job.runtime or "").startswith("acp:"):
            return False
        if not on() or not aifeatures.enabled("nextstep"):
            return False
        flow = get(sid)
        nxt = flow and flow["next"]
        if not nxt or not flow["auto"] or nxt["turn_id"] != job.id:
            return False
        return _start(sid, nxt["station"], job.chat_id, effort)
    except Exception as e:  # noqa: BLE001 — never raise into the turn lifecycle
        print(f"[paths] continue failed: {e}", file=sys.stderr)
        return False


def advance(session_id: str, station: str) -> bool:
    """`station` finished elsewhere (MERGE in its own session): mark it done here
    and start this flow's next step."""
    try:
        if not on() or not aifeatures.enabled("nextstep"):
            return False
        with _lock:
            _load_locked()
            f = _cache.get(session_id)
            if not f or not f["auto"]:
                return False
            if station not in f["done"]:
                f["done"].append(station)
            rest = [st[0] for st in _stations(f) if st[0] not in f["done"]]
            f["next"] = {"station": rest[0], "turn_id": ""} if rest else None
            _save_locked()
        return bool(rest) and _start(session_id, rest[0])
    except Exception as e:  # noqa: BLE001
        print(f"[paths] advance failed: {e}", file=sys.stderr)
        return False
