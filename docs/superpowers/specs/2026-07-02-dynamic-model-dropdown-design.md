# Dynamic model dropdown + per-model usage %

Today the chat composer's model picker is a **hardcoded** `opus/sonnet/haiku`
list. This feature makes it **self-updating**: on a **12-hour cadence, or as soon
as the 5-hour session window resets**, the bridge re-reads Anthropic's model
catalog and shows one entry per current family (Opus, Sonnet, Haiku, Fable…),
auto-gaining new families and dropping any that vanish. You can additionally
**pin** specific older versions (e.g. Opus 4.7) into the list. When Anthropic is
actively metering a model for your account, the dropdown shows that model's
**remaining headroom** (e.g. `Opus 4.8 · 82% left`).

This reuses the exact OAuth credential + fetch/cache pattern the existing
`bridge/usage.py` already uses; it needs no new auth and no background thread.

## What already exists (verified)

- **`bridge/usage.py`** loads the local OAuth token from
  `~/.claude/.credentials.json` (`_token()`), calls
  `GET https://api.anthropic.com/api/oauth/usage` with the
  `anthropic-beta: oauth-2025-04-20` header (`_fetch()`), normalizes to
  `{available, five_hour, seven_day, limits}` with a 60s TTL cache (`get_usage()`).
- **The usage payload carries per-model data** (verified live on this machine):
  top-level `seven_day_opus` / `seven_day_sonnet` buckets (currently `null`), and
  a `limits[]` entry `{"kind":"weekly_scoped", "scope":{"model":{"id":…,
  "display_name":"Fable"}}, "percent":…, "resets_at":…, "severity":…}`. Per-model
  buckets are populated **only when your plan meters that model**; otherwise `null`.
  `five_hour.resets_at` is the "session token reset" timestamp.
- **`GET https://api.anthropic.com/v1/models?limit=100`** succeeds with the **same
  OAuth token** + `anthropic-version: 2023-06-01` + the oauth-beta header (verified,
  HTTP 200). Returns `data: [{id, display_name, ...}]`, e.g. `claude-opus-4-8` /
  "Claude Opus 4.8", `claude-sonnet-5`, `claude-haiku-4-5-20251001`,
  `claude-fable-5`, plus older versions (`claude-opus-4-7`, `-4-6`, `-4-5`, `-4-1`,
  `claude-sonnet-4-5`). The list is newest-first.
- **The CLI accepts both aliases and full ids.** `claude --help` (v2.1.198):
  `--model <model>` — "Provide an alias for the latest model (e.g. 'fable',
  'opus', or 'sonnet') or a [full model name]". So `fable` is a real alias, and a
  pinned older version can pass its full id.
- **`bridge/transcript_jsonl.py:_short_model(id)`** already maps a full model id
  (`claude-opus-4-…`) to its short family (`opus`) — reused for family derivation
  and so cost/history keep working when a full id is stored on a turn.
- **`bridge/config.py:35`** `MINIAPP_MODELS = {"opus","sonnet","haiku"}` is the
  server-side allow-list; **`bridge/miniapp/server.py:63` `normalize_model_effort`**
  400s a run whose model isn't in it. The runner passes `--model <value>` as an
  **argv element** (`runner.py:145`) — no shell, so no injection risk; validation
  only keeps junk from reaching the CLI.
- **`bridge/store.py`** is the SQLite store: `_SCHEMA` + an idempotent `init()`
  that `executescript`s the schema and runs `ALTER TABLE`/`PRAGMA table_info`
  migrations (the `memories` table is the closest precedent for a new table).
- **Two parallel frontends**, each with its own hardcoded `MODELS` array:
  - Mini App `bridge/miniapp/web/src/components/Composer.tsx:17` (shadcn
    `DropdownMenu`, labels "Opus 4.8"…), polls `GET /api/usage` via
    `UsageStrip.tsx` (react-query, 60s).
  - Dashboard `bridge/dashboard/web/src/components/Composer.tsx:4` (custom `Drop`
    component; renders a `{model.toUpperCase()}` badge at line 257), served from
    `/local/usage`.
  - Shared type `ModelId = "opus"|"sonnet"|"haiku"` in each app's `api.ts`
    (`miniapp/web/src/lib/api.ts:114`, `dashboard/web/src/api.ts`). `chat.tsx`
    (mini app) / `App.tsx` (dashboard) hold `model` state and pass it to
    `api.run(...)`.
  - Both apps serve a prebuilt `web/dist` (rebuild via local bins; `pnpm build`
    can trip on esbuild → fall back to `vite build`; don't restart the bridge
    mid-session — per project memory). Frontend gate is `tsc -b` + build.
  - Backend tests are stdlib `unittest` under `tests/test_*.py`.

## Goals / non-goals

- **Goal:** dropdown reflects the live catalog (latest per family) + user pins,
  refreshed every 12h or on session reset; per-model remaining % shown when metered;
  pins persist server-side and appear on every surface.
- **Non-goal:** no background/cron refresh thread; no change to effort/permission
  pickers; no per-version metering (per-model % is per *family*); no exposure of
  raw token counts (usage stays percentages-only, matching `usage.py`).

## 1. Backend — model catalog (`bridge/models.py`, new)

Mirror `usage.py` structure and reuse its token loader.

- `_fetch_catalog(token)` → `GET /v1/models?limit=100` with headers
  `Authorization: Bearer …`, `anthropic-beta: oauth-2025-04-20`,
  `anthropic-version: 2023-06-01`; 5s timeout; returns `data` list or `None`.
- **Family reduction:** for each `{id, display_name}`, derive `family` via the same
  logic as `_short_model` (`opus`/`sonnet`/`haiku`/`fable`/…). Keep the **first**
  (newest) id per family. Produce
  `families: [{family, alias, id, label}]` where `alias` = family name when it's a
  **known CLI alias** (`{opus, sonnet, haiku, fable}`) else the concrete `id`
  (future-family fallback), and `label` = `display_name`.
- **`send_value(entry)`** — the string handed to `--model`: a family entry sends
  its `alias`; a pinned entry sends its full `id`.
- **Cache + triggers:** module-level `{ts, session_reset_seen, data}` guarded by a
  `Lock`. `get_catalog()` refetches when **`now - ts > 12h`** OR when the
  **session window has reset** since the last fetch. It learns the reset time from
  the usage layer: `usage.get_usage()` is cheap (60s cache) and returns
  `five_hour.resets_at`; if that timestamp differs from the one captured at last
  catalog fetch (i.e. a new 5h window began), invalidate. On fetch failure or no
  token → `{available: False}` (frontend then falls back to the static list).
- **Allowed-set helper:** `allowed_model_values(pins)` → set of every string the
  server may accept = family aliases ∪ pinned full ids ∪ all catalog ids. Used by
  validation (§4).

Returned shape:
```json
{ "available": true,
  "families": [{"family":"opus","alias":"opus","id":"claude-opus-4-8","label":"Opus 4.8"}, …],
  "catalog":  [{"id":"claude-opus-4-7","family":"opus","label":"Opus 4.7"}, …] }
```

## 2. Backend — per-model usage % (extend `usage.py`)

Extend `_normalize(payload)` to add a `models` map without changing existing keys:

```json
"models": { "opus": {"percent": 18, "resets_at": "…", "severity": "normal"}, … }
```

Built from (a) the `seven_day_<family>` top-level buckets when non-null, and
(b) any `limits[]` entry with `kind == "weekly_scoped"` whose
`scope.model.display_name`/`id` maps to a family. Only families with data appear;
absent families are simply omitted. The frontend computes **remaining =
100 − percent**. No new endpoint — this rides the existing `/api/usage` /
`/local/usage` payload the composer already polls.

## 3. Pins — server-side, synced

- **New table** in `store.py` `_SCHEMA` (+ create is idempotent via
  `CREATE TABLE IF NOT EXISTS`, no migration needed for fresh installs; existing
  DBs pick it up because `init()` runs `executescript` every startup):
  ```sql
  CREATE TABLE IF NOT EXISTS model_pins (
    owner_id   INTEGER NOT NULL,
    model_id   TEXT    NOT NULL,
    created_at REAL    NOT NULL,
    PRIMARY KEY (owner_id, model_id)
  );
  ```
- **Store helpers:** `list_model_pins(owner_id) -> list[str]`,
  `set_model_pin(owner_id, model_id, pinned: bool)`. `owner_id` is the chat/user id
  the servers already resolve (mini app via init-data `_auth`; dashboard via
  `config.DASH_CHAT_ID`).

## 4. Endpoints + validation

Both servers (`miniapp/server.py` GET dispatch on `/api/*` + `_auth`; dashboard
`server.py` `_get_api`/`_post` on `/local/*` behind the Host + `DASH_TOKEN` gates):

- **`GET /api/models`** (`/local/models`) → merges catalog + pins into the render
  model:
  ```json
  { "available": true,
    "models":  [ …latest-per-family…, …pinned entries appended… ],
    "catalog": [ …full list for the "More models…" picker… ],
    "pins":    ["claude-opus-4-7"] }
  ```
  Each `models[]` entry: `{value, label, family, pinned}` where `value` is exactly
  what gets sent to `--model` (§1 `send_value`). Cached server-side (§1); safe to
  poll.
- **`POST /api/models/pin`** (`/local/models/pin`) `{model_id, pinned}` → validates
  `model_id` is in the catalog, writes via `set_model_pin`, returns the fresh
  `pins`. Dashboard POST carries `DASH_TOKEN` like its other mutations.
- **Validation change:** `normalize_model_effort` validates against
  `models.allowed_model_values(store.list_model_pins(owner))` instead of the static
  `config.MINIAPP_MODELS`. If the catalog is unavailable (offline), fall back to the
  static `{opus, sonnet, haiku}` so runs never break. `config.MINIAPP_MODELS` stays
  as that fallback constant.

## 5. Frontend — both composers

Shared behavior, implemented in each app (they don't share code):

- **New API type + helper:** `ModelOption { value: string; label: string; family:
  string; pinned: boolean }`; `api.getModels()`. `ModelId` loosens to `string`
  (ripples through `chat.tsx`/`App.tsx` state, `api.run` param, persisted draft —
  all already treat it as an opaque string when sending).
- **Fetch** `GET /api/models` via react-query (like `useUsage`), plus the existing
  `/api/usage` poll. Merge: for each `ModelOption`, look up
  `usage.models[family]`; if present show a **remaining chip** `${100 - percent}%
  left`, colored with the same `sevColor` thresholds `UsageStrip` uses
  (amber/red on non-normal severity). No bucket → label only.
- **Dropdown contents:** latest-per-family rows, then pinned rows, then an
  expandable **"More models…"** section listing `catalog` with a **star** to
  pin/unpin (`POST /api/models/pin`, then invalidate the models query). Newly
  pinned versions appear in the main list.
- **Fallback:** when `available === false` (offline/no token), render the static
  `opus/sonnet/haiku` list — never an empty picker.
- **Dashboard badge:** replace `{model.toUpperCase()}` (Composer.tsx:257) with a
  `value → short label` lookup so a pinned full id (`claude-opus-4-7`) renders as
  e.g. `OPUS 4.7`, not the raw id.

## 6. Edge cases

- **No token / offline / 401:** `/api/models` → `{available:false}`; dropdown falls
  back to static list; validation falls back to static allow-list.
- **Stored session used a now-removed model:** the value is still sent verbatim
  (validation allows known ids; a truly stale id would 400 → surface a clear error
  and let the user re-pick). Not silently rewritten.
- **Future family with no CLI alias:** its `send_value` is the concrete id, so the
  run still works.
- **Per-model buckets all null (typical):** dropdown shows labels only; the
  existing 5h/weekly `UsageStrip` is unchanged.

## 7. Testing

Backend (`tests/test_*.py`, stdlib `unittest`, fixtures — no live network):

- `models`: family reduction + newest-per-family from a fixture catalog; alias vs
  concrete-id `send_value`; `allowed_model_values` = aliases ∪ pins ∪ ids;
  12h-TTL and session-reset invalidation (inject `ts`/`resets_at`).
- `usage`: `_normalize` emits the `models` map from a fixture payload containing a
  `weekly_scoped` scoped limit and a `seven_day_opus` bucket; omits null families;
  existing five_hour/seven_day keys unchanged.
- `store`: `model_pins` add/remove/list round-trip; idempotent `init()`.
- `server`: `normalize_model_effort` accepts a family alias, a pinned id, and a
  catalog id; rejects junk; falls back to static set when catalog unavailable.

Frontend gate: `tsc -b` + build in each app (fall back to `vite build`); manual
check that the dropdown renders the live list, a pinned version appears, and a
metered model shows a `% left` chip (or a fixture-injected usage payload if none
is metered).

## 8. Build sequence

1. `bridge/models.py` + unit tests → verify catalog fetch/reduce/cache in isolation.
2. Extend `usage._normalize` + tests.
3. `store.model_pins` table + helpers + tests.
4. Endpoints (`/api/models`, `/api/models/pin` on both servers) + validation swap
   + server tests.
5. Mini App composer: dynamic list, `% left` chips, "More models…" pin picker.
6. Dashboard composer: same, plus badge label lookup.
7. Rebuild both `web/dist`; smoke-test both surfaces.
