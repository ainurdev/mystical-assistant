"""The council: reviewers rate the work a push would send (1-10) and list
findings; the session that wrote the code fixes them until the score passes.

This module owns all of it: settings, what a push would send, the reviewer
seats, merging their findings, and the round loop with the tab's actions.
Spec: docs/superpowers/specs/council-tab.md.

Design choices (the why):
- One rubric prompt with a JSON answer serves every seat, so their scores share
  a scale. `/code-review` and Codex's `/review` give free text or their own format.
- Merging is code, no chairman model: two findings are the same when they share
  a file and their lines are within NEAR (or, with no line, the same title).
  Severity is the higher of the two.
- Only a must finding that every seat that ran agrees on blocks a pass, so one
  reviewer's hunch can't hold a push hostage.
- The fix turn objects to a wrong finding on its own line, "N. NO: <why>".
- State is one JSON column, sessions.council, like sessions.goal.

- Reviewers are read-only and get the diff in the prompt: Claude runs in plan
  mode with no pack, Codex over ACP with every permission request denied. A
  watchdog owns hangs, since ACP's session/prompt has no timeout of its own.
- A diff over DIFF_CAP drops whole-file sections, never cuts one mid-file, and
  names what it left out so the reviewer knows its view is partial.

The loop: start -> _round -> fixing -> after_turn -> _round ...
- A round runs on a thread of its own (_spawn), its seats side by side on
  threads joined against one deadline, so a reviewer that never answers costs
  the round that seat, never the round.
- A failed round queues one prompt on the session's own queue, as a goal nudge
  does, so it waits behind what you type and keeps pause, reorder and steer.
  runner._continue_after_turn asks after_turn before paths and goals; True
  there (the next round started) skips that turn's DONE, flow step and goal
  nudge: the verdict is the news, and one turn end never queues two.
- Which turn end counts. The queue keeps an item that ran, done or failed with
  its job_id, until you clear it, and notify_job_done runs before
  _continue_after_turn. So the fix turn is the job that ran the item. An item
  already done counts too: an auto-resume ends that turn without asking us, and
  the resumed turn carries the fix on. So does one gone from the queue (steered
  into the running turn, or removed). Queued, or running under another job
  (your turn ended and the queue just started the fix), means wait.
- One lock guards every read-modify-write of a run, and seats never read under
  it. A round lands only if the run is still on it (since, round), so a Stop or
  a new run while the seats read is never written over. Every turn end in the
  bridge calls after_turn, so it looks first without the lock and goes on only
  for a run that is fixing; a round can hold the lock across an enqueue. That
  is safe because "fixing" is saved before any fix prompt is enqueued, and the
  item id lands under the same lock: a fix turn that ends at once (a refused
  run) still finds the run waiting on it.
- Restarts: the state outlives the process, its threads don't. The bridge
  restarts by os.execv in place (selfupdate.exec_self), so the pid survives;
  each run carries the _BOOT token minted at import instead. "reviewing" from
  another boot is stopped as "interrupted by a restart"; so is "fixing" from
  another boot whose item the persisted queue no longer has. One whose item
  survived goes on when it runs.
- A run that passes or stops says so once (council_passed / council_stopped),
  and wakes the sessions waiting on this one (waits.target_ended): the turn end
  that would have woken them led into the council. Your Stop wakes no one, as
  waits keeps the waiters of a turn you stopped; a failed fix turn's own end
  wakes them. A seat still reading when a run stops reads "stopped".
- "2 more rounds" after a stop that left findings unsent (no gain, the cap, a
  failed fix turn) sends them first: the same code read again scores the same.
- Findings you side with the session on are marked dismissed and left out of
  fix prompts and advice, not only out of blocking.

Not built: a chairman model, a push gate (RUN is the only start), a third
reviewer, live updates over SSE, the Mini App and the bot; cancelling a
reviewer still reading when you Stop (its answer is dropped), and
council_stopped in the live NEEDS YOU list (it is in the bell and Telegram).
"""
import json
import math
import os
import re
import sys
import threading
import time
import types

from . import acp, acp_agents, git, native, profiles, queue_manager, runner, state, store, waits

DEFAULTS = {"bar": 9.0, "max_rounds": 5, "stop_early": True,
            "claude": True, "codex": True, "codex_projects": []}
SEATS = ("claude", "codex")
NEAR = 3
SEAT_TIMEOUT = 900
DIFF_CAP = 150_000
_SEV = ("must", "should", "nit")


def settings() -> dict:
    s = dict(DEFAULTS)
    try:
        saved = json.loads(store.get_setting("council") or "{}")
    except ValueError:
        saved = {}
    if isinstance(saved, dict):
        s.update({k: v for k, v in saved.items() if k in DEFAULTS})
    return s


def save_settings(patch: dict) -> dict:
    s = settings()
    try:    # a bad value keeps the current setting; this sits behind an HTTP route
        bar = float(patch["bar"])
        if math.isfinite(bar):
            s["bar"] = round(min(10.0, max(1.0, bar)) * 2) / 2
    except (KeyError, TypeError, ValueError, OverflowError):
        pass
    try:
        s["max_rounds"] = min(10, max(1, int(patch["max_rounds"])))
    except (KeyError, TypeError, ValueError, OverflowError):
        pass
    for k in ("stop_early", "claude", "codex"):
        if k in patch:
            s[k] = bool(patch[k])
    if isinstance(patch.get("codex_projects"), list):
        s["codex_projects"] = [p for p in patch["codex_projects"] if isinstance(p, str)]
    store.set_setting("council", json.dumps(s))
    return settings()


def parse_review(text: str) -> "dict | None":
    dec, last, i = json.JSONDecoder(), None, text.find("{")
    while i != -1:
        try:
            obj, _ = dec.raw_decode(text, i)
            if isinstance(obj, dict) and "score" in obj:
                last = obj
        except (ValueError, RecursionError):
            pass
        i = text.find("{", i + 1)
    if last is None:
        return None
    score = last["score"]
    if isinstance(score, bool) or not isinstance(score, (int, float)) or not 1 <= score <= 10:
        return None
    findings = []
    raw = last.get("findings")
    for f in raw if isinstance(raw, list) else []:
        if not isinstance(f, dict) or not f.get("title"):
            continue
        line = f.get("line")
        findings.append({"sev": f.get("sev") if f.get("sev") in _SEV else "should",
                         "file": str(f.get("file") or ""),
                         "line": line if isinstance(line, int) and not isinstance(line, bool) else None,
                         "title": str(f["title"])})
    return {"score": round(float(score), 1), "summary": str(last.get("summary") or ""),
            "findings": findings}


def same(a: dict, b: dict) -> bool:
    if a["file"] != b["file"]:
        return False
    if a["line"] is None or b["line"] is None:
        return a["title"].lower() == b["title"].lower()
    return abs(a["line"] - b["line"]) <= NEAR


def merge(by_seat: dict) -> list:
    out = []
    for seat, review in by_seat.items():
        for f in review["findings"]:
            for m in out:
                if same(m, f):
                    if seat not in m["by"]:
                        m["by"].append(seat)
                    if _SEV.index(f["sev"]) < _SEV.index(m["sev"]):
                        m["sev"] = f["sev"]
                    break
            else:
                out.append({"id": f"{f['file']}:{f['line'] or 0}", "sev": f["sev"],
                            "file": f["file"], "line": f["line"], "title": f["title"],
                            "by": [seat], "state": "open", "answer": ""})
    out.sort(key=lambda f: (_SEV.index(f["sev"]), f["file"], f["line"] or 0))
    return out


def _from_id(i: str) -> dict:
    file, _, line = i.rpartition(":")
    return {"file": file, "line": int(line) or None if line.isdigit() else None, "title": ""}


def _gone(f: dict, dismissed: list) -> bool:
    # A line-less finding has id file:0, which only an identical id can dismiss.
    return f["id"] in dismissed or any(g["line"] and same(f, g) for g in map(_from_id, dismissed))


def blocking(findings: list, ran: list, dismissed: list) -> list:
    return [f for f in findings
            if f["sev"] == "must" and all(s in f["by"] for s in ran) and not _gone(f, dismissed)]


def decide(c: dict) -> str:
    last = c["rounds"][-1]
    if last["score"] >= c["bar"] and not last["blocking"]:
        return "passed"
    if c["round"] >= c["max_rounds"]:
        return "stopped:max_rounds"
    if c["stop_early"] and len(c["rounds"]) > 1 and last["score"] <= c["rounds"][-2]["score"]:
        return "stopped:stalled"
    return "fixing"


def _todo(rnd: dict) -> list:
    """(index, finding) for what a fix prompt sends: open, and not one you dismissed."""
    return [(i, f) for i, f in enumerate(rnd["findings"])
            if f.get("state") == "open" and not f.get("dismissed")]


def _at(f: dict) -> str:
    return f"{f['file']}:{f['line']}" if f["line"] is not None else f["file"]


def _line(n: int, f: dict) -> str:
    return f"{n}. {f['sev'].upper()} · {_at(f)} · {'+'.join(f['by'])} · {f['title']}"


def fix_prompt(c: dict) -> str:
    last = c["rounds"][-1]
    lines = [f"[council {c['round']}/{c['max_rounds']}] {last['score']:.1f} of {c['bar']:.1f}",
             "The council reviewed what a push would send, and it isn't ready yet. "
             "Fix each finding below. If one is wrong, answer it on its own line as "
             '"<number>. NO: <why>". Don\'t push; when you finish, the council reviews again.',
             ""]
    lines += [_line(n, f) for n, (_, f) in enumerate(_todo(last), 1)]
    return "\n".join(lines)


def answers(text: str) -> dict:
    return {int(m.group(1)): m.group(2).strip()
            for m in re.finditer(r"^[ \t]*(\d+)[.)][ \t]*NO\b(?:[ \t]*[:-][ \t]*|[ \t]+)(\S.*)$", text, re.M)}


def material(cwd: str) -> "dict | None":
    rc, head, _ = git._run(cwd, "rev-parse", "HEAD")
    if rc != 0:
        return None
    head = head.strip()
    base = ""
    rc, _, _ = git._run(cwd, "rev-parse", "--verify", "-q", "@{upstream}")
    cands = ["@{upstream}"] if rc == 0 else []
    if not cands:
        d = git.default_branch(cwd)
        cands = [f"origin/{d}", d]
    for c in cands:
        rc, out, _ = git._run(cwd, "merge-base", "HEAD", c)
        if rc == 0 and out.strip():
            base = out.strip()
            break
    base = base or head     # shortcut: no base found reviews only uncommitted work
    def must(rc_out_err, what):    # a failed git call is not "nothing to review"
        rc, out, err = rc_out_err
        if rc != 0:
            raise RuntimeError(f"git {what}: {err.strip() or rc}")
        return out
    log = must(git._run(cwd, "log", "--format=%h%x00%s", f"{base}..HEAD"), "log")
    commits = [l.split("\0", 1) for l in log.splitlines() if "\0" in l]
    diff = must(git._run(cwd, "diff", base, timeout=60, errors="replace"), "diff")
    stat = must(git._run(cwd, "diff", "--numstat", base, timeout=60, errors="replace"), "diff --numstat")
    nums = [l.split("\t", 2) for l in stat.splitlines() if l.count("\t") == 2]
    un = must(git._run(cwd, "ls-files", "--others", "--exclude-standard", errors="replace"), "ls-files")
    untracked = [u for u in un.splitlines() if u]
    if not (commits or diff.strip() or untracked):
        return None
    kept, left_out, size = [], [], 0
    for sec in re.split(r"(?m)^(?=diff --git )", diff):
        if not sec:
            continue
        if size + len(sec) <= DIFF_CAP:
            kept.append(sec)
            size += len(sec)
        else:
            m = re.match(r"diff --git a/(.*?) b/", sec)
            left_out.append(m.group(1) if m else "?")
    return {"base": base, "head": head, "commits": commits, "files": len(nums),
            "add": sum(int(n[0]) for n in nums if n[0].isdigit()),
            "del": sum(int(n[1]) for n in nums if n[1].isdigit()),
            "untracked": untracked, "diff": "".join(kept),
            "truncated": bool(left_out), "left_out": left_out}


def review_prompt(m: dict, settled: list, answered: list) -> str:
    out = [native.INTERNAL_ONESHOT_TAG,
           "You are a code reviewer. Rate the work below, which a push would send, "
           "from 1 to 10 and list what is wrong.",
           "Score: 10 = ship as is; 9 = nits only; 7-8 = should-fix issues; "
           "5-6 = a must-fix; below 5 = several must-fix, or broken.",
           "Severity: must = a real bug, data loss, a security hole or broken behaviour "
           "you can point to at a line; should = worth fixing before the push; nit = taste.",
           "Reply with ONLY this JSON, in a ```json block, and nothing after it:",
           '{"score": n, "summary": "<one line, your words>", '
           '"findings": [{"sev": "must|should|nit", "file": "<path>", "line": n, "title": "<what is wrong>"}]}']
    if settled:
        out += ["", "Settled by the user, do not raise:", *settled]
    if answered:
        out += ["", "The author answered these last round; raise one again only if the answer is wrong:",
                *answered]
    out += ["", "Commits:", *([f"{sha} {subj}" for sha, subj in m["commits"]] or ["(none)"])]
    if m["untracked"]:
        out += ["", "Untracked files (not in the diff; read them):", *m["untracked"]]
    out += ["", "Diff:", m["diff"]]
    if m["truncated"]:
        out.append("The diff was cut for size. Left out, read these yourself: " + ", ".join(m["left_out"]))
    return "\n".join(out)


def _result(text: str, err: bool) -> dict:
    r = None if err else parse_review(text or "")
    if r:
        return {"ok": True, **r}
    return {"ok": False, "error": (text or "failed")[:300] if err else "no score in the reviewer's answer"}


def seat_claude(prompt: str, cwd: str, chat_id: int, slot) -> dict:
    try:
        text, _sid, _cost, err = runner.run_blocking(
            chat_id, prompt, cwd=cwd, timeout=SEAT_TIMEOUT, skip_pack=True,
            permission_mode="plan", new_session=True, account_slot=slot)
        return _result(text, err)
    except Exception as e:  # noqa: BLE001 - a seat never raises into the round
        return {"ok": False, "error": str(e)}


def _codex_acct() -> str:
    """A hidden seat has no session agent: the first Codex account, else the CLI's own login."""
    return next((a["id"] for a in acp_agents.accounts("codex")), "")


class _Awaiting(dict):
    def __call__(self, kind):     # acp calls job.awaiting(kind) when a card is raised
        pass


def _read_only_mode(acct) -> "str | None":
    """Codex's cached read-only mode id. acp.Turn.apply shrugs off a mode the agent
    doesn't list and runs in its default, which may write, so no id means no run."""
    modes = acp_agents.options_for("codex", acct).get("mode") or []
    return next((m["value"] for m in modes if "read" in m["value"].lower()), None)


def seat_codex(prompt: str, cwd: str, timeout: float = SEAT_TIMEOUT) -> dict:
    try:
        return _seat_codex(prompt, cwd, timeout)
    except Exception as e:  # noqa: BLE001 - a seat never raises into the round
        return {"ok": False, "error": str(e)}


def _seat_codex(prompt: str, cwd: str, timeout: float) -> dict:
    p, acct = acp_agents.preset("codex"), _codex_acct()
    ro = _read_only_mode(acct)
    if not ro:
        return {"ok": False, "error": "Codex has no read-only mode yet: run TEST on Codex in Settings"}
    job = types.SimpleNamespace(
        events=[], pending=[], texts=[], todos=[], awaiting=_Awaiting(), awaited=[],
        ctx_tokens=None, cost=None, result=None, error_msg=None, elapsed=None,
        status="running", boot="starting", model=None, interrupted=False, timed_out=False,
        agent_session_id=None, conn=None, turn=None, _interrupt_timer=None, needs_login=False)
    job.started = job.last_at = time.time()
    job.add = job.events.append
    job.add_pending = job.pending.append
    job.clear_pending = lambda: job.pending.clear()
    done, cut = threading.Event(), []

    def watch():
        end = time.monotonic() + timeout
        while not done.wait(0.1):
            for rid in [c["request_id"] for c in list(job.pending)] + list(job.awaiting):
                acp.answer(job, rid, False)
            if time.monotonic() >= end:
                cut.append(1)
                acp.cancel(job, 5)
                return
    threading.Thread(target=watch, daemon=True).start()
    try:
        acp.run_turn(job, argv=acp_agents.argv(p), env=acp_agents.env_for(p, acct), cwd=cwd,
                     label=p["label"], login_hint=acp_agents.login_hint(p, acct),
                     auth_method=acp_agents.auth_method(p, acct), text=prompt,
                     agent_session_id=None, opts={"permission_mode": ro})
    finally:
        done.set()
    if cut:
        return {"ok": False, "error": "timed out"}
    return _result(job.error_msg if job.status != "done" else job.result, job.status != "done")


def seats_for(session: dict, s: dict) -> dict:
    codex = "off"
    if s["codex"]:
        codex = "not-allowed"
        if (session or {}).get("project") in s["codex_projects"]:
            ready = any(a["id"] == "codex" and a["installed"] for a in acp_agents.available())
            acct = _codex_acct()
            ok = (ready and acp_agents.options_for("codex", acct).get("signed_in") is True
                  and _read_only_mode(acct) is not None)
            codex = "on" if ok else "sign-in"
    return {"claude": "on" if s["claude"] else "off", "codex": codex}


# --- the loop ------------------------------------------------------------

_lock = threading.Lock()
# This boot of the bridge. A restart execs in place and keeps the pid; this doesn't survive it.
_BOOT = f"{os.getpid()}:{time.time_ns()}"


def _spawn(fn, *args) -> None:
    threading.Thread(target=fn, args=args, daemon=True).start()


def _seat(st: str, score=None, summary: str = "", error: str = "") -> dict:
    return {"state": st, "score": score, "summary": summary, "error": error}


def _seats(session: dict, s: dict) -> dict:
    """Each seat before its answer: running, or why it sits this one out."""
    return {k: _seat("running" if v == "on" else v) for k, v in seats_for(session, s).items()}


def _queued(sid: str, item_id) -> "dict | None":
    return next((i for i in queue_manager.snapshot(sid).get("items") or [] if i.get("id") == item_id), None)


def _busy(c) -> bool:
    return bool(c) and c.get("status") in ("reviewing", "fixing")


def _stop(c: dict, reason: str) -> dict:
    """Stopped, with no seat left spinning: one still reading says "stopped"."""
    c.update(status="stopped", reason=reason, at=time.time(),
             seats={k: dict(v, state="stopped") if v.get("state") == "running" else v
                    for k, v in (c.get("seats") or {}).items()})
    return c


def _settle(sid: str) -> "dict | None":
    """The stored run with the restart rules applied and saved. Under _lock."""
    c = store.get_council(sid)
    if c and c.get("boot") != _BOOT and (
            c.get("status") == "reviewing"
            or c.get("status") == "fixing" and _queued(sid, c.get("item")) is None):
        store.set_council(sid, _stop(c, "interrupted by a restart"))
    return c


def get(sid: str) -> "dict | None":
    with _lock:
        return _settle(sid)


def _ran(rnd: dict) -> list:
    return [k for k, v in rnd["seats"].items() if v["state"] == "done"]


def _blocks(c: dict, rnd: dict) -> list:
    return blocking(rnd["findings"], _ran(rnd), c["dismissed"])


def _enqueue(sid: str, text: str) -> str:
    sess = store.get_session(sid) or {}
    return queue_manager.enqueue(
        sid, text=text, prompt=text, images=[], model=None, effort=None,
        permission_mode=None, width=None, sel=[], surface="council",
        chat_id=sess.get("chat_id"), project=sess.get("project") or "")


def _fix(sid: str, c: dict, text: str = "", sent: "list | None" = None) -> None:
    """Queue a fix prompt, the last round's open findings unless given, and wait
    on it; `sent` keeps which findings, in the prompt's numbering, for
    after_turn. Under _lock. "fixing" is saved before the enqueue, so
    after_turn's unlocked first look sees it even for a turn that ends at once."""
    c.update(status="fixing", reason="", item=None, boot=_BOOT, at=time.time(),
             sent=[i for i, _ in _todo(c["rounds"][-1])] if sent is None else sent)
    store.set_council(sid, c)
    try:
        c["item"] = _enqueue(sid, text or fix_prompt(c))
    except Exception as e:  # noqa: BLE001 - a fix that never queued can't be waited on
        _stop(c, f"couldn't queue the fix: {e}")


def start(session: dict, cwd: str) -> dict:
    """RUN: review what a push from `cwd` would send, then loop."""
    sid = session["id"]
    if state.is_running(sid):
        raise ValueError("running")
    if _busy(get(sid)):
        raise ValueError("busy")
    try:
        if material(cwd) is None:
            raise ValueError("nothing")
    except RuntimeError:
        pass                        # a git failure is the round's to report, as its stop reason
    s, now = settings(), time.time()
    c = {"status": "reviewing", "round": 1, "rounds": [], "boot": _BOOT, "cwd": cwd,
         "bar": s["bar"], "max_rounds": s["max_rounds"], "stop_early": s["stop_early"],
         "dismissed": [], "item": None, "since": now, "at": now, "seats": _seats(session, s)}
    with _lock:
        if _busy(_settle(sid)):
            raise ValueError("busy")            # a second tap on RUN
        store.set_council(sid, c)
    _spawn(_round, sid)
    return brief(sid)


def _mine(sid: str, key: tuple) -> "dict | None":
    """The run, if it is still on round `key` (its start, its number). Under _lock."""
    c = store.get_council(sid)
    return c if c and c.get("status") == "reviewing" and (c.get("since"), c.get("round")) == key else None


def _land(sid: str, key: tuple, stop: str = "", **kw) -> None:
    """Write onto round `key` if the run is still on it; with `stop`, the run ends there."""
    with _lock:
        c = _mine(sid, key)
        if not c:
            return
        c.update(kw, at=time.time())
        if stop:
            _stop(c, stop)
        store.set_council(sid, c)
    if stop:
        _ended(sid, c)


def _told(c: dict) -> tuple:
    """What the reviewers hear: what you settled, and the author's answers last round."""
    seen = {f["id"]: f for r in c["rounds"] for f in r["findings"]}
    settled = [f"{_at(seen[d])} · {seen[d]['title']}" if d in seen else d for d in c["dismissed"]]
    last = c["rounds"][-1]["findings"] if c["rounds"] else []
    return settled, [f"{_at(f)} · {f['title']} — {f['answer']}" for f in last if f["state"] == "answered"]


def _sit(on: list, prompt: str, cwd: str, session: dict) -> dict:
    """Every seat at once, against one deadline: one still reading at it timed out."""
    slot = profiles.claude_slot(profiles.effective(session)) if "claude" in on else None
    run = {"claude": lambda: seat_claude(prompt, cwd, session.get("chat_id"), slot),
           "codex": lambda: seat_codex(prompt, cwd)}
    got = {}
    ts = [threading.Thread(target=lambda k=k: got.update({k: run[k]()}), daemon=True) for k in on]
    for t in ts:
        t.start()
    end = time.monotonic() + SEAT_TIMEOUT + 30
    for t in ts:
        t.join(max(0.0, end - time.monotonic()))
    return {k: got.get(k) or {"ok": False, "error": "timed out"} for k in on}


def _round(sid: str) -> None:
    """One review round, on its own thread."""
    c = get(sid)
    if not c or c.get("status") != "reviewing":
        return
    key = (c.get("since"), c["round"])
    try:
        session = store.get_session(sid) or {}
        seats = _seats(session, settings())
        _land(sid, key, seats=seats)
        m = material(c["cwd"])
        if m is None:               # pushed or committed elsewhere while the loop ran
            return _land(sid, key, stop="nothing left to review")
        on = [k for k in SEATS if seats.get(k, {}).get("state") == "running"]
        got = _sit(on, review_prompt(m, *_told(c)), c["cwd"], session)
        for k in on:
            r = got[k]
            seats[k] = (_seat("done", r["score"], r["summary"]) if r["ok"]
                        else _seat("error", error=r["error"]))
        ran = [k for k in on if got[k]["ok"]]
        if not ran:
            why = next((got[k]["error"] for k in on), "no reviewer is switched on")
            return _land(sid, key, seats=seats, stop=f"no reviewer answered: {why}")
        findings = merge({k: got[k] for k in ran})
        with _lock:
            c = _mine(sid, key)
            if not c:
                return              # stopped, or a new run, while the seats read
            for f in findings:
                if _gone(f, c["dismissed"]):
                    f["dismissed"] = True
            c["rounds"].append({"n": key[1], "score": round(sum(got[k]["score"] for k in ran) / len(ran), 1),
                                "blocking": len(blocking(findings, ran, c["dismissed"])),
                                "seats": seats, "findings": findings, "at": time.time()})
            c["seats"] = seats
            v = decide(c)
            if v == "fixing":
                _fix(sid, c)
            elif v == "passed":
                c.update(status="passed", reason="", at=time.time())
            else:
                _stop(c, {"stopped:max_rounds": f"it used all {c['max_rounds']} rounds",
                          "stopped:stalled": f"round {key[1]} didn't raise the score"}[v])
            store.set_council(sid, c)
        if c["status"] != "fixing":
            _ended(sid, c)
    except Exception as e:  # noqa: BLE001 - material's git failure is the reason; nothing stays "reviewing"
        _land(sid, key, stop=str(e) or type(e).__name__)


def after_turn(job) -> bool:
    """A turn ended. If it ran the council's fix prompt, its answers go on the
    last round and the next round starts: True, so that turn's DONE waits for
    the verdict. Best-effort: never raises into the turn's end."""
    try:
        sid = job.store_session_id
        c = store.get_council(sid) if sid else None
        if not c or c.get("status") != "fixing":
            return False            # nearly every turn: no lock, so none waits on a round's enqueue
        with _lock:
            c = _settle(sid)
            if not c or c.get("status") != "fixing":
                return False
            it = _queued(sid, c.get("item"))
            if it and it.get("job_id") != job.id and it.get("status") in ("queued", "running"):
                return False        # another turn: the fix waits, or has only just begun
            if job.status != "done" or job.interrupted:
                _stop(c, "the fix turn stopped")
            else:
                said, found = answers(job.result or ""), c["rounds"][-1]["findings"]
                for n, i in enumerate(c.get("sent") or [], 1):     # the prompt's numbering
                    found[i]["state"], found[i]["answer"] = (
                        ("answered", said[n]) if n in said else ("fixed", ""))
                c.update(status="reviewing", round=c["round"] + 1, boot=_BOOT, item=None, sent=[],
                         at=time.time())
            store.set_council(sid, c)
        if c["status"] == "stopped":
            _spawn(_ended, sid, c, False)   # False below: the turn's own end wakes its waiters
            return False
        _spawn(_round, sid)
        return True
    except Exception as e:  # noqa: BLE001 - never raise into the turn lifecycle
        print(f"[council] after_turn failed: {e}", file=sys.stderr)
        return False


def act(session: dict, action: str, key: str = "") -> dict:
    """A tap in the tab: stop | more | side | fix | advice."""
    sid = session["id"]
    with _lock:
        c, then = _act(sid, action, key)
    if then == "round":
        _spawn(_round, sid)
    elif then == "tell":
        _spawn(_ended, sid, c)
    return brief(sid)


def _act(sid: str, action: str, key: str) -> tuple:
    """act()'s change, under _lock: the saved run, and what follows it."""
    c = _settle(sid)
    last = ((c or {}).get("rounds") or [None])[-1]
    then, was = None, (c or {}).get("status")
    if action == "stop":
        if not _busy(c):
            return c, None          # nothing to stop: a second tap
        it = _queued(sid, c.get("item"))
        if it and it.get("status") == "queued":
            queue_manager.remove(sid, it["id"])
        _stop(c, "you stopped it")
    elif action == "advice":
        if _busy(c):
            raise ValueError("busy")
        blocked = _blocks(c, last) if last else []
        tips = [f for f in last["findings"] if f not in blocked and not f.get("dismissed")] if last else []
        if not tips:
            raise ValueError("nothing")
        _enqueue(sid, "\n".join(["[council advice]"] + [_line(n, f) for n, f in enumerate(tips, 1)]))
        c["advice_sent"] = True
    elif action not in ("more", "side", "fix") or (c or {}).get("status") != "stopped":
        raise ValueError("action")
    elif action == "more":
        c["max_rounds"] += 2
        if last and _todo(last):
            _fix(sid, c)            # its findings were never sent: send them, then read again
        else:
            c.update(status="reviewing", reason="", round=c["round"] + 1, boot=_BOOT)
            then = "round"
    else:
        i = next((i for i, f in enumerate(last["findings"]) if f["id"] == key), None) if last else None
        if i is None:
            raise ValueError("action")
        if action == "side":
            c["dismissed"].append(key)
            for f in last["findings"]:
                if _gone(f, c["dismissed"]):
                    f["dismissed"] = True
            last["blocking"] = len(_blocks(c, last))
            if last["score"] >= c["bar"] and not last["blocking"]:
                c.update(status="passed", reason="")
                then = "tell"
        else:
            c["max_rounds"] += 1
            _fix(sid, c, f"[council {c['round']}/{c['max_rounds']}] the user wants this fixed\n"
                 + _line(1, last["findings"][i]), [i])
    if c["status"] != was:
        c["at"] = time.time()       # `at` is when the status moved: a passed run's elapsed stays put
    store.set_council(sid, c)
    return c, then


def _stuck(c: dict) -> "dict | None":
    """The blocking finding they keep raising: it matches one in each of the k
    rounds before the last (k >= 2), with the session's latest answer to it."""
    rs, best = c["rounds"], None
    for f in _blocks(c, rs[-1]) if rs else []:
        k, answer = 0, ""
        for r in reversed(rs[:-1]):
            g = next((g for g in r["findings"] if same(f, g)), None)
            if g is None:
                break
            k, answer = k + 1, answer or g["answer"]
        if k >= 2 and (best is None or k > best["rounds"]):
            best = {"finding": dict(f, blocking=True), "rounds": k, "answer": answer}
    return best


def brief(sid: str, cwd: "str | None" = None, full: bool = False) -> dict:
    """What the tab draws: the run, or before one the settings and seats. Never stored."""
    c = get(sid)
    if c:
        rs = c["rounds"]
        last = rs[-1] if rs else None
        blocked = _blocks(c, last) if last else []
        found = [dict(f, blocking=f in blocked) for f in (last["findings"] if last else [])]
        out = {"status": c["status"], "reason": c.get("reason") or "", "round": c["round"],
               "max_rounds": c["max_rounds"], "bar": c["bar"], "score": last["score"] if last else None,
               "rounds": [{"n": r["n"], "score": r["score"], "blocking": r["blocking"]} for r in rs],
               "seats": c["seats"], "findings": found,
               "previous": rs[-2]["findings"] if len(rs) > 1 else [], "stuck": _stuck(c),
               "advice": [f for f in found if not f["blocking"] and not f.get("dismissed")],
               "fixed_total": sum(f["state"] == "fixed" for r in rs for f in r["findings"]),
               "advice_sent": bool(c.get("advice_sent")),
               "elapsed": int((time.time() if _busy(c) else c["at"]) - c["since"])}
    else:
        s = settings()
        out = {"status": "idle", "reason": "", "round": 0, "max_rounds": s["max_rounds"], "bar": s["bar"],
               "score": None, "rounds": [], "findings": [], "previous": [], "stuck": None, "advice": [],
               "fixed_total": 0, "advice_sent": False, "elapsed": 0,
               "seats": {k: _seat(v) for k, v in seats_for(store.get_session(sid) or {}, s).items()}}
    if full and cwd:
        try:
            m = material(cwd)
        except RuntimeError:
            m = None
        out["material"] = {k: m[k] for k in ("commits", "files", "add", "del")} if m else None
    return out


def _ended(sid: str, c: dict, wake: bool = True) -> None:
    """A run passed or stopped: one notice through the house notifier (Telegram
    follows NOTIFY's choices), then the sessions waiting on this one are woken,
    since the turn end that would have woken them led into the council.
    Best-effort."""
    rs = c.get("rounds") or []
    score = rs[-1]["score"] if rs else None
    passed = c.get("status") == "passed"
    rounds = f"{len(rs)} round{'s' * (len(rs) != 1)}"
    try:
        label = runner._session_label(sid)                                  # noqa: SLF001
        chat = (store.get_session(sid) or {}).get("chat_id")
        if passed:
            body = f"{score:.1f} of {c['bar']:.1f} in {rounds}"
            runner._notify(chat, f"⚖ Council passed — {label}\n{body}", None,       # noqa: SLF001
                           kind="council_passed", sid=sid, body=body, meta={"score": score})
        else:
            runner._notify(chat, f"⚖ Council needs you — {label}\n{c['reason']}", None,   # noqa: SLF001
                           kind="council_stopped", sid=sid, body=c["reason"], meta={"score": score})
    except Exception as e:  # noqa: BLE001 - the verdict stands either way
        print(f"[council] notice failed: {e}", file=sys.stderr)
    if not wake:
        return
    try:
        said = f"Council passed · {score:.1f} in {rounds}" if passed else f"Council stopped · {c['reason']}"
        waits.target_ended(types.SimpleNamespace(store_session_id=sid, status="done", result=said,
                                                 texts=[], elapsed=int(time.time() - c["since"])))
    except Exception as e:  # noqa: BLE001
        print(f"[council] wake failed: {e}", file=sys.stderr)
