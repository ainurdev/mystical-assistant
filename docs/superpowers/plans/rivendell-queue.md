# Rivendell request queue + accept/reject gate

## Why

Rivendell auto-ran every incoming request through a single serial consumer (the
consumer existed only to stop two runs racing a shared checkout). The operator
wants (a) to *see* the incoming requests and decide what runs, and (b) to run
several at once. Prompts now instruct each run to work in its own git worktree,
so the shared-tree race the serial consumer guarded against is gone — concurrency
is safe.

## Behaviour change

- Incoming requests (WS events + catch-up) are **held PENDING** in a per-worker
  queue instead of running on arrival.
- The dashboard PLUGINS tab shows the queue. **Accept** claims the request
  (`GET …/prompt`) and starts an autonomous run — accepts run concurrently, one
  thread each. **Reject** claims then POSTs `FAILED` ("declined by operator") so
  the decision sticks server-side (there is no reject endpoint; only
  COMPLETED/FAILED exist). Reject confirms in a dialog.
- rivendell no longer runs unattended. (Follow-up if wanted: a per-instance
  AUTO-ACCEPT toggle that accepts on enqueue.)

## Slice

- `bridge/rivendell.py`: `_pending` dict + `_q_lock` replace `_queue`/`_consume`;
  `_enqueue` fills pending; `accept`/`reject`/`_run_accepted`/`_do_reject`/
  `queue_snapshot`; manager `queue()`/`accept()`/`reject()`. Docstrings rewritten.
- `bridge/dashboard/server.py`: `GET /local/rivendell/queue` (flat rows sorted by
  created_at, each carrying instance name), `POST /local/rivendell/queue`
  (op accept|reject). `_session_brief` gains `created`.
- `bridge/dashboard/web/src/api.ts`: `RivendellQueueItem`, `rivendellQueue()`,
  `acceptRivendell()`, `rejectRivendell()`; `SessionBrief.created`.
- `bridge/dashboard/web/src/components/hud/SessionsPanel.tsx`: match plugin
  sessions by origin **prefix** (`rivendell:<name>`), sort PLUGINS tab by
  `created`, label each row with its plugin/instance; render the QUEUE block with
  hover accept/reject + reject-confirm.
- `tests/test_rivendell.py`: drain from `_pending`; add accept/reject tests.

## Note

Plugin sessions were invisible in the PLUGINS tab because the filter compared the
full origin `rivendell:<name>` against the bare `"rivendell"`. Prefix match fixes
it; those sessions also legitimately appear in Projects/Attention/Recent.
