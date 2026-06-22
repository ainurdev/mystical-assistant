# Telegram Mini App for the Claude Code Bridge — Design

**Date:** 2026-06-22
**Status:** Approved (pending spec review)
**Component:** `claude_telegram_bridge.py` → refactored `bridge/` package + new `bridge/miniapp/`

## 1. Goal

Add a Telegram **Mini App** (Web App) to the existing Claude Code Telegram bridge: a
full control panel, openable from the phone, that lets the user

- pick the active project,
- type a prompt **and attach screenshots**, send it to the local Claude Code, and
  watch Claude's progress **stream live**, then read the final reply,
- start/stop the project's dev server and view its logs,
- start/stop the public preview tunnel and open the link.

In the same change, **refactor** the 500-line single-file bot into a focused
`bridge/` package so the Mini App and the bot share one implementation.

## 2. Non-goals

- No Anthropic API usage. Everything runs the local `claude` CLI with the user's
  Claude Code subscription login (unchanged from today).
- No multi-user / multi-tenant support. Access is locked to `ALLOWED_CHAT_IDS`.
- No persistent database. Jobs and state live in memory (same as today).
- No named-tunnel / custom-domain setup; quick tunnels only. **(Superseded for
  `/preview` — it now uses a stable named tunnel: see
  `2026-06-22-preview-named-tunnel.md`. The Mini App panel tunnel is still a quick
  tunnel.)**

## 3. Decisions (from brainstorming)

| Decision | Choice |
|---|---|
| App scope | **Full control panel** (project, prompt+screenshots, server, logs, preview) |
| Hosting | **cloudflared quick tunnel**, started on launch; menu button auto-updated |
| Progress | **Live progress stream** (`--output-format stream-json`) |
| Auth | Validate Telegram signed `initData` (HMAC-SHA256 w/ bot token) + `ALLOWED_CHAT_IDS` |
| Frontend | **React + Vite + TanStack (Router + Query)**, built to static assets served by the bot |
| Backend | Python **stdlib only** (`http.server.ThreadingHTTPServer`); images as base64 JSON |
| Slash commands | Kept as-is (additive; the app does not remove them) |

## 4. Architecture

One process, three concurrent parts:

```
claude_telegram_bridge.py (entry point)
├── Telegram long-poll loop      (existing; slash-commands)
├── HTTP server thread (NEW)     ThreadingHTTPServer on 127.0.0.1:MINIAPP_PORT (8787)
│     serves index.html + /api/* JSON
└── Mini-app tunnel (NEW)        cloudflared quick tunnel → HTTP server, on launch;
                                  URL pushed to Telegram menu button
```

Shared in-memory state (`_sessions`, `_active`, dev-server, tunnels, `_busy`) is the
**same** objects the bot uses, so an action in the app is reflected for the bot and
vice-versa.

### 4.1 Module layout (refactor)

```
bridge/
  __init__.py
  config.py     # all env vars + constants (TOKEN, BASE_PATH, ALLOWED_CHAT_IDS, ports, prompts)
  telegram.py   # tg(), send(), edit(), answer_cb(), typing(), get_updates()
  browser.py    # list_dirs(), within_base(), rel(), browser_view()
  state.py      # shared mutable state + locks (_sessions, _active, _busy, registries)
  runner.py     # Claude runner: run_blocking() (json) + run_streaming() (stream-json) + Job manager
  devserver.py  # start_server(), stop_server(), server_status(), log buffer
  tunnel.py     # quick-tunnel helpers (reused for preview AND the miniapp)
  dispatch.py   # on_message(), handle_callback()  (behavior identical to today)
  miniapp/
    server.py   # HTTP routing, initData auth, JSON handlers, job polling, static serving
    web/        # React + Vite + TanStack source (built to web/dist/, served by server.py)
      index.html, vite.config.ts, package.json, src/…
claude_telegram_bridge.py  # thin: build config, start miniapp, run Telegram loop
```

Refactor rule: **behavior-preserving**. The bot's commands must work exactly as
today after the split (verified by manual command pass + smoke tests).

## 5. Backend HTTP API

Server: `http.server.ThreadingHTTPServer`, bound to `127.0.0.1:8787` (only reachable
via the cloudflared tunnel, never directly public). JSON in/out.

**Auth (every `/api/*` request):** the client sends `X-Telegram-Init-Data: <initData>`.
The server:
1. parses the init-data query string, extracts `hash`,
2. builds `data_check_string` = sorted `key=value` lines (excluding `hash`), `\n`-joined,
3. `secret = HMAC_SHA256(key="WebAppData", msg=BOT_TOKEN)`,
4. `calc = HMAC_SHA256(key=secret, msg=data_check_string).hexdigest()`,
5. rejects (`401`) unless `calc == hash`,
6. rejects (`403`) unless `auth_date` is fresh (≤ 24h) and `user.id ∈ ALLOWED_CHAT_IDS`.

The validated `user.id` is the chat_id used for session/state keys.

| Method / path | Body / query | Action |
|---|---|---|
| `GET /` + `/assets/*` | — | serve built `web/dist/` (SPA: unknown non-`/api` paths → `index.html`) |
| `GET /api/state` | — | `{project, server, preview_url, busy}` |
| `GET /api/projects` | `?dir=` | list folders under `BASE_PATH` (same rules as browser) |
| `POST /api/select` | `{dir}` | set `_active[chat]`, reset session |
| `POST /api/run` | `{prompt, images:[dataURL], project?}` | start a streaming run → `{job_id}`; `409` if `_busy` |
| `GET /api/run/<job_id>` | `?cursor=N` | `{events:[…from N], status, result?, cost?, session_id?}` |
| `POST /api/server` | `{action, cmd?}` | start/stop dev server (reuses `devserver`) |
| `GET /api/logs` | `?n=` | dev-server log tail |
| `POST /api/preview` | `{action, port?}` | start/stop preview tunnel (reuses `tunnel`) |

All handlers reject non-allowed users before any side effect. Paths outside the table → `404`.

## 6. Streaming + job model (`runner.py`)

`POST /api/run` creates a `Job(job_id, chat_id)` and spawns:

```
claude -p <full_prompt> --output-format stream-json --verbose
       [--resume <session_id>] --append-system-prompt <ASK_PROMPT>
       --dangerously-skip-permissions   (from EXTRA_CLAUDE_ARGS)
```

(run in `project_dir(chat)`). A reader thread parses each stdout JSON line into a
compact event appended to `job.events`:

- assistant `text` block → `{type:"text", text}`
- assistant `tool_use` → `{type:"tool", name, summary}` (e.g. `Bash: npm test`, `Edit: a.ts`)
- user `tool_result` → `{type:"tool_done"}`
- terminal `result` → set `job.result`, `job.session_id`, `job.cost`, `job.status="done"`

`GET /api/run/<job_id>?cursor=N` returns `job.events[N:]` + status; the app advances
its cursor each poll (~1.5s). On `done`, `_sessions[chat]=session_id` so the
conversation continues across both app and bot. Errors → `job.status="error"` with a
message event.

Concurrency: runs acquire the existing `_busy` lock. A second run while busy →
`/api/run` responds `409` and the app surfaces "busy."

Job lifetime: kept in an in-memory dict; trimmed to the last N (e.g. 20) jobs.

## 7. Screenshots → Claude

The app encodes each attached image as a base64 data URL and includes them in the
`/api/run` body. The server:
1. decodes to `BASE_PATH/.bridge_uploads/<job_id>/shotK.<ext>` (ext from MIME),
2. prepends to the prompt:
   `"The user attached screenshot(s); view them before responding: <abs1>, <abs2>\n\n"`,
3. Claude reads them via its Read tool (native PNG/JPG support),
4. the per-job upload dir is removed after the job completes.

Limits: max ~8 images, max ~10 MB each (rejected with `413` otherwise).
`.bridge_uploads/` is git-ignored.

## 8. Frontend (`miniapp/web/` — React + Vite + TanStack)

A Vite + React + TypeScript app using **TanStack Router** (tabs as routes) and
**TanStack Query** (data fetching + polling). Built with `npm run build` to
`web/dist/`, which `server.py` serves as static assets (Vite `base: '/'`). The
`index.html` template loads `https://telegram.org/js/telegram-web-app.js`.

On boot: `WebApp.ready()`/`expand()`, capture `WebApp.initData`, derive CSS variables
from `WebApp.themeParams` for dark/light. A shared `fetch` wrapper injects the
`X-Telegram-Init-Data` header on every request; a typed API client wraps the
endpoints. TanStack Query handles polling (`refetchInterval`) for the live run
stream and the server logs.

Three tabs (TanStack Router routes):

- **Run** — a compact **folder navigator** at top (shows the current dir's
  subfolders, tap to enter, "Use this folder" to select), backed by
  `/api/projects?dir=` + `/api/select` — mirrors the bot's browser and handles the
  nested `<org>/<repo>` layout; the chosen project is shown as a header chip. Then
  prompt `<textarea>`; 📎 file input (`accept=image/*`, multiple) with removable
  thumbnails; **Send**. Below: a live stream pane rendering events as they arrive,
  then the final reply with `time · $cost`.
- **Server** — command input (default `npm run dev`), Start/Stop, status, log tail
  (auto-refresh while tab active).
- **Preview** — port input, Start/Stop, shows public URL with Open + Copy.

Every request carries `X-Telegram-Init-Data`. Polling only while a job is running or
the active tab needs it.

## 9. Tunnel + menu button wiring

On launch, after `getMe`:
1. start the HTTP server thread on `127.0.0.1:8787`,
2. start a cloudflared quick tunnel to it, capture the `*.trycloudflare.com` URL
   (reuses `tunnel.py`; this is a second, always-on tunnel distinct from `/preview`),
3. call `setChatMenuButton` for each allowed chat:
   `menu_button = {type:"web_app", text:"🛠 Open Panel", web_app:{url:<tunnel_url>}}`,
4. also add a `/app` command that replies with an inline `web_app` button to the
   current URL (fallback if the menu button is stale).

On shutdown, stop the miniapp tunnel alongside the others.

## 10. Config / env additions (`config.py`)

| Var | Default | Meaning |
|---|---|---|
| `MINIAPP_PORT` | `8787` | local bind port for the HTTP server |
| `MINIAPP_ENABLE` | `1` | toggle the Mini App on/off |
| `UPLOAD_MAX_MB` | `10` | per-image size cap |
| `UPLOAD_MAX_COUNT` | `8` | images per prompt |

Existing vars unchanged. `run.sh` needs no edits (defaults work); it stays
git-ignored because it holds the token.

## 11. Security

- initData HMAC validation + `ALLOWED_CHAT_IDS` on **every** API call (same trust
  boundary as the bot's chat-id gate).
- HTTP server binds `127.0.0.1` only; the sole ingress is the cloudflared tunnel.
- The tunnel URL is unguessable but **not** a secret — auth is what protects it; an
  unauthenticated request gets `401/403` and does nothing.
- `run.sh` (token) and `.bridge_uploads/` are git-ignored; `.gitignore` added.
- Same `--dangerously-skip-permissions` posture as chosen for the bot; the app does
  not widen it.

## 12. Testing

- **Unit:** initData validation (valid/invalid hash, stale auth_date, disallowed
  user); stream-json event parsing (text/tool_use/tool_result/result fixtures);
  base64 image decode + path building; project listing within `BASE_PATH`.
- **Refactor safety:** import smoke test (`python -m py_compile` across the package);
  a behavior checklist for each slash-command after the split.
- **Manual end-to-end (phone):** open panel from menu button → pick project →
  prompt + screenshot → watch live stream → final reply; server start/logs; preview
  start/open.

## 13. Rollout / build order

1. Refactor the single file into `bridge/` (behavior-preserving), verify bot works.
2. Add `runner.py` streaming (`run_streaming` + Job) behind the existing bot path
   first (json) so shared logic is proven.
3. Add `miniapp/server.py` (auth + state/projects/select/logs first — read paths).
4. Add `/api/run` streaming + screenshots.
5. Build the React + Vite + TanStack app (Run → Server → Preview tabs); `npm run build`
   to `web/dist/`, served by `server.py`.
6. Wire tunnel + menu button in the entry point.
7. Manual e2e on the phone.

> Build note: the Mini App requires `npm --prefix bridge/miniapp/web ci && npm --prefix
> bridge/miniapp/web run build` before first run; `web/node_modules` and `web/dist` are
> git-ignored.
