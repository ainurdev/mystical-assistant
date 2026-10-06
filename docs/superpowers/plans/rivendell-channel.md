# Rivendell channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a broken Rivendell link visible and loud (once), make every Rivendell job watchable and answerable from this bridge — the RIVENDELL tab and Telegram — and prepare the bridge side of a negotiated contract that lets Rivendell watch and answer too.

**Architecture:** Part 1 is bridge-only and works against the Rivendell deployed today: it reads everything off the bridge's own state (the worker's link status, the live `runner.Job`, the session store) and sends Rivendell nothing new. Every run is filed under its request in a new `sessions.ref` column, so a card finds its run's session after the run and after a restart. Part 2 adds a server-first `hello {features}` frame. The bridge sends progress, structured results and test jobs only for the features Rivendell names; Rivendell's side of that contract is listed at the end, for a separate repo.

**Tech Stack:** Python 3 stdlib (bridge), SQLite (`bridge/store.py`), the Telegram Bot API over urllib, React 19 + TypeScript + Vite (`bridge/dashboard/web`). Rivendell (read-only here): NestJS 10, `@nestjs/platform-ws`, Prisma, class-validator.

**Spec:** `docs/superpowers/specs/rivendell-channel.md` (mockups: `.mystical/design-drafts/rivendell-channel/`, git-ignored; Claude Design `drafts/rivendell-channel/`).

## Global Constraints

- Backend stays stdlib-only Python; no new web dependency.
- Work only in `/home/mhzrerfani/projects/.worktrees/mystical-assistant/feat-rivendell-channel` on `feat/rivendell-channel`. Don't touch the main checkout or the Rivendell repo; don't switch branches, push, or restart anything.
- Never write to `~/.bridge_state`. Any manual script runs with `BRIDGE_DB=/tmp/plan-rc.db`.
- `tests/conftest.py` pins the environment before `bridge.config` is imported. Never put env setup in a test module.
- `ponytail:` comments are load-bearing. Module docstrings carry the why; each task updates the docstrings of what it changes.
- Commits are plain messages: no `Co-Authored-By`, no "Generated with".
- Grace before a DISCONNECTED alert: **300 s** (`_LINK_GRACE = 300.0`).
- **Only the bridge's owner answers NEEDS YOU**, from the RIVENDELL tab, the session itself, or Telegram (`config.DASH_CHAT_ID`). Telegram pings NEEDS YOU for **every Rivendell job on this bridge**.
- Tokens (CSS): `--warn` NEEDS YOU, `--acc` RUNNING, `--ok` DONE and LINKED, `--err` FAILED, TOKEN REJECTED and the rail dot. Card chrome unchanged from variant C. Use the app's CSS variables and inline-style idiom, not the mockups' STUDIO palette.
- Tokens and time, never dollars.
- Part 1 puts nothing new on the wire to Rivendell (no new frame, field or route). Part 2 sends a new thing only when Rivendell's `hello` names its feature.
- Baselines at 666d29a1 in this worktree. `python3 -m pytest tests/ -q` gives **1460 passed, 2 skipped**; CLAUDE.md's 1007 is stale. `node_modules/.bin/tsc -p tsconfig.app.json` (in `bridge/dashboard/web`) exits 2 with exactly one pre-existing error, `src/components/Markdown.tsx(4,26): error TS2307: Cannot find module 'remark-breaks'`, because the symlinked main-checkout `node_modules` predates 4a73fed3. Task 10 gives the worktree its own install, after which tsc must exit 0. Anything else red is yours.

## Review Focus

1. **One question, two surfaces.** Answered in the tab (or the session), then tapped in Telegram, or the other way round. The second answer must say "already answered" and never land on whatever the run asks next. Pinned by Task 7, `test_a_question_answered_elsewhere_makes_the_tap_stale`.
2. **Re-dialing a still-bad token** (TEST LINK, or a token edit that is still wrong) passes through `connected` before the gateway's 4401. No second Telegram message may go out in the same break. Pinned by Task 5, `test_a_rejected_token_alerts_once_per_break`.
3. **A run held on a question for longer than its kind's timeout** must not land FAILED, and its clock resumes once answered. Pinned by Task 2, `test_a_question_pauses_the_jobs_wall_clock` and `test_a_question_pauses_a_batchs_wall_clock`.
4. **A Telegram reply to an ordinary bot message** must stay a prompt to Claude, not get eaten as an answer. Pinned by Task 7, `test_a_reply_to_any_other_message_is_still_a_prompt`.
5. **The deployed Rivendell (no hello)** must get no progress POST and no `details` on a result, since it 400s unknown fields. Pinned by Task 14, `test_progress_waits_for_the_feature_then_throttles`, and Task 16, `test_result_details_ride_only_a_rivendell_that_asked`.

---

## What the code says (verified 2026-10-06)

The plan argues from these. Line numbers are at 666d29a1.

1. **Rivendell runs are interactive stream-json runs.** `Worker._start_run` (`bridge/rivendell.py:832-842`) calls `runner.start_streaming_job(..., permission_mode="bypassPermissions")`, so `_base_cmd(interactive=True)` adds `--input-format stream-json --permission-mode bypassPermissions --permission-prompt-tool stdio` (`bridge/runner.py:346-348`).
2. **They can already ask.** A probe on claude **2.1.280** with exactly that argv (`--no-session-persistence`, so nothing was indexed) showed AskUserQuestion still arriving as `control_request {subtype: can_use_tool}`, with the CLI blocking until it got a `control_response`. The bridge's deny-with-message answer (`Job.respond`, `runner.py:695-721`) came back as the tool result, and the same process continued. `_handle_control_request` (`runner.py:1397-1421`) already holds the question: a pending entry, a `question` event (the session's QuestionCard), and a generic Telegram ping. The appended system prompt tells every run to use AskUserQuestion (`config.py:56-70`). So the spec's "can't ask yet" is not the gap; the gaps are the next two facts.
3. **The hang watchdog already ignores a wait on a person** (`runner.py:1775-1791`); **the kind's wall clock does not.** `Worker._wait_job` (`rivendell.py:790-819`) interrupts the job after `review_timeout` (3600 s) or `impl_timeout` (10800 s) no matter what, and `_wait_queue` (`rivendell.py:947-983`) does the same for a batch. A question held over lunch fails the job.
4. **There is no TodoWrite in `-p` mode on 2.1.280.** The init tool list has `TaskCreate, TaskGet, TaskList, TaskStop, TaskUpdate`. Captured shapes: `TaskCreate {subject, description}` → `tool_use_result: {"task": {"id": "1", "subject": …}}`, and `TaskUpdate {taskId: "1", status: "in_progress"|"completed"|…}`. `Job.todos` (`runner.py:611`) fills only from TodoWrite (`runner.py:1577`), so it is empty for every run today.
5. **Rivendell drops unknown socket frames silently.** The gateway (`backend/src/agent-gateway/agent.gateway.ts`, origin/main) has **no** `@SubscribeMessage` handler. `@nestjs/platform-ws` 10.4.22 `WsAdapter.bindMessageHandler` wraps `JSON.parse` and the handler lookup in `try { … } catch { return EMPTY }`, so any frame the bridge sends is ignored and the socket stays up.
6. **Rivendell 400s unknown result fields.** `backend/src/main.ts` installs a global `ValidationPipe({whitelist: true, forbidNonWhitelisted: true, transform: true})`. All five kinds take `SubmitReviewResultDto {status, result?, error? (≤5000), model?}` on their result route. Any new field on a result POST is a 400 today, so result details must wait for negotiation.
7. **A WebSocket round trip needs no Rivendell change.** Rivendell's `ws` 8.21.3 defaults `autoPong: true` and echoes the ping payload in its pong (`receiverOnPing`).
8. **"connected" is not proof of a good token.** The gateway closes 4401/4403 *after* the 101, once `handleConnection` has awaited the token check. It closes 4401 for *any* failure of `authenticate()`, a database hiccup included. The bridge marks itself `connected` at the 101 (`rivendell.py:690-692`) and only reads the close later.
9. **Nothing in Rivendell expires an IN_PROGRESS job.** `agent-job-phase.ts` only covers PENDING delivery, so a held run isn't failed server-side while it waits.
10. **The bridge ignores unknown frame types** (`_handle_message`, `rivendell.py:604-645`, returns None), so a new Rivendell's `hello` is harmless to today's bridge.
11. **The Mini App has no Rivendell surface**, and the dashboard binds 127.0.0.1 (`config.DASH_HOST`). A Telegram button can't open Settings.
12. **Sessions have no external-ref column** (`store.py:22-41`). Queue-mode batch turns are tagged `ref` = `"<instance id>:<request id>"` (`rivendell.py:921`). `Worker._running` (`rivendell.py:264-268`) is memory-only and dropped when the run ends (`_untrack`).
13. **`/plugin/tasks`' implementation summary is `{id, status, createdAt, completedAt}`**, with no error text.
14. **Existing tests stub `_start_run`, `_new_session` and `_wait_job` with fixed lambdas** (`tests/test_rivendell.py:338-1566`), so no new parameter may be added to those three. The plan hooks `_track`, `_post_result` and a new per-worker thread instead.

## Decisions this plan takes (the spec left them open)

- **D1 · Where request → session lives.** A new nullable `sessions.ref` column holding `"<instance id>:<request id>"` (the queue's own key), written by `Worker._track`, which every run path already calls. No new table. `_start_run`/`_new_session` stay untouched (fact 14).
- **D2 · Waiting pauses the clock.** While the live job has a pending entry, `_wait_job` and `_wait_queue` push their deadline forward by the time spent waiting: the watchdog's existing rule, applied to the wall clock. There is no cap (`ponytail:`, named in Task 2).
- **D3 · Buttons only for one single-choice question.** AskUserQuestion can carry several questions and `multiSelect`. Anything richer shows the question and OPEN SESSION, and a Telegram text reply answers it as free text.
- **D4 · A break ends when the link proves itself.** That means a non-close frame arrives, or a whole quiet interval passes with no close. It does not end at the 101 (fact 8), otherwise every re-dial of a dead token would open a new break and send another message.
- **D5 · The 5-minute grace is checked on status changes.** Those come at least every backoff plus dial timeout (≤ 70 s) during an outage, so the alert can land up to that late (`ponytail:`).
- **D6 · No "Open settings" button on the link-broken Telegram message** (fact 11). The text says where to fix it.
- **D7 · "Job done" is one ping per job, from the worker.** Rivendell sessions skip the generic per-turn ping and the "needs you" ping. Otherwise a queue-mode batch pinged once per step, and an autonomous run's closing question (meant for its requester, in Rivendell) pinged you. The ping carries the PR and time but **not checks**, which have only just started at that moment.
- **D8 · Checks on DONE cards come from `gh pr view --json statusCheckRollup`**, cached 2 minutes. It's its own task (4), so it can be cut without touching the rest. The user's Part 1 list left checks out; the spec's DONE line has them.
- **D9 · "Last known" cards are server-side.** The worker keeps the last good `/plugin/tasks` answer per slug in memory, and on any failure returns it marked `stale`.
- **D10 · TEST LINK by state.**
  - Connected: a ping/pong round trip on the live socket, carrying a nonce (fact 7).
  - auth_error: re-dial once with the same token (fact 8, the 4401-on-any-failure case).
  - error: report the listener's error, since it is already retrying.
  - off: 409.
- **D11 · Part 2 transport.**
  - Everything the bridge says goes up over HTTP, like ack and refuse: progress, ping answers, result details.
  - Everything Rivendell says comes down the socket: `hello`, `job-answer`, `ping-request`.
  - The gateway keeps zero inbound handlers.
  - Negotiation is a server-first `hello {features}`, reset on every connection. Features: `progress`, `result-details`, `ping`.
- **D12 · Wire names are camelCase**, matching Rivendell's DTOs (`taskId`, `repositoryFullName`): `sessionId`, `dashboardUrl`, `wallSeconds`, `activeSeconds`. The structured result rides one nested `details` object, so Rivendell stores it in one JSON column.
- **D13 · `ping` is not an AGENT_JOB_KIND on Rivendell.** It is an in-memory round trip with no row, no resend sweep and no requester decision.
- **D14 · Rivendell's answer path is limited to `claimedById`**, the bridge's owner (settled answer 1). The task page may show the question to everyone.
- **D15 · Todo progress counts TaskCreate/TaskUpdate** (fact 4) and falls back to a TodoWrite list.
- **D16 · Tokens "in" includes cache reads and writes**, SPEND's convention (`SpendPanel.tsx:192`).

## Dry run (2026-10-06)

Every code block in this plan was applied, verbatim and in task order, to a throwaway copy of this worktree in `/tmp` (since deleted).

- **Backend.** After Part 1 the suite read **1513 passed, 2 skipped**; after Part 2, **1526 passed, 2 skipped**.
- **Web.** tsc was clean except the pre-existing `remark-breaks` error, which went away with Task 10's local install. Every `.check.ts` passed and `vite build` succeeded.
- **Screenshots.** Task 10 Step 5's recipe rendered both tab states as the mockups intend.

So a red test while executing this plan means the code drifted from the plan, or the plan was misapplied.

## Surfaces (bridge-feature-slice)

| Row | Here |
|---|---|
| 1 Logic | `bridge/rivendell.py` (most), small hooks in `bridge/runner.py`, `bridge/github.py`, `bridge/telegram.py` |
| 2 Storage | `bridge/store.py`: `sessions.ref` + three readers |
| 3 Dashboard route | `POST /local/rivendell/test`; `/local/rivendell/tasks` and `/local/rivendell` gain fields, same routes |
| 4/6/8 Mini App | **Skipped.** The RIVENDELL tab is dashboard-only (its own spec), the Mini App has no Rivendell surface, and Telegram is the phone surface here |
| 5 Dashboard client | `bridge/dashboard/web/src/api.ts` |
| 7 Dashboard UI | `RivendellTasks.tsx`, `RightPanel.tsx`, `App.tsx`, `Notifications.tsx`, `SettingsModal.tsx` |
| 9 Bot | No new slash command (callbacks + replies only), so `HELP` is unchanged |
| 10 Live updates | **Skipped.** The tab polls every 10 s, as the spec says |
| 11 Tests | `tests/test_rivendell_channel.py` (new), `tests/test_github_checks.py` (new), additions to `tests/test_rivendell.py`, `tests/test_rivendell_tasks_endpoint.py`, `tests/test_telegram.py`; web: `src/lib/rivendelltasks.check.ts` |

## File map

| File | Change |
|---|---|
| `bridge/store.py` | `sessions.ref` migration; `set_ref`, `sessions_for_refs`, `last_turn` |
| `bridge/runner.py` | `live_job`; `Job.task_status` + TaskCreate/TaskUpdate tracking; question `at`; the NEEDS YOU hook; Rivendell sessions skip generic turn pings |
| `bridge/github.py` | `pr_ref`, `checks_state`, `pr_checks` |
| `bridge/telegram.py` | `send` returns the last message Telegram accepted |
| `bridge/rivendell.py` | run filing, clock pause, run views, link break/alert, TEST LINK, NEEDS YOU, job-done ping; Part 2: hello, progress, answers, result details, ping |
| `bridge/dispatch.py` | `rq:` callback, reply-to-ping routing |
| `bridge/dashboard/server.py` | `POST /local/rivendell/test` |
| `bridge/dashboard/web/src/api.ts` | channel types, `rivendellTest` |
| `bridge/dashboard/web/src/lib/rivendelltasks.ts` (+ `.check.ts`) | chip, banner code, result line, grouping, alert text, test text |
| `bridge/dashboard/web/src/lib/surfaces.ts` | `kilo` (moved from SpendPanel) |
| `bridge/dashboard/web/src/lib/opensettings.ts` | `openSettings(tab, focus?)`, `takeSettingsFocus()` |
| `bridge/dashboard/web/src/components/hud/RivendellTasks.tsx` | chip, banner, NEEDS YOU, live and result lines, last-known dimming |
| `bridge/dashboard/web/src/components/RightPanel.tsx` | `PanelTab.alert` red dot |
| `bridge/dashboard/web/src/components/hud/Notifications.tsx` | `notify` returns its id; `dismiss` exported |
| `bridge/dashboard/web/src/App.tsx` | Rivendell status poll, castle dot, one bell entry per break; Part 2: `?s=` deep link |
| `bridge/dashboard/web/src/components/hud/SettingsModal.tsx` | edit-on-open focus, TEST row; Part 2: SEND TEST JOB |

---

# Part 1 — bridge only

Works against the Rivendell deployed today. Nothing new goes over the wire to Rivendell.

### Task 1: File every run's session under its request

**Files:**
- Modify: `bridge/store.py`, in `init()` after the `work_cwd` migration (lines 179-183); new `set_ref`, `sessions_for_refs` after `set_work_cwd` (lines 398-403).
- Modify: `bridge/rivendell.py`: `Worker._track` (lines 1171-1178), `tasks()` (lines 1487-1512), and the module docstring's last paragraph (lines 153-157).
- Create: `tests/test_rivendell_channel.py`

**Interfaces:**
- Produces: `store.set_ref(session_id: str, ref: str) -> None`; `store.sessions_for_refs(refs: list[str]) -> dict[str, str]` (ref → newest session id); ref format `f"{instance_id}:{request_id}"`. `rivendell.tasks()` rows keep `session_id` for finished runs too. Test helpers that later tasks append to `tests/test_rivendell_channel.py`: fixtures `quiet` (autouse; the Telegram messages "sent", each `{"chat", "text", "kb", "mid"}`), `workers`, `jobs`, plus `_inst`, `_worker`, `_answering`, `_session`, `_turn`, `_tasks`, `_wait_until`.

- [ ] **Step 1: Write the failing tests** — create `tests/test_rivendell_channel.py`:

```python
"""The Rivendell channel (docs/superpowers/specs/rivendell-channel.md): what the
bridge itself knows about a Rivendell job — the session that ran it, what that
run is doing or came to, the question it is held on — and the state of the link
the job arrived over.

No network and no Claude: workers are driven directly, every Telegram message
lands in the `quiet` fixture, and the store is conftest's temp DB (store.init()
is idempotent, so each helper that needs tables calls it).
Run: python -m pytest tests/test_rivendell_channel.py -v
"""

import itertools
import json
import socket
import threading
import time
import uuid

import pytest

from bridge import config, rivendell, runner, state, store, wsutil

_mids = itertools.count(1000)          # Telegram message ids, unique across tests


@pytest.fixture(autouse=True)
def quiet(monkeypatch):
    """Every Telegram message a worker or a hook would send, recorded instead of
    sent: {"chat", "text", "kb", "mid"}. The generic run pings (runner._notify)
    are silenced too. NOTIFY_ENABLE and the Mini App URL are pinned here: the
    bridge exports .env into the shells it hosts, and conftest pins neither."""
    from bridge import telegram
    sent = []

    def send(chat_id, text, reply_markup=None):
        sent.append({"chat": chat_id, "text": text, "kb": reply_markup, "mid": next(_mids)})
        return {"message_id": sent[-1]["mid"]}
    monkeypatch.setattr(telegram, "send", send)
    monkeypatch.setattr(runner, "_notify", lambda *a, **k: None)
    monkeypatch.setattr(config, "NOTIFY_ENABLE", True)
    monkeypatch.setattr(state, "miniapp_url", None)        # no OPEN SESSION button to count
    return sent


@pytest.fixture
def workers():
    """The running-worker registry, emptied around the test."""
    store.init()
    rivendell._workers.clear()
    yield rivendell._workers
    rivendell._workers.clear()


@pytest.fixture
def jobs():
    """Jobs a test registers with the runner, dropped again afterwards."""
    made = []
    yield made
    with runner._jobs_lock:
        for j in made:
            runner._jobs.pop(j.id, None)


def _inst(**kw):
    d = {"id": "ch", "name": "test", "enable": True,
         "api_url": "http://api.example:3001", "token": "rvd_testtoken",
         "ws_url": "", "model": "opus", "workdir": "",
         "review_timeout": 3600, "impl_timeout": 10800}
    d.update(kw)
    return d


def _worker(**kw):
    return rivendell.Worker(_inst(**kw))


def _answering(answer):
    """An _api stand-in that returns a fresh copy of `answer` for every call."""
    return lambda path, payload=None: json.loads(json.dumps(answer))


def _session(origin="rivendell:test", title="Inbox: group meeting action items by client"):
    store.init()
    sid = store.create_session(config.DASH_CHAT_ID, "proj", origin=origin)["id"]
    if title:
        store.rename(sid, title)
    return sid


def _turn(sid, *, status="done", elapsed=60, result=None, error=None, tokens=None):
    """One finished turn on `sid`, with the events a run would have journaled.
    Turn ids are a global primary key, hence the uuid."""
    tid = uuid.uuid4().hex
    store.start_turn(sid, tid, "implement it", None)
    if error:
        store.append_event(sid, tid, {"type": "error", "message": error})
    if result is not None:
        store.append_event(sid, tid, {"type": "result", "result": result})
    store.set_turn_tokens(tid, tokens)
    store.finish_turn(tid, status, None, elapsed)
    return tid


def _tasks(*rids, status="COMPLETED"):
    """A /plugin/tasks answer: one of the user's tasks per request id."""
    return {"projects": [{"id": "p1", "name": "Rivendell", "url": "https://rv/projects/p1"}],
            "tasks": [{"id": f"t{i}", "name": f"Task {i}", "mine": True, "implementation":
                       {"id": rid, "status": status, "createdAt": "2026-10-06T10:00:00Z",
                        "completedAt": None}}
                      for i, rid in enumerate(rids, 1)]}


def _wait_until(pred, timeout=3.0):
    deadline = time.time() + timeout
    while time.time() < deadline:
        if pred():
            return
        time.sleep(0.01)
    raise AssertionError("condition not met within timeout")


# --- Task 1: every run is filed under its request ------------------------------

def test_sessions_are_found_by_their_request_ref():
    a, b = _session(), _session()
    store.set_ref(a, "ch:r-find-1")
    store.set_ref(b, "ch:r-find-2")
    assert store.sessions_for_refs(["ch:r-find-1", "ch:r-find-2", "ch:nope"]) == {
        "ch:r-find-1": a, "ch:r-find-2": b}
    assert store.sessions_for_refs([]) == {}


def test_a_request_run_again_names_its_newest_session():
    """A catch-up after a restart re-claims an IN_PROGRESS request and runs it in
    a new session; the card must open the one that did the work it now shows."""
    old, new = _session(), _session()
    store.set_ref(old, "ch:r-again")
    store.set_ref(new, "ch:r-again")
    assert store.sessions_for_refs(["ch:r-again"]) == {"ch:r-again": new}


def test_track_files_the_session_under_the_request(workers):
    sid = _session()
    _worker()._track("r-track", "impl", "acme/app", sid, label=None, link=None)
    assert store.sessions_for_refs(["ch:r-track"]) == {"ch:r-track": sid}


def test_a_finished_run_keeps_its_session_on_the_card(workers):
    """OPEN SESSION used to vanish with the run (memory only). A DONE card now
    still knows the session that did the work — after a restart too."""
    sid = _session()
    store.set_ref(sid, "ch:r-done")
    w = _worker()
    w._api = _answering(_tasks("r-done"))
    workers["ch"] = w
    assert rivendell.tasks("acme/app")["tasks"][0]["session_id"] == sid
```

- [ ] **Step 2: Run them to see them fail**

Run: `python3 -m pytest tests/test_rivendell_channel.py -q`
Expected: FAIL, `AttributeError: module 'bridge.store' has no attribute 'set_ref'`.

- [ ] **Step 3: Implement**

In `bridge/store.py` `init()`, directly after:

```python
        if "work_cwd" not in scols:
            c.execute("ALTER TABLE sessions ADD COLUMN work_cwd TEXT")
```

add:

```python
        # A plugin run's handle on the job that started it — "<instance id>:<request
        # id>" for a Rivendell request (bridge/rivendell.py Worker._track), the key a
        # queue-mode batch already tags its turns with. NULL = not a plugin run. It
        # is how a RIVENDELL card finds the session of a run that has ended, after a
        # restart too.
        if "ref" not in scols:
            c.execute("ALTER TABLE sessions ADD COLUMN ref TEXT")
        c.execute("CREATE INDEX IF NOT EXISTS ix_sessions_ref ON sessions(ref)")
```

After `set_work_cwd` (line 398-403) add:

```python
def set_ref(session_id: str, ref: str) -> None:
    """File a plugin run's session under the job that started it (see init)."""
    with closing(_connect()) as c:
        c.execute("UPDATE sessions SET ref=? WHERE id=?", (ref, session_id))


def sessions_for_refs(refs: list[str]) -> dict[str, str]:
    """ref -> the newest session filed under it. A request run again (a catch-up
    after a restart re-claims it) gets a second session; the newest is the one
    whose work the request now shows.
    ponytail: one IN (…) bind per ref — a tab lists one repo's open tasks, far
    under SQLite's variable limit; chunk it if a caller ever passes thousands."""
    if not refs:
        return {}
    with closing(_connect()) as c:
        rows = c.execute(
            f"SELECT ref, id FROM sessions WHERE ref IN ({','.join('?' * len(refs))}) "
            "ORDER BY created, rowid", list(refs)).fetchall()
    return {r["ref"]: r["id"] for r in rows}
```

In `bridge/rivendell.py`, replace `Worker._track` with:

```python
    def _track(self, request_id: str, kind: str, slug: "str | None", session_id: str,
               label: "str | None", link: "str | None") -> None:
        with self._q_lock:
            self._running[request_id] = {
                "instance_id": self.id, "key": f"{kind}:{request_id}", "kind": kind,
                "request_id": request_id, "slug": slug, "label": label or slug,
                "link": link, "session_id": session_id, "created_at": time.time(),
            }
        # Filed for good, not only while it runs: a DONE card opens (and reads its
        # result line from) the session that did the work, after the run and after
        # a restart. Best-effort — a card without its session beats a run that
        # fails over bookkeeping.
        try:
            from bridge import store                 # local import: heavy module
            store.set_ref(session_id, f"{self.id}:{request_id}")
        except Exception as e:  # noqa: BLE001
            print(f"rivendell[{self.name}]: could not file {request_id} "
                  f"under {session_id}: {e}")
```

In `tasks()`, replace the loop body after the `except TasksError` block (from `out["projects"] += …` to the end of the `for t in …` loop) with:

```python
        out["projects"] += [{**p, "instance_id": w.id} for p in got.get("projects") or []]
        rows = got.get("tasks") or []
        try:   # the session each request ran in here, finished or not (Worker._track)
            from bridge import store                 # local import: heavy module
            refs = store.sessions_for_refs([f"{w.id}:{t['implementation']['id']}" for t in rows
                                            if (t.get("implementation") or {}).get("id")])
        except Exception as e:  # noqa: BLE001 — the list must still come back
            print(f"rivendell[{w.name}]: session lookup failed: {e}")
            refs = {}
        for t in rows:
            rid = (t.get("implementation") or {}).get("id")
            out["tasks"].append({**t, "instance_id": w.id,
                                 "session_id": (w._running.get(rid) or {}).get("session_id")
                                 or refs.get(f"{w.id}:{rid}")})
```

In its docstring, change "a task whose request runs here also carries the session running it" to "a task whose request ran here carries the session that ran it (filed by _track, so it outlives the run and a restart)".

Extend the module docstring's last paragraph (lines 153-157) to:

```
The dashboard's RIVENDELL tab goes through here as well (tasks / implement, at
the bottom). It lists a repo's open tasks, and IMPLEMENT only asks Rivendell to
create the request. The run itself comes back over the socket like any other.
Every run is filed under its request (store sessions.ref, written by _track),
so a card still opens the session of a run that has ended, after a restart
too. The channel around it — link state, run views, NEEDS YOU — is
docs/superpowers/specs/rivendell-channel.md.
```

- [ ] **Step 4: Run the tests**

Run: `python3 -m pytest tests/test_rivendell_channel.py tests/test_rivendell.py tests/test_rivendell_tasks_endpoint.py -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge/store.py bridge/rivendell.py tests/test_rivendell_channel.py
git commit -m "rivendell: file every run's session under its request, so a finished card still opens it"
```

---

### Task 2: A held question doesn't run out the job's clock

**Files:**
- Modify: `bridge/runner.py`: add `live_job()` after `boot_phase` (lines 825-831).
- Modify: `bridge/rivendell.py`: `Worker._wait_job` (lines 790-819), `Worker._wait_queue` (lines 947-983), and a new module helper `_held` before `# --- One connection into one rivendell-api instance` (line 237).
- Test: `tests/test_rivendell_channel.py`

**Interfaces:**
- Produces: `runner.live_job(session_id: str) -> Job | None` (the session's running job); `rivendell._held(sid: str) -> bool`.

- [ ] **Step 1: Write the failing tests** (append):

```python
# --- Task 2: a question pauses the job's clock ---------------------------------

class _Waiting:
    """A live job that never ends on its own; `pending` is what it is held on."""

    def __init__(self):
        self.status, self.pending, self.interrupted = "running", [], False
        self.exited = threading.Event()
        self.store_session_id = None

    def interrupt(self):
        self.interrupted = True


def test_a_question_pauses_the_jobs_wall_clock(monkeypatch):
    """Review focus 3. A run held on AskUserQuestion is waiting on a person: its
    kind's timeout must not fail it while they think (the hang watchdog already
    reads a pending question that way — runner._watchdog)."""
    monkeypatch.setattr(rivendell, "_POLL_INTERVAL", 0.02)
    job = _Waiting()
    job.pending = [{"request_id": "q1", "kind": "question"}]
    out = []
    t = threading.Thread(target=lambda: out.append(_worker()._wait_job(job, 0.2)), daemon=True)
    t.start()
    time.sleep(0.6)                       # three timeouts' worth, all of it waiting on you
    assert out == [] and not job.interrupted
    job.pending = []                      # answered: the clock runs again
    t.join(3)
    assert out == [(False, "run timed out after 0.2s")] and job.interrupted


def test_a_question_pauses_a_batchs_wall_clock(monkeypatch):
    from bridge import queue_manager
    from bridge.queue_manager import PreviewQueue
    q = PreviewQueue(run_fn=lambda item: "job-q", persist_path=None)
    monkeypatch.setattr(queue_manager, "_instance", q)
    monkeypatch.setattr(rivendell, "_POLL_INTERVAL", 0.02)
    held = {"on": True}
    monkeypatch.setattr(rivendell, "_held", lambda sid: held["on"])
    q.enqueue("sess-held", text="step", prompt="do it", images=[], model="opus", effort=None,
              permission_mode="bypassPermissions", width=0, sel=[], surface="rivendell",
              chat_id=config.DASH_CHAT_ID, project="/repo", label="step · 1/1", link=None,
              ref="ch:b-held")
    out = []
    t = threading.Thread(target=lambda: out.append(
        _worker()._wait_queue("sess-held", "ch:b-held", 0.2)), daemon=True)
    t.start()
    time.sleep(0.6)
    assert out == [], "a turn waiting on a person must not run the batch's clock out"
    held["on"] = False
    t.join(3)
    assert out == [(False, "run timed out after 0.2s")]


def test_live_job_is_the_sessions_running_job(jobs):
    job = runner.Job(uuid.uuid4().hex, config.DASH_CHAT_ID, "sess-live")
    runner._register(job)
    jobs.append(job)
    assert runner.live_job("sess-live") is job
    assert runner.live_job("sess-other") is None
    job.status = "done"
    assert runner.live_job("sess-live") is None
```

- [ ] **Step 2: Run them to see them fail**

Run: `python3 -m pytest tests/test_rivendell_channel.py -q -k "pauses or live_job"`
Expected: FAIL. The two clock tests time out early with `run timed out after 0.2s`, and the third fails with `AttributeError: module 'bridge.runner' has no attribute 'live_job'`.

- [ ] **Step 3: Implement**

`bridge/runner.py`, after `boot_phase`:

```python
def live_job(session_id: str) -> "Job | None":
    """The session's in-flight job, or None — what the RIVENDELL tab and the
    Rivendell worker read a run's live state off. Same lookup as steer() and
    boot_phase(): a session has at most one running job."""
    with _jobs_lock:
        return next((j for j in _jobs.values()
                     if j.store_session_id == session_id and j.status == "running"), None)
```

`bridge/rivendell.py`, new module helper (just above the `# --- One connection into one rivendell-api instance` banner):

```python
def _held(sid: str) -> bool:
    """Is session `sid`'s live turn held on a question or an approval? A batch's
    clock pauses while it is (Worker._wait_queue; see Worker._wait_job)."""
    from bridge import runner                    # local import: heavy module
    job = runner.live_job(sid)
    return bool(job and job.pending)
```

In `Worker._wait_job`, add to the end of its docstring:

```
        Time the run spends held on a question (or an approval) doesn't count: a
        person is deciding, and their time is not the run's — the rule the hang
        watchdog already applies (runner._watchdog), here for the kind's wall
        clock, which would otherwise fail a run while you were answering it.
        ponytail: no cap — an unanswered question holds the job (and its
        IN_PROGRESS request) until someone answers or stops it; cap the paused
        time if abandoned asks ever pile up.
```

and replace its wait loop:

```python
        while not over() and time.time() < deadline:
            t0 = time.time()
            if self._stop.wait(_POLL_INTERVAL):
                break
            if getattr(job, "pending", None):
                deadline += time.time() - t0
```

In `Worker._wait_queue`, replace:

```python
            if self._stop.wait(_POLL_INTERVAL):
                return None, "bridge stopping"
```

with:

```python
            t0 = time.time()
            if self._stop.wait(_POLL_INTERVAL):
                return None, "bridge stopping"
            if _held(sid):
                deadline += time.time() - t0     # a turn waits on a person (see _wait_job)
```

and add "Time a turn spends held on a question doesn't count (see _wait_job)." to its docstring.

- [ ] **Step 4: Run the tests**

Run: `python3 -m pytest tests/test_rivendell_channel.py tests/test_rivendell.py -q`
Expected: all PASS. The existing `test_wait_job_*` stubs have no `pending` attribute, so their clocks behave as before.

- [ ] **Step 5: Commit**

```bash
git add bridge/runner.py bridge/rivendell.py tests/test_rivendell_channel.py
git commit -m "rivendell: a question a run is held on pauses its kind's wall clock"
```

---

### Task 3: Cards learn what the run is doing, asking, or came to

**Files:**
- Modify: `bridge/runner.py`:
  - `Job.__init__`: add `task_status` after `self.todos` (line 611).
  - `_handle_event`: TaskUpdate in the tool_use branch (after lines 1577-1578), TaskCreate result in the tool_result branch (after line 1591).
  - `_handle_control_request`: the question entry gains `at` (lines 1407-1408).
- Modify: `bridge/store.py`: `last_turn` after `turn_metrics` (lines 1021-1028).
- Modify: `bridge/github.py`: `pr_ref` after `_PR_URL_RE` (line 124).
- Modify: `bridge/rivendell.py`: `live_view`, `_result_view`, `_run_view` in the "RIVENDELL tab" section (after `_ask`, line 1485); `tasks()` adds `run`.
- Test: `tests/test_rivendell_channel.py`

**Interfaces:**
- Consumes: `runner.live_job` (Task 2), `store.sessions_for_refs` (Task 1).
- Produces:
  - `Job.task_status: dict[str, str]`; question pending entries carry `"at": float`.
  - `store.last_turn(session_id) -> dict | None`: the turn row plus `result: str` and `outcome: dict | None`.
  - `github.pr_ref(text) -> {"number": int, "url": str} | None`.
  - `rivendell.live_view(job) -> {"live": {"line": str, "steps": int, "todos": {"done", "total"} | None}, "ask": {"job_id", "request_id", "at", "question", "header", "options": [str], "simple": bool} | None}`.
  - `rivendell._result_view(sid) -> {"wall_s": int, "tokens": {"in", "out"} | None, "pr": {...} | None, "outcome": {"code", "label", "detail"} | None} | None`.
  - `rivendell._run_view(sid) -> dict`: either `live_view(...)` or `{"result": ...}`, or `{}` on failure.
  - Each `tasks()` row gains `run`.

- [ ] **Step 1: Write the failing tests** (append):

```python
# --- Task 3: what a card knows about its run -----------------------------------

class _Stdin:
    def __init__(self):
        self.lines = []

    def write(self, s):
        self.lines.append(s)

    def flush(self):
        pass


class _Proc:
    """Enough of a Popen for Job.respond: a stdin to answer on, and alive."""

    def __init__(self):
        self.stdin = _Stdin()

    def poll(self):
        return None


def _use(tid, name, inp):
    return {"type": "assistant",
            "message": {"content": [{"type": "tool_use", "id": tid, "name": name, "input": inp}]}}


def _tool_result(tid, tool_use_result):
    return {"type": "user", "tool_use_result": tool_use_result,
            "message": {"content": [{"type": "tool_result", "tool_use_id": tid,
                                     "content": [{"type": "text", "text": "ok"}]}]}}


COLOUR = [{"question": "Items with no meeting: group them under “No client”, or leave them out?",
           "header": "No meeting", "multiSelect": False,
           "options": [{"label": "Under “No client”", "description": ""},
                       {"label": "Leave them out", "description": ""}]}]


def _held_job(questions=COLOUR, sid=None):
    """A job held on an AskUserQuestion, as runner._handle_control_request leaves it."""
    j = runner.Job(uuid.uuid4().hex, config.DASH_CHAT_ID, sid)
    j.proc = _Proc()
    runner._handle_control_request(j, {"request_id": "q1", "request": {
        "subtype": "can_use_tool", "tool_name": "AskUserQuestion",
        "input": {"questions": questions}}})
    return j


def test_the_task_tools_are_the_runs_todo_list():
    """claude 2.1.280 offers no TodoWrite in -p mode; a run plans with
    TaskCreate/TaskUpdate (shapes captured from the CLI on 2026-10-06)."""
    j = runner.Job(uuid.uuid4().hex, config.DASH_CHAT_ID)
    runner._handle_event(j, _use("u1", "TaskCreate", {"subject": "alpha", "description": "a"}))
    runner._handle_event(j, _tool_result("u1", {"task": {"id": "1", "subject": "alpha"}}))
    runner._handle_event(j, _use("u2", "TaskCreate", {"subject": "beta", "description": "b"}))
    runner._handle_event(j, _tool_result("u2", {"task": {"id": "2", "subject": "beta"}}))
    runner._handle_event(j, _use("u3", "TaskUpdate", {"taskId": "1", "status": "in_progress"}))
    runner._handle_event(j, _use("u4", "TaskUpdate", {"taskId": "1", "status": "completed"}))
    assert j.task_status == {"1": "completed", "2": "pending"}
    assert rivendell.live_view(j)["live"]["todos"] == {"done": 1, "total": 2}


def test_a_deleted_task_leaves_the_count():
    j = runner.Job(uuid.uuid4().hex, config.DASH_CHAT_ID)
    j.task_status = {"1": "completed", "2": "deleted", "3": "in_progress"}
    assert rivendell.live_view(j)["live"]["todos"] == {"done": 1, "total": 2}


def test_a_todowrite_list_still_counts():
    j = runner.Job(uuid.uuid4().hex, config.DASH_CHAT_ID)
    j.todos = [{"content": "a", "status": "completed"}, {"content": "b", "status": "pending"}]
    assert rivendell.live_view(j)["live"]["todos"] == {"done": 1, "total": 2}


def test_live_view_names_the_latest_action_and_counts_steps():
    j = runner.Job(uuid.uuid4().hex, config.DASH_CHAT_ID)
    runner._handle_event(j, _use("u1", "Read", {"file_path": "a.ts"}))
    runner._handle_event(j, _use("u2", "Edit", {"file_path": "frontend/src/routes/tasks/$id.tsx"}))
    v = rivendell.live_view(j)
    assert v["live"] == {"line": "Edit: frontend/src/routes/tasks/$id.tsx", "steps": 2, "todos": None}
    assert v["ask"] is None


def test_live_view_carries_the_question_a_run_is_held_on():
    j = _held_job()
    ask = rivendell.live_view(j)["ask"]
    assert (ask["job_id"], ask["request_id"], ask["header"], ask["simple"]) == (
        j.id, "q1", "No meeting", True)
    assert ask["options"] == ["Under “No client”", "Leave them out"]
    assert ask["question"] == COLOUR[0]["question"] and ask["at"] > 0


def test_a_richer_question_is_not_buttons():
    two = COLOUR + [{"question": "And the rest?", "header": "Rest", "options": [{"label": "x"}]}]
    assert rivendell.live_view(_held_job(two))["ask"]["simple"] is False
    assert rivendell.live_view(_held_job([{**COLOUR[0], "multiSelect": True}]))["ask"]["simple"] is False


def test_result_view_reads_the_pr_time_and_tokens_off_the_session():
    sid = _session()
    _turn(sid, elapsed=2280,
          result="Branch feat/x. PR: https://github.com/acme/app/pull/128 — opened.",
          tokens={"in": 1000, "out": 200, "cache_w": 500, "cache_r": 1_000_000})
    v = rivendell._result_view(sid)
    assert (v["pr"]["number"], v["pr"]["url"]) == (128, "https://github.com/acme/app/pull/128")
    assert v["wall_s"] == 2280 and v["tokens"] == {"in": 1_001_500, "out": 200}
    assert v["outcome"] is None


def test_result_view_names_a_failed_runs_outcome():
    sid = _session()
    _turn(sid, status="error", elapsed=1260, error="⏱️ No output for 30 min — killed as hung.")
    assert rivendell._result_view(sid)["outcome"]["label"] == "KILLED AS HUNG"


def test_a_session_with_no_turns_has_no_result():
    assert rivendell._result_view(_session()) is None


def test_tasks_carry_each_runs_view(workers, jobs):
    done = _session()
    store.set_ref(done, "ch:r-view-done")
    _turn(done, result="https://github.com/acme/app/pull/7")
    live = _session()
    store.set_ref(live, "ch:r-view-live")
    j = _held_job(sid=live)
    runner._register(j)
    jobs.append(j)
    w = _worker()
    w._api = _answering(_tasks("r-view-done", "r-view-live"))
    workers["ch"] = w
    by_rid = {t["implementation"]["id"]: t for t in rivendell.tasks("acme/app")["tasks"]}
    assert by_rid["r-view-done"]["run"]["result"]["pr"]["number"] == 7
    assert by_rid["r-view-live"]["run"]["ask"]["request_id"] == "q1"
```

- [ ] **Step 2: Run them to see them fail**

Run: `python3 -m pytest tests/test_rivendell_channel.py -q`
Expected: FAIL, `AttributeError: … has no attribute 'task_status'` / `'live_view'` / `'_result_view'`.

- [ ] **Step 3: Implement**

`bridge/runner.py`, `Job.__init__`, after `self.todos: list = []`:

```python
        # The plan as the task tools keep it — what claude 2.1.280 -p offers
        # instead of TodoWrite: task id -> its latest status (TaskCreate's result
        # names the id, TaskUpdate moves it). The RIVENDELL card's todo bar.
        self.task_status: dict[str, str] = {}
```

`_handle_event`, tool_use branch, after the TodoWrite `elif`:

```python
                elif name == "TaskUpdate" and inp.get("taskId"):
                    tid = str(inp["taskId"])
                    job.task_status[tid] = str(inp.get("status")
                                               or job.task_status.get(tid, "pending"))
```

tool_result branch, right after `name, t0 = job.open_tools.pop(rid, (None, 0.0))`:

```python
                made = d.get("tool_use_result") if name == "TaskCreate" else None
                if (isinstance(made, dict) and isinstance(made.get("task"), dict)
                        and made["task"].get("id")):
                    job.task_status.setdefault(str(made["task"]["id"]), "pending")
```

`_handle_control_request`, the question entry:

```python
        job.add_pending({"request_id": rid, "kind": "question",
                         "tool_name": tool, "questions": questions,
                         "at": time.time()})    # since when: the card's "ASKS · 3m ago"
```

`bridge/store.py`, after `turn_metrics`:

```python
def last_turn(session_id: str) -> "dict | None":
    """A session's newest turn and how it ended: `result`, the text of its last
    result event ("" when none came), and `outcome` (bridge/outcomes.py) when it
    failed. For a readout that wants one run's ending without paying for its
    whole transcript — a RIVENDELL card reads it on every poll."""
    with closing(_connect()) as c:
        t = _row(c.execute("SELECT * FROM turns WHERE session_id=? ORDER BY seq DESC LIMIT 1",
                           (session_id,)).fetchone())
        if t is None:
            return None
        r = c.execute("SELECT payload FROM events WHERE session_id=? AND turn_id=? "
                      "AND type='result' ORDER BY seq DESC LIMIT 1",
                      (session_id, t["id"])).fetchone()
        sig = _outcome_signals(c, session_id, {t["id"]}) if t["status"] == "error" else {}
    t["result"] = str(json.loads(r["payload"]).get("result") or "") if r else ""
    t["outcome"] = outcomes.outcome(t, sig[t["id"]]) if sig else None
    return t
```

`bridge/github.py`, after `_PR_URL_RE`:

```python
def pr_ref(text: str) -> "dict | None":
    """The first pull request URL in `text`, as {number, url}: how a run's
    closing summary names the PR it opened (Rivendell's prompts ask for the
    link). None when it names none."""
    m = _PR_URL_RE.search(text or "")
    return {"number": int(m.group(1)), "url": m.group(0)} if m else None
```

`bridge/rivendell.py`, after `_ask` (the "RIVENDELL tab" section):

```python
def live_view(job) -> dict:
    """A live run, read off its job (pure: no I/O). `live` is what it is doing
    now — the jobs monitor's own label (Job.activity) —, its todo progress and
    how many steps (tool calls) it has taken; `ask` is the question it is held
    on, or None. Todo progress counts the task tools (claude 2.1.280's -p mode
    has no TodoWrite) and falls back to a TodoWrite list. `ask.simple` marks one
    single-choice question, the only kind whose options can be buttons; a
    richer one is answered in the session's own card."""
    act = job.activity()
    plan = [s for s in list(job.task_status.values()) if s != "deleted"] or [
        t.get("status") for t in job.todos if isinstance(t, dict)]
    ask = None
    for p in list(job.pending):
        qs = p.get("questions") or []
        if p.get("kind") == "question" and qs:
            q = qs[0]
            ask = {"job_id": job.id, "request_id": p["request_id"], "at": p.get("at"),
                   "question": q.get("question") or "",
                   "header": q.get("header") or q.get("question") or "",
                   "options": [o["label"] for o in q.get("options") or []
                               if isinstance(o, dict) and o.get("label")],
                   "simple": len(qs) == 1 and not q.get("multiSelect")}
            break
    return {"live": {"line": act["label"], "steps": act["tools"],
                     "todos": ({"done": plan.count("completed"), "total": len(plan)}
                               if plan else None)},
            "ask": ask}


def _result_view(sid: str) -> "dict | None":
    """What a finished run came to, read off its session: wall time and token
    spend over its turns (tokens in counts cache reads and writes, as SPEND
    does), the PR its closing summary names (Rivendell's prompts ask for the
    link), and — when its last turn failed — the outcome the transcript shows
    (bridge/outcomes.py). None for a session with no turns."""
    from bridge import github, store             # local import: heavy modules
    last = store.last_turn(sid)
    if last is None:
        return None
    rows = store.turn_metrics(sid)
    tin = sum((r.get("tok_in") or 0) + (r.get("tok_cache_w") or 0) + (r.get("tok_cache_r") or 0)
              for r in rows)
    tout = sum(r.get("tok_out") or 0 for r in rows)
    return {"wall_s": sum(r.get("elapsed") or 0 for r in rows),
            "tokens": {"in": tin, "out": tout} if tin or tout else None,
            "pr": github.pr_ref(last["result"]), "outcome": last["outcome"]}


def _run_view(sid: str) -> dict:
    """What this bridge knows about the run in session `sid`, for its card:
    while it runs, `live` and `ask` (live_view); once over, `result`. Read off
    the live job and the store — nothing here asks Rivendell. Best-effort: a
    card without its extra line beats a tab that fails to list."""
    from bridge import runner                    # local import: heavy module
    try:
        job = runner.live_job(sid)
        return live_view(job) if job is not None else {"result": _result_view(sid)}
    except Exception as e:  # noqa: BLE001
        print(f"rivendell: run view for {sid} failed: {e}")
        return {}
```

In `tasks()`, the row append becomes:

```python
        for t in rows:
            rid = (t.get("implementation") or {}).get("id")
            sid = (w._running.get(rid) or {}).get("session_id") or refs.get(f"{w.id}:{rid}")
            out["tasks"].append({**t, "instance_id": w.id, "session_id": sid,
                                 "run": _run_view(sid) if sid else None})
```

Add to `tasks()`'s docstring: "… and `run`, what this bridge knows about that run (_run_view)." Add to the module docstring paragraph from Task 1: "A card's run view (live_view / _result_view) is read off the live job and the store; nothing asks Rivendell."

- [ ] **Step 4: Run the tests**

Run: `python3 -m pytest tests/test_rivendell_channel.py tests/test_rivendell.py tests/test_bridge.py tests/test_clip_panel.py -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge/runner.py bridge/store.py bridge/github.py bridge/rivendell.py tests/test_rivendell_channel.py
git commit -m "rivendell: cards read the run's live line, todo progress, held question and result off the bridge"
```

---

### Task 4: DONE cards show the PR's checks

**Files:**
- Modify: `bridge/github.py`: `checks_state`, `pr_checks` after `pr_ref`.
- Modify: `bridge/rivendell.py`: `_CHECKS_TTL` and `_checks_cache` with the other constants (after line 169); `_checks()` and `_result_view(sid, checks=True)`.
- Create: `tests/test_github_checks.py`
- Test: `tests/test_rivendell_channel.py` (the cache, plus an autouse offline stub)

**Interfaces:**
- Produces: `github.checks_state(rollup) -> "pass" | "fail" | "pending" | None`; `github.pr_checks(url) -> same`; `rivendell._checks(url)` (cached); `_result_view(sid, checks: bool = True)` adds `pr["checks"]`.

- [ ] **Step 1: Write the failing tests.** Create `tests/test_github_checks.py`:

```python
"""A PR's checks as one word (bridge/github.py checks_state / pr_checks): what a
RIVENDELL DONE card shows beside its PR link.
Run: python -m pytest tests/test_github_checks.py -v"""

import json

from bridge import github


def test_any_failure_fails():
    assert github.checks_state([{"conclusion": "SUCCESS"}, {"conclusion": "FAILURE"}]) == "fail"
    assert github.checks_state([{"state": "ERROR"}]) == "fail"


def test_anything_still_running_is_pending():
    assert github.checks_state([{"conclusion": "SUCCESS"},
                                {"status": "IN_PROGRESS", "conclusion": ""}]) == "pending"
    assert github.checks_state([{"state": "PENDING"}]) == "pending"


def test_all_green_or_skipped_passes():
    assert github.checks_state([{"conclusion": "SUCCESS"}, {"conclusion": "SKIPPED"},
                                {"state": "SUCCESS"}]) == "pass"


def test_no_checks_is_no_word():
    assert github.checks_state([]) is None and github.checks_state(None) is None


def test_pr_checks_reads_gh(monkeypatch):
    calls = []

    def run(*args, **kw):
        calls.append(args)
        return 0, json.dumps({"statusCheckRollup": [{"conclusion": "SUCCESS"}]}), ""
    monkeypatch.setattr(github, "_run", run)
    assert github.pr_checks("https://github.com/a/b/pull/7") == "pass"
    assert calls == [("gh", "pr", "view", "https://github.com/a/b/pull/7",
                      "--json", "statusCheckRollup")]


def test_pr_checks_without_gh_is_unknown(monkeypatch):
    monkeypatch.setattr(github, "_run", lambda *a, **k: (127, "", "gh: not found"))
    assert github.pr_checks("https://github.com/a/b/pull/7") is None
```

In `tests/test_rivendell_channel.py`, add the offline stub to the `quiet` fixture (before `return sent`):

```python
    from bridge import github
    monkeypatch.setattr(github, "pr_checks", lambda url: None)   # never `gh` over the network
    rivendell._checks_cache.clear()
```

and append:

```python
# --- Task 4: DONE cards show the PR's checks -----------------------------------

def test_checks_ride_the_pr_and_are_cached_between_polls(monkeypatch):
    from bridge import github
    calls = []
    monkeypatch.setattr(github, "pr_checks", lambda url: calls.append(url) or "pass")
    sid = _session()
    _turn(sid, result="https://github.com/acme/app/pull/31")
    assert rivendell._result_view(sid)["pr"]["checks"] == "pass"
    assert rivendell._result_view(sid)["pr"]["checks"] == "pass"
    assert calls == ["https://github.com/acme/app/pull/31"], "one `gh` call per TTL"
    monkeypatch.setattr(rivendell, "_CHECKS_TTL", 0)
    rivendell._result_view(sid)
    assert len(calls) == 2
    assert "checks" not in rivendell._result_view(sid, checks=False)["pr"]
```

- [ ] **Step 2: Run them to see them fail**

Run: `python3 -m pytest tests/test_github_checks.py tests/test_rivendell_channel.py -q`
Expected: FAIL, `AttributeError: module 'bridge.github' has no attribute 'checks_state'` (and the fixture's `pr_checks` stub raises `AttributeError` until it exists).

- [ ] **Step 3: Implement.** In `bridge/github.py`, after `pr_ref`:

```python
_CHECKS_FAIL = {"FAILURE", "ERROR", "TIMED_OUT", "CANCELLED", "ACTION_REQUIRED", "STARTUP_FAILURE"}
_CHECKS_OK = {"SUCCESS", "NEUTRAL", "SKIPPED"}


def checks_state(rollup) -> "str | None":
    """GitHub's statusCheckRollup as one word: fail if any check failed, pending
    while any is still running, pass when every one passed; None when there are
    none. A CheckRun answers in `conclusion` (empty while it runs), a commit
    status in `state`."""
    states = [str(c.get("conclusion") or c.get("state") or "").upper()
              for c in rollup or () if isinstance(c, dict)]
    if not states:
        return None
    if any(s in _CHECKS_FAIL for s in states):
        return "fail"
    return "pass" if all(s in _CHECKS_OK for s in states) else "pending"


def pr_checks(url: str) -> "str | None":
    """checks_state for the PR at `url`, via the user's authed `gh`. None when gh
    can't say (not installed, no access, not a PR)."""
    rc, out, _ = _run("gh", "pr", "view", url, "--json", "statusCheckRollup")
    if rc != 0:
        return None
    try:
        return checks_state(json.loads(out or "{}").get("statusCheckRollup"))
    except ValueError:
        return None
```

In `bridge/rivendell.py`, with the constants:

```python
_CHECKS_TTL = 120.0       # seconds a PR's checks state is reused across tab polls
_checks_cache: "dict[str, tuple[float, str | None]]" = {}
```

and beside `_result_view`:

```python
def _checks(url: str) -> "str | None":
    """github.pr_checks, cached for _CHECKS_TTL: the tab polls every 10 s, and
    each read is a `gh` call over the network.
    ponytail: a plain dict keyed by PR url, never pruned — a few entries per
    DONE card ever shown; an LRU if a bridge lives through months of PRs."""
    from bridge import github                    # local import: subprocess-heavy
    hit = _checks_cache.get(url)
    if hit and time.monotonic() - hit[0] < _CHECKS_TTL:
        return hit[1]
    state = github.pr_checks(url)
    _checks_cache[url] = (time.monotonic(), state)
    return state
```

Change `_result_view` to `def _result_view(sid: str, checks: bool = True) -> "dict | None":`, add "with its checks (unless `checks` is False: they have only just started when a job ends)" to its docstring, and replace its `return` with:

```python
    pr = github.pr_ref(last["result"])
    if pr and checks:
        pr["checks"] = _checks(pr["url"])
    return {"wall_s": sum(r.get("elapsed") or 0 for r in rows),
            "tokens": {"in": tin, "out": tout} if tin or tout else None,
            "pr": pr, "outcome": last["outcome"]}
```

- [ ] **Step 4: Run the tests**

Run: `python3 -m pytest tests/test_github_checks.py tests/test_rivendell_channel.py -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge/github.py bridge/rivendell.py tests/test_github_checks.py tests/test_rivendell_channel.py
git commit -m "rivendell: DONE cards carry their PR's checks (gh, cached two minutes)"
```

---

### Task 5: The link's break, flagged once; link states and last-known cards on the tab

**Files:**
- Modify: `bridge/rivendell.py`:
  - `_LINK_GRACE` with the constants.
  - `Worker.__init__`: new fields after `self.last_event_at` (line 282).
  - `_set_status`, `status_snapshot` (lines 284-300).
  - New `_recovered` and `_alert_broken` after `status_snapshot`.
  - `_deliver_telegram`'s docstring (line 1143).
  - `_listen`: the dial-failure branch (lines 681-688) and the frame loop (lines 700-722).
  - `tasks()`.
  - The module docstring.
- Modify: `tests/test_rivendell.py`: an autouse fixture after `acks` (line 43); `test_tasks_with_no_running_instance_says_so` (line 1430).
- Test: `tests/test_rivendell_channel.py`

**Interfaces:**
- Produces:
  - `Worker` fields `down_since`, `alert_at`, `attempt`, `retry_at`, `_last_tasks`.
  - `status_snapshot()` gains `down_since`, `alert_at`, `attempt`, `retry_at`.
  - `Worker._recovered()`, `Worker._alert_broken()`.
  - `tasks()` returns `links: [{instance_id, instance, **status_snapshot()}]`, and each task row gains `stale: bool`.

- [ ] **Step 1: Write the failing tests** (append to `tests/test_rivendell_channel.py`):

```python
# --- Task 5: the link's break, flagged once ------------------------------------

def _alerts(quiet):
    return [m["text"] for m in quiet if m["text"].startswith("✕ Rivendell link broken")]


def test_a_rejected_token_alerts_once_per_break(quiet):
    """Review focus 2. The gateway closes a bad token AFTER the 101, so a re-dial
    of a still-bad token passes through "connected": that must not end the
    break, or every TEST LINK would send another message."""
    w = _worker()
    w._set_status("connecting", "ws://x/agent")
    w._set_status("auth_error", "token rejected by gateway (4401 Invalid or revoked token)")
    _wait_until(lambda: len(_alerts(quiet)) == 1)
    assert "4401" in _alerts(quiet)[0] and w.alert_at is not None
    for state in ("connecting", "connected", "auth_error"):          # the re-dial
        w._set_status(state, "token rejected by gateway (4401)")
    time.sleep(0.1)
    assert len(_alerts(quiet)) == 1


def test_an_outage_alerts_only_after_the_grace(quiet):
    w = _worker()
    w._set_status("error", "connection refused")
    w._set_status("connecting", "ws://x/agent")
    assert w.alert_at is None and w.down_since is not None
    w.down_since -= rivendell._LINK_GRACE                  # the outage is five minutes old now
    w._set_status("error", "connection refused")
    _wait_until(lambda: len(_alerts(quiet)) == 1)
    assert "Can't reach" in _alerts(quiet)[0]


def test_coming_back_inside_the_grace_sends_nothing(quiet):
    w = _worker()
    w._set_status("error", "connection refused")
    w._set_status("connected", "ws://x/agent")
    w._recovered()
    assert w.down_since is None and w.alert_at is None
    time.sleep(0.05)
    assert _alerts(quiet) == []


def test_only_a_proven_link_ends_the_break():
    w = _worker()
    w._set_status("auth_error", "token rejected (4401)")
    w._set_status("connected", "ws://x/agent")
    assert w.alert_at is not None, "the 101 alone is not recovery"
    w._recovered()
    assert w.alert_at is None and w.down_since is None


def test_switching_off_ends_the_break_silently(quiet):
    w = _worker()
    w._set_status("auth_error", "token rejected (4401)")
    _wait_until(lambda: len(_alerts(quiet)) == 1)
    w.stop()
    assert w.alert_at is None and w.status_snapshot()["state"] == "off"


def test_a_frame_on_the_link_proves_it(monkeypatch):
    server, client = socket.socketpair()
    w = _worker()
    w.down_since = w.alert_at = time.time() - 600            # a break, already flagged
    monkeypatch.setattr(w, "_connect", lambda: (client, client.makefile("rb")))
    monkeypatch.setattr(w, "_catch_up", lambda: 0)
    t = threading.Thread(target=w._listen, daemon=True)
    t.start()
    try:
        _wait_until(lambda: w.status == "connected")
        assert w.alert_at is not None
        server.sendall(wsutil.encode_frame(b'{"type":"noise"}', wsutil.OP_TEXT))
        _wait_until(lambda: w.alert_at is None)
    finally:
        w.stop()
        t.join(2)
        server.close()


def test_a_failed_dial_counts_and_schedules_the_retry(monkeypatch):
    w = _worker()

    def refuse():
        raise ConnectionRefusedError("connection refused")
    monkeypatch.setattr(w, "_connect", refuse)
    t = threading.Thread(target=w._listen, daemon=True)
    t.start()
    try:
        _wait_until(lambda: w.status == "error")
        snap = w.status_snapshot()
        assert snap["attempt"] == 1 and snap["retry_at"] >= snap["since"]
        assert snap["down_since"] is not None and snap["alert_at"] is None
    finally:
        w.stop()
        t.join(2)


def test_tasks_carry_each_connections_state(workers):
    w = _worker(name="production")
    w._api = _answering(_tasks())
    w._set_status("connected", "wss://rv/agent")
    workers["ch"] = w
    (link,) = rivendell.tasks("acme/app")["links"]
    assert (link["instance_id"], link["instance"], link["state"]) == ("ch", "production", "connected")


def test_a_failing_instance_lists_its_last_good_answer_as_stale(workers):
    w = _worker()
    w._api = _answering(_tasks("r-stale-1", "r-stale-2"))
    workers["ch"] = w
    assert [t["stale"] for t in rivendell.tasks("acme/app")["tasks"]] == [False, False]
    w._set_status("auth_error", "token rejected (4401)")
    out = rivendell.tasks("acme/app")
    assert [(t["id"], t["stale"]) for t in out["tasks"]] == [("t1", True), ("t2", True)]
    assert out["errors"][0]["error"] == "token_rejected" and out["projects"]
```

In `tests/test_rivendell.py`, after the `acks` fixture, add:

```python
@pytest.fixture(autouse=True)
def no_link_alerts(monkeypatch):
    """A rejected token (or a long outage) pings Telegram once per break
    (Worker._alert_broken); no test here may reach the network for it."""
    monkeypatch.setattr(rivendell.Worker, "_alert_broken", lambda self: None)
```

and change `test_tasks_with_no_running_instance_says_so` to expect `links`:

```python
def test_tasks_with_no_running_instance_says_so(workers):
    assert rivendell.tasks("acme/app") == {
        "instances": 0, "projects": [], "tasks": [], "errors": [], "links": []}
```

- [ ] **Step 2: Run them to see them fail**

Run: `python3 -m pytest tests/test_rivendell_channel.py tests/test_rivendell.py -q`
Expected: FAIL, `AttributeError: … has no attribute '_LINK_GRACE'` / `'_recovered'`, a missing `links` key, and `test_rivendell.py` failing on its new fixture until `_alert_broken` exists.

- [ ] **Step 3: Implement.** Constants:

```python
_LINK_GRACE = 300.0       # an outage this long is a break worth one Telegram message
```

`Worker.__init__`, after `self.last_event_at: float | None = None`:

```python
        # The current break (see _set_status): when it began, and when it was
        # flagged — once per break, cleared when the link proves itself
        # (_recovered). attempt/retry_at drive the tab's "RETRY n · 20s" chip.
        self.down_since: float | None = None
        self.alert_at: float | None = None
        self.attempt = 0
        self.retry_at: float | None = None
        # The last good /plugin/tasks answer per repo slug: an instance that
        # fails still shows its cards, dimmed as "last known" (tasks()). One
        # entry per repo the tab has shown.
        self._last_tasks: "dict[str, dict]" = {}
```

Replace `_set_status` and `status_snapshot`, and add the two helpers:

```python
    def _set_status(self, state: str, detail: str = "") -> None:
        self.status = state
        self.status_detail = detail
        self.status_at = time.time()
        if state == "connected":
            self.connected_since = self.status_at
            self.attempt, self.retry_at = 0, None
        elif state != "connected":
            self.connected_since = None
        # The break behind the rail dot, the bell and the one Telegram message
        # (docs/superpowers/specs/rivendell-channel.md §B). It opens at the first
        # failure and closes only when the link proves itself (_recovered):
        # "connected" is just the 101, and the gateway closes a bad token after
        # it. Switching off closes it silently: an instance you turned off never
        # pings.
        if state == "off":
            self.down_since = self.alert_at = None
        elif state in ("error", "auth_error") and self.down_since is None:
            self.down_since = self.status_at
        if (self.alert_at is None and self.down_since is not None and state != "connected"
                and (state == "auth_error" or self.status_at - self.down_since >= _LINK_GRACE)):
            # ponytail: the grace is checked on status changes, which come at least
            # every backoff + dial timeout (≤ 70 s) while the link is down, so the
            # alert lands up to that late. A timer, if minutes must be exact.
            self.alert_at = self.status_at
            self._alert_broken()

    def status_snapshot(self) -> dict:
        return {
            "state": self.status,
            "detail": self.status_detail,
            "since": self.status_at,
            "connected_since": self.connected_since,
            "last_event_at": self.last_event_at,
            "down_since": self.down_since,      # when the current break began
            "alert_at": self.alert_at,          # when it was flagged: dot, bell, Telegram
            "attempt": self.attempt,            # failed dials in a row
            "retry_at": self.retry_at,          # when the next dial starts
        }

    def _recovered(self) -> None:
        """The link has proven itself: a frame arrived on it, or a whole quiet
        interval passed without the gateway closing it. Only now is a break
        over. The gateway closes a bad token AFTER the upgrade, so the 101 alone
        (status "connected") can't clear the alert, or every re-dial of a dead
        token would end one break and open the next."""
        self.down_since = self.alert_at = None

    def _alert_broken(self) -> None:
        """The break's one Telegram message (the dashboard's rail dot and bell
        read alert_at off the status). Off-thread: _set_status runs on the
        listener. No settings button: the dashboard is localhost-only and the
        Mini App has no Rivendell settings, so the text says where to go."""
        at = time.strftime("%H:%M", time.localtime(self.down_since or time.time()))
        if self.status == "auth_error":
            text = (f"✕ Rivendell link broken — {self.name}\n"
                    f"Rivendell refused this bridge's token at {at} ({self.status_detail}). "
                    "Jobs are paused until you replace it: mint a new LLM token in "
                    "Rivendell ▸ Profile ▸ API tokens, then paste it in the dashboard "
                    "under Settings ▸ PLUGINS.")
        else:
            text = (f"✕ Rivendell link broken — {self.name}\n"
                    f"Can't reach Rivendell since {at} ({self.status_detail}). "
                    "The bridge keeps retrying; jobs wait until it's back.")
        threading.Thread(target=self._deliver_telegram, args=(text, None),
                         name=f"rivendell-tg-{self.id}", daemon=True).start()
```

Change `_deliver_telegram`'s docstring first sentence to "Send one ping (a held request, a broken link, a finished job) to the bridge owner's chat."

In `_listen`, the dial-failure branch becomes:

```python
            except Exception as e:  # noqa: BLE001 — reconnect-forever by design
                if not self._stop.is_set():
                    self.attempt += 1
                    self.retry_at = time.time() + backoff
                    self._set_status("error", str(e))
```

(the `print` and `self._stop.wait(backoff)` lines after it stay). In the frame loop, after the dead-peer check in the timeout branch:

```python
                        if missed > _MAX_MISSED_PONGS:
                            raise ConnectionError("peer stopped answering pings")
                        # A whole quiet interval with no close: the gateway took
                        # the token, so the link has proven itself.
                        self._recovered()
                        self._send(sock, b"", wsutil.OP_PING)
                        continue
```

and right after `opcode, payload = frame`:

```python
                    if opcode != wsutil.OP_CLOSE:
                        self._recovered()       # anything but a close proves the link
```

Replace `tasks()` with its final Part 1 form:

```python
def tasks(slug: str) -> dict:
    """Open tasks of the Rivendell projects that link the repo `slug`, from
    every running instance, merged, plus `links` — each instance's connection
    state, for the tab's chip and banner. Each project and task is tagged with
    its instance (IMPLEMENT goes back to the same one). A task whose request
    ran here carries the session that ran it (filed by _track, so it outlives
    the run and a restart) and `run`, what this bridge knows about that run
    (_run_view). A failing instance is one entry in `errors`, never an
    exception — the rest still list — and its last good answer comes back
    marked `stale`, which the tab dims to "last known". A worker parked on a
    rejected token isn't asked: the tab polls, and re-sending a dead token
    every few seconds is exactly the hammering _listen avoids."""
    with _manager_lock:
        running = list(_workers.values())
    out: dict = {"instances": len(running), "projects": [], "tasks": [], "errors": [],
                 "links": [{"instance_id": w.id, "instance": w.name, **w.status_snapshot()}
                           for w in running]}
    for w in running:
        stale = False
        try:
            if w.status == "auth_error":
                raise TasksError("token_rejected", w.status_detail or "token rejected")
            got = w._last_tasks[slug] = _ask(
                w, "/plugin/tasks?repository=" + quote(slug, safe="/"))
        except TasksError as e:
            out["errors"].append({"instance_id": w.id, "instance": w.name,
                                  "error": e.code, "detail": str(e)})
            got, stale = w._last_tasks.get(slug), True
            if got is None:
                continue
        out["projects"] += [{**p, "instance_id": w.id} for p in got.get("projects") or []]
        rows = got.get("tasks") or []
        try:   # the session each request ran in here, finished or not (Worker._track)
            from bridge import store                 # local import: heavy module
            refs = store.sessions_for_refs([f"{w.id}:{t['implementation']['id']}" for t in rows
                                            if (t.get("implementation") or {}).get("id")])
        except Exception as e:  # noqa: BLE001 — the list must still come back
            print(f"rivendell[{w.name}]: session lookup failed: {e}")
            refs = {}
        for t in rows:
            rid = (t.get("implementation") or {}).get("id")
            sid = (w._running.get(rid) or {}).get("session_id") or refs.get(f"{w.id}:{rid}")
            out["tasks"].append({**t, "instance_id": w.id, "session_id": sid, "stale": stale,
                                 "run": _run_view(sid) if sid else None})
    return out
```

Add to the module docstring, after the token-rejection paragraph ("A token/auth failure is treated apart …"):

```
A broken link is a *break*: it opens at the first failure, ends only when the
link proves itself (a frame arrives, or a quiet interval passes with no close —
_recovered), and is flagged once: one Telegram message, plus alert_at on the
status for the dashboard's rail dot and bell. Flagged at once on the move to
auth_error, after _LINK_GRACE of anything else; an instance switched off never
pings.
```

- [ ] **Step 4: Run the tests**

Run: `python3 -m pytest tests/test_rivendell_channel.py tests/test_rivendell.py tests/test_rivendell_tasks_endpoint.py -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge/rivendell.py tests/test_rivendell_channel.py tests/test_rivendell.py
git commit -m "rivendell: a broken link is one break, flagged once, over when the link proves itself; tasks carry link states and last-known cards"
```

---

### Task 6: TEST LINK

**Files:**
- Modify: `bridge/rivendell.py`:
  - `_TEST_TIMEOUT` with the constants.
  - `Worker.__init__` (`_pongs`, `_send_lock`, `last_test`).
  - `status_snapshot` (`last_test`).
  - `_send` (lines 446-447).
  - `_listen`, the OP_PONG branch (lines 744-748).
  - New `Worker.test_link` after `_recovered`.
  - Module `test_link` after `running()` (line 1375-1380).
- Modify: `bridge/dashboard/server.py`: `POST /local/rivendell/test`, after the `/local/rivendell/implement` block (ends line 1325).
- Test: `tests/test_rivendell_channel.py`, `tests/test_rivendell_tasks_endpoint.py`

**Interfaces:**
- Produces:
  - `Worker.test_link(timeout: float = _TEST_TIMEOUT) -> {"ok": bool | None, "rtt_ms": int | None, "detail": str, "at": float}`; `ok` None means "re-dialing".
  - `rivendell.test_link(instance_id: str, job: bool = False) -> dict | None`; `job` is accepted now and used in Task 17.
  - `status_snapshot()["last_test"]`.
  - Route `POST /local/rivendell/test {instance_id}` → that dict, or 409.

- [ ] **Step 1: Write the failing tests.** Append to `tests/test_rivendell_channel.py`:

```python
# --- Task 6: TEST LINK ----------------------------------------------------------

def _gateway(server, answer_pings=True):
    """What Rivendell's `ws` does with a client's ping (autoPong, ws 8): echo its
    payload back in a pong. Runs until the socket closes."""
    def run():
        srv = server.makefile("rb")
        while True:
            try:
                f = wsutil.decode_frame(srv)
            except OSError:
                return
            if f is None:
                return
            if f[0] == wsutil.OP_PING and answer_pings:
                server.sendall(wsutil.encode_frame(f[1], wsutil.OP_PONG))
    threading.Thread(target=run, daemon=True).start()


def _linked(monkeypatch, answer_pings=True):
    server, client = socket.socketpair()
    w = _worker()
    monkeypatch.setattr(w, "_connect", lambda: (client, client.makefile("rb")))
    monkeypatch.setattr(w, "_catch_up", lambda: 0)
    _gateway(server, answer_pings)
    t = threading.Thread(target=w._listen, daemon=True)
    t.start()
    _wait_until(lambda: w.status == "connected")
    return w, t, server


def test_test_link_is_a_ping_pong_round_trip(monkeypatch):
    w, t, server = _linked(monkeypatch)
    try:
        res = w.test_link()
        assert res["ok"] is True and res["rtt_ms"] is not None and res["detail"] == ""
        assert w.status_snapshot()["last_test"] == res
    finally:
        w.stop()
        t.join(2)
        server.close()


def test_test_link_without_a_pong_says_so(monkeypatch):
    w, t, server = _linked(monkeypatch, answer_pings=False)
    try:
        res = w.test_link(timeout=0.2)
        assert res["ok"] is False and res["detail"] == "no pong in 0.2s"
    finally:
        w.stop()
        t.join(2)
        server.close()


def test_test_link_on_a_parked_token_redials_it_once():
    """A 4401 is any failure of Rivendell's token check, a database hiccup
    included — and a parked worker never retries on its own."""
    w = _worker(token="bad")
    w._block_on_token("token rejected by gateway (4401)")
    res = w.test_link()
    assert res["ok"] is None and w._blocked_token is None and w._wake.is_set()


def test_test_link_while_retrying_reports_the_error():
    w = _worker()
    w._set_status("error", "connection refused")
    res = w.test_link()
    assert (res["ok"], res["detail"]) == (False, "connection refused")
```

Append to `tests/test_rivendell_tasks_endpoint.py`:

```python
def test_test_link_relays_to_the_instance(monkeypatch):
    calls = []
    monkeypatch.setattr(rivendell, "test_link", lambda iid, job=False: calls.append(iid)
                        or {"ok": True, "rtt_ms": 12, "detail": "", "at": 1.0})
    r = dpost("/local/rivendell/test", {"instance_id": "a"})
    assert calls == ["a"] and r["code"] == 200 and r["obj"]["rtt_ms"] == 12


def test_test_link_on_a_connection_that_is_off_is_a_conflict(monkeypatch):
    monkeypatch.setattr(rivendell, "test_link", lambda iid, job=False: None)
    r = dpost("/local/rivendell/test", {"instance_id": "a"})
    assert r["code"] == 409 and r["obj"] == {"error": "that Rivendell connection is off"}
```

- [ ] **Step 2: Run them to see them fail**

Run: `python3 -m pytest tests/test_rivendell_channel.py tests/test_rivendell_tasks_endpoint.py -q -k test_link`
Expected: FAIL, `AttributeError: 'Worker' object has no attribute 'test_link'`, and the route answers 404 `not found`.

- [ ] **Step 3: Implement.** Constants:

```python
_TEST_TIMEOUT = 5.0       # seconds TEST LINK waits for its pong
```

`Worker.__init__`, with the break fields:

```python
        # TEST LINK: nonce -> the event its pong sets; the last outcome (Settings
        # ▸ PLUGINS shows it). The send lock keeps TEST LINK's ping (an HTTP
        # thread) from interleaving with the listener's own frames.
        self._pongs: "dict[bytes, threading.Event]" = {}
        self._send_lock = threading.Lock()
        self.last_test: "dict | None" = None
```

`status_snapshot` gains `"last_test": self.last_test,`. Replace `_send`:

```python
    def _send(self, sock: socket.socket, payload: bytes, opcode: int) -> None:
        with self._send_lock:    # TEST LINK sends from an HTTP thread
            sock.sendall(wsutil.encode_frame(payload, opcode, masked=True))
```

In `_listen`'s frame loop, after the `OP_CONT` branch, replace the trailing comment `# OP_PONG / anything else: arrival already reset `missed`.` with:

```python
                    elif opcode == wsutil.OP_PONG:
                        waiter = self._pongs.get(payload)    # TEST LINK's nonce
                        if waiter is not None:
                            waiter.set()
                    # Anything else: arrival already reset `missed`.
```

`Worker.test_link`, after `_recovered`:

```python
    def test_link(self, timeout: float = _TEST_TIMEOUT) -> dict:
        """TEST LINK: one WebSocket ping/pong round trip on the live socket. The
        gateway's `ws` (8.x, autoPong) answers every ping with a pong carrying
        the same payload, so a nonce proves the link end to end with no
        Rivendell change. Parked on a rejected token it re-dials once with that
        same token instead: Rivendell closes 4401 for ANY failure of its token
        check, a database hiccup included, and a parked worker never retries on
        its own. Anything else is reported as it stands — the listener is
        already retrying. Kept as `last_test`."""
        sock = self._sock
        if self.status == "auth_error":
            self._blocked_token = None
            self._wake.set()
            res = {"ok": None, "rtt_ms": None, "detail": "re-dialing with the saved token"}
        elif self.status != "connected" or sock is None:
            res = {"ok": False, "rtt_ms": None, "detail": self.status_detail or self.status}
        else:
            nonce, got = os.urandom(8), threading.Event()
            self._pongs[nonce] = got
            t0 = time.monotonic()
            try:
                self._send(sock, nonce, wsutil.OP_PING)
                ok = got.wait(timeout)
                res = {"ok": ok, "rtt_ms": round((time.monotonic() - t0) * 1000) if ok else None,
                       "detail": "" if ok else f"no pong in {timeout:g}s"}
            except OSError as e:
                res = {"ok": False, "rtt_ms": None, "detail": str(e)}
            finally:
                self._pongs.pop(nonce, None)
        self.last_test = {**res, "at": time.time()}
        return self.last_test
```

Module level, after `running()`:

```python
def test_link(instance_id: str, job: bool = False) -> "dict | None":
    """TEST LINK on one instance (Worker.test_link). None when it has no running
    worker (switched off or removed)."""
    with _manager_lock:
        w = _workers.get(instance_id)
    return w.test_link() if w else None
```

`bridge/dashboard/server.py`, after the `/local/rivendell/implement` block:

```python
        if path == "/local/rivendell/test":
            # TEST LINK (Settings ▸ PLUGINS, and the RIVENDELL tab's TOKEN
            # REJECTED banner): a round trip on the live socket, or a re-dial.
            res = rivendell.test_link((body.get("instance_id") or "").strip())
            if res is None:
                return self._json({"error": "that Rivendell connection is off"}, 409)
            return self._json(res)
```

- [ ] **Step 4: Run the tests**

Run: `python3 -m pytest tests/test_rivendell_channel.py tests/test_rivendell.py tests/test_rivendell_tasks_endpoint.py -q`
Expected: all PASS, including the existing `test_quiet_interval_pings_and_keeps_the_connection`.

- [ ] **Step 5: Commit**

```bash
git add bridge/rivendell.py bridge/dashboard/server.py tests/test_rivendell_channel.py tests/test_rivendell_tasks_endpoint.py
git commit -m "rivendell: TEST LINK — a ping/pong round trip on the live socket, or a re-dial of a parked token"
```

---

### Task 7: NEEDS YOU over Telegram

**Files:**
- Modify: `bridge/telegram.py`: `send` (lines 131-146) returns the last accepted message.
- Modify: `bridge/runner.py`: `_handle_control_request`, the AskUserQuestion branch (lines 1405-1409).
- Modify: `bridge/rivendell.py`: a new "NEEDS YOU over Telegram" section before `start = reconfigure` (line 1525), and the module docstring.
- Modify: `bridge/dispatch.py`:
  - `_question_callback`, after `_rivendell_callback` (line 157).
  - `on_message`, the reply routing, after the `if not text:` block (line 175).
  - `handle_callback`, the `rq:` route, after the `rv:` branch (lines 446-448).
- Test: `tests/test_telegram.py`, `tests/test_rivendell_channel.py`

**Interfaces:**
- Consumes: `live_view` (Task 3), `runner.live_job` (Task 2).
- Produces:
  - `telegram.send(...) -> dict | None`, the Message.
  - `rivendell.ping_question(job, request_id, questions) -> bool`.
  - `rivendell._question_message(sess, age_s, q, token, opts) -> (str, dict | None)`.
  - `rivendell.answer_option(token: str, i: int) -> str | None`.
  - `rivendell.answer_reply(message_id: int, text: str) -> str | bool | None`: None means not a ping, False means stale.
  - Callback data `rq:<token>:<option index>`.

- [ ] **Step 1: Write the failing tests.** Append to `tests/test_telegram.py`:

```python
def test_send_returns_the_message_that_carries_the_buttons():
    """A NEEDS YOU ping is matched to the reply that answers it by message id,
    so send() hands back the message Telegram accepted — the last chunk's, the
    one carrying the buttons."""
    sent = []

    def fake_tg(method, **params):
        sent.append(params)
        return {"message_id": len(sent)}
    telegram.tg, real = fake_tg, telegram.tg
    try:
        got = telegram.send(1, "\n".join(f"line {i}" for i in range(2000)), {"inline_keyboard": []})
    finally:
        telegram.tg = real
    assert len(sent) > 1 and got == {"message_id": len(sent)}
```

Append to `tests/test_rivendell_channel.py`:

```python
# --- Task 7: NEEDS YOU over Telegram --------------------------------------------

def _needs_you(quiet):
    _wait_until(lambda: any(m["text"].startswith("◆ Rivendell job needs you") for m in quiet))
    return next(m for m in quiet if m["text"].startswith("◆ Rivendell job needs you"))


def _held_here(jobs, origin="rivendell:test"):
    """A run of `origin` held on COLOUR, registered so runner.live_job finds it."""
    j = _held_job(sid=_session(origin=origin))
    runner._register(j)
    jobs.append(j)
    return j


def _answer_sent(j):
    return json.loads(j.proc.stdin.lines[-1])["response"]["response"]["message"]


def _token(ping):
    return ping["kb"]["inline_keyboard"][0][0]["callback_data"].split(":")[1]


def test_the_ping_reads_like_the_mockup():
    text, kb = rivendell._question_message(
        {"id": "s1", "title": "Inbox: group meeting action items by client",
         "origin": "rivendell:production"},
        9 * 60 + 5, COLOUR[0], "abc", ["Under “No client”", "Leave them out", "Ask me later"])
    assert text.splitlines()[:3] == [
        "◆ Rivendell job needs you", "Inbox: group meeting action items by client",
        "rivendell · production · running 9m · paused for you"]
    assert text.endswith(COLOUR[0]["question"])
    assert [[b["callback_data"] for b in row] for row in kb["inline_keyboard"]] == [
        ["rq:abc:0", "rq:abc:1"], ["rq:abc:2"]]


def test_a_rivendell_runs_question_pings_with_its_options(quiet, jobs):
    _held_here(jobs)
    ping = _needs_you(quiet)
    assert ping["chat"] == config.DASH_CHAT_ID
    buttons = [b for row in ping["kb"]["inline_keyboard"] for b in row]
    assert [b["text"] for b in buttons] == ["Under “No client”", "Leave them out"]
    assert all(len(b["callback_data"].encode()) <= 64 for b in buttons)


def test_any_other_sessions_question_keeps_the_generic_ping(quiet, jobs):
    _held_here(jobs, origin="dashboard")
    time.sleep(0.1)
    assert not any(m["text"].startswith("◆ Rivendell") for m in quiet)


def test_a_tap_answers_the_live_run(quiet, jobs):
    j = _held_here(jobs)
    assert rivendell.answer_option(_token(_needs_you(quiet)), 1) == "Leave them out"
    assert j.pending == [] and "Leave them out" in _answer_sent(j)


def test_a_question_answered_elsewhere_makes_the_tap_stale(quiet, jobs):
    """Review focus 1: one question, two surfaces. The second answer must say so,
    and never land on whatever the run asks next."""
    j = _held_here(jobs)
    token = _token(_needs_you(quiet))
    assert j.respond("q1", answers=[{"header": "No meeting", "labels": ["Leave them out"]}])
    assert rivendell.answer_option(token, 0) is None


def test_a_text_reply_is_a_free_answer(quiet, jobs):
    j = _held_here(jobs)
    mid = _needs_you(quiet)["mid"]
    _wait_until(lambda: mid in rivendell._ask_msgs)
    assert rivendell.answer_reply(mid, "only the ones from last week") == "only the ones from last week"
    assert "only the ones from last week" in _answer_sent(j)
    assert rivendell.answer_reply(mid, "again") is False         # its question no longer waits
    assert rivendell.answer_reply(-1, "hello") is None           # not a ping: an ordinary prompt


def test_the_option_button_answers_and_edits_the_ping(monkeypatch):
    from bridge import dispatch
    edits, acks = [], []
    monkeypatch.setattr(dispatch, "edit", lambda chat, mid, text, kb=None: edits.append(text))
    monkeypatch.setattr(dispatch, "answer_cb", lambda cid, text="": acks.append(text))
    monkeypatch.setattr(rivendell, "answer_option",
                        lambda token, i: "Leave them out" if (token, i) == ("tok", 1) else None)
    cb = {"id": "cb1", "message": {"chat": {"id": config.DASH_CHAT_ID}, "message_id": 7,
                                   "text": "◆ Rivendell job needs you"}}
    dispatch._question_callback(cb, config.DASH_CHAT_ID, 7, "rq:tok:1")
    assert edits[-1] == ("◆ Rivendell job needs you\n\n"
                         "✓ You answered: Leave them out. The run continues.")
    dispatch._question_callback(cb, config.DASH_CHAT_ID, 7, "rq:gone:0")
    assert acks[-1] == "Already answered." and edits[-1] == "◆ Rivendell job needs you"


def test_a_reply_to_a_ping_never_becomes_a_prompt(monkeypatch):
    from bridge import dispatch
    started, edits = [], []
    monkeypatch.setattr(dispatch, "handle_task", lambda *a: started.append(a))
    monkeypatch.setattr(dispatch, "send", lambda *a, **k: None)
    monkeypatch.setattr(dispatch, "edit", lambda chat, mid, text, kb=None: edits.append((mid, text)))
    monkeypatch.setattr(rivendell, "answer_reply",
                        lambda mid, text: "only last week" if mid == 41 else None)
    dispatch.on_message({"chat": {"id": 555}, "text": "only last week",    # conftest's allowed chat
                         "reply_to_message": {"message_id": 41,
                                              "text": "◆ Rivendell job needs you"}})
    assert started == []
    assert edits == [(41, "◆ Rivendell job needs you\n\n"
                          "✓ You answered: only last week. The run continues.")]


def test_a_reply_to_any_other_message_is_still_a_prompt(monkeypatch):
    """Review focus 4: replying to an ordinary bot message keeps meaning "do this"."""
    from bridge import dispatch, state
    started = []
    monkeypatch.setattr(dispatch, "handle_task", lambda *a: started.append(a))
    monkeypatch.setattr(dispatch, "send", lambda *a, **k: None)
    monkeypatch.setattr(rivendell, "answer_reply", lambda mid, text: None)
    store.init()
    dispatch.on_message({"chat": {"id": 555}, "text": "fix the header",
                         "reply_to_message": {"message_id": 42, "text": "✅ Claude finished"}})
    _wait_until(lambda: started)
    state.release_run(started[0][2]["id"])
    assert started[0][1] == "fix the header"
```

- [ ] **Step 2: Run them to see them fail**

Run: `python3 -m pytest tests/test_telegram.py tests/test_rivendell_channel.py -q -k "send_returns or ping or tap or reply or option"`
Expected: FAIL. `send` returns None, and `rivendell` has no `_question_message` / `answer_option` / `answer_reply`.

- [ ] **Step 3: Implement.** Replace `telegram.send`'s loop and give it a docstring:

```python
def send(chat_id: int, text: str, reply_markup: dict | None = None):
    """Send `text` (split on lines past TG_MAX), buttons on the last chunk.
    Returns the last message Telegram accepted — the one carrying the buttons,
    which a later reply or edit refers to — or None."""
    text = text or "(empty)"
    extra = {"reply_markup": json.dumps(reply_markup)} if reply_markup else {}
    # Margin under TG_MAX: escaping and tags only ever grow the text.
    chunks = _chunks(text, config.TG_MAX - 512) or [text]
    sent = None
    for i, raw in enumerate(chunks):
        html = _md_to_html(raw)
        params = dict(chat_id=chat_id, disable_web_page_preview="true",
                      # Buttons ride the LAST chunk: that's where reading ends.
                      **(extra if i == len(chunks) - 1 else {}))
        # Whatever outgrew the hard limit, or that Telegram rejects as malformed
        # HTML, goes as the plain markdown it sent before parse_mode existed:
        # unformatted is a worse message, dropped is a lost one.
        sent = ((len(html) <= config.TG_MAX
                 and tg("sendMessage", text=html, parse_mode="HTML", **params))
                or tg("sendMessage", text=raw[:config.TG_MAX], **params))
    return sent
```

`runner._handle_control_request`, the AskUserQuestion branch becomes:

```python
    if tool == "AskUserQuestion":
        questions = (req.get("input") or {}).get("questions", [])
        job.add_pending({"request_id": rid, "kind": "question",
                         "tool_name": tool, "questions": questions,
                         "at": time.time()})    # since when: the card's "ASKS · 3m ago"
        job.add({"type": "question", "request_id": rid, "questions": questions})
        from bridge import rivendell  # local import: rivendell reaches runner lazily too
        if rivendell.ping_question(job, rid, questions):
            return    # a Rivendell run's own ping carries the options as buttons
```

(the `else:` permission branch and the closing `notify_awaiting(...)` are unchanged). `bridge/rivendell.py`, a new section before `start = reconfigure`:

```python
# --- NEEDS YOU over Telegram ----------------------------------------------------
# A Rivendell run held on an AskUserQuestion pings the bridge's owner with the
# question's options as buttons; a tap, or a text reply to the ping, answers the
# live run (Job.respond — exactly what the session's QuestionCard sends) and the
# ping is edited to record it (bridge/dispatch.py). A short token stands for
# (session, control request) in callback_data, capped at 64 bytes; the ping's
# message id maps a reply back to the same token. Memory only: a restart ends
# the held run anyway, and its buttons then just say "already answered".
_asks: "dict[str, dict]" = {}            # token -> {sid, rid, header, options}
_ask_msgs: "dict[int, str]" = {}         # ping message id -> token
_asks_lock = threading.Lock()


def ping_question(job, request_id: str, questions: list) -> bool:
    """runner._handle_control_request's hook. A Rivendell run's question — every
    Rivendell job on this bridge, whoever requested it; the bridge's owner is
    the one who answers — pings with its options as buttons instead of the
    generic "Claude needs a question". False, sending nothing, for any other
    session, which keeps the generic ping. Never raises into the run."""
    try:
        from bridge import store                 # local import: heavy module
        sess = store.get_session(job.store_session_id) if job.store_session_id else None
        if not sess or not config.is_plugin_origin(sess.get("origin")):
            return False
        threading.Thread(target=_send_question, args=(job, request_id, questions, sess),
                         name="rivendell-ask", daemon=True).start()
        return True
    except Exception as e:  # noqa: BLE001
        print(f"rivendell: NEEDS YOU ping skipped: {e}")
        return False


def _send_question(job, request_id: str, questions: list, sess: dict) -> None:
    """The NEEDS YOU ping, off the run's stdout thread (Telegram is slow)."""
    if not config.NOTIFY_ENABLE or not config.TOKEN or not config.DASH_CHAT_ID:
        return
    from bridge import telegram                  # local import: telegram pulls state
    q = questions[0] if questions else {}
    simple = len(questions) == 1 and not q.get("multiSelect")
    opts = [o["label"] for o in q.get("options") or []
            if isinstance(o, dict) and o.get("label")] if simple else []
    token = uuid.uuid4().hex[:10]
    with _asks_lock:
        _asks[token] = {"sid": sess["id"], "rid": request_id, "options": opts,
                        "header": q.get("header") or q.get("question") or ""}
    text, kb = _question_message(sess, time.time() - job.started, q, token, opts)
    try:
        sent = telegram.send(config.DASH_CHAT_ID, text, kb)
    except Exception as e:  # noqa: BLE001 — the question still waits in the session
        print(f"rivendell: NEEDS YOU ping failed: {e}")
        return
    if sent and sent.get("message_id"):
        with _asks_lock:
            _ask_msgs[sent["message_id"]] = token


def _question_message(sess: dict, age_s: float, q: dict, token: str, opts: list) -> tuple:
    """The NEEDS YOU ping: what is asking and for how long, the question, and
    its options as buttons (two a row) above OPEN SESSION — the Mini App at that
    session, where any question can be answered. Pure but for panel_kb."""
    from bridge.telegram import panel_kb         # local import: telegram pulls state
    text = (f"◆ Rivendell job needs you\n{sess.get('title') or 'Rivendell job'}\n"
            f"{(sess.get('origin') or 'rivendell').replace(':', ' · ')} · "
            f"running {int(age_s // 60)}m · paused for you\n\n{q.get('question') or ''}")
    rows = [[{"text": o[:60], "callback_data": f"rq:{token}:{i}"}
             for i, o in enumerate(opts) if k <= i < k + 2] for k in range(0, len(opts), 2)]
    rows += (panel_kb(config.DASH_CHAT_ID, sess["id"], sess.get("project"),
                      "Open session ↗") or {}).get("inline_keyboard", [])
    return text, ({"inline_keyboard": rows} if rows else None)


def _answer(token: str, labels: list, notes: str = "") -> "str | None":
    """Answer the held question behind `token` on its live run. What was
    answered, or None when it no longer waits — answered elsewhere, or the run
    ended — so a stale tap can never answer the run's next question."""
    with _asks_lock:
        a = _asks.pop(token, None)
    if a is None:
        return None
    from bridge import runner                    # local import: heavy module
    job = runner.live_job(a["sid"])
    ans = {"header": a["header"], "labels": labels, **({"notes": notes} if notes else {})}
    if job is None or not job.respond(a["rid"], answers=[ans]):
        return None
    return ", ".join(labels) or notes


def answer_option(token: str, i: int) -> "str | None":
    """A tap on the ping's i-th option button (bridge/dispatch.py)."""
    with _asks_lock:
        opts = (_asks.get(token) or {}).get("options") or []
    return _answer(token, [opts[i]]) if 0 <= i < len(opts) else None


def answer_reply(message_id: int, text: str) -> "str | bool | None":
    """A text reply to a NEEDS YOU ping: a free answer to its question, for when
    no option fits or there were none. None when `message_id` isn't one of
    those pings (the reply is an ordinary prompt); False when its question no
    longer waits."""
    with _asks_lock:
        token = _ask_msgs.get(message_id)
    if token is None:
        return None
    return _answer(token, [], notes=text) or False
```

Add to the module docstring's channel paragraph: "A Rivendell run's question pings Telegram with its options as buttons (ping_question); a tap or a text reply answers the live run."

`bridge/dispatch.py`, after `_rivendell_callback`:

```python
def _question_callback(cb: dict, chat_id: int, msg_id: int, data: str) -> None:
    """An option button on a Rivendell NEEDS YOU ping (rivendell.ping_question):
    answer the question its run is held on, and turn the ping into the record of
    the answer. A stale tap (answered elsewhere, or the run ended) just loses
    the buttons."""
    from bridge import rivendell
    _, token, idx = data.split(":", 2)
    said = rivendell.answer_option(token, int(idx) if idx.isdigit() else -1)
    text = (cb["message"].get("text") or "").strip()
    if said is None:
        answer_cb(cb["id"], "Already answered.")
        edit(chat_id, msg_id, text)
        return
    answer_cb(cb["id"], "Answered — the run continues.")
    edit(chat_id, msg_id, f"{text}\n\n✓ You answered: {said}. The run continues.")
```

In `on_message`, right after the `if not text: … return` block:

```python
    # A text reply to a Rivendell NEEDS YOU ping answers its question (free text,
    # for when none of the options fit). It is not a prompt.
    replied = msg.get("reply_to_message") or {}
    if replied.get("message_id") and not text.startswith("/"):
        from bridge import rivendell
        said = rivendell.answer_reply(replied["message_id"], text)
        if said is False:
            send(chat_id, "That question was already answered, or its run ended.")
            return
        if said:
            edit(chat_id, replied["message_id"],
                 f"{(replied.get('text') or '').strip()}\n\n"
                 f"✓ You answered: {said}. The run continues.")
            return
```

In `handle_callback`, after the `rv:` branch:

```python
    elif data.startswith("rq:"):
        threading.Thread(target=_question_callback,
                         args=(cb, chat_id, msg_id, data), daemon=True).start()
```

- [ ] **Step 4: Run the tests**

Run: `python3 -m pytest tests/test_telegram.py tests/test_rivendell_channel.py tests/test_bridge.py tests/test_fallback_commands.py -q`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge/telegram.py bridge/runner.py bridge/rivendell.py bridge/dispatch.py tests/test_telegram.py tests/test_rivendell_channel.py
git commit -m "rivendell: NEEDS YOU pings Telegram with the options as buttons; a tap or a reply answers the live run"
```

---

### Task 8: One "job done" ping per Rivendell job

**Files:**
- Modify: `bridge/runner.py`: `_plugin_session` before `notify_awaiting` (line 1092), and a guard in `notify_turn_done` and `notify_needs_you` (lines 1099-1111).
- Modify: `bridge/rivendell.py`: `_post_result` (lines 368-385), new `Worker._ping_done`, and module `_done_message` beside `_question_message`.
- Test: `tests/test_rivendell_channel.py`

**Interfaces:**
- Consumes: `_result_view(sid, checks=False)` (Task 4), `store.sessions_for_refs` (Task 1).
- Produces: `runner._plugin_session(session_id) -> bool`; `Worker._ping_done(request_id, ok, text)`; `rivendell._done_message(sess, ok, text, res) -> (str, dict | None)`.

- [ ] **Step 1: Write the failing tests** (append):

```python
# --- Task 8: one "job done" ping per job ----------------------------------------

def test_a_finished_job_pings_once_with_its_pr_and_time(quiet, workers):
    sid = _session()
    rid = uuid.uuid4().hex
    store.set_ref(sid, f"ch:{rid}")
    _turn(sid, elapsed=38 * 60, result="Opened https://github.com/acme/app/pull/128")
    w = _worker()
    w._api = lambda path, payload=None: {}
    w._post_result("implementation-requests", rid, True, "summary")
    (ping,) = [m for m in quiet if m["text"].startswith("✓ Rivendell job done")]
    assert ping["text"].splitlines()[1:] == ["Inbox: group meeting action items by client",
                                             "rivendell · test · PR #128 · 38m"]
    assert ping["kb"]["inline_keyboard"][0][0] == {
        "text": "Open PR ↗", "url": "https://github.com/acme/app/pull/128"}


def test_a_failed_job_names_why(quiet, workers):
    sid = _session()
    rid = uuid.uuid4().hex
    store.set_ref(sid, f"ch:{rid}")
    _turn(sid, status="error", elapsed=21 * 60, error="⏱️ No output for 30 min — killed as hung.")
    w = _worker()
    w._api = lambda path, payload=None: {}
    w._post_result("implementation-requests", rid, False, "run killed after 1800s of silence")
    (ping,) = [m for m in quiet if m["text"].startswith("✕ Rivendell job failed")]
    assert ping["text"].splitlines()[2] == "rivendell · test · KILLED AS HUNG · 21m"


def test_a_job_that_never_ran_here_pings_nothing(quiet):
    w = _worker()
    w._api = lambda path, payload=None: {}
    w._post_result("implementation-requests", uuid.uuid4().hex, False, "no local checkout")
    assert not [m for m in quiet if "Rivendell job" in m["text"]]


def test_a_rivendell_session_skips_the_generic_turn_pings(monkeypatch):
    notes = []
    monkeypatch.setattr(runner, "_notify", lambda chat, text, kb=None: notes.append(text))
    runner.notify_turn_done(config.DASH_CHAT_ID, _session(), False)
    runner.notify_needs_you(config.DASH_CHAT_ID, _session(), "pick one")
    assert notes == []
    runner.notify_turn_done(config.DASH_CHAT_ID, _session(origin="dashboard"), False)
    assert len(notes) == 1
```

- [ ] **Step 2: Run them to see them fail**

Run: `python3 -m pytest tests/test_rivendell_channel.py -q -k "ping or generic_turn"`
Expected: FAIL. No "Rivendell job done" message is sent, and the generic ping fires for a Rivendell session.

- [ ] **Step 3: Implement.** `bridge/runner.py`, before `notify_awaiting`:

```python
def _plugin_session(session_id: str | None) -> bool:
    """A Rivendell run's session. Its worker pings once per JOB
    (rivendell.Worker._ping_done), so the per-turn pings stay quiet for it —
    a queue-mode batch would otherwise ping once per step, and an autonomous
    run's closing question is for its requester, in Rivendell.
    ponytail: by origin, so a turn you later send by hand in such a session
    pings nothing either; tell them apart if that ever matters."""
    sess = store.get_session(session_id) if session_id else None
    return bool(sess) and config.is_plugin_origin(sess.get("origin"))
```

Add `if _plugin_session(session_id): return` as the first line of `notify_turn_done` and of `notify_needs_you`.

`bridge/rivendell.py`, `_post_result`: change the loop's `return` after a successful POST to `break`, and call the ping after the loop:

```python
        for i, delay in enumerate((0,) + _RESULT_RETRIES):
            if delay:
                time.sleep(delay)
            try:
                self._api(f"/plugin/{kind_path}/{request_id}/result", payload)
                break
            except Exception as e:  # noqa: BLE001 — retried; loud on final failure
                if i == len(_RESULT_RETRIES):
                    print(f"rivendell[{self.name}]: result POST failed for "
                          f"{request_id}: {e} (transcript still in dashboard)")
        self._ping_done(request_id, ok, text)
```

New `Worker._ping_done`, after `_post_result`:

```python
    def _ping_done(self, request_id: str, ok: bool, text: str) -> None:
        """The job's one Telegram message once its result is posted: done or
        failed, its PR and time, with OPEN PR and OPEN SESSION. Only for a job
        that ran here (a session is filed under it); checks are left out — they
        have only just started. Best-effort: a lost ping never fails a result."""
        try:
            from bridge import store                 # local import: heavy module
            ref = f"{self.id}:{request_id}"
            sid = store.sessions_for_refs([ref]).get(ref)
            if sid is None:
                return
            sess = store.get_session(sid) or {"id": sid}
            msg, kb = _done_message(sess, ok, text, _result_view(sid, checks=False) or {})
            self._deliver_telegram(msg, kb)
        except Exception as e:  # noqa: BLE001
            print(f"rivendell[{self.name}]: done ping failed for {request_id}: {e}")
```

Module level, beside `_question_message`:

```python
def _done_message(sess: dict, ok: bool, text: str, res: dict) -> tuple:
    """A finished job's ping: done or failed, its title, and one line — where it
    came from, its PR, why it failed, how long it took — over OPEN PR and OPEN
    SESSION. Pure but for panel_kb."""
    from bridge.telegram import panel_kb         # local import: telegram pulls state
    pr = res.get("pr")
    why = None if ok else ((res.get("outcome") or {}).get("label")
                           or (text.strip().splitlines() or ["failed"])[0][:80])
    mins = round((res.get("wall_s") or 0) / 60)
    line = " · ".join(b for b in ((sess.get("origin") or "rivendell").replace(":", " · "),
                                  f"PR #{pr['number']}" if pr else "", why or "",
                                  f"{mins}m" if mins else "") if b)
    head = "✓ Rivendell job done" if ok else "✕ Rivendell job failed"
    row = [{"text": "Open PR ↗", "url": pr["url"]}] if pr else []
    row += [b for r in (panel_kb(config.DASH_CHAT_ID, sess.get("id"), sess.get("project"),
                                 "Open session ↗") or {}).get("inline_keyboard", []) for b in r]
    return (f"{head}\n{sess.get('title') or 'Rivendell job'}\n{line}",
            {"inline_keyboard": [row]} if row else None)
```

- [ ] **Step 4: Run the tests**

Run: `python3 -m pytest tests/test_rivendell_channel.py tests/test_rivendell.py tests/test_bridge.py -q`
Expected: all PASS. The existing `_post_result` tests stub `_api`; jobs that never ran here ping nothing.

- [ ] **Step 5: Commit**

```bash
git add bridge/runner.py bridge/rivendell.py tests/test_rivendell_channel.py
git commit -m "rivendell: one Telegram ping per finished job, with its PR and time; Rivendell sessions skip the per-turn pings"
```

---

### Task 9: Dashboard client: channel types, TEST LINK call, card and chip logic

**Files:**
- Modify: `bridge/dashboard/web/src/api.ts`: `RivendellStatus` (lines 376-384), `RivendellTask` (433-453), `RivendellTasks` (454-462), new types after `RivendellTask`, and `rivendellTest` after `rivendellImplement` (line 1555).
- Modify: `bridge/dashboard/web/src/lib/surfaces.ts`: `kilo` after `fmtDuration` (line 218).
- Modify: `bridge/dashboard/web/src/components/hud/SpendPanel.tsx`: delete the local `kilo` (lines 22-26) and import it.
- Modify: `bridge/dashboard/web/src/lib/rivendelltasks.ts`
- Test: `bridge/dashboard/web/src/lib/rivendelltasks.check.ts`

**Interfaces:**
- Produces (TS):
  - Types `RivendellTest`, `RivendellLink`, `RivendellAsk`, `RivendellRun`.
  - `RivendellStatus` gains `down_since`, `alert_at`, `attempt`, `retry_at`, `last_test`.
  - `RivendellTask` gains `stale`, `run`; `RivendellTasks` gains `links`.
  - `api.rivendellTest(instance_id)`.
  - `kilo(n)`.
  - From `lib/rivendelltasks.ts`: `since(sec, now)`, `linkChip(s, now) -> {label, tone: LinkTone}`, `closeCode(detail)`, `resultBits(r)`, `groupTasks(tasks)`, `linkAlertText(inst)`, `testText(t)`.

- [ ] **Step 1: Write the failing checks.** Append to `src/lib/rivendelltasks.check.ts`, and add `closeCode, groupTasks, linkAlertText, linkChip, resultBits, testText` to its import line:

```ts
import type { RivendellStatus } from "../api";

// --- the channel (docs/superpowers/specs/rivendell-channel.md) ---
const nowS = today.getTime() / 1000;
const st = (s: Partial<RivendellStatus>) => ({ state: "off", ...s }) as RivendellStatus;

eq(linkChip(st({ state: "connected", last_event_at: nowS - 12 * 60 }), today), { label: "LINKED · 12m", tone: "ok" },
  "linked names the time since the last job");
eq(linkChip(st({ state: "connected" }), today), { label: "LINKED", tone: "ok" }, "no job seen since the restart: just LINKED");
eq(linkChip(st({ state: "connecting" }), today), { label: "CONNECTING…", tone: "warn" }, "dialing");
eq(linkChip(st({ state: "error", attempt: 3, retry_at: nowS + 20 }), today), { label: "RETRY 3 · 20s", tone: "warn" },
  "retrying counts the attempt and the wait");
eq(linkChip(st({ state: "auth_error" }), today), { label: "TOKEN REJECTED", tone: "err" }, "a rejected token is its own red state");
eq(linkChip(undefined, today), { label: "OFF", tone: "off" }, "no worker: OFF");

eq(closeCode("token rejected by gateway (4401 Invalid or revoked token)"), "4401", "the gateway's close code");
eq(closeCode("token rejected at handshake: HTTP/1.1 401 Unauthorized"), "401", "a proxy's status");
eq(closeCode("connection refused"), null, "no code, no badge");

eq(resultBits({ wall_s: 38 * 60, tokens: { in: 1_150_000, out: 50_000 },
  pr: { number: 128, url: "https://github.com/a/b/pull/128", checks: "pass" }, outcome: null }),
  { pr: { label: "PR #128", url: "https://github.com/a/b/pull/128", checks: "✓ checks" }, rest: "38m · 1.20M tok", outcome: null },
  "done: PR, checks, time, tokens");
eq(resultBits({ wall_s: 1260, tokens: null, pr: null,
  outcome: { code: "timeout", label: "KILLED AS HUNG", detail: "no output for 30 min" } })?.outcome,
  "KILLED AS HUNG — no output for 30 min", "failed: the transcript's own outcome label");
eq(resultBits(null), null, "no session here: no line");

const tk = (id: string, mine: boolean, asks = false) => ({ id, mine,
  run: asks ? { ask: { job_id: "j", request_id: "q", at: null, question: "?", header: "h", options: [], simple: true } } : null }) as never;
const g = groupTasks([tk("a", true), tk("b", false, true), tk("c", false)]);
eq([g.needs, g.mine, g.team].map((x: { id: string }[]) => x.map((t) => t.id)), [["b"], ["a"], ["c"]],
  "a question jumps the list; the rest stay mine / team");

ok(linkAlertText({ name: "production", status: st({ state: "auth_error" }) }).includes("refused this bridge's token"),
  "the bell names a rejected token");
ok(linkAlertText({ name: "production", status: st({ state: "error" }) }).includes("unreachable"),
  "and an outage");

eq(testText(null), "never tested", "no test yet");
eq(testText({ ok: true, rtt_ms: 182, detail: "", at: 1 }), "✓ round trip 182 ms", "a pong");
eq(testText({ ok: false, rtt_ms: null, detail: "no pong in 5s", at: 1 }), "✕ no pong in 5s", "no pong");
eq(testText({ ok: null, rtt_ms: null, detail: "re-dialing with the saved token", at: 1 }),
  "↻ re-dialing with the saved token", "a parked token re-dials");
```

- [ ] **Step 2: Run the check to see it fail**

Run (from `bridge/dashboard/web`): `node --experimental-strip-types src/lib/rivendelltasks.check.ts`
Expected: FAIL, `SyntaxError: The requested module './rivendelltasks.ts' does not provide an export named 'closeCode'`.

- [ ] **Step 3: Implement.** In `src/api.ts`, extend `RivendellStatus`:

```ts
  // The current break (bridge/rivendell.py Worker._set_status): when it began,
  // and when it was flagged — once per break, cleared when the link proves
  // itself. alert_at drives the castle's dot and the bell.
  down_since?: number | null;
  alert_at?: number | null;
  attempt?: number;                  // failed dials in a row
  retry_at?: number | null;          // epoch seconds of the next dial
  last_test?: RivendellTest | null;  // TEST LINK's last outcome
```

and after `RivendellTask` add:

```ts
/** TEST LINK's outcome (POST /local/rivendell/test). ok null = re-dialing a
 *  parked token; the chip shows how that went. */
export interface RivendellTest {
  ok: boolean | null;
  rtt_ms: number | null;
  detail: string;
  at: number;                // epoch seconds
}
/** One connection's state on the RIVENDELL tab: its instance and its status. */
export type RivendellLink = RivendellStatus & { instance_id: string; instance: string };
/** A question a Rivendell run is held on (bridge/rivendell.py live_view). */
export interface RivendellAsk {
  job_id: string;            // answer with api.respond(job_id, …)
  request_id: string;
  at: number | null;         // when it started waiting
  question: string;
  header: string;            // the AnswerSelection header
  options: string[];
  simple: boolean;           // one single-choice question: its options can be buttons
}
/** What this bridge knows about the run behind a card (bridge/rivendell.py _run_view). */
export interface RivendellRun {
  live?: { line: string; steps: number; todos: { done: number; total: number } | null };
  ask?: RivendellAsk | null;
  result?: {
    wall_s: number;
    tokens: { in: number; out: number } | null;
    pr: { number: number; url: string; checks?: "pass" | "fail" | "pending" | null } | null;
    outcome: { code: string; label: string; detail: string } | null;
  } | null;
}
```

Add to `RivendellTask`:

```ts
  stale?: boolean;           // its instance failed: the last good answer, shown dimmed
  run?: RivendellRun | null; // what this bridge knows about its run, when it ran here
```

and to `RivendellTasks`: `links?: RivendellLink[];  // each connection's state, for the chip and banner`. After `rivendellImplement`:

```ts
  // TEST LINK: a ping/pong round trip on the live socket, or a re-dial of a
  // parked token (bridge/rivendell.py Worker.test_link). 409 when it's off.
  rivendellTest: (instance_id: string) =>
    req<RivendellTest>("/local/rivendell/test", { method: "POST", body: { instance_id } }),
```

In `src/lib/surfaces.ts`, after `fmtDuration`:

```ts
/** "950" / "12.3k" / "1.20M" — a token count at a glance (SPEND, RIVENDELL). */
export function kilo(n: number): string {
  if (n < 1000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}
```

In `SpendPanel.tsx`, delete its local `function kilo` (lines 22-26) and add `import { kilo } from "../../lib/surfaces";`.

In `src/lib/rivendelltasks.ts`, change the imports to:

```ts
import type { RivendellRun, RivendellStatus, RivendellTask, RivendellTest } from "../api";
import { fmtDuration, kilo } from "./surfaces.ts";
```

and append:

```ts
/** Epoch seconds as the tab's short age: "now", "12m", "3h", "2d" ("" for none). */
export function since(sec: number | null | undefined, now: Date): string {
  if (!sec) return "";
  const a = age(new Date(sec * 1000).toISOString(), now);
  return a === "just now" ? "now" : a;
}

export type LinkTone = "ok" | "warn" | "err" | "off";

/** The connection chip beside the project name — one state per riStatusView
 *  state (SettingsModal), in the tab's words (spec §B). */
export function linkChip(s: RivendellStatus | undefined, now: Date): { label: string; tone: LinkTone } {
  switch (s?.state) {
    case "connected": {
      const last = since(s.last_event_at, now);
      return { label: last ? `LINKED · ${last}` : "LINKED", tone: "ok" };
    }
    case "connecting": return { label: "CONNECTING…", tone: "warn" };
    case "error": {
      const wait = s.retry_at ? Math.max(0, Math.round(s.retry_at - now.getTime() / 1000)) : null;
      return { label: `RETRY ${s.attempt || 1}${wait === null ? "" : ` · ${wait}s`}`, tone: "warn" };
    }
    case "auth_error": return { label: "TOKEN REJECTED", tone: "err" };
    default: return { label: "OFF", tone: "off" };
  }
}

/** The close code (4401/4403) or HTTP status (401/403) a token rejection's
 *  detail carries, for the TOKEN REJECTED banner. */
export function closeCode(detail: string | undefined): string | null {
  return /\b(4\d\d\d?)\b/.exec(detail ?? "")?.[1] ?? null;
}

const CHECKS: Record<string, string> = { pass: "✓ checks", fail: "✕ checks", pending: "◷ checks" };

/** A finished run's line: the PR its summary names (with its checks), wall time
 *  and tokens; for a failure, the outcome the transcript shows (bridge/outcomes.py). */
export function resultBits(r: RivendellRun["result"] | undefined): {
  pr: { label: string; url: string; checks: string | null } | null; rest: string; outcome: string | null;
} | null {
  if (!r) return null;
  const tok = r.tokens ? r.tokens.in + r.tokens.out : 0;
  return {
    pr: r.pr ? { label: `PR #${r.pr.number}`, url: r.pr.url, checks: CHECKS[r.pr.checks ?? ""] ?? null } : null,
    rest: [r.wall_s > 0 ? fmtDuration(r.wall_s) : "", tok ? `${kilo(tok)} tok` : ""].filter(Boolean).join(" · "),
    outcome: r.outcome ? `${r.outcome.label}${r.outcome.detail ? ` — ${r.outcome.detail}` : ""}` : null,
  };
}

/** NEEDS YOU first — a run held on a question jumps the list — then YOURS and TEAM. */
export function groupTasks<T extends Pick<RivendellTask, "mine" | "run">>(tasks: T[]) {
  const rest = tasks.filter((t) => !t.run?.ask);
  return { needs: tasks.filter((t) => t.run?.ask), mine: rest.filter((t) => t.mine), team: rest.filter((t) => !t.mine) };
}

/** The bell's line for a broken link (App, once per break). */
export function linkAlertText(i: { name: string; status?: RivendellStatus }): string {
  const at = i.status?.down_since ? new Date(i.status.down_since * 1000).toTimeString().slice(0, 5) : "";
  return i.status?.state === "auth_error"
    ? `Rivendell ${i.name} refused this bridge's token${at ? ` at ${at}` : ""}. Jobs are paused until you replace it.`
    : `Rivendell ${i.name} unreachable${at ? ` since ${at}` : ""}. The bridge keeps retrying.`;
}

/** TEST LINK's last outcome in words (Settings ▸ PLUGINS, the tab's banner). */
export function testText(t: RivendellTest | null | undefined): string {
  if (!t) return "never tested";
  if (t.ok === null) return `↻ ${t.detail}`;
  return t.ok ? `✓ round trip ${t.rtt_ms} ms` : `✕ ${t.detail}`;
}
```

- [ ] **Step 4: Run the checks and the typecheck**

Run (from `bridge/dashboard/web`):
`node --experimental-strip-types src/lib/rivendelltasks.check.ts && node --experimental-strip-types src/lib/surfaces.check.ts && node_modules/.bin/tsc -p tsconfig.app.json`
Expected: every `ok -` line passes. tsc reports only the pre-existing `Markdown.tsx(4,26) … 'remark-breaks'` error.

- [ ] **Step 5: Commit**

```bash
git add bridge/dashboard/web/src/api.ts bridge/dashboard/web/src/lib/surfaces.ts bridge/dashboard/web/src/components/hud/SpendPanel.tsx bridge/dashboard/web/src/lib/rivendelltasks.ts bridge/dashboard/web/src/lib/rivendelltasks.check.ts
git commit -m "web: the Rivendell channel's client types and its chip, banner and card logic"
```

---

### Task 10: The RIVENDELL tab: chip, banner, NEEDS YOU, live and result lines

**Files:**
- Modify: `bridge/dashboard/web/src/lib/opensettings.ts` (whole file).
- Modify: `bridge/dashboard/web/src/components/hud/RivendellTasks.tsx` (whole file).
- Modify: `bridge/dashboard/web/src/components/hud/SettingsModal.tsx`: `RivendellPanel`'s `editing` state (line 2555), plus an import.
- Test: tsc, the check scripts, and screenshots (bridge-eyes).

**Interfaces:**
- Consumes: everything from Task 9; `api.respond` (existing, `api.ts:1355`); `hhmm` (`lib/surfaces.ts:164`).
- Produces: `openSettings(tab: string, focus?: string)`; `takeSettingsFocus(): string | null`.

- [ ] **Step 1: Give the worktree its own web install** (needed to build; the shared one lacks `remark-breaks`). From `bridge/dashboard/web`:

```bash
test -L node_modules && rm node_modules    # removes the link only; the main checkout's modules stay
npm ci
node_modules/.bin/tsc -p tsconfig.app.json && echo TSC-CLEAN
```

Expected: `TSC-CLEAN`. From here on tsc must exit 0. npm may warn that esbuild's postinstall script needs approval; `vite build` works without it.

- [ ] **Step 2: `src/lib/opensettings.ts`**, the whole file:

```ts
/** Open SETTINGS on one tab from anywhere in the tree — and, for PLUGINS,
 *  straight into editing one connection (the RIVENDELL tab's REPLACE TOKEN,
 *  the bell's broken-link entry).
 *
 *  ponytail: a window event rather than a prop threaded App → Terminal →
 *  Transcript → TurnBlock. The callers are a dead-login badge four layers
 *  down and the RIVENDELL tab's buttons; the only listener is App. The focus
 *  rides a module variable the panel takes once, on mount. Make it a context
 *  when a caller needs more than a tab and an id. */
let focus: string | null = null;

export function openSettings(tab: string, what?: string) {
  focus = what ?? null;
  window.dispatchEvent(new CustomEvent("hud:settings", { detail: tab }));
}

/** What openSettings asked the tab to open on (an instance id) — once. */
export function takeSettingsFocus(): string | null {
  const f = focus;
  focus = null;
  return f;
}
```

In `SettingsModal.tsx`, add `import { takeSettingsFocus } from "../../lib/opensettings";` and in `RivendellPanel` change the `editing` state to open on the instance REPLACE TOKEN named:

```tsx
  const [editing, setEditing] = useState<string | null>(() => takeSettingsFocus());   // instance id, "new", or null
```

- [ ] **Step 3: `src/components/hud/RivendellTasks.tsx`**, the whole file:

```tsx
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Castle, ListTodo, Play } from "lucide-react";
import type { RivendellLink, RivendellTask, RivendellTasks as TasksAnswer } from "../../api";
import { api } from "../../api";
import { openSettings } from "../../lib/opensettings";
import {
  cardState, closeCode, dueLabel, groupTasks, initials, linkChip, resultBits, since, testText,
  type CardTone, type LinkTone,
} from "../../lib/rivendelltasks";
import { hhmm } from "../../lib/surfaces";
import { askConfirm } from "../ui/Ask";

const POLL_MS = 10_000;

const TONE: Record<CardTone, string> = {
  warn: "var(--warn)", acc: "var(--acc)", ok: "var(--ok)", err: "var(--err)", "": "var(--txl)",
};
const LINK_TONE: Record<LinkTone, string> = {
  ok: "var(--ok)", warn: "var(--warn)", err: "var(--err)", off: "var(--txd)",
};
// A checks word's colour, by its glyph (lib/rivendelltasks resultBits).
const CHECK_TONE: Record<string, string> = { "✓": "var(--ok)", "✕": "var(--err)", "◷": "var(--warn)" };

const toolBtn = {
  appearance: "none", cursor: "pointer", background: "transparent", color: "var(--txm)",
  border: "1px solid color-mix(in srgb, var(--acc) 20%, transparent)", fontFamily: "inherit",
  fontSize: "var(--t95)", lineHeight: 1.3, padding: "2px 6px",
} as const;

/** RIVENDELL — the open Rivendell tasks for the open session's repo, as cards,
 *  with what this bridge knows about each one's run: the question it is held
 *  on (NEEDS YOU, answered right here, resuming the same session), what it is
 *  doing, what came back. IMPLEMENT is Rivendell's own "Implement using AI":
 *  the request comes back to this bridge and runs through the PLUGINS queue
 *  like any other. The link's state sits beside the project name; a rejected
 *  token pauses the tab behind a banner and dims the cards to what was last
 *  known. Polls while showing — request states change with no dashboard event
 *  to announce it. Design: docs/superpowers/specs/rivendell-tasks-tab.md, then
 *  docs/superpowers/specs/rivendell-channel.md. */
export function RivendellTasks({ project, onOpenSession }: {
  project: string | null;
  onOpenSession: (id: string) => void;
}) {
  const [data, setData] = useState<TasksAnswer | null>(null);
  const [fail, setFail] = useState<string | null>(null);
  const [now, setNow] = useState(() => new Date());
  const [busy, setBusy] = useState<Set<string>>(new Set());
  // task id -> the request IMPLEMENT just created, shown QUEUED until the list
  // catches up with it; task id -> why IMPLEMENT (or an answer) failed.
  const [queued, setQueued] = useState<Record<string, string>>({});
  const [errs, setErrs] = useState<Record<string, string>>({});
  const [hov, setHov] = useState("");
  // TEST LINK on the TOKEN REJECTED banner: the connection being tested, and
  // what each test said.
  const [testing, setTesting] = useState("");
  const [tested, setTested] = useState<Record<string, string>>({});

  const load = useCallback(() => {
    if (!project) return;
    api.rivendellTasks(project)
      .then((r) => {
        setData(r); setFail(null); setNow(new Date());
        // Once the list has shown a request, the list is the truth about it.
        const listed = new Set(r.tasks.map((t) => t.implementation?.id));
        setQueued((q) => Object.fromEntries(Object.entries(q).filter(([, rid]) => !listed.has(rid))));
      })
      .catch((e: Error) => setFail(e.message));
  }, [project]);

  useEffect(() => {
    load();
    const t = setInterval(load, POLL_MS);
    return () => clearInterval(t);
  }, [load]);

  const unbusy = (id: string) => setBusy((b) => { const n = new Set(b); n.delete(id); return n; });

  async function implement(t: RivendellTask) {
    const yes = await askConfirm(
      `Implement “${t.name}” with AI? It runs on this bridge without permission prompts, ` +
      "pushes a branch and opens a pull request; the result is posted to the task in Rivendell.");
    if (!yes) return;
    setBusy((b) => new Set(b).add(t.id));
    setErrs((m) => { const n = { ...m }; delete n[t.id]; return n; });
    try {
      const r = await api.rivendellImplement(t.instance_id, t.id);
      setQueued((q) => ({ ...q, [t.id]: r.request.id }));
      load();
    } catch (e) {
      setErrs((m) => ({ ...m, [t.id]: (e as Error).message }));
    } finally {
      unbusy(t.id);
    }
  }

  /** NEEDS YOU, answered from the card: the session's own answer route, so it
   *  resumes the same run exactly as its QuestionCard would. */
  async function answer(t: RivendellTask, label: string) {
    const ask = t.run?.ask;
    if (!ask) return;
    setBusy((b) => new Set(b).add(t.id));
    setErrs((m) => { const n = { ...m }; delete n[t.id]; return n; });
    try {
      await api.respond(ask.job_id, { request_id: ask.request_id, answers: [{ header: ask.header, labels: [label] }] });
      load();
    } catch (e) {
      setErrs((m) => ({ ...m, [t.id]: (e as Error).message }));
    } finally {
      unbusy(t.id);
    }
  }

  async function test(iid: string) {
    setTesting(iid);
    try {
      setTested((m) => ({ ...m, [iid]: "" }));
      const r = await api.rivendellTest(iid);
      setTested((m) => ({ ...m, [iid]: testText(r) }));
      load();
    } catch (e) {
      setTested((m) => ({ ...m, [iid]: `✕ ${(e as Error).message}` }));
    } finally {
      setTesting("");
    }
  }

  const projects = data?.projects ?? [];
  const links = data?.links ?? [];
  const names = [...new Set(projects.map((p) => p.name))].join(" · ") || links.map((l) => l.instance).join(" · ");

  return (
    <div className="panel" style={{ border: "1px solid color-mix(in srgb, var(--acc) 16%, transparent)", background: "color-mix(in srgb, var(--panel) 86%, transparent)", display: "flex", flexDirection: "column", flex: 1, minHeight: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 12px" }}>
        <span style={{ fontSize: "var(--t105)", letterSpacing: 2.5, color: "var(--txl)" }}>RIVENDELL</span>
        <span style={{ display: "flex", gap: 6 }}>
          {projects[0]?.url && (
            <button style={toolBtn} title="Open the project in Rivendell"
              onClick={() => window.open(projects[0].url, "_blank", "noopener")}>↗</button>
          )}
          <button style={toolBtn} title="refresh" onClick={load}>⟳</button>
        </span>
      </div>
      <div style={{ height: 1, background: "linear-gradient(90deg,var(--acc),transparent)" }} />
      {names && (
        <div className="swapin" style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 12px 2px", fontSize: "var(--t95)", color: "var(--purple-h)", minWidth: 0 }}>
          <span style={{ color: "var(--purple)", flex: "none" }}>◆</span>
          <span style={{ whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{names}</span>
          {links.map((l) => <Chip key={l.instance_id} link={l} now={now} />)}
          <span style={{ marginLeft: "auto", flex: "none", color: "var(--txl)" }}>{data?.tasks.length ?? 0} OPEN</span>
        </div>
      )}
      <div className="mscroll" style={{ flex: 1, minHeight: 0, padding: "4px 0 10px" }}>
        {body()}
      </div>
    </div>
  );

  function body(): ReactNode {
    // A dashboard built from newer code than the running bridge: the route is
    // missing, and the catch-all answers 404 "not found" (see SpendPanel).
    if (fail === "not found") return <Empty title="The bridge needs a restart" text="This dashboard is newer than the running bridge, which can't list Rivendell tasks yet." />;
    if (fail) return <Empty title="Couldn't read the task list" text={fail} />;
    if (!data) return [100, 100, 60].map((w, i) => <div key={i} style={{ height: 30, margin: "8px 12px", width: `calc(${w}% - 24px)`, background: "color-mix(in srgb, var(--acc) 7%, transparent)" }} />);
    if (data.slug === null) return <Empty title="No GitHub origin" text="This checkout has no GitHub origin remote, so there is no repo to look up in Rivendell." />;
    if (data.instances === 0) return <Empty title="Rivendell connection is off" text="Switch a Rivendell connection on, and this repo's tasks show up here." settings />;
    const paused = links.filter((l) => l.state === "auth_error").map((l) => (
      <Paused key={l.instance_id} link={l} testing={testing === l.instance_id}
        note={tested[l.instance_id]} onTest={() => void test(l.instance_id)} />
    ));
    const err = data.errors[0];
    if (!data.tasks.length && err) {
      if (err.error === "token_rejected") {
        return paused.length ? paused : <Empty title="Rivendell refused the token" text="Mint a new one in Rivendell under Profile → API tokens (LLM), then paste it into the connection." settings />;
      }
      if (err.error === "not_deployed") return <Empty title="This Rivendell can't list tasks yet" text="Its API is older than this tab. The task routes arrive with its next deploy." />;
      return <Empty title={err.error === "unreachable" ? "Rivendell is unreachable" : "Rivendell said no"} text={err.detail} />;
    }
    if (!projects.length) return <>{paused}<Empty title="No Rivendell project links this repo" text={<>Nothing in Rivendell links <code style={{ color: "var(--purple-h)" }}>{data.slug}</code>. Link it to a project there and its tasks show up here.</>} /></>;
    if (!data.tasks.length) return <>{paused}<Empty icon={<ListTodo size={26} strokeWidth={1.3} />} title="No open tasks" text={`Every task of ${names} is done.`} /></>;
    const g = groupTasks(data.tasks);
    const last = data.tasks.some((t) => t.stale) ? " · LAST KNOWN" : "";
    return (
      <>
        {paused}
        {data.errors.filter((e) => e.error !== "token_rejected").map((e) => (
          <div key={e.instance_id} style={{ margin: "6px 12px 0", fontSize: "var(--t9)", color: "var(--warn)" }}>⚠ {e.instance}: {e.detail}</div>
        ))}
        {g.needs.length > 0 && <Section label="NEEDS YOU" n={g.needs.length} color="var(--warn)" />}
        {g.needs.map(card)}
        {g.mine.length > 0 && <Section label={`YOURS${last}`} n={g.mine.length} />}
        {g.mine.map(card)}
        {g.team.length > 0 && <Section label={`TEAM${last}`} n={g.team.length} />}
        {g.team.map(card)}
      </>
    );
  }

  function card(t: RivendellTask) {
    const id = `${t.instance_id}|${t.id}`;
    const just = queued[t.id];
    const req = just && t.implementation?.id !== just
      ? { id: just, status: "PENDING" as const, createdAt: now.toISOString(), completedAt: null }
      : t.implementation;
    const st = cardState({ implementation: req, session_id: t.session_id }, now);
    const due = dueLabel(t.dueDate, now);
    const working = busy.has(t.id);
    const frozen = !!t.stale;                 // last known: nothing new may start from it
    const on = hov === id;
    const ask = t.run?.ask ?? null;
    const live = req?.status === "IN_PROGRESS" && !ask ? t.run?.live ?? null : null;
    const res = req?.status === "COMPLETED" || req?.status === "FAILED" ? resultBits(t.run?.result) : null;
    const asked = ask?.at ? since(ask.at, now) : "";
    const act = (label: ReactNode, run: () => void, tone: "primary" | "ghost" | "err" | "warn", off = false) => {
      const c = tone === "err" ? "var(--err)" : tone === "warn" ? "var(--warn)" : "var(--acc)";
      const strong = tone === "primary" || tone === "warn";
      return (
        <button
          disabled={working || off}
          onClick={(e) => { e.stopPropagation(); run(); }}
          style={{
            appearance: "none", cursor: working || off ? "default" : "pointer", fontFamily: "inherit",
            fontSize: "var(--t9)", letterSpacing: 1, padding: "5px 9px", whiteSpace: "nowrap",
            display: "inline-flex", alignItems: "center", gap: 5, opacity: working || off ? 0.5 : 1,
            border: `1px solid color-mix(in srgb, ${c} ${strong ? 45 : tone === "err" ? 40 : 22}%, transparent)`,
            background: strong ? `color-mix(in srgb, ${c} 12%, transparent)` : "transparent",
            color: tone === "primary" ? "var(--txb)" : tone === "ghost" ? "var(--txm)" : c,
          }}
        >{working ? "…" : label}</button>
      );
    };
    const href = t.url ?? t.htmlUrl;
    const row = { display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 8, minHeight: 25 } as const;
    return (
      <div
        key={id}
        onClick={() => href && window.open(href, "_blank", "noopener")}
        onMouseEnter={() => setHov(id)} onMouseLeave={() => setHov("")}
        title={t.url ? "Open in Rivendell" : t.htmlUrl ? "Open in Teamwork" : undefined}
        style={{
          margin: "0 8px 8px", padding: "9px 10px 10px", cursor: href ? "pointer" : "default",
          border: `1px solid color-mix(in srgb, ${ask ? "var(--warn)" : "var(--acc)"} ${ask ? 45 : on ? 24 : 12}%, transparent)`,
          background: "color-mix(in srgb, var(--panel2) 70%, transparent)", opacity: frozen ? 0.55 : 1,
          transition: "border-color .13s ease", animation: "mfadeup .35s ease both",
        }}
      >
        <div style={{ fontSize: "var(--t115)", lineHeight: 1.4, color: "var(--txh)", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{t.name}</div>
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginTop: 4, fontSize: "var(--t9)", color: "var(--txl)", whiteSpace: "nowrap", minWidth: 0 }}>
          {t.assignees.length > 0 && (
            <span title={t.assignees.map((a) => a.name).join(", ")} style={{ display: "inline-flex", flex: "none" }}>
              {t.assignees.slice(0, 3).map((a, i) => (
                <span key={a.id} style={{
                  width: 15, height: 15, borderRadius: "50%", marginLeft: i ? -3 : 0, display: "inline-flex",
                  alignItems: "center", justifyContent: "center", fontSize: "var(--t7)", color: "var(--acc-on)",
                  background: t.mine && i === 0 ? "var(--acc)" : "var(--txm)", border: "1px solid var(--panel)",
                }}>{initials(a.name)}</span>
              ))}
            </span>
          )}
          {[t.column && <span key="c" style={{ color: "var(--txd)" }}>{t.column}</span>,
            due && <span key="d" style={{ color: due.tone === "late" ? "var(--err)" : due.tone === "soon" ? "var(--warn)" : undefined }}>{due.text}</span>]
            .filter(Boolean)
            .flatMap((el, i) => (i ? [<span key={`s${i}`}>·</span>, el] : [el]))}
        </div>
        {ask && (
          <div onClick={(e) => e.stopPropagation()} style={{ marginTop: 9, padding: "2px 0 2px 10px", borderLeft: "2px solid var(--warn)", cursor: "default" }}>
            <div style={{ fontSize: "var(--t9)", letterSpacing: 1.5, color: "var(--warn)" }}>
              ◆ ASKS{asked ? ` · ${asked === "now" ? "just now" : `${asked} ago`}` : ""}
            </div>
            <div style={{ marginTop: 5, fontSize: "var(--t105)", lineHeight: 1.5, color: "var(--txh)" }}>{ask.question}</div>
            {ask.simple && ask.options.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
                {ask.options.map((o, i) => <span key={o}>{act(o, () => void answer(t, o), i === 0 ? "warn" : "ghost")}</span>)}
              </div>
            )}
          </div>
        )}
        {live && (
          <div style={{ marginTop: 8, padding: "6px 8px", background: "color-mix(in srgb, var(--acc) 6%, transparent)", fontSize: "var(--t9)" }}>
            <div title={live.line} style={{ color: "var(--txm)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>› {live.line}</div>
            <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 5, color: "var(--txl)", letterSpacing: 1 }}>
              {live.todos && (
                <span aria-hidden style={{ display: "inline-flex", gap: 2 }}>
                  {Array.from({ length: Math.min(live.todos.total, 12) }, (_, i) => (
                    <span key={i} style={{ width: 10, height: 4, background: i < live.todos!.done ? "var(--acc)" : "color-mix(in srgb, var(--acc) 18%, transparent)" }} />
                  ))}
                </span>
              )}
              <span>{[live.todos && `${live.todos.done}/${live.todos.total} TODOS`, `${live.steps} STEPS`].filter(Boolean).join(" · ")}</span>
            </div>
          </div>
        )}
        {res && (res.pr || res.rest || res.outcome) && (
          <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", alignItems: "center", gap: "2px 8px", fontSize: "var(--t9)", color: "var(--txl)" }}>
            {res.outcome && <span style={{ color: "var(--err)" }}>{res.outcome}</span>}
            {res.pr && (
              <a href={res.pr.url} target="_blank" rel="noopener" onClick={(e) => e.stopPropagation()}
                style={{ color: "var(--txb)", textDecoration: "none" }}>↑ {res.pr.label} ↗</a>
            )}
            {res.pr?.checks && <span style={{ color: CHECK_TONE[res.pr.checks[0]] }}>{res.pr.checks}</span>}
            {res.rest && <span>{res.rest}</span>}
          </div>
        )}
        {ask ? (
          <div style={row}>
            <span style={{ fontSize: "var(--t9)", letterSpacing: 1, color: "var(--warn)" }}>◆ NEEDS YOU · PAUSED</span>
            {t.session_id && act("OPEN SESSION ›", () => onOpenSession(t.session_id!), "ghost")}
          </div>
        ) : (st.line || st.action) && (
          <div style={row}>
            <span style={{ fontSize: "var(--t9)", letterSpacing: 1, color: TONE[st.tone] }}>{st.line}</span>
            {st.action === "implement" && act(<><Play size={9} strokeWidth={2.4} />IMPLEMENT</>, () => void implement(t), "primary", frozen)}
            {st.action === "open" && t.session_id && act("OPEN SESSION ›", () => onOpenSession(t.session_id!), "ghost")}
            {st.action === "again" && act("RUN AGAIN", () => void implement(t), "ghost", frozen)}
            {st.action === "retry" && act("RETRY", () => void implement(t), "err", frozen)}
          </div>
        )}
        {errs[t.id] && <div style={{ marginTop: 6, fontSize: "var(--t9)", color: "var(--err)" }}>{errs[t.id]}</div>}
      </div>
    );
  }
}

/** The connection beside the project name (lib/rivendelltasks linkChip). */
function Chip({ link, now }: { link: RivendellLink; now: Date }) {
  const c = linkChip(link, now);
  const color = LINK_TONE[c.tone];
  return (
    <span title={link.detail || c.label} style={{
      flex: "none", display: "inline-flex", alignItems: "center", gap: 5, padding: "1px 6px",
      fontSize: "var(--t85)", letterSpacing: 1, color, border: `1px solid color-mix(in srgb, ${color} 40%, transparent)`,
    }}>
      {c.tone === "ok" && <span style={{ width: 6, height: 6, borderRadius: "50%", background: color, boxShadow: `0 0 6px ${color}` }} />}
      {c.tone === "warn" && "◌"}{c.tone === "err" && "✕"}
      <span>{c.label}</span>
    </span>
  );
}

/** TOKEN REJECTED: nothing Rivendell sends can arrive and IMPLEMENT can't start
 *  until the token is replaced. REPLACE TOKEN opens Settings ▸ PLUGINS editing
 *  this connection; TEST LINK re-dials it once (a 4401 can be Rivendell's own
 *  hiccup, and a parked worker never retries by itself). */
function Paused({ link, testing, note, onTest }: { link: RivendellLink; testing: boolean; note?: string; onTest: () => void }) {
  const code = closeCode(link.detail);
  const at = link.down_since ?? link.since;
  const btn = (c: string) => ({
    appearance: "none", cursor: "pointer", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1.5,
    padding: "6px 10px", background: "transparent", color: c, border: `1px solid color-mix(in srgb, ${c} 45%, transparent)`,
  }) as const;
  return (
    <div style={{ margin: "8px 8px 6px", padding: "10px 11px", borderLeft: "2px solid var(--err)", background: "color-mix(in srgb, var(--err) 7%, transparent)" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8, fontSize: "var(--t9)", letterSpacing: 1.5 }}>
        <span style={{ color: "var(--err)" }}>✕ JOBS ARE PAUSED</span>
        <span style={{ color: "var(--txl)", letterSpacing: 0.5 }}>{[at ? `since ${hhmm(at)}` : "", code].filter(Boolean).join(" · ")}</span>
      </div>
      <div style={{ marginTop: 6, fontSize: "var(--t10)", lineHeight: 1.55, color: "var(--txm)" }}>
        Rivendell refused this bridge's token, so nothing it sends can arrive, and IMPLEMENT can't start.
        Mint a new LLM token in Rivendell ▸ Profile ▸ API tokens.
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 9 }}>
        <button style={btn("var(--err)")} onClick={() => openSettings("plugins", link.instance_id)}>REPLACE TOKEN ▸</button>
        <button style={{ ...btn("var(--txm)"), opacity: testing ? 0.5 : 1 }} disabled={testing} onClick={onTest}>
          {testing ? "TESTING…" : "TEST LINK"}
        </button>
      </div>
      {note && <div style={{ marginTop: 6, fontSize: "var(--t9)", color: "var(--txl)" }}>{note}</div>}
    </div>
  );
}

function Section({ label, n, color }: { label: string; n: number; color?: string }) {
  return (
    <div style={{ display: "flex", gap: 8, padding: "10px 12px 6px", fontSize: "var(--t9)", letterSpacing: 1.8, color: color ?? "var(--txl)" }}>
      <span>{label}</span><span style={{ color: "var(--txg)" }}>{n}</span>
    </div>
  );
}

function Empty({ title, text, icon, settings }: { title: string; text: ReactNode; icon?: ReactNode; settings?: boolean }) {
  return (
    <div style={{ padding: "26px 16px", display: "flex", flexDirection: "column", alignItems: "center", gap: 10, textAlign: "center" }}>
      <span style={{ color: "var(--txg)" }}>{icon ?? <Castle size={26} strokeWidth={1.3} />}</span>
      <div style={{ fontSize: "var(--t115)", color: "var(--txh)" }}>{title}</div>
      <div style={{ fontSize: "var(--t10)", lineHeight: 1.55, color: "var(--txl)", maxWidth: 240 }}>{text}</div>
      {settings && (
        <button onClick={() => openSettings("plugins")} style={{ ...toolBtn, fontSize: "var(--t9)", letterSpacing: 1, padding: "5px 10px" }}>
          SETTINGS ▸ PLUGINS ›
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Typecheck and checks**

Run (from `bridge/dashboard/web`): `node_modules/.bin/tsc -p tsconfig.app.json && node --experimental-strip-types src/lib/rivendelltasks.check.ts`
Expected: tsc exits 0 and every check passes.

- [ ] **Step 5: Look at it (bridge-eyes).** Build, serve the worktree's `dist` read-only, and stub the two Rivendell routes with fixtures. The live bridge still runs old code, and its token is revoked, so its data can't show these states. First write the fixtures:

```bash
cd /home/mhzrerfani/projects/.worktrees/mystical-assistant/feat-rivendell-channel/bridge/dashboard/web
node_modules/.bin/vite build
python3 - <<'EOF'
import json, time
now = time.time()
def link(state, **kw):
    return {"instance_id": "prod", "instance": "production", "state": state, "detail": kw.pop("detail", "wss://api.rivendell.ainurhq.cloud/agent"),
            "since": now - 600, "connected_since": None, "last_event_at": now - 720, "down_since": None, "alert_at": None,
            "attempt": 0, "retry_at": None, "last_test": None, **kw}
def task(i, name, mine, status, run=None, stale=False):
    stamp = lambda ago: time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime(now - ago))
    impl = None if status is None else {"id": f"r{i}", "status": status, "createdAt": stamp(720),
                                        "completedAt": stamp(7200) if status in ("COMPLETED", "FAILED") else None}
    return {"id": f"t{i}", "name": name, "htmlUrl": None, "url": None, "projectName": "Rivendell", "column": "In progress",
            "dueDate": None, "priority": None, "assignees": [{"id": "u1", "name": "Mahziyar Erfani"}], "mine": mine,
            "implementation": impl, "instance_id": "prod", "session_id": f"s{i}" if impl else None,
            "stale": stale, "run": run}
ask = {"job_id": "j1", "request_id": "q1", "at": now - 180, "header": "No meeting", "simple": True,
       "question": "Items with no meeting: group them under “No client”, or leave them out?", "options": ["Under “No client”", "Leave them out"]}
live_tasks = [
    task(1, "Inbox: group meeting action items by client", True, "IN_PROGRESS", {"live": {"line": "Edit: frontend/src/routes/tasks/$id.tsx", "steps": 14, "todos": {"done": 3, "total": 5}}, "ask": ask}),
    task(2, "Task dialog: show every implementation run, newest first", True, "IN_PROGRESS", {"live": {"line": "Edit: frontend/src/routes/tasks/$id.tsx", "steps": 14, "todos": {"done": 3, "total": 5}}, "ask": None}),
    task(3, "Roadmap share page remembers the access code", True, "COMPLETED", {"result": {"wall_s": 2280, "tokens": {"in": 1150000, "out": 50000}, "pr": {"number": 128, "url": "https://github.com/ainurhq/rivendell/pull/128", "checks": "pass"}, "outcome": None}}),
    task(4, "Changelog generator: pick a date range", False, "FAILED", {"result": {"wall_s": 1260, "tokens": None, "pr": None, "outcome": {"code": "timeout", "label": "KILLED AS HUNG", "detail": "no output for 30 min, after 21m of work"}}}),
]
base = {"slug": "ainurhq/rivendell", "instances": 1, "errors": [],
        "projects": [{"id": "p1", "name": "Rivendell", "url": "https://rivendell.example/projects/p1", "instance_id": "prod"}]}
json.dump({**base, "links": [link("connected")], "tasks": live_tasks}, open("/tmp/rc-tasks-live.json", "w"))
rejected = link("auth_error", detail="token rejected by gateway (4401 Invalid or revoked token)", down_since=now - 900, alert_at=now - 900)
json.dump({**base, "links": [rejected], "errors": [{"instance_id": "prod", "instance": "production", "error": "token_rejected", "detail": "token rejected"}],
           "tasks": [task(1, "Inbox: group meeting action items by client", True, "IN_PROGRESS", None, True), task(5, "Task dialog: show every implementation run, newest first", True, None, None, True)]},
          open("/tmp/rc-tasks-paused.json", "w"))
inst = {"id": "prod", "name": "production", "enable": True, "api_url": "https://api.rivendell.ainurhq.cloud", "ws_url": "", "model": "claude-opus-5-5",
        "workdir": "", "review_timeout": 3600, "impl_timeout": 10800, "origin": "rivendell:production", "token": "…xxxx"}
json.dump({"instances": [{**inst, "status": link("connected")}]}, open("/tmp/rc-inst-live.json", "w"))
json.dump({"instances": [{**inst, "status": rejected}]}, open("/tmp/rc-inst-paused.json", "w"))
EOF
```

Then serve and shoot both states. Kill the probe by its PID; `pkill -f` would kill your own shell.

```bash
python3 /home/mhzrerfani/projects/mystical-assistant/.mystical/probe/probe.py 8795 "$PWD/dist" 8790 &
PROBE=$!
sleep 1
for s in live paused; do
SEED="(() => { const T = $(cat /tmp/rc-tasks-$s.json); const I = $(cat /tmp/rc-inst-$s.json); const real = window.fetch.bind(window); window.fetch = (u, o) => { const p = String(u); const b = p.startsWith('/local/rivendell/tasks') ? T : p === '/local/rivendell' ? I : null; return b ? Promise.resolve(new Response(JSON.stringify(b), { headers: { 'Content-Type': 'application/json' } })) : real(u, o); }; return { 'hud-settings': { rightOpen: true, rightTab: 'rivendell' } }; })()"
node /home/mhzrerfani/projects/mystical-assistant/.mystical/probe/shot2.mjs 'http://127.0.0.1:8795/?skipboot=1' /tmp/rc-tab-$s.png 1440 1000 7000 "$SEED"
done
kill $PROBE
```

Expected: `/tmp/rc-tab-live.png` shows NEEDS YOU on top (warn border, ASKS · 3m ago, the two option buttons, ◆ NEEDS YOU · PAUSED, OPEN SESSION), then a RUNNING card with its live line and a 3/5 · 14 STEPS bar, DONE with ↑ PR #128 ↗ ✓ checks · 38m · 1.20M tok, and FAILED with KILLED AS HUNG — …. The chip reads `LINKED · 12m`. `/tmp/rc-tab-paused.png` shows the red ✕ JOBS ARE PAUSED banner (since HH:MM · 4401, REPLACE TOKEN ▸, TEST LINK), a `✕ TOKEN REJECTED` chip, and dimmed `YOURS · LAST KNOWN` cards with IMPLEMENT greyed out. `Read` both PNGs, compare them with `/tmp/rc-a.png` and `/tmp/rc-b.png`, and attach them to the chat with the verify **Attach** tool so the user sees them.

- [ ] **Step 6: Commit**

```bash
cd /home/mhzrerfani/projects/.worktrees/mystical-assistant/feat-rivendell-channel
git add bridge/dashboard/web/src/lib/opensettings.ts bridge/dashboard/web/src/components/hud/RivendellTasks.tsx bridge/dashboard/web/src/components/hud/SettingsModal.tsx
git commit -m "ui(rivendell): link chip, TOKEN REJECTED banner, NEEDS YOU answered from the card, live and result lines"
```

---

### Task 11: The castle's red dot, the bell, and Settings' TEST row

**Files:**
- Modify: `bridge/dashboard/web/src/components/RightPanel.tsx`: `PanelTab` (lines 4-19); the rail button (after the badge, lines 114-119).
- Modify: `bridge/dashboard/web/src/components/hud/Notifications.tsx`: `notify` (lines 31-35), `dismiss` (line 37).
- Modify: `bridge/dashboard/web/src/App.tsx`: imports (lines 5-22, 76); the Rivendell block (lines 1518-1524); the castle tab (lines 1581-1586).
- Modify: `bridge/dashboard/web/src/components/hud/SettingsModal.tsx`: `RivendellPanel`, the TEST row after the workdir line (line 2665-2668), plus an import.
- Test: tsc, checks, screenshots.

**Interfaces:**
- Consumes: `linkAlertText`, `testText` (Task 9); `openSettings(tab, focus)` (Task 10); `api.rivendellTest`.
- Produces: `PanelTab.alert?: boolean`; `notify(...) -> number`; `export function dismiss(id: number)`.

- [ ] **Step 1: `RightPanel.tsx`.** Add to `PanelTab` after `badge`:

```tsx
  // A red dot instead of a count: something this tab is about is broken (the
  // castle's, while a Rivendell link is down — App.tsx). Shows on every tab.
  alert?: boolean;
```

and in the rail button, after the badge's `{t.badge ? (…) : null}`:

```tsx
              {t.alert ? (
                <span className="absolute right-[5px] top-[4px] h-[8px] w-[8px] rounded-full"
                  style={{ background: "var(--err)", boxShadow: "0 0 6px var(--err)" }} />
              ) : null}
```

- [ ] **Step 2: `Notifications.tsx`.** `notify` returns its id, and `dismiss` is exported:

```tsx
/** Push a notification: shows a toast popup and lands in the bell dropdown.
 *  `onClick` makes it a link — clicking the toast or the row runs it. Returns
 *  its id, so a caller whose news goes stale can dismiss it. */
export function notify(kind: NoticeKind, text: string, onClick?: () => void): number {
  const id = nextId++;
  notices = [{ id, kind, text: text || "unknown error", time: Date.now(), read: false, onClick }, ...notices].slice(0, 50);
  emit();
  onNotice?.(kind);
  return id;
}

/** Drop one notice: its row's ×, or a caller whose news went stale (a
 *  Rivendell link that came back — App.tsx). */
export function dismiss(id: number) { notices = notices.filter((n) => n.id !== id); emit(); }
```

- [ ] **Step 3: `App.tsx`.** Add `type RivendellInstance,` to the `./api` import list, change line 76 to `import { dismiss, notify, setNoticeSound } from "./components/hud/Notifications";`, and add:

```tsx
import { openSettings } from "./lib/opensettings";
import { linkAlertText } from "./lib/rivendelltasks";
```

Replace the `rivendellOn` block (lines 1518-1524) with:

```tsx
  // The RIVENDELL tab exists only with a Rivendell connection to ask. Polled,
  // not only re-read when SETTINGS closes (where one is added or removed): a
  // link breaks with no dashboard event to say so, and the castle's dot and the
  // bell follow each connection's break (bridge/rivendell.py, alert_at — set
  // once per break, cleared when the link proves itself).
  const [rivendell, setRivendell] = useState<RivendellInstance[]>([]);
  useEffect(() => {
    if (settingsOpen) return;
    const tick = () => api.rivendell().then((r) => setRivendell(r.instances)).catch(() => { /* ignore */ });
    void tick();
    const id = setInterval(tick, 10000);
    return () => clearInterval(id);
  }, [settingsOpen]);
  const rivendellOn = rivendell.length > 0;
  const rivendellDown = rivendell.some((i) => i.enable && !!i.status?.alert_at);
  // One bell entry per break, gone when the link is back. Telegram's one
  // message per break is the bridge's to send (Worker._alert_broken).
  const linkNotices = useRef<Record<string, { at: number; id: number }>>({});
  useEffect(() => {
    const shown = linkNotices.current;
    for (const i of rivendell) {
      const at = i.status?.alert_at ?? null;
      const cur = shown[i.id];
      if (at && cur?.at !== at) {
        if (cur) dismiss(cur.id);
        shown[i.id] = { at, id: notify("error", linkAlertText(i), () => openSettings("plugins", i.id)) };
      } else if (!at && cur) {
        dismiss(cur.id);
        delete shown[i.id];
      }
    }
  }, [rivendell]);
```

and the castle tab entry becomes:

```tsx
    ...(rivendellOn ? [{
      id: "rivendell", label: rivendellDown ? "Rivendell tasks — link broken" : "Rivendell tasks",
      icon: <Castle {...RAIL} />, ownScroll: true, scope: "project" as const, alert: rivendellDown,
      render: () => (
        <RivendellTasks project={sessionProject} onOpenSession={(id) => { openSession(id); toChat(); }} />
      ),
    }] : []),
```

- [ ] **Step 4: Settings' TEST row.** In `SettingsModal.tsx`, add `import { testText } from "../../lib/rivendelltasks";`. In `RivendellPanel`, after the `hp` helper:

```tsx
  // TEST LINK: a ping/pong round trip on the live socket, or a re-dial of a
  // parked token (bridge/rivendell.py Worker.test_link). The row keeps the last.
  const [testing, setTesting] = useState("");
  async function test(id: string) {
    setTesting(id); setErr("");
    try {
      const r = await api.rivendellTest(id);
      setRows((p) => (p ?? []).map((x) => (x.id === id ? { ...x, status: { ...x.status, last_test: r } } : x)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not test");
    } finally {
      setTesting("");
    }
  }
```

and inside the row's `desc`, after the `workdir … impl …s` `<div>`:

```tsx
                    <div style={{ marginTop: 6, display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span style={{ ...dim, letterSpacing: 1.5 }}>TEST</span>
                      <span style={{ color: c.status?.last_test?.ok ? "var(--ok)" : c.status?.last_test?.ok === false ? "var(--err)" : "var(--txl)" }}>
                        {testText(c.status?.last_test)}
                        {c.status?.last_test
                          ? <span style={dim}> · {new Date(c.status.last_test.at * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span>
                          : null}
                      </span>
                      <button disabled={st === "off" || testing === c.id} onClick={() => void test(c.id)} {...hp(`ts:${c.id}`)}
                        style={{ appearance: "none", cursor: st === "off" ? "default" : "pointer", fontFamily: "inherit", fontSize: "var(--t9)", letterSpacing: 1.5, padding: "4px 10px", border: "1px solid color-mix(in srgb, var(--acc) 25%, transparent)", background: hov === `ts:${c.id}` ? "color-mix(in srgb, var(--acc) 8%, transparent)" : "transparent", color: "var(--txm)", opacity: st === "off" ? 0.4 : 1 }}>
                        {testing === c.id ? "TESTING…" : "TEST LINK"}
                      </button>
                    </div>
```

- [ ] **Step 5: Typecheck, checks, look**

Run (from `bridge/dashboard/web`): `node_modules/.bin/tsc -p tsconfig.app.json && node --experimental-strip-types src/lib/rivendelltasks.check.ts && node_modules/.bin/vite build`
Expected: clean. Re-run Task 10 Step 5's `paused` shot with `rightTab: 'files'` in the seed. The castle must carry the red dot while FILES is open, and the bell's toast must read "Rivendell production refused this bridge's token…". Attach the PNG.

- [ ] **Step 6: Commit**

```bash
git add bridge/dashboard/web/src/components/RightPanel.tsx bridge/dashboard/web/src/components/hud/Notifications.tsx bridge/dashboard/web/src/App.tsx bridge/dashboard/web/src/components/hud/SettingsModal.tsx
git commit -m "ui(rivendell): a red dot on the castle and one bell entry per broken link; Settings' TEST row"
```

---

### Task 12: Part 1 — verify the whole slice

**Files:** none new.

- [ ] **Step 1: Backend suite.** Run `python3 -m pytest tests/ -q`. Expected: green, 1513 passed (the 1460 from before plus Part 1's 53 new tests), 2 skipped.
- [ ] **Step 2: Web.** From `bridge/dashboard/web`, run `node_modules/.bin/tsc -p tsconfig.app.json && for f in src/lib/*.check.ts; do node --experimental-strip-types "$f" >/dev/null || echo "FAIL $f"; done`. Expected: tsc exits 0, and no `FAIL` lines.
- [ ] **Step 3: Nothing new on the wire.** Run `git diff 666d29a1 -- bridge/rivendell.py | grep -n '_api(' `. Expected: the only `_api(` calls in the diff are the existing claim, ack, refuse and result paths, plus no new path. Part 1 must not add a Rivendell route.
- [ ] **Step 4: Stop.** Going live (rebuild the dashboard, restart the bridge) is **bridge-ship**, and it waits for the user's OK. The live token has been revoked since 2026-09-30, so the first visible effects after a restart are the TOKEN REJECTED banner and exactly one Telegram message.

---

# Part 2 — the contract (bridge side, behind negotiation)

Each task below is inert against today's Rivendell (no `hello`, so `features` stays empty). It comes alive when Rivendell ships the matching section of "Rivendell changes" below.

### Task 13: Capability negotiation — `hello` and `features`

**Files:**
- Modify: `bridge/rivendell.py`:
  - `Worker.__init__` (`features`).
  - `status_snapshot` (`features`).
  - `_handle_message` (a `hello` branch first).
  - `_listen` (reset before `_set_status("connected")`, line 692).
  - The module docstring.
- Modify: `bridge/dashboard/web/src/api.ts`: `RivendellStatus.features?: string[]`.
- Test: `tests/test_rivendell_channel.py`

**Interfaces:**
- Produces: `Worker.features: frozenset[str]` (empty until this connection's hello); `status_snapshot()["features"]` (sorted list). Feature names: `"progress"`, `"result-details"`, `"ping"`.

- [ ] **Step 1: Write the failing tests** (append):

```python
# --- Task 13: capability negotiation ---------------------------------------------

def test_hello_names_what_this_rivendell_understands():
    w = _worker()
    assert w._handle_message(json.dumps(
        {"type": "hello", "features": ["progress", "ping"]}).encode()) is None
    assert w.features == frozenset({"progress", "ping"})
    assert w.status_snapshot()["features"] == ["ping", "progress"]


def test_a_rivendell_that_says_nothing_gets_nothing_new():
    """The deployed Rivendell sends no hello: features stay empty, and every
    Part 2 sender checks them (progress, result details, test jobs)."""
    assert _worker().features == frozenset()


def test_each_connection_starts_without_features(monkeypatch):
    server, client = socket.socketpair()
    w = _worker()
    w.features = frozenset({"progress"})              # what the last connection said
    monkeypatch.setattr(w, "_connect", lambda: (client, client.makefile("rb")))
    monkeypatch.setattr(w, "_catch_up", lambda: 0)
    t = threading.Thread(target=w._listen, daemon=True)
    t.start()
    try:
        _wait_until(lambda: w.status == "connected")
        assert w.features == frozenset()
        server.sendall(wsutil.encode_frame(
            json.dumps({"type": "hello", "features": ["ping"]}).encode(), wsutil.OP_TEXT))
        _wait_until(lambda: w.features == frozenset({"ping"}))
    finally:
        w.stop()
        t.join(2)
        server.close()
```

- [ ] **Step 2: Run them to see them fail**

Run: `python3 -m pytest tests/test_rivendell_channel.py -q -k "hello or features or says_nothing"`
Expected: FAIL, `AttributeError: 'Worker' object has no attribute 'features'`.

- [ ] **Step 3: Implement.** `Worker.__init__`:

```python
        # What this connection's Rivendell said it understands, in its hello
        # (docs/superpowers/specs/rivendell-channel.md, Contract). Empty until it
        # does; the deployed API sends no hello, so it stays empty and gets
        # exactly today's traffic.
        self.features: frozenset = frozenset()
```

`status_snapshot` gains `"features": sorted(self.features),`. In `_handle_message`, first thing after the JSON parse:

```python
        if obj.get("type") == "hello":
            self.features = frozenset(str(f) for f in obj.get("features") or () if f)
            print(f"rivendell[{self.name}]: speaks {sorted(self.features) or 'nothing new'}")
            return None
```

In `_listen`, right before `self._set_status("connected", url)`:

```python
            self.features = frozenset()     # this connection hasn't said hello yet
```

Module docstring, a new paragraph:

```
The contract beyond jobs is negotiated: on each connection Rivendell may send
{"type": "hello", "features": [...]} first, and the bridge sends something new —
progress, result details, test jobs — only for a feature named there (features
reset per connection). The deployed Rivendell sends no hello and 400s unknown
result fields (forbidNonWhitelisted), so it keeps getting exactly today's
traffic. Frames from Rivendell this bridge doesn't know are ignored, as ever.
```

In `api.ts` `RivendellStatus`: `features?: string[];   // what its hello said it understands (progress, result-details, ping)`.

- [ ] **Step 4: Run the tests.** Run `python3 -m pytest tests/test_rivendell_channel.py tests/test_rivendell.py -q`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge/rivendell.py bridge/dashboard/web/src/api.ts tests/test_rivendell_channel.py
git commit -m "rivendell: read Rivendell's hello — new traffic only for the features it names"
```

---

### Task 14: Progress feed (throttled ~10 s)

**Files:**
- Modify: `bridge/rivendell.py`:
  - `_PROGRESS_EVERY`, `_ACTIVITY`.
  - Module `_activity`, `progress_body` (beside `live_view`).
  - `Worker.__init__` (`_progress_thread`).
  - `Worker._progress_loop`, `_progress_tick`, `_post_progress`.
  - `start()` (lines 1286-1296).
- Test: `tests/test_rivendell_channel.py`

**Interfaces:**
- Consumes: `live_view` (Task 3), `features` (Task 13), `runner.live_job`.
- Produces:
  - `progress_body(job) -> {"state": "running"|"awaiting_input", "activity": {"kind", "text"}, "todos": {...}|None, "step": int, "question"?: {"id", "text", "header", "options", "buttons"}}`.
  - It POSTs to `/plugin/<kind>-requests/<id>/progress`.

- [ ] **Step 1: Write the failing tests** (append):

```python
# --- Task 14: progress feed -------------------------------------------------------

def test_progress_body_is_the_contracts_shape():
    j = runner.Job(uuid.uuid4().hex, config.DASH_CHAT_ID)
    runner._handle_event(j, _use("u1", "Edit", {"file_path": "a.tsx"}))
    j.task_status = {"1": "completed", "2": "pending"}
    assert rivendell.progress_body(j) == {
        "state": "running", "activity": {"kind": "action", "text": "Edit: a.tsx"},
        "todos": {"done": 1, "total": 2}, "step": 1}


def test_a_held_question_is_awaiting_input_with_its_options():
    body = rivendell.progress_body(_held_job())
    assert body["state"] == "awaiting_input" and body["activity"]["kind"] == "question"
    assert body["question"] == {"id": "q1", "text": COLOUR[0]["question"], "header": "No meeting",
                                "options": ["Under “No client”", "Leave them out"], "buttons": True}


def test_progress_waits_for_the_feature_then_throttles(monkeypatch):
    """Review focus 5: the deployed Rivendell never said "progress" and hears
    nothing; one that did hears a change at most every 10 s — at once when the
    run starts or stops waiting on a person."""
    w = _worker()
    posted = []
    monkeypatch.setattr(w, "_post_progress",
                        lambda kp, rid, body: posted.append((kp, rid, body["state"])))
    j = runner.Job(uuid.uuid4().hex, config.DASH_CHAT_ID)    # session-less: journals nothing
    monkeypatch.setattr(runner, "live_job", lambda sid: j if sid == "sess-p" else None)
    w._running["rp1"] = {"request_id": "rp1", "kind": "impl", "session_id": "sess-p"}
    last = {}
    w._progress_tick(last, 0.0)
    assert posted == []
    w.features = frozenset({"progress"})
    w._progress_tick(last, 0.0)
    assert posted == [("implementation-requests", "rp1", "running")]
    runner._handle_event(j, _use("u1", "Read", {"file_path": "b.ts"}))
    w._progress_tick(last, 5.0)
    assert len(posted) == 1, "changed, but inside the 10 s throttle"
    w._progress_tick(last, 11.0)
    assert len(posted) == 2
    j.add_pending({"request_id": "q9", "kind": "question", "questions": COLOUR})
    w._progress_tick(last, 12.0)
    assert posted[-1][2] == "awaiting_input", "waiting on a person goes out at once"
```

- [ ] **Step 2: Run them to see them fail**

Run: `python3 -m pytest tests/test_rivendell_channel.py -q -k progress`
Expected: FAIL, `AttributeError: module 'bridge.rivendell' has no attribute 'progress_body'`.

- [ ] **Step 3: Implement.** Constants:

```python
_PROGRESS_EVERY = 10.0    # at most one progress post per run this often (spec: ~10 s)
_ACTIVITY = {"tool": "action", "thinking": "thought", "text": "response", "error": "error"}
```

Beside `live_view`:

```python
def _activity(job) -> dict:
    """The run's latest move as the contract names it — action | thought |
    question | response | error — with a short text: what Rivendell's task page
    shows as "now"."""
    if any(p.get("kind") == "question" for p in list(job.pending)):
        return {"kind": "question", "text": "waiting for an answer"}
    for ev in reversed(list(job.events)):
        kind = _ACTIVITY.get(ev.get("type"))
        if kind == "action":
            text = f"{ev.get('name')}: {ev['summary']}" if ev.get("summary") else ev.get("name") or ""
        elif kind == "thought":
            text = "thinking"
        elif kind:
            text = ev.get("text") or ev.get("message") or ""
        else:
            continue
        return {"kind": kind, "text": str(text)[:200]}
    return {"kind": "action", "text": "starting"}


def progress_body(job) -> dict:
    """One run's progress event (spec: Contract → Progress): its state, latest
    activity, todo progress and step count — plus, while it waits on a person,
    the question, with the id an answer must quote (Worker._rivendell_answer)
    and whether its options can be one-tap buttons."""
    v = live_view(job)
    body = {"state": "awaiting_input" if v["ask"] else "running", "activity": _activity(job),
            "todos": v["live"]["todos"], "step": v["live"]["steps"]}
    if v["ask"]:
        a = v["ask"]
        body["question"] = {"id": a["request_id"], "text": a["question"], "header": a["header"],
                            "options": a["options"], "buttons": a["simple"]}
    return body
```

`Worker.__init__`: `self._progress_thread: threading.Thread | None = None`. Worker methods, after `_post_result`:

```python
    def _progress_loop(self) -> None:
        """Rivendell's live feed for every run in flight here (_progress_tick on
        each poll beat). Its own thread, so no run path changes shape."""
        last: dict = {}
        while not self._stop.wait(_POLL_INTERVAL):
            try:
                self._progress_tick(last, time.monotonic())
            except Exception as e:  # noqa: BLE001 — the feed outlives any beat
                print(f"rivendell[{self.name}]: progress beat failed: {e}")

    def _progress_tick(self, last: dict, now: float) -> None:
        """One beat: each run in flight posts its progress_body when it changed —
        at most every _PROGRESS_EVERY s, but at once when it starts or stops
        waiting on a person. Silent unless this Rivendell's hello said
        "progress". `last` is request id -> (body, when posted); runs that ended
        are forgotten."""
        if "progress" not in self.features:
            return
        from bridge import runner                    # local import: heavy module
        with self._q_lock:
            rows = list(self._running.values())
        for r in rows:
            job = runner.live_job(r["session_id"])
            if job is None:
                continue
            body = progress_body(job)
            prev = last.get(r["request_id"])
            if prev and (prev[0] == body or (prev[0]["state"] == body["state"]
                                              and now - prev[1] < _PROGRESS_EVERY)):
                continue
            last[r["request_id"]] = (body, now)
            self._post_progress(self._KIND_PATH.get(r["kind"], "review-requests"),
                                r["request_id"], body)
        for gone in set(last) - {r["request_id"] for r in rows}:
            last.pop(gone)

    def _post_progress(self, kind_path: str, request_id: str, body: dict) -> None:
        try:
            self._api(f"/plugin/{kind_path}/{request_id}/progress", body)
        except Exception as e:  # noqa: BLE001 — a missed beat is fixed by the next
            print(f"rivendell[{self.name}]: progress post failed for {request_id}: {e}")
```

In `start()`, after the listener spawn:

```python
        if self._progress_thread is None or not self._progress_thread.is_alive():
            self._progress_thread = threading.Thread(
                target=self._progress_loop, name=f"rivendell-progress-{self.id}", daemon=True)
            self._progress_thread.start()
```

- [ ] **Step 4: Run the tests.** Run `python3 -m pytest tests/test_rivendell_channel.py tests/test_rivendell.py -q`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge/rivendell.py tests/test_rivendell_channel.py
git commit -m "rivendell: a throttled progress feed per run, for a Rivendell that asked for it"
```

---

### Task 15: Answers from Rivendell resume the same run

**Files:**
- Modify: `bridge/rivendell.py`: `_handle_message` (a `job-answer` branch after `hello`); new `Worker._rivendell_answer`.
- Test: `tests/test_rivendell_channel.py`

**Interfaces:**
- Consumes: the frame `{"type": "job-answer", "kind": str, "requestId": str, "questionId": str, "answer": {"labels"?: [str], "notes"?: str}}`; `questionId` is `progress_body`'s `question.id`.
- Produces: `Worker._rivendell_answer(obj: dict) -> None`.

- [ ] **Step 1: Write the failing tests** (append):

```python
# --- Task 15: answers from Rivendell ----------------------------------------------

def test_an_answer_from_rivendell_resumes_the_held_run(jobs):
    w = _worker()
    sid = "sess-" + uuid.uuid4().hex
    j = _held_job(sid=sid)
    runner._register(j)
    jobs.append(j)
    w._running["ra1"] = {"request_id": "ra1", "kind": "impl", "session_id": sid}
    assert w._handle_message(json.dumps({
        "type": "job-answer", "kind": "implementation", "requestId": "ra1", "questionId": "q1",
        "answer": {"labels": ["Leave them out"]}}).encode()) is None
    assert j.pending == [] and "Leave them out" in _answer_sent(j)


def test_an_answer_to_a_question_no_longer_asked_is_dropped(jobs):
    w = _worker()
    sid = "sess-" + uuid.uuid4().hex
    j = _held_job(sid=sid)
    runner._register(j)
    jobs.append(j)
    w._running["ra2"] = {"request_id": "ra2", "kind": "impl", "session_id": sid}
    w._handle_message(json.dumps({"type": "job-answer", "requestId": "ra2",
                                  "questionId": "q-old", "answer": {"labels": ["x"]}}).encode())
    assert [p["request_id"] for p in j.pending] == ["q1"], "never misapplied to another question"
```

- [ ] **Step 2: Run them to see them fail.** Run `python3 -m pytest tests/test_rivendell_channel.py -q -k answer_from_rivendell`. Expected: FAIL, the question is still pending.

- [ ] **Step 3: Implement.** `_handle_message`, after the `hello` branch:

```python
        if obj.get("type") == "job-answer" and obj.get("requestId"):
            self._rivendell_answer(obj)
            return None
```

Worker method:

```python
    def _rivendell_answer(self, obj: dict) -> None:
        """A NEEDS YOU answer given in Rivendell. Only the bridge's owner may
        give one, and Rivendell checks that (claimedById). It answers the question
        its run is held on, matched by the question's id, so an answer to a
        question already answered here, or to an earlier one, is dropped, never
        misapplied. Same path as the session's QuestionCard (Job.respond), so the
        same run continues."""
        from bridge import runner                    # local import: heavy module
        with self._q_lock:
            row = self._running.get(obj.get("requestId") or "")
        job = runner.live_job(row["session_id"]) if row else None
        qid = obj.get("questionId") or ""
        entry = (next((p for p in list(job.pending) if p.get("request_id") == qid), None)
                 if job else None)
        if entry is None:
            print(f"rivendell[{self.name}]: answer for {obj.get('requestId')} dropped: "
                  "its question no longer waits")
            return
        a = obj.get("answer") or {}
        q = (entry.get("questions") or [{}])[0]
        ans = {"header": q.get("header") or q.get("question") or "",
               "labels": [str(x) for x in a.get("labels") or []]}
        if str(a.get("notes") or "").strip():
            ans["notes"] = str(a["notes"]).strip()
        job.respond(qid, answers=[ans])
```

- [ ] **Step 4: Run the tests.** Run `python3 -m pytest tests/test_rivendell_channel.py -q`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge/rivendell.py tests/test_rivendell_channel.py
git commit -m "rivendell: a NEEDS YOU answer given in Rivendell resumes the same run"
```

---

### Task 16: Structured result fields, and a dashboard link to the session

**Files:**
- Modify: `bridge/rivendell.py`: `_post_result` (payload + `details`), new `Worker._result_details`.
- Modify: `bridge/dashboard/web/src/App.tsx`: the cold-start reopen (line 606) honours `?s=<session id>`.
- Test: `tests/test_rivendell_channel.py`

**Interfaces:**
- Consumes: `_result_view` (Tasks 3-4), `attribution.breakdown`, `features`.
- Produces: the result payload's `details` = `{"outcome": {code,label,detail}|None, "pr": {number,url,checks}|None, "sessionId", "dashboardUrl", "wallSeconds", "activeSeconds", "tokens": {in,out}|None}`, sent only with `"result-details"`.

- [ ] **Step 1: Write the failing test** (append):

```python
# --- Task 16: structured result fields ---------------------------------------------

def test_result_details_ride_only_a_rivendell_that_asked(workers):
    """Review focus 5: the deployed Rivendell 400s any field it doesn't know."""
    sid = _session()
    rid = uuid.uuid4().hex
    store.set_ref(sid, f"ch:{rid}")
    _turn(sid, elapsed=600, result="PR https://github.com/acme/app/pull/9",
          tokens={"in": 10, "out": 5, "cache_w": 0, "cache_r": 85})
    w = _worker()
    sent = []
    w._api = lambda path, payload=None: sent.append(payload) or {}
    w._post_result("implementation-requests", rid, True, "summary")
    assert set(sent[-1]) == {"status", "result", "model"}
    w.features = frozenset({"result-details"})
    w._post_result("implementation-requests", rid, True, "summary")
    d = sent[-1]["details"]
    assert d["sessionId"] == sid and (d["pr"]["number"], d["pr"]["checks"]) == (9, None)
    assert (d["wallSeconds"], d["activeSeconds"], d["tokens"]) == (600, 600, {"in": 95, "out": 5})
    assert d["dashboardUrl"].endswith(f"/?s={sid}") and d["outcome"] is None
```

- [ ] **Step 2: Run it to see it fail.** Run `python3 -m pytest tests/test_rivendell_channel.py -q -k result_details`. Expected: FAIL, `KeyError: 'details'`.

- [ ] **Step 3: Implement.** In `_post_result`, after `payload = {…}`:

```python
        if "result-details" in self.features:
            try:
                if (details := self._result_details(request_id)):
                    payload["details"] = details
            except Exception as e:  # noqa: BLE001 — the plain result still goes
                print(f"rivendell[{self.name}]: result details failed for {request_id}: {e}")
```

and add to its docstring: "A Rivendell whose hello said "result-details" also gets `details` (_result_details); the deployed one 400s any field it doesn't know, so it gets exactly today's body." Then the new method:

```python
    def _result_details(self, request_id: str) -> "dict | None":
        """The structured half of a result (spec: Contract → Result), read off
        the session that ran it: the outcome the transcript shows, the PR with
        its checks, wall and active time (active = wall minus waiting on a
        person), tokens, and where to open it on this bridge. Wire names are
        camelCase, as Rivendell's DTOs are. None when no run happened here."""
        from bridge import attribution, store        # local import: heavy modules
        ref = f"{self.id}:{request_id}"
        sid = store.sessions_for_refs([ref]).get(ref)
        if sid is None:
            return None
        res = _result_view(sid) or {}
        b = attribution.breakdown(sid)
        return {"outcome": res.get("outcome"), "pr": res.get("pr"), "sessionId": sid,
                "dashboardUrl": f"http://localhost:{config.DASH_PORT}/?s={sid}",
                "wallSeconds": round(b["wall"]),
                "activeSeconds": round(max(0.0, b["wall"] - b["waiting_s"])),
                "tokens": res.get("tokens")}
```

`App.tsx`, the cold-start reopen (line 606):

```tsx
        // ?s=<id> — a link that names a session (Rivendell's dashboardUrl)
        // wins over the one you had open.
        const asked = new URLSearchParams(location.search).get("s");
        const was = ss.find((s) => s.id === asked) ?? ss.find((s) => s.id === lastOpen())
          ?? ss.find((s) => s.project === projectRel) ?? ss[0];
```

- [ ] **Step 4: Run.** Run `python3 -m pytest tests/test_rivendell_channel.py -q` and, from `bridge/dashboard/web`, `node_modules/.bin/tsc -p tsconfig.app.json`. Expected: PASS and clean.

- [ ] **Step 5: Commit**

```bash
git add bridge/rivendell.py bridge/dashboard/web/src/App.tsx tests/test_rivendell_channel.py
git commit -m "rivendell: structured result details for a Rivendell that asked; the dashboard opens ?s=<session>"
```

---

### Task 17: The `ping` job kind — SEND TEST JOB

**Files:**
- Modify: `bridge/rivendell.py`:
  - `_handle_message`: a `ping-request` branch.
  - `Worker._post_pong`, `Worker.test_job`.
  - Module `test_link(instance_id, job=False)`, now using `job`.
- Modify: `bridge/dashboard/server.py`: `/local/rivendell/test` passes `job`.
- Modify: `bridge/dashboard/web/src/api.ts`: `rivendellTest(instance_id, job = false)` and `RivendellTest.via?`.
- Modify: `bridge/dashboard/web/src/components/hud/SettingsModal.tsx`: the TEST row offers SEND TEST JOB when `features` include `ping`.
- Test: `tests/test_rivendell_channel.py`, `tests/test_rivendell_tasks_endpoint.py`

**Interfaces:**
- Consumes: the frame `{"type": "ping-request", "requestId": str}`; `POST /plugin/ping-requests` → `{"id", "ok": bool, "rttMs"?}`.
- Produces: `Worker.test_job() -> {"ok", "rtt_ms", "detail", "via": "job", "at"}`; it answers with `POST /plugin/ping-requests/<id>/result {}`.

- [ ] **Step 1: Write the failing tests.** Append to `tests/test_rivendell_channel.py`:

```python
# --- Task 17: the ping job kind ------------------------------------------------------

def test_a_ping_job_is_answered_without_claude():
    w = _worker()
    calls = []
    w._api = lambda path, payload=None: calls.append((path, payload)) or {}
    assert w._handle_message(json.dumps({"type": "ping-request", "requestId": "p1"}).encode()) is None
    _wait_until(lambda: calls)
    assert calls == [("/plugin/ping-requests/p1/result", {})]


def test_send_test_job_records_the_round_trip():
    w = _worker()
    w._api = lambda path, payload=None: {"id": "p2", "ok": True, "rttMs": 120}
    res = w.test_job()
    assert res["ok"] is True and res["via"] == "job" and res["rtt_ms"] >= 0
    assert w.status_snapshot()["last_test"] == res


def test_a_test_job_that_never_comes_back_fails():
    w = _worker()
    w._api = lambda path, payload=None: {"id": "p3", "ok": False}
    assert w.test_job()["ok"] is False
```

Append to `tests/test_rivendell_tasks_endpoint.py`:

```python
def test_send_test_job_asks_for_the_job_round_trip(monkeypatch):
    calls = []
    monkeypatch.setattr(rivendell, "test_link", lambda iid, job=False: calls.append((iid, job))
                        or {"ok": True, "rtt_ms": 900, "detail": "", "at": 1.0, "via": "job"})
    dpost("/local/rivendell/test", {"instance_id": "a", "job": True})
    assert calls == [("a", True)]
```

- [ ] **Step 2: Run them to see them fail.** Run `python3 -m pytest tests/test_rivendell_channel.py tests/test_rivendell_tasks_endpoint.py -q -k "ping or test_job"`. Expected: FAIL, `AttributeError: 'Worker' object has no attribute 'test_job'`.

- [ ] **Step 3: Implement.** `_handle_message`, after `job-answer`:

```python
        if obj.get("type") == "ping-request" and obj.get("requestId"):
            # SEND TEST JOB's echo: answered here, no Claude, off the listener.
            threading.Thread(target=self._post_pong, args=(obj["requestId"],),
                             name=f"rivendell-pong-{self.id}", daemon=True).start()
            return None
```

Worker methods, after `test_link`:

```python
    def _post_pong(self, request_id: str) -> None:
        try:
            self._api(f"/plugin/ping-requests/{request_id}/result", {})
        except Exception as e:  # noqa: BLE001 — Rivendell then reads the test as failed
            print(f"rivendell[{self.name}]: ping answer failed for {request_id}: {e}")

    def test_job(self) -> dict:
        """SEND TEST JOB: Rivendell files a `ping`, sends it down the socket, and
        this bridge answers it without Claude (_post_pong). That is HTTP in, the
        socket out, HTTP back: the whole path a real job takes. Rivendell holds
        the first POST open until the answer lands. Offered once its hello names
        "ping", and kept as `last_test` like TEST LINK."""
        t0 = time.monotonic()
        try:
            ok = bool(self._api("/plugin/ping-requests", {}).get("ok"))
            res = {"ok": ok, "rtt_ms": round((time.monotonic() - t0) * 1000) if ok else None,
                   "detail": "" if ok else "the job never came back over the socket"}
        except Exception as e:  # noqa: BLE001 — one line for the row
            res = {"ok": False, "rtt_ms": None, "detail": str(_explain(e))}
        self.last_test = {**res, "via": "job", "at": time.time()}
        return self.last_test
```

Module `test_link`:

```python
def test_link(instance_id: str, job: bool = False) -> "dict | None":
    """TEST LINK (Worker.test_link), or with `job` SEND TEST JOB (Worker.test_job).
    None when the instance has no running worker (switched off or removed)."""
    with _manager_lock:
        w = _workers.get(instance_id)
    if w is None:
        return None
    return w.test_job() if job else w.test_link()
```

In `bridge/dashboard/server.py`, change the call to `rivendell.test_link((body.get("instance_id") or "").strip(), job=bool(body.get("job")))`. In `api.ts`, `RivendellTest` gains `via?: "job";` and:

```ts
  rivendellTest: (instance_id: string, job = false) =>
    req<RivendellTest>("/local/rivendell/test", { method: "POST", body: { instance_id, job } }),
```

In `SettingsModal.tsx` `RivendellPanel`, `test(id)` takes the job flag and the button picks its words:

```tsx
  async function test(id: string, job: boolean) {
    setTesting(id); setErr("");
    try {
      const r = await api.rivendellTest(id, job);
      setRows((p) => (p ?? []).map((x) => (x.id === id ? { ...x, status: { ...x.status, last_test: r } } : x)));
    } catch (e) {
      setErr(e instanceof Error ? e.message : "could not test");
    } finally {
      setTesting("");
    }
  }
```

In the `rows.map` callback, next to `const st = c.status?.state ?? "off";`, add `const jobs = !!c.status?.features?.includes("ping");`. The TEST row's button then calls `onClick={() => void test(c.id, jobs)}` and reads `{testing === c.id ? "TESTING…" : jobs ? "SEND TEST JOB" : "TEST LINK"}`. In the paused-banner path, `RivendellTasks.tsx`'s `api.rivendellTest(iid)` keeps TEST LINK, which is right for a parked token.

- [ ] **Step 4: Run.** Run `python3 -m pytest tests/ -q` and, from `bridge/dashboard/web`, `node_modules/.bin/tsc -p tsconfig.app.json && node --experimental-strip-types src/lib/rivendelltasks.check.ts`. Expected: all green.

- [ ] **Step 5: Commit**

```bash
git add bridge/rivendell.py bridge/dashboard/server.py bridge/dashboard/web/src/api.ts bridge/dashboard/web/src/components/hud/SettingsModal.tsx tests/test_rivendell_channel.py tests/test_rivendell_tasks_endpoint.py
git commit -m "rivendell: SEND TEST JOB — a ping job Rivendell sends down the socket and the bridge answers without Claude"
```

---

## Rivendell changes (separate repo, prepared not pushed)

For a later session in a Rivendell worktree off `origin/main`. Local `main` is 23 commits behind; read `origin/main`, don't pull the user's checkout. Rivendell's `backend/AGENTS.md` binds that session:

- **"Stop at forks in the road".** A contract change is a fork, so present this section to the user (and Mahdi/Erfan) and get the shape agreed before writing it.
- **"Ask first"** for an OpenAPI contract change the frontend depends on.
- **Every route declares** `@Access` / `@OwnAccount` / `@PublicRoute`, because `backend/src/rbac/access/route-coverage.spec.ts` fails otherwise.
- **Run** `pnpm typecheck && pnpm lint && pnpm test` (backend).
- **Prefer a migration** over an ad-hoc schema edit: `pnpm db:migrate`, i.e. `prisma migrate dev --name agent_job_channel`.
- **Never run git operations unless asked**, and never push.

The bridge side (Tasks 13-17) already speaks all of this, and stays silent until the `hello` names a feature. So **R1 ships last, or in the same deploy, and lists only features whose routes are live.**

**R1 · `hello` with features.**
- `backend/src/agent-gateway/agent.gateway.ts`, `handleConnection`: once the token check passes, and **before** `this.clients.set(client, userId)` so no dispatch can precede it, send `client.send(JSON.stringify({ type: 'hello', features: AGENT_FEATURES }))`.
- Define `export const AGENT_FEATURES = ['progress', 'result-details', 'ping'] as const` (in `agent-job-kinds.ts` or a new `agent-features.ts`).
- Today's bridges ignore unknown frame types, so this is safe to old bridges.
- Tests in `agent.gateway.spec.ts`: (a) an accepted bridge's socket gets the hello as its first `send`; (b) a rejected token is closed 4401 and gets no hello. The spec's `connect()` helper already fakes the socket.

**R2 · Progress (`features: progress`).**
- **Schema.** In `backend/prisma/schema.prisma`, add `progress Json?` and `progressAt DateTime?` to `PrReviewRequest` (line 521), `TaskImplementationRequest` (571), `TaskDescriptionRequest` (623), `ChangelogRequest` (676) and `ProjectTodolistRequest` (739). One migration (shared with R4): `backend/prisma/migrations/<ts>_agent_job_channel/migration.sql`. Add the two fields to `AgentJobRow` in `agent-job-kinds.ts`.
- **DTO.** In `dto/agent-job.dto.ts`, add `ReportAgentJobProgressDto`:
  - `state`: `IsIn(['running','awaiting_input'])`.
  - `activity`: `ValidateNested`, `{kind: IsIn(['action','thought','question','response','error']), text: MaxLength(500)}`.
  - `todos?`: `{done, total}`, `IsInt Min(0)`, nullable.
  - `step`: `IsInt Min(0)`.
  - `question?`: `{id: MaxLength(200), text: MaxLength(2000), header: MaxLength(200), options: string[] ArrayMaxSize(10), buttons: boolean}`.
- **Route.** In `plugin-jobs.controller.ts`, add `@Post(':path/:id/progress') @HttpCode(204) @OwnAccount('a running job this bridge claimed (AgentJobsService checks claimedById)')`, beside ack and refuse.
- **Service.** In `agent-jobs.service.ts`, add `progress(kind, id, user, dto)`. It is a no-op unless `row.claimedById === user.id && row.status === IN_PROGRESS`; otherwise it stores `progress: dto, progressAt: now`.
- **Read side.** `AgentJobDto` and `listMine` carry `progress` and `progressAt` for IN_PROGRESS jobs (`GET /agent-jobs/mine`).
- **Tests.**
  - `agent-jobs.service.spec.ts`: the claimer's progress is stored; another user's is ignored; a finished job's is ignored; `listMine` returns it.
  - `plugin.controllers.spec.ts`: the new route's guards are `ApiTokenAuthGuard` + LLM capability.
  - `route-coverage.spec.ts`: green.

**R3 · Answers from Rivendell (`progress` implies it).**
- **Route.** In `agent-jobs.controller.ts` (cookie auth, `JwtAuthGuard`), add `@Post(':kind/:id/answer')` with `@OwnAccount("the bridge owner's own running job (AgentJobsService checks claimedById)")` and the DTO `AnswerAgentJobDto { questionId: string; labels?: string[]; notes?: string }` (at least one of `labels` or `notes`).
- **Service.** `AgentJobsService.answer(user, kind, id, dto)`:
  - 404 for an unknown job.
  - **403 unless `row.claimedById === user.id`.** Settled: only the bridge's owner answers.
  - 409 unless the job is IN_PROGRESS, `progress.state === 'awaiting_input'` and `progress.question.id === dto.questionId`.
  - Then `gateway.dispatch({ type: 'job-answer', kind, requestId: id, questionId: dto.questionId, answer: { labels, notes } }, user.id)`, which reaches only that user's bridges.
- **Tests.** The owner's answer is dispatched to the owner; a non-owner gets 403; a stale `questionId` gets 409; a job not awaiting input gets 409.

**R4 · Structured result (`features: result-details`).**
- **DTO.** In `dto/submit-review-result.dto.ts`, add an optional `@ValidateNested() @Type(() => RunDetailsDto) details?: RunDetailsDto`, where `RunDetailsDto` is:

  ```
  {
    outcome?: {code, label, detail} | null,
    pr?: {number: IsInt, url: IsUrl, checks?: IsIn(['pass','fail','pending']) | null} | null,
    sessionId?: string,
    dashboardUrl?: string,
    wallSeconds?: IsInt,
    activeSeconds?: IsInt,
    tokens?: {in, out} | null
  }
  ```

  Top-level unknown fields stay forbidden.
- **Schema.** Add `runDetails Json?` to the same five models, in R2's migration.
- **Writes.** Every `complete()` stores `runDetails: dto.details ?? null`:
  - `agent-gateway/implementation-requests.service.ts:286`
  - `agent-gateway/review-requests.service.ts:140`
  - `changelogs/changelogs.service.ts:175`
  - `project-todolists/project-todolists.service.ts:410, 446, 484`
  - `task-descriptions/task-description-requests.service.ts:176`
- **Reads.** The response DTOs the task page reads gain `runDetails`, starting with `dto/implementation-request.dto.ts`.
- **Tests.** A DTO validation spec (`validate(plainToInstance(SubmitReviewResultDto, …), { whitelist: true, forbidNonWhitelisted: true })`): `details` is accepted, an unknown top-level field is still rejected, and a malformed `details.pr` is rejected. One service spec stores `runDetails`.
- **Optional.** `GET /plugin/tasks`' `implementation` gains `errorMessage` for FAILED, so the RIVENDELL card can say why when this bridge has no session for it.

**R5 · The `ping` job (`features: ping`).**
- **Service.** New `backend/src/agent-gateway/ping.service.ts`, in memory and not an AGENT_JOB_KIND (D13):
  - `start(user)`: returns `{ id, ok: false }` at once when `!gateway.isOnline(user.id)`. Otherwise it mints a `randomUUID()`, dispatches `{ type: 'ping-request', requestId }` to `user.id`'s bridges, and awaits the answer for up to 10 s. It returns `{ id, ok, rttMs }`.
  - `answer(id, user)`: resolves only for the same user.
- **Controller.** New `plugin-ping.controller.ts`: `@Controller('plugin/ping-requests')`, `ApiTokenAuthGuard`, `@RequireCapabilities(LLM)`, `@Post()` start and `@Post(':id/result') @HttpCode(204)` answer, both `@OwnAccount`. Register both in `agent-gateway.module.ts`.
- **Tests.** `ping.service.spec.ts`: resolves on the same user's answer; ignores another user's; an offline user gets `ok: false` without waiting; a timeout gives `ok: false`.
- **ponytail.** A single API instance holds the waiter; a multi-instance deploy would need Redis pub/sub.

**R6 · The task page: its own design pass.**
- **Surfaces.** `frontend/src/features/task-management/components/task-detail-dialog.tsx`, where `AiImplementationsSection` (around line 603) lists a task's runs, and `frontend/src/features/agent-jobs/` (`types.ts`, `queries.ts`, `components/agent-job-status.tsx`).
- **What it shows.** The progress line (activity, todos, step), the held question with answer buttons for the bridge's owner only (`claimedById === me`), and the result details (PR and checks, wall/active time, tokens, the outcome label).
- **Contract.** Regenerate the frontend client from the OpenAPI spec.
- **Design.** Run `/design-first` in the Rivendell repo before building, against Rivendell's own design system, not the bridge's HUD.

**R7 · Docs.** In `docs/agent-jobs.md`, under API → "For bridges", document hello/features, `POST …/:id/progress`, `job-answer`, `details` on results, and `ping-requests`, plus a note that a bridge sends nothing new without the feature.

---

## Rollout

1. Merge Part 1 (Tasks 1-12). Going live is **bridge-ship** (rebuild the dashboard, restart the bridge), and only with the user's OK.
2. Part 2's bridge tasks (13-17) can merge before Rivendell changes anything: with no `hello`, nothing new is sent.
3. Rivendell R1-R7 go in a Rivendell worktree, are presented to the user first (AGENTS.md), and are committed only when asked, never pushed by an agent. R1's feature list names only what is deployed.
4. Not fixed here, but noticed: `_post_result` can send an `error` longer than Rivendell's `MaxLength(5000)`. `_wait_job` returns `job.result` on some failures, and a 400 there leaves the request IN_PROGRESS. That's a one-line cap, but outside this plan.
