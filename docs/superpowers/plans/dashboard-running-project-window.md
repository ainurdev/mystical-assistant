# Session-bound branch + floating running-project window — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Terminal header's branch follow the selected session (and sync the active project on select), and replace the `DSGN` view-tab with a non-modal, draggable/resizable running-project window (localhost↔deployed toggle, Pin hidden, crosshair select cursor, existing Send-to-Claude flow).

**Architecture:** Backend exposes each session's branch in `_session_brief` (TTL-cached `git` call) and a per-project production URL + dev port; the frontend binds the header branch to the selected session, syncs the active project on select, and hosts the preview/selector flow inside a new floating window opened from the Terminal header.

**Tech Stack:** Python 3 stdlib HTTP server (`bridge/`), React 19 + Vite 6 + pnpm (`bridge/dashboard/web`), hand-rolled inline styles (no DnD/resize lib), `vite-plugin-mystical-selector` (`tools/selector-plugin`). Backend tests: `tests/test_bridge.py` (pytest or plain). Frontend verification: `tsc -b` + `vite build`.

## Global Constraints

- **No new frontend dependencies.** Drag/resize is hand-rolled with pointer events.
- **Stdlib only** in `bridge/` Python modules; every `git` call shells out with a timeout.
- **Inline-style convention**: match existing components (no Tailwind for new chrome except where the file already uses it — `PreviewFrame`/`SelectionTray` keep their existing className styles).
- **Dashboard serves a prebuilt `web/dist`** — rebuild via local bins; `pnpm build` can trip on esbuild, so typecheck with `npx tsc -b` and build with `npx vite build`. **Do not restart the bridge mid-session.**
- **The repo is mid-WIP** on `feat/dashboard-terminal-tab` (uncommitted terminal-tab work touching `App.tsx`, `Terminal.tsx`, `ViewTabs.tsx`, `DesignView.tsx`, `server.py`, `runner.py`, `test_bridge.py`). All file/line references are against the **current working tree**. `git add` only the files named in each task's commit step.
- **No git checkout** ever happens on session-select — display + active-project sync only.

## File structure

**Backend**
- `bridge/git.py` — add `current_branch_cached(cwd)` (TTL cache).
- `bridge/miniapp/server.py` — import `git`; add `"branch"` to `_session_brief`.
- `bridge/project_config.py` — add `prod_url` / `set_prod_url`.
- `bridge/dashboard/server.py` — `/local/state` adds `dev_port`; `/local/project/settings` GET adds `prod_url`, POST persists it; add `_allowed_screenshot_url` helper + use it in `/local/preview/screenshot`.
- `tests/test_bridge.py` — update `test_session_brief_shape`; add cache, prod_url, and screenshot-URL-validation tests.

**Frontend** (`bridge/dashboard/web/src`)
- `api.ts` — `SessionBrief.branch`, `DashState.dev_port`, `ProjectSettings.prod_url`, `setProjectSettings(project, {...})`, `screenshot(width, url?)`.
- `components/hud/ViewTabs.tsx` — drop `design`.
- `components/hud/Terminal.tsx` — add `⊞ PREVIEW` button + `onOpenRunner` prop.
- `components/hud/ProjectsPanel.tsx` — render `s.branch`; drop the worktrees fetch.
- `App.tsx` — `branch={selected?.branch}`, `selectSession`, `runnerOpen` + `<RunningWindow>`, remove `design` view/palette/import.
- `components/design/FloatingWindow.tsx` — **new** drag/resize chrome.
- `components/design/ProjectRunBar.tsx` — **new** (extracted from `DesignView`, controlled, + prod-URL field).
- `components/design/PreviewFrame.tsx` — hide Pin; crosshair in select mode.
- `components/design/RunningWindow.tsx` — **new**; composes the above + selector + Send to Claude.
- `components/design/DesignView.tsx` — **delete**.

**Selector plugin**
- `tools/selector-plugin/src/agent.ts` — crosshair cursor while armed.
- `tools/selector-plugin/test/agent.test.ts` — cursor assertion (if the suite covers `setMode`).

---

## Task 1: TTL-cached `current_branch`

**Files:**
- Modify: `bridge/git.py` (imports at top; add helper after `current_branch` at `bridge/git.py:153-155`)
- Test: `tests/test_bridge.py`

**Interfaces:**
- Produces: `git.current_branch_cached(cwd: str) -> str` — `current_branch` with a ~3s per-cwd cache; `""` for empty cwd. Module-level `git._branch_cache: dict[str, tuple[str, float]]`.

- [ ] **Step 1: Write the failing test**

Add to `tests/test_bridge.py`:

```python
def test_current_branch_cached_dedupes_within_ttl():
    from bridge import git
    calls = []
    real = git.current_branch
    git.current_branch = lambda cwd: (calls.append(cwd), "feat/x")[1]
    git._branch_cache.clear()
    try:
        assert git.current_branch_cached("/wt") == "feat/x"
        assert git.current_branch_cached("/wt") == "feat/x"
        assert len(calls) == 1            # second call served from cache
        assert git.current_branch_cached("") == ""   # empty cwd short-circuits
    finally:
        git.current_branch = real
        git._branch_cache.clear()
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_bridge.py::test_current_branch_cached_dedupes_within_ttl -v`
Expected: FAIL — `AttributeError: module 'bridge.git' has no attribute 'current_branch_cached'`.

- [ ] **Step 3: Write minimal implementation**

In `bridge/git.py`, change the import block at the top:

```python
import os
import subprocess
import time
```

Then add, immediately after `current_branch` (after `bridge/git.py:155`):

```python
_branch_cache: dict[str, tuple[str, float]] = {}
_BRANCH_TTL = 3.0


def current_branch_cached(cwd: str) -> str:
    """current_branch with a short TTL cache. /local/sessions polls every 5s and
    many sessions share one cwd (the project dir), so this avoids spawning a git
    per session on every poll."""
    if not cwd:
        return ""
    now = time.monotonic()
    hit = _branch_cache.get(cwd)
    if hit is not None and now - hit[1] < _BRANCH_TTL:
        return hit[0]
    b = current_branch(cwd)
    _branch_cache[cwd] = (b, now)
    return b
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_bridge.py::test_current_branch_cached_dedupes_within_ttl -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge/git.py tests/test_bridge.py
git commit -m "feat(git): TTL-cached current_branch for per-session branch lookups"
```

---

## Task 2: `branch` in the session payload

**Files:**
- Modify: `bridge/miniapp/server.py:21-23` (imports), `bridge/miniapp/server.py:85-88` (`_session_brief`)
- Test: `tests/test_bridge.py:323` (`test_session_brief_shape`)

**Interfaces:**
- Consumes: `git.current_branch_cached` (Task 1).
- Produces: `_session_brief(s)` now returns a `"branch"` key (str). Frontend `SessionBrief.branch` (Task 3) mirrors it.

- [ ] **Step 1: Update the shape test (currently out of sync — it omits `cwd`)**

Replace `test_session_brief_shape` at `tests/test_bridge.py:323`:

```python
def test_session_brief_shape():
    from bridge.miniapp.server import _session_brief
    s = store.create_session(555, "p6")
    b = _session_brief(s)
    assert set(b) == {"id", "title", "project", "updated", "archived",
                      "origin", "cwd", "branch"}
    assert b["id"] == s["id"] and b["project"] == "p6"
    assert isinstance(b["branch"], str)   # "" when cwd has no repo
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_bridge.py::test_session_brief_shape -v`
Expected: FAIL — assertion error, `branch` missing from the key set.

- [ ] **Step 3: Write minimal implementation**

In `bridge/miniapp/server.py`, add `git` to the bridge import (line 21-23 block):

```python
from bridge import (browser, config, devserver, git, github, native,
                    project_config, runner, screenshot, shell, state, store,
                    transcript_jsonl, tunnel, usage)
```

Replace `_session_brief` at `bridge/miniapp/server.py:85`:

```python
def _session_brief(s: dict) -> dict:
    cwd = s.get("cwd")
    return {"id": s["id"], "title": s["title"], "project": s["project"],
            "updated": s["updated"], "archived": s["archived"],
            "origin": s.get("origin"), "cwd": cwd,
            "branch": git.current_branch_cached(cwd) if cwd else ""}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_bridge.py::test_session_brief_shape -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge/miniapp/server.py tests/test_bridge.py
git commit -m "feat(sessions): include each session's git branch in the brief"
```

---

## Task 3: Per-project production URL + dev port (backend settings)

**Files:**
- Modify: `bridge/project_config.py` (add after `set_run_cmd`, `bridge/project_config.py:58`)
- Modify: `bridge/dashboard/server.py:154-159` (`/local/state`), `bridge/dashboard/server.py:247-261` (settings GET), and the settings POST in `_post_api`
- Test: `tests/test_bridge.py`

**Interfaces:**
- Produces: `project_config.prod_url(project) -> str | None`, `project_config.set_prod_url(project, url) -> str | None`. `/local/state` returns `dev_port: int`. `/local/project/settings` GET returns `prod_url`; POST accepts optional `prod_url`.

- [ ] **Step 1: Write the failing test**

Add to `tests/test_bridge.py`:

```python
def test_project_config_prod_url_roundtrip():
    from bridge import project_config
    project_config.set_prod_url("proj/pu", "https://app.example.com/")
    assert project_config.prod_url("proj/pu") == "https://app.example.com/"
    project_config.set_prod_url("proj/pu", "")     # blank clears
    assert project_config.prod_url("proj/pu") is None
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_bridge.py::test_project_config_prod_url_roundtrip -v`
Expected: FAIL — `AttributeError: module 'bridge.project_config' has no attribute 'set_prod_url'`.

- [ ] **Step 3: Write minimal implementation**

In `bridge/project_config.py`, add after `set_run_cmd` (after `bridge/project_config.py:58`):

```python
def prod_url(project: str) -> str | None:
    """The configured production/deployed URL for a project, or None if unset."""
    return get(project).get("prod_url") or None


def set_prod_url(project: str, url: str) -> str | None:
    """Persist (or clear, when blank) a project's production URL."""
    url = (url or "").strip()
    with _lock:
        data = _load()
        entry = data.get(project, {})
        if url:
            entry["prod_url"] = url
        else:
            entry.pop("prod_url", None)
        if entry:
            data[project] = entry
        else:
            data.pop(project, None)
        _save(data)
    return url or None
```

In `bridge/dashboard/server.py`, add `dev_port` to `/local/state` (the dict returned at `bridge/dashboard/server.py:156`):

```python
            return self._json({
                "project": {"rel": browser.rel(pd), "name": os.path.basename(pd)},
                "server": devserver.server_state(), "preview": tunnel.tunnel_state(),
                "dev_port": config.PREVIEW_PORT,
                "permission_mode": config.MINIAPP_PERMISSION_MODE})
```

Extend the settings GET response (the dict at `bridge/dashboard/server.py:256`):

```python
            return self._json({
                "scripts": project_config.package_scripts(abs_p),
                "run_cmd": project_config.run_cmd(rel),
                "prod_url": project_config.prod_url(rel),
                "default_cmd": config.START_CMD,
                "log_path": devserver.DEV_LOG_REL,
            })
```

The settings **POST** handler in `_post_api` currently reads (at `bridge/dashboard/server.py:375`):

```python
        if path == "/local/project/settings":
            rel = (body.get("project") or "").strip()
            if _abs_project(rel) is None:
                return self._json({"error": "invalid project"}, 400)
            cmd = project_config.set_run_cmd(rel, (body.get("run_cmd") or "")[:1000])
            return self._json({"ok": True, "run_cmd": cmd})
```

Replace it with (preserves the `[:1000]` cap; persists whichever keys are present):

```python
        if path == "/local/project/settings":
            rel = (body.get("project") or "").strip()
            if _abs_project(rel) is None:
                return self._json({"error": "invalid project"}, 400)
            out: dict = {"ok": True}
            if "run_cmd" in body:
                out["run_cmd"] = project_config.set_run_cmd(rel, (body.get("run_cmd") or "")[:1000])
            if "prod_url" in body:
                out["prod_url"] = project_config.set_prod_url(rel, (body.get("prod_url") or "")[:1000])
            return self._json(out)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_bridge.py::test_project_config_prod_url_roundtrip -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge/project_config.py bridge/dashboard/server.py tests/test_bridge.py
git commit -m "feat(settings): per-project prod URL + dev_port in state"
```

---

## Task 4: Screenshot targets the active source (validated)

**Files:**
- Modify: `bridge/dashboard/server.py` (add `_allowed_screenshot_url` module helper near `_worktree_path` at `bridge/dashboard/server.py:77`; use it in `_api_preview_screenshot` at `bridge/dashboard/server.py:566`)
- Test: `tests/test_bridge.py`

**Interfaces:**
- Consumes: `project_config.prod_url`, `config.PREVIEW_PORT`.
- Produces: module fn `_allowed_screenshot_url(url: str, dev_port: int, prod_url: str | None) -> bool`. `/local/preview/screenshot` accepts optional `url` in the body; when present it must pass validation, else 400; when absent it falls back to the tunnel (unchanged).

- [ ] **Step 1: Write the failing test**

Add to `tests/test_bridge.py`:

```python
def test_allowed_screenshot_url():
    from bridge.dashboard.server import _allowed_screenshot_url
    assert _allowed_screenshot_url("http://localhost:3000", 3000, None)
    assert _allowed_screenshot_url("http://127.0.0.1:3000/x", 3000, None)
    assert not _allowed_screenshot_url("http://localhost:9999", 3000, None)
    assert _allowed_screenshot_url("https://app.example.com/p", 3000, "https://app.example.com")
    assert not _allowed_screenshot_url("https://evil.example.com", 3000, "https://app.example.com")
    assert not _allowed_screenshot_url("file:///etc/passwd", 3000, None)
```

- [ ] **Step 2: Run test to verify it fails**

Run: `python -m pytest tests/test_bridge.py::test_allowed_screenshot_url -v`
Expected: FAIL — import error (`_allowed_screenshot_url` undefined).

- [ ] **Step 3: Write minimal implementation**

`urlparse` is **already imported** at `bridge/dashboard/server.py:26` (`from urllib.parse import parse_qs, urlparse`), and `git`/`browser`/`state`/`config`/`project_config` are already imported — no new imports needed.

Add the helper at module level (after `_worktree_path`, `bridge/dashboard/server.py:79`):

```python
def _allowed_screenshot_url(url: str, dev_port: int, prod_url: str | None) -> bool:
    """A screenshot target is allowed only if it is the local dev server
    (localhost/127.0.0.1 on dev_port) or the project's configured prod URL."""
    try:
        u = urlparse((url or "").strip())
    except ValueError:
        return False
    if u.scheme not in ("http", "https") or not u.hostname:
        return False
    if u.hostname in ("localhost", "127.0.0.1") and u.port == dev_port:
        return True
    if prod_url:
        p = urlparse(prod_url.strip())
        if (u.scheme == p.scheme and u.hostname == p.hostname
                and (u.port or None) == (p.port or None)):
            return True
    return False
```

Replace the whole `_api_preview_screenshot` (`bridge/dashboard/server.py:566-579`) with — only the target-resolution preamble is new; the width/capture/response tail is unchanged:

```python
    def _api_preview_screenshot(self, body: dict):
        chat = _chat()
        target = (body.get("url") or "").strip()
        if target:
            rel = browser.rel(state.project_dir(chat))
            if not _allowed_screenshot_url(target, config.PREVIEW_PORT,
                                           project_config.prod_url(rel)):
                return self._json({"error": "url not allowed"}, 400)
            url = target
        else:
            url = tunnel.tunnel_state().get("url")
        if not url:
            return self._json({"error": "preview not running"}, 409)
        try:
            width = int(body.get("width") or 375)
        except (TypeError, ValueError):
            width = 375
        try:
            png = screenshot.capture(url, width)
        except Exception as e:  # noqa: BLE001
            return self._json({"error": f"{type(e).__name__}: {e}"}, 500)
        data_url = "data:image/png;base64," + base64.b64encode(png).decode()
        return self._json({"data_url": data_url})
```

- [ ] **Step 4: Run test to verify it passes**

Run: `python -m pytest tests/test_bridge.py::test_allowed_screenshot_url -v`
Expected: PASS.

- [ ] **Step 5: Run the full backend suite**

Run: `python -m pytest tests/test_bridge.py -q`
Expected: PASS (no regressions).

- [ ] **Step 6: Commit**

```bash
git add bridge/dashboard/server.py tests/test_bridge.py
git commit -m "feat(preview): screenshot the active source URL, validated"
```

---

## Task 5: API client types + signatures

**Files:**
- Modify: `bridge/dashboard/web/src/api.ts`

**Interfaces:**
- Consumes: backend fields from Tasks 2–4.
- Produces: `SessionBrief.branch?: string`; `DashState.dev_port?: number`; `ProjectSettings.prod_url: string | null`; `api.setProjectSettings(project, { run_cmd?, prod_url? })`; `api.screenshot(width, url?)`.

- [ ] **Step 1: Add `branch` to `SessionBrief`**

In `bridge/dashboard/web/src/api.ts`, in `interface SessionBrief` (after `cwd?`):

```typescript
  cwd?: string | null; // run dir — a linked worktree differs from the project dir
  branch?: string; // the session's git branch (worktree branch, or the project's)
```

- [ ] **Step 2: Add `dev_port` to `DashState`**

In `interface DashState`:

```typescript
export interface DashState {
  project: Project | null;
  server: ServerInfo;
  preview: PreviewInfo;
  dev_port?: number; // local dev-server port (config.PREVIEW_PORT) for the preview window
  permission_mode?: string | null;
}
```

- [ ] **Step 3: Add `prod_url` to `ProjectSettings`**

```typescript
export interface ProjectSettings {
  scripts: Record<string, string>;
  run_cmd: string | null;
  prod_url: string | null;
  default_cmd: string;
  log_path: string;
}
```

- [ ] **Step 4: Change `setProjectSettings` + `screenshot` signatures**

Replace the `setProjectSettings` entry in the `api` object:

```typescript
  setProjectSettings: (project: string, patch: { run_cmd?: string; prod_url?: string }) =>
    req<{ ok: boolean; run_cmd?: string | null; prod_url?: string | null }>("/local/project/settings", {
      method: "POST",
      body: { project, ...patch },
    }),
```

Replace the `screenshot` entry:

```typescript
  screenshot: (width: number, url?: string) =>
    req<{ data_url: string }>("/local/preview/screenshot", { method: "POST", body: { width, url } }),
```

- [ ] **Step 5: Typecheck**

Run: `cd bridge/dashboard/web && npx tsc -b`
Expected: errors ONLY at the old `setProjectSettings(project, cmd)` call site in `DesignView.tsx` (fixed when `DesignView` is replaced in Task 11). If any other call site breaks, note it. (`DesignView` is deleted in Task 11, so a transient error there is acceptable; do not commit a broken build — proceed to Task 6+ which remove/replace `DesignView`.)

- [ ] **Step 6: Commit**

```bash
git add bridge/dashboard/web/src/api.ts
git commit -m "feat(api): session branch, dev_port, prod_url, source-aware screenshot"
```

---

## Task 6: Header branch follows the session + active-project sync

**Files:**
- Modify: `bridge/dashboard/web/src/App.tsx` (header `branch` prop at `App.tsx:514`; add `selectSession`; wire `ProjectsPanel`/`AnalyzeModal` `onSelectSession`)

**Interfaces:**
- Consumes: `SessionBrief.branch` (Task 5), `api.select`, `api.state`.
- Produces: `selectSession(s: SessionBrief): Promise<void>` — selects the session's project on the backend (when different) then opens the session.

- [ ] **Step 1: Add `selectSession`**

In `App.tsx`, after `openSession` (`App.tsx:131-137`):

```typescript
  async function selectSession(s: SessionBrief) {
    if (s.project !== activeProject) {
      try { await api.select(s.project); setState(await api.state()); } catch { /* ignore */ }
    }
    openSession(s.id);
  }
```

- [ ] **Step 2: Bind the header branch to the selected session**

The `Terminal` is rendered with `branch={activeBadge?.branch}` (`App.tsx:514`). Change it to:

```tsx
                  branch={selected?.branch}
```

(Leave `activeBadge`/`activeBadge?.dirty` usage elsewhere — StatusBar/run badge — untouched.)

- [ ] **Step 3: Wire `ProjectsPanel.onSelectSession`**

In the `<ProjectsPanel ... />` props (`App.tsx:533-542`), change:

```tsx
                  onSelectSession={(s) => void selectSession(s)}
```

- [ ] **Step 4: Wire `AnalyzeModal.onSelectSession`**

In `<AnalyzeModal ... />` (`App.tsx:556`), change:

```tsx
                onSelectSession={(s) => { void selectSession(s); setAnalyzeProject(null); setView("chat"); }}
```

- [ ] **Step 5: Typecheck**

Run: `cd bridge/dashboard/web && npx tsc -b`
Expected: no new errors from `App.tsx` (the `DesignView` error from Task 5 may persist until Task 11).

- [ ] **Step 6: Commit**

```bash
git add bridge/dashboard/web/src/App.tsx
git commit -m "fix(header): branch follows the selected session; sync active project on select"
```

---

## Task 7: ProjectsPanel uses `s.branch` (drop the worktrees fetch)

**Files:**
- Modify: `bridge/dashboard/web/src/components/hud/ProjectsPanel.tsx`

**Interfaces:**
- Consumes: `SessionBrief.branch` (Task 5).

- [ ] **Step 1: Remove the worktrees state, effect, and `branchForSession`**

In `ProjectCard` (`ProjectsPanel.tsx:48-84`), delete these (the `worktrees` `useState`, the `sessionCwds` line, the worktrees `useEffect`, and `branchForSession`):

```typescript
  const [worktrees, setWorktrees] = useState<Worktree[]>([]);
  // ...
  const sessionCwds = g.sessions.map((s) => s.cwd ?? "").join("|");
  useEffect(() => {
    if (!sessionCwds) return;
    let live = true;
    void api.worktrees(g.rel).then((w) => { if (live) setWorktrees(w.worktrees); }).catch(() => {});
    return () => { live = false; };
  }, [g.rel, sessionCwds]);

  function branchForSession(s: SessionBrief): string {
    const wt = worktrees.find((w) => w.path === s.cwd);
    return wt?.branch || badge?.branch || "main";
  }
```

- [ ] **Step 2: Render `s.branch` directly**

Replace the branch span content (`ProjectsPanel.tsx:133`):

```tsx
                      <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.branch || badge?.branch || "main"}</span>
```

- [ ] **Step 3: Drop the now-unused `Worktree` import**

In `ProjectsPanel.tsx:2`, remove `Worktree` from the type import (keep `GitBadge, SessionBrief, SessionStatus`):

```typescript
import type { GitBadge, SessionBrief, SessionStatus } from "../../api";
```

- [ ] **Step 4: Typecheck**

Run: `cd bridge/dashboard/web && npx tsc -b`
Expected: no new errors (the keep-list `api` import is still used elsewhere in the file — `api.branches`. If `api` became unused, remove it; it should NOT, branches picker still uses it).

- [ ] **Step 5: Commit**

```bash
git add bridge/dashboard/web/src/components/hud/ProjectsPanel.tsx
git commit -m "refactor(projects): use session.branch instead of a per-card worktrees fetch"
```

---

## Task 8: Crosshair cursor in the selector agent

**Files:**
- Modify: `tools/selector-plugin/src/agent.ts`
- Test: `tools/selector-plugin/test/agent.test.ts` (only if it already exercises `setMode`/install; otherwise skip the test step and rely on build + manual)

**Interfaces:**
- Produces: while `mode !== "idle"`, `win.document.body.style.cursor === "crosshair"`; restored to its prior value on `idle`.

- [ ] **Step 1: Inspect the agent's mode transitions**

Read `tools/selector-plugin/src/agent.ts`. Mode is set in three places: the `init` host message (`mode = d.mode ?? "idle"`), the `setMode` message (`if (msg.type === "setMode") mode = msg.mode`), and any `idle` reset. Add a single `applyCursor()` call after each mode assignment.

- [ ] **Step 2: Add the cursor helper + calls**

Inside `installAgent`, add near the top (after `let overlay ...`):

```typescript
  let savedCursor: string | null = null;
  function applyCursor() {
    const body = win.document.body;
    if (!body) return;
    if (mode !== "idle") {
      if (savedCursor === null) savedCursor = body.style.cursor;
      body.style.cursor = "crosshair";
    } else if (savedCursor !== null) {
      body.style.cursor = savedCursor;
      savedCursor = null;
    }
  }
```

Then call `applyCursor();` immediately after every line that assigns `mode` (the `init` handler's `mode = d.mode ?? "idle"`, the `setMode` handler's `mode = msg.mode`, and any `if (mode === "idle") moveOverlay(null)` block — add `applyCursor()` there too).

- [ ] **Step 3: Add the test**

`tools/selector-plugin/test/agent.test.ts` already imports `installAgent` and `HOST_SOURCE` and drives the agent via jsdom `MessageEvent`s on `window` (it seeds `document.body` in `beforeEach`). Add a new `it` (inside a `describe`, e.g. a new `describe("agent cursor", ...)`):

```typescript
it("sets a crosshair cursor while armed and restores it on idle", () => {
  installAgent(window);
  const send = (type: string, mode: string) =>
    window.dispatchEvent(new MessageEvent("message", {
      data: { source: HOST_SOURCE, nonce: "n1", type, mode },
      origin: "http://localhost",
    }));
  send("init", "idle");          // handshake: registers nonce "n1"
  send("setMode", "select");
  expect(document.body.style.cursor).toBe("crosshair");
  send("setMode", "idle");
  expect(document.body.style.cursor).toBe("");
});
```

(If the agent's `init` handler uses a field name other than `mode` for the initial mode, the `send("init", "idle")` still registers the nonce — only the nonce matters for the subsequent `setMode` to be accepted.)

- [ ] **Step 4: Run the selector tests**

Run: `cd tools/selector-plugin && npx vitest run`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/selector-plugin/src/agent.ts tools/selector-plugin/test/agent.test.ts
git commit -m "feat(selector): crosshair cursor while in select mode"
```

---

## Task 9: `FloatingWindow` chrome (drag + resize)

**Files:**
- Create: `bridge/dashboard/web/src/components/design/FloatingWindow.tsx`

**Interfaces:**
- Produces: `FloatingWindow({ storageKey, defaultRect, header, onClose, children })` — a fixed, non-modal panel; title bar drags to move (ignoring clicks on `button,input,select,a,[data-no-drag]`), a bottom-right handle resizes; position/size persisted to `localStorage[storageKey]`; clamped to the viewport with min `{w:360,h:300}`. `defaultRect: { x:number; y:number; w:number; h:number }`.

- [ ] **Step 1: Create the component**

Create `bridge/dashboard/web/src/components/design/FloatingWindow.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

export interface Rect { x: number; y: number; w: number; h: number; }
const MIN = { w: 360, h: 300 };

function clamp(r: Rect): Rect {
  const w = Math.max(MIN.w, Math.min(r.w, window.innerWidth));
  const h = Math.max(MIN.h, Math.min(r.h, window.innerHeight));
  return {
    w, h,
    x: Math.min(Math.max(0, r.x), Math.max(0, window.innerWidth - 80)),
    y: Math.min(Math.max(0, r.y), Math.max(0, window.innerHeight - 40)),
  };
}

function load(key: string, fallback: Rect): Rect {
  try {
    const v = JSON.parse(localStorage.getItem(key) || "");
    if (v && typeof v.x === "number" && typeof v.w === "number") return clamp(v);
  } catch { /* ignore */ }
  return clamp(fallback);
}

export function FloatingWindow({
  storageKey, defaultRect, header, onClose, children,
}: {
  storageKey: string;
  defaultRect: Rect;
  header: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  const [rect, setRect] = useState<Rect>(() => load(storageKey, defaultRect));
  const drag = useRef<{ mode: "move" | "resize"; sx: number; sy: number; r: Rect } | null>(null);

  useEffect(() => {
    try { localStorage.setItem(storageKey, JSON.stringify(rect)); } catch { /* ignore */ }
  }, [storageKey, rect]);

  const onMove = useCallback((e: PointerEvent) => {
    const d = drag.current; if (!d) return;
    const dx = e.clientX - d.sx, dy = e.clientY - d.sy;
    setRect(clamp(d.mode === "move"
      ? { ...d.r, x: d.r.x + dx, y: d.r.y + dy }
      : { ...d.r, w: d.r.w + dx, h: d.r.h + dy }));
  }, []);
  const onUp = useCallback(() => { drag.current = null; }, []);

  useEffect(() => {
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, [onMove, onUp]);

  const startMove = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button,input,select,a,textarea,[data-no-drag]")) return;
    drag.current = { mode: "move", sx: e.clientX, sy: e.clientY, r: rect };
  };
  const startResize = (e: React.PointerEvent) => {
    e.stopPropagation();
    drag.current = { mode: "resize", sx: e.clientX, sy: e.clientY, r: rect };
  };

  return (
    <div style={{ position: "fixed", left: rect.x, top: rect.y, width: rect.w, height: rect.h, zIndex: 60, display: "flex", flexDirection: "column", border: "1px solid rgba(127,233,216,.3)", background: "rgba(7,13,13,.94)", boxShadow: "0 18px 60px rgba(0,0,0,.55)" }}>
      <div onPointerDown={startMove}
        style={{ display: "flex", alignItems: "center", gap: 10, padding: "7px 10px", cursor: "move", flex: "none", borderBottom: "1px solid rgba(127,233,216,.15)", userSelect: "none" }}>
        {header}
        <button data-no-drag onClick={onClose} title="Close"
          style={{ marginLeft: "auto", appearance: "none", cursor: "pointer", border: "1px solid rgba(224,137,122,.4)", background: "transparent", color: "#e0897a", fontFamily: "inherit", fontSize: 11, lineHeight: 1, padding: "3px 8px" }}>✕</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {children}
      </div>
      <div onPointerDown={startResize} title="Drag to resize"
        style={{ position: "absolute", right: 0, bottom: 0, width: 16, height: 16, cursor: "nwse-resize", background: "linear-gradient(135deg,transparent 45%,rgba(127,233,216,.55) 45%)" }} />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd bridge/dashboard/web && npx tsc -b`
Expected: no new errors from `FloatingWindow.tsx` (it's not imported yet; `DesignView` error from Task 5 may persist until Task 11).

- [ ] **Step 3: Commit**

```bash
git add bridge/dashboard/web/src/components/design/FloatingWindow.tsx
git commit -m "feat(design): draggable/resizable FloatingWindow chrome"
```

---

## Task 10: `PreviewFrame` — hide Pin, crosshair in select mode

**Files:**
- Modify: `bridge/dashboard/web/src/components/design/PreviewFrame.tsx`

**Interfaces:**
- Consumes: `mode`/`onMode` (`"idle"|"select"|"pin"` from the selector controller — unchanged signature; only `idle`/`select` are used now).

- [ ] **Step 1: Remove the Pin button**

In `PreviewFrame.tsx`, delete the Pin `<button>` (`PreviewFrame.tsx:38-39`):

```tsx
        <button onClick={() => onMode(mode === "pin" ? "idle" : "pin")}
          className={`rounded px-2 py-1 ${mode === "pin" ? "bg-[var(--accent)] text-[var(--accent-foreground)]" : "bg-[var(--panel)]"}`}>Pin</button>
```

- [ ] **Step 2: Crosshair cursor on the preview container in select mode**

Update the scroll container div (`PreviewFrame.tsx:42-43`) to set the cursor:

```tsx
      <div ref={(el) => setContainerW(el?.clientWidth ?? 0)}
        className="relative flex-1 overflow-auto rounded border border-[var(--border)] bg-[var(--background)]"
        style={{ cursor: mode === "select" ? "crosshair" : "default" }}>
```

- [ ] **Step 3: Typecheck**

Run: `cd bridge/dashboard/web && npx tsc -b`
Expected: no new errors from `PreviewFrame.tsx`.

- [ ] **Step 4: Commit**

```bash
git add bridge/dashboard/web/src/components/design/PreviewFrame.tsx
git commit -m "feat(preview): hide Pin, crosshair cursor in select mode"
```

---

## Task 11: `ProjectRunBar` (extracted, controlled, + prod-URL field)

**Files:**
- Create: `bridge/dashboard/web/src/components/design/ProjectRunBar.tsx`

**Interfaces:**
- Produces: `ProjectRunBar({ project, cmd, onCmd, placeholder, prodUrl, onProdUrl, serverStatus, onStart, onStop, onSave, busy })` — presentational run controls (branch is shown in the window title bar, not here). `onStart()`/`onStop()`/`onSave()` are fire-and-forget handlers; `onCmd`/`onProdUrl` are controlled setters; `serverStatus: string`.

- [ ] **Step 1: Create the component (logic lifted from `DesignView.ProjectRunBar`, made controlled, tunnel kick dropped)**

Create `bridge/dashboard/web/src/components/design/ProjectRunBar.tsx`:

```tsx
const ctl = { appearance: "none" as const, cursor: "pointer", fontFamily: "inherit", flex: "none" as const };

export function ProjectRunBar({
  project, cmd, onCmd, placeholder, prodUrl, onProdUrl, serverStatus, onStart, onStop, onSave, busy,
}: {
  project: string | null;
  cmd: string;
  onCmd: (v: string) => void;
  placeholder: string;
  prodUrl: string;
  onProdUrl: (v: string) => void;
  serverStatus: string;
  onStart: () => void;
  onStop: () => void;
  onSave: () => void;
  busy: boolean;
}) {
  const running = serverStatus === "running";
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 12px", flexWrap: "wrap", flex: "none" }}>
      <span style={{ fontSize: 12, color: "#b9a6ff", fontFamily: "'JetBrains Mono',monospace", flex: "none" }}>$</span>
      <input value={cmd} onChange={(e) => onCmd(e.target.value)} placeholder={placeholder}
        spellCheck={false} disabled={!project} title="Start command — edit, then Save or Run"
        style={{ flex: 1, minWidth: 120, background: "rgba(7,13,13,.6)", border: "1px solid rgba(127,233,216,.18)", outline: "none", color: "#dff8f2", fontFamily: "'JetBrains Mono',monospace", fontSize: 12, padding: "6px 9px" }} />
      <input value={prodUrl} onChange={(e) => onProdUrl(e.target.value)} placeholder="https://deployed-url…"
        spellCheck={false} disabled={!project} title="Production URL — used by the 'deployed' source toggle"
        style={{ flex: 1, minWidth: 140, background: "rgba(7,13,13,.6)", border: "1px solid rgba(185,166,255,.2)", outline: "none", color: "#dff8f2", fontFamily: "'JetBrains Mono',monospace", fontSize: 12, padding: "6px 9px" }} />
      <button data-no-drag onClick={onSave} disabled={busy || !project} title="Save command + prod URL for this project"
        style={{ ...ctl, border: "1px solid rgba(127,233,216,.25)", background: "transparent", color: "#9fc7c0", fontSize: 9.5, letterSpacing: 1, padding: "6px 11px", opacity: busy || !project ? 0.4 : 1 }}>SAVE</button>
      {running ? (
        <button data-no-drag onClick={onStop} disabled={busy} title="Stop dev server"
          style={{ ...ctl, border: "1px solid #e0897a", background: "rgba(224,137,122,.12)", color: "#e0897a", fontSize: 10, letterSpacing: 1, padding: "6px 14px", opacity: busy ? 0.4 : 1 }}>STOP ■</button>
      ) : (
        <button data-no-drag onClick={onStart} disabled={busy || !project} title="Run this project's dev server"
          style={{ ...ctl, border: "1px solid #7fe9d8", background: "rgba(127,233,216,.12)", color: "#dff8f2", fontSize: 10, letterSpacing: 1, padding: "6px 14px", opacity: busy || !project ? 0.4 : 1 }}>RUN ▸</button>
      )}
      <span style={{ display: "inline-flex", alignItems: "center", gap: 5, flex: "none" }}>
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: running ? "#8fd9a8" : "#3c544f", animation: running ? "mpulse 2.4s infinite" : undefined }} />
        <span style={{ fontSize: 9, letterSpacing: 1, color: running ? "#8fd9a8" : "#3c544f" }}>{serverStatus.toUpperCase()}</span>
      </span>
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd bridge/dashboard/web && npx tsc -b`
Expected: no new errors from `ProjectRunBar.tsx` (not imported yet).

- [ ] **Step 3: Commit**

```bash
git add bridge/dashboard/web/src/components/design/ProjectRunBar.tsx
git commit -m "feat(design): controlled ProjectRunBar with prod-URL field"
```

---

## Task 12: `RunningWindow` + retire the design tab (wire it all up)

**Files:**
- Create: `bridge/dashboard/web/src/components/design/RunningWindow.tsx`
- Delete: `bridge/dashboard/web/src/components/design/DesignView.tsx`
- Modify: `bridge/dashboard/web/src/components/hud/ViewTabs.tsx`
- Modify: `bridge/dashboard/web/src/components/hud/Terminal.tsx`
- Modify: `bridge/dashboard/web/src/App.tsx`

**Interfaces:**
- Consumes: `FloatingWindow` (Task 9), `PreviewFrame` (Task 10), `ProjectRunBar` (Task 11), `useSelector`, `SelectionTray`, `composePrompt`, `api`.
- Produces: `RunningWindow({ project, branch, devPort, busy, onSubmit, onClose })`. `Terminal` gains `onOpenRunner?: () => void`. `View = "chat" | "history"`.

- [ ] **Step 1: Shrink `ViewTabs` to chat/history**

Replace `bridge/dashboard/web/src/components/hud/ViewTabs.tsx` entirely:

```tsx
export type View = "chat" | "history";

const LABELS: Record<View, string> = { chat: "CHAT", history: "HIST" };

/* Shared CHAT / HIST switcher in the Terminal header. */
export function ViewTabs({ view, onView }: { view: View; onView: (v: View) => void }) {
  return (
    <div style={{ display: "flex" }}>
      {(["chat", "history"] as const).map((v) => (
        <button key={v} onClick={() => onView(v)}
          style={{ appearance: "none", cursor: "pointer", border: `1px solid ${view === v ? "#7fe9d8" : "rgba(127,233,216,.16)"}`, background: view === v ? "rgba(127,233,216,.08)" : "transparent", color: view === v ? "#dff8f2" : "#3c544f", fontFamily: "inherit", fontSize: 9, letterSpacing: 1.5, padding: "3px 8px" }}>
          {LABELS[v]}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Create `RunningWindow`**

Create `bridge/dashboard/web/src/components/design/RunningWindow.tsx`:

```tsx
import { useEffect, useMemo, useRef, useState } from "react";
import { composePrompt } from "@selector/composePrompt";
import { api } from "../../api";
import { FloatingWindow } from "./FloatingWindow";
import { ProjectRunBar } from "./ProjectRunBar";
import { PreviewFrame } from "./PreviewFrame";
import { SelectionTray } from "./SelectionTray";
import { useSelector } from "./useSelector";

function basename(rel: string | null): string {
  if (!rel) return "—";
  const clean = rel.replace(/\/+$/, "");
  return clean.split("/").pop() || clean || "—";
}

export function RunningWindow({
  project, branch, devPort, busy, onSubmit, onClose,
}: {
  project: string | null;
  branch: string | null | undefined;
  devPort: number;
  busy: boolean;
  onSubmit: (text: string, images: string[]) => void;
  onClose: () => void;
}) {
  const [source, setSource] = useState<"localhost" | "deployed">("localhost");
  const [cmd, setCmd] = useState("");
  const [placeholder, setPlaceholder] = useState("npm run dev");
  const [prodUrl, setProdUrl] = useState("");
  const [serverStatus, setServerStatus] = useState("not started");
  const [busyRun, setBusyRun] = useState(false);
  const [width, setWidth] = useState(375);
  const [instruction, setInstruction] = useState("");
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Per-project settings: run command + prod URL.
  useEffect(() => {
    if (!project) { setCmd(""); setProdUrl(""); return; }
    let live = true;
    api.projectSettings(project).then((s) => {
      if (!live) return;
      setCmd(s.run_cmd ?? s.default_cmd);
      setPlaceholder(s.default_cmd || "npm run dev");
      setProdUrl(s.prod_url ?? "");
    }).catch(() => {});
    return () => { live = false; };
  }, [project]);

  // Dev-server status poll.
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try { const st = await api.state(); if (live) setServerStatus(st.server?.status ?? "not started"); }
      catch { /* ignore */ }
    };
    void tick();
    const id = setInterval(tick, 3000);
    return () => { live = false; clearInterval(id); };
  }, []);

  const localhostUrl = `http://localhost:${devPort}`;
  const activeUrl = source === "localhost" ? localhostUrl : (prodUrl || null);
  const origin = useMemo(() => {
    try { return activeUrl ? new URL(activeUrl).origin : null; } catch { return null; }
  }, [activeUrl]);

  // The selector only works against the dev server (the plugin is dev-only).
  const selectorOrigin = source === "localhost" ? origin : null;
  const sel = useSelector(iframeRef, selectorOrigin);

  const save = async () => {
    if (project) await api.setProjectSettings(project, { run_cmd: cmd, prod_url: prodUrl }).catch(() => {});
  };
  const start = async () => {
    if (!project) return;
    setBusyRun(true);
    try {
      await save();
      await api.select(project);        // dev-server cwd keys off the active project
      await api.server("start", cmd, project);
      setServerStatus("running");
      setSource("localhost");
    } catch { /* ignore */ } finally { setBusyRun(false); }
  };
  const stop = async () => {
    setBusyRun(true);
    try { await api.server("stop"); setServerStatus("exited"); } catch { /* ignore */ }
    finally { setBusyRun(false); }
  };

  const submit = async () => {
    if (!instruction.trim() || !sel.state.items.length) return;
    const text = composePrompt({ project, width, items: sel.state.items, instruction });
    let images: string[] = [];
    try {
      if (activeUrl) {
        const shot = await api.screenshot(width, activeUrl);
        if (shot.data_url) images = [shot.data_url];
      }
    } catch { /* text-only fallback */ }
    onSubmit(text, images);
    sel.clear();
    setInstruction("");
  };

  const header = (
    <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
      <span style={{ fontSize: 9, letterSpacing: 1, color: "#7fe9d8", border: "1px solid rgba(127,233,216,.4)", padding: "2px 7px", flex: "none" }}>RUNNING</span>
      <span style={{ fontSize: 11, color: "#dff8f2", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{basename(project)}</span>
      {branch && (
        <span style={{ display: "flex", alignItems: "center", gap: 4, flex: "none", fontSize: 9, color: "#a78bf0", border: "1px solid rgba(185,166,255,.28)", padding: "2px 7px" }}>
          <span style={{ color: "#b9a6ff" }}>⎇</span>{branch}
        </span>
      )}
      <span style={{ display: "flex", marginLeft: 6, flex: "none" }}>
        {(["localhost", "deployed"] as const).map((s) => (
          <button key={s} data-no-drag onClick={() => setSource(s)}
            disabled={s === "deployed" && !prodUrl}
            title={s === "deployed" && !prodUrl ? "Set a production URL in the run bar first" : `Show ${s}`}
            style={{ appearance: "none", cursor: "pointer", border: `1px solid ${source === s ? "#7fe9d8" : "rgba(127,233,216,.16)"}`, background: source === s ? "rgba(127,233,216,.08)" : "transparent", color: source === s ? "#dff8f2" : "#3c544f", fontFamily: "inherit", fontSize: 9, letterSpacing: 1, padding: "3px 8px", opacity: s === "deployed" && !prodUrl ? 0.4 : 1 }}>
            {s.toUpperCase()}
          </button>
        ))}
      </span>
    </div>
  );

  return (
    <FloatingWindow storageKey="mystical:runner"
      defaultRect={{ x: Math.max(20, window.innerWidth - 760), y: 90, w: 720, h: 560 }}
      header={header} onClose={onClose}>
      <ProjectRunBar project={project} cmd={cmd} onCmd={setCmd} placeholder={placeholder}
        prodUrl={prodUrl} onProdUrl={setProdUrl} serverStatus={serverStatus}
        onStart={() => void start()} onStop={() => void stop()} onSave={() => void save()} busy={busyRun} />
      <div style={{ height: 1, background: "rgba(127,233,216,.1)", flex: "none" }} />
      {!activeUrl ? (
        <div className="p-4 text-sm opacity-60" style={{ color: "#9fc7c0" }}>
          {source === "deployed" ? "No production URL set — add one in the run bar." : "Start the dev server to preview localhost."}
        </div>
      ) : (
        <div className="grid grid-cols-[1fr_300px] gap-3 p-3" style={{ flex: 1, minHeight: 0 }}>
          <PreviewFrame url={activeUrl} iframeRef={iframeRef} width={width} onWidth={setWidth}
            mode={sel.state.mode} onMode={sel.setMode} hoverLabel={sel.state.hoverLabel} />
          <div className="flex flex-col gap-2 overflow-y-auto">
            {source === "deployed" ? (
              <p className="text-xs opacity-60">Production preview — element selection needs the dev server (localhost).</p>
            ) : (
              <SelectionTray items={sel.state.items} onNote={sel.setNote} onRemove={sel.remove} />
            )}
            <textarea value={instruction} onChange={(e) => setInstruction(e.target.value)}
              placeholder="What should Claude change?" rows={3}
              className="w-full rounded border border-[var(--border)] bg-[var(--panel)] p-2 text-sm outline-none" />
            <button onClick={() => void submit()} disabled={busy || !instruction.trim() || !sel.state.items.length}
              className="rounded bg-[var(--accent)] px-3 py-2 text-sm font-medium text-[var(--accent-foreground)] disabled:opacity-40">
              Send to Claude
            </button>
          </div>
        </div>
      )}
    </FloatingWindow>
  );
}
```

- [ ] **Step 3: Add the PREVIEW button to the Terminal header**

In `bridge/dashboard/web/src/components/hud/Terminal.tsx`, add `onOpenRunner` to the prop type (after `sessionId?`):

```typescript
  sessionId?: string | null;
  onOpenRunner?: () => void;
```

Destructure it in the function params (add `onOpenRunner` to the list at the top of `Terminal({...})`).

Then in the header's right-side controls (`Terminal.tsx:163-168`), add the button before `<ViewTabs ... />`:

```tsx
        <div style={{ display: "flex", alignItems: "center", gap: 9, flex: "none" }}>
          <span style={{ fontSize: 9, letterSpacing: 1, color: surf.color, border: `1px solid ${surf.color}`, padding: "2px 7px" }}>
            {surf.label.toUpperCase()}
          </span>
          {onOpenRunner && (
            <button onClick={onOpenRunner} title="Open the running-project preview"
              style={{ appearance: "none", cursor: "pointer", border: "1px solid rgba(127,233,216,.3)", background: "rgba(127,233,216,.06)", color: "#bfe6de", fontFamily: "inherit", fontSize: 9, letterSpacing: 1.5, padding: "3px 8px" }}>
              ⊞ PREVIEW
            </button>
          )}
          <ViewTabs view={view} onView={onView} />
        </div>
```

- [ ] **Step 4: Wire `App.tsx` — state, button, window; remove the design view**

In `App.tsx`:

(a) The view state type (`App.tsx:68`) — drop `"design"`:

```tsx
  const [view, setView] = useState<"chat" | "history">("chat");
```

(b) Add runner state near the other UI state (after `App.tsx:79`):

```tsx
  const [runnerOpen, setRunnerOpen] = useState(false);
```

(c) Remove the `DesignView` import (`App.tsx:44`).

(d) Replace the center `view === "design" ? <DesignView .../> : <Terminal .../>` ternary (`App.tsx:503-529`) with just the `Terminal` (keep all its existing props), and add `onOpenRunner`:

```tsx
              {/* CENTER */}
              <Terminal
                view={view} onView={setView} selected={selected} sessionId={sessionId} activeProject={activeProject}
                branch={selected?.branch} model={model} turnCount={turns.length} turns={turns}
                activeId={active?.id ?? null} onRespond={(rid, o) => void respond(rid, o)} error={error}
                scrollRef={scrollRef} contentRef={contentRef}
                onOpenFromHistory={(s) => void openFromHistory(s)} liveTurns={liveTurns.current}
                trailingWorking={openWorking && !running} loading={loadingSession}
                onOpenRunner={() => setRunnerOpen(true)}
                composer={
                  <Composer
                    disabled={running || pendingCount > 0} running={running} model={model} effort={effort}
                    permissionMode={state?.permission_mode} injectedText={inject.text} injectNonce={inject.nonce}
                    contextTokens={contextTokens} resetLabel={resetLabel} onModel={setModel} onEffort={setEffort}
                    perm={permMode} onPerm={setPermMode} onSend={(t, i) => void send(t, i)} onStop={() => void stop()}
                    onCompact={() => void send("/compact", [])}
                  />
                }
              />
```

(e) Remove the `view-design` palette command (`App.tsx:399`).

(f) Render the window — add inside the `showDashboard` block, right after `<CommandPalette ... />` (`App.tsx:561`):

```tsx
            {runnerOpen && (
              <RunningWindow
                project={selected?.project ?? activeProject}
                branch={selected?.branch}
                devPort={state?.dev_port ?? 3000}
                busy={!!active}
                onSubmit={(text, images) => { void send(text, images); }}
                onClose={() => setRunnerOpen(false)}
              />
            )}
```

(g) Add the import near the other component imports (replacing the removed `DesignView` import):

```tsx
import { RunningWindow } from "./components/design/RunningWindow";
```

(h) Add Escape-to-close — in the keydown handler (`App.tsx:245-251`), add a branch (and `runnerOpen` to the dep array at `App.tsx:255`):

```tsx
      } else if (e.key === "Escape") {
        if (ctxMenu) setCtxMenu(null);
        else if (paletteOpen) setPaletteOpen(false);
        else if (runnerOpen) setRunnerOpen(false);
        else if (themeOpen) setThemeOpen(false);
        else if (settingsOpen) setSettingsOpen(false);
        else if (analyzeProject) setAnalyzeProject(null);
      }
```

- [ ] **Step 5: Delete `DesignView.tsx`**

```bash
git rm bridge/dashboard/web/src/components/design/DesignView.tsx
```

- [ ] **Step 6: Typecheck + build**

Run: `cd bridge/dashboard/web && npx tsc -b && npx vite build`
Expected: clean typecheck and a successful build (no remaining references to `DesignView`, `view === "design"`, or `setProjectSettings(project, cmd)`).

- [ ] **Step 7: Commit**

```bash
git add bridge/dashboard/web/src/components/design/RunningWindow.tsx \
        bridge/dashboard/web/src/components/hud/ViewTabs.tsx \
        bridge/dashboard/web/src/components/hud/Terminal.tsx \
        bridge/dashboard/web/src/App.tsx
git commit -m "feat(dashboard): floating running-project window replaces the DSGN tab"
```

---

## Task 13: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Backend tests**

Run: `python -m pytest tests/test_bridge.py -q`
Expected: PASS.

- [ ] **Step 2: Selector tests**

Run: `cd tools/selector-plugin && npx vitest run`
Expected: PASS.

- [ ] **Step 3: Frontend typecheck + build**

Run: `cd bridge/dashboard/web && npx tsc -b && npx vite build`
Expected: clean.

- [ ] **Step 4: Manual smoke (do NOT restart the bridge mid-session — open the freshly built dashboard)**

Verify:
1. Switch between a mystical-assistant session and an ibgroups session → the Terminal header branch flips to each session's real branch (no stale `sdlc`).
2. The right-panel session branches still render correctly.
3. Click `⊞ PREVIEW` → the floating window opens; drag it by the title bar; resize from the bottom-right; reload → it reopens at the same place/size.
4. Run the dev server; `localhost` source shows the app; enter Select mode → crosshair cursor; select an element → it appears in the tray; type an instruction → Send to Claude posts a turn.
5. Set a production URL, toggle to `deployed` → the iframe loads it and the tray shows the "needs the dev server" hint.

- [ ] **Step 5: Final commit (if any verification fixups were needed)**

```bash
git add -A
git commit -m "chore: verification fixups for the running-project window"
```

---

## Self-review notes (coverage map)

- Spec A1 (cached branch) → Task 1. A1 (`_session_brief.branch`) → Task 2. A2 (frontend bind) → Tasks 5–6. A3 (select sync) → Task 6. A4 (ProjectsPanel cleanup) → Task 7.
- Spec B1 (retire tab) → Task 12. B2 (FloatingWindow) → Task 9; (RunningWindow) → Task 12. B3 (source toggle + dev_port) → Tasks 3, 5, 12. B4 (PreviewFrame) → Task 10. B5 (prod URL) → Tasks 3, 5, 11. B6 (screenshot) → Tasks 4, 5, 12. B7 (agent cursor) → Task 8. B8 (button) → Task 12. B9 (orphan cleanup) → Tasks 11–12.
- Out-of-scope items (tunnel untouched, no checkout, Pin hidden-not-deleted) respected throughout.
