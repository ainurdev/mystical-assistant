# Flow-native chat UI — design

2026-08-25 · approved in-session (data-driven, full scope incl. handoffs)

## Problem

Every typed session renders the same way: `FlowCard` shows a summary, a flat
string list of fields, and up to three action buttons. The work inside a BUILD
session (plans, diffs, checks) looks identical to a REVIEW session (findings,
verdicts). Engagement is typing, plus one APPROVE button at gates.

The goal: after the first message (which stays a plain typed message — AUTO
TYPE classifies it), the chat UI specializes per flow, and the primary way the
user engages becomes flow-appropriate taps — approving plans, triaging
findings, annotating mockups, arming ops — with the text box always available
as the escape hatch.

## Decision: data-driven

`bridge/flow.py`'s premise is "a flow is data, not code", and custom flows
exist via `flow:*` settings rows. UI knowledge therefore lives in the flow
JSON, not in per-stype React components: flows declare field *types*, a
per-stage *input* hint, and *handoff* targets; the frontends ship generic
typed widgets keyed on those declarations. A custom flow authored later
inherits the entire rich UI. The six built-ins become data edits.

## 1. Schema extensions (`bridge/flows/*.json`, validated in `flow.py`)

### 1a. Typed card fields

`card_fields` entries may be either a bare string (today's form, renders as
text) or an object:

```json
"card_fields": ["approach", {"name": "checks", "type": "checks"}]
```

The engine normalizes every entry to `{name, type}` with `type` defaulting to
`"text"` (one helper, used by validation, contract composition, and
`catalog()` so frontends see normalized shapes).

Types and the shape the model must emit:

| type         | model emits                                              | widget          |
|--------------|----------------------------------------------------------|-----------------|
| `text`       | string (list of strings joins)                           | prose line      |
| `files`      | `["path", ...]` repo-relative, or `[{"path": str, "add"?: int, "del"?: int}]` | FileChips |
| `checks`     | `[{"cmd": str, "ok": bool, "note"?: str}]`               | CheckBoard      |
| `screens`    | `[{"path": str, "caption"?: str}]`                       | ScreenGallery   |
| `findings`   | `[{"file": str, "line"?: int, "severity": "high"\|"med"\|"low", "note": str}]` | FindingsTriage |
| `commands`   | `[{"cmd": str, "status"?: "ok"\|"fail"\|"pending"}]`     | CommandManifest |
| `confidence` | number 0–1                                               | ConfidenceMeter |
| `verdict`    | short string; renderer banners known values (pass/fail/yes/no/ship/needs_work), neutral otherwise | VerdictBanner |

### 1b. Per-stage `input` hint

Optional string telling the composer what the primary engagement is:

- `approve` — gate-first UI (the default at any gated stage awaiting advance)
- `arm` — approve variant: hold-to-confirm, for destructive ops
- `evidence` — paste-log / attach affordances above the keyboard
- `triage` — per-finding keep/dismiss; composer shows a triage summary chip
- `annotate` — per-screen notes in the gallery; composer collects them

Absent → plain composer. The text box never disappears under any hint.

### 1c. Per-stage `handoff`

Optional list of stypes this stage's card can spawn:
`"handoff": ["fix", "build"]`. Rendered as `OPEN AS FIX ▸` buttons on that
stage's card.

### 1d. Validation

`validate_flow` grows: card_fields entries must be a string or `{name, type}`
with a known type; `input` must be from the hint set; `handoff` targets must
name known stypes. Stays a required-keys check, not JSON Schema (existing
`ponytail:` ceiling in `validate_card` holds).

## 2. Contract changes (`compose_section`, `_CONTRACT`)

The card contract already names required fields. It additionally states each
typed field's expected shape, one line per non-text field, e.g.:

```
"checks" must be a JSON list: [{"cmd": "<command>", "ok": true|false}]
```

Cache note: the section stays stable per (flow, stage), so prompt caching is
unaffected.

**Nudge policy:** `validate_card` keeps its current presence checks only.
Wrong *shapes* are not nudged — the renderer degrades that field to text
(work is never lost, no turn is burned on punctuation). Missing fields nudge
exactly as today.

## 3. Typed widgets (dashboard + miniapp, mirrored like FlowCard)

`TypedField` replaces `formatValue` in both `FlowCard.tsx` files: it
dispatches on the declared type (from the catalog's normalized shapes) and
falls back to today's text rendering when the value doesn't match the
declared shape or the type is unknown (stale custom flow).

Widgets, shared across flows:

- **CheckBoard** — ✓/✗ row per check; tapping a ✗ sends a canned "fix: <cmd>"
  prompt (pairs with `next_allowed` loop-backs in build/fix/design).
- **FileChips** — tap opens the file in the EDITOR (dashboard) / file view
  (miniapp); shows +/− counts when the value carries them.
- **ScreenGallery** — swipeable images (reuses the transcript's existing
  image rendering path); per-screen note entry when the stage's input is
  `annotate`.
- **FindingsTriage** — severity chip, file:line link, expandable note;
  keep/dismiss toggles held client-side until sent.
- **CommandManifest** — numbered commands; status glyph per row when present.
- **ConfidenceMeter** — small horizontal meter.
- **VerdictBanner** — full-width banner colored by known verdicts.

## 4. Stage-aware composer

The composer (both apps) reads the current stage's `input` hint from the
catalog:

- Gated stage + card requesting advance → APPROVE-first layout (today's
  button, promoted). `arm` renders it as hold-to-confirm.
- `evidence` → PASTE LOG (multiline paste → sent as a fenced block) and the
  existing image-attach, surfaced above the keyboard.
- `triage` → summary chip ("KEEP 3 · DISMISS 2 → SEND"); send composes a
  structured prompt listing dismissed findings (+ optional free text).
- `annotate` → send composes "screen N: <note>" lines from the gallery.

Card `actions` (0–3 canned taps) keep working everywhere as today.

## 5. Handoffs

A card on a stage with `handoff` targets renders one button per enabled
target. Tap →

1. existing create-session endpoint with `stype` + first stage preset
   (`dashboard/server.py:736` path; `flowtype.kick` already no-ops on preset
   stype, so no classify runs);
2. first prompt composed from the card — flow label header, summary, fields
   serialized in `render_card` style — so the new session's first message is
   still a plain message;
3. UI navigates to the new session.

Failure → toast, button re-enabled. Buttons for disabled flows are hidden
(catalog only lists enabled ones).

## 6. The six built-ins (data edits)

- **build** — plan: approach text, `files`, risks text, input `approve`;
  implement: changed `files`; verify: `checks` + pass `verdict`; ship: gains
  `commit_msg` text (editable commit preview at the gate; APPROVE sends the
  edited message as the approval turn's text), input `approve`.
- **design** — draft: `screens`, input `annotate`; implement: changed
  `files`; verify: `checks` + pass `verdict` + shot `screens` (built result
  beside the approved mock).
- **fix** — reproduce: reproduced `verdict` + evidence text, input
  `evidence`; rootcause: cause/fix_plan text, input `approve`; fix: changed
  `files`; verify: `checks` + pass `verdict`.
- **ops** — state: will_do `commands` + blast_radius text, input `arm`;
  execute: ran `commands`; confirm: `checks` + ok `verdict`.
- **probe** — dig: `findings`; report: answer/recommendation text +
  `confidence`, handoff `["fix", "build"]`.
- **review** — sweep: `findings`, input `triage`; report: `findings` +
  `verdict`, handoff `["fix"]`.

## 7. Bot surface

Stays prose + `render_card`. One addition in `dispatch.py`: when a finished
turn's card is gated and requests advance, the message carries a Telegram
inline APPROVE ▸ button wired to the existing stage-advance action. Nothing
else changes on the bot.

## 8. Error handling summary

- Unknown type/input/handoff in a custom flow → `save_custom` validation
  error; never reaches a session.
- Model emits a wrong shape → that field renders as text; no nudge.
- Missing required field → one nudge turn (unchanged).
- Handoff create fails → toast + re-enabled button.
- Old sessions / history cards render through the same fallback path.

## 9. Testing

- **pytest** (`tests/`): normalization helper; `validate_flow` accepting
  string/object mixes and rejecting unknown types/inputs/handoffs;
  `compose_section` shape lines; handoff-prompt composer; all six built-in
  JSONs validate; `catalog()` carries normalized fields + hints.
- **Frontend checks**: `typedfield.check.ts` beside the existing
  `lib/*.check.ts` pattern — shape guards and text fallback per type.
- **bridge-eyes**: screenshot each widget state (check pass/fail, triage
  kept/dismissed, gallery, armed gate) in the dashboard; spot-check miniapp.

## 10. Rollout

Worktree per **bridge-worktree** (feature branch; no new persisted data — all
state rides existing card events and flow JSON). Build order: engine schema +
contract → typed widgets → stage-aware composer → handoffs → bot button.
Dashboard first, miniapp mirrored (usage is 95% dashboard). Live only after a
bridge restart per **bridge-ship**; template edits (`flows/*.json`) are live
per-turn, engine changes are not.

## Non-goals

- No per-flow theming beyond the widgets; the CRT-HUD system is unchanged.
- No bot parity beyond the gate-approve button.
- No new flow-editor UI — custom flows keep editing raw JSON; the new keys
  validate on save.
- No changes to AUTO TYPE / classification.
