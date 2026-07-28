# Session-bound branch + floating running-project window

Two changes to the dashboard:

1. **Branch follows the session.** The Terminal header shows a stale branch (e.g.
   `sdlc` from another project) because it reads the *backend's* active project,
   which clicking a session never updates. Make branch a property of each session,
   and sync the active project when a session is selected.
2. **Floating running-project window.** Replace the `DSGN` view-tab with a button
   that opens a **non-modal, draggable, resizable** window showing the project's
   running app, with a **localhost ↔ deployed** source toggle, the element selector
   (Pin hidden) with a proper crosshair cursor, and the existing Send-to-Claude flow.

## What already exists (verified)

- **Header branch** is `branch={activeBadge?.branch}` in `App.tsx:514`, where
  `activeBadge = gitBadges.get(activeProject)` and `activeProject = state.project.rel`
  (`/local/state` → `state.project_dir(chat)`). `gitAll` (`/local/git/all`) keys
  badges by each session's logical `project` rel, computed with `git.badge(_abs_project(rel))`
  — i.e. the project's **main checkout** branch, never a worktree branch.
- **`openSession(id)`** (`App.tsx:131`) only sets local `sessionId`; it never calls
  `api.select`. `selectProject`/`openFromHistory` do select. So clicking a session
  in `ProjectsPanel` (`onSelectSession={(s) => openSession(s.id)}`) leaves the backend
  active project stale → wrong header branch.
- **`ProjectsPanel` already solves per-session branch**: `branchForSession(s)` fetches
  `api.worktrees(g.rel)` and maps `s.cwd → worktree.branch`, falling back to `badge.branch`.
  Sessions store an **absolute `cwd`** (worktree path, or the project dir) — set in
  `create_session` (`server.py` `/local/sessions` POST; `_worktree`).
- **`_session_brief`** (`bridge/miniapp/server.py:85`) returns
  `{id,title,project,updated,archived,origin,cwd}`. Shared by dashboard + miniapp.
- **`git.current_branch(cwd)`** = `git rev-parse --abbrev-ref HEAD` (subprocess).
  No caching today.
- **Design view**: `DesignView.tsx` is shown when `view==="design"` (`App.tsx:503`).
  It renders a VISUAL SELECTOR header + `ViewTabs` + `ProjectRunBar` (start/stop dev
  server, editable run command, kicks the tunnel) + body: `PreviewFrame`
  (device-width presets, **Select**/**Pin** mode buttons, scaled iframe of the
  **tunnel** URL `state.preview.url`) + `SelectionTray` + instruction + Send to Claude.
- **`ViewTabs`** (`View = "chat"|"history"|"design"`, labels CHAT/HIST/DSGN) lives in
  both the Terminal header and the Design header. Palette has a `view-design` command.
- **Selector**: parent-side `controller.ts` (aliased `@selector`, built with the
  dashboard) ↔ in-iframe `agent.ts` (injected by `vite-plugin-mystical-selector`,
  dev-only, installed in the *target* project). The agent draws a hover overlay box
  but **never sets a cursor**. `useSelector` exposes `mode: "idle"|"select"|"pin"`.
- **URL sources**: dev server runs on `config.PREVIEW_PORT` (default 3000, the port
  the tunnel forwards). `server_state()` returns `{status,cmd,dir,pid}` — **no port**.
  `tunnel_state()` returns `{url,port}`. There is **no** production-URL concept today.
- **Per-project settings**: `project_config.py` persists JSON keyed by project rel;
  today only `run_cmd`. `/local/project/settings` GET returns
  `{scripts,run_cmd,default_cmd,log_path}`; POST persists `run_cmd` only.
  `api.setProjectSettings(project, run_cmd)` — one caller (`ProjectRunBar`).
- **Screenshot**: `/local/preview/screenshot` captures `tunnel_state().url` via headless
  Chrome (`screenshot.capture(url, width)`). Only caller is `DesignView.submit`.
- **Frontend**: React 19 + Vite 6 + pnpm, hand-rolled inline styles, **no DnD/resize
  library**. Verification: `tsc -b` + `vite build`. Backend tests: `tests/test_bridge.py`.
- **Build/deploy caveat** (memory): the dashboard serves a prebuilt `web/dist`; rebuild
  via local bins (`pnpm build` can trip on esbuild); do not restart the bridge mid-session.

## Part A — Branch follows the session

### A1. Backend: branch in the session payload
- Add a small **TTL cache** (~3 s, module-level `dict[cwd] -> (branch, ts)`) around a new
  `git.current_branch` path — or a `current_branch_cached(cwd)` helper — so the 5 s
  `/sessions` poll (and miniapp) don't spawn one `git` per session. Many sessions share
  one cwd, so this collapses to a couple of calls per poll.
- In `_session_brief`, add `"branch": current_branch_cached(cwd) if cwd else ""`.
  Worktree sessions → their branch; plain sessions → the project's branch; missing cwd → `""`.

### A2. Frontend: consume it
- `SessionBrief` gains `branch?: string` (`api.ts`).
- Terminal header binds `branch={selected?.branch}` (`App.tsx:514`). `Terminal` already
  renders the `branch` prop; no change there. Flips immediately on session switch,
  independent of any round-trip.

### A3. Sync active project on session-select
- New `async function selectSession(s: SessionBrief)` in App: if `s.project !== activeProject`,
  `await api.select(s.project); setState(await api.state())`, then `openSession(s.id)`.
- Wire `ProjectsPanel.onSelectSession` and `AnalyzeModal.onSelectSession` to it (the latter
  also closes the modal + sets chat view, as today).
- Keeps preview/dev-server/git/header all pointed at the session's repo.

### A4. Cleanup (directly related)
- Remove `ProjectsPanel`'s `api.worktrees` fetch + `branchForSession`; render `s.branch`
  directly (fallback `g.badge?.branch || "—"`). One source of truth, one fewer request/card.
- `Worktree` import in ProjectsPanel drops if now unused.

## Part B — Floating running-project window

### B1. Retire the design view-tab
- `ViewTabs`: `View = "chat" | "history"`, labels `{chat:"CHAT", history:"HIST"}`.
- App: delete the `view==="design"` branch (always render `Terminal`), the `view-design`
  palette command, and the `DesignView` import.

### B2. `RunningWindow.tsx` (new) — floating, non-modal, draggable, resizable
Replaces `DesignView`'s role. Rendered at App root when `runnerOpen`. **Non-modal**
(no backdrop — usable while floating). Implementation: hand-rolled with pointer events,
no new deps.
- **Frame**: `position: fixed`, high z-index, min size (~`{w:360,h:300}`), clamped to the
  viewport. Position + size + chosen source persisted to `localStorage`
  (`mystical:runner` JSON), restored on open.
- **Move**: pointer-drag on the **title bar**. **Resize**: a corner handle (bottom-right)
  pointer-drag; optional edge handles. `pointerdown`/`pointermove`/`pointerup` with
  `setPointerCapture`.
- **Title bar**: project name + `⎇ branch`, the **localhost ↔ deployed** toggle, a close `✕`.
- **Run bar**: reuses `ProjectRunBar` logic (start/stop dev server, editable run command,
  SAVE/RUN/STOP, status dot) **plus** a production-URL input that persists via project
  settings. Drop the tunnel kick (`api.preview("start")`) — localhost is direct.
- **Body**: `PreviewFrame` (below) + `SelectionTray` + instruction textarea + Send to Claude
  (`submit()` unchanged except the screenshot target, B6).

### B3. Source toggle (localhost ↔ deployed)
- `localhost` = `http://localhost:${devPort}`. Expose `dev_port: config.PREVIEW_PORT` on
  `/local/state` (new top-level field). Selector works here.
- `deployed` = the project's configured **prod URL** (B5). **Preview-only**: the selector
  plugin is dev-only, so when source=deployed the selection tray is disabled with a hint
  ("Production preview — element selection needs the dev server"). Send-to-Claude naturally
  disabled (no items).
- Default source = `localhost`. If no dev server running, the run bar prompts to start it.
  If source=deployed and no prod URL set, show an inline input to set it.

### B4. `PreviewFrame` changes
- **Hide Pin**: remove the Pin button; only Select toggles `mode` between `idle`/`select`.
- **Crosshair (parent affordance)**: set `cursor: "crosshair"` on the iframe wrapper when
  `mode==="select"` (the real cross-content fix is B7).
- Iframe `src` = the active source URL. Device-width presets + scaling unchanged.

### B5. Per-project production URL
- `project_config.py`: add `prod_url(project) -> str | None` and `set_prod_url(project, url)`
  (mirror `run_cmd`/`set_run_cmd`, key `prod_url`).
- `/local/project/settings` GET adds `"prod_url": project_config.prod_url(rel)`. POST accepts
  optional `prod_url` (and still `run_cmd`); persist whichever keys are present.
- `api.ts`: `ProjectSettings` gains `prod_url: string | null`. Change
  `setProjectSettings(project, run_cmd)` → `setProjectSettings(project, { run_cmd?, prod_url? })`;
  update the one caller.

### B6. Screenshot follows the active source
- `/local/preview/screenshot` accepts an optional `url`; capture that instead of the tunnel
  when provided. Validate it against the allowed targets: `http://localhost:<dev_port>` or the
  active project's configured `prod_url` (reject anything else → 400). `RunningWindow.submit`
  passes the current source URL. Tunnel module untouched (Telegram `/preview` still uses it).

### B7. Crosshair cursor — the real fix
- In `tools/selector-plugin/src/agent.ts`: while `mode !== "idle"`, set
  `win.document.body.style.cursor = "crosshair"`; restore on `idle` (in the `setMode` handler
  and the `init` mode set). This ships in `vite-plugin-mystical-selector`; **target projects
  pick it up on their next dev-server start** (acceptable — the parent affordance in B4 covers
  the gap). Add/extend a controller/agent test if the existing suite covers `setMode`.

### B8. Button to open the window
- Terminal header: next to `ViewTabs`, a `⊞ PREVIEW` button calling `onOpenRunner`.
- App holds `runnerOpen` state; passes `onOpenRunner={() => setRunnerOpen(true)}` to `Terminal`;
  renders `<RunningWindow .../>` at root when open. Escape / `✕` close it.

### B9. Orphan cleanup
- Remove `DesignView.tsx` (refactored into `RunningWindow.tsx`). Keep `PreviewFrame`,
  `SelectionTray`, `useSelector`, `ProjectRunBar` (extract `ProjectRunBar` from `DesignView`
  into its own file or fold into `RunningWindow`). Remove now-dead `design` plumbing/imports.

## Testing & verification
- **Backend** (`tests/test_bridge.py`): `_session_brief` includes `branch`; `current_branch`
  TTL cache returns cached value within window; `/local/project/settings` round-trips `prod_url`;
  screenshot URL validation rejects a non-allowed host.
- **Frontend**: `tsc -b` + `vite build` clean. Selector unit tests still pass (agent cursor).
- **Manual**: switch between a mystical-assistant session and an ibgroups session → header branch
  flips correctly; open the window, toggle localhost/deployed, move + resize it, enter Select mode
  (crosshair), select an element, Send to Claude.

## Out of scope
- The tunnel stays as-is (other surfaces use it); the window doesn't depend on it.
- No git checkout on session-select (display + project-sync only).
- Pin mode is hidden, not deleted (agent still supports it).
