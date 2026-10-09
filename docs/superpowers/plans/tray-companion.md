# Tray Companion Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Put Mystical.app's menu bar on Windows (bridge in WSL) and Linux desktops: a tray icon with the waiting-on-you count, start/stop/restart, and alerts while no dashboard window is open.

**Architecture:** Two small tray programs built only from what each OS ships — `windows/tray.ps1` (Windows PowerShell 5.1 + WinForms) and `linux/tray.py` (system python3 + PyGObject). Both poll the dashboard's `GET /local/running` every 4 s and diff its status map. They stay quiet while a new `watched` flag says a dashboard page with its own alerts is polling. `bridge/startup.py` starts them at login with OPEN THE WINDOW TOO, and `mystical app` starts them right away.

**Tech Stack:** Python 3 stdlib (bridge + tests, pytest), PyGObject (Gtk 3.0, Notify 0.7, AyatanaAppIndicator3 0.1), Windows PowerShell 5.1 + System.Windows.Forms/System.Drawing, bash, React/TypeScript (one poll flag).

**Spec:** `docs/superpowers/specs/tray-companion-design.md`

## Global Constraints

- The bridge backend stays **Python stdlib only**. The trays are desktop clients: `linux/tray.py` = stdlib + the distro's PyGObject, run on **`/usr/bin/python3`**; `windows/tray.ps1` = **Windows PowerShell 5.1** + WinForms, no PowerShell 7 syntax (`??`, `?.`, `&&`, `||`, `? :`).
- `windows/tray.ps1` is **ASCII only**. Glyphs are built from code points: ⏸ `0x23F8`, ✓ `0x2713`, ⏳ `0x23F3`, ● `0x25CF`, ○ `0x25CB`, … `0x2026`, · `0x00B7`, — `0x2014`.
- Poll every **4 s**. HTTP timeout **3 s**. `watched` window **90 s**. Polls ignore any system proxy.
- Alert text: `⏸ <title>` / body label, else `waiting on you`; `✓ <title>` / `finished` (title falls back to `session`, never the label); `⏳ <title>` / body label, else `parked`. Titles come from `jobs[].title`, remembered across polls, falling back to the label, then `session`.
- Opening a session: `--profile-directory=<profile> --app=http://localhost:<port>/?<manifest start_url query>&s=<id>&skipboot`. Open dashboard: same, without `s`/`skipboot`. No Chromium browser → system default (`Start-Process <url>` / `xdg-open`).
- One instance: mutex `Local\mystical-tray` (Windows), `fcntl.flock` on `$XDG_RUNTIME_DIR/mystical-tray.lock` (Linux).
- Quitting the tray never stops the bridge. Bridge commands go through `bin/mystical start|stop|restart` in a login+interactive bash (`bash -lic`).
- Tray arguments: Windows `-Port -Distro -User -Repo -Browser -BrowserProfile`; Linux `--port --browser --profile` (+ `--check`).
- Tests run with `~/.cache/mystical-test-venv/bin/python -m pytest` (alias `$PY` below). On this Mac, master already fails 7 known tests: `test_clip_panel::test_clip_marks_round_trip`, 4 in `test_map_command`, and `test_startup::test_script_opens_a_window_only_when_asked` + `test_startup::test_state_reports_why_when_there_is_no_windows_side`. Any other red test is caused by this work.
- Commits: local only, never pushed. No `Co-Authored-By` lines (the user's CLAUDE.md overrides the harness default).
- Comments: `shortcut: <the limit>, <when to upgrade>` for known limits. Module docstrings carry the why.

### Spec tweaks made while planning (already folded into the spec)

1. ASCII-only `tray.ps1` with code-point glyphs, instead of "UTF-8 with BOM". It satisfies the same requirement, and a BOM is one editor save away from being stripped.
2. `-BrowserProfile`, not `-Profile`: `$PROFILE` is a PowerShell automatic variable.
3. `wsl.exe … -e bash -lic`, not `-- bash -lic`: `--` hands the line to the default shell, which re-parses the quoting. The Linux tray uses `bash -lic` too, because a desktop session's PATH lacks nvm's npm (`mystical start` rebuilds stale bundles).
4. The "done" title skips the label. A working session's label is its activity, so "✓ running Bash" would read as if Bash finished.
5. On Linux, `mystical app` and the doctor both use `linux/tray.py --check`, so the package names live in one place. AppIndicator gives a left click to the menu, so a middle click opens the dashboard.

## Review Focus

1. **The bridge goes down and comes back** (WSL shut down, a restart): the tray must show `○ stopped`, keep running, and treat the first answer afterwards as a baseline, with no burst of stale alerts. Pinned by `test_a_bridge_that_comes_back_starts_a_fresh_baseline` (Task 2) and the `down`/`back up` checks in `tray.check.ps1` (Task 4).
2. **A dashboard window that already alerted, then closes** (`watched` true → false): the tray must not repeat that alert. Pinned by `test_watched_moves_state_on_without_alerting` (Task 2) and the `watched` checks in `tray.check.ps1` (Task 4).
3. **DASH_TOKEN set, empty, or the manifest unreachable**: the opened window gets the token only when there is one, and "Open dashboard" keeps it. Pinned by `test_session_url_carries_the_token_only_when_there_is_one` (Task 2) and the URL checks in `tray.check.ps1` (Task 4).
4. **Paths and profiles with spaces** (`C:\Program Files\…`, `Profile 2`): quoted correctly in the .cmd line, the .desktop Exec and Start-Process arguments. Pinned by `test_script_starts_the_tray_with_the_window`, `test_linux_tray_entry_follows_the_window_switch` (Task 5) and `Get-BrowserArgs` in `tray.check.ps1` (Task 4).
5. **A burst of alerts, or long titles, on Windows**: one balloon per poll, clipped to the shell's 63/255 characters, and a tooltip of 63 or fewer. WinForms throws past those limits, and an unhandled throw in a handler kills the tray. Pinned by the balloon and tooltip checks in `tray.check.ps1` (Task 4).

---

### Task 0: Worktree

**Files:** none (git plumbing).

- [ ] **Step 1: Create the worktree (bridge-worktree skill)**

```bash
git -C /Users/mhzrerfani/Projects/mystical-assistant worktree add -b feat/tray-companion \
  /Users/mhzrerfani/Projects/.worktrees/mystical-assistant/feat-tray-companion
WT=/Users/mhzrerfani/Projects/.worktrees/mystical-assistant/feat-tray-companion
cp /Users/mhzrerfani/Projects/mystical-assistant/.env "$WT/.env"
# tsc only: borrow master's node_modules (unlink this before removing the worktree)
ln -s /Users/mhzrerfani/Projects/mystical-assistant/bridge/dashboard/web/node_modules \
  "$WT/bridge/dashboard/web/node_modules"
```

- [ ] **Step 2: Baseline the suite in the worktree**

Run: `cd "$WT" && ~/.cache/mystical-test-venv/bin/python -m pytest tests/ -q 2>&1 | tail -12`
Expected: only the 7 known macOS failures listed in Global Constraints. Write the passed count down. Every later full run must show the same 7 failures and a higher passed count.

All later paths are relative to `$WT`, and every command runs from `$WT`.

---

### Task 1: `watched` on `/local/running`, and the dashboard's alerts flag

**Files:**
- Modify: `bridge/dashboard/server.py` (imports; new `_WATCH_S`, `_alerts_at`, `_watched()` after `_chat()` at line 66; the `/local/running` branch in `_get_api`, line 308)
- Modify: `bridge/dashboard/web/src/api.ts:1595`
- Modify: `bridge/dashboard/web/src/App.tsx:57` and `:916-927`
- Create: `tests/test_running_watched.py`

**Interfaces:**
- Produces: `GET /local/running[?alerts=1]` → the existing snapshot plus `"watched": bool`. Both trays read `watched`, and only the dashboard page sends `alerts=1`.

- [ ] **Step 1: Write the failing test**

Create `tests/test_running_watched.py`:

```python
"""`watched` on /local/running: true while a dashboard page that raises its own
OS alerts has polled within the last 90 s. The tray companions (windows/,
linux/) read it to stay quiet instead of alerting twice.
Run: python3 -m pytest tests/test_running_watched.py -q"""

import time

import pytest

from bridge.dashboard import server as dash


@pytest.fixture(autouse=True)
def _fresh(monkeypatch):
    monkeypatch.setattr(dash, "_alerts_at", float("-inf"))
    monkeypatch.setattr(dash.runner, "running_snapshot",
                        lambda chat: {"status": {}, "jobs": []})


def _poll(qs):
    h = dash.Handler.__new__(dash.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    h._get_api("/local/running", qs)
    return box["obj"]


def test_nobody_is_watching_until_an_alerting_page_polls():
    assert _poll({})["watched"] is False


def test_an_alerting_page_marks_it_watched_and_plain_polls_do_not():
    assert _poll({"alerts": ["1"]})["watched"] is True
    # The trays poll without the flag: they read the mark, they never refresh it.
    assert _poll({})["watched"] is True
    assert _poll({"alerts": ["0"]})["watched"] is True


def test_the_mark_lapses_once_the_page_stops_polling(monkeypatch):
    monkeypatch.setattr(dash, "_alerts_at", time.monotonic() - dash._WATCH_S - 1)
    assert _poll({})["watched"] is False


def test_the_snapshot_itself_passes_through():
    assert _poll({})["jobs"] == []
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `$PY -m pytest tests/test_running_watched.py -q`
Expected: FAIL. `monkeypatch.setattr(dash, "_alerts_at", …)` raises `AttributeError: <module 'bridge.dashboard.server'> has no attribute '_alerts_at'`.

- [ ] **Step 3: Implement it in `server.py`**

Add `import time` to the stdlib imports, after `import threading`:

```python
import threading
import time
import uuid
```

Add this after `def _chat()` (line 66-67):

```python
# The tray companions (windows/tray.ps1, linux/tray.py) alert only while no
# dashboard page that raises its own OS alerts is polling; such a page asks for
# /local/running?alerts=1. 90 s outlasts Chrome's once-a-minute timers in a
# hidden window. -inf, not 0.0: monotonic() can be under 90 just after boot,
# which is exactly when a login-started bridge comes up.
_WATCH_S = 90
_alerts_at = float("-inf")


def _watched(qs) -> bool:
    global _alerts_at
    now = time.monotonic()
    if qs.get("alerts") == ["1"]:
        _alerts_at = now
    return now - _alerts_at < _WATCH_S
```

Replace the `/local/running` branch in `_get_api`:

```python
        if path == "/local/running":
            return self._json({**runner.running_snapshot(chat), "watched": _watched(qs)})
```

- [ ] **Step 4: Run the test to make sure it passes**

Run: `$PY -m pytest tests/test_running_watched.py tests/test_dashboard_cross_site.py -q`
Expected: PASS (4 + 7 passed).

- [ ] **Step 5: The dashboard asks with `alerts=1` when its own alerts are on**

`bridge/dashboard/web/src/api.ts:1595`, replace `running: () => req<RunningInfo>("/local/running"),` with:

```ts
  // alerts: this page raises its own OS alerts, so the tray companion stays quiet.
  running: (alerts = false) =>
    req<RunningInfo>(alerts ? "/local/running?alerts=1" : "/local/running"),
```

`bridge/dashboard/web/src/App.tsx:57`, replace the import with:

```ts
import { push, pushGranted, shouldPush } from "./lib/push";
```

`App.tsx:916-927`: replace the poll effect (the one that starts `useEffect(() => { let live = true; const tick = async () => { … api.running() …`) with:

```tsx
  // Tells the bridge this page alerts by itself, so the tray companion
  // (windows/, linux/) stays quiet rather than alerting twice. A ref: the poll
  // below is set up once, and the toggle can change under it.
  const alertsOn = useRef(false);
  useEffect(() => { alertsOn.current = settings.push && pushGranted(); }, [settings.push]);
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const r = await api.running(alertsOn.current);
        if (!live) return;
        setStatusMap(new Map(Object.entries(r.status ?? {})));
      } catch { /* ignore */ }
    };
    void tick();
    const id = setInterval(tick, 4000);
    return () => { live = false; clearInterval(id); };
  }, []);
```

- [ ] **Step 6: Type-check the dashboard**

Run: `cd bridge/dashboard/web && ./node_modules/.bin/tsc -p tsconfig.app.json; echo "tsc exit $?"; cd "$WT"`
Expected: `tsc exit 0`, no output before it. (`HistoryView.tsx:71` still calls `api.running()` with no argument, so it never marks the page watched. That's intended.)

- [ ] **Step 7: Commit**

```bash
git add bridge/dashboard/server.py bridge/dashboard/web/src/api.ts \
        bridge/dashboard/web/src/App.tsx tests/test_running_watched.py
git commit -m "dashboard: /local/running says whether a page that alerts by itself is watching"
```

---

### Task 2: `linux/tray.py`, what counts as news (pure functions)

**Files:**
- Create: `linux/tray.py` (docstring, constants, pure functions, HTTP/lock/bindings edges, `parser()`, `missing()`; the GTK half comes in Task 3)
- Create: `tests/test_tray.py`

**Interfaces:**
- Produces (module `linux/tray.py`, loaded by tests through `importlib`):
  - `remember_titles(titles: dict, running: dict) -> dict`
  - `alerts(prev: dict | None, cur: dict, titles: dict) -> list[dict]` — each `{"id", "title", "body"}`
  - `waiting(status: dict, titles: dict) -> list[tuple[str, str]]`
  - `step(prev, running: dict | None, titles: dict) -> tuple[list[dict], dict | None, list[tuple[str, str]]]`
  - `session_url(port: int, start_url: str | None, sid: str | None = None) -> str`
  - `fetch(port: int, path: str) -> dict | None`
  - `single_instance()` — the open lock file, or `None`
  - `bindings() -> (AppIndicator, GLib, Gtk, Notify)`; raises `ImportError`/`ValueError`
  - `missing() -> str | None`
  - `parser() -> argparse.ArgumentParser` (`--port`, `--browser`, `--profile`, `--check`)
  - constants `REPO`, `ICON`, `POLL_S`, `PACKAGES`

- [ ] **Step 1: Write the failing tests**

Create `tests/test_tray.py`:

```python
"""The tray companion's logic (linux/tray.py) and the seams between the trays
and bridge/startup.py, which writes their login entries. The GTK half runs in
a Linux desktop container instead (the plan's Task 8); windows/tray.ps1's pure
half is asserted by windows/tray.check.ps1 under pwsh.
Run: python3 -m pytest tests/test_tray.py -q"""

import importlib.util
import os

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_spec = importlib.util.spec_from_file_location(
    "linux_tray", os.path.join(_ROOT, "linux", "tray.py"))
tray = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tray)


def _run(status, jobs=(), watched=False):
    return {"status": status, "jobs": list(jobs), "watched": watched}


def test_the_first_poll_is_a_baseline():
    assert tray.alerts(None, {"a": {"state": "awaiting", "label": "Which DB?"}}, {}) == []


def test_a_session_that_starts_waiting_alerts_once():
    prev = {"a": {"state": "working", "label": "running Bash"}}
    cur = {"a": {"state": "awaiting", "label": "Which DB?"}}
    assert tray.alerts(prev, cur, {"a": "fix login"}) == [
        {"id": "a", "title": "⏸ fix login", "body": "Which DB?"}]
    assert tray.alerts(cur, cur, {"a": "fix login"}) == []      # still waiting: not news


def test_parked_on_a_limit_alerts():
    cur = {"a": {"state": "parked", "label": "usage limit — resuming ~14:00"}}
    assert tray.alerts({}, cur, {"a": "x"}) == [
        {"id": "a", "title": "⏳ x", "body": "usage limit — resuming ~14:00"}]


def test_a_working_session_that_leaves_is_done():
    prev = {"a": {"state": "working", "label": "running Bash"}}
    assert tray.alerts(prev, {}, {"a": "fix login"}) == [
        {"id": "a", "title": "✓ fix login", "body": "finished"}]
    # No title known: "session", never the activity label.
    assert tray.alerts(prev, {}, {})[0]["title"] == "✓ session"


def test_working_into_awaiting_or_parked_is_not_done():
    prev = {"a": {"state": "working"}, "b": {"state": "working"}}
    cur = {"a": {"state": "awaiting"}, "b": {"state": "parked"}}
    assert sorted(n["title"][0] for n in tray.alerts(prev, cur, {})) == ["⏳", "⏸"]


def test_titles_outlive_the_job_that_carried_them():
    titles = {}
    _, prev, _ = tray.step(None, _run({"a": {"state": "working"}},
                                      [{"session_id": "a", "title": "fix login"}]), titles)
    news, _, rows = tray.step(
        prev, _run({"a": {"state": "awaiting", "label": "Which DB?"}}), titles)
    assert news[0]["title"] == "⏸ fix login"
    assert rows == [("a", "fix login")]


def test_waiting_rows_fall_back_to_the_label_and_sort_by_title():
    status = {"b": {"state": "awaiting", "label": "Zed?"}, "a": {"state": "awaiting"},
              "c": {"state": "working"}}
    assert tray.waiting(status, {"b": "alpha"}) == [("b", "alpha"), ("a", "waiting on you")]


def test_watched_moves_state_on_without_alerting():
    titles = {}
    _, prev, _ = tray.step(None, _run({"a": {"state": "working"}}), titles)
    news, prev, _ = tray.step(prev, _run({"a": {"state": "awaiting"}}, watched=True), titles)
    assert news == []
    # The window closes: the question it already rang for must not ring again.
    news, _, _ = tray.step(prev, _run({"a": {"state": "awaiting"}}), titles)
    assert news == []


def test_a_bridge_that_comes_back_starts_a_fresh_baseline():
    titles = {}
    _, prev, _ = tray.step(None, _run({"a": {"state": "working"}}), titles)
    assert tray.step(prev, None, titles) == ([], None, [])               # down
    news, _, _ = tray.step(None, _run({"a": {"state": "awaiting"}}), titles)  # back up
    assert news == []


def test_session_url_carries_the_token_only_when_there_is_one():
    assert tray.session_url(8790, "/?token=abc", "s 1") == \
        "http://localhost:8790/?token=abc&s=s%201&skipboot"
    assert tray.session_url(8790, "/", "s1") == "http://localhost:8790/?s=s1&skipboot"
    assert tray.session_url(8790, None) == "http://localhost:8790/"      # manifest unreachable
    assert tray.session_url(8790, "/?token=abc") == "http://localhost:8790/?token=abc"


def test_a_second_tray_backs_off(tmp_path, monkeypatch):
    monkeypatch.setenv("XDG_RUNTIME_DIR", str(tmp_path))
    first = tray.single_instance()
    assert first is not None
    assert tray.single_instance() is None
    first.close()
    again = tray.single_instance()
    assert again is not None
    again.close()


def test_missing_bindings_name_the_packages(monkeypatch):
    def gone():
        raise ImportError("No module named 'gi'")
    monkeypatch.setattr(tray, "bindings", gone)
    why = tray.missing()
    assert "gir1.2-ayatanaappindicator3-0.1" in why and "libayatana-appindicator-gtk3" in why
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `$PY -m pytest tests/test_tray.py -q`
Expected: FAIL at collection. `FileNotFoundError` for `linux/tray.py`.

- [ ] **Step 3: Write `linux/tray.py` (pure half)**

```python
#!/usr/bin/python3
"""The Linux tray companion: Mystical.app's menu bar, on a Linux desktop.

A tray icon beside the installed dashboard window (bridge/startup.py opens that
one): how many sessions are waiting on you, start/stop/restart without a
terminal, and alerts while no dashboard window is open. Its Windows twin is
windows/tray.ps1; the design is docs/superpowers/specs/tray-companion-design.md.

Why it is shaped like this:
- **System python3 + the distro's GTK bindings** (PyGObject, AppIndicator,
  libnotify): nothing to build or pip-install. The bridge's stdlib-only rule is
  about the server; this is a desktop client, and PyGObject is a distro package
  — which is also why startup.py runs it on /usr/bin/python3, not on whatever
  interpreter the bridge uses.
- **It polls GET /local/running every 4 s**, the dashboard's own cadence, and
  alerts on the transitions the dashboard rings for (App.tsx), minus "started".
- **It stays quiet while `watched` is true**: a dashboard page with its own
  alerts on has polled within 90 s, and that page already alerted — with the
  user's sound, and skipping the session they're looking at.
- **No token in its arguments.** Opening a window reads start_url from
  /manifest.webmanifest, so a rotated DASH_TOKEN is picked up on the next open.
- **GTK is imported in bindings()**, so everything here imports on any machine;
  tests/test_tray.py runs the pure functions on a box without GTK.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import sys
import urllib.parse
import urllib.request

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICON = os.path.join(REPO, "bridge", "dashboard", "web", "public", "icon-192.png")
POLL_S = 4
PACKAGES = ("Debian/Ubuntu: sudo apt install gir1.2-ayatanaappindicator3-0.1 "
            "gir1.2-notify-0.7 — Fedora: sudo dnf install "
            "libayatana-appindicator-gtk3 libnotify")
_IN_FLIGHT = ("working", "awaiting", "parked")
# Proxies are for the internet; a system http_proxy must never see localhost.
_HTTP = urllib.request.build_opener(urllib.request.ProxyHandler({}))


# --- what counts as news (pure; mirrors App.tsx's statusMap effect) -----------
def remember_titles(titles: dict, running: dict) -> dict:
    """Fold jobs[].title into `titles` (the field Running.swift reads). Kept
    across polls: a turn that ends on a question leaves `jobs`, but its title
    was there while it worked."""
    for job in running.get("jobs") or []:
        if job.get("session_id") and job.get("title"):
            titles[job["session_id"]] = job["title"]
    return titles


def alerts(prev: dict | None, cur: dict, titles: dict) -> list[dict]:
    """The alerts one poll brings: [{id, title, body}]. `prev` None is a
    baseline (the first poll, or the first after the bridge came back) —
    nothing that predates it is news."""
    if prev is None:
        return []
    out = []
    for sid, st in cur.items():
        was = (prev.get(sid) or {}).get("state")
        name = titles.get(sid) or st.get("label") or "session"
        if st.get("state") == "awaiting" and was != "awaiting":
            out.append({"id": sid, "title": f"⏸ {name}",
                        "body": st.get("label") or "waiting on you"})
        elif st.get("state") == "parked" and was != "parked":
            out.append({"id": sid, "title": f"⏳ {name}",
                        "body": st.get("label") or "parked"})
    for sid, st in prev.items():
        if (st.get("state") == "working"
                and (cur.get(sid) or {}).get("state") not in _IN_FLIGHT):
            # Not the label: a working session's label is its activity, and
            # "✓ running Bash" reads as if Bash were what finished.
            out.append({"id": sid, "title": f"✓ {titles.get(sid) or 'session'}",
                        "body": "finished"})
    return out


def waiting(status: dict, titles: dict) -> list[tuple[str, str]]:
    """(session id, title) for each session blocked on you, by title: the menu's rows."""
    rows = [(sid, titles.get(sid) or st.get("label") or "waiting on you")
            for sid, st in status.items() if st.get("state") == "awaiting"]
    return sorted(rows, key=lambda r: (r[1], r[0]))


def step(prev: dict | None, running: dict | None, titles: dict):
    """Fold one poll in: (alerts to show, the map the next poll diffs against,
    the waiting rows). `running` None = the bridge didn't answer, so the next
    answer is a fresh baseline. While `watched` the state still moves on —
    nothing replays once the dashboard window closes — but nothing alerts."""
    if running is None:
        return [], None, []
    status = running.get("status") or {}
    remember_titles(titles, running)
    news = [] if running.get("watched") else alerts(prev, status, titles)
    return news, status, waiting(status, titles)


def session_url(port: int, start_url: str | None, sid: str | None = None) -> str:
    """What a window opens: localhost (the installed app's origin, so it shares
    its storage), the manifest's query (the token, when DASH_TOKEN is set), then
    the session to open, skipping the intro a click doesn't want."""
    parts = [q for q in [(start_url or "").partition("?")[2]] if q]
    if sid:
        parts += [f"s={urllib.parse.quote(sid, safe='')}", "skipboot"]
    return f"http://localhost:{port}/" + ("?" + "&".join(parts) if parts else "")


# --- the edges: HTTP, the lock, the bindings ----------------------------------
def fetch(port: int, path: str) -> dict | None:
    """GET a JSON path off the dashboard, or None when it doesn't answer."""
    try:
        with _HTTP.open(f"http://localhost:{port}{path}", timeout=3) as r:
            return json.load(r)
    except (OSError, ValueError):
        return None


def single_instance():
    """The lock file, held for as long as this tray runs — or None when another
    tray holds it (the autostart entry and `mystical app` can both fire)."""
    run = os.environ.get("XDG_RUNTIME_DIR") or f"/tmp/mystical-{os.getuid()}"
    os.makedirs(run, exist_ok=True)
    f = open(os.path.join(run, "mystical-tray.lock"), "w")
    try:
        fcntl.flock(f, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        f.close()
        return None
    return f


def bindings():
    """(AppIndicator, GLib, Gtk, Notify), or ImportError/ValueError naming what
    is missing. Ayatana first (Debian, Ubuntu and Fedora ship it), the original
    AppIndicator3 where that's all there is."""
    import gi
    gi.require_version("Gtk", "3.0")
    gi.require_version("Notify", "0.7")
    try:
        gi.require_version("AyatanaAppIndicator3", "0.1")
        from gi.repository import AyatanaAppIndicator3 as AppIndicator
    except (ValueError, ImportError):
        gi.require_version("AppIndicator3", "0.1")
        from gi.repository import AppIndicator3 as AppIndicator
    from gi.repository import GLib, Gtk, Notify
    return AppIndicator, GLib, Gtk, Notify


def missing() -> str | None:
    """None when the GTK bindings import; else the line saying what to install
    (shown by `mystical app` and `mystical doctor`, through --check)."""
    try:
        bindings()
    except (ImportError, ValueError) as e:
        return f"mystical tray: the GTK bindings are missing ({e}). {PACKAGES}"
    return None


def parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(prog="tray.py", description="mystical//assistant tray icon")
    p.add_argument("--port", type=int, default=8790, help="the dashboard's port")
    p.add_argument("--browser", help="the Chromium-family browser windows open in")
    p.add_argument("--profile", help="its --profile-directory")
    p.add_argument("--check", action="store_true",
                   help="exit 0 if the GTK bindings import, else name the packages")
    return p
```

`subprocess` and `threading` are left out on purpose: Task 3 adds them along with the code that uses them, so pyflakes stays clean in between.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `$PY -m pytest tests/test_tray.py -q && $PY -m pyflakes linux/tray.py tests/test_tray.py`
Expected: `12 passed`, and no pyflakes output.

- [ ] **Step 5: Commit**

```bash
chmod +x linux/tray.py
git add linux/tray.py tests/test_tray.py
git commit -m "linux tray: what counts as news — the dashboard's transitions, minus started, quiet while watched"
```

---

### Task 3: `linux/tray.py`, the tray itself (GTK)

**Files:**
- Modify: `linux/tray.py` (imports; append `open_url`, `run_mystical`, `class Tray`, `main`, the `__main__` guard)
- Modify: `tests/test_tray.py` (one test for `main(["--check"])`)

**Interfaces:**
- Consumes: everything Task 2 produced.
- Produces: `python3 linux/tray.py [--port N] [--browser PATH] [--profile NAME] [--check]`. Exit 0 = ran or already running, or `--check` passed. Exit 1 = bindings missing, with one stderr line containing `PACKAGES`.

- [ ] **Step 1: Write the failing test**

Append to `tests/test_tray.py`:

```python
def test_check_exits_1_and_names_the_packages(monkeypatch, capsys):
    def gone():
        raise ValueError("Namespace AyatanaAppIndicator3 not available")
    monkeypatch.setattr(tray, "bindings", gone)
    assert tray.main(["--check"]) == 1
    assert "gir1.2-notify-0.7" in capsys.readouterr().err
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `$PY -m pytest tests/test_tray.py -q -k check_exits`
Expected: FAIL with `AttributeError: module 'linux_tray' has no attribute 'main'`.

- [ ] **Step 3: Add the GTK half**

In `linux/tray.py`, add `import subprocess` and `import threading` to the imports (alphabetical, after `import os`). Then append:

```python
def open_url(url: str, browser: str | None, profile: str | None) -> None:
    """In the installed window's browser and profile, as an app window; the
    desktop's default browser when there's no Chromium-family one."""
    argv = ([browser, *([f"--profile-directory={profile}"] if profile else []),
             f"--app={url}"] if browser else ["xdg-open", url])
    subprocess.Popen(argv, start_new_session=True, stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def run_mystical(cmd: str) -> tuple[int, str]:
    """bin/mystical start|stop|restart through a login+interactive shell — the
    PATH your terminal has (nvm's npm, for a stale bundle), not the desktop
    session's. (exit code, the output's last lines)."""
    p = subprocess.run(["bash", "-lic", f"'{REPO}/bin/mystical' {cmd}"],
                       stdin=subprocess.DEVNULL, capture_output=True, text=True)
    return p.returncode, "\n".join((p.stdout + p.stderr).strip().splitlines()[-12:])


class Tray:
    """The icon, its menu and its alerts. Every GTK call happens on the main
    loop's thread; HTTP and bridge commands run on worker threads and hand
    their results back through GLib.idle_add."""

    def __init__(self, a, AppIndicator, GLib, Gtk, Notify):
        self.a, self.GLib, self.Gtk, self.Notify = a, GLib, Gtk, Notify
        self.prev, self.titles, self.rows = None, {}, []
        self.up, self.busy, self.shown = False, None, None
        self.notes = {}                   # session id -> its one Notify.Notification
        self.icon = ICON if os.path.isfile(ICON) else "dialog-information"
        Notify.init("mystical")
        self.ind = AppIndicator.Indicator.new(
            "mystical-tray", self.icon, AppIndicator.IndicatorCategory.APPLICATION_STATUS)
        self.ind.set_status(AppIndicator.IndicatorStatus.ACTIVE)
        self.ind.set_title("mystical")
        self.render()
        self.poll()
        GLib.timeout_add_seconds(POLL_S, self.poll)

    def poll(self):
        def work():
            running = fetch(self.a.port, "/local/running")
            self.GLib.idle_add(self.landed, running)
        threading.Thread(target=work, daemon=True).start()
        return True                       # keep the 4 s timer

    def landed(self, running):
        news, self.prev, self.rows = step(self.prev, running, self.titles)
        self.up = running is not None
        for n in news:
            self.notify(n)
        self.render()
        return False                      # idle_add: once

    def notify(self, n):
        # One per session, updated in place: a chatty session replaces its own
        # alert instead of stacking a column of them.
        note = self.notes.get(n["id"])
        if note is None:
            note = self.Notify.Notification.new(n["title"], n["body"], self.icon)
            note.add_action("default", "Open", lambda _n, _a, sid: self.open(sid), n["id"])
            self.notes[n["id"]] = note
        else:
            note.update(n["title"], n["body"], self.icon)
        try:
            note.show()
        except self.GLib.Error:
            pass                          # no notification daemon: the menu still says it

    def render(self):
        n = len(self.rows)
        head = self.busy or ("● running" if self.up else "○ stopped")
        if n:
            head += f" · {n} waiting on you"
        if (head, tuple(self.rows)) == self.shown:
            return                        # re-sending an open menu over D-Bus makes it flicker
        self.shown = (head, tuple(self.rows))
        self.ind.set_label(str(n) if n else "", "99")
        Gtk, menu = self.Gtk, self.Gtk.Menu()

        def item(label, on=None, enabled=True):
            it = Gtk.MenuItem(label=label)
            if on:
                it.connect("activate", lambda _w: on())
            it.set_sensitive(bool(on) and enabled)
            menu.append(it)
            return it

        item(head)
        for sid, title in self.rows:
            item(f"    {title}", lambda sid=sid: self.open(sid))
        menu.append(Gtk.SeparatorMenuItem())
        # AppIndicator gives a left click to the menu; a middle click opens the dashboard.
        self.ind.set_secondary_activate_target(item("Open dashboard", lambda: self.open(None)))
        idle = self.busy is None
        item("Start bridge", lambda: self.bridge("start"), idle and not self.up)
        item("Stop bridge", lambda: self.bridge("stop"), idle and self.up)
        item("Restart bridge", lambda: self.bridge("restart"), idle and self.up)
        menu.append(Gtk.SeparatorMenuItem())
        item("Quit tray", Gtk.main_quit)
        menu.show_all()
        self.ind.set_menu(menu)

    def open(self, sid):
        def work():
            manifest = fetch(self.a.port, "/manifest.webmanifest") or {}
            open_url(session_url(self.a.port, manifest.get("start_url"), sid),
                     self.a.browser, self.a.profile)
        threading.Thread(target=work, daemon=True).start()

    def bridge(self, cmd):
        self.busy = {"start": "… starting", "stop": "… stopping",
                     "restart": "… restarting"}[cmd]
        self.render()

        def work():
            rc, tail = run_mystical(cmd)
            self.GLib.idle_add(self.ran, cmd, rc, tail)
        threading.Thread(target=work, daemon=True).start()

    def ran(self, cmd, rc, tail):
        self.busy = None
        self.render()
        if rc:
            d = self.Gtk.MessageDialog(message_type=self.Gtk.MessageType.ERROR,
                                       buttons=self.Gtk.ButtonsType.CLOSE,
                                       text=f"mystical {cmd} failed (exit {rc})")
            d.format_secondary_text(tail)
            d.run()
            d.destroy()
        return False


def main(argv=None) -> int:
    a = parser().parse_args(argv)
    why = missing()
    if why:
        print(why, file=sys.stderr)
        return 1
    if a.check:
        return 0
    lock = single_instance()
    if lock is None:
        return 0                          # another tray runs already; one is plenty
    AppIndicator, GLib, Gtk, Notify = bindings()
    # The 4 s timer holds the Tray through its bound poll, so it needs no name.
    Tray(a, AppIndicator, GLib, Gtk, Notify)
    Gtk.main()
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Run the tests, and the real `--check` on this Mac**

Run: `$PY -m pytest tests/test_tray.py -q && $PY -m pyflakes linux/tray.py && /usr/bin/python3 linux/tray.py --check; echo "check exit $?"`
Expected: `13 passed`, no pyflakes output, then the stderr line `mystical tray: the GTK bindings are missing (No module named 'gi'). Debian/Ubuntu: …` and `check exit 1`. The Mac has no PyGObject, so this exercises the real failure path. The GTK path itself runs in Task 8.

- [ ] **Step 5: Commit**

```bash
git add linux/tray.py tests/test_tray.py
git commit -m "linux tray: the icon, its menu and its alerts (AppIndicator + libnotify)"
```

---

### Task 4: `windows/tray.ps1` and its check script

**Files:**
- Create: `windows/tray.ps1`
- Create: `windows/tray.check.ps1`
- Modify: `tests/test_tray.py` (the ASCII / PowerShell 5.1 guard)

**Interfaces:**
- Produces: `powershell.exe -File tray.ps1 -Port <int> -Distro <s> -User <s> -Repo <linux path> [-Browser <windows path>] [-BrowserProfile <s>] [-Check]`. The param block ends with a line holding only `)`, which Task 5's interface test relies on.
- Pure functions (dot-sourced by the check script): `First`, `ConvertTo-Map`, `Update-Titles`, `Get-Alerts`, `Get-Waiting`, `Step-Poll`, `Get-SessionUrl`, `Get-Clipped`, `Get-Balloon`, `Get-Tooltip`, `Get-MenuHead`, `Get-BridgeArgs`, `Get-BrowserArgs`; glyph variables `$GlyphWait $GlyphDone $GlyphParked $GlyphUp $GlyphDown $GlyphBusy $Dot $Dash`.

- [ ] **Step 1: Write the failing pytest guard**

Append to `tests/test_tray.py`:

```python
def test_the_windows_tray_stays_readable_by_windows_powershell_5_1():
    """5.1 reads a BOM-less script as ANSI, so the file stays ASCII (glyphs come
    from code points); and it has none of PowerShell 7's operators."""
    raw = open(os.path.join(_ROOT, "windows", "tray.ps1"), "rb").read()
    assert raw.isascii(), "build glyphs from code points: [char]0x23F8"
    code = [ln for ln in raw.decode("ascii").splitlines() if not ln.lstrip().startswith("#")]
    for op in ("??", "?.", "&&", "||"):
        assert not any(op in ln for ln in code), f"{op} is PowerShell 7 only"
```

Run: `$PY -m pytest tests/test_tray.py -q -k powershell_5_1`
Expected: FAIL with `FileNotFoundError` (`windows/tray.ps1`).

- [ ] **Step 2: Write `windows/tray.ps1`**

ASCII only. Keep the prose free of the four forbidden operators too: the guard skips only `#` lines, and the `<# #>` block's lines don't start with `#`.

```powershell
<#
  mystical//assistant - the Windows tray companion: Mystical.app's menu bar,
  for a bridge running in WSL.

  A tray icon beside the installed dashboard window (bridge/startup.py opens
  that one from the Startup folder): how many sessions are waiting on you,
  start/stop/restart without a terminal, and alerts while no dashboard window
  is open. Its Linux twin is linux/tray.py; the design is
  docs/superpowers/specs/tray-companion-design.md.

  Why it is shaped like this:
  - Windows PowerShell 5.1 and WinForms, which every Windows 10/11 ships:
    nothing to build, sign or download. It runs from the checkout through
    \\wsl$, so a git pull updates it. 5.1, not 7: none of 7's newer operators.
  - ASCII only. 5.1 reads a BOM-less script as ANSI, so every glyph below is
    built from its code point rather than typed.
  - It polls GET /local/running every 4 s, like the dashboard, and alerts on
    the transitions the dashboard rings for (App.tsx), minus "started" - but
    not while `watched`: a dashboard page with its own alerts on polled within
    90 s and already alerted.
  - No token in its arguments: opening a window reads start_url from
    /manifest.webmanifest, so a rotated DASH_TOKEN is picked up on the next open.
  - Everything above "if ($Check)" is pure, so windows/tray.check.ps1 can
    dot-source it under pwsh on any OS; WinForms starts below that line.
#>
param(
  [int]$Port = 8790,
  [string]$Distro = 'Ubuntu',
  [string]$User = '',
  [string]$Repo = '',
  [string]$Browser = '',
  [string]$BrowserProfile = '',
  [switch]$Check
)

$GlyphWait   = [string][char]0x23F8   # pause: waiting on you
$GlyphDone   = [string][char]0x2713   # check mark: finished
$GlyphParked = [string][char]0x23F3   # hourglass: parked on a limit
$GlyphUp     = [string][char]0x25CF   # filled circle: running
$GlyphDown   = [string][char]0x25CB   # empty circle: stopped
$GlyphBusy   = [string][char]0x2026   # ellipsis: starting, stopping
$Dot         = [string][char]0x00B7
$Dash        = [string][char]0x2014

# --- what counts as news (pure; mirrors linux/tray.py) -----------------------
function First {
  # The first argument that isn't empty.
  foreach ($a in $args) { if ($a) { return $a } }
  return $null
}

function ConvertTo-Map($Obj) {
  # ConvertFrom-Json hands back a PSCustomObject; the diff wants a hashtable.
  if ($Obj -is [hashtable]) { return $Obj }
  $map = @{}
  if ($null -ne $Obj) { foreach ($p in $Obj.PSObject.Properties) { $map[$p.Name] = $p.Value } }
  return $map
}

function Update-Titles([hashtable]$Titles, $Running) {
  # jobs[].title, kept across polls: a turn that ends on a question leaves
  # jobs, but its title was there while it worked.
  foreach ($job in @($Running.jobs)) {
    if ($job -and $job.session_id -and $job.title) { $Titles[$job.session_id] = $job.title }
  }
}

function Get-Alerts($Prev, [hashtable]$Cur, [hashtable]$Titles) {
  # The alerts one poll brings. $Prev $null is a baseline (the first poll, or
  # the first after the bridge came back): nothing that predates it is news.
  $out = New-Object System.Collections.ArrayList
  if ($null -eq $Prev) { return ,$out }
  foreach ($sid in @($Cur.Keys)) {
    $st = $Cur[$sid]
    $was = $null
    if ($Prev.ContainsKey($sid)) { $was = $Prev[$sid].state }
    $name = First $Titles[$sid] $st.label 'session'
    if ($st.state -eq 'awaiting' -and $was -ne 'awaiting') {
      [void]$out.Add(@{ id = $sid; title = "$GlyphWait $name"; body = (First $st.label 'waiting on you') })
    } elseif ($st.state -eq 'parked' -and $was -ne 'parked') {
      [void]$out.Add(@{ id = $sid; title = "$GlyphParked $name"; body = (First $st.label 'parked') })
    }
  }
  foreach ($sid in @($Prev.Keys)) {
    if ($Prev[$sid].state -ne 'working') { continue }
    $now = $null
    if ($Cur.ContainsKey($sid)) { $now = $Cur[$sid].state }
    if (@('working', 'awaiting', 'parked') -notcontains $now) {
      # Not the label: a working session's label is its activity.
      [void]$out.Add(@{ id = $sid; title = "$GlyphDone $(First $Titles[$sid] 'session')"; body = 'finished' })
    }
  }
  return ,$out
}

function Get-Waiting([hashtable]$Status, [hashtable]$Titles) {
  # One row per session blocked on you, by title: the menu's rows.
  $rows = @(foreach ($sid in @($Status.Keys)) {
    if ($Status[$sid].state -eq 'awaiting') {
      [pscustomobject]@{ id = $sid; title = (First $Titles[$sid] $Status[$sid].label 'waiting on you') }
    }
  })
  return ,@($rows | Sort-Object -Property title, id)
}

function Step-Poll($Prev, $Running, [hashtable]$Titles) {
  # One poll folded in. $Running $null = the bridge didn't answer, so the next
  # answer is a fresh baseline. While watched the state still moves on, so
  # nothing replays once the dashboard window closes, but nothing alerts.
  if ($null -eq $Running) { return @{ news = @(); prev = $null; waiting = @() } }
  $status = ConvertTo-Map $Running.status
  Update-Titles $Titles $Running
  $news = @()
  if (-not $Running.watched) { $news = Get-Alerts $Prev $status $Titles }
  return @{ news = $news; prev = $status; waiting = (Get-Waiting $status $Titles) }
}

function Get-SessionUrl([int]$Port, [string]$StartUrl, [string]$Sid) {
  # localhost (the installed app's origin, so it shares its storage), the
  # manifest's query (the token, when DASH_TOKEN is set), then the session,
  # skipping the intro a click doesn't want.
  $parts = @()
  if ($StartUrl.Contains('?')) {
    $query = $StartUrl.Substring($StartUrl.IndexOf('?') + 1)
    if ($query) { $parts += $query }
  }
  if ($Sid) { $parts += 's=' + [uri]::EscapeDataString($Sid); $parts += 'skipboot' }
  $url = "http://localhost:$Port/"
  if ($parts.Count) { $url += '?' + ($parts -join '&') }
  return $url
}

function Get-Clipped([string]$Text, [int]$Max) {
  if ($Text.Length -le $Max) { return $Text }
  return $Text.Substring(0, $Max - 1) + $GlyphBusy
}

function Get-Balloon($News) {
  # Windows shows one tray balloon at a time, so a poll's alerts become one: a
  # single alert names its session (a click opens it), several become a
  # summary (a click opens the dashboard). WinForms throws past the shell's
  # 63/255 characters, and a throw in a handler would end the tray.
  if ($News.Count -eq 1) {
    $b = @{ id = $News[0].id; title = $News[0].title; body = $News[0].body }
  } else {
    $b = @{ id = $null; title = "$($News.Count) sessions need you"
            body = (@($News | ForEach-Object { $_.title }) -join "`n") }
  }
  $b.title = Get-Clipped $b.title 63
  $b.body = Get-Clipped $b.body 255
  return $b
}

function Get-Tooltip([bool]$Up, [int]$Waiting) {
  if (-not $Up) { return "mystical $Dash stopped" }
  if ($Waiting) { return Get-Clipped "mystical $Dash $Waiting waiting on you" 63 }
  return 'mystical'
}

function Get-MenuHead([string]$Busy, [bool]$Up, [int]$Waiting) {
  if ($Busy) { $head = $Busy } elseif ($Up) { $head = "$GlyphUp running" } else { $head = "$GlyphDown stopped" }
  if ($Waiting) { $head += " $Dot $Waiting waiting on you" }
  return $head
}

function Get-BridgeArgs([string]$Distro, [string]$User, [string]$Repo, [string]$Cmd) {
  # -e runs bash itself rather than through the default shell, so this is the
  # only quoting; -lic gives it the PATH your terminal has (nvm's npm, for a
  # stale bundle).
  return "-d `"$Distro`" -u `"$User`" -e bash -lic `"'$Repo/bin/mystical' $Cmd`""
}

function Get-BrowserArgs([string]$BrowserProfile, [string]$Url) {
  # Start-Process joins an argument array with bare spaces, so a profile with
  # a space in it ("Profile 2") is quoted here.
  $a = @()
  if ($BrowserProfile) { $a += "--profile-directory=`"$BrowserProfile`"" }
  $a += "--app=$Url"
  return ,$a
}

if ($Check) { return }   # tray.check.ps1 dot-sources the pure half above

# --- the tray -----------------------------------------------------------------
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Namespace Mystical -Name Native -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("user32.dll")]
public static extern bool DestroyIcon(System.IntPtr handle);
'@

# One tray per login: the Startup entry and `mystical app` can both fire.
$fresh = $false
$mutex = [System.Threading.Mutex]::new($true, 'Local\mystical-tray', [ref]$fresh)
if (-not $fresh) { exit 0 }

$IconPath = Join-Path (Split-Path $PSScriptRoot -Parent) 'bridge\dashboard\web\public\icon-192.png'
$Base = $null
try {
  # Into memory: GDI+ keeps reading a bitmap's file, and this one sits on
  # \\wsl$, which goes away whenever the distro stops.
  $stream = New-Object System.IO.MemoryStream(, [System.IO.File]::ReadAllBytes($IconPath))
  $Base = New-Object System.Drawing.Bitmap($stream)
} catch { $Base = $null }

function New-TrayIcon([int]$Count) {
  # The emblem, with the waiting count on an amber badge (the dashboard's --warn).
  $size = 32
  $bmp = New-Object System.Drawing.Bitmap($size, $size)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
  if ($Base) { $g.DrawImage($Base, 0, 0, $size, $size) }
  else { $g.DrawIcon([System.Drawing.SystemIcons]::Application, (New-Object System.Drawing.Rectangle(0, 0, $size, $size))) }
  if ($Count -gt 0) {
    $d = 20
    $x = $size - $d
    $amber = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(0xE3, 0xC2, 0x79))
    $ink = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(0x06, 0x0A, 0x0A))
    $font = New-Object System.Drawing.Font('Segoe UI', 13, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = [System.Drawing.StringAlignment]::Center
    $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
    $label = "$Count"
    if ($Count -gt 9) { $label = '9+' }
    $g.FillEllipse($amber, $x, $x, $d, $d)
    $g.DrawString($label, $font, $ink, (New-Object System.Drawing.RectangleF($x, $x, $d, $d)), $fmt)
    $amber.Dispose(); $ink.Dispose(); $font.Dispose(); $fmt.Dispose()
  }
  $g.Dispose()
  $handle = $bmp.GetHicon()
  $bmp.Dispose()
  return @{ icon = [System.Drawing.Icon]::FromHandle($handle); handle = $handle }
}

$tray = New-Object System.Windows.Forms.NotifyIcon
$menu = New-Object System.Windows.Forms.ContextMenuStrip
$tray.ContextMenuStrip = $menu
$state = @{ prev = $null; titles = @{}; rows = @(); up = $false; busy = $null
            shown = -1; key = $null; handle = [IntPtr]::Zero; balloon = $null
            job = $null; jobCmd = $null; jobLog = $null; inflight = $false
            sentAt = [datetime]::MinValue; ticks = 0 }

function Update-Icon {
  $n = $state.rows.Count
  if ($n -eq $state.shown) { return }
  $state.shown = $n
  $made = New-TrayIcon $n
  $tray.Icon = $made.icon
  # The shell keeps its own copy; the handle GetHicon made is ours to free.
  if ($state.handle -ne [IntPtr]::Zero) { [void][Mystical.Native]::DestroyIcon($state.handle) }
  $state.handle = $made.handle
}

function Update-Menu {
  $head = Get-MenuHead $state.busy $state.up $state.rows.Count
  $key = $head + '|' + ((@($state.rows) | ForEach-Object { $_.id + '=' + $_.title }) -join '|')
  # Rebuilding an open menu closes it under the cursor; the next poll catches up.
  if ($key -eq $state.key -or $menu.Visible) { return }
  $state.key = $key
  $menu.Items.Clear()
  $item = $menu.Items.Add($head); $item.Enabled = $false
  foreach ($row in $state.rows) {
    $item = $menu.Items.Add('    ' + $row.title)
    $item.Tag = $row.id
    $item.add_Click({ param($s, $e) Open-Dashboard $s.Tag })
  }
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  $item = $menu.Items.Add('Open dashboard'); $item.add_Click({ Open-Dashboard '' })
  $idle = -not $state.busy
  $item = $menu.Items.Add('Start bridge'); $item.Enabled = ($idle -and -not $state.up); $item.add_Click({ Invoke-Bridge 'start' })
  $item = $menu.Items.Add('Stop bridge'); $item.Enabled = ($idle -and $state.up); $item.add_Click({ Invoke-Bridge 'stop' })
  $item = $menu.Items.Add('Restart bridge'); $item.Enabled = ($idle -and $state.up); $item.add_Click({ Invoke-Bridge 'restart' })
  [void]$menu.Items.Add((New-Object System.Windows.Forms.ToolStripSeparator))
  $item = $menu.Items.Add('Quit tray'); $item.add_Click({ [System.Windows.Forms.Application]::Exit() })
}

function Receive-Poll($Running) {
  $r = Step-Poll $state.prev $Running $state.titles
  $state.prev = $r.prev
  $state.rows = @($r.waiting)
  $state.up = ($null -ne $Running)
  if ($r.news.Count -gt 0) {
    $b = Get-Balloon $r.news
    $state.balloon = $b.id
    $tray.ShowBalloonTip(10000, $b.title, $b.body, [System.Windows.Forms.ToolTipIcon]::None)
  }
  Update-Icon
  Update-Menu
  $tray.Text = Get-Tooltip $state.up $state.rows.Count
}

$web = New-Object System.Net.WebClient
$web.Proxy = $null                    # a system proxy must never see localhost
$web.Encoding = [System.Text.Encoding]::UTF8
$web.add_DownloadStringCompleted({
  param($s, $e)
  $state.inflight = $false
  $running = $null
  if (-not $e.Cancelled -and -not $e.Error) {
    try { $running = $e.Result | ConvertFrom-Json } catch { $running = $null }
  }
  Receive-Poll $running
})

function Start-Poll {
  if ($state.inflight) {
    # WebClient has no timeout of its own: a bridge that accepts and never
    # answers would otherwise hold this one request forever.
    if (((Get-Date) - $state.sentAt).TotalSeconds -gt 3) { $web.CancelAsync() }
    return
  }
  $state.inflight = $true
  $state.sentAt = Get-Date
  $web.DownloadStringAsync([uri]"http://localhost:$Port/local/running")
}

function Open-Dashboard([string]$Sid) {
  $start = $null
  try {
    $req = [System.Net.HttpWebRequest]::Create("http://localhost:$Port/manifest.webmanifest")
    $req.Proxy = $null
    $req.Timeout = 2000
    $resp = $req.GetResponse()
    try { $start = ((New-Object System.IO.StreamReader($resp.GetResponseStream())).ReadToEnd() | ConvertFrom-Json).start_url }
    finally { $resp.Close() }
  } catch { $start = $null }          # no manifest: the window opens without the token
  $url = Get-SessionUrl $Port $start $Sid
  if ($Browser -and (Test-Path -LiteralPath $Browser)) {
    Start-Process -FilePath $Browser -ArgumentList (Get-BrowserArgs $BrowserProfile $url)
  } else {
    Start-Process $url
  }
}

function Invoke-Bridge([string]$Cmd) {
  $words = @{ start = 'starting'; stop = 'stopping'; restart = 'restarting' }
  $state.busy = "$GlyphBusy " + $words[$Cmd]
  $state.jobCmd = $Cmd
  $state.jobLog = Join-Path $env:TEMP "mystical-tray-$Cmd.log"
  try {
    $how = @{ FilePath = 'wsl.exe'; ArgumentList = (Get-BridgeArgs $Distro $User $Repo $Cmd)
              WindowStyle = 'Hidden'; PassThru = $true
              RedirectStandardOutput = $state.jobLog; RedirectStandardError = ($state.jobLog + '.err') }
    $p = Start-Process @how
    $null = $p.Handle                 # without this, ExitCode reads back empty after exit
    $state.job = $p
  } catch {
    $state.busy = $null
    [void][System.Windows.Forms.MessageBox]::Show("Couldn't run wsl.exe: $_", 'mystical')
  }
  Update-Menu
}

function Watch-Bridge {
  $p = $state.job
  if ($null -eq $p -or -not $p.HasExited) { return }
  $state.job = $null
  $state.busy = $null
  Update-Menu
  if ($p.ExitCode -ne 0) {
    $tail = @(Get-Content -Tail 12 -Path $state.jobLog, ($state.jobLog + '.err') -ErrorAction SilentlyContinue) -join "`n"
    [void][System.Windows.Forms.MessageBox]::Show("mystical $($state.jobCmd) failed (exit $($p.ExitCode))`n`n$tail", 'mystical')
  }
}

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1000
$timer.add_Tick({
  $state.ticks += 1
  Watch-Bridge
  if ($state.ticks % 4 -eq 0) { Start-Poll }
})
$tray.add_MouseClick({ param($s, $e) if ($e.Button -eq [System.Windows.Forms.MouseButtons]::Left) { Open-Dashboard '' } })
$tray.add_BalloonTipClicked({ Open-Dashboard $state.balloon })

Update-Icon
Update-Menu
$tray.Text = Get-Tooltip $false 0
$tray.Visible = $true
Start-Poll
$timer.Start()
[System.Windows.Forms.Application]::Run()

# Quit tray: take the icon down now, not when the mouse next passes over it.
$timer.Stop()
$tray.Visible = $false
$tray.Dispose()
$mutex.ReleaseMutex()
```

- [ ] **Step 3: Write `windows/tray.check.ps1`**

```powershell
# Assertions over windows/tray.ps1's pure half: the cases tests/test_tray.py
# runs against linux/tray.py, so the twins can't drift. No WinForms needed:
#   pwsh -NoProfile -File windows/tray.check.ps1    (powershell.exe on Windows)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'tray.ps1') -Check
$script:failed = 0
function Assert-That([bool]$Ok, [string]$What) {
  if ($Ok) { Write-Host "ok    $What" } else { Write-Host "FAIL  $What"; $script:failed += 1 }
}
function Poll([string]$Json) { return ($Json | ConvertFrom-Json) }

$titles = @{}
$r = Step-Poll $null (Poll '{"status":{"a":{"state":"awaiting","label":"Which DB?"}},"jobs":[]}') $titles
Assert-That ($r.news.Count -eq 0) 'the first poll is a baseline'

$titles = @{}
$r = Step-Poll $null (Poll '{"status":{"a":{"state":"working","label":"running Bash"}},"jobs":[{"session_id":"a","title":"fix login"}]}') $titles
$r = Step-Poll $r.prev (Poll '{"status":{"a":{"state":"awaiting","label":"Which DB?"}},"jobs":[]}') $titles
Assert-That ($r.news.Count -eq 1 -and $r.news[0].title -eq "$GlyphWait fix login" -and $r.news[0].body -eq 'Which DB?') 'waiting alerts once, titled from the job'
Assert-That ($r.waiting.Count -eq 1 -and $r.waiting[0].title -eq 'fix login') 'the waiting row keeps the title'
$again = Step-Poll $r.prev (Poll '{"status":{"a":{"state":"awaiting","label":"Which DB?"}},"jobs":[]}') $titles
Assert-That ($again.news.Count -eq 0) 'still waiting is not news'

$r = Step-Poll @{} (Poll '{"status":{"a":{"state":"parked","label":"usage limit"}},"jobs":[]}') @{ a = 'x' }
Assert-That ($r.news.Count -eq 1 -and $r.news[0].title -eq "$GlyphParked x" -and $r.news[0].body -eq 'usage limit') 'parked alerts'

$prev = ConvertTo-Map (Poll '{"a":{"state":"working","label":"running Bash"}}')
$news = Get-Alerts $prev @{} @{}
Assert-That ($news.Count -eq 1 -and $news[0].title -eq "$GlyphDone session" -and $news[0].body -eq 'finished') 'done falls back to session, never the label'

$prev = ConvertTo-Map (Poll '{"a":{"state":"working"},"b":{"state":"working"}}')
$cur = ConvertTo-Map (Poll '{"a":{"state":"awaiting"},"b":{"state":"parked"}}')
$news = Get-Alerts $prev $cur @{}
Assert-That ($news.Count -eq 2 -and -not ($news | Where-Object { $_.title.StartsWith($GlyphDone) })) 'into awaiting or parked is not done'

$titles = @{}
$r = Step-Poll $null (Poll '{"status":{"a":{"state":"working"}},"jobs":[]}') $titles
$r = Step-Poll $r.prev (Poll '{"status":{"a":{"state":"awaiting"}},"jobs":[],"watched":true}') $titles
Assert-That ($r.news.Count -eq 0) 'watched: no alert'
$r = Step-Poll $r.prev (Poll '{"status":{"a":{"state":"awaiting"}},"jobs":[]}') $titles
Assert-That ($r.news.Count -eq 0) 'the window closes: nothing replays'

$r = Step-Poll $r.prev $null $titles
Assert-That ($null -eq $r.prev -and $r.waiting.Count -eq 0) 'down: no rows, no baseline'
$r = Step-Poll $r.prev (Poll '{"status":{"a":{"state":"awaiting"}},"jobs":[]}') $titles
Assert-That ($r.news.Count -eq 0) 'back up: a fresh baseline'

$status = ConvertTo-Map (Poll '{"b":{"state":"awaiting","label":"Zed?"},"a":{"state":"awaiting"},"c":{"state":"working"}}')
$rows = Get-Waiting $status @{ b = 'alpha' }
Assert-That ($rows.Count -eq 2 -and $rows[0].title -eq 'alpha' -and $rows[1].title -eq 'waiting on you') 'rows sort by title, falling back to waiting on you'

Assert-That ((Get-SessionUrl 8790 '/?token=abc' 's 1') -eq 'http://localhost:8790/?token=abc&s=s%201&skipboot') 'token and session'
Assert-That ((Get-SessionUrl 8790 '/' 's1') -eq 'http://localhost:8790/?s=s1&skipboot') 'no token'
Assert-That ((Get-SessionUrl 8790 $null $null) -eq 'http://localhost:8790/') 'manifest unreachable'
Assert-That ((Get-SessionUrl 8790 '/?token=abc' $null) -eq 'http://localhost:8790/?token=abc') 'open dashboard keeps the token'

$one = Get-Balloon @(@{ id = 'a'; title = "$GlyphWait fix login"; body = 'Which DB?' })
Assert-That ($one.id -eq 'a' -and $one.title -eq "$GlyphWait fix login" -and $one.body -eq 'Which DB?') 'one alert names its session'
$many = Get-Balloon @(@{ id = 'a'; title = 'one'; body = 'x' }, @{ id = 'b'; title = 'two'; body = 'y' })
Assert-That ($null -eq $many.id -and $many.title -eq '2 sessions need you' -and $many.body -eq "one`ntwo") 'several summarise'
$long = Get-Balloon @(@{ id = 'a'; title = ('t' * 80); body = ('b' * 300) })
Assert-That ($long.title.Length -eq 63 -and $long.body.Length -eq 255) 'balloons clip to 63/255'
Assert-That ((Get-Tooltip $true 3) -eq "mystical $Dash 3 waiting on you" -and (Get-Tooltip $false 0) -eq "mystical $Dash stopped") 'tooltip'
Assert-That ((Get-MenuHead '' $true 2) -eq "$GlyphUp running $Dot 2 waiting on you" -and (Get-MenuHead "$GlyphBusy starting" $false 0) -eq "$GlyphBusy starting") 'menu head'

Assert-That ((Get-BridgeArgs 'Ubuntu' 'u' '/home/u/m' 'start') -eq "-d `"Ubuntu`" -u `"u`" -e bash -lic `"'/home/u/m/bin/mystical' start`"") 'wsl.exe argument line'
$ba = Get-BrowserArgs 'Profile 2' 'http://localhost:8790/'
Assert-That (($ba -join ' ') -eq '--profile-directory="Profile 2" --app=http://localhost:8790/') 'browser arguments quote the profile'
$ba = Get-BrowserArgs '' 'http://localhost:8790/'
Assert-That ($ba.Count -eq 1 -and $ba[0] -eq '--app=http://localhost:8790/') 'no profile, no flag'

if ($script:failed) { Write-Host "$($script:failed) failed"; exit 1 }
Write-Host 'all passed'
```

- [ ] **Step 4: Run the pytest guard**

Run: `$PY -m pytest tests/test_tray.py -q`
Expected: `14 passed`. (The pwsh run of `tray.check.ps1` comes in Task 8; nothing on this Mac can run it before then.)

- [ ] **Step 5: Commit**

```bash
git add windows/tray.ps1 windows/tray.check.ps1 tests/test_tray.py
git commit -m "windows tray: the WSL bridge's tray icon in PowerShell 5.1 + WinForms, with a pwsh check of its pure half"
```

---

### Task 5: `startup.py`, the tray's login entries and `launch_tray()`

**Files:**
- Modify: `bridge/startup.py`:
  - the module docstring, adding a tray paragraph;
  - constants after `_AUTOSTART`;
  - new `_tray_ps1`, `_tray_argv`, `_cmd_arg`, `_exec_arg`, `_tray_desktop`, `_remove`, `launch_tray`;
  - `_script()`;
  - `apply()`'s Linux and login-off branches.
- Modify: `tests/test_startup.py`:
  - a new autouse fixture;
  - one assertion in `test_script_waits_rather_than_sleeping`;
  - new tests.
- Modify: `tests/test_tray.py` (the two interface pins)

**Interfaces:**
- Consumes: `windows/tray.ps1`'s param names (`Port Distro User Repo Browser BrowserProfile`), and `linux/tray.py`'s `parser()` and `--check`.
- Produces:
  - `startup._tray_argv(windows: bool, browser: str | None, profile: str | None) -> list[str]`. Under `windows`, it returns powershell.exe's arguments, starting `-NoProfile`. Otherwise it returns the full Linux argv, starting `/usr/bin/python3`.
  - `startup.launch_tray() -> None`, which raises `RuntimeError(str)`. Task 6 uses it.
  - `startup._TRAY_AUTOSTART`, `startup._POWERSHELL`.

- [ ] **Step 1: Write the failing tests**

In `tests/test_startup.py`, add this fixture right after `_not_darwin`:

```python
@pytest.fixture(autouse=True)
def _tray_entry_in_tmp(monkeypatch, tmp_path):
    """The tray's autostart entry would otherwise land in the real ~/.config."""
    monkeypatch.setattr(startup, "_TRAY_AUTOSTART",
                        str(tmp_path / "autostart/mystical-tray.desktop"))
```

In `test_script_waits_rather_than_sleeping`, replace `assert "errorlevel 1" in text` with:

```python
    # Captured, not tested in place: the tray's `start` line runs in between.
    assert 'set "UP=%errorlevel%"' in text and 'if not "%UP%"=="0" (' in text
```

Append these tests (before the `# --- macOS` block):

```python
def _wsl_box(monkeypatch):
    monkeypatch.setattr(startup, "_REPO", "/home/u/projects/mystical-assistant")
    monkeypatch.setattr(startup, "_distro", lambda: "Ubuntu")
    monkeypatch.setattr(startup.getpass, "getuser", lambda: "u")
    monkeypatch.setattr(startup, "_browser",
                        lambda: "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe")
    monkeypatch.setattr(startup, "_profile", lambda *_: "Profile 2")


def test_script_starts_the_tray_with_the_window(monkeypatch):
    from bridge import config
    _wsl_box(monkeypatch)
    text = startup._script(True)
    line = next(ln for ln in text.split("\r\n") if "tray.ps1" in ln)
    assert line.startswith('start "" powershell.exe -NoProfile -WindowStyle Hidden '
                           '-ExecutionPolicy Bypass -File ')
    assert r"\\wsl$\Ubuntu\home\u\projects\mystical-assistant\windows\tray.ps1" in line
    assert (f"-Port {config.DASH_PORT} -Distro Ubuntu -User u "
            "-Repo /home/u/projects/mystical-assistant") in line
    assert r'-Browser "C:\Program Files\Google\Chrome\Application\chrome.exe"' in line
    assert '-BrowserProfile "Profile 2"' in line
    # Ahead of the bail-out: a bridge that didn't answer still gets its tray.
    assert text.index("tray.ps1") < text.index('if not "%UP%"=="0"')
    assert "tray.ps1" not in startup._script(False)


def test_a_checkout_on_a_windows_drive_runs_the_tray_from_there(monkeypatch):
    _wsl_box(monkeypatch)
    monkeypatch.setattr(startup, "_REPO", "/mnt/d/src/mystical-assistant")
    assert r"-File D:\src\mystical-assistant\windows\tray.ps1" in startup._script(True)


def test_linux_tray_entry_follows_the_window_switch(tmp_path, monkeypatch):
    from bridge import config
    entry = tmp_path / "autostart/mystical-assistant.desktop"
    tray = tmp_path / "autostart/mystical-tray.desktop"
    monkeypatch.setattr(startup, "_wsl", lambda: False)
    monkeypatch.setattr(startup, "_AUTOSTART", str(entry))
    monkeypatch.setattr(startup, "_TRAY_AUTOSTART", str(tray))
    monkeypatch.setattr(startup, "_REPO", "/home/u/m")
    monkeypatch.setattr(startup, "_has_systemd", lambda: True)
    monkeypatch.setattr(startup, "_browser", lambda: "/usr/bin/google-chrome")
    monkeypatch.setattr(startup, "_profile", lambda *_: "Profile 5")
    monkeypatch.setattr(startup, "_profiles", lambda _b: [])
    monkeypatch.setattr(startup, "_unit_text", lambda: "[Unit]\n")
    monkeypatch.setattr(startup, "_systemctl", _fake_systemctl([]))
    monkeypatch.setattr(startup.subprocess, "run", lambda *a, **k: None)
    monkeypatch.setattr(startup, "_UNIT_DIR", str(tmp_path / "systemd"))

    startup.apply(True, True)
    assert (f"Exec=/usr/bin/python3 /home/u/m/linux/tray.py --port {config.DASH_PORT} "
            '--browser /usr/bin/google-chrome --profile "Profile 5"\n') in tray.read_text()
    startup.apply(True, False)                    # window off: both entries go
    assert not tray.exists() and not entry.exists()
    startup.apply(True, True)
    startup.apply(False, False)                   # login off: both go too
    assert not tray.exists() and not entry.exists()


def test_launch_tray_on_wsl_runs_windows_powershell_from_a_windows_dir(tmp_path, monkeypatch):
    _wsl_box(monkeypatch)
    ps = tmp_path / "powershell.exe"
    ps.write_text("")
    monkeypatch.setattr(startup, "_wsl", lambda: True)
    monkeypatch.setattr(startup, "_POWERSHELL", str(ps))
    seen = {}
    monkeypatch.setattr(startup.subprocess, "Popen",
                        lambda argv, **kw: seen.update(argv=argv, **kw))
    startup.launch_tray()
    assert seen["argv"][0] == str(ps) and "-File" in seen["argv"]
    assert seen["cwd"] == str(tmp_path) and seen["start_new_session"] is True


def test_launch_tray_on_wsl_says_when_there_is_no_powershell(tmp_path, monkeypatch):
    _wsl_box(monkeypatch)
    monkeypatch.setattr(startup, "_wsl", lambda: True)
    monkeypatch.setattr(startup, "_POWERSHELL", str(tmp_path / "nope.exe"))
    with pytest.raises(RuntimeError, match="PowerShell"):
        startup.launch_tray()


def test_launch_tray_on_linux_checks_the_bindings_first(monkeypatch):
    from bridge import config
    monkeypatch.setattr(startup, "_wsl", lambda: False)
    monkeypatch.setattr(startup, "_REPO", "/home/u/m")
    monkeypatch.setattr(startup, "_browser", lambda: None)

    class R:
        returncode = 1
        stderr = "mystical tray: the GTK bindings are missing (No module named 'gi')."
    monkeypatch.setattr(startup.subprocess, "run", lambda argv, **kw: R())
    started = []
    monkeypatch.setattr(startup.subprocess, "Popen", lambda argv, **kw: started.append(argv))
    with pytest.raises(RuntimeError, match="GTK bindings"):
        startup.launch_tray()
    assert not started
    R.returncode = 0
    startup.launch_tray()
    assert started == [["/usr/bin/python3", "/home/u/m/linux/tray.py",
                        "--port", str(config.DASH_PORT)]]
```

Append to `tests/test_tray.py` (add `import re` to its imports):

```python
def test_startup_passes_only_arguments_the_linux_tray_takes():
    from bridge import startup
    argv = startup._tray_argv(False, "/usr/bin/google-chrome", "Profile 5")
    assert argv[:2] == ["/usr/bin/python3", os.path.join(startup._REPO, "linux", "tray.py")]
    a = tray.parser().parse_args(argv[2:])
    assert (a.browser, a.profile) == ("/usr/bin/google-chrome", "Profile 5")


def test_startup_passes_only_parameters_the_windows_tray_declares():
    from bridge import startup
    argv = startup._tray_argv(
        True, "/mnt/c/Program Files/Google/Chrome/Application/chrome.exe", "Profile 2")
    passed = {name[1:] for name in argv[argv.index("-File") + 2:][::2]}
    text = open(os.path.join(_ROOT, "windows", "tray.ps1"), encoding="ascii").read()
    declared = set(re.findall(r"\$(\w+)", text.split("param(", 1)[1].split("\n)", 1)[0]))
    assert passed == {"Port", "Distro", "User", "Repo", "Browser", "BrowserProfile"}
    assert passed <= declared, passed - declared
```

- [ ] **Step 2: Run them to make sure they fail**

Run: `$PY -m pytest tests/test_startup.py tests/test_tray.py -q 2>&1 | tail -15`
Expected: errors on every test_startup test, because the autouse fixture hits `AttributeError: … has no attribute '_TRAY_AUTOSTART'`. The two new test_tray tests also fail, with `AttributeError: … '_tray_argv'`.

- [ ] **Step 3: Implement it in `bridge/startup.py`**

Append to the module docstring, before its closing `"""`:

```
The window half also starts the **tray companion** (windows/tray.ps1 under WSL,
linux/tray.py on a Linux desktop): Mystical.app's menu bar for these systems.
It runs from this checkout with what the OS ships, so there is nothing to
install; launch_tray() is `mystical app` for not waiting until the next login.
```

After the `_AUTOSTART = …` line, add:

```python
# The tray's own entry beside the window's, so the desktop's startup-apps list
# shows, and can switch off, each one on its own.
_TRAY_AUTOSTART = os.path.expanduser("~/.config/autostart/mystical-tray.desktop")
# Windows exes aren't on a WSL PATH; this one is on every Windows 10/11.
_POWERSHELL = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
```

Replace `_script()` in full:

```python
def _script(open_window: bool, profile: str | None = None) -> str:
    from bridge import config
    port = config.DASH_PORT
    distro, user = _distro(), getpass.getuser()
    lines = [
        "@echo off",
        "REM mystical//assistant - written by the dashboard's SYSTEM tab. Toggle it",
        "REM there rather than editing here; this file is rewritten on every change.",
        "REM Booting the WSL distro is the whole trick: systemd + linger bring the",
        "REM bridge up on their own once Windows touches the distro. Then wait for",
        "REM the port to actually answer, because WSL boot plus bridge start takes",
        "REM several seconds and a blind sleep races it. Quarter-second polls, so",
        "REM the window opens the moment it answers (same 60s ceiling).",
        "",
        f'wsl.exe -d {distro} -u {user} -e bash -c "for i in $(seq 1 240); do '
        f'curl -sf -o /dev/null http://127.0.0.1:{port}/ && exit 0; sleep 0.25; done; exit 1"',
        'set "UP=%errorlevel%"',
    ]
    browser = _browser()
    if open_window:
        prof = (profile or _profile(browser, port)) if browser else None
        lines += ["", "REM The tray (windows/tray.ps1) comes up whether or not the bridge did,",
                  "REM so a failed start still leaves you a tray with Start in it.",
                  'start "" powershell.exe '
                  + " ".join(map(_cmd_arg, _tray_argv(True, browser, prof)))]
    lines += [
        "",
        'if not "%UP%"=="0" (',
        f"  echo mystical//assistant did not answer on :{port} within 60s.",
        f"  echo Check it with:  wsl -d {distro} -- systemctl --user status {UNIT}",
        "  pause",
        "  exit /b 1",
        ")",
    ]
    if open_window and browser:
        pick = f' --profile-directory="{prof}"' if prof else ""
        lines += ["", f'start "" "{_win_path(browser)}"{pick} '
                      f'--app=http://localhost:{port}/']
    # CRLF: a .cmd with bare LFs breaks cmd.exe's parsing of multi-line if blocks.
    return "\r\n".join(lines) + "\r\n"
```

After `_desktop()`, add:

```python
def _tray_ps1() -> str:
    """Where Windows finds windows/tray.ps1: the distro's \\\\wsl$ share, or the
    drive path when the checkout lives on /mnt/<drive>."""
    p = os.path.join(_REPO, "windows", "tray.ps1")
    return _win_path(p) if p.startswith("/mnt/") else f"\\\\wsl$\\{_distro()}" + p.replace("/", "\\")


def _tray_argv(windows: bool, browser: str | None, profile: str | None) -> list[str]:
    """The tray's command line, with the same port, browser and profile as the
    window line beside it. `windows`: powershell.exe's arguments for
    windows/tray.ps1. Otherwise: linux/tray.py on the system interpreter,
    where the distro's PyGObject lives."""
    from bridge import config
    port = str(config.DASH_PORT)
    if windows:
        argv = ["-NoProfile", "-WindowStyle", "Hidden", "-ExecutionPolicy", "Bypass",
                "-File", _tray_ps1(), "-Port", port, "-Distro", _distro(),
                "-User", getpass.getuser(), "-Repo", _REPO]
        argv += ["-Browser", _win_path(browser)] if browser else []
        return argv + (["-BrowserProfile", profile] if profile else [])
    argv = ["/usr/bin/python3", os.path.join(_REPO, "linux", "tray.py"), "--port", port]
    argv += ["--browser", browser] if browser else []
    return argv + (["--profile", profile] if profile else [])


def _cmd_arg(a: str) -> str:
    """One argument of a .cmd line, quoted when it has a space (cmd.exe and
    PowerShell's own parser both split there)."""
    return f'"{a}"' if " " in a or not a else a


def _exec_arg(a: str) -> str:
    # shortcut: quotes spaces only. A path holding " ` $ or \ needs the Desktop
    # Entry spec's double escaping; none of ours do. Escape them if one must.
    return f'"{a}"' if " " in a else a


def _tray_desktop(profile: str | None = None) -> str:
    """The autostart entry for linux/tray.py."""
    from bridge import config
    browser = _browser()
    prof = (profile or _profile(browser, config.DASH_PORT)) if browser else None
    return ("[Desktop Entry]\n"
            "Type=Application\n"
            "Name=mystical//assistant tray\n"
            "Comment=What's waiting on you, and alerts while the window is closed\n"
            f"Exec={' '.join(map(_exec_arg, _tray_argv(False, browser, prof)))}\n"
            "X-GNOME-Autostart-enabled=true\n")


def _remove(*paths: str) -> None:
    for p in paths:
        if os.path.isfile(p):
            os.remove(p)


def launch_tray() -> None:
    """Start the tray now, detached: `mystical app` on Linux and WSL, so it
    doesn't wait for the next login. Raises RuntimeError with a line worth
    showing when it can't start."""
    from bridge import config
    win, browser = _wsl(), _browser()
    # shortcut: the profile is the auto-guess, not a pin from the SYSTEM tab;
    # they agree unless the pinned profile never opened the dashboard.
    prof = _profile(browser, config.DASH_PORT) if browser else None
    argv = _tray_argv(win, browser, prof)
    if win:
        if not os.path.isfile(_POWERSHELL):
            raise RuntimeError(f"no Windows PowerShell at {_POWERSHELL}")
        # A Windows working dir: run from a WSL path, Windows sees a UNC cwd.
        argv, cwd = [_POWERSHELL, *argv], os.path.dirname(_POWERSHELL)
    else:
        try:
            check = subprocess.run([*argv[:2], "--check"], capture_output=True,
                                   text=True, timeout=30)
        except (OSError, subprocess.SubprocessError) as e:
            raise RuntimeError(f"can't run {argv[0]}: {e}") from e
        if check.returncode:
            raise RuntimeError(check.stderr.strip() or "the tray's GTK bindings are missing")
        cwd = None
    # A tray started from inside a bridge session lives in the bridge unit's
    # cgroup and goes down with its next restart; the login entry's doesn't.
    subprocess.Popen(argv, cwd=cwd, start_new_session=True, stdin=subprocess.DEVNULL,
                     stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
```

In `apply()`, replace the Linux window branch and the login-off cleanup.

Old (inside `if login:`):

```python
        elif window and _browser():
            os.makedirs(os.path.dirname(_AUTOSTART), exist_ok=True)
            with open(_AUTOSTART, "w", encoding="utf-8") as f:
                f.write(_desktop(profile))
        elif os.path.isfile(_AUTOSTART):
            os.remove(_AUTOSTART)
```

New:

```python
        elif window and _browser():
            for path, text in ((_AUTOSTART, _desktop(profile)),
                               (_TRAY_AUTOSTART, _tray_desktop(profile))):
                os.makedirs(os.path.dirname(path), exist_ok=True)
                with open(path, "w", encoding="utf-8") as f:
                    f.write(text)
        else:
            _remove(_AUTOSTART, _TRAY_AUTOSTART)
```

Old (end of the `else:`, login off):

```python
        for f in (cmd, None if cmd else _AUTOSTART):
            if f and os.path.isfile(f):
                os.remove(f)
```

New:

```python
        _remove(*((cmd,) if cmd else (_AUTOSTART, _TRAY_AUTOSTART)))
```

- [ ] **Step 4: Run the tests to make sure they pass**

Run: `$PY -m pytest tests/test_startup.py tests/test_tray.py -q 2>&1 | tail -6 && $PY -m pyflakes bridge/startup.py tests/test_startup.py tests/test_tray.py`
Expected: `2 failed` — exactly `test_script_opens_a_window_only_when_asked` and `test_state_reports_why_when_there_is_no_windows_side`, the known macOS pair. Everything else passes, and pyflakes prints nothing.

- [ ] **Step 5: Commit**

```bash
git add bridge/startup.py tests/test_startup.py tests/test_tray.py
git commit -m "startup: OPEN THE WINDOW TOO also starts the tray companion at login; launch_tray() starts it now"
```

---

### Task 6: `mystical app` on Linux/WSL, and the doctor's tray line

**Files:**
- Modify: `bin/mystical` (the usage line for `app`; `cmd_app()`, around line 354)
- Modify: `setup.sh` (`doctor()`, after the Darwin `swift` block, around line 58)

**Interfaces:**
- Consumes: `startup.launch_tray()` (Task 5) and `linux/tray.py --check` (Task 3).

- [ ] **Step 1: Write the failing check**

There's no bash test harness in this repo, so the check is a fake `uname` that makes this Mac look like Linux:

```bash
mkdir -p .mystical/fakeos && printf '#!/bin/sh\necho Linux\n' > .mystical/fakeos/uname && chmod +x .mystical/fakeos/uname
PATH="$PWD/.mystical/fakeos:$PATH" bin/mystical app open; echo "exit $?"
```

Expected now: `✘ Mystical.app is macOS-only.` and `exit 1`. After Step 2 it must name what `mystical app` does here.

- [ ] **Step 2: Implement `cmd_app` for Linux/WSL**

Replace `cmd_app()`:

```bash
cmd_app() {
  if ! darwin; then
    # Linux and WSL have nothing to build: the tray (linux/tray.py,
    # windows/tray.ps1) runs from this checkout. This starts it now; OPEN THE
    # WINDOW TOO brings it back at every login.
    [ -z "${1:-}" ] || die "'mystical app $1' is macOS-only. Here the window is your browser's installed app, and 'mystical app' starts the tray."
    PYTHONPATH="$REPO" python3 -c '
import sys
from bridge import startup
try:
    startup.launch_tray()
except RuntimeError as e:
    sys.exit(str(e))
' || exit 1
    ok "tray started — OPEN THE WINDOW TOO (SETTINGS → SYSTEM) brings it back at every login"
    return 0
  fi
  case "${1:-}" in
    "")   exec "$REPO/macos/build.sh" ;;
    open) [ -d "$APP" ] || die "not built yet — run: mystical app"; exec open "$APP" ;;
    *)    die "unknown option for app: $1 — 'mystical app' builds, 'mystical app open' opens" ;;
  esac
}
```

In `usage()`, replace the `app` line with:

```bash
  ${c_b}🍎${c_0} mystical ${c_c}app${c_0} ${c_c}[open]${c_0}  macOS: build + install Mystical.app, or open it · Linux/WSL: start the tray icon
```

- [ ] **Step 3: Add the doctor line in `setup.sh`**

Right after the Darwin `swift` block inside `doctor()` (the `fi` that closes `if [ "$(uname -s)" = Darwin ]`), add:

```bash
  # A Linux desktop (WSL's tray is PowerShell, always there): the tray icon
  # needs the distro's GTK bindings, and linux/tray.py --check names them.
  if [ "$(uname -s)" = Linux ] && [ -n "${XDG_CURRENT_DESKTOP:-}" ] \
     && ! grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then
    if msg="$(/usr/bin/python3 "$REPO/linux/tray.py" --check 2>&1)"; then ok "tray bindings — the tray icon can run"
    else warn "tray bindings — missing: no tray icon. ${msg#mystical tray: }"; fi
  fi
```

- [ ] **Step 4: Verify both, as Linux and as the Mac**

```bash
bash -n bin/mystical && bash -n setup.sh && echo syntax-ok
PATH="$PWD/.mystical/fakeos:$PATH" bin/mystical app open; echo "exit $?"
PATH="$PWD/.mystical/fakeos:$PATH" bin/mystical app; echo "exit $?"
PATH="$PWD/.mystical/fakeos:$PATH" XDG_CURRENT_DESKTOP=GNOME ./setup.sh --check-only 2>&1 | grep -i tray
./setup.sh --check-only 2>&1 | grep -ci tray; bin/mystical app bogus; echo "exit $?"
```

Expected:
1. `syntax-ok`.
2. `✘ 'mystical app open' is macOS-only. Here the window is …` and `exit 1`.
3. `mystical tray: the GTK bindings are missing (No module named 'gi'). Debian/Ubuntu: …` and `exit 1`. This is `launch_tray()`'s real Linux path, running `/usr/bin/python3 linux/tray.py --check` on this Mac.
4. `▲ tray bindings — missing: no tray icon. the GTK bindings are missing …`.
5. `0` (no tray line on a Mac), then the unchanged macOS `✘ unknown option for app: bogus …` and `exit 1`.

- [ ] **Step 5: Commit**

```bash
git add bin/mystical setup.sh
git commit -m "mystical app starts the tray on Linux/WSL; doctor names the Linux tray's packages"
```

---

### Task 7: The words — README and the STARTUP info text

**Files:**
- Modify: `README.md` (command list around line 318; new paragraph after the launchd paragraph ending "Rebuild the app (`mystical app`) after moving the checkout.", around line 350)
- Modify: `bridge/dashboard/web/src/components/hud/SettingsModal.tsx:2014` (the STARTUP `info=` string)

- [ ] **Step 1: README command list**

After the line `mystical app open   macOS: open it`, add:

```
mystical app        Linux/WSL: start the tray icon now (it also comes up at login)
```

- [ ] **Step 2: README paragraph**

After the launchd paragraph, add:

```markdown
**On Windows (WSL) and Linux**

The dashboard's own window comes from your browser: INSTALL AS APP in the
dashboard's SYSTEM tab, then START AT LOGIN and OPEN THE WINDOW TOO to have it
open at login. OPEN THE WINDOW TOO also starts a **tray icon**, Mystical.app's
menu bar for these systems. It shows how many sessions are waiting on you, with
a row for each, plus start/stop/restart and alerts while no dashboard window is
open. A window that's open alerts by itself, so the tray stays quiet then.
`mystical app` starts it now instead of at the next login. There's nothing to
build. On Windows it's PowerShell (`windows/tray.ps1`). On Linux it's the system
python3 with the distro's GTK bindings (`linux/tray.py`), and `mystical doctor`
names the packages if they're missing. GNOME shows tray icons only with the
AppIndicator extension, which Ubuntu ships and Fedora doesn't. The alerts work
without it.
```

- [ ] **Step 3: The STARTUP info text**

In `SettingsModal.tsx:2014`, inside the `info="…"` string, replace

```
(a launchd agent on a Mac, where OPEN THE WINDOW TOO opens Mystical.app — build it with `mystical app`)
```

with

```
(a launchd agent on a Mac, where OPEN THE WINDOW TOO opens Mystical.app — build it with `mystical app`; on Windows and Linux it also starts a tray icon with what's waiting on you)
```

- [ ] **Step 4: Type-check**

Run: `cd bridge/dashboard/web && ./node_modules/.bin/tsc -p tsconfig.app.json; echo "tsc exit $?"; cd "$WT"`
Expected: `tsc exit 0`.

- [ ] **Step 5: Commit**

```bash
git add README.md bridge/dashboard/web/src/components/hud/SettingsModal.tsx
git commit -m "docs: the tray companion on Windows (WSL) and Linux"
```

---

### Task 8: Run the trays where they can run — pwsh and a Linux desktop container

**Files:**
- Create (git-ignored scratch): `.mystical/tray-probe/Dockerfile`, `.mystical/tray-probe/fake_bridge.py`, `.mystical/tray-probe/run.sh`, `.mystical/tray-probe/out/`

Nothing in this task is committed. Its output is evidence: pass/fail lines and screenshots for the user.

- [ ] **Step 1: Start Docker Desktop and wait for it**

```bash
DOCKER=/Applications/Docker.app/Contents/Resources/bin/docker
open -a Docker
```

Then wait, using Monitor with an until-loop (no foreground sleep) and a 180 s ceiling: `until "$DOCKER" info >/dev/null 2>&1; do sleep 3; done`. If it never answers, write "container checks NOT RUN: Docker didn't start" in the report and skip to Task 9.

- [ ] **Step 2: The PowerShell parse check plus `tray.check.ps1`**

```bash
"$DOCKER" run --rm -v "$WT/windows:/w:ro" mcr.microsoft.com/powershell:latest pwsh -NoProfile -Command '
  $errs = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile("/w/tray.ps1", [ref]$null, [ref]$errs)
  if ($errs) { $errs | ForEach-Object { $_.ToString() }; exit 1 }
  "parse-ok"
  & /w/tray.check.ps1'
echo "exit $?"
```

Expected: `parse-ok`, about 25 `ok` lines, `all passed`, `exit 0`. If the image has no arm64 build, add `--platform linux/amd64`. A `FAIL` line means `tray.ps1` and `linux/tray.py` disagree. Fix `tray.ps1` (the Python side is pinned by pytest), rerun, and commit the fix as `windows tray: <what>`.

- [ ] **Step 3: Write the probe files**

`.mystical/tray-probe/Dockerfile`:

```dockerfile
FROM debian:bookworm-slim
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
      python3 python3-gi gir1.2-gtk-3.0 gir1.2-ayatanaappindicator3-0.1 gir1.2-notify-0.7 \
      xvfb stalonetray xfce4-panel xfce4-notifyd dbus-x11 xdotool imagemagick \
      fonts-dejavu-core adwaita-icon-theme librsvg2-common \
  && rm -rf /var/lib/apt/lists/*
```

`.mystical/tray-probe/fake_bridge.py`:

```python
"""A stand-in for the dashboard: /local/running steps from one working session
to two waiting on you (three polls per step), plus a manifest with a token."""
import json
import sys
from http.server import BaseHTTPRequestHandler, HTTPServer

STEPS = [
    {"status": {"s1": {"state": "working", "label": "running Bash"}},
     "jobs": [{"session_id": "s1", "title": "fix the login redirect"}]},
    {"status": {"s1": {"state": "awaiting", "label": "Which database should I use?"},
                "s2": {"state": "awaiting", "label": "Allow git push?"}},
     "jobs": [{"session_id": "s2", "title": "release notes"}]},
]
polls = 0


class H(BaseHTTPRequestHandler):
    def do_GET(self):
        global polls
        if self.path.startswith("/local/running"):
            body = {**STEPS[min(polls // 3, len(STEPS) - 1)], "watched": False}
            polls += 1
        else:
            body = {"start_url": "/?token=probe"}
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


HTTPServer(("127.0.0.1", int(sys.argv[1])), H).serve_forever()
```

`.mystical/tray-probe/run.sh`:

```bash
#!/bin/bash
# Inside the probe container: a virtual display, a tray host, a notification
# daemon, the fake bridge and the real linux/tray.py. Screenshots go to /out.
set -u
export DISPLAY=:99
Xvfb :99 -screen 0 900x520x24 & sleep 1
if [ "${HOST:-stalonetray}" = xfce ]; then
  XFCE_PANEL_MIGRATE_DEFAULT=1 xfce4-panel & sleep 3
else
  stalonetray --geometry 6x1+0+0 --icon-size 32 --background '#1d2626' & sleep 1
fi
python3 /probe/fake_bridge.py 8790 &
python3 /repo/linux/tray.py --check && echo "check-ok"
python3 /repo/linux/tray.py --port 8790 &
sleep 6;  import -window root /out/1-baseline.png      # working: the baseline, no alert
sleep 9;  import -window root /out/2-alerts.png        # two sessions now wait on you
xdotool mousemove 16 16 click 1; sleep 1; import -window root /out/3-menu.png
python3 /repo/linux/tray.py --port 8790; echo "second tray exit $?"   # must back off at once
```

- [ ] **Step 4: Build and run it**

```bash
cd "$WT/.mystical/tray-probe" && mkdir -p out && "$DOCKER" build -q -t mystical-tray-probe . && cd "$WT"
"$DOCKER" run --rm -v "$WT:/repo:ro" -v "$WT/.mystical/tray-probe:/probe:ro" \
  -v "$WT/.mystical/tray-probe/out:/out" mystical-tray-probe dbus-run-session bash /probe/run.sh
```

Expected: `check-ok`, `second tray exit 0`, and three PNGs in `out/`.
- `1-baseline.png`: the icon, no alert.
- `2-alerts.png`: two notifications, `⏸ fix the login redirect` / "Which database should I use?" and `⏸ release notes` / "Allow git push?".
- `3-menu.png`: the menu, headed `● running · 2 waiting on you`, with the two rows, Open dashboard, Start (greyed), Stop, Restart and Quit tray.

If stalonetray shows no icon (AppIndicator without an XEmbed fallback), rerun with `-e HOST=xfce` added before the image name, and use those screenshots. Look at each PNG before trusting it. If the menu didn't open at (16,16), try a right click (`click 3`), or click at the icon's actual position.

- [ ] **Step 5: Deliver the evidence and tidy up**

Attach the three screenshots with `mcp__verify__Attach`, each with a one-line caption saying what it shows. Note which tray host rendered the icon, and whether the count label showed. XEmbed hosts don't draw AppIndicator labels, so in that case the menu head carries the count.

Then quit Docker Desktop, since it wasn't running before: `osascript -e 'quit app "Docker"'`.

---

### Task 9: Whole-branch verification and hand-off

**Files:** none new.

- [ ] **Step 1: Full suite, lint, types, shell syntax**

```bash
$PY -m pytest tests/ -q 2>&1 | tail -12
$PY -m pyflakes bridge/startup.py bridge/dashboard/server.py linux/tray.py \
  tests/test_tray.py tests/test_running_watched.py tests/test_startup.py
(cd bridge/dashboard/web && ./node_modules/.bin/tsc -p tsconfig.app.json && echo tsc-ok)
bash -n bin/mystical && bash -n setup.sh && echo sh-ok
```

Expected: exactly the 7 known macOS failures, and a passed count that is Task 0's baseline plus the new tests (4 in `test_running_watched.py` + 16 in `test_tray.py` + 6 in `test_startup.py` = 26 more). No pyflakes output, `tsc-ok`, `sh-ok`. Anything else red is this branch's, so fix it before going on.

- [ ] **Step 2: Review the whole branch**

Use superpowers:requesting-code-review on `git diff master...feat/tray-companion`. Point the reviewer at the spec, this plan's Review Focus, and the five spec tweaks. Fix what it confirms, re-run Step 1, and commit the fixes.

- [ ] **Step 3: Hand off (superpowers:finishing-a-development-branch)**

Don't merge on your own. The final report says, outcome first:
- what passed, with the commands above;
- what ran in containers, with screenshots attached;
- what hasn't run anywhere: the WinForms half of `tray.ps1`, and every Windows-side path (`\\wsl$` launch, toasts, `wsl.exe` start/stop);
- the Windows checklist from the spec's Testing section (5 checks);
- that live use needs the branch merged, then a dashboard `dist` rebuild for the `alerts=1` flag and a bridge restart for `watched` (bridge-ship). On this Mac neither changes what the user sees.

Ask the user one decision with AskUserQuestion: merge `feat/tray-companion` into local master now, or leave it on the branch until the Windows checklist has run. Getting the branch onto a Windows machine (a push or a `git bundle`) is a separate question for later. Never push without their explicit OK.
