# Usage-limit deferred auto-resume

**Date:** 2026-07-08
**Problem:** When the Claude account hits a usage limit (5-hour / weekly /
per-model window) mid-turn, the turn dies as a generic error. The runner's
immediate crash auto-resume retries twice while the window is still
exhausted, burns its cap, and gives up — nothing revisits the session when
the limit resets. The user comes back hours later to silently dead sessions.

## Design

One new module, `bridge/limits.py`, plus a hook at the runner's existing
single choke point for non-user turn deaths (`_maybe_auto_resume`).

**Detect.** A turn-death text is a limit death when it matches the CLI/API
shapes: `usage limit reached` (old CLIs appended `|<epoch>`; CLI 2.1.x's
error classifier still emits the phrase) or the newer
`You've hit your <usage|session|weekly|Opus|Sonnet|Fable …|org's monthly usage> limit`
family. Deliberately not matched: transient server 429s (`…(not your usage
limit)`) and spend-cap / usage-credit messages — waiting for a window reset
won't clear those, so they keep the normal error path. The text comes from
the result event (`job.result`) or, when the CLI dies without one, the
stderr tail (new `job.error_msg`).

**Defer.** Instead of the immediate resume, the session is parked:
`limits.defer(session_id, chat_id, cwd, model, effort)` records it in
`limit_resume.json` next to the DB (same restart-durable pattern as
`preview_queue.json`) and arms one global `threading.Timer` for the reset
time + 90s. Reset time comes from the OAuth usage endpoint already wrapped
by `bridge/usage.py`: the latest `resets_at` among windows reading ≥99%.
When nothing reads exhausted (60s cache lag, endpoint down), it probes again
in 30 minutes. The Telegram/streaming user gets one "paused, auto-resuming
~HH:MM" ping per episode. The blocking bot path (`handle_task`) defers the
same way.

**Fire.** At reset the timer resumes every parked session via
`start_streaming_job` with a limit-specific nudge (same wording family as
`recovery.NUDGE`). A busy run slot means the user moved on — skipped
silently. A resume that finds the account still limited errors with the same
limit message and lands right back in defer (self-healing), with episode
tries carried across fires and capped at `MAX_TRIES = 12`; a completed turn
closes the episode (`note_ok`).

**Boot.** `limits.boot()` (called from `main()` after `recovery.recover()`)
reloads the persisted file and re-arms the timer, so a bridge restart during
the wait loses nothing. Orphaned turns that boot recovery resumes while
still limited fail into the same defer hook — no special casing.

## Interactions

- Limit deferrals bypass `_resume_fails` (the crash-resume cap) entirely.
- `config.AUTO_RESUME` gates limit-resume too — it is a form of auto-resume.
- User Stop and the RUN_TIMEOUT watchdog are still never resumed.

## Testing

`tests/test_limits.py`: message matching against real CLI strings (positive
and negative), defer→persist→fire flow with injected run/notify, unknown
reset fallback, tries cap + episode reset, busy-slot skip, boot re-arm, and
the runner hook for both result-event and stderr-tail limit deaths.
