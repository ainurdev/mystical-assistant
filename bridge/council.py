"""The council: reviewers rate the work a push would send (1-10) and list
findings; the session that wrote the code fixes them until the score passes.

This module is the pure core: settings, parsing a reviewer's answer, merging
findings from several seats, and deciding whether to go on. Running the
reviewers and the round loop live elsewhere. Spec: docs/superpowers/specs/council-tab.md.

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

Not built: a chairman model, a push gate (RUN is the only start), a third
reviewer, live updates over SSE, the Mini App and the bot.
"""
import json
import math
import re
import threading
import time
import types

from . import acp, acp_agents, git, native, runner, store

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


def blocking(findings: list, ran: list, dismissed: list) -> list:
    gone = [_from_id(d) for d in dismissed]
    # A line-less finding has id file:0, which only an identical id can dismiss.
    return [f for f in findings
            if f["sev"] == "must" and all(s in f["by"] for s in ran)
            and f["id"] not in dismissed
            and not any(g["line"] and same(f, g) for g in gone)]


def decide(c: dict) -> str:
    last = c["rounds"][-1]
    if last["score"] >= c["bar"] and not last["blocking"]:
        return "passed"
    if c["round"] >= c["max_rounds"]:
        return "stopped:max_rounds"
    if c["stop_early"] and len(c["rounds"]) > 1 and last["score"] <= c["rounds"][-2]["score"]:
        return "stopped:stalled"
    return "fixing"


def fix_prompt(c: dict) -> str:
    last = c["rounds"][-1]
    lines = [f"[council {c['round']}/{c['max_rounds']}] {last['score']:.1f} of {c['bar']:.1f}",
             "The council reviewed what a push would send, and it isn't ready yet. "
             "Fix each finding below. If one is wrong, answer it on its own line as "
             '"<number>. NO: <why>". Don\'t push; when you finish, the council reviews again.',
             ""]
    open_ = [f for f in last["findings"] if f.get("state") == "open"]
    for i, f in enumerate(open_, 1):
        lines.append(f"{i}. {f['sev'].upper()} · {f['file']}:{f['line']} · "
                     f"{'+'.join(f['by'])} · {f['title']}")
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
