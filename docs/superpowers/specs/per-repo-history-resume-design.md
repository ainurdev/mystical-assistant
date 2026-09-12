# Per-repo history view + cross-device resume

A repo-centric rollup of every Claude session — date, # turns, total cost,
models used, last activity — on both clients, with one-tap resume of any past
session from either device.

## What already exists (verified)

- **Resume works**: sessions persist `claude_session_id`; the runner passes it as
  `--resume` (runner.py). Selecting a session + sending a message resumes it.
- **Cross-device is already shared at the data layer**: the dashboard runs as
  `DASH_CHAT_ID = min(ALLOWED_CHAT_IDS)` (= the Telegram uid); the Mini App authes
  as that same uid, so both read the same store sessions.
- `# turns`, `total cost`, `last activity`, `created` are all derivable from the
  existing `turns` table.

## Gaps this fills

1. No **aggregated metadata** view anywhere.
2. The **Mini App only shows the active project's sessions** (header dropdown) —
   a phone session in another repo isn't reachable without switching projects.
3. **Models used isn't stored** — the `turns` table has no model column and the
   runner never journals it.

## 1. Data (store)

- **Migration** (idempotent, in `store.init()`): add `model TEXT` to `turns`,
  guarded by a `PRAGMA table_info(turns)` check so re-running is a no-op.
- **Capture**: `start_turn(..., model=None)` persists the model. The runner passes
  the run's model on the streaming path; bot/blocking turns persist `NULL`
  (shown as "—"). Historical turns stay `NULL`.
- **Query** `history(chat_id, include_archived=False) -> list[dict]`: one row per
  session via `LEFT JOIN turns … GROUP BY session`:
  `{id, title, project, created, updated, archived, turn_count, total_cost,
  last_activity, models[]}` where `total_cost = COALESCE(SUM(turns.cost), 0)`,
  `last_activity = COALESCE(MAX(turns.started), updated)`, `models` = sorted
  distinct non-null `turns.model`.

## 2. Endpoints

| Mini App (Telegram-authed) | Dashboard (Host-gated) | Returns |
|---|---|---|
| `GET /api/history?archived=0` | `GET /local/history?archived=0` | `{sessions: EnrichedSession[]}` |

The live "running" dot reuses the existing `/api/running` · `/local/running`
(`bridge_running`), intersected client-side.

## 3. Mini App — `/history` tab (4th, after Preview)

Cross-repo list **grouped by repo**. Repo header: `name · N sessions · $total ·
last activity`. Session rows: `title — 3 turns · $0.02 · opus,sonnet · 2h ago`,
running dot if live. Controls: text filter, sort (recent | cost), show-archived
toggle.

## 4. Dashboard — `Chat | History` header toggle

A view-state toggle (no router added). History view is a full-width panel with
the same grouped-by-repo aggregates + filter/sort/archived. The existing sidebar
stays for in-chat navigation.

## 5. Cross-repo resume (correctness crux)

Opening **any** session — from either history screen — first sets the active
project to that session's `project` (`api.select(project)`), *then* opens the
session, so the next message resumes `--resume` in the **right cwd**. Without
this, resuming a repo-B session while repo-A is active would run in A.

- If the repo dir no longer exists, `select` fails → the session is viewable
  (read-only transcript), resume disabled with a short note.
- Mini App: tapping a history row navigates to the Run tab with that session
  loaded; the chat provider's auto-resolve effect is guarded so an explicit
  selection isn't overridden when the active project changes.

## 6. Testing

- store: migration idempotent; `history()` aggregates (count, cost sum,
  last_activity, distinct models, archived filter); `start_turn` persists model.
- HTTP: drive `/local/history` + `/api/history` against running servers.
- Frontend: both `tsc -b && vite build`.

## Scope guard (YAGNI)

No per-turn drill-down in history (tap opens the existing transcript); no
date-range filter; no export; model only (not effort).
