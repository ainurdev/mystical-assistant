"""Automations: when something happens, or at some time, run a prompt in a project.

Four triggers. A timer runs every N minutes, and can first ask a command or a script whether to go
on: exit 0 means yes, unless the last line it prints says false. "Times a day" spaces N runs between
two times. A path listener watches files or folders. A Telegram command fires on your /word. Whatever
fires, the same thing happens: an agent runs the prompt in the chosen project, in a new chat or the
automation's one chat, with the permission mode that automation was given, and you get a Telegram
message when it ends. An approval it stops for pings you the way any turn's does (tgask).

This is the one place in the bridge that runs commands on a schedule, so only the owner can write
one (owner_only, in multi_api) and no agent tool can: a prompt injected into some run must not be able
to give itself a timer. Paths and scripts stay inside the projects folder.

Laptops sleep. A "times a day" slot missed within CATCH_UP_S runs once on waking, however many went
by, as five weather reports at once help nobody. Timers just carry on. Path listeners ignore what
happens during their own run and look afresh after it, or an agent editing a watched folder would
trigger itself forever, and they're capped per hour besides.

ponytail: paths are polled, as stdlib has no file events, so a change lands within POLL_S and a
tree over MAX_WATCH entries is only watched that far. It's also why this is JSON beside the database:
a few dozen rows, read on every tick, and readable when the store is mid-migration.

Stdlib only.
"""

import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
import uuid

from bridge import config, experimental, store

KINDS = ("timer", "daily", "path", "telegram")
MODES = ("plan", "acceptEdits", "bypassPermissions")
TICK_S, POLL_S, QUIET_S, WATCH_S = 5, 10, 3, 2
CHECK_TIMEOUT_S = 60
CATCH_UP_S = 12 * 3600
MAX_WATCH = 20000
PATH_RUNS_PER_HOUR = 12
KEEP_RUNS = 20
_IGNORE = {".git", "node_modules", ".mystical", "__pycache__", "dist", "build", ".next", ".venv", "venv", ".cache"}
_lock = threading.RLock()
_mem: dict = {}          # id -> what isn't worth saving: running job, watched snapshot, checks in flight
_started = False


class Refused(ValueError):
    """A sentence for whoever asked: what to change."""


def _path() -> str:
    return os.path.join(os.path.dirname(config.BRIDGE_DB), "automations.json")


def _load() -> list:
    try:
        with open(_path(), encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except (OSError, ValueError):
        return []


def _save(rows: list) -> None:
    tmp = f"{_path()}.{threading.get_ident()}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(rows, f, ensure_ascii=False)
    os.replace(tmp, _path())


def _reserved() -> set:
    """The bot's own commands, as a command of yours mustn't shadow one."""
    try:
        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "dispatch.py"), encoding="utf-8") as f:
            return set(re.findall(r'"/([a-z_]+)"', f.read())) | {"start", "help"}
    except OSError:
        return {"start", "help"}


def project_dir(project: str) -> str:
    """The folder of a project, from its name in the list."""
    real = os.path.realpath(os.path.join(config.BASE_PATH, str(project or "").lstrip("/")))
    base = os.path.realpath(config.BASE_PATH)
    if not str(project or "").strip("/") or not real.startswith(base + os.sep) or not os.path.isdir(real):
        raise Refused("Pick a project.")
    return real


def _inside(path: str, cwd: str) -> str:
    """A path the owner named, resolved against the project and kept to the projects folder."""
    real = os.path.realpath(os.path.expanduser(path) if os.path.isabs(os.path.expanduser(path)) else os.path.join(cwd, path))
    base = os.path.realpath(config.BASE_PATH)
    if real != base and not real.startswith(base + os.sep):
        raise Refused(f"{path} is outside your projects folder.")
    return real


def _hhmm(value, fallback: str) -> str:
    v = str(value or fallback).strip()
    if not re.fullmatch(r"([01]?\d|2[0-3]):[0-5]\d", v):
        raise Refused(f"{v} isn't a time like 09:00.")
    return f"{int(v.split(':')[0]):02d}:{v.split(':')[1]}"


def _clean_trigger(raw: dict, cwd: str) -> dict:
    kind = raw.get("kind")
    if kind not in KINDS:
        raise Refused("Pick when it should run.")
    if kind == "timer":
        try:
            every = int(raw.get("every") or 0)
        except (TypeError, ValueError):
            every = 0
        if every < 1 or every > 7 * 24 * 60:
            raise Refused("A timer runs every 1 minute to 7 days.")
        check = raw.get("check") if isinstance(raw.get("check"), dict) else {}
        how = check.get("kind") if check.get("kind") in ("none", "command", "script") else "none"
        out = {"kind": kind, "every": every, "check": {"kind": how}}
        if how == "command":
            command = str(check.get("command") or "").strip()
            if not command:
                raise Refused("Write the command, or choose no check.")
            out["check"]["command"] = command[:2000]
        if how == "script":
            script = str(check.get("script") or "").strip()
            if not script:
                raise Refused("Say where the script is, or choose no check.")
            _inside(script, cwd)
            out["check"]["script"] = script[:1000]
        return out
    if kind == "daily":
        try:
            count = int(raw.get("count") or 0)
        except (TypeError, ValueError):
            count = 0
        if count < 1 or count > 48:
            raise Refused("Run it 1 to 48 times a day.")
        start, end = _hhmm(raw.get("start"), "09:00"), _hhmm(raw.get("end"), "18:00")
        if count > 1 and _mins(end) <= _mins(start):
            raise Refused("The last time has to be after the first.")
        return {"kind": kind, "count": count, "start": start, "end": end}
    if kind == "path":
        paths = [str(p).strip() for p in (raw.get("paths") or []) if str(p).strip()][:20] if isinstance(raw.get("paths"), list) else []
        if not paths:
            raise Refused("Say which files or folders to watch.")
        for p in paths:
            _inside(p, cwd)
        return {"kind": kind, "paths": paths}
    word = str(raw.get("command") or "").strip().lstrip("/").lower()
    if not re.fullmatch(r"[a-z0-9_]{1,32}", word):
        raise Refused("A command is one word of letters, numbers and underscores.")
    if word in _reserved():
        raise Refused(f"/{word} is already one of the bot's commands.")
    return {"kind": kind, "command": word}


def _mins(hhmm: str) -> int:
    h, m = hhmm.split(":")
    return int(h) * 60 + int(m)


def slots(trigger: dict) -> list:
    """The day's times for a "times a day" trigger, in minutes, spaced evenly."""
    start, end, n = _mins(trigger["start"]), _mins(trigger["end"]), trigger["count"]
    return [start] if n == 1 else [round(start + (end - start) * i / (n - 1)) for i in range(n)]


def _local_day_start(now: float) -> float:
    t = time.localtime(now)
    return time.mktime((t.tm_year, t.tm_mon, t.tm_mday, 0, 0, 0, 0, 0, -1))


def due_slot(trigger: dict, last: float, now: float) -> "float | None":
    """The newest slot that has gone by since `last`, within reach: at most one, however many passed."""
    day = _local_day_start(now)
    times = [day - 86400 + m * 60 for m in slots(trigger)] + [day + m * 60 for m in slots(trigger)]
    gone = [t for t in times if last < t <= now and now - t <= CATCH_UP_S]
    return gone[-1] if gone else None


def next_at(a: dict, now: "float | None" = None) -> "float | None":
    """When it'll next run, for the list. None when it depends on something happening."""
    now = now or time.time()
    t = a["trigger"]
    if not a.get("enabled"):
        return None
    if t["kind"] == "timer":
        return max(now, a.get("last_check", 0) + t["every"] * 60)
    if t["kind"] == "daily":
        day = _local_day_start(now)
        for base in (day, day + 86400):
            for m in slots(t):
                if base + m * 60 > now:
                    return base + m * 60
    return None


def public(a: dict) -> dict:
    return {**a, "next_at": next_at(a), "running": bool(_mem.get(a["id"], {}).get("job"))}


def listed() -> dict:
    from bridge import browser
    return {"automations": [public(a) for a in _load()], "projects": browser.list_projects(),
            "modes": list(MODES), "kinds": list(KINDS)}


def save(body: dict) -> dict:
    """Create or update. What the run needs comes from the form; what's happened so far stays."""
    name = " ".join(str(body.get("name") or "").split())[:80]
    prompt = str(body.get("prompt") or "").strip()[:8000]
    if not name:
        raise Refused("Give it a name.")
    if not prompt:
        raise Refused("Write what the agent should do.")
    cwd = project_dir(body.get("project"))
    mode = body.get("mode") if body.get("mode") in MODES else "acceptEdits"
    chat = body.get("chat") if body.get("chat") in ("new", "same") else "new"
    trigger = _clean_trigger(body.get("trigger") if isinstance(body.get("trigger"), dict) else {}, cwd)
    with _lock:
        rows = _load()
        if trigger["kind"] == "telegram" and any(a["trigger"].get("command") == trigger["command"] and a["id"] != body.get("id") for a in rows):
            raise Refused(f"Another automation already uses /{trigger['command']}.")
        cur = next((a for a in rows if a["id"] == body.get("id")), None)
        if cur:
            cur.update(name=name, prompt=prompt, project=str(body["project"]), mode=mode, chat=chat, trigger=trigger)
            _mem.pop(cur["id"], None)
        else:
            cur = {"id": uuid.uuid4().hex[:12], "name": name, "prompt": prompt, "project": str(body["project"]), "mode": mode, "chat": chat,
                   "trigger": trigger, "enabled": body.get("enabled") is not False, "created": time.time(), "last_check": time.time(), "last_fire": time.time(), "runs": [], "note": ""}
            rows.append(cur)
        _save(rows)
    return public(cur)


def toggle(aid: str, on: bool) -> dict:
    with _lock:
        rows = _load()
        cur = next((a for a in rows if a["id"] == aid), None)
        if not cur:
            raise Refused("No such automation.")
        cur["enabled"] = on
        # Turned back on, it starts from now: nothing it would have done while off happens at once.
        if on:
            cur["last_check"] = cur["last_fire"] = time.time()
            cur["note"] = ""
        _mem.pop(aid, None)
        _save(rows)
    return public(cur)


def delete(aid: str) -> None:
    with _lock:
        rows = _load()
        if not any(a["id"] == aid for a in rows):
            raise Refused("No such automation.")
        _save([a for a in rows if a["id"] != aid])
        _mem.pop(aid, None)


def _update(aid: str, **kw) -> None:
    with _lock:
        rows = _load()
        for a in rows:
            if a["id"] == aid:
                a.update(kw)
        _save(rows)


def _command_for(a: dict) -> "tuple[list, str]":
    """(argv, cwd) of a timer's check. Raises Refused when its script isn't there yet."""
    cwd = project_dir(a["project"])
    check = a["trigger"].get("check") or {}
    if check.get("kind") == "command":
        return ["bash", "-c", check["command"]], cwd
    script = _inside(check["script"], cwd)
    if not os.path.isfile(script):
        raise Refused(f"The script isn't at {check['script']} yet.")
    return ([script] if os.access(script, os.X_OK) else [shutil.which("bash") or "sh", script]), cwd


def run_check(a: dict) -> dict:
    """Does the check say go? {go, output, why}. Exit 0 is yes, unless the last line says otherwise."""
    if (a["trigger"].get("check") or {}).get("kind", "none") == "none":
        return {"go": True, "output": "", "why": "no check"}
    try:
        argv, cwd = _command_for(a)
    except Refused as e:
        return {"go": False, "output": "", "why": str(e), "broken": True}
    try:
        p = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=CHECK_TIMEOUT_S, stdin=subprocess.DEVNULL)
    except subprocess.TimeoutExpired:
        return {"go": False, "output": "", "why": f"It took over {CHECK_TIMEOUT_S} s.", "broken": True}
    except OSError as e:
        return {"go": False, "output": "", "why": f"It couldn't start: {e}", "broken": True}
    out = (p.stdout or "").strip()
    last = out.splitlines()[-1].strip().lower() if out else ""
    go = p.returncode == 0 and last not in ("false", "no", "0")
    why = f"exit {p.returncode}" + (f', printed "{last[:40]}"' if last in ("false", "no", "0", "true", "yes", "1") else "")
    return {"go": go, "output": out[-2000:], "why": why, **({"error": (p.stderr or "").strip()[-400:]} if p.returncode not in (0, 1) else {})}


def fire(a: dict, why: str, context: str = "") -> "str | None":
    """Start the run. Returns its session id, or None when it can't start (busy, a project gone)."""
    from bridge import runner
    with _lock:
        mem = _mem.setdefault(a["id"], {})
        if mem.get("job"):
            return None
    try:
        cwd = project_dir(a["project"])
    except Refused as e:
        _update(a["id"], note=str(e))
        return None
    chat_id = config.DASH_CHAT_ID
    sid = a.get("session_id") if a.get("chat") == "same" and a.get("session_id") and store.get_session(a["session_id"]) else None
    if not sid:
        s = store.create_session(chat_id, a["project"], origin="automation", cwd=cwd, permission_mode=a["mode"])
        sid = s["id"]
        store.rename(sid, f"⏱ {a['name']}")
    prompt = a["prompt"]
    if context:
        prompt += f"\n\n{context}"
    prompt += f"\n\n(This is the automation \"{a['name']}\", which ran because of: {why}. Nobody is watching this chat as it runs.)"
    job = runner.start_streaming_job(chat_id, prompt, [], project=a["project"], permission_mode=a["mode"], session_id=sid, origin="automation")
    if job is None or getattr(job, "refusal", None):
        _update(a["id"], note="It couldn't start: that chat is busy." if job is None else f"It couldn't start: {job.refusal}")
        return None
    with _lock:
        _mem.setdefault(a["id"], {})["job"] = job
        rows = _load()
        for r in rows:
            if r["id"] == a["id"]:
                r["last_fire"] = time.time()
                r["note"] = ""
                if r.get("chat") == "same":
                    r["session_id"] = sid
                r["runs"] = (r.get("runs") or [])[-(KEEP_RUNS - 1):] + [{"at": time.time(), "why": why[:160], "session_id": sid, "status": "running"}]
        _save(rows)
    threading.Thread(target=_watch, args=(a["id"], a["name"], job, sid), daemon=True).start()
    return sid


def _watch(aid: str, name: str, job, sid: str) -> None:
    """See the run to its end, say so, and let the next one go."""
    while getattr(job, "status", "done") == "running":
        time.sleep(WATCH_S)
    status = job.status
    with _lock:
        mem = _mem.setdefault(aid, {})
        mem["job"] = None
        mem["snapshot"] = None      # a path listener looks afresh: this run's own edits don't count
        rows = _load()
        for r in rows:
            if r["id"] == aid and r.get("runs"):
                r["runs"][-1]["status"] = status
        _save(rows)
    if config.TOKEN:
        from bridge import telegram
        first = next((ln.strip() for ln in str(getattr(job, "result", "") or "").splitlines() if ln.strip()), "")
        said = f"⏱ {name}: " + (first[:600] if first and status == "done" else "finished" if status == "done" else "it failed. See its chat.")
        try:
            telegram.send(config.DASH_CHAT_ID, said, markdown=False)
        except (OSError, ValueError) as e:
            print(f"[automations] {e}", file=sys.stderr)


def _snapshot(paths: list, cwd: str) -> dict:
    seen: dict = {}

    def note(p: str) -> None:
        try:
            st = os.stat(p)
            seen[p] = (st.st_mtime_ns, st.st_size)
        except OSError:
            pass
    for raw in paths:
        real = _inside(raw, cwd)
        if os.path.isfile(real):
            note(real)
            continue
        for d, dirs, names in os.walk(real):
            dirs[:] = [x for x in dirs if x not in _IGNORE]
            for n in names:
                note(os.path.join(d, n))
            if len(seen) >= MAX_WATCH:
                return seen
    return seen


def _diff(before: dict, after: dict) -> list:
    return sorted(p for p in set(before) | set(after) if before.get(p) != after.get(p))


def _tick_path(a: dict, now: float) -> None:
    mem = _mem.setdefault(a["id"], {})
    if mem.get("job") or now - mem.get("polled", 0) < POLL_S:
        return
    mem["polled"] = now
    try:
        cwd = project_dir(a["project"])
        snap = _snapshot(a["trigger"]["paths"], cwd)
    except Refused as e:
        _update(a["id"], note=str(e))
        return
    if mem.get("snapshot") is None:
        mem["snapshot"], mem["changed"] = snap, []
        return
    changed = _diff(mem["snapshot"], snap)
    mem["snapshot"] = snap
    if changed:
        mem["changed"] = sorted(set(mem.get("changed") or []) | set(changed))
        mem["quiet"] = now
        return
    # A save is often several writes: it goes once things have settled.
    if mem.get("changed") and now - mem.get("quiet", now) >= QUIET_S:
        recent = [r for r in a.get("runs") or [] if now - r["at"] < 3600]
        if len(recent) >= PATH_RUNS_PER_HOUR:
            _update(a["id"], note=f"Held: it already ran {PATH_RUNS_PER_HOUR} times this hour.")
            mem["changed"] = []
            return
        files = mem["changed"]
        mem["changed"] = []
        names = [os.path.relpath(p, cwd) for p in files[:30]]
        fire(a, f"{len(files)} file(s) changed", "These changed:\n" + "\n".join(names) + (f"\nand {len(files) - 30} more" if len(files) > 30 else ""))


def _check_then_fire(a: dict) -> None:
    try:
        got = run_check(a)
        if got.get("broken"):
            _update(a["id"], note=got["why"])
        elif got["go"]:
            fire(a, f"the timer's check said yes ({got['why']})" if a["trigger"]["check"]["kind"] != "none" else "its timer",
                 f"The check printed:\n{got['output']}" if got["output"] else "")
    finally:
        _mem.setdefault(a["id"], {})["checking"] = False


def tick(now: "float | None" = None) -> None:
    now = now or time.time()
    if not experimental.enabled():
        return
    for a in _load():
        if not a.get("enabled"):
            continue
        t = a["trigger"]
        mem = _mem.setdefault(a["id"], {})
        if t["kind"] == "path":
            _tick_path(a, now)
        elif mem.get("job") or mem.get("checking"):
            continue
        elif t["kind"] == "timer" and now - a.get("last_check", 0) >= t["every"] * 60:
            _update(a["id"], last_check=now)
            mem["checking"] = True
            threading.Thread(target=_check_then_fire, args=({**a, "last_check": now},), daemon=True).start()
        elif t["kind"] == "daily":
            slot = due_slot(t, a.get("last_fire", 0), now)
            if slot:
                _update(a["id"], last_fire=now)
                fire(a, f"its {time.strftime('%H:%M', time.localtime(slot))} run")


def on_command(chat_id: int, text: str) -> "str | None":
    """A Telegram /word: what to reply when it's one of yours, or None to let the bot carry on."""
    m = re.fullmatch(r"/([a-z0-9_]{1,32})(?:@\w+)?(?:\s+([\s\S]*))?", text.strip())
    if not m or not experimental.enabled() or chat_id != config.DASH_CHAT_ID:
        return None
    a = next((x for x in _load() if x["trigger"].get("command") == m.group(1)), None)
    if not a:
        return None
    if not a.get("enabled"):
        return f"{a['name']} is switched off."
    sid = fire(a, f"you sent /{m.group(1)}", f"With it you wrote: {m.group(2)}" if m.group(2) else "")
    return f"⏱ {a['name']} is running." if sid else f"{a['name']} is already running, or its chat is busy."


def run_now(aid: str) -> dict:
    a = next((x for x in _load() if x["id"] == aid), None)
    if not a:
        raise Refused("No such automation.")
    sid = fire(a, "you pressed Run now")
    if not sid:
        raise Refused("It's already running, or its chat is busy.")
    return {"session_id": sid}


def write_script(body: dict) -> dict:
    """Start a chat in which an agent drafts the timer's check with you, and saves it when you say."""
    from bridge import runner
    wanted = str(body.get("description") or "").strip()[:2000]
    where = str(body.get("path") or "").strip()
    if not wanted:
        raise Refused("Say what the script should check.")
    if not where:
        raise Refused("Say where to save it.")
    cwd = project_dir(body.get("project"))
    real = _inside(where, cwd)
    chat_id = config.DASH_CHAT_ID
    s = store.create_session(chat_id, str(body["project"]), origin="automation", cwd=cwd, permission_mode="acceptEdits")
    store.rename(s["id"], f"⏱ Script: {wanted[:40]}")
    prompt = (f"Write a script for an automation's timer. It should check this: {wanted}\n\n"
              "How it's read: exit 0 means run the automation, anything else means don't. Printing true or false as the last line "
              "overrides that, and what it prints reaches the automation's agent, so print what it found. It runs from the project's "
              f"folder, every time the timer goes, for at most {CHECK_TIMEOUT_S} seconds, with nobody there to answer it.\n\n"
              f"Draft it somewhere temporary, run it and show me the script and what it returned. We'll go back and forth. Only when I "
              f"say to save it, write it to {real} and make it executable.")
    job = runner.start_streaming_job(chat_id, prompt, [], project=str(body["project"]), permission_mode="acceptEdits", session_id=s["id"], origin="automation")
    if job is None or getattr(job, "refusal", None):
        raise Refused("That chat couldn't start.")
    return {"session_id": s["id"], "path": where}


def test(body: dict) -> dict:
    """The check, run once from the form, so you find out before the timer does."""
    cwd = project_dir(body.get("project"))
    trigger = _clean_trigger(body.get("trigger") if isinstance(body.get("trigger"), dict) else {}, cwd)
    return run_check({"project": body["project"], "trigger": trigger})


def _loop() -> None:
    while True:
        try:
            tick()
        except Exception as e:  # noqa: BLE001 - one bad row mustn't end every automation
            print(f"[automations] {e!r}", file=sys.stderr)
        time.sleep(TICK_S)


def boot() -> None:
    global _started
    if _started:
        return
    _started = True
    threading.Thread(target=_loop, daemon=True, name="automations").start()


def api(path: str, body: dict, chat_id: int) -> "tuple[dict, int]":
    """POST automations/*. Only the owner: these run commands and agents on this machine."""
    if chat_id != config.DASH_CHAT_ID:
        return {"error": "Only the owner can change automations."}, 403
    try:
        if path == "automations/save":
            return {"automation": save(body), **listed()}, 200
        if path == "automations/toggle":
            toggle(str(body.get("id")), body.get("on") is True)
        elif path == "automations/delete":
            delete(str(body.get("id")))
        elif path == "automations/run":
            return {**run_now(str(body.get("id"))), **listed()}, 200
        elif path == "automations/test":
            return test(body), 200
        elif path == "automations/script":
            return write_script(body), 200
        else:
            return {"error": "No such route."}, 404
    except Refused as e:
        return {"error": str(e)}, 400
    return listed(), 200
