# Bridge enhancements — design

Date: 2026-06-24
Branch: `feat/unified-sessions-dashboard`

Five enhancements to the mystical-assistant bridge, built in this order (smallest /
lowest-risk first), each its own commit.

---

## ① Miniapp AI response → Markdown

**Problem.** `bridge/miniapp/web/src/components/Markdown.tsx` exists and the `.md`
styles are in `index.css`, but the miniapp's `RunStream.tsx` still renders assistant
`text` events and the `FinalResult` body as `whitespace-pre-wrap` plain text. The
dashboard `RunStream.tsx` already wraps both in `<Markdown>`.

**Change.** Mirror the dashboard: wrap the `text` event render and the `FinalResult`
body in `<Markdown>`, reusing the existing `.md` styles. Frontend only.

Files: `bridge/miniapp/web/src/components/RunStream.tsx`.

---

## ② Per-project issues → feed to Claude

**Current.** `bridge/github.py` + dashboard `IssuesTab.tsx` + `/local/github/issues`
already list a repo's open issues per project via `gh`. The miniapp has no issues view.

**Change.**
1. **Feed to Claude action** on each issue: composes a prompt
   `Work on issue #N — <title>\n\n<body>\n\n<url>` and starts a run in that project's
   session (same path the composer uses to start a run).
2. **Miniapp parity:** add a compact issues list to the miniapp with the same action.

Files: dashboard `IssuesTab.tsx`, dashboard `api.ts`/run-start; miniapp new issues
view + `lib/api`, `bridge/miniapp/server.py` (issues endpoint, mirrors dashboard).

---

## ③ Background-jobs monitor (Claude background jobs)

**Current.** `/local/running` + `/api/running` return `{external, bridge_running,
awaiting}`, but `bridge_running` is just session IDs. The rich live state (current
tool, elapsed, pending) lives in the in-memory `runner._jobs` registry (max 20) and
is not exposed. `RunningNow.tsx` (miniapp) and `SessionsPanel.tsx` (dashboard) render
the thin shape.

**Change.**
1. **Enrich the running payload**: add a `jobs` array where each running bridge job
   carries `{session_id, project, title, model, started, activity, prompt_preview}`,
   sourced from `runner._jobs` joined with the store. New helper in `runner.py`
   (e.g. `running_jobs()`), surfaced through both `/running` endpoints.
2. **Monitor panel** in both clients: a "BACKGROUND JOBS" list with per-job elapsed
   timer, current activity / "awaiting you", tap-to-open. Reuses the existing 3–4s
   poll. Scope: the bridge's own Claude runs + already-available external sessions.

Files: `bridge/runner.py`, `bridge/dashboard/server.py`, `bridge/miniapp/server.py`,
dashboard + miniapp running components and API types.

---

## ④ Per-project run settings from package.json + logs Claude can read

**Current.** Dev server runs a global `config.START_CMD` (`npm run dev`), logs to an
in-memory `deque(maxlen=300)`, nothing on disk — so a Claude session cannot read the
dev logs. No `package.json` is read anywhere; no per-project config exists.

**Change, three parts.**
1. **Settings:** parse a project's `package.json` `scripts`; expose them as choices;
   persist the chosen run command per project in a new small JSON-file config store
   keyed by project path (`bridge/project_config.py`, file under the bridge state dir).
2. **Logs to disk:** `devserver` tees its output to a stable file
   `<project>/.mystical/dev.log` (gitignored), in addition to the live deque.
3. **Easy Claude access:** the log file sits in the project cwd, so a Claude session
   can `Read .mystical/dev.log`. The path is surfaced to the session via an appended
   system-prompt note so Claude knows where to look. (On-disk file beats an MCP/HTTP
   channel — no new moving parts, works with the existing cwd-based runner.)

Files: new `bridge/project_config.py`, `bridge/devserver.py`, `bridge/config.py`,
both `server.py` (settings + package.json endpoints), `bridge/runner.py` (system-prompt
note), settings UI in both clients.

---

## ⑤ Compact current context

**Constraint.** Maps to Claude Code's `/compact`. The streaming control channel only
supports user-message / interrupt / control-response; there is **no evidence** the
headless CLI honors a `/compact` slash command over stream-json stdin.

**Change.**
1. **Spike first:** send `/compact` as a user message to a resumed streaming session
   and observe the result. Report before building.
2. If honored → add a "Compact" action that sends it on the current session.
   If not → fallback: summarize prior turns into a seed for continuing the session.

Files: `bridge/runner.py`, both `server.py` (compact endpoint), compact action in both
clients.

---

## Testing

- Backend: pytest under `tests/` (existing `test_github.py`, `test_native.py`, etc.).
  Add unit tests for package.json script parsing and the devserver log-file tee.
- Frontend: build both web clients (`npm --prefix … run build`) to typecheck.
