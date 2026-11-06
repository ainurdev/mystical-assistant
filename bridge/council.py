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

Not built: a chairman model, a push gate (RUN is the only start), a third
reviewer, live updates over SSE, the Mini App and the bot.
"""
import json
import re

from . import store

DEFAULTS = {"bar": 9.0, "max_rounds": 5, "stop_early": True,
            "claude": True, "codex": True, "codex_projects": []}
SEATS = ("claude", "codex")
NEAR = 3
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
    if "bar" in patch:
        s["bar"] = min(10.0, max(1.0, round(float(patch["bar"]) * 2) / 2))
    if "max_rounds" in patch:
        s["max_rounds"] = min(10, max(1, int(patch["max_rounds"])))
    for k in ("stop_early", "claude", "codex"):
        if k in patch:
            s[k] = bool(patch[k])
    if "codex_projects" in patch:
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
        except ValueError:
            pass
        i = text.find("{", i + 1)
    if last is None:
        return None
    score = last["score"]
    if isinstance(score, bool) or not isinstance(score, (int, float)) or not 1 <= score <= 10:
        return None
    findings = []
    for f in last.get("findings") or []:
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
    return [f for f in findings
            if f["sev"] == "must" and all(s in f["by"] for s in ran)
            and not any(same(f, g) for g in gone)]


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
            for m in re.finditer(r"^\s*(\d+)[.)]\s*NO\b[:\s-]*(.+)$", text, re.M)}
