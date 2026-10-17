# Notifications: one feed, kept by the bridge

Approved 2026-10-16 through /design-first ("Approve & build all"). Mockups and the draft SPEC:
`.mystical/design-drafts/notifications/` (01-bell, 02-toasts, 03-mac, 04-settings; 2x crops
in `crops/`). Theme in the mockups: FLINT VIOLET.

## Why

- Telegram hears ~30 kinds of event. The dashboard hears 5 (done, question, permission,
  parked, started), and only by diffing its own 4 s poll of `/local/running` (`App.tsx` push
  block). An event that happens with no dashboard open is never news.
- A failed turn banners as `✓ title — finished`. `PushEvent "failure"` is declared and never raised.
- 44 of the dashboard's 50 `notify()` calls are feedback on a click ("Copied.", "Archived.").
  Session news never reaches the bell, and the bell lives in page memory, so a reload clears it.
- Rivendell: offered jobs, held jobs, and done or failed results go to Telegram only. A job
  refused for having no checkout, or whose result POST gave up, goes to the log only. A batch
  rings the OS once per step.
- One sound for every event. Telegram ignores every dashboard setting.

## What it is

1. **The feed** (`bridge/notices.py`, table `notices`). Each site that pings Telegram today
   also writes one row: `{id, at, kind, subject, title, body, meta, read_at}`. `subject` is
   a session id, `rv:<instance>:<request_id>`, `rv-link:<instance>` or
   `pr:<slug>:<branch>`. Rows are kept for 7 days; `GET /local/notices` returns the newest
   200. Clients group rows by subject, newest first, so one session or job is one row with
   "n earlier".
2. **NEEDS YOU is live state, not stored state.** It covers:
   - sessions whose status is `awaiting` (a card, or a turn that ended on a question);
   - offered Rivendell requests still held in the queue;
   - sessions whose newest notice is `login` or `limit_choice`.

   It rides `/local/running` as `needs`, so the bell, the Mac menu bar and the WAITING ON
   YOU panel all read one list. Answering anywhere (the card, a Mac banner, Telegram, the
   PLUGINS queue) removes it, because the state changed.
3. **Routing.** Per-event-group prefs live on the bridge (`settings` key `notify_prefs`),
   because Telegram reads them:
   - `pop` (bool): a toast while a dashboard window has focus, otherwise the OS banner,
     never both;
   - `sound`: `blip`, `chime`, `ping`, `knock` or `none`;
   - `tg`: `off`, `away` or `always`.
   - Plus quiet hours `{on, from, to, needs}` and `away_min` (5).

   **Away** means no click or keypress in any dashboard window for `away_min`. Pages report
   their last input with the `/local/running` poll (`seen=`). `NOTIFY_ENABLE` stays the
   master switch for Telegram.
4. **The bell** (`Notifications.tsx`):
   - Badge: a peach count when something needs you, otherwise a violet dot for unread
     news, a moon during quiet hours.
   - Popover: filters All / Needs you / Sessions / Rivendell / PRs. NEEDS YOU is pinned,
     with its buttons. Then TODAY and EARLIER, one row per subject: a verb, the title, the
     body, the meta, the time. A row you've read shrinks to one line.
   - The Rivendell filter adds a link bar and a NOW section (running and held jobs).
   - The empty state uses the oracle line.
   - Closing the popover marks what it showed as read. "Mark all read" does it explicitly.
5. **Toasts** use the bell's row anatomy. At most 3; the rest fold into "+n more". Hovering
   pauses them. A news toast lasts 8 s; a needs toast lasts 30 s, then moves into the bell.
6. **Pills.** `notify(kind, text, onClick?)` keeps its name and every call site, and now
   draws a pill: bottom centre, one at a time, 3 s (6 s when red), never stored.
7. **Mac.** The banner gets a subtitle (project · branch, or the Rivendell instance) and a
   `threadIdentifier` (the subject); the tag is the subject, so a later banner replaces an
   earlier one. A Rivendell offer gets Accept / Dismiss. `Running.waiting` reads `needs`,
   falling back to `status` from an older bridge.

## Event catalog

| kind | group (settings row) | tier | Telegram today |
|---|---|---|---|
| approve, question | ask | needs | ❓ needs your approval / a question |
| asking | asked | needs | ❓ Claude needs you + the ask |
| login, limit_choice | account | needs | 🔐 login expired / ⛔ usage limit card |
| rv_offer | rv_offer | needs | 🧩 offered by a teammate |
| done | done | news | ✅ finished |
| failed | failed | news | ⚠️ hit an error, with the reason (context, outdated CLI…) |
| parked | parked | news | ⏳ usage limit |
| resumed, retrying, waiting, rv_link_back | resumed | fyi | ⏱️ hung, 🔄 crash / restart / reset / signed in, ↪ switched account, ⚠️ API retry (off by default) |
| started, rv_started | started | fyi | (bot echo only) |
| rv_held, rv_dismissed | rv_held | fyi | 🧩 queued behind running work |
| rv_done | rv_done | news | ✓ Rivendell job done |
| rv_failed, rv_refused | rv_failed | news | ✕ job failed / (refusal: log only) |
| rv_link | rv_link | news | ✕ link broken |
| pr_failing, pr_changes | pr | news | ✕ checks failing / ◆ changes requested |
| move_done, move_failed | bridge | news | (MoveDock only) |
| weekly | weekly | fyi | the weekly report |

Defaults (pop · sound · tg):

| group | pop | sound | tg |
|---|---|---|---|
| ask, asked, rv_offer | ✓ | ping | away |
| account | ✓ | knock | always |
| done | ✓ | chime | away |
| failed | ✓ | knock | away |
| parked | ✓ | none | away |
| resumed | — | none | off |
| started | — | none | off |
| rv_held | — | none | away |
| rv_done | ✓ | chime | away |
| rv_failed | ✓ | knock | away |
| rv_link | ✓ | none | always |
| pr | ✓ | blip | away |
| bridge | ✓ | none | off |
| weekly | — | none | always |

What the bridge gets past by itself (the `resumed` row) only lands in the bell: in a week
of real use that was 65 auto-resumes, and the turn's DONE or FAILED is the news anyway. A
FAILED or PARKED that lands within a minute behind a SIGN IN or LIMIT ask for the same
session is that ask's echo (`notices.echo`). It goes in the bell with `meta.quiet`, and
pops and sends nothing, because the ask already knocked once.

## Refinements while planning (vs the mockups)

- "Commit message ready" stays a pill with a Show action. It only fires while you're in the
  dashboard, after you started it. "Bridge didn't come back" stays a red pill, because the
  bridge can't record its own absence. So the settings table has no Commit row, and its
  bridge row reads "MOVE finished".
- "Finished" shows the closing line and the elapsed time. A file count isn't cheaply known,
  so it's left out.
- "Compact & retry" on a failed row is just Open: the failed turn in the transcript already
  carries its own actions.
- The Rivendell NOW row shows elapsed time, not a step count or a progress bar; nothing
  reports progress.

## Not in this

The Mini App and the Linux/Windows trays keep today's behaviour. No new event sources: goals
stay generic and there is no scheduler. No undo for archive. Pills are never persisted.
