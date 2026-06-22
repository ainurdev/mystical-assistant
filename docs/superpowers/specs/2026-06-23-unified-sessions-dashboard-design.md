# Unified session store + per-project chats + desktop dashboard — Design

**Date:** 2026-06-23
**Status:** Draft (under adversarial review; pending user sign-off)
**Components:** `bridge/store.py` (new), `bridge/runner.py`, `bridge/state.py`,
`bridge/miniapp/server.py`, `bridge/miniapp/web/` (phone), `bridge/dashboard/`
(new server + second React app), `claude_telegram_bridge.py`, `bridge/config.py`

## 1. Goal

Three tightly-coupled changes, delivered together:

- **A · Shared session store** — a server-side SQLite store becomes the single
  source of truth for conversations (sessions → turns → events), written by every
  Claude run (interactive Mini App path and bot plain-text path).
- **B · Phone migration + per-project chats** — the Telegram Mini App reads/writes
  the store instead of `localStorage`; each **project** has its own chat thread(s)
  with a resumable Claude session; switching projects switches the transcript.
- **C · Desktop dashboard** — a second React app on a **localhost-only, never-tunneled**
  port: a full-parity desktop Claude client (pick project/session, send prompts +
  images, answer permission/AskUserQuestion cards, start/stop dev server & preview)
  **plus** live per-session/project Claude streams and dev-server logs side by side.

## 2. Non-goals

- No multi-user/tenant support; same `ALLOWED_CHAT_IDS` trust boundary for the phone,
  localhost trust for the dashboard.
- No Anthropic API usage; still the local `claude` CLI.
- No change to the permission/control protocol itself (it already works); we reuse it.
- No more than one concurrent Claude run (the single global `state.busy` lock stays).

## 3. Architecture

```
claude_telegram_bridge.py (one process)
├── Telegram long-poll loop                 (bot slash-commands + plain text)
├── Mini App HTTP server  127.0.0.1:8787    initData-authed; TUNNELED (public)
├── Dashboard HTTP server 127.0.0.1:8790    NO auth; localhost only; NEVER tunneled
├── runner: Claude runs  → journal events → store + pub/sub
├── store (sqlite)        sessions / turns / events  = source of truth
└── pub/sub broker        live fan-out of run events + dev-server log lines (SSE)
```

Key invariant: **only the Mini App port is tunneled.** The dashboard server is a
*separate* port that is never passed to `cloudflared`, so unauthenticated localhost
endpoints are not publicly reachable.

## 4. Data model (`bridge/store.py`, stdlib `sqlite3`)

DB file: `~/.bridge_state/bridge.db` (override `BRIDGE_DB`), mode 600, git-ignored
(outside repo). `PRAGMA journal_mode=WAL`. All access goes through one module-level
connection opened with `check_same_thread=False`, serialized by a single
`threading.Lock` (write volume is low; WAL lets the SSE readers read concurrently
when we use short-lived read connections — see §8).

```sql
CREATE TABLE sessions (
  id            TEXT PRIMARY KEY,         -- uuid4 hex
  chat_id       INTEGER NOT NULL,         -- owning Telegram user
  project       TEXT NOT NULL,            -- rel path under BASE_PATH ('' = base)
  claude_session_id TEXT,                 -- for `--resume`; null until first result
  title         TEXT,                     -- derived from first prompt (truncated)
  created       REAL NOT NULL,
  updated       REAL NOT NULL,
  archived      INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ix_sessions_proj ON sessions(chat_id, project, archived, updated);

CREATE TABLE turns (
  id          TEXT PRIMARY KEY,           -- == job_id of the live run
  session_id  TEXT NOT NULL REFERENCES sessions(id),
  seq         INTEGER NOT NULL,           -- 0-based within session
  prompt      TEXT NOT NULL,
  attachments TEXT NOT NULL DEFAULT '[]', -- json: [{name}] (no blobs persisted)
  status      TEXT NOT NULL,              -- running|done|error
  cost        REAL, elapsed INTEGER,
  started     REAL NOT NULL
);
CREATE INDEX ix_turns_session ON turns(session_id, seq);

CREATE TABLE events (
  session_id  TEXT NOT NULL,
  turn_id     TEXT NOT NULL,
  seq         INTEGER NOT NULL,           -- 0-based within session (monotonic)
  type        TEXT NOT NULL,
  payload     TEXT NOT NULL,              -- json of the compact event dict
  ts          REAL NOT NULL,
  PRIMARY KEY (session_id, seq)
);
```

`events.seq` is the **session-level cursor** the UIs poll/stream against (so a session's
whole transcript is one monotonic stream across turns — convenient for the dashboard).

Store API (sketch): `create_session(chat_id, project) -> Session`,
`list_sessions(chat_id, project) -> [Session]`, `get_session(id)`,
`latest_session(chat_id, project)`, `set_claude_session_id(id, sid)`,
`rename/auto_title`, `archive(id)`, `start_turn(session_id, job_id, prompt, attachments) -> seq`,
`append_event(session_id, turn_id, ev) -> seq`, `finish_turn(turn_id, status, cost, elapsed)`,
`transcript(session_id, cursor=0) -> {events, next_cursor, turns, session}`.

## 5. Runner changes (`bridge/runner.py`)

- `Job` gains `session_id` (the store session) distinct from `claude_session_id`.
- `start_streaming_job(chat_id, prompt, image_paths, project, job_id, session_id)`:
  resolves/creates the store session for `(chat_id, project)`; `start_turn(...)`;
  `--resume` uses `session.claude_session_id` (NOT `state.sessions[chat_id]`).
- Journaling: `Job.add(ev)` also calls `store.append_event(session_id, turn_id, ev)`
  **and** publishes to the pub/sub broker. Terminal `result` → `finish_turn(...)` and
  `set_claude_session_id(...)` from the captured Claude session id.
- `state.sessions` (chat→sid) is **removed**; resume continuity now lives in the store,
  keyed by session. The bot plain-text path resolves the latest (or a new) session for
  its active project and journals a single synthetic turn (its one-shot result becomes
  one `result` event) so the dashboard sees bot activity too.
- The in-memory `Job`/live snapshot stays for the active turn (low-latency polling);
  history for non-active turns is served from the store.

## 6. Mini App / server API changes (`bridge/miniapp/server.py`, phone web)

New endpoints (all initData-authed, same as today):

| Method/path | Action |
|---|---|
| `GET /api/sessions?project=` | list sessions for the user+project (id, title, updated, archived) |
| `POST /api/sessions` `{project}` | create a session → `{session}` |
| `GET /api/sessions/<id>?cursor=N` | transcript from the store (events[N:], turns, session) |
| `POST /api/sessions/<id>/archive` | soft-archive |
| `POST /api/run` `{session_id, prompt, images, project}` | now requires `session_id`; 409 if busy |
| `GET /api/run/<job>?cursor=`, `POST /api/run/<job>/respond` | unchanged (live turn) |

Phone web (`bridge/miniapp/web`): `ChatProvider` becomes **server-backed**.
- On load / project change: `GET /api/sessions?project=`; pick most-recent unarchived
  or create one; `GET /api/sessions/<id>` for the transcript (the `turns`/`events` now
  come from the store, not `localStorage`). `localStorage` is reduced to a small UX
  cache (draft text, last-open session id per project) — no longer the source of truth.
- `send()` posts `{session_id, project, prompt, images}`; the live turn still polls
  `/api/run/<job>` and renders the same `RunStream` cards (unchanged).
- Header gets a **session switcher** (list + "＋ New") scoped to the current project;
  the existing `FolderNavigator` still selects the project.
- "＋ New" → `POST /api/sessions`. Switching project loads that project's sessions.

Feature-1 preservation: `RunStream`, `PermissionCard`, `QuestionCard`, `Composer`,
the poll/respond loop, and the permission/question rendering are **unchanged**; only the
*source* of `turns`/`events` and the session selection move server-side.

## 7. Desktop dashboard (`bridge/dashboard/`)

### 7.1 Server (`bridge/dashboard/server.py`)
Own `ThreadingHTTPServer` on `127.0.0.1:DASH_PORT` (default 8790), started from the
entry point, **never tunneled**. No initData (localhost trust). Endpoints:

- Static: serve `bridge/dashboard/web/dist`.
- Read: `GET /local/projects`, `GET /local/sessions?project=`, `GET /local/sessions/<id>`
  (transcript), `GET /local/state` (server + preview + busy).
- **SSE (live):** `GET /local/stream/session/<id>` → backfill from store at `?cursor=`,
  then live events via pub/sub; `GET /local/stream/logs` → dev-server log lines live.
- Control (full parity): `POST /local/run` (`{session_id,project,prompt,images}`),
  `POST /local/run/<job>/respond`, `POST /local/server`, `POST /local/preview`,
  `POST /local/sessions`, `POST /local/select` — all reuse the same
  `runner`/`devserver`/`tunnel`/`store` functions as the Mini App.

### 7.2 Pub/sub broker (`bridge/pubsub.py`, small)
`subscribe(topic) -> Queue`, `publish(topic, item)`, `unsubscribe`. Topics:
`session:<id>` (run events) and `logs` (dev-server lines). The runner publishes each
journaled event; `devserver` publishes each new log line. SSE handlers backfill from the
store/deque, then drain their queue, writing `data: <json>\n\n` and flushing; client
disconnect surfaces as a write error → unsubscribe + close. (ThreadingHTTPServer gives
each SSE response its own thread, so long-lived streams don't block others.)

### 7.3 Second React app (`bridge/dashboard/web`, React+Vite+TanStack)
Desktop layout: **left sidebar** projects→sessions tree (live "running" badges);
**center** the chat/stream view (reuses the event/card renderer); **right or bottom**
the dev-server logs panel (live). Full-parity composer (prompt + images, answer
permission/question cards, stop run; server & preview controls). Uses `EventSource`
for the two SSE streams; its own (non-Telegram) theme.

Code sharing: extract the shared, framework-only pieces — `RunEvent`/`Question` types
and the `RunStream`/`PermissionCard`/`QuestionCard` renderers — into
`bridge/web-shared/` and reference it from both Vite apps via a `resolve.alias`
(`@shared`). Telegram-specific bits stay in the phone app. (Reviewers: confirm alias vs
a tiny local copy.)

## 8. Concurrency, threading, SSE

- **SQLite:** one shared connection, `check_same_thread=False`, WAL, guarded by a single
  write lock; SSE backfill uses a short-lived read-only connection so long polls don't
  hold the write lock. Low event volume makes this safe and simple.
- **Busy lock:** unchanged — phone, desktop, and bot all serialize on `state.busy`; a
  second run while busy returns 409 in both UIs. Answering a permission/question card is
  *not* a new run (it writes to the live process stdin), so it is never blocked by busy.
- **SSE lifecycle:** explicit flush after every frame; periodic `:keepalive\n\n` comment
  every ~15 s; unsubscribe + close on write error; cap subscribers per topic.

## 9. Config additions (`bridge/config.py`)

`DASH_ENABLE` (default 1), `DASH_PORT` (8790), `BRIDGE_DB`
(`~/.bridge_state/bridge.db`), `DASH_HOST` (127.0.0.1, fixed). Entry point starts the
dashboard server + prints `Dashboard: http://127.0.0.1:8790`.

## 10. Security

- Dashboard binds 127.0.0.1 and is **never** added to any tunnel; localhost is the trust
  boundary (the machine already runs Claude with the user's chosen permission posture).
- Mini App keeps initData HMAC + `ALLOWED_CHAT_IDS`; no new tunneled endpoints.
- Store file is mode 600 under `$HOME`, git-ignored; no image blobs persisted (only names).

## 11. Testing

- **Store unit:** session/turn/event CRUD, monotonic `seq`, transcript cursor, resume id
  set/get, archive, concurrent append under threads.
- **Runner:** journaling parity (every compact event lands in the store), `--resume`
  from session, bot path journaling.
- **Server:** new session endpoints; `/api/run` requires `session_id`; existing
  poll/respond/auth unchanged (existing tests still pass).
- **Dashboard:** SSE smoke (backfill + live frame + disconnect), control endpoints reuse
  tested runner; not-tunneled assertion (dashboard port absent from tunnel wiring).
- **Feature-1 regression:** phone chat still streams + renders permission/question cards
  after the server-backed migration (manual e2e on phone + a built-app smoke).
- **Build:** both Vite apps build; `@shared` resolves in both.

## 12. Build / tooling

Two Vite roots: `bridge/miniapp/web` and `bridge/dashboard/web`, each `npm ci && npm run
build` to its own `dist/` (both git-ignored). `bridge/web-shared/` holds shared TS.
Entry-point/README note updated with the dashboard build + URL.

## 13. Rollout (single change, internal order)

1. `store.py` + schema + unit tests. 2. `pubsub.py`. 3. Runner journaling + resume via
store (+ bot path). 4. Mini App session endpoints; migrate phone provider; per-project
sessions. 5. Dashboard server + SSE + control. 6. Dashboard React app. 7. Entry wiring.
8. Build both apps; manual e2e (phone + desktop). The bot's existing commands stay
behavior-preserving throughout.

## 14. Open questions / risks

- `@shared` alias across two Vite roots vs. a small duplicated renderer — pick during impl.
- SSE on `BaseHTTPRequestHandler`: confirm direct `wfile` streaming + flush works with the
  chosen Python; fall back to chunked cursor long-poll if a proxy buffers (none here).
- Bot one-shot journaling fidelity (it lacks per-tool events) — acceptable as a single
  result event.
- Busy-lock contention between desktop and phone is by design (one Claude at a time);
  both surface "busy".

## 15. Adversarial review — must-fix addendum (2026-06-23)

**Security (mandatory before the dashboard ships):**
- The dashboard is a no-auth control server → CSRF / DNS-rebinding exposure (any web
  page can POST to `127.0.0.1:8790`). Enforce on **every** `/local/*` request before any
  side effect: (1) **Host** allow-list `{127.0.0.1:DASH_PORT, localhost:DASH_PORT,
  [::1]:DASH_PORT}`; (2) **Origin/Referer** allow-list for state-changing requests; (3) a
  startup-generated **local secret token** embedded in the served dashboard HTML and
  required (custom header) on every `/local/*` call — cross-origin pages can't read it.
  Gate SSE/GET reads with Host too (they leak transcripts).
- `tunnel.start_tunnel()`: hard **deny-list** `DASH_PORT` and `MINIAPP_PORT`; validate
  range. Stops a CSRF `/local/preview {port: DASH_PORT}` from exposing the dashboard. Test it.
- WAL sidecars: `~/.bridge_state` mode 0700; `bridge.db` + `-wal` + `-shm` owner-only;
  assert at startup. `UPLOAD_DIR` stays git-ignored + deleted post-run.
- Tests: every `/api/*` (incl `/api/sessions*`) → 401 without initData; `/local/*` never
  bound on `MINIAPP_PORT`; only `MINIAPP_PORT`/preview port ever passed to the tunnel.

**Concurrency / SSE / store:**
- SQLite: fresh short-lived `connect()` per op (WAL + threadsafety=3) **or** lock *all*
  access on one shared conn. `busy_timeout=5000`, `synchronous=NORMAL`. Allocate
  `events.seq` atomically (`BEGIN IMMEDIATE; MAX(seq)+1; INSERT`).
- Journaling **off** the hot stdout loop: `Job.add` appends in-memory + enqueues; a
  dedicated journal thread does `append_event` + `publish`. Never block the pipe reader.
- SSE handler: headers (`text/event-stream`, `no-cache`, `Connection: close`,
  `X-Accel-Buffering: no`), force `close_connection`/HTTP-1.0 framing, socket write
  timeout, ~15 s keepalive; broker pushes a **shutdown sentinel** so blocked handlers wake
  (`block_on_close=True` would hang shutdown otherwise).
- Pub/sub: bounded queues (~512), non-blocking publish; on Full push one **resync**
  sentinel so the client re-fetches from the store at its cursor. Subscribe **first**,
  then backfill, dedupe by session `seq`.
- Busy lock: release on any exception between `acquire()` and thread start (store ops can
  now raise); regression test.

**Feature-1 chat migration (don't regress the committed chat):**
- Active turn stays **job-local** (job cursor); never seed it from the store; only
  historical turns load from store; define the completion hand-off.
- **Upsert** store turns by `turns.id` (==job_id); never blind-append (avoids double-render).
- Drop the `fresh` flag; "New"/`newChat` POSTs `/api/sessions` and switches `session_id`
  before send; `--resume` from `session.claude_session_id` (omit when null).
- Reconcile `markStale` vs store-says-running after a restart.

**Cross-references / contract (all-at-once):**
- `_base_cmd` gains a `claude_session_id` (or `Session`) param; `run_blocking` +
  `start_streaming_job` resolve the store session for `(chat_id, project)` first. Update
  the 4 existing `_base_cmd` tests.
- Remove `state.sessions` — 8 sites: `runner.py:53/99/424`, `dispatch.py:73/93/139`,
  `server.py:220/247`. Rewrite `/status` to read the store; update `/new`, `'use'`,
  `_api_select`, `_api_run('fresh')`.
- One canonical project key = `browser.rel(abs_dir)`; reconcile `''` vs `'/'` base across
  phone/bot/dashboard.
- Unified run contract `{session_id, project, prompt, images, model?, effort?}` on **both**
  `/api/run` and `/local/run` (model/effort + interrupt already exist in `runner.py`).
- Bot path: latest unarchived session per active project; generate `job_id`; `start_turn`
  before `run_blocking`, `finish_turn` + `set_claude_session_id` after.
- Session lifecycle: create, auto_title, rename, archive/unarchive, (optional) delete,
  empty-session policy — mirrored on `/api` and `/local`.
- `localStorage 'miniapp:chat:v1'`: import as read-only vs discard+clear (recommend
  one-time import, display-only — old chats have no saved `claude_session_id` to resume).
- `@shared`: add `resolve.alias` + tsconfig `paths` in **both** Vite roots, include
  `bridge/web-shared`; or duplicate the renderer. Decide before building.
- Wire dashboard server into `main()`/`_setup` + `_shutdown`; `web_built` 503 guard;
  `.gitignore` dashboard dist/node_modules + `~/.bridge_state`; update README + `__init__`
  docstring.
- SSE on `BaseHTTPRequestHandler` verified working on Python 3.14.4 (unbuffered `wfile`);
  keep chunked cursor long-poll as the fallback.

## 16. ⚠️ Coordination note (blocking)

At spec time the working tree had **large uncommitted WIP** (interrupt + model/effort +
shadcn/ui migration, ~18 modified files + new `src/components/ui/`, with its own spec
`2026-06-23-miniapp-interrupt-model-effort-shadcn-design.md`). That WIP edits the exact
files this feature rewrites (`runner.py`, `server.py`, `config.py`, `chat.tsx`, `api.ts`,
`root.tsx`, `run.tsx`). **Do not start implementation until that work is committed/stashed
or an isolation strategy is agreed**, to avoid clobbering in-progress changes.
