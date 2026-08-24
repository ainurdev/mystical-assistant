# Typed session flows — design

**Date:** 2026-08-24
**Status:** approved design, pre-plan
**Decided with:** user (Telegram), options presented as cards

## Summary

Sessions stop being one undifferentiated chat. A session can carry a **type**
(BUILD, FIX, PROBE, OPS, REVIEW, DESIGN); each type is a **flow** — a
server-owned sequence of stages with a start form, a per-stage reply contract,
and approval gates. A new engine (`bridge/flow.py`) owns the state: it injects
only the current stage's contract into each turn, validates that the turn ends
with a structured card, decides transitions, and holds gates shut until the
user taps APPROVE. Untyped sessions (`stype` NULL) are CHAT and behave exactly
as today — the engine is dormant for them.

The user chose the workflow-engine approach (C) over prompt-packs (A) and
skill-backed types (B): server-enforced stages, not prompt hopes.

## Goals

- Start a session by picking a type and filling a 1–4 field form instead of
  composing prose.
- Every turn in a typed session ends with a machine-readable card the UIs
  render as structure: outcome, fields, tappable next actions.
- Stages are server state. The model requests advancement; the server (and on
  gated stages, the user) decides. A gate cannot be prompt-engineered past.
- The session list groups and filters by type.

## Non-goals (v1)

- No auto-classification of existing sessions — untyped ones bucket as CHAT.
- No user-facing flow editor — `bridge/flows/*.json` files are the editor.
- No parallel or nested flows per session.
- No reimplementation of `/design-first` — the DESIGN flow invokes the skill.
- No hard-blocking of nonconforming turns — the model's work is never
  discarded; worst case the turn renders as prose like today.

## Concepts

| Term | Meaning |
|------|---------|
| **type / stype** | The kind of work: `build`, `fix`, `probe`, `ops`, `review`, `design`. NULL = CHAT. |
| **flow** | The definition of a type: form + ordered stages. One JSON file per type. |
| **stage** | One step of a flow. Has instructions, a card contract, optionally a gate and a permission-mode override. |
| **card** | The fenced ` ```hud-card ` JSON block a typed turn must end with. Parsed by the runner into a `card` event. |
| **gate** | A stage flagged `gate: true` advances only on explicit user action, never automatically. |

## Data model (`bridge/store.py`)

Additive, same ALTER-if-missing migration pattern as `tags`:

- `sessions.stype TEXT` — NULL for CHAT.
- `sessions.stage TEXT` — current stage id; `done` after the last stage.
- `turns.stage TEXT` — stamp of the stage the turn ran under (audit/render).

Stage transitions append to the existing `events` table (type `stage`) —
history is free, no new table. Parsed cards append as `card` events.

## Flow definitions (`bridge/flows/*.json`)

Loaded from disk per run — **not** frozen into `bridge/config` constants — so
editing instructions or forms takes effect on the next turn without a bridge
restart. Engine code changes still need a restart (bridge-ship as usual).

```json
{
  "stype": "fix",
  "label": "FIX",
  "blurb": "Hunt and kill a bug.",
  "form": [
    {"key": "what",  "label": "WHAT BROKE",  "required": true,  "multiline": true},
    {"key": "seen",  "label": "WHERE SEEN",  "required": false, "multiline": false},
    {"key": "repro", "label": "REPRO STEPS", "required": false, "multiline": true}
  ],
  "stages": [
    {"id": "reproduce", "label": "REPRODUCE", "gate": false,
     "instructions": "…", "card_fields": ["reproduced", "evidence"]},
    {"id": "rootcause", "label": "ROOT-CAUSE", "gate": true,
     "instructions": "…", "card_fields": ["cause", "fix_plan"]},
    {"id": "fix", "label": "FIX", "gate": false, "permission_mode": "acceptEdits",
     "instructions": "…", "card_fields": ["changed"]},
    {"id": "verify", "label": "VERIFY", "gate": false,
     "instructions": "…", "card_fields": ["checks", "pass"]}
  ]
}
```

### The six flows

| Type | Form | Stages (gate marked ◆) |
|------|------|------------------------|
| **BUILD** | what / why / done-when | PLAN ◆ → IMPLEMENT → VERIFY → SHIP ◆ |
| **FIX** | what broke / where seen / repro | REPRODUCE → ROOT-CAUSE ◆ → FIX → VERIFY |
| **PROBE** | question / depth (quick·deep) | DIG → REPORT |
| **OPS** | task | STATE ◆ → EXECUTE → CONFIRM |
| **REVIEW** | target (branch/PR/path) / depth | SWEEP → REPORT |
| **DESIGN** | brief | DRAFT ◆ → IMPLEMENT → VERIFY |

Gate rationale: BUILD gates before code is written and before shipping; FIX
gates on the diagnosis (agree on the cause before edits); OPS gates before
anything executes (the destructive-action gate); DESIGN keeps the approval
`/design-first` already has, formalized as a stage gate. PROBE and REVIEW are
read-shaped and run gateless. DESIGN's DRAFT instructions tell the session to
invoke `/design-first` with the brief — the skill does the work, the flow
records the state.

`permission_mode` per stage is optional; when set, it overrides the session's
mode for turns run in that stage (v1 sets it only where obviously safe, e.g.
`fix.fix: acceptEdits`; OPS.EXECUTE deliberately leaves the session default so
tool prompts still ask).

## Engine (`bridge/flow.py`, new)

Stdlib only, like everything else. Four responsibilities:

**1. Compose.** At turn composition (`runner._compose_system_prompt`,
`bridge/runner.py:100`, called at :346), append the flow section for typed
sessions: the stage map (labels only), the *current* stage's instructions, the
card contract for that stage, and the gate rule ("you may set advance:true;
gated stages advance only when the user approves"). Only the current stage's
contract ships — a 40-turn session cannot drift, because every turn is
composed from server state. The text is stable per (type, stage), so the
prompt-cache cost noted at `runner.py:104-114` is paid only on transitions,
when context legitimately changes.

**2. Validate.** When a turn finalizes, the runner scans the final assistant
text for the **last** fenced `hud-card` block, `json.loads` it, and checks
required keys: `stage`, `summary`, and the stage's `card_fields` present in
`fields`. Valid → emit `card` event, stamp `turns.stage`.
Invalid or missing → emit `card_missing`, render prose as today, and fire
**one** automatic nudge turn ("End your reply with the hud-card block for
stage X — restate your result in it"), reusing the system-initiated-turn
machinery that auto-resume (`bridge/limits.py`) already exercises. Capped at
one nudge per user turn; a second failure just stays prose.
`# ponytail:` validation is a required-keys check, not JSON Schema — upgrade
if flows ever need typed/nested field constraints.

**3. Transition.** After a valid card:
- `advance: true` and stage not gated → advance now, emit `stage` event
  `{from, to, by: "auto"}`.
- `advance: true` and gated → no server change; the card renders an APPROVE
  button. `POST /api/sessions/{id}/stage {action: "advance"}` performs it
  (`by: "user"`).
- Manual `back` / `set` are always allowed (stage dropdown in the header) and
  take effect at the next turn's composition.
- Advancing past the final stage sets `stage = "done"`; the flow section
  reduces to a one-line "flow complete" note and the card becomes optional.
  `lifecycle` is untouched — flow-done and session-ending stay independent.

**4. Permission.** Effective permission mode for a turn =
`stage.permission_mode or session.permission_mode`, resolved at compose time.

## Card contract

The turn's final text ends with:

````
```hud-card
{"stage": "fix",
 "summary": "Guarded parse_tags against non-list JSON; all callers covered.",
 "fields": {"changed": ["bridge/store.py:409"]},
 "advance": true,
 "actions": [{"label": "RUN FULL SUITE", "send": "run the full test suite"}]}
```
````

- `stage`, `summary`, `fields` required; `advance`, `actions` optional.
- `actions` are tappable buttons that send their `send` text as the next
  prompt — canned next moves instead of typing.
- Frontends render the card; the raw fenced block is hidden from the
  transcript body (the parsed `card` event is the source of truth).

## API

Served by both HTTP servers (`bridge/miniapp/server.py`,
`bridge/dashboard/server.py`), same pattern as existing session endpoints:

- `GET /api/flows` — catalog: stype, label, blurb, form schema, stage list
  (id, label, gate). No instruction text — UIs need shape, not prompts.
- `POST /api/sessions` — gains optional `stype`. Unknown stype → 400.
  The **first prompt is composed by the surface** (web composer, or dispatch
  for the bot) from the form as labeled lines, e.g. `[FIX] WHAT BROKE: …`,
  and sent through the normal message path — the store keeps only the type;
  prompts stay plain text end to end.
- `POST /api/sessions/{id}/stage` — `{action: "advance" | "back" | "set",
  stage?}`. Emits the `stage` event; next turn composes at the new stage.
- Session payloads (list + detail) gain `stype` and `stage`; the list endpoint
  accepts a `stype` filter.
- New event types on the existing stream: `card`, `stage`.

## Surfaces (per bridge-feature-slice)

**Dashboard** (primary — 95% of usage):
- New-session: type picker row (CHAT + six types; DESIGN button folds into
  it) → form fields from `/api/flows` → composed first prompt.
- Session header: stage rail (`REPRODUCE → ROOT-CAUSE → FIX → VERIFY`,
  current lit), manual stage dropdown.
- Transcript: card component (summary, fields, action buttons, APPROVE on
  gated cards) rendered from `card` events.
- Session list: type chip per row; group/filter by type, untyped = CHAT.

**Mini App:** same data, compact forms, stage chip instead of full rail, same
card rendering.

**Bot** (`bridge/dispatch.py`, rendering via `bridge/fmt.py`):
- `/new` keyboard gains a type row. Typed pick → one follow-up message; the
  reply lands in the form's primary field, other fields skipped.
  `# ponytail:` single-field bot form — labeled-line parsing if phone-typed
  multi-field briefs ever matter.
- Cards render as plain-text sections; APPROVE and `actions` as inline
  buttons.

## Testing

- `tests/test_flow.py` — flow loading/validation, stage machine (auto vs
  gated advance, back/set, done), card parsing (valid, malformed JSON, missing
  fields, multiple blocks → last wins), per-stage prompt composition,
  permission-mode resolution.
- `tests/test_bridge.py` additions — `/api/flows`, create-with-stype,
  stage endpoint, stype filter, `card`/`stage` events on the stream.
- Env-dependent config stays conftest-pinned per the existing rule.

## Rollout

- Built in a worktree with its own DB (new persisted columns — bridge-worktree
  rule), landed via bridge-ship.
- Additive schema only; existing sessions read as CHAT and render unchanged.
- Flow JSON edits are live next turn; `flow.py`/runner/server changes need the
  restart.

## Build order (for the plan)

1. Store columns + `flow.py` engine + flow JSONs + tests (no UI yet).
2. Runner integration: compose, validate, nudge, transition, events.
3. API endpoints on both servers.
4. Dashboard picker/form/rail/cards/list.
5. Mini App.
6. Bot.
