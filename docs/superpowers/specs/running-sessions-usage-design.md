# Machine-wide running sessions + Claude usage box

Two surgical additions to both clients (Mini App + desktop dashboard): a
"Running now" view of every Claude session on this host, and a usage/reset strip
in the composer. Existing flows untouched.

## Data sources (verified on this machine, 2026-06-23)

1. **Running sessions** → `~/.claude/sessions/<pid>.json`. Each interactive
   client writes one file: `sessionId, pid, cwd, startedAt` (epoch **ms**),
   `kind`, `entrypoint`, and — **only for `entrypoint=cli`** — `status`
   (`idle`/`waiting`) + `waitingFor`. Liveness is exact: `os.kill(pid, 0)`.
2. **Usage** → `GET https://api.anthropic.com/api/oauth/usage` with the local
   OAuth token (`~/.claude/.credentials.json` → `claudeAiOauth.accessToken`) and
   header `anthropic-beta: oauth-2025-04-20`. Returns `five_hour`/`seven_day`
   `{utilization, resets_at}` and a `limits[]` array with `percent`/`severity`.

### Corrections to the original proposal (found during verification)

- **The registry does NOT contain the bridge's own `claude -p` runs.** Every
  record is `kind=interactive` / `entrypoint ∈ {cli, claude-vscode}`. The bridge
  spawns `claude -p` via `subprocess.Popen` (runner.py) and those never register.
  So the two halves cover **disjoint** sets: registry = external sessions
  (VS Code + terminal); store = bridge runs.
- **`status`/`waitingFor` exist only for the terminal CLI entrypoint.** VS Code
  rows are presence-only (no working/waiting indicator).
- Usage buckets carry `utilization` (a float), not `percent`; we round it and
  attach the matching `limits[].severity`.

## Backend (stdlib only)

- `bridge/machine.py` — `list_running()`: glob the registry, drop dead PIDs,
  normalize each record to `{session_id, pid, project, cwd (home-shortened),
  source ∈ vscode|cli|sdk, started (epoch s), status, waiting_for}`, newest first.
- `bridge/usage.py` — `get_usage()`: read+validate the token (short-circuits an
  expired `expiresAt`), call the endpoint, normalize to `{available, five_hour,
  seven_day, limits}` with a 60s cache. The token never leaves the process; any
  failure → `{available: False}`.
- `store.running_session_ids(chat_id)` — sessions with an in-flight (`running`)
  turn; drives the badge.

## Endpoints

| Mini App (Telegram-authed) | Dashboard (Host+token-gated) | Returns |
|---|---|---|
| `GET /api/running` | `GET /local/running` | `{external: RunningSession[], bridge_running: string[]}` |
| `GET /api/usage`   | `GET /local/usage`   | `UsageInfo` |

## Frontend (both clients)

- **Composer** — slim `UsageStrip`: `5h 31% · resets 6:49 AM · Wk 52%`, colored
  by severity, hidden when unavailable. Polls 60s.
- **"Running now" panel** — this chat's live bridge runs (tappable → open that
  chat) then read-only external rows (project • source • started/waiting). Polls
  4s. Mini App: top of the Run tab. Dashboard: top of the sidebar.
- **Running badge** — a dot (dashboard sidebar) / `●` prefix (Mini App session
  picker) on store sessions whose latest turn is running. This is the
  "prompt on phone → dashboard shows it running" signal.

## Security

Usage computes server-side only — no token reaches any client. `/api/*` keep the
Telegram trust boundary; `/local/*` keep the Host/Origin/token gates. The Mini
App is public-tunneled, so it surfaces the user's own project names + usage % to
their phone (cwd is home-shortened); no secrets.

## Trade-offs

- Registry + PID over `/proc` scraping or mtime heuristics → canonical and exact.
- Separate "Running now" panel rather than merging external sessions into the
  store-backed lists → external sessions have no transcript to open.
- Polling over SSE for running/usage → cheap to compute, simplest.
