# Notifications Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One bridge-kept notification feed. Every event Telegram hears today lands in the
dashboard bell, the toasts, the OS/Mac banners and Telegram, each routed per event.

**Architecture:** `bridge/notices.py` owns a `notices` table, the event catalog, the prefs and
the Telegram routing. Every existing ping site calls `notices.emit()` and asks
`notices.telegram_ok()` before sending. NEEDS YOU is computed from live state into
`/local/running`. The dashboard polls `GET /local/notices` and renders the bell, toasts and
pills. Mystical.app reads `needs` and gets a subtitle and a thread for its banners.

**Tech Stack:** Python 3 stdlib + SQLite (bridge), React/TS (dashboard), Swift (macos/).

**Spec:** `docs/superpowers/specs/notifications.md` (mockups:
`.mystical/design-drafts/notifications/`).

## Global Constraints

- Python is stdlib only. `emit()` and `telegram_ok()` never raise into a run, a worker or a
  request.
- Schema changes are additive only (`_SCHEMA` + `CREATE INDEX IF NOT EXISTS`); master keeps
  reading the DB.
- Retention is 7 days. `GET /local/notices` returns at most 200 rows, newest first.
- Prefs live in `store` settings key `notify_prefs`. Unknown keys are dropped, and bad values
  fall back to the defaults table in the spec.
- Away is `time.time() - last_seen > away_min * 60`. Quiet hours span midnight when
  `from > to`. NEEDS YOU gets through quiet hours when `quiet.needs` is set.
- `config.NOTIFY_ENABLE` false → no Telegram, whatever the prefs say.
- Copy uses the mockups' verbs: APPROVE, QUESTION, ASKS, SIGN IN, LIMIT, OFFERED, DONE,
  FAILED, PARKED, RESUMED, STARTED, HELD, DISMISSED, REVIEWED / IMPLEMENTED / DONE (Rivendell,
  by job kind), REFUSED, LINK DOWN, LINK BACK, CHECKS FAILING, CHANGES ASKED, MOVED,
  MOVE FAILED, WEEKLY REPORT.
- The dashboard must survive an older bridge: a 404 on `/local/notices` shows "restart the
  bridge to see notifications" in the bell, and pills keep working.

## Review Focus

- A notice for the session you're looking at, in a visible window → no toast, no banner, no
  sound (`shouldPush`). Test: `notices.check.ts` `popFor()` returns null.
- First poll after a reload: rows older than the stored cursor must not pop again. Test:
  `notices.check.ts` `freshSince()` with a cursor.
- A quiet window across midnight (22:00→09:00) at 23:30 and at 08:59 is quiet; at 09:00 it
  isn't. Test: `test_quiet_spans_midnight` + the TS twin in `notices.check.ts`.
- A Rivendell batch's per-step turns must not emit `done` / `failed` (plugin sessions); only
  the job's `rv_done` / `rv_failed` does. Test: `test_plugin_session_turn_emits_nothing`.
- Corrupt `notify_prefs` (bad JSON or wrong types) → defaults, never a 500. Test:
  `test_prefs_bad_json_defaults`.

---

### Task 1: The feed, prefs and routing (`bridge/notices.py`, `bridge/store.py`)

**Files:**
- Create: `bridge/notices.py`
- Modify: `bridge/store.py` (`_SCHEMA`: table + 2 indexes; four functions)
- Test: `tests/test_notices.py`

**Interfaces — Produces:**
- `store.add_notice(kind: str, subject: str, title: str, body: str, meta: dict) -> int`
- `store.list_notices(since_ts: float, limit: int) -> list[dict]`, newest first, `meta` decoded
- `store.mark_notices_read(ids: list[int] | None) -> int`, where `None` means all unread
- `store.prune_notices(before_ts: float) -> None`
- `notices.CATALOG: dict[str, tuple[group, tier, source]]`
- `notices.DEFAULTS: dict[group, {"pop": bool, "sound": str, "tg": str}]`
- `notices.emit(kind, subject, *, title="", body="", meta=None) -> int | None`. Never raises.
  Prunes rows older than 7 days.
- `notices.feed() -> list[dict]`. Each row: `id, at, kind, group, tier, source, subject,
  title, body, meta, read`. A session subject gets its title, project and branch filled in
  from `store.get_session` when the row's title is empty.
- `notices.mark_read(ids: list[int] | None) -> int`
- `notices.prefs() -> dict` `{"events": {group: {...}}, "quiet": {"on","from","to","needs"}, "away_min": int}`
- `notices.set_prefs(patch: dict) -> dict` (validated merge, returns the result)
- `notices.seen(ts: float) -> None`; `notices.away(now=None) -> bool`
- `notices.quiet(now: datetime | None = None) -> bool`
- `notices.telegram_ok(kind: str, now: float | None = None) -> bool`
- `notices.needs(status: dict) -> list[dict]`. Each entry: `subject, kind, title, body,
  at, session_id, meta`. Sources: status `awaiting` (kind `permission`→approve,
  `question`→question, `None`→asking, with body and meta from the newest matching notice);
  `rivendell.queue()` items with `offered`; sessions whose newest notice is `login` or
  `limit_choice`.

- [ ] **Step 1: Write failing tests in `tests/test_notices.py`:**
  - `test_emit_and_feed_newest_first` (two emits → feed ids descending, `meta` round-trips)
  - `test_feed_fills_session_title` (a session row with an empty title gets the session's title)
  - `test_prune_drops_week_old` (a row with `at` = now − 8 d is gone after the next emit)
  - `test_mark_read_ids_and_all`
  - `test_prefs_defaults_and_patch` (patch `{"events": {"done": {"tg": "always"}}}` sticks;
    `{"events": {"done": {"tg": "loud"}}}` is ignored)
  - `test_prefs_bad_json_defaults` (`store.set_setting("notify_prefs", "{nope")` → defaults)
  - `test_telegram_ok_matrix`: off → False; always → True; away → depends on `seen()`;
    `NOTIFY_ENABLE` False → False
  - `test_quiet_spans_midnight`: 22:00→09:00, true at 23:30 and 08:59, false at 09:00
  - `test_quiet_lets_needs_through` (`ask` passes, `done` doesn't, while quiet)
  - `test_needs_from_status_offers_and_login` (monkeypatch `rivendell.queue`)
  - `test_emit_never_raises` (store raising → returns None)
- [ ] **Step 2:** `~/.cache/mystical-test-venv/bin/python -m pytest tests/test_notices.py -q` → fails (no module)
- [ ] **Step 3:** Implement. Schema:
  `notices(id INTEGER PRIMARY KEY AUTOINCREMENT, at REAL NOT NULL, kind TEXT NOT NULL,
  subject TEXT NOT NULL, title TEXT NOT NULL DEFAULT '', body TEXT NOT NULL DEFAULT '',
  meta TEXT NOT NULL DEFAULT '{}', read_at REAL)`, plus `ix_notices_at(at)` and
  `ix_notices_subject(subject, id)`. `_last_seen` is a module float starting at `-inf`. The
  module docstring says why the feed is bridge-side and why NEEDS YOU is derived.
- [ ] **Step 4:** Rerun the tests → pass
- [ ] **Step 5:** Commit `notices: the bridge keeps one feed, its prefs and the Telegram routing`

### Task 2: Routes (`bridge/dashboard/server.py`)

**Interfaces — Consumes:** Task 1. **Produces:**
- `GET /local/notices` → `{"notices": notices.feed(), "prefs": notices.prefs(), "quiet": bool}`
- `POST /local/notices`:
  - `{"op":"read","ids":[..]}` or `{"op":"read","all":true}` → `{"ok": true, "n": int}`
  - `{"op":"prefs","patch":{...}}` → `{"prefs": {...}}`
  - anything else → 400
- `GET /local/running?seen=<epoch>` calls `notices.seen(float)` and adds
  `"needs": notices.needs(snapshot["status"])` to the response.

- [ ] **Step 1:** Write failing tests in `tests/test_notices_endpoint.py`, copying the HTTP
  harness of an existing endpoint test (`tests/test_projectmarks_endpoint.py` or the closest
  on master):
  - `test_get_notices_shape`
  - `test_post_read_all`
  - `test_post_prefs_roundtrip`
  - `test_post_bad_op_400`
  - `test_running_carries_needs_and_seen`
- [ ] **Step 2:** Run them → fail
- [ ] **Step 3:** Add the routes next to `/local/running`, specific paths first
- [ ] **Step 4:** Run them → pass
- [ ] **Step 5:** Commit `dashboard: /local/notices, and /local/running carries needs + seen`

### Task 3: Session and bridge emitters

**Files:** `bridge/runner.py`, `bridge/tailstate.py`, `bridge/limits.py`, `bridge/ladder.py`,
`bridge/recovery.py`, `bridge/report.py`, `bridge/movejob.py`. Tests go in `tests/test_notices.py`
(emitter section).

**Interfaces — Consumes:** `notices.emit`, `notices.telegram_ok`.
**Produces:**
- `runner._notify(chat_id, text, kb=None, *, kind=None, sid=None, body="", meta=None)`
  emits when `kind` is given, then sends to Telegram only if `NOTIFY_ENABLE`, a chat, and
  (`kind` is None or `telegram_ok(kind)`).
- `runner.notify_awaiting(chat_id, sid, kind, body="", job_id=None)`, with the caller
  (`_handle_control_request`) passing the tool and summary, or the first question's text,
  and `job.id`.
- `runner.notify_turn_done(chat_id, sid, is_error, body="")`. For an error, the body comes
  from `store.last_turn(sid)["outcome"]` (label in sentence case + ": " + detail, cut at
  200); for done, it is the tail's first line, cut at 200. `meta.elapsed` comes from the turn.
- `runner.notify_needs_you(...)`: kind `asking`, body = the ask.

Kinds by site:

| Site | Kind | Body |
|---|---|---|
| park on limit | parked | |
| API retry | parked | "API error, retrying in …" |
| outdated CLI | failed | |
| context | failed | |
| hung resume | resumed | |
| crash resume | resumed | |
| `_auth_stop` | login | |
| `resume_after_login` | resumed | |
| bot-path start (`🤖 On it…`) | started | "from Telegram" |
| `limits` reset | resumed | |
| `ladder._offer` | limit_choice | |
| `ladder.take` | resumed | "continuing on …" |
| `recovery` | resumed | |
| `report` weekly send | weekly | |
| `movejob.finish` | move_done / move_failed | |

`ladder`, `limits` and `recovery` take an injected `notify`. Emit beside the call and gate
it with `telegram_ok`, keeping the injected callable for tests.

- [ ] **Step 1:** Write failing tests:
  - `test_turn_error_emits_failed_with_outcome` (a fake `last_turn` with outcome
    CONTEXT → body starts "Out of context")
  - `test_turn_done_emits_done_with_closing_line`
  - `test_plugin_session_turn_emits_nothing`
  - `test_awaiting_emits_approve_with_summary`
  - `test_tg_off_suppresses_send` (monkeypatch `runner.send`; `prefs` tg off → not called;
    the row still exists)
  - `test_move_finish_emits`
- [ ] **Step 2:** Run them → fail
- [ ] **Step 3:** Implement at each site (one or two lines each)
- [ ] **Step 4:** Run them → pass, then run the full suite
- [ ] **Step 5:** Commit `notices: sessions, limits, logins, recovery, the weekly report and MOVE write the feed`

### Task 4: Rivendell and PR emitters (`bridge/rivendell.py`, `bridge/prstatus.py`)

**Kinds by site:**

| Site | Kind | Subject | Title / body / meta |
|---|---|---|---|
| `_notify_queued` | rv_offer if `offered`, else rv_held | `rv:{id}:{request_id}` | title `{label} · {target}`; meta `instance_id, key, link, job_kind` |
| `accept()` | rv_started | same | |
| `reject()` | rv_dismissed | same | |
| `_ping_done` | rv_done / rv_failed | | meta `pr_url, pr_number, session_id, job_kind`. Emit even when no session ran here; the title is then "Rivendell job {request_id[:8]}" |
| `_post_result` final give-up | rv_failed | | body "Couldn't report the result to Rivendell; the transcript is in the dashboard." |
| impl no-checkout refusal | rv_refused | | body "No checkout of {slug} under {BASE_PATH}, so the bridge told Rivendell no. Clone it to take the next one." |
| `_alert_broken` | rv_link | `rv-link:{id}` | title = instance name; body as `linkAlertText` |
| `_recovered()` when `alert_at` was set | rv_link_back | same | body "down HH:MM → HH:MM" |
| `_send_question` (Rivendell run paused) | question | the session id | body = question; meta `job_id` |
| `prstatus._pings` fresh keys | pr_failing / pr_changes | `pr:{slug}:{branch}` | title `#{n} · {branch}`; meta `url, number` |

Telegram routing: `_deliver_telegram(text, kb, kind)` returns early unless
`notices.telegram_ok(kind)`. `_send_question` and `prstatus._telegram` gate the same way.

- [ ] **Step 1:** Write failing tests in `tests/test_notices.py`:
  - `test_rivendell_offer_emits_rv_offer` (drive `_notify_queued` on a stub worker as
    `tests/test_rivendell.py` does)
  - `test_rivendell_link_break_and_back`
  - `test_rivendell_done_without_session_still_emits`
  - `test_pr_fresh_ping_emits`
- [ ] **Step 2:** Run them → fail
- [ ] **Step 3:** Implement
- [ ] **Step 4:** Run them → pass, then run the full suite
- [ ] **Step 5:** Commit `notices: Rivendell jobs and links, PR checks and reviews write the feed`

### Task 5: Dashboard data layer

**Files:**
- Create: `bridge/dashboard/web/src/lib/notices.ts`, `lib/notices.check.ts`
- Modify: `api.ts`, `lib/push.ts`

**Produces:**
- `api.notices(): Promise<{notices: Notice[]; prefs: NoticePrefs; quiet: boolean}>`
- `api.noticesRead(ids: number[] | "all")`
- `api.noticePrefs(patch)`
- `api.running(alerts, seen?)`; `RunningInfo.needs?: Need[]`
- `push(title, body, tag?, onClick?, buttons?, onAction?, extra?: {subtitle?: string; thread?: string})`
- `lib/notices.ts`:
  - `VERB`, `TIER`, `GROUP`, `SOURCE`, `verbOf(n)`
  - `groupBySubject(rows) -> Row[]` with `earlier`
  - `sectionOf(at, now) -> "TODAY" | "EARLIER"`
  - `matches(filter, row)`
  - `badge(needs, rows, quiet) -> {kind: "count" | "dot" | "moon" | null, n}`
  - `isQuiet(q, date)`
  - `freshSince(rows, cursor) -> Notice[]`
  - `popFor(notice, {openSession, visible, prefs, quiet}) -> {sound?: ToneKey | null, pop: boolean} | null`

- [ ] **Step 1:** In `notices.check.ts`, write asserts for every function above, including
  the Review Focus cases (open-session suppression, cursor, midnight)
- [ ] **Step 2:** `node --experimental-strip-types src/lib/notices.check.ts` → fails
- [ ] **Step 3:** Implement
- [ ] **Step 4:** Run it → passes; `npx tsc --noEmit -p tsconfig.app.json` is clean
- [ ] **Step 5:** Commit `dashboard: notices client + pure helpers`

### Task 6: Bell, toasts, pills (`components/hud/Notifications.tsx`, `App.tsx`, `PrChip.tsx`, `MoveDock.tsx`)

- `Notifications.tsx`:
  - `notify(kind, text, onClick?)` now pushes a pill.
  - `PillHost` renders pills, bottom centre, one at a time (3 s, or 6 s for error), with
    the onClick as a "Show" action.
  - `NotificationCenter` polls `api.notices()` every 4 s, renders the badge and popover
    from the mockups, raises toasts for focus-visible pops (and `push()` otherwise), and
    plays sounds.
  - Module setters from App: `setNoticeEnv({open(sid), settings(tab, sec?), openSession(): string | null, settings: HudSettings})`, `setNeeds(Need[])`, `setLinks(RivendellInstance[])`.
- `App.tsx`: delete the transition push block (keep `doneIds`), the Rivendell link-notice
  block, `PushEvent`. Feed `setNeeds(r.needs)` from the running poll. Report `seen` (last
  pointerdown or keydown). Mount `PillHost`.
- `PrChip.tsx`: drop the bell ping (the bridge emits it). `MoveDock.tsx`: drop the
  news notify and chime (the bridge emits).
- Actions: Allow / Deny / options via `api.job` + `bannerActions` / `bannerAnswer` + `api.respond`;
  Accept / Dismiss / Run it too via `POST /local/rivendell/queue`; Open PR (`meta.pr_url`
  or `meta.url`); Settings (`plugins` / `move` / `aimgmt`).

- [ ] **Step 1:** `npx tsc --noEmit -p tsconfig.app.json` clean; `notices.check.ts` passes
- [ ] **Step 2:** Build to `/tmp/notif-dist`. Serve it with `.mystical/probe/probe.py`
  against a scratch bridge seeded with notices (`BRIDGE_DB=/tmp/notif.db`). Screenshot the
  bell (All, Rivendell, empty), a toast and a pill at 2x; compare with the mockup crops.
- [ ] **Step 3:** Commit `dashboard: the bell reads the feed; toasts and pills replace the ERR/INFO log`

### Task 7: Settings ▸ NOTIFY (`components/hud/SettingsModal.tsx`)

The block that replaces DESKTOP + SOUND has three parts:
- WHAT INTERRUPTS YOU: 14 rows, POP UP checkbox, SOUND select, TELEGRAM segmented. When
  `NOTIFY_ENABLE` is off, the column is disabled with "Telegram pings are off in System".
- QUIET HOURS: switch, from/to, let NEEDS YOU through.
- DEVICE (this browser): OS banners (the existing `push` + `requestPush`), sounds (the
  existing `pushSound`), volume (the existing `pushVolume` + preview).

Every change POSTs `{"op":"prefs","patch":…}`. Choosing a sound plays it.

- [ ] **Step 1:** tsc clean; screenshot at 2x against `04-settings` crop
- [ ] **Step 2:** Commit `settings: NOTIFY routes each event to a pop-up, a sound and Telegram`

### Task 8: Mystical.app (`macos/`)

- `NotificationShim.template`: forward `o.subtitle` and `o.thread` in `show`.
- `Notifier` `show`: set `content.subtitle` and `content.threadIdentifier`.
- `Running.waiting`: prefer `root["needs"]`. Each entry becomes `WaitingSession(id:
  session_id ?? "", title, label: verb + " · " + body)`. Fall back to `status`.
- `AppDelegate.openWaiting` and `FloatingPanel`: an empty id opens the dashboard window.

- [ ] **Step 1:** Write failing tests in `CoreTests.swift`:
  - `testWaitingPrefersNeeds`
  - `testWaitingFallsBackToStatus`
  - `testShimForwardsSubtitleAndThread` (the template contains `subtitle:` and `thread:`)
- [ ] **Step 2:** `cd macos && swift test` → fails, then implement, then passes
- [ ] **Step 3:** Commit `mac: banners carry a subtitle and a thread; WAITING ON YOU lists NEEDS YOU`

### Task 9: Whole-branch verification

- [ ] The full pytest suite: only the 7 known macOS failures (see memory mac-test-env)
- [ ] tsc clean (`-p tsconfig.app.json`); every `lib/*.check.ts` passes; `swift test` passes
- [ ] Screenshots of the built dist against the scratch bridge match the four mockup sheets
- [ ] A fresh reviewer reads the whole branch diff against this plan and the spec
