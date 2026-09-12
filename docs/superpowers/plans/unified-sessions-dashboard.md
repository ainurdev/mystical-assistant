# Unified Session Store + Per-Project Chats + Desktop Dashboard — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a server-side SQLite store the single source of truth for Claude
conversations (sessions→turns→events), migrate the Telegram Mini App onto it with
per-project chats, and add a localhost-only desktop dashboard (second React app) that is
a full-parity Claude client plus live per-session/project log streaming.

**Architecture:** One process, two HTTP servers. The Mini App server (`:8787`, initData
auth, tunneled) and a new dashboard server (`:8790`, localhost-only, **never tunneled**,
defended against CSRF/DNS-rebinding) both read/write a shared `bridge/store.py` (sqlite).
The runner journals every event to the store **off the hot stdout loop** via a journal
queue + thread, and publishes to an in-process pub/sub broker that SSE handlers fan out.

**Tech Stack:** Python 3.14 stdlib only (`sqlite3` WAL, `http.server`, `queue`,
`threading`); React + Vite + TanStack (two app roots); SSE for live streams.

**Spec:** `docs/superpowers/specs/2026-06-23-unified-sessions-dashboard-design.md`
(see §15 must-fix addendum — every item is a Global Constraint below).

## Global Constraints

- **Stdlib backend only** (no new Python deps). sqlite via `sqlite3`; per-operation
  short-lived connections; `PRAGMA journal_mode=WAL`, `busy_timeout=5000`,
  `synchronous=NORMAL`. Allocate `events.seq` atomically inside a `BEGIN IMMEDIATE` txn.
- **Tests run via** `python tests/test_bridge.py` (no pytest dep); new tests extend that
  file's plain assert/`__main__` runner and must keep it green. JS verified via
  `npm --prefix <root> run build`.
- **Journaling never blocks the pipe reader:** `Job.add` appends in-memory + enqueues;
  a dedicated journal thread does `store.append_event` + `pubsub.publish`.
- **Dashboard is no-auth localhost → mandatory defenses on EVERY `/local/*`:** Host
  allow-list `{127.0.0.1:DASH_PORT, localhost:DASH_PORT, [::1]:DASH_PORT}`; Origin/Referer
  allow-list on state-changing requests; a startup-generated secret token embedded in the
  served HTML and required via custom header `X-Dash-Token`. Gate SSE/GET reads with Host too.
- **`tunnel.start_tunnel()` deny-list:** refuse `DASH_PORT` and `MINIAPP_PORT`; validate
  1..65535. The dashboard port is never passed to `open_quick_tunnel`/the named tunnel.
- **Store at rest:** `~/.bridge_state` mode 0700; `bridge.db` + `-wal` + `-shm` owner-only;
  asserted at startup. Git-ignored. `BRIDGE_DB` overridable.
- **One canonical project key** = `browser.rel(abs_dir)` (`''` for base). Phone, bot, and
  dashboard all key sessions by this string; the runner converts rel↔abs at the edge.
- **Single Claude run at a time** (existing `state.busy` lock); release it on ANY
  exception between `acquire()` and thread start. Answering/interrupting is not a new run.
- **Behavior-preserving for the bot** except `/status` and `/new` (rewired to the store).
- **No image blobs persisted** — `turns.attachments` stores names only.

## File structure

**Create:**
- `bridge/store.py` — sqlite store: sessions/turns/events CRUD + journaling helpers.
- `bridge/pubsub.py` — in-process bounded pub/sub broker (topics: `session:<id>`, `logs`).
- `bridge/dashboard/__init__.py`
- `bridge/dashboard/server.py` — localhost ThreadingHTTPServer: static + `/local/*` JSON,
  SSE, control; Host/Origin/token defenses; SSE streaming helper.
- `bridge/dashboard/web/` — second Vite/React/TanStack app (own `dist/`).
- `bridge/web-shared/` — shared TS: event/question types + `RunStream`/`PermissionCard`/
  `QuestionCard` renderers, aliased `@shared` from both Vite roots.

**Modify:**
- `bridge/config.py` — `DASH_ENABLE`, `DASH_PORT=8790`, `DASH_HOST=127.0.0.1`, `BRIDGE_DB`.
- `bridge/state.py` — **remove** `sessions` dict; keep `active`/`busy`/`browse`. Add
  `project_key(chat_id) -> rel` helper.
- `bridge/runner.py` — `Job.session_id`; journal queue+thread; `_base_cmd` gains
  `claude_session_id`; `run_blocking`/`start_streaming_job` resolve a store session first;
  remove `state.sessions` reads/writes (lines 53/99/424); bot synthetic turn journaling.
- `bridge/miniapp/server.py` — session endpoints (`/api/sessions*`); `/api/run` requires
  `session_id`, drop `fresh`; remove `state.sessions` (lines 220/247).
- `bridge/dispatch.py` — `/status` reads store (line 93); `/new` creates a store session
  (lines 73, 139 → store); `use` callback (line 139).
- `claude_telegram_bridge.py` — start/stop dashboard server; `store.init()`; print URL.
- `bridge/tunnel.py` — `start_tunnel` deny-list.
- `bridge/miniapp/web/src/lib/{api,chat}.tsx`, `routes/{root,run}.tsx` — server-backed
  chat + session switcher; drop `fresh`; add `session_id`.
- `bridge/miniapp/web/{vite.config.ts,tsconfig.app.json}` — `@shared` alias.
- `tests/test_bridge.py` — update 4 `_base_cmd` tests; add store/session/security tests.
- `.gitignore` — `bridge/dashboard/web/{node_modules,dist}`, `bridge/web-shared` build, DB.

---

## PHASE A — Foundation: store + pubsub (independently testable)

### Task A1: `bridge/store.py` schema + connection + session CRUD

**Files:** Create `bridge/store.py`; Test: `tests/test_bridge.py` (new `test_store_*`).

**Interfaces — Produces:**
- `init() -> None` (idempotent; makedirs 0700, create tables, pragmas, chmod).
- `_connect() -> sqlite3.Connection` (WAL, busy_timeout=5000, Row factory).
- `create_session(chat_id:int, project:str, *, session_id:str|None=None) -> dict`
- `get_session(session_id:str) -> dict|None`
- `list_sessions(chat_id:int, project:str, include_archived=False) -> list[dict]`
- `latest_session(chat_id:int, project:str) -> dict|None`
- `ensure_session(chat_id:int, project:str, session_id:str|None=None) -> dict`
  (valid given id → it; else latest; else create)
- `set_claude_session_id(session_id, claude_sid)`, `set_title(session_id,title)`,
  `archive(session_id, archived=True)`, `rename(session_id,title)`
- Session dict shape: `{id, chat_id, project, claude_session_id, title, created, updated, archived}`

- [ ] **Step 1: failing tests**

```python
# tests/test_bridge.py  (add near top: import tempfile; set BRIDGE_DB before importing store)
os.environ.setdefault("BRIDGE_DB", os.path.join(tempfile.mkdtemp(), "t.db"))
from bridge import store  # noqa: E402
store.init()

def test_store_create_and_get_session():
    s = store.create_session(555, "org/repo")
    assert s["chat_id"] == 555 and s["project"] == "org/repo" and s["archived"] == 0
    got = store.get_session(s["id"])
    assert got["id"] == s["id"] and got["claude_session_id"] is None

def test_store_latest_and_ensure():
    a = store.create_session(555, "p1"); b = store.create_session(555, "p1")
    assert store.latest_session(555, "p1")["id"] == b["id"]
    assert store.ensure_session(555, "p1", a["id"])["id"] == a["id"]
    assert store.ensure_session(555, "p2")["project"] == "p2"   # creates

def test_store_archive_and_resume_id():
    s = store.create_session(555, "p3")
    store.set_claude_session_id(s["id"], "claude-xyz")
    store.archive(s["id"])
    assert store.get_session(s["id"])["claude_session_id"] == "claude-xyz"
    assert store.get_session(s["id"])["archived"] == 1
    assert all(x["id"] != s["id"] for x in store.list_sessions(555, "p3"))
```

- [ ] **Step 2:** `python tests/test_bridge.py` → these FAIL (no `store`).
- [ ] **Step 3:** implement `bridge/store.py` (schema from spec §4; `_connect()` sets
  `PRAGMA journal_mode=WAL; busy_timeout=5000; synchronous=NORMAL`; `init()` creates the
  dir 0700, tables, and `os.chmod` db+`-wal`+`-shm` to 0600; row→dict helper).
- [ ] **Step 4:** `python tests/test_bridge.py` → PASS.
- [ ] **Step 5:** `git add -A && git commit -m "feat(store): sqlite session store + CRUD"`

### Task A2: turns + events + transcript (atomic seq)

**Interfaces — Produces:**
- `start_turn(session_id, turn_id, prompt, attachments:list[str]) -> None` (insert turn
  status=running, seq=next; bump session.updated; auto-`set_title` from first prompt if null)
- `append_event(session_id, turn_id, ev:dict) -> int` (atomic `BEGIN IMMEDIATE`; seq =
  `COALESCE(MAX(seq),-1)+1` for session; insert; return seq)
- `finish_turn(turn_id, status, cost, elapsed) -> None`
- `transcript(session_id, cursor:int=0) -> {session, turns:list, events:list, next_cursor}`
  (events are `{seq, turn_id, type, ...payload}` with `seq > cursor`)

- [ ] **Step 1: failing tests**

```python
def test_store_turns_events_transcript():
    s = store.create_session(555, "p4")
    store.start_turn(s["id"], "job1", "hello world", [])
    assert store.get_session(s["id"])["title"]          # auto-titled
    seq0 = store.append_event(s["id"], "job1", {"type": "text", "text": "hi"})
    seq1 = store.append_event(s["id"], "job1", {"type": "result", "result": "done"})
    assert (seq0, seq1) == (0, 1)
    store.finish_turn("job1", "done", 0.01, 3)
    t = store.transcript(s["id"], cursor=0)
    assert [e["type"] for e in t["events"]] == ["text", "result"]
    assert t["next_cursor"] == 2 and t["turns"][0]["status"] == "done"
    assert store.transcript(s["id"], cursor=1)["events"][0]["type"] == "result"
```

- [ ] **Step 2–4:** fail → implement → pass (`python tests/test_bridge.py`).
- [ ] **Step 5:** commit `feat(store): turns/events/transcript with atomic seq`.

### Task A3: `bridge/pubsub.py` bounded broker

**Interfaces — Produces:**
- `SHUTDOWN`, `RESYNC` sentinels; `subscribe(topic) -> queue.Queue` (maxsize=512);
  `unsubscribe(topic, q)`; `publish(topic, item)` (try `put_nowait`; on `Full` clear queue
  and put `RESYNC`); `shutdown()` (put `SHUTDOWN` to all, drop subscribers).

- [ ] **Step 1: failing tests**

```python
from bridge import pubsub  # noqa: E402
def test_pubsub_basic_and_overflow():
    q = pubsub.subscribe("t1")
    pubsub.publish("t1", {"n": 1})
    assert q.get_nowait() == {"n": 1}
    for i in range(600): pubsub.publish("t1", {"n": i})   # overflow 512
    assert q.get_nowait() is pubsub.RESYNC                 # collapsed to resync
    pubsub.unsubscribe("t1", q)
    pubsub.publish("t1", {"n": 2})                         # no subscribers: no error
```

- [ ] **Step 2–4:** fail → implement → pass.
- [ ] **Step 5:** commit `feat(pubsub): bounded in-process broker`.

---

## PHASE B — Runner journaling, per-project sessions, API, phone migration

### Task B1: `_base_cmd` takes `claude_session_id`; remove `state.sessions` from runner

**Files:** Modify `bridge/runner.py`, `bridge/state.py`; update `tests/test_bridge.py`.

**Interfaces — Produces:**
- `_base_cmd(prompt, chat_id, *, stream, interactive=False, model=None, effort=None,
  claude_session_id=None)` — `--resume` from the param (not `state.sessions`).
- `state.project_key(chat_id) -> str` = `browser.rel(project_dir(chat_id))`.
- `state.sessions` removed.

- [ ] **Step 1:** update existing tests `test_interactive_base_cmd`,
  `test_blocking_base_cmd_unchanged`, `test_base_cmd_model_and_effort`,
  `test_base_cmd_omits_model_effort_by_default` to pass `claude_session_id=None`/a value and
  assert `--resume` presence/absence. Add `test_base_cmd_resumes_when_session_id`.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** change `_base_cmd` signature; delete `sid = state.sessions.get(chat_id)`,
  use the param; remove `state.sessions` from `state.py`; add `project_key`.
- [ ] **Step 4:** run → PASS (other runner tests unaffected — `Job` unchanged here).
- [ ] **Step 5:** commit `refactor(runner): resume via store session id param`.

### Task B2: Job journaling off the hot loop + session resolution

**Files:** Modify `bridge/runner.py`.

**Interfaces — Produces:**
- `Job(job_id, chat_id, session_id)`; `Job.add(ev)` appends in-memory AND
  `_journal_q.put((session_id, job_id, ev))`. Module journal thread drains the queue:
  `seq = store.append_event(...)`; `pubsub.publish(f"session:{sid}", {**ev, "seq": seq})`.
- `run_blocking(chat_id, prompt, session)` and `start_streaming_job(..., session_id=None)`
  call `store.ensure_session(chat_id, project_key, session_id)`; `--resume` from
  `session.claude_session_id`; `start_turn` before run; `finish_turn`+`set_claude_session_id`
  after. Remove the `state.sessions[...] = sid` writes (runner.py:99/424).

- [ ] **Step 1:** failing test — drive `_handle_event` through a `Job` with a real store
  session and assert events landed in `store.transcript` (flush journal queue in test via a
  `runner._drain_journal()` helper for determinism).

```python
def test_runner_journals_to_store():
    s = store.create_session(555, "p5")
    job = runner.Job("jx", 555, s["id"])
    runner._handle_event(job, {"type": "assistant", "message": {"content":[{"type":"text","text":"hey"}]}})
    runner._handle_event(job, {"type": "result", "result": "ok", "total_cost_usd": 0.02, "session_id": "c1"})
    runner._drain_journal()
    evs = [e["type"] for e in store.transcript(s["id"])["events"]]
    assert "text" in evs and "result" in evs
```

- [ ] **Step 2–4:** fail → implement (journal queue+thread; `_drain_journal` for tests) → pass.
- [ ] **Step 5:** commit `feat(runner): journal events to store via async thread`.

### Task B3: session API endpoints + run contract (`session_id`, drop `fresh`)

**Files:** Modify `bridge/miniapp/server.py`; tests.

**Interfaces — Produces (all initData-authed under `/api/`):**
- `GET /api/sessions?project=` → `{sessions:[{id,title,updated,archived}]}`
- `POST /api/sessions {project}` → `{session}`
- `GET /api/sessions/<id>?cursor=N` → `store.transcript(...)`
- `POST /api/sessions/<id>/archive` → `{ok:true}`
- `POST /api/run {session_id, project, prompt, images, model?, effort?}` → `{job_id}`;
  no more `fresh`; resolves `ensure_session` and passes `session_id` to the runner.

- [ ] **Step 1:** add tests asserting the 401 gate on `/api/sessions*` and `normalize`
  unchanged; a handler-level test using a fake request is heavy — instead unit-test the
  thin helpers (`_api_run` validation) by calling extracted pure functions where possible.
- [ ] **Step 2–4:** implement the routes (GET/POST dispatch in `do_GET`/`do_POST`); thread
  `session_id` into `start_streaming_job`; remove the `fresh` pop (server.py:245-247) and the
  `_api_select` pop (server.py:220).
- [ ] **Step 5:** commit `feat(api): session endpoints + session_id run contract`.

### Task B4: dispatch `/status`, `/new`, `use` → store; bot path journaling

**Files:** Modify `bridge/dispatch.py`, `bridge/runner.py` (`handle_task`).

- [ ] `/new` (dispatch:73) → `store.create_session(chat, project_key)`; `use` (dispatch:139)
  → create/select session for the new project; `/status` (dispatch:93) → show latest store
  session id/title. `handle_task` generates a `job_id`, `ensure_session`, `start_turn`,
  runs, `finish_turn`+`set_claude_session_id`, journals one synthetic `result` event.
- [ ] Test: `handle_task` with a stub `run_blocking` writes a turn+result to the store.
- [ ] Commit `feat(bot): per-project store sessions + /status/new rewrite`.

### Task B5: phone migration (server-backed chat + per-project session switcher)

**Files:** Modify `bridge/miniapp/web/src/lib/api.ts`, `lib/chat.tsx`, `routes/root.tsx`,
`routes/run.tsx`. Apply spec §15 Feature-1 fixes:
- Active turn stays job-local (job cursor); only historical turns load via
  `GET /api/sessions/<id>`; **upsert** turns by `job_id`; drop `fresh`; `New`/`newChat`
  POSTs `/api/sessions` then sets `session_id` before `send`; `--resume` server-side.
- Header session switcher (list current project's sessions + `＋ New`).

- [ ] Build check: `npm --prefix bridge/miniapp/web run build` succeeds; manual e2e on phone
  (chat streams, cards work, switching project switches transcript, New makes a session).
- [ ] Commit `feat(miniapp): server-backed per-project chats`.

---

## PHASE C — Desktop dashboard

### Task C1: extract `bridge/web-shared/` + `@shared` alias

- [ ] Move event/question **types** + `RunStream`/`PermissionCard`/`QuestionCard` into
  `bridge/web-shared/`. Add `resolve.alias { '@shared': <abs path> }` to
  `bridge/miniapp/web/vite.config.ts` and `paths {"@shared/*": [...]}` to its
  `tsconfig.app.json`; update imports. Verify the phone app still builds.
- [ ] Commit `refactor(web): extract @shared renderer/types`.

### Task C2: dashboard server — security gate + SSE helper + read endpoints

**Files:** Create `bridge/dashboard/server.py`, `bridge/dashboard/__init__.py`; modify
`bridge/config.py`, `bridge/tunnel.py`.

- [ ] `tunnel.start_tunnel` deny-list test: `start_tunnel(config.DASH_PORT)` returns an
  error and never spawns; `start_tunnel(config.MINIAPP_PORT)` likewise. Implement.
- [ ] Dashboard `Handler`: `_guard()` enforces Host allow-list (always) + `X-Dash-Token`
  (state-changing) + Origin allow-list; a `_sse(topic, backfill_fn)` helper that sends SSE
  headers (`text/event-stream`, `Connection: close`, `X-Accel-Buffering: no`), forces
  `close_connection=True`, sets a socket write timeout, **subscribes first**, writes
  backfill, then drains the queue (dedupe by `seq`), ~15s keepalive, unsubscribe on write
  error/`SHUTDOWN`. Read routes: `GET /local/projects|sessions|sessions/<id>|state`.
- [ ] Tests: `_guard` rejects bad Host (403) and missing token on POST; allows good ones.
- [ ] Commit `feat(dashboard): localhost server, security gate, SSE + reads`.

### Task C3: dashboard control endpoints + entry wiring

- [ ] `POST /local/run|run/<job>/respond|run/<job>/interrupt|server|preview|sessions|select`
  reusing `runner`/`devserver`/`tunnel`/`store` (same logic as `/api`, minus initData, plus
  `_guard`). `GET /local/stream/session/<id>` and `/local/stream/logs` via `_sse`.
  `devserver` publishes each new log line to `pubsub` topic `logs`.
- [ ] `claude_telegram_bridge.py`: `store.init()`; start dashboard server (if `DASH_ENABLE`),
  print `Dashboard: http://127.0.0.1:8790?token=…`; stop on shutdown; pubsub `shutdown()`.
- [ ] Commit `feat(dashboard): control endpoints + live log SSE + entry wiring`.

### Task C4: dashboard React app

**Files:** Create `bridge/dashboard/web/` (Vite/React/TanStack, `@shared` alias, own theme).

- [ ] Layout: left sidebar projects→sessions (live "running" badges via `/local/state`
  poll); center chat/stream view (reuse `@shared` `RunStream`/cards) with a full composer
  (prompt+images, answer cards, Stop/interrupt, model/effort); right/bottom dev-server logs
  panel (EventSource `/local/stream/logs`). Token read from the URL/`location` and sent as
  `X-Dash-Token`. Server + preview controls.
- [ ] `npm --prefix bridge/dashboard/web run build` succeeds; manual e2e on desktop.
- [ ] Commit `feat(dashboard): full-parity React client`.

### Task C5: finalize — gitignore, README/build notes, full verify

- [ ] `.gitignore` dashboard `node_modules`/`dist`, `~/.bridge_state`. Update
  `claude_telegram_bridge.py` docstring + README build steps (two Vite apps + dashboard URL).
- [ ] `python tests/test_bridge.py` green; both Vite apps build; manual e2e phone+desktop;
  assert dashboard port never tunneled.
- [ ] Commit `chore: gitignore + docs + final verify`.

---

## Self-review notes

- **Spec coverage:** §4 store→A1/A2; §5 runner→B1/B2/B4; §6 API+phone→B3/B5; §7 dashboard→
  C2/C3/C4; §8 concurrency→A1/A3/B2/C2; §9 config→C2/C3; §10 security→Global+C2; §11 tests→
  each task; §12 build→C1/C5; §15 must-fixes→Global Constraints + B5/C2. All mapped.
- **Open micro-decision:** session `delete` (hard) is deferred (archive only) — YAGNI until
  asked. `localStorage 'miniapp:chat:v1'` is discarded on first server-backed load (old
  global chats had no resumable `claude_session_id`); the key is cleared (note in B5).
- **Risk:** SSE handler-level behavior is integration-tested manually (no JS test infra);
  the `_guard`/`_sse`/store/tunnel logic is unit-tested headlessly.
