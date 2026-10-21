"""STYLE WITH AI (SETTINGS ▸ Projects): one model call looks at every project's
candidate logos and says what each should wear, on what background, in which
colour (docs/superpowers/specs/logo-stylist.md).

The bridge can't draw a logo (stdlib only, no SVG renderer), so the dashboard
draws the contact sheet: each project's candidates from
projectmarks.style_candidates(), numbered, on a dark ground and a light one.
That picture goes inline to one sonnet call over stream-json, with no tools,
MCP servers, hooks or saved session: about 12k tokens, a cent or two. Sonnet,
not haiku: on this machine's real sheet haiku thought for ~27 s before its
first line (it thinks at any effort) and once took SvelteKit's default favicon
for Elvou's; sonnet answered from ~14 s and kept Elvou's own monogram. The model answers one JSON line per
project; each line is checked and applied (projectmarks.apply_style) the moment
it is complete, so the page and the bell show real progress rather than an
animation over a finished answer.

One call, not one per project: seeing every project at once is what lets it
give one client's repos one mark, and read a hub's clients' logos as clients'.

The run is the bridge's, not the page's: closing SETTINGS doesn't stop it, the
bell draws it from /local/running (`live()`), and it ends in a notice. One runs
at a time; the last one's answers stay readable until the next one starts.
"""

import base64
import copy
import json
import os
import re
import shutil
import subprocess
import tempfile
import threading
import time
import uuid

from bridge import aifeatures, notices, projectmarks, runner

MODEL = "sonnet"
TIMEOUT_S = 180          # the call, start to last line: a sheet of 21 projects answers in ~20 s
SHEET_MAX = 6 * 1024 * 1024
# The model's "none" means no plate needed, which is AUTO's call to make: AUTO measures where a logo
# would vanish (lib/logoinfo.ts), so a pinned NONE would only hide a black wordmark on a dark theme.
BGS = {"auto": "auto", "none": "auto", "light": "light", "dark": "dark"}
# shortcut: any lucide-shaped name passes, and a name lucide lacks shows the initials
# (DynamicIcon's fallback); check against lucide's list if the model starts inventing them.
_ICON = re.compile(r"^[a-z0-9-]{1,48}$")
_HEX = re.compile(r"^#[0-9a-fA-F]{6}$")
# The page's 16x16 average hash of each picture (lib/stylerun.ts). A pick within SAME_BITS of what the
# project wears is a copy of it (an icon-512.png of Rivendell's emblem): the model sometimes "switches"
# to one, which changes nothing you can see and quietly stops the project following Rivendell. Measured
# here: copies 0-12 bits, the same lion cropped differently 51, different logos 66 and up.
SAME_BITS = 24
_HASH = re.compile(r"^[0-9a-f]{64}$")
_LOGO = re.compile(r"^[0-9a-f]{64}\.(png|jpg|webp|svg)$")

_lock = threading.Lock()
_run: dict = {"state": "idle"}
_proc: "subprocess.Popen | None" = None

_RULES = """You choose each project's mark for a developer dashboard. A mark is a 20 px rounded tile shown beside \
the project's name, on dark themes and light ones.

The picture is a contact sheet. Each project starts with its key and name (P1 shop). Its candidates follow, \
each in a framed box of its own: the id at the top of the box (c1, c2, ...), and below it the candidate drawn \
twice, on a dark ground and on a light ground. An id belongs to the pictures in its own box only.

For every project choose:
- pick: the candidate that reads best as that project's own mark at 20 px, by its id ("c2"); "keep" for what it \
wears now; or, only when no candidate is the project's own, an icon as "icon:<lucide icon name>" that fits what \
the project is.
- bg: the background behind a logo. "auto" leaves it bare and adds a plate only on a ground it would vanish \
into; "light" or "dark" always puts that plate behind it. Almost always "auto".
- color: one #rrggbb accent, taken from the mark it will wear (for an icon, one that suits the project).
- why: at most 12 words, lowercase, why this one.

Rules:
- Only the project's own brand. A picture of another company or of a client (a hub keeps its clients' logos) is \
not the project's.
- Never a framework's leftover default: React, Vite, Next.js, Svelte, Vue, Angular, Expo, Electron and the like.
- A symbol or a square app icon beats a wide wordmark: words vanish at 20 px.
- One layer of an icon (an Android foreground, background or monochrome) is not a whole icon.
- When what it wears is already the best, "keep" it. A logo Rivendell lends is the client's own choice: keep it \
unless another candidate is clearly better at 20 px, and never swap it for a copy of the same picture.
- Repos of one client or product wear the same mark.

Answer with one JSON object per line, in the order of the projects, and nothing else:
{"p":"P1","pick":"c2","bg":"auto","color":"#3168d0","why":"its own app icon reads at a glance"}
Then, if you passed over a framework's default or another company's logo, one last line naming them in at most 25 words: {"p":"note","why":"react's logo in elvou is a framework's"}"""

_WEARS = {"letters": "its initials", "auto": "its own icon, from the repo", "rivendell": "the logo Rivendell lends it",
          "pick": "a logo picked earlier", "style": "your last pick", "icon": "an icon", "logo": "a logo"}


def _label(c: dict, p: dict) -> str:
    if c["src"] == "now":
        return "what it wears now" + (f" ({c['path']})" if c.get("path") else
                                      " (Rivendell's logo)" if p["wears"] == "rivendell" else "")
    if c["src"] == "frontend":
        return f"its frontend {c['from'].rpartition('/')[2]}'s logo"
    return c.get("path") or c["id"]


def _prompt(projects: list) -> str:
    rows = []
    for p in projects:
        cands = " · ".join(f"{c['id']} {_label(c, p)}" for c in p["cands"]) or "none"
        rows.append(f"{p['key']} {p['name']} — {p['rel']}" + (f", github {p['remote']}" if p["remote"] else "")
                    + (f". About: {p['about']}" if p["about"] else "")
                    + f". Wears {_WEARS.get(p['wears'], p['wears'])}. Candidates: {cands}")
    return _RULES + "\n\nThe projects:\n" + "\n".join(rows)


def state() -> dict:
    """The run as the page draws it: its answers so far, and the line being written."""
    with _lock:
        return copy.deepcopy(_run)


def live() -> "dict | None":
    """What the bell draws while a run is on: how far it has got."""
    with _lock:
        if _run.get("state") != "running":
            return None
        return {"id": _run["id"], "total": _run["total"], "decided": len(_run["items"]),
                "changed": sum(1 for i in _run["items"] if i["how"]), "started": _run["started"]}


def start(sheet_b64: str, sig: str, hashes: "dict | None" = None) -> dict:
    """Start a run over the sheet the page drew from style_candidates() `sig`,
    with each picture's average hash (`hashes`, logo name -> hex) when the page
    sent them. ValueError for a sheet that can't be used, RuntimeError while one
    runs."""
    global _run
    if not aifeatures.enabled("logostyle"):
        raise ValueError("Style with AI is off in Settings ▸ AI")
    try:
        sheet = base64.b64decode(sheet_b64 or "", validate=True)
    except (ValueError, TypeError):
        raise ValueError("the sheet isn't base64") from None
    if not sheet.startswith(b"\x89PNG\r\n\x1a\n") or len(sheet) > SHEET_MAX:
        raise ValueError("the sheet must be a PNG under 6 MB")
    got = projectmarks.style_candidates()
    if got["sig"] != sig:
        raise ValueError("the projects changed while the sheet was drawn; try again")
    projects = [{**p, "key": f"P{i + 1}"} for i, p in enumerate(got["projects"])]
    hashes = {k: v for k, v in (hashes if isinstance(hashes, dict) else {}).items()
              if isinstance(k, str) and isinstance(v, str) and _LOGO.match(k) and _HASH.match(v)}
    with _lock:
        if _run.get("state") == "running":
            raise RuntimeError("Style with AI is already running")
        rid = uuid.uuid4().hex[:12]
        _run = {"id": rid, "state": "running", "started": time.time(), "ended": None, "total": len(projects),
                "projects": [{"rel": p["rel"], "key": p["key"], "name": p["name"], "cands": p["cands"]} for p in projects],
                "yours": got["yours"], "items": [], "current": "", "error": None}
    threading.Thread(target=_work, args=(rid, sheet, projects, hashes), daemon=True, name="logostyle").start()
    return state()


def stop() -> dict:
    """STOP: the call is killed; what landed stays, and Undo takes it back."""
    with _lock:
        p = _proc if _run.get("state") == "running" else None
        if _run.get("state") == "running":
            _run["stopping"] = True
    if p:
        p.kill()
    return state()


def _work(rid: str, sheet: bytes, projects: list, hashes: dict) -> None:
    by_key = {p["key"]: p for p in projects}
    try:
        err = _ask(sheet, _prompt(projects), lambda line: _take(rid, by_key, line, hashes), lambda part: _part(rid, part))
    except Exception as e:  # noqa: BLE001 — a run must end, whatever broke
        err = str(e) or type(e).__name__
    _finish(rid, err)


def _ask(sheet: bytes, prompt: str, on_line, on_part) -> "str | None":
    """One call with the sheet inline. Each complete line of the answer goes to
    on_line as it streams in, the line still being written to on_part. Returns
    what went wrong, or None."""
    global _proc
    msg = {"type": "user", "message": {"role": "user", "content": [
        {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                     "data": base64.b64encode(sheet).decode()}},
        {"type": "text", "text": prompt}]}}
    cmd = [runner.claude_bin(), "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
           "--include-partial-messages", "--model", MODEL, "--effort", "low", "--no-session-persistence", "--tools", "",
           "--strict-mcp-config", "--settings", '{"disableAllHooks":true}']
    tmp = tempfile.mkdtemp(prefix="logostyle-")
    try:
        with open(os.path.join(tmp, "stderr"), "w+") as err:
            try:
                p = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=err, text=True,
                                     cwd=tmp, env=runner._run_env("off"))
            except OSError as e:
                return f"claude didn't start: {e}"
            with _lock:
                _proc = p
                if _run.get("stopping"):
                    p.kill()
            timer = threading.Timer(TIMEOUT_S, p.kill)
            timer.start()
            buf, result = "", None
            try:
                p.stdin.write(json.dumps(msg) + "\n")
                p.stdin.close()
                for raw in p.stdout:
                    try:
                        e = json.loads(raw)
                    except ValueError:
                        continue
                    ev = (e.get("event") or {}) if e.get("type") == "stream_event" else {}
                    d = (ev.get("delta") or {}) if ev.get("type") == "content_block_delta" else {}
                    if d.get("type") == "text_delta":
                        *lines, buf = (buf + (d.get("text") or "")).split("\n")
                        for line in lines:
                            on_line(line)
                        on_part(buf)
                    elif e.get("type") == "result":
                        result = e
                if buf.strip():
                    on_line(buf)
                p.wait()
            except OSError:
                p.kill()
            finally:
                timer.cancel()
                with _lock:
                    _proc = None
            if result is not None and not result.get("is_error"):
                return None
            err.seek(0)
            return (str((result or {}).get("result") or "") or err.read().strip()[-300:]
                    or f"claude stopped ({p.returncode})")[:300]
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _same(a: "str | None", b: "str | None") -> bool:
    return bool(a and b) and bin(int(a, 16) ^ int(b, 16)).count("1") <= SAME_BITS


def _take(rid: str, by_key: dict, line: str, hashes: "dict | None" = None) -> None:
    """One line of the answer: checked, then worn. A line that isn't an answer,
    names no project of this run or answers one twice changes nothing; a pick
    that isn't one of the project's candidates, or is a copy of what it wears,
    keeps what it wears."""
    try:
        v = json.loads(line.strip())
    except ValueError:
        return
    p = by_key.get(str(v.get("p") or "").strip()) if isinstance(v, dict) else None
    if isinstance(v, dict) and v.get("p") == "note":
        with _lock:
            if _run.get("id") == rid:
                _run["note"] = " ".join(str(v.get("why") or "").split())[:300]
        return
    with _lock:
        if not p or _run.get("id") != rid or _run.get("stopping") or any(i["rel"] == p["rel"] for i in _run["items"]):
            return
    pick = str(v.get("pick") or "keep").strip()
    icon = pick[5:] if pick.startswith("icon:") and _ICON.match(pick[5:]) else None
    cand = next((c for c in p["cands"] if c["id"] == pick), None)
    now = next((c for c in p["cands"] if c["src"] == "now"), None)
    if cand and now and cand is not now and _same((hashes or {}).get(cand["logo"]), (hashes or {}).get(now["logo"])):
        cand = None
    color = v.get("color") if isinstance(v.get("color"), str) and _HEX.match(v["color"]) else None
    why = " ".join(str(v.get("why") or "").split())[:160]
    try:
        got = projectmarks.apply_style(p["rel"], cand, icon=icon, plate=BGS.get(str(v.get("bg"))), color=color,
                                       why=why, run=rid)
    except (ValueError, OSError) as e:
        got = {"rel": p["rel"], "how": [], "error": str(e)}
    with _lock:
        if _run.get("id") == rid:
            _run["items"].append({**got, "key": p["key"], "pick": pick, "why": why})


def _part(rid: str, text: str) -> None:
    with _lock:
        if _run.get("id") == rid:
            _run["current"] = text[-600:]



def summary(items: list) -> str:
    """'1 new logo · 2 colours · 12 already right': what a run did, for the notice."""
    def n(k, one, many):
        c = sum(1 for i in items if k(i["how"]))
        return f"{c} {one if c == 1 else many}" if c else ""
    parts = [n(lambda h: h[:1] == ["logo"], "new logo", "new logos"), n(lambda h: h[:1] == ["icon"], "new icon", "new icons"),
             n(lambda h: "background" in h, "background", "backgrounds"), n(lambda h: "colour" in h, "colour", "colours"),
             n(lambda h: not h, "already right", "already right")]
    return " · ".join(p for p in parts if p)


def _finish(rid: str, err: "str | None") -> None:
    with _lock:
        if _run.get("id") != rid:
            return
        stopped = bool(_run.pop("stopping", False))
        _run.update(state="stopped" if stopped else "failed" if err else "done", ended=time.time(), current="",
                    error=None if stopped else err)
        run = copy.deepcopy(_run)
    if stopped:
        return                              # you stopped it: nothing to tell you
    changed = sum(1 for i in run["items"] if i["how"])
    if run["state"] == "failed":
        notices.emit("style_failed", f"logostyle:{rid}", title="Style with AI",
                     body=f"{err}" + (f" · {changed} changed before it stopped, Undo takes them back" if changed else ""),
                     meta={"run": rid})
    else:
        notices.emit("styled", f"logostyle:{rid}", title=f"{changed} project{'' if changed == 1 else 's'}",
                     body=summary(run["items"]), meta={"run": rid})
