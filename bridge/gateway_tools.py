"""The Mystical tools beyond the basics: evidence, browser, memory, waiting, secrets.

The test for adding one: Bash is 78% of all tool calls here, so a tool that wraps what Bash
does fine earns nothing. Each of these does something Bash can't, or replaces something
agents kept hand-rolling (a browser driver in a scratch script, a by-eye comparison of test
failures against master).

They run in the bridge, so they work the same for any provider. A call must answer within
Kimi Code's 60 s MCP timeout, so anything slower runs in the background and reports back by
the same delivery the channel uses (channel._reach). Rare ones aren't listed up front: an
agent that loads every description eagerly pays for each one on every turn, so they sit
behind find_tools with the shared servers (EXTRA), and any name can still be called.

A figure (show_image, compare_images) is the agent showing you something, as opposed to a
picture it read to look at. It goes on the turn as its own `figure` event with a caption,
copied beside the turn's uploads like Attach's, so it's drawn large with the answer and
sent on Telegram. Stdlib only.
"""

import json
import mimetypes
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time

from bridge import chat_images, config, devserver, handoff, profiles, store

_MCP_S = 45
_CHECK_MAX_S = 1800
_LOG_TAIL = 6000
_FIGURE_MAX = 64 * 1024 * 1024
_SECRET_NAME = re.compile(r"^[A-Z][A-Z0-9_]{0,63}$")
_lock = threading.Lock()


def _t(name: str, description: str, props: "dict | None" = None, required: "list | None" = None) -> dict:
    return {"name": name, "description": description,
            "inputSchema": {"type": "object", "properties": props or {}, "required": required or []}}


_S = {"type": "string"}
_IMG = {"type": "string", "description": "Path to an image or video on this machine."}
SHOW = _t("show_image", "Put an image or video in front of the user, drawn large with your answer. This is how "
          "you show proof; a picture you only read to look at stays in the work log. The caption says what it "
          "proves, in one line: \"Checkout on a phone: the button no longer overlaps the total\". Capture at 2x "
          "and crop to the part that matters.",
          {"path": _IMG, "caption": {"type": "string", "description": "One line: what this shows."}},
          ["path", "caption"])
DATA = {"name": "show_data", "description": (
    "Draw a live sheet, chart, board or diagram in the chat. Use it in any conversation, whenever numbers or items "
    "would otherwise be a list or a Markdown table: test coverage or bundle size by folder, benchmarks, options side "
    "by side, a plan's status as a board, tasks, finances, a burndown; or a flowchart for how something works and a "
    "timeline for what happened. Call it once per view; several in one answer are "
    "fine. Totals, burndown lines and counts are computed for you. Then keep your reply to what stands out. Use real "
    "data only, and say when it's partial."),
    "inputSchema": {"type": "object", "required": ["view", "title"], "properties": {
        "view": {"type": "string", "enum": ["table", "chart", "kanban", "stats", "diagram"]},
        "title": {"type": "string", "description": "What this is, as you'd say it to the user."},
        "caption": {"type": "string", "description": "Optional: one line on what stands out."},
        "source": {"type": "string", "description": "Where the data came from: Rivendell board X, Snelstart, bank CSV."},
        "as_of": {"type": "string", "description": "When it's from. Default: today."},
        "currency": {"type": "string", "description": "ISO code for money, like EUR."},
        "columns": {"type": "array", "items": {"type": "object"}, "description":
                    "table: [{key, label, type: text|number|money|percent|progress|date|link, currency}]; progress "
                    "draws a 0-100 value as a bar. "
                    "kanban: [{name, limit, cards: [{title, key, assignee, due, priority, tags, note, url}]}], "
                    "including empty columns."},
        "rows": {"type": "array", "items": {"type": "object"}, "description":
                 "table and chart: one object per row, keyed by column. Send amounts as plain JSON numbers. "
                 "Up to 5000 for a table, 500 for a chart."},
        "totals": {"type": "boolean", "description": "table: false hides the computed totals row."},
        "nodes": {"type": "array", "items": {"type": "object"}, "description":
                  "diagram, flow: [{id, label, note, shape: process|decision|terminal, group}]. Laid out for you."},
        "edges": {"type": "array", "items": {"type": "object"}, "description": "diagram, flow: [{from, to, label}]."},
        "direction": {"type": "string", "enum": ["right", "down"], "description": "diagram, flow. Default: fits the screen."},
        "kind": {"type": "string", "enum": ["bar", "bar_stacked", "line", "area", "donut", "burndown", "flow", "timeline"], "description":
                 "diagram: flow or timeline. chart: bar to compare, line or area over time, bar_stacked for parts of a whole over time, donut for "
                 "a few parts of one whole, burndown for work remaining (the ideal line is computed)."},
        "x": {"type": "string", "description": "chart: the row key for the x axis."},
        "series": {"type": "array", "items": {}, "description":
                   "chart: row keys to plot, or [{key, label}]. All on one axis, so same unit. Two different units "
                   "are two charts."},
        "format": {"type": "string", "enum": ["number", "money", "percent"], "description":
                   "chart: how values read. For percent, 12 means 12%."},
        "x_label": _S, "y_label": _S,
        "ideal_end": {"type": "number", "description": "burndown: where the ideal line ends. Default 0."},
        "items": {"type": "array", "items": {"type": "object"}, "description":
                  "stats: [{label, value, format: number|money|percent|text, currency, delta, note}]. "
                  "diagram, timeline: [{date, label, note, state: done|now|next}], in the order to show."}}}}
COMPARE = _t("compare_images", "Show a before and an after side by side, with one caption saying what changed.",
             {"before": _IMG, "after": _IMG, "caption": _S}, ["before", "after", "caption"])
CHECKS = _t("run_checks", "Run this project's tests or checks and record the result in the chat, compared with "
            "the failures already known, so \"7 failed, the same as before\" is on record. It runs in the "
            "background and the result arrives as a message unless it finishes within seconds. Set `command` "
            "once for a project and it's remembered.",
            {"command": {"type": "string", "description": "Leave out to use the project's own or a detected one."},
             "baseline": {"type": "boolean", "description": "True: record these failures as the known ones. Only "
                          "on a clean base branch, or when the user says so."}})
DRIVE = _t("drive_page", "Open a page in a headless browser, go through steps with real clicks and keys, and get "
           "back screenshots, console errors, exceptions and failed requests. Use this instead of writing a "
           "browser script. Doesn't show anything to the user: call show_image for what they should see.",
           {"url": _S, "viewport": {"type": "string", "enum": ["desktop", "phone"]},
            "steps": {"type": "array", "description": "In order. Each is one of {click: 'visible text or /regex/'}, "
                      "{type: 'text'}, {key: 'Enter'}, {wait: ms}, {scroll: pixels}, {eval: 'js'}, {shot: 'label'}.",
                      "items": {"type": "object"}}}, ["url"])
REPORT = _t("show_report", "Present a Markdown file you wrote (a report, a review, a plan) as a card in the chat, "
            "instead of pasting it. Save it under .mystical/docs/ first.",
            {"path": _S, "title": _S, "summary": {"type": "string", "description": "One or two lines."}},
            ["path", "title"])
SEARCH = _t("search_chats", "Search earlier chats and saved lessons: what was decided, what was tried.",
            {"query": _S, "project_only": {"type": "boolean"}}, ["query"])
READ_CHAT = _t("read_chat", "Read an earlier chat that search_chats found: its prompts and answers.",
               {"id": _S, "last": {"type": "integer", "description": "How many of its newest turns. Default 10."}},
               ["id"])
WAIT = _t("wait_for", "Stop waiting by hand: end your turn after this, and you're woken when it's true. Waits on "
          "a time, a pull request's checks, or a local port answering. A prompt from the user cancels it.",
          {"kind": {"type": "string", "enum": ["time", "pr", "port"]},
           "seconds": {"type": "integer", "description": "time: how long from now."},
           "pr": {"type": "string", "description": "pr: its number or URL."},
           "port": {"type": "integer"}, "then": {"type": "string", "description": "What you'll do next."}},
          ["kind", "then"])
WAIT_SESSION = _t("wait_for_session", "Wake when another session here finishes its turn. End your turn after this.",
                  {"session": {"type": "string", "description": "Its id, or words from its title. ? lists them."},
                   "then": _S}, ["session"])
NOTIFY = _t("notify_me", "Ping the user now on their phone, without ending your turn. For something they'd want "
            "to know before you finish. Not for routine progress.",
            {"title": _S, "body": _S}, ["title"])
LOGS = _t("server_logs", "Read the output of this project's dev server, the one run_project started.",
          {"lines": {"type": "integer"}})
USAGE = _t("usage_left", "How much of the current account's usage is left, so you can pace long work.")
SECRET = _t("request_secret", "Ask the user for a key or password. They paste it in a card, and it goes straight to "
            "this project's .env without passing through you or the chat. Use this instead of asking in text. "
            "Your code reads it from the environment or the file.",
            {"name": {"type": "string", "description": "The variable name, like STRIPE_KEY."},
             "why": {"type": "string", "description": "What it's for, in one line."}}, ["name", "why"])
SCREENSHOT = _t("screenshot", "Look at a page: returns a screenshot to you alone. Use show_image for what the user should see.",
                {"url": _S, "width": {"type": "integer"}, "height": {"type": "integer"}}, ["url"])
RECORD = _t("record", "Record a page to a video and put it in the chat. Returns its final frame. It runs up to 40 s.",
            {"url": _S, "seconds": {"type": "integer"}, "caption": _S}, ["url"])

# Listed for every session that gets the gateway.
CORE_ALL = (SHOW, DATA, CHECKS, DRIVE)
# Reached through find_tools: rarely used, so they don't cost every turn.
EXTRA_ALL = (COMPARE, REPORT, SEARCH, READ_CHAT, WAIT, NOTIFY, LOGS, USAGE, SECRET)
# Device runs aren't here: they run under a device's Claude account and their route finds
# the session by its Claude id, so an agent session has nothing to send.
EXTRA_AGENT = (WAIT_SESSION, SCREENSHOT, RECORD)
HANDLED = {t["name"] for t in (*CORE_ALL, *EXTRA_ALL, *EXTRA_AGENT)}


def _text(s: str, error: bool = False) -> dict:
    out = {"content": [{"type": "text", "text": s}]}
    if error:
        out["isError"] = True
    return out


def _cwd(s: dict) -> str:
    return s.get("work_cwd") or s.get("cwd") or config.BASE_PATH


def call(s: dict, job, name: str, a: dict) -> dict:
    fn = _FUNCS.get(name)
    return fn(s, job, a) if fn else _text(f"Unknown tool: {name}", error=True)


# ------- figures ---------------------------------------------------------------

def _copy_in(job_id: str, path: str, tag: str) -> "tuple[str | None, str | None]":
    path = os.path.abspath(os.path.expanduser(str(path or "").strip()))
    if not os.path.isfile(path):
        return None, f"Nothing at {path}."
    kind = mimetypes.guess_type(path)[0] or ""
    if not kind.startswith(("image/", "video/")) or kind == "image/svg+xml":
        return None, f"Not an image or video: {path}."
    if os.path.getsize(path) > _FIGURE_MAX:
        return None, f"{path} is too big to show."
    d = os.path.join(config.UPLOAD_DIR, job_id)
    os.makedirs(d, exist_ok=True)
    out = os.path.join(d, f"{tag}-{os.path.basename(path)}")
    shutil.copy2(path, out)
    return out, None


def _figure(s: dict, job, items: list, caption: str, kind: str) -> dict:
    caption = " ".join(str(caption or "").split())[:400]
    if not caption:
        return _text("Say what it shows: a caption is required.", error=True)
    if job is None:
        return _text("No turn is running to show this in.", error=True)
    tag = f"fig-{int(time.time() * 1000)}"
    images = []
    for i, p in enumerate(items):
        got, why = _copy_in(job.id, p, f"{tag}-{i}")
        if why:
            return _text(why, error=True)
        images.append(got)
    job.add({"type": "figure", "kind": kind, "images": images, "caption": caption})
    _send_figure(s, job, images, caption)
    return _text("It's in the chat, with your caption. The user can see it now.")


def _send_figure(s: dict, job, images: list, caption: str) -> None:
    """Pictures you were shown reach Telegram too; ones an agent only looked at don't."""
    if not getattr(job, "tg_live", False):
        return
    from bridge import telegram, tgtopics
    try:
        thread = tgtopics.thread_for(job.chat_id, s["id"])
        for p in images:
            if (mimetypes.guess_type(p)[0] or "").startswith("image/"):
                telegram.send_photo(job.chat_id, p, caption=caption[:900], thread=thread)
    except Exception as e:  # noqa: BLE001 - the chat still has it
        print(f"[gateway_tools] telegram figure: {e!r}", file=sys.stderr)


def _show_data(s: dict, job, a: dict) -> dict:
    """A sheet, chart or board on the turn (bridge/data_views.py)."""
    from bridge import data_views
    if job is None:
        return _text("No turn is running to show this in.", error=True)
    try:
        ev, notes = data_views.build(a)
    except data_views.Refused as e:
        return _text(str(e), error=True)
    job.add(ev)
    said = f"It's in the chat: {data_views.describe(ev)}. Keep your reply short and don't repeat the data."
    if notes:
        said += f"\n{len(notes)} value(s) couldn't be read and show blank:\n" + "\n".join(notes[:10])
    return _text(said)


def _show_image(s: dict, job, a: dict) -> dict:
    return _figure(s, job, [a.get("path")], a.get("caption"), "shown")


def _compare(s: dict, job, a: dict) -> dict:
    return _figure(s, job, [a.get("before"), a.get("after")], a.get("caption"), "compare")


# ------- run_checks ----------------------------------------------------------------

def _checks_path(root: str) -> str:
    return os.path.join(root, ".mystical", "checks.json")


def _read_checks(root: str) -> dict:
    try:
        with open(_checks_path(root), encoding="utf-8") as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_checks(root: str, d: dict) -> None:
    devserver.mystical_dir(root)
    tmp = _checks_path(root) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(d, f, indent=2)
    os.replace(tmp, _checks_path(root))


def detect_command(root: str) -> "str | None":
    """The obvious test command for a repo, or None."""
    has = lambda *p: os.path.exists(os.path.join(root, *p))  # noqa: E731
    if has("tests") and (has("pytest.ini") or has("pyproject.toml") or has("setup.py") or has("tests", "conftest.py")):
        return "python3 -m pytest tests/ -q"
    if has("package.json"):
        try:
            with open(os.path.join(root, "package.json"), encoding="utf-8") as f:
                if "no test specified" not in (json.load(f).get("scripts") or {}).get("test", "no test specified"):
                    return "npm test --silent"
        except (OSError, ValueError):
            pass
    if has("go.mod"):
        return "go test ./..."
    if has("Cargo.toml"):
        return "cargo test"
    return None


_FAIL_LINE = re.compile(r"^(?:FAILED|ERROR)\s+(\S+)|^\s*(?:FAIL|✕|×)\s+(.+?)\s*$|^--- FAIL: (\S+)", re.M)


def parse_output(out: str) -> dict:
    """Numbers and failing names from the common runners' output. What it can't read
    stays None and the exit code speaks for itself."""
    tail = out[-20000:]
    nums = {}
    for key in ("passed", "failed", "skipped"):
        found = re.findall(rf"(\d+)\s+{key}", tail)
        nums[key] = int(found[-1]) if found else None
    names = sorted({next(g for g in m.groups() if g) for m in _FAIL_LINE.finditer(tail)})[:200]
    return {**nums, "failures": names}


def _run_checks_now(s: dict, job, cmd: str, root: str, baseline: bool, cwd: str) -> dict:
    t0 = time.time()
    try:
        p = subprocess.run(cmd, shell=True, cwd=cwd, capture_output=True, text=True, timeout=_CHECK_MAX_S,
                           errors="replace", env={**os.environ, "CI": "1"})
        out, code = (p.stdout or "") + (p.stderr or ""), p.returncode
    except subprocess.TimeoutExpired as e:
        out, code = str(e.stdout or "")[-_LOG_TAIL:] + "\n(timed out)", 124
    got = parse_output(out)
    data = _read_checks(root)
    known = set(data.get("known") or [])
    fresh = [f for f in got["failures"] if f not in known]
    if baseline:
        data["known"] = got["failures"]
        known, fresh = set(got["failures"]), []
    data["command"] = cmd
    _write_checks(root, data)
    log = os.path.join(root, ".mystical", "checks-last.log")
    try:
        with open(log, "w", encoding="utf-8") as f:
            f.write(out)
    except OSError:
        log = ""
    ok = code == 0 or (bool(got["failures"]) and not fresh)
    return {"type": "checks", "command": cmd, "ok": ok, "code": code, "ms": int((time.time() - t0) * 1000),
            "passed": got["passed"], "failed": got["failed"], "skipped": got["skipped"], "new": fresh[:40],
            "known": sorted(known & set(got["failures"]))[:40], "log": os.path.relpath(log, root) if log else "",
            "tail": out[-1500:]}


def _describe_checks(ev: dict) -> str:
    bits = [f"{ev[k]} {k}" for k in ("passed", "failed", "skipped") if ev.get(k) is not None]
    head = ", ".join(bits) or f"exit code {ev['code']}"
    if ev["new"]:
        say = f"{head}. New failures:\n" + "\n".join(ev["new"])
    elif ev["known"]:
        say = f"{head}. All {len(ev['known'])} failures were already known, none are new."
    else:
        say = head + "."
    return f"`{ev['command']}`: {say}\nFull output: {ev['log']}\n\n{ev['tail'] if not ev['ok'] else ''}".strip()


def _run_checks(s: dict, job, a: dict) -> dict:
    from bridge import agent_caps, channel, runner
    cwd, root = _cwd(s), chat_images.root_of(_cwd(s))
    if not root:
        return _text("This chat has no project folder.", error=True)
    data = _read_checks(root)
    cmd = str(a.get("command") or data.get("command") or detect_command(cwd) or "").strip()
    if not cmd:
        return _text("I can't tell how to test this project. Call again with `command`.", error=True)
    agent = profiles.effective(s)["agent"]
    result: dict = {}

    def work():
        ev = _run_checks_now(s, job, cmd, root, a.get("baseline") is True, cwd)
        result.update(ev)
        live = runner.live_job(s["id"])
        if live is not None:
            live.add(ev)
        else:
            channel._journal(s, ev)
    t = threading.Thread(target=work, daemon=True)
    t.start()
    t.join(_MCP_S if agent_caps.caps(agent)["block"] else 40)
    if not t.is_alive():
        return _text(_describe_checks(result))

    def report():
        t.join()
        chat = store.get_session(s["id"])
        if chat and result:
            channel._reach(chat, chat, f"⧖ Your checks finished. {_describe_checks(result)}")
    threading.Thread(target=report, daemon=True).start()
    return _text(f"`{cmd}` is still running. Carry on, or end your turn: the result arrives as a message.")


# ------- drive_page ------------------------------------------------------------------

def _drive(s: dict, job, a: dict) -> dict:
    node = shutil.which("node")
    if not node:
        return _text("Node isn't installed here, so there's no browser to drive.", error=True)
    url = str(a.get("url") or "")
    if not re.match(r"^https?://", url):
        return _text("url must be an absolute http(s) URL.", error=True)
    phone = a.get("viewport") == "phone"
    spec = {"url": url, "width": 390 if phone else 1280, "height": 844 if phone else 800, "mobile": phone,
            "scale": 2, "steps": a.get("steps") if isinstance(a.get("steps"), list) else []}
    d = tempfile.mkdtemp(prefix="mystical-drive-")
    try:
        path = os.path.join(d, "spec.json")
        with open(path, "w", encoding="utf-8") as f:
            json.dump(spec, f)
        js = os.path.join(os.path.dirname(os.path.abspath(__file__)), "drive.mjs")
        try:
            p = subprocess.run([node, js, path, d], capture_output=True, text=True, timeout=_MCP_S)
        except subprocess.TimeoutExpired:
            return _text(f"The page took over {_MCP_S} s. Use fewer steps or shorter waits.", error=True)
        try:
            got = json.loads((p.stdout or "").strip().splitlines()[-1])
        except (ValueError, IndexError):
            return _text(f"The browser failed: {(p.stderr or p.stdout)[-400:]}", error=True)
        if got.get("error"):
            return _text(got["error"], error=True)
        lines = []
        for key, label in (("exceptions", "Exceptions"), ("console", "Console"), ("failed", "Failed requests"),
                           ("log", "Steps")):
            if got.get(key):
                lines.append(f"{label}:\n" + "\n".join(got[key][:20]))
        blocks = [{"type": "text", "text": "\n\n".join(lines) or "No console errors, exceptions or failed requests."}]
        import base64
        for sh in got.get("shots", [])[-4:]:
            with open(sh["path"], "rb") as f:
                blocks += [{"type": "text", "text": f"Screenshot: {sh['label']}"},
                           {"type": "image", "data": base64.b64encode(f.read()).decode(), "mimeType": "image/png"}]
        return {"content": blocks}
    finally:
        shutil.rmtree(d, ignore_errors=True)


# ------- report -------------------------------------------------------------------------

def _report(s: dict, job, a: dict) -> dict:
    root = chat_images.root_of(_cwd(s))
    raw = str(a.get("path") or "")
    path = os.path.realpath(raw if os.path.isabs(raw) else os.path.join(_cwd(s), raw))
    if not root or not (path.startswith(os.path.realpath(root) + os.sep)
                        or path.startswith(os.path.realpath(_cwd(s)) + os.sep)):
        return _text("The report has to be a file in this project.", error=True)
    if not os.path.isfile(path) or not path.endswith((".md", ".markdown", ".txt")):
        return _text(f"No Markdown file at {raw}.", error=True)
    if job is None:
        return _text("No turn is running to show this in.", error=True)
    job.add({"type": "report", "path": os.path.relpath(path, root), "title": str(a.get("title"))[:200],
             "summary": str(a.get("summary") or "")[:600], "bytes": os.path.getsize(path)})
    return _text("It's in the chat as a card.")


# ------- memory -------------------------------------------------------------------------

def _search(s: dict, job, a: dict) -> dict:
    from bridge import chat_search
    rows = chat_search.search(s["chat_id"], str(a.get("query") or ""),
                              project=s.get("project") if a.get("project_only") else None, exclude=s["id"])
    if not rows:
        return _text("Nothing matches.")
    return _text("\n\n".join(f"{r['title']} ({r['project']}, id {r['session_id'][:12]})\n{r['snippet']}" for r in rows))


def _read_chat(s: dict, job, a: dict) -> dict:
    want = str(a.get("id") or "")
    if len(want) < 6:
        return _text("Give the id search_chats showed.", error=True)
    rows = [r for r in store.list_sessions_all(s["chat_id"], include_archived=True, max_age_secs=None)
            if r["id"].startswith(want)]
    if not rows:
        return _text("No chat has that id.", error=True)
    turns = store.turns_of(rows[0]["id"])[-min(int(a.get("last") or 10), 50):]
    blocks = [handoff._turn_block(rows[0], t, tools=False) for t in turns]
    return _text(f"{rows[0].get('title')}\n\n" + "\n\n".join(b for b in blocks if b)[:40000])


# ------- waiting -------------------------------------------------------------------------

def _wait_for(s: dict, job, a: dict) -> dict:
    from bridge import timed_waits
    return _text(timed_waits.add(s, a))


def _wait_session(s: dict, job, a: dict) -> dict:
    from bridge import waits
    return _text(waits.add(s["chat_id"], s["id"], str(a.get("session") or ""), str(a.get("then") or "")))


def _notify(s: dict, job, a: dict) -> dict:
    from bridge import runner
    title = " ".join(str(a.get("title") or "").split())[:200]
    if not title:
        return _text("Give it a title.", error=True)
    runner._notify(s["chat_id"], f"📣 {title} — {runner._session_label(s['id'])}",
                   runner._session_kb(s["chat_id"], s["id"], "Open"), kind="agent_note", sid=s["id"],
                   body=str(a.get("body") or "")[:1000], always=True)
    return _text("Sent.")


def _logs(s: dict, job, a: dict) -> dict:
    lines = devserver.log_tail(min(int(a.get("lines") or 100), 500), _cwd(s))
    return _text("\n".join(str(x) for x in lines) or "No dev server output yet.")


def _usage(s: dict, job, a: dict) -> dict:
    from bridge import accounts, agent_caps, usage
    eff = profiles.effective(s)
    if not agent_caps.caps(eff["agent"])["usage"]:
        return _text(f"{handoff.label(eff['agent'])} doesn't report its usage to Mystical, so this can't say.")
    try:
        slot = profiles.claude_slot(eff) or accounts.DEFAULT_SLOT
        data = usage.get_usage(accounts.credentials_path(slot)) if hasattr(accounts, "credentials_path") else usage.get_usage()
    except Exception as e:  # noqa: BLE001 - a read
        return _text(f"Couldn't read usage: {e}")
    return _text(json.dumps(data)[:2000])


# ------- secrets -------------------------------------------------------------------------

def write_secret(cwd: str, name: str, value: str) -> "str | None":
    """Put NAME=value in this project's .env. Returns a refusal, or None. Only into a file
    git ignores: a key must not land somewhere a commit would take it. A value can't hold
    a newline, so it can't add a second variable."""
    if not _SECRET_NAME.match(name or ""):
        return "That name isn't a valid variable name."
    if "\n" in value or "\r" in value or "\0" in value or not value:
        return "That value can't be stored on one line."
    path = os.path.join(cwd, ".env")
    git = subprocess.run(["git", "-C", cwd, "rev-parse", "--is-inside-work-tree"], capture_output=True, text=True)
    if git.returncode == 0:
        ignored = subprocess.run(["git", "-C", cwd, "check-ignore", "-q", ".env"], capture_output=True)
        if ignored.returncode != 0:
            return ".env isn't ignored by git here, so a key saved there could get committed."
    quoted = '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    lines = []
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.read().splitlines()
    except OSError:
        pass
    lines = [ln for ln in lines if not re.match(rf"^\s*(export\s+)?{re.escape(name)}\s*=", ln)]
    lines.append(f"{name}={quoted}")
    tmp = path + ".tmp"
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    os.replace(tmp, path)
    return None


_secret_cards: dict = {}


def _request_secret(s: dict, job, a: dict) -> dict:
    from bridge import agent_caps, gateway
    name = str(a.get("name") or "").strip()
    if not _SECRET_NAME.match(name):
        return _text("name must look like STRIPE_KEY.", error=True)
    if job is None:
        return _text("No turn is running to ask from.", error=True)
    cwd = _cwd(s)
    why = " ".join(str(a.get("why") or "").split())[:300]

    def on_answer(answers: list) -> str:
        said = next((x.get("value") for x in answers if isinstance(x, dict) and "value" in x), None)
        if not said:
            return False, f"The user didn't give {name}. Carry on without it, or say what you need."
        refused = write_secret(cwd, name, str(said))
        if refused:
            return False, refused
        return True, (f"{name} is saved in .env for this project. It didn't pass through the chat; "
                      "read it from the environment or the file when your code runs.")
    return gateway.card_of_kind(job, s, "secret", {"name": name, "why": why}, on_answer,
                                f"Mystical needs {name}: {why}")


# ------- agent parity ---------------------------------------------------------------------

def _screenshot(s: dict, job, a: dict) -> dict:
    import base64
    from bridge import screenshot
    url = str(a.get("url") or "")
    if not re.match(r"^https?://", url):
        return _text("url must be an absolute http(s) URL.", error=True)
    try:
        png = screenshot.capture(url, min(int(a.get("width") or 1200), 1600), min(int(a.get("height") or 900), 1600))
    except Exception as e:  # noqa: BLE001 - chrome missing, timeout
        return _text(f"Screenshot failed: {e}", error=True)
    return {"content": [{"type": "text", "text": f"Screenshot of {url}:"},
                        {"type": "image", "data": base64.b64encode(png).decode(), "mimeType": "image/png"}]}


def _record(s: dict, job, a: dict) -> dict:
    import base64
    from bridge import record
    url = str(a.get("url") or "")
    if not re.match(r"^https?://", url):
        return _text("url must be an absolute http(s) URL.", error=True)
    try:
        path, still, _chapters = record.capture(url, min(int(a.get("seconds") or 8), 30))
    except Exception as e:  # noqa: BLE001
        return _text(f"Recording failed: {e}", error=True)
    res = _figure(s, job, [path], a.get("caption") or f"Recording of {url}", "shown")
    if still:
        with open(still, "rb") as f:
            res["content"].append({"type": "image", "data": base64.b64encode(f.read()).decode(),
                                   "mimeType": "image/jpeg"})
    return res


_FUNCS = {
    "show_image": _show_image, "show_data": _show_data, "compare_images": _compare, "run_checks": _run_checks, "drive_page": _drive,
    "show_report": _report, "search_chats": _search, "read_chat": _read_chat, "wait_for": _wait_for,
    "wait_for_session": _wait_session, "notify_me": _notify, "server_logs": _logs, "usage_left": _usage,
    "request_secret": _request_secret, "screenshot": _screenshot, "record": _record,
}
