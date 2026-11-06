"""Today's wins: what shipped today, across every session of the chat — the
right rail's HOME reads it as a spine down the day.

Read-side only, like report.py. Every Bash call is already in the events
table: its command in the `tool` event (`detail`, else `summary`) and what it
printed in the matching `tool_done` (`output`, plus `is_error`). A win is a call
whose command and output agree that something landed: a commit, a merge, a
push, a PR opened, a test run that passed. Commits in one turn fold into one
win ("6 commits"), and so do a turn's test runs (its last passing one), since a
session working task by task would otherwise bury the merge that mattered.

Why not `git log`: it misses PRs and test runs, needs a walk per repo, and
can't tell the sessions' work from the user's own. Why no table: nothing here
outlives the events it is read from. Best effort throughout: a command we can't
read is simply not a win, and nothing here raises into a request.
"""

import datetime
import json
import os
import re
import time

from bridge import store
from bridge.report import _WORKTREE, _slug

# shortcut: a gap of 30 minutes between turns reads as away, fixed; a setting when someone asks.
AWAY = 30 * 60
# Turns closer than this run on as one stretch of work.
JOIN = 5 * 60

# Commands are matched on the command with its heredoc bodies and quoted strings
# blanked, and only where a command starts, so a report that *mentions*
# `git merge` (cat <<EOF …) or a script that prints "git push" is no win.
_HEREDOC_BODY = re.compile(r"<<-?\s*(['\"]?)(\w+)\1[^\n]*\n.*?(?:^\s*\2\s*$|\Z)", re.S | re.M)
_QUOTED = re.compile(r"\"(?:[^\"\\]|\\.)*\"|'[^']*'")
_AT = r"(?:^|[;&|(\n]|\bthen\b|\bdo\b)\s*(?:\w+=\S*\s+)*"
_GIT = _AT + r"git\b(?:\s+-C\s+\S+)?\s+"
_COMMIT = re.compile(_GIT + r"commit\b")
_MERGE = re.compile(_GIT + r"merge\b(?!-)")          # not merge-base / merge-file
_PUSH = re.compile(_GIT + r"push\b")
_PR = re.compile(_AT + r"gh\s+pr\s+create\b")
_TEST = re.compile(r"\b(?:pytest|vitest|jest|node\s+--test|(?:npm|pnpm|yarn)\s+(?:run\s+)?test)\b")
_MSG = re.compile(r"""-m\s+(?:"((?:[^"\\]|\\.)*)"|'([^']*)')""")
_HEREDOC = re.compile(r"""<<\s*'?(\w+)'?\s*\n\s*([^\n]+)""")


def _bare(cmd: str) -> str:
    return _QUOTED.sub('""', _HEREDOC_BODY.sub("<<EOF\n", cmd))


def _args(bare: str, m: "re.Match") -> list:
    """The plain arguments after a matched subcommand, up to the next command:
    flags and blanked strings dropped."""
    rest = re.split(r"[;&|)\n]", bare[m.end():], maxsplit=1)[0]
    return [t for t in rest.split() if not t.startswith("-") and t != '""' and not re.match(r"\d?>", t)]


def _subject(cmd: str, out: str) -> str:
    m = re.search(r"^\[[^\]\n]+ [0-9a-f]{7,}\] (.+)$", out, re.M)
    if m:
        return m.group(1).strip()
    m = _MSG.search(cmd)
    if m:
        msg = m.group(1) if m.group(1) is not None else m.group(2)
        if msg.startswith("$("):
            h = _HEREDOC.search(cmd)
            return h.group(2).strip() if h else ""
        return msg.split("\n")[0].strip()
    return ""


def _tests(out: str) -> "int | None":
    """How many passed, when the run says it all passed; None otherwise."""
    if re.search(r"\b[1-9]\d* (?:failed|errors?)\b", out) or re.search(r"# fail [1-9]", out):
        return None
    for pat in (r"(\d+) passed", r"Tests:?\s+(\d+) passed", r"# pass (\d+)"):
        m = re.findall(pat, out)
        if m:
            return int(m[-1])
    return None


def classify(cmd: str, out: str, is_error: bool) -> list[dict]:
    """The wins one Bash call shows: [] when its output doesn't back them up.
    A compound command (commit && push) can show more than one."""
    cmd, out = cmd or "", out or ""
    bare = _bare(cmd)
    wins = []
    landed = re.search(r"^\[[^\]\n]+ [0-9a-f]{7,}\] ", out, re.M)
    if _COMMIT.search(bare) and "--amend" not in bare and "nothing to commit" not in out \
            and "no changes added to commit" not in out and (landed or not is_error):
        wins.append({"kind": "commit", "text": _subject(cmd, out)})
    m = _MERGE.search(bare)
    if m and "--abort" not in bare and "CONFLICT" not in out and "Already up to date" not in out \
            and "fatal:" not in out and ("Fast-forward" in out or "Merge made" in out or not is_error):
        args = _args(bare, m)
        wins.append({"kind": "merge", "text": args[0] if args else ""})
    m = _PUSH.search(bare)
    if m and "Everything up-to-date" not in out and "[rejected]" not in out \
            and "failed to push" not in out and ("->" in out or not is_error):
        args = _args(bare, m)
        ref = args[1].lstrip("+").split(":")[-1] if len(args) > 1 else ""
        shown = re.findall(r"->\s+(\S+)", out)
        wins.append({"kind": "push", "text": ref or (shown[-1] if shown else "")})
    if _PR.search(bare):
        m = re.search(r"/pull/(\d+)", out)
        if m:
            wins.append({"kind": "pr", "text": f"#{m.group(1)}"})
    if _TEST.search(bare) and not is_error:
        n = _tests(out)
        if n:
            wins.append({"kind": "tests", "text": f"{n:,}"})
    return wins


def _home(project: str, repos: dict) -> str:
    """A worktree's wins count toward its repo when exactly one repo of the
    chat has that folder name (report._fold_worktrees' rule)."""
    m = _WORKTREE.match(project)
    home = repos.get(m.group(1)) if m else None
    return home[0] if home and len(home) == 1 else project


def _union(spans: list) -> list:
    out = []
    for s, e in sorted(spans):
        if out and s <= out[-1][1] + JOIN:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return out


def today(chat_id: int, now: "float | None" = None) -> dict:
    """Since local midnight: the wins (newest first), the stretches worked per
    project, the gaps between them that read as away, and the time worked."""
    now = time.time() if now is None else now
    since = datetime.datetime.fromtimestamp(now).replace(hour=0, minute=0, second=0, microsecond=0).timestamp()
    events = store.day_tool_events(chat_id, since)
    spans = store.day_turn_spans(chat_id, since)
    repos: dict = {}
    for p in {e["project"] for e in events} | {t["project"] for t in spans}:
        if not _WORKTREE.match(p):
            repos.setdefault(_slug(os.path.basename(p)), []).append(p)

    pending, done = {}, []
    for e in events:
        try:
            p = json.loads(e["payload"])
        except (TypeError, ValueError):
            continue
        if e["type"] == "tool" and p.get("name") == "Bash" and p.get("id"):
            pending[p["id"]] = (p.get("detail") or p.get("summary") or "", e)
        elif e["type"] == "tool_done" and p.get("id") in pending:
            cmd, call = pending.pop(p["id"])
            for w in classify(cmd, p.get("output") or "", bool(p.get("is_error"))):
                done.append(dict(w, ts=e["ts"], project=_home(call["project"], repos),
                                 session=call["session_id"], turn=call["turn_id"]))

    # A turn's commits fold into one win, and its test runs into its last passing one.
    rows, folded = [], {}
    for w in done:
        if w["kind"] in ("commit", "tests"):
            prev = folded.get((w["turn"], w["kind"]))
            if prev:
                prev["ts"] = w["ts"]
                if w["kind"] == "tests":
                    prev["text"] = w["text"]
                else:
                    prev["n"] += 1
                    prev["last"] = w["text"]
                continue
            w.update(n=1, last=w["text"])
            folded[(w["turn"], w["kind"])] = w
        rows.append(w)
    for r in rows:
        n, last = r.pop("n", 1), r.pop("last", None)
        if r["kind"] == "commit" and n > 1:
            r.update(kind="commits", text=str(n), detail=last)
        r["big"] = r["kind"] in ("merge", "pr", "commits")
    rows.sort(key=lambda r: -r["ts"])

    work: dict = {}
    for t in spans:
        end = t["started"] + t["elapsed"] if t["elapsed"] is not None else now
        work.setdefault(_home(t["project"], repos), []).append((t["started"], min(end, now)))
    stretches = [{"project": p, "start": s, "end": e} for p, sp in work.items() for s, e in _union(sp)]
    every = _union([(s["start"], s["end"]) for s in stretches])
    away = [{"start": a[1], "end": b[0]} for a, b in zip(every, every[1:]) if b[0] - a[1] >= AWAY]
    return {
        "since": since,
        "now": now,
        "wins": rows,
        "work": sorted(stretches, key=lambda s: s["start"]),
        "away": away,
        "worked": round(sum(e - s for s, e in every)),
    }
