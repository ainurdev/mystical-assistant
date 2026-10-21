# Logo picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a Pick logos button that dresses letter-only projects, and an AUTO
background that plates a logo only where it would vanish on the current theme.

**Architecture:** the bridge picks and stores (`bridge/projectmarks.py`, stdlib
only). The browser reads pixels for AUTO (`lib/logoinfo.ts`), and CSS on
`html[data-light]` switches the plate per theme.

**Tech Stack:** Python stdlib, React + TS, `gh` CLI for the organization lookup.

**Spec:** `docs/superpowers/specs/logo-picker.md`

## Global Constraints

- Never touch a mark you set, a mark following Rivendell, or a repo's own auto icon.
- Option A: one tap applies at once, a strip under the toolbar reports and offers Undo.
- AUTO is the default (no `plate` stored). `none` pins no plate; `light`/`dark` pin one.
- Organization pictures: organizations only, never GitHub's generated default.

## Review Focus

- A pick for a project that got a mark set meanwhile is dropped, not overwritten (`pick_all` re-reads under the lock).
- Undo leaves a pick you edited since (it's no longer `source: "pick"`).
- `gh` missing, unauthenticated or offline: the organization source is skipped, never an error.
- An old cached logo reading without `night`/`day` is read again, not treated as "no plate".
- AURORA keeps its silhouette, and Mystical's own tile is never plated by AUTO.

---

### Task 1: Pick logos in the bridge

**Files:** Modify `bridge/projectmarks.py` and `bridge/dashboard/server.py`. Test `tests/test_projectmarks.py` and `tests/test_projectmarks_endpoint.py`.

**Interfaces:**
- Produces `pick_all() -> {"picked": [{"rel", "how": "frontend"|"brand"|"org", "from"?}], "none": [rel]}`
- Produces `undo_picks() -> {"undone": int}`
- Produces `POST /local/project-mark/pick {action: "pick"|"undo"}`
- A pick mark: `{"kind": "logo", "source": "pick", "pick": {"how", "from"?}}` plus `logo` (frontend or org, copied) or `repo` (brand, by path)

- [ ] Tests:
  - `test_pick_gives_a_backend_its_frontends_logo` (unideck-api ← unideck's auto icon, bytes copied)
  - `test_pick_takes_a_brand_file_named_for_the_repo_but_not_a_clients`
  - `test_pick_takes_an_organizations_picture_but_not_a_person_or_githubs_default`
  - `test_pick_leaves_yours_rivendells_and_auto_icons_alone`
  - `test_undo_takes_back_only_picks_still_as_picked`
  - `test_rivendell_wins_over_a_pick`
  - `test_a_repo_icon_beats_an_earlier_pick`
  - the route test
- [ ] Implement `_frontend`, `_brand`, `_org`, `pick_all`, `undo_picks`. `_yours` and `_offer_rels` treat `source: "pick"` like no mark. `marks()` lets a repo icon beat a pick.
- [ ] Run the mark tests, then commit.

### Task 2: AUTO background

**Files:** Modify `bridge/projectmarks.py` (`PLATES` gains `none`), `lib/logoinfo.ts` (+ check), `components/ui/ProjectTile.tsx`, `index.css` and `components/hud/MarkEditor.tsx` (the AUTO option, the "light here" hint, the pick labels).

- [ ] `analyse()` returns `night` (needs a light plate on a 0.03 ground) and `day` (needs a dark plate on a 0.9 ground). A logo needs one when less than half of its ink reaches 2:1 against that ground; a fill never does. Checks: black wordmark → night only, white → day only, orange → neither, opaque square → neither.
- [ ] The tile sets `data-auto-n`/`data-auto-d` when no plate is stored. The CSS plates them under `html:not([data-light])` and `html[data-light]` respectively, excluding AURORA and `[data-self]`.
- [ ] The editor offers AUTO · NONE · LIGHT · DARK; AUTO is `null`, so nothing is stored.
- [ ] Run tsc and the checks, then commit.

### Task 3: The button and its strip

**Files:** Modify `api.ts` (`pickLogos`), `components/hud/ProjectsSettings.tsx` and `index.css`.

- [ ] Add Pick logos after All / Shown / Hidden. It calls `pickLogos("pick")`, refreshes the marks, and shows the strip: "Picked a logo for N projects", what each wears, what found nothing, Undo and ×.
- [ ] Verify on the scratch bridge at 2x, in Rivendell by night and by day.
- [ ] Run the full suite, tsc and the checks, then commit.
