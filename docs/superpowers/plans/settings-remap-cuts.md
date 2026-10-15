# Settings Remap — Slice 1: the Cuts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the Settings tabs, features and browser settings the spec retires, without touching the AI MANAGEMENT page beyond two one-line edits, one commit per cut, suite green after each.

**Architecture:** Pure deletion in the dashboard (`bridge/dashboard/web/src`), the Mini App (`bridge/miniapp/web/src`) and the bridge (`bridge/*.py`, `tests/`). Every removed setting leaves `HudSettings` and its loader; every removed feature leaves its routes, panel, lib and tests together. The transcript-language cut comes last and alone because it is the only one that touches CSS on both surfaces.

**Tech Stack:** Python 3.10+ stdlib (bridge), React 19 + TypeScript + Vite (both web apps), pytest in `~/.cache/mystical-test-venv`, Node 26 (runs `.check.ts` files directly).

**Spec:** `docs/superpowers/specs/settings-remap-design.md` (v2) — sections "What goes", "Browser settings", "Pages", "Delivery order" slice 1.

## Global Constraints

- Work on branch `feat/settings-cuts` in the worktree `~/Projects/.worktrees/mystical-assistant/feat-settings-cuts`. `master` is the checkout the live bridge runs; never edit there during this slice.
- Python: standard library only, no new dependencies. Frontend: no new dependencies.
- Commit messages in the repo's voice: `<area>: <what> — <why>`, lowercase, no `Co-Authored-By`, no "Generated with" lines. Never `git push`.
- Inside AI MANAGEMENT (`AiManagementPanel`, `SkillsFold.tsx`, `ProjectsSettings.tsx`) only these edits are allowed: delete the `COPY CURRENT LOGIN` button (Task 8), stop reading `settings.agent` (Task 8), drop the import row (Task 8). No reshaping.
- Backend check after every task: `~/.cache/mystical-test-venv/bin/python -m pytest tests/ -q`. Only these 7 may fail on this Mac (pre-existing): `test_clip_panel::test_clip_marks_round_trip`, four in `test_map_command`, two in `test_startup`. Anything else red is yours.
- Frontend check after every task: `cd bridge/dashboard/web && npx tsc -p tsconfig.app.json --noEmit` and `cd bridge/miniapp/web && npx tsc -p tsconfig.app.json --noEmit` (the Mini App only changes in Task 9, but it costs seconds). `.check.ts` files run as `node src/lib/<name>.check.ts` from the web dir; a check prints nothing on success.
- Keep both skins alive: every page still renders under FLINT (`[data-theme^="flint"]`) and the HUD themes. Deletions only, no new classes.
- Deleting a function, delete its now-unused imports in the same commit (`noUnusedLocals` is off, so tsc will not tell you; grep the file for each name you removed).

## Review Focus

1. A browser whose stored `hud-settings` still says `indicator: "nyan"` (or `piano`, `tiles`) must open on the EQUALIZER, never throw — pinned by `lib/indicator.check.ts` in Task 5.
2. A browser that had per-event pack sounds assigned (`pushSounds` non-empty) must still ring the tone on DONE / QUESTION / FAILURE — pinned by `chime()` replacing `playSound()` in Task 6; verify by hand in Task 6 step 6.
3. A webhook URL someone pasted into GitHub must now get a plain 404 from the Mini App server, not a traceback — pinned by `tests/test_hooks_gone.py` in Task 1.
4. A theme whose default language was SIGNAL (`signal`, `foundry` in `lib/theme.ts`) must render in DOSSIER after Task 9 with its widgets drawn in WIRE's material — pinned by the before/after capture in Task 9 step 12.
5. The Mini App with `ma-tool-style` stored as `halo` must render CONTROL PLATE and never read the key — pinned by the Mini App's `toolwidget.check.ts` rewrite in Task 9 step 9.

---

### Task 0: Worktree and baseline

**Files:**
- Create: the worktree `~/Projects/.worktrees/mystical-assistant/feat-settings-cuts`

- [ ] **Step 1: Create the worktree from master**

```bash
cd ~/Projects/mystical-assistant
git worktree add -b feat/settings-cuts ~/Projects/.worktrees/mystical-assistant/feat-settings-cuts master
cp .env ~/Projects/.worktrees/mystical-assistant/feat-settings-cuts/.env
ln -s ~/Projects/mystical-assistant/bridge/dashboard/web/node_modules ~/Projects/.worktrees/mystical-assistant/feat-settings-cuts/bridge/dashboard/web/node_modules
ln -s ~/Projects/mystical-assistant/bridge/miniapp/web/node_modules ~/Projects/.worktrees/mystical-assistant/feat-settings-cuts/bridge/miniapp/web/node_modules
```

The symlinks are git-ignored (`node_modules` without a trailing slash in `.gitignore`); unlink them before removing the worktree at the end.

- [ ] **Step 2: Record the baseline**

```bash
cd ~/Projects/.worktrees/mystical-assistant/feat-settings-cuts
~/.cache/mystical-test-venv/bin/python -m pytest tests/ -q 2>&1 | tail -3
cd bridge/dashboard/web && npx tsc -p tsconfig.app.json --noEmit && cd ../../miniapp/web && npx tsc -p tsconfig.app.json --noEmit && echo tsc-ok
```

Expected: pytest reports exactly the 7 known failures; `tsc-ok` printed. Note the pass count; every later task must keep it minus the tests it deletes.

---

### Task 1: Remove inbound hooks (feature, routes, panel, tests)

**Files:**
- Delete: `bridge/hooks.py`, `tests/test_hooks.py`, `tests/test_hooks_endpoint.py`
- Create: `tests/test_hooks_gone.py`
- Modify: `bridge/dashboard/server.py:775-784` (GET) and `:944-960` (POST), `bridge/miniapp/server.py:23` (import list), `:360-386` (`_hook`), `:461-465` (the `/hook/` branch), `bridge/store.py:601-690` (the six hook functions; the `CREATE TABLE hooks` / `hook_events` statements at `:79-98` stay), `bridge/dashboard/web/src/api.ts:976-1004` (`HookRow`, `HookEvent`, `HooksInfo`) and `:1485-1490` (`hooks`, `hookAction`), `bridge/dashboard/web/src/components/hud/SettingsModal.tsx` (`"hooks"` in `Tab` `:165`, the TABS entry `:212-213`, the three `tab: "hooks"` INDEX rows, `HooksPanel` `:3193-3450`, the render `:5662`, the `HooksInfo` type import, the `Radio` icon import)

**Interfaces:**
- Consumes: nothing.
- Produces: `mini.Handler.do_POST` answers `/hook/<anything>` with `{"error": "not found"}` 404 (the existing non-`/api/` fallthrough).

- [ ] **Step 1: Write the failing test**

Create `tests/test_hooks_gone.py`:

```python
"""Inbound hooks were removed (settings remap, 2026-10-15): the public receiver
on the Mini App server is gone, so a webhook URL still pasted somewhere gets the
plain 404 every unknown POST gets. Driven without sockets via the
Handler.__new__ trick (mirrors test_breakdown_endpoint.py).

Run: python -m pytest tests/test_hooks_gone.py -v
"""

import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from bridge.miniapp import server as mini  # noqa: E402


def test_a_posted_hook_url_is_a_plain_404():
    h = mini.Handler.__new__(mini.Handler)
    box = {}
    h._json = lambda obj, code=200: box.update(obj=obj, code=code)
    h.path = "/hook/abc123"
    h.rfile = io.BytesIO(b'{"title":"build red"}')
    h.headers = {"Content-Length": "21"}
    h.do_POST()
    assert box["code"] == 404
    assert not hasattr(mini.Handler, "_hook")
```

- [ ] **Step 2: Run it to verify it fails**

Run: `~/.cache/mystical-test-venv/bin/python -m pytest tests/test_hooks_gone.py -v`
Expected: FAIL — `_hook` still exists and the POST is routed to it (it returns 404 for an unknown token too, so the `hasattr` assertion is the one that fails).

- [ ] **Step 3: Delete the feature**

```bash
git rm -q bridge/hooks.py tests/test_hooks.py tests/test_hooks_endpoint.py
```

In `bridge/miniapp/server.py`: remove `hooks` from the `from bridge import (...)` list at line 23; delete the whole `_hook` method (`def _hook(self, token: str):` through the line before `def do_GET`); in `do_POST` delete the four comment lines and the two-line `if path.startswith("/hook/"): return self._hook(...)` branch so the method starts with `path = urlparse(self.path).path` followed by `if not path.startswith("/api/")`.

In `bridge/dashboard/server.py`: delete the GET block from `if path == "/local/hooks":` through `"public": bool(config.PREVIEW_HOSTNAME)})` and the POST block from `if path == "/local/hooks":` through its final `return self._json({"error": f"unknown action {action!r}"}, 400)` (the one directly before `if path == "/local/mcp":`).

In `bridge/store.py`: delete from the `# --- Inbound hooks ---` comment through the end of `list_hook_events` (the line before `def default_disabled_tools`). Leave the two `CREATE TABLE` statements: an existing DB keeps its empty tables.

In `api.ts`: delete the `HookRow`, `HookEvent` and `HooksInfo` interfaces (and the comment above `HookRow`), and the `hooks:` and `hookAction:` members of `api`.

In `SettingsModal.tsx`: remove `| "hooks"` from `Tab`; delete the TABS entry `{ key: "hooks", ... }`; delete the three INDEX rows whose `tab` is `"hooks"`; delete `function HooksPanel()` through the closing brace before `function LoginFlow(`; delete `{shown === "hooks" && <HooksPanel />}`; remove `HooksInfo` from the `../../api` import and `Radio` from the lucide import.

- [ ] **Step 4: Verify**

```bash
grep -rn "hooks\.\|list_hooks\|hook_events\|HooksPanel\|HooksInfo" bridge/*.py bridge/dashboard/server.py bridge/miniapp/server.py bridge/dashboard/web/src/components/hud/SettingsModal.tsx bridge/dashboard/web/src/api.ts
~/.cache/mystical-test-venv/bin/python -m pytest tests/ -q 2>&1 | tail -3
cd bridge/dashboard/web && npx tsc -p tsconfig.app.json --noEmit && echo tsc-ok
```

Expected: the grep prints only `bridge/move.py` lines (Claude Code's own `hooks` key in `settings.json`, unrelated); pytest shows the baseline minus 31 (12 + 19 deleted) plus 1 new, same 7 known failures; `tsc-ok`.

- [ ] **Step 5: Commit**

```bash
git add -A bridge/hooks.py tests/test_hooks.py tests/test_hooks_endpoint.py tests/test_hooks_gone.py bridge/dashboard/server.py bridge/miniapp/server.py bridge/store.py bridge/dashboard/web/src/api.ts bridge/dashboard/web/src/components/hud/SettingsModal.tsx
git commit -m "settings: drop inbound hooks — 0 hooks and 0 events ever minted; the two tables stay empty"
```

---

### Task 2: Remove the CONFIG tab (agent config files)

**Files:**
- Delete: `bridge/agentconfig.py`, `tests/test_agentconfig.py`
- Modify: `bridge/dashboard/server.py:371-373` (GET) and `:1006-1015` (POST), `bridge/dashboard/web/src/api.ts:1057-1073` (`AgentConfigFile`, `AgentConfigTool`) and `:1562-1570` (`agentConfig`, `setAgentConfig`), `SettingsModal.tsx` (`"agentconfig"` in `Tab`, the TABS entry `:210-211`, the two INDEX rows `tab: "agentconfig"`, `AgentConfigPanel` `:2244-2351`, the render `:5660`, the `AgentConfigTool` import, the `FileCog` icon import)

**Interfaces:** none.

- [ ] **Step 1: Delete**

```bash
git rm -q bridge/agentconfig.py tests/test_agentconfig.py
```

In `bridge/dashboard/server.py` delete the three-line GET block starting `if path == "/local/agentconfig":` and the POST block starting `if path == "/local/agentconfig":` through `return self._json({"ok": True, **agentconfig.state()})`.

In `api.ts` delete `AgentConfigFile`, `AgentConfigTool`, and the `agentConfig:` / `setAgentConfig:` members with their doc comments.

In `SettingsModal.tsx` remove `| "agentconfig"` from `Tab`, the TABS entry, the two INDEX rows (`CLAUDE CODE`, `OPENCODE`), the comment block + `function AgentConfigPanel()` through the brace before `function EnvPanel()`, the render line, and the `AgentConfigTool` and `FileCog` imports.

- [ ] **Step 2: Verify**

```bash
grep -rn "agentconfig\|AgentConfig" bridge/ tests/ --include='*.py' --include='*.ts' --include='*.tsx' | grep -v node_modules
~/.cache/mystical-test-venv/bin/python -m pytest tests/ -q 2>&1 | tail -3
cd bridge/dashboard/web && npx tsc -p tsconfig.app.json --noEmit && echo tsc-ok
```

Expected: grep empty; pytest baseline minus 6; `tsc-ok`.

- [ ] **Step 3: Commit**

```bash
git add -A bridge/agentconfig.py tests/test_agentconfig.py bridge/dashboard/server.py bridge/dashboard/web/src/api.ts bridge/dashboard/web/src/components/hud/SettingsModal.tsx
git commit -m "settings: drop the CONFIG tab — claude /config and any editor already edit those files"
```

---

### Task 3: Report leaves Settings

**Files:**
- Modify: `SettingsModal.tsx` (`"report"` in `Tab` `:167`, TABS entry `:223-224` and the comment above it, INDEX row `:272`, the render block `:5653-5657`, the `WeekPanel` import `:25`, the `BarChart3` icon import)

**Interfaces:** `WeekPanel` keeps its two homes in `components/hud/Strip.tsx` (`:123` the brand cap, `:430` the clock menu) — untouched.

- [ ] **Step 1: Delete the tab**

Remove `| "report"` from `Tab`; delete the TABS entry and its leading comment ("Not a setting — a readout…"); delete the INDEX row; delete

```tsx
            {shown === "report" && (
              <Section title="WEEK" icon={BarChart3}>
                <WeekPanel inline />
              </Section>
            )}
```

and the `WeekPanel` and `BarChart3` imports.

- [ ] **Step 2: Verify**

```bash
cd bridge/dashboard/web && grep -n "WeekPanel\|BarChart3\|\"report\"" src/components/hud/SettingsModal.tsx; npx tsc -p tsconfig.app.json --noEmit && echo tsc-ok
```

Expected: grep empty; `tsc-ok`.

- [ ] **Step 3: Commit**

```bash
git commit -am "settings: the week report leaves Settings — it opens from the brand cap and the clock menu"
```

---

### Task 4: Remove AMBIENT and Claude·FM

**Files:**
- Modify: `SettingsModal.tsx` (`"ambient"` in `Tab`, TABS entry `:197-198`, the two INDEX rows `tab: "ambient"`, the `SEC_DESC` entries for `"WEATHER · header clock"` and `"CLAUDE·FM"` and matching `SEC_ICONS`, `WeatherCard` `:1821-1901`, the `shown === "ambient"` block `:5521-5560`, props `weather` / `onSetCity` / `onSetUnit` / `station` / `onStation` in `SettingsModalProps` `:127-132` and the destructure in `SettingsModal`, imports `CloudSun`, `Weather`, `RADIO_STATIONS`, `Cell` if unused)
- Modify: `bridge/dashboard/web/src/App.tsx` (`useRadio` import `:51`, `const radio = useRadio(settings.radioVolume)` `:471`, the palette command `:1911`, the context items `:2079` and `:2089`, `radio` in the deps array `:2104`, `radio=` / `onToggleRadio=` props `:2239-2240`, the four props `weather … onStation` passed to `SettingsModal` `:2482-2483`)
- Modify: `bridge/dashboard/web/src/components/hud/Strip.tsx` (props `radio` `:35`, `onToggleRadio` `:36`, the destructure `:238`, the `fmHover` state, the whole `<button className="fm" …>` `:349-382`; the surrounding `<span style={{ display: "flex", flexDirection: "column", gap: 3 }}>` keeps only the weather button)
- Modify: `bridge/dashboard/web/src/lib/ambient.ts` (delete `RadioState`, `Station`, `STATIONS`, `RADIO_STATIONS`, `useRadio` `:181-260`; keep `useHostVitals`, `useWeather`, `useFocus`)
- Modify: `bridge/dashboard/web/src/lib/theme.ts` (`radioVolume` in `HudSettings` `:434`, in `DEFAULTS` `:540`, in `loadSettings` `:626`)

**Interfaces:**
- `SettingsModalProps` loses `weather`, `onSetCity`, `onSetUnit`, `station`, `onStation`. `StripProps` loses `radio`, `onToggleRadio`.

- [ ] **Step 1: Delete the tab and the card**

In `SettingsModal.tsx` remove `| "ambient"`, the TABS entry, both INDEX rows, the two `SEC_DESC` / `SEC_ICONS` entries, `function WeatherCard(…)` through the brace before `/** What the bridge's own checkout is running`, the `shown === "ambient"` block, the five props from the interface and the destructure, and the now-unused imports (`CloudSun`, `Weather`, `RADIO_STATIONS`; keep `Volume` — Notify still uses it).

- [ ] **Step 2: Delete the radio**

In `App.tsx`: change line 51 to `import { useHostVitals, useWeather } from "./lib/ambient";`; delete line 471; delete the `{ id: "radio", … }` palette command; delete the `items.push({ icon: "»", label: "Next station", … })` line and the `{ icon: "♪", label: "Toggle Claude·FM", … }` item; remove `radio` from the deps array at the end of that `useMemo`; delete `radio={radio.radio}` and `onToggleRadio={radio.toggle}` from `<Strip …>`; delete `weather={weather} onSetCity={setCity} onSetUnit={setUnit}` and `station={radio.station} onStation={radio.setStation}` from `<SettingsModal …>` (keep `onFeed={feed}`).

In `Strip.tsx`: delete the two props from the interface and the destructure, the `fmHover` state line, and the `<button className="fm" …>…</button>` element.

In `lib/ambient.ts`: delete everything from `export interface RadioState` to the end of `useRadio` (the end of the file, if nothing follows).

In `lib/theme.ts`: delete the `radioVolume` line in the interface, the `radioVolume: 0.6,` in `DEFAULTS`, and `radioVolume: clamp01(p.radioVolume, 0.6),` in `loadSettings`.

- [ ] **Step 3: Verify**

```bash
cd bridge/dashboard/web && grep -rn "radio\|RADIO\|useRadio\|onStation\|WeatherCard" src --include='*.ts' --include='*.tsx' | grep -v "radio-\|aria-" ; npx tsc -p tsconfig.app.json --noEmit && echo tsc-ok
```

Expected: grep prints nothing (the `useWeather` hook and the clock popover's city editor in `Strip.tsx` stay — they never mention the radio); `tsc-ok`.

- [ ] **Step 4: Commit**

```bash
git commit -am "settings: drop AMBIENT and Claude·FM — the weather lives in the clock popover; a radio is not a dev tool"
```

---

### Task 5: Working indicator folds into Transcript; nyan, piano and tiles go

**Files:**
- Delete: `src/lib/nyan.ts`, `src/lib/songs.ts`, `src/lib/piano.ts`, `src/components/hud/usePianoEngine.ts`, `src/components/hud/PianoKeyboard.tsx`, `src/components/hud/PianoIndicator.tsx`, `src/components/hud/TilesIndicator.tsx` (all under `bridge/dashboard/web/`)
- Create: `bridge/dashboard/web/src/lib/indicator.ts`, `bridge/dashboard/web/src/lib/indicator.check.ts`
- Modify: `src/components/hud/WorkingIndicator.tsx` (imports `:3-7`, the three branches `:51-59`, `NyanIndicator` `:118-end`), `src/lib/theme.ts` (imports `:9,12,13`, `INDICATORS` / `Indicator` `:415-416`, the eight fields `:426-433`, `DEFAULTS` `:538-540`, `loadSettings` `:607-625`, the `legacyVoice` helper `:568-569`), `SettingsModal.tsx` (`"indicator"` in `Tab`, TABS entry `:195-196`, the INDEX row `:239`, the `// ---- WORKING INDICATOR` block `:302-357`, `IndicatorPicker` `:1652-1820`, the `shown === "indicator"` block `:5515-5520`, imports `AudioLines`, `NYAN_MODES`, `nyanThumb`, `NyanSound`, `VOICES`, `VOICE_GROUPS`, `SONGS`, `TILE_SPEEDS`, `TileSpeed`, `themeUnfilter` if unused; a new WHILE IT WORKS section at the end of the transcript page, a new INDEX row, a `SEC_DESC` entry), `src/index.css` (the nyan block `:639-688` and the PIANO TILES block from `:689` to the line before the next `/* ----` section header)

**Interfaces:**
- Produces: `lib/indicator.ts` exporting `INDICATORS = ["bar", "status"] as const`, `type Indicator`, `toIndicator(v: unknown): Indicator`. `lib/theme.ts` re-exports nothing new; `HudSettings.indicator: Indicator` stays.

- [ ] **Step 1: Write the failing check**

Create `src/lib/indicator.ts`:

```ts
/** What the transcript shows while the agent works. Two forms since the
 *  settings remap (2026-10-15): the braille spinner with its level bars, or one
 *  quiet status line. A stored pick from the retired forms (nyan, piano,
 *  tiles) lands on the spinner. */
export const INDICATORS = ["bar", "status"] as const;
export type Indicator = (typeof INDICATORS)[number];

export function toIndicator(v: unknown): Indicator {
  return v === "status" ? "status" : "bar";
}
```

Create `src/lib/indicator.check.ts`:

```ts
// Run: node bridge/dashboard/web/src/lib/indicator.check.ts
import { toIndicator } from "./indicator.ts";

console.assert(toIndicator("status") === "status", "status is kept");
console.assert(toIndicator("bar") === "bar", "bar is kept");
console.assert(toIndicator("nyan") === "bar", "a retired form lands on the spinner");
console.assert(toIndicator("piano") === "bar", "a retired form lands on the spinner");
console.assert(toIndicator("tiles") === "bar", "a retired form lands on the spinner");
console.assert(toIndicator(undefined) === "bar", "nothing stored is the spinner");
```

- [ ] **Step 2: Run the check**

Run: `cd bridge/dashboard/web && node src/lib/indicator.check.ts`
Expected: no output (it passes against the new module; the point of the check is to keep the mapping once theme.ts depends on it).

- [ ] **Step 3: Rewire theme.ts**

Delete imports at lines 9, 12, 13 (`./nyan`, `./piano`, `./songs`). Replace lines 414-416 with `export { INDICATORS, type Indicator } from "./indicator";` plus `import { toIndicator, type Indicator } from "./indicator";` near the other imports. In `HudSettings` delete the eight fields `nyan … tilesSpeed` (keep `indicator: Indicator;`). In `DEFAULTS` delete `nyan: "original", nyanSound: "match", nyanVolume: 0.4, nyanExtra: true,`, `pianoVoice: …, pianoVolume: 0.3,`, `tilesSong: "fur-elise", tilesSpeed: "normal",`. Delete the `legacyVoice` helper. In `loadSettings` replace the `indicator:` expression and the eight following field lines with:

```ts
        indicator: toIndicator(p.indicator),
```

- [ ] **Step 4: Rewire WorkingIndicator.tsx**

Delete the imports of `./nyan`, `PianoIndicator`, `TilesIndicator`; delete the three `if (hud?.indicator === "nyan" | "piano" | "tiles")` branches; delete `function NyanIndicator` through the end of the file (it is the last function; check nothing follows it). Remove `themeCompensator` / `themeUnfilter` from the `../../lib/theme` import if they were only used by `NyanIndicator` (grep the file).

- [ ] **Step 5: Delete the files and the CSS**

```bash
cd bridge/dashboard/web
git rm -q src/lib/nyan.ts src/lib/songs.ts src/lib/piano.ts src/components/hud/usePianoEngine.ts src/components/hud/PianoKeyboard.tsx src/components/hud/PianoIndicator.tsx src/components/hud/TilesIndicator.tsx
grep -n "^/\* ----" src/index.css | awk -F: '$1 > 689' | head -1
```

Delete `src/index.css` from line 639 (`/* nyan.cat, plain: …`) up to, not including, the section header the grep printed. Then `grep -n "nyan\|tiles-field\|\.tile\b\|piano" src/index.css` must print only `.flc-tiles` (unrelated, keep).

- [ ] **Step 6: Settings: the tab goes, the row moves to Transcript**

In `SettingsModal.tsx`: remove `| "indicator"` from `Tab`; delete the TABS entry; delete the INDEX row `{ tab: "indicator", sec: "WORKING INDICATOR", … }` and add `{ tab: "transcript", sec: "WHILE IT WORKS", terms: "working indicator equalizer spinner status line bars" },`; delete the `// ---- WORKING INDICATOR` block (`INDICATOR_TABS`) and `function IndicatorPicker` (through the brace before `/** City + unit …` — after Task 4, before `/** What the bridge's own checkout …`); delete the `shown === "indicator"` block; add to `SEC_DESC`: `"WHILE IT WORKS": "What the transcript shows while a session is working.",`; append after the RESULTS section inside `shown === "transcript"`:

```tsx
                <Section title="WHILE IT WORKS" top>
                  <div style={CARD}>
                    <Row first label="WORKING INDICATOR" desc="STATUS is one quiet line: what is running right now, and for how long. EQUALIZER is the braille spinner with level bars.">
                      <div style={{ width: 220 }}>
                        <Segmented
                          options={[{ label: "EQUALIZER", value: "bar" }, { label: "STATUS", value: "status" }]}
                          value={settings.indicator}
                          onPick={(indicator) => onPatch({ indicator })}
                        />
                      </div>
                    </Row>
                  </div>
                </Section>
```

Remove the now-unused imports (`AudioLines`, `NYAN_MODES`, `nyanThumb`, `NyanSound`, `VOICES`, `VOICE_GROUPS`, `SONGS`, `TILE_SPEEDS`, `TileSpeed`, `themeUnfilter`, `Indicator` from theme if unused).

- [ ] **Step 7: Verify**

```bash
cd bridge/dashboard/web && grep -rn "nyan\|Nyan\|piano\|Piano\|tilesSong\|TilesIndicator\|SONGS\b\|VOICE" src --include='*.ts' --include='*.tsx' --include='*.css'; node src/lib/indicator.check.ts; npx tsc -p tsconfig.app.json --noEmit && echo tsc-ok
```

Expected: grep empty; check silent; `tsc-ok`.

- [ ] **Step 8: Commit**

```bash
git add -A src/lib src/components/hud src/index.css
git commit -m "settings: the working indicator is a row in TRANSCRIPT — nyan, piano and tiles go (~1,200 lines nobody switched on)"
```

---

### Task 6: Per-event sound packs go; the tone rings

**Files:**
- Delete: `bridge/dashboard/web/src/lib/sounds.ts`, `bridge/dashboard/web/src/lib/sounds.check.ts`
- Modify: `src/lib/theme.ts` (import `:11`, `pushSounds` field `:462`, `DEFAULTS` `pushSounds: {}`, the `soundChoices` helper `:577-587`, `loadSettings` line `:656`), `src/App.tsx` (`:63` import, `:1013-1019` the `ping` helper, `:1058` and `:1067` deps, `:1065` the failure sound, `:1070-1073` the preload effect), `src/components/hud/MoveDock.tsx` (`:23` import, `:403`, `:416`), `SettingsModal.tsx` (the `// ---- NOTIFICATION SOUNDS` block `:807-1139` — `PackBrowser`, `EVENT_ICONS`, `SoundBoard`; the PER EVENT section inside `shown === "notifications"`; the `hidden` set line `...(settings.pushSound ? [] : ["PER EVENT"])`; the INDEX row `sec: "PER EVENT"`; the `../../lib/sounds` import block; icons used only there), `src/index.css` (`.sndrow` rules `:1152-1153` and `:1260`)

**Interfaces:**
- Consumes: `chime(tone: ToneKey = "blip", volume = 0.6): void` from `src/lib/push.ts` (exists).
- Produces: `type PushEvent = "done" | "question" | "permission" | "failure" | "start" | "limit"` local to `App.tsx`.

- [ ] **Step 1: Replace the sound path in App.tsx**

Line 60 becomes `import { chime, push, pushGranted, shouldPush } from "./lib/push";`. Delete line 63 (`import { playSound, preloadSound, type PushEvent } from "./lib/sounds";`) and add below the imports:

```ts
// The moments a session can ring for. The per-event pack sounds that used to
// hang off these went with the settings remap; every event rings the one tone.
type PushEvent = "done" | "question" | "permission" | "failure" | "start" | "limit";
```

In `ping` replace `playSound(settings.pushSounds[ev], settings.pushVolume, settings.pushTone);` with `chime(settings.pushTone, settings.pushVolume);`. At line 1065 replace `playSound(settings.pushSounds.failure, settings.pushVolume, settings.pushTone);` with `chime(settings.pushTone, settings.pushVolume);`. Remove `settings.pushSounds` from both deps arrays. Delete the preload effect (`useEffect(() => { for (const c of Object.values(settings.pushSounds)) preloadSound(c?.src); }, [settings.pushSounds]);`).

- [ ] **Step 2: Same in MoveDock.tsx**

Line 22 becomes `import { chime, push } from "../../lib/push";`; delete line 23; line 403 becomes `if (j.status === "done" && settings.pushSound) chime(settings.pushTone, settings.pushVolume);`; remove `settings.pushSounds` from the deps array at line 416.

- [ ] **Step 3: theme.ts and the files**

Delete import line 11, the `pushSounds` field and its comment, `pushSounds: {}` in `DEFAULTS`, the `soundChoices` helper, and `pushSounds: soundChoices(p.pushSounds),` in `loadSettings`.

```bash
cd bridge/dashboard/web && git rm -q src/lib/sounds.ts src/lib/sounds.check.ts
```

- [ ] **Step 4: Settings**

Delete the `// ---- NOTIFICATION SOUNDS` block (`PackBrowser`, `EVENT_ICONS`, `SoundBoard` — from the comment through the brace before `type ThemeCard`); delete the `{settings.pushSound && (<Section title="PER EVENT" …>…</Section>)}` block in the notifications page; change the `hidden` set to `const hidden = new Set<string>();`; delete the INDEX row for PER EVENT; delete the `../../lib/sounds` import block; remove icons only `EVENT_ICONS` used (grep each of `CircleCheck`, `MessageCircleQuestion`, `ShieldQuestion`, `TriangleAlert`, `Play`, `Hourglass`, `ListMusic` — delete the ones with no other use in the file). In `index.css` delete the three `.sndrow` lines.

- [ ] **Step 5: Verify**

```bash
cd bridge/dashboard/web && grep -rn "pushSounds\|lib/sounds\|playSound\|SoundBoard\|PackBrowser\|sndrow" src; npx tsc -p tsconfig.app.json --noEmit && echo tsc-ok
```

Expected: grep empty; `tsc-ok`.

- [ ] **Step 6: Hear it once (Review Focus 2)**

```bash
cd bridge/dashboard/web && npx vite build --outDir /tmp/cuts-dist --emptyOutDir >/dev/null && python3 ~/Projects/mystical-assistant/.mystical/probe/probe.py 8892 /tmp/cuts-dist 8790 &
```

Open `http://127.0.0.1:8892/?skipboot=1&token=<DASH_TOKEN from .env>` in the headless probe (`.mystical/probe-mac/cdp.mjs`, PRELOAD seeding `hud-settings` with `{"pushSound":true,"pushSounds":{"done":{"src":"https://example.invalid/x.mp3","label":"gone"}}}`), open Settings ▸ Notify and confirm the SOUND card shows only the switch, tone and volume. Stop the probe by port: `lsof -ti tcp:8892 -sTCP:LISTEN | xargs kill`.

- [ ] **Step 7: Commit**

```bash
git add -A src
git commit -m "notify: one tone per event — the PeonPing pack board goes (never assigned; the CLI's PeonPing already rings)"
```

---

### Task 7: MOVE keeps export and import; the dock-look page goes

**Files:**
- Modify: `src/lib/theme.ts` (`MoveBar` … `MovePrefs`, `MOVE_DEFAULTS`, `toMove` `:484-510`, the `move` field `:481`, `DEFAULTS` `move: MOVE_DEFAULTS`, `loadSettings` `move: toMove(p.move)`), `src/components/hud/MoveDock.tsx` (`:20` import, `:28-31` keep, `:346` `CORNER`, `:354-355` `MoveDock`, `:265` the SETTINGS ▸ button), `SettingsModal.tsx` (`MoveSub` / `MOVE_SUBS` `:4324-4329`, `Swatches` `:4807-4831`, `DEMO` / `DEMO_IMPORT`, `MoveProgress` `:4832-4946`, `MovePanel` `:4947-4992`, the `<MovePanel settings={settings} onPatch={onPatch} />` call, imports `Bar`, `Frame`, `JobCard`, `MOVE_COLORS`, `Pill`, `THICK` from `./MoveDock` and `MoveBar`, `MoveColor`, `MovePrefs`, `MoveThick` from theme, icons `Gauge`, `PanelBottom`, `LayoutPanelTop`, `Timer` if unused; the INDEX row `sec: "WHAT GOES"` loses `progress bar dock minimize`)

**Interfaces:**
- Produces: `MoveDock.tsx` owns `MovePrefs` and `const PREFS: MovePrefs` (the former `MOVE_DEFAULTS`); `MoveDock({ settings })` keeps its signature (it still reads `settings.push`, `pushSound`, `pushTone`, `pushVolume`).

- [ ] **Step 1: Move the types into the dock**

In `MoveDock.tsx` replace the import at line 20 with `import type { HudSettings } from "../../lib/theme";` and add after the imports:

```ts
// How the dock draws. These were thirteen Settings rows (MOVE ▸ PROGRESS) that
// nobody moved off their defaults; the defaults are the dock now.
export type MoveBar = "line" | "blocks" | "ascii" | "sweep";
export type MoveThick = "thin" | "regular" | "thick";
export type MoveColor = "acc" | "ok" | "purple" | "info" | "warn";
export interface MovePrefs {
  bar: MoveBar; thick: MoveThick; exportColor: MoveColor; importColor: MoveColor;
  corner: "tl" | "tr" | "bl" | "br"; mini: "pill" | "edge" | "frame";
  steps: boolean; log: boolean; eta: boolean; speed: boolean;
  startMin: boolean; autoHide: boolean; motion: boolean;
}
const PREFS: MovePrefs = {
  bar: "line", thick: "regular", exportColor: "acc", importColor: "purple", corner: "br",
  mini: "pill", steps: true, log: true, eta: true, speed: true,
  startMin: false, autoHide: true, motion: true,
};
```

Change `const prefs = settings.move;` to `const prefs = PREFS;`. Delete the `<Btn onClick={() => openSettings("move")}>SETTINGS ▸</Btn>` line (the REVIEW ▸ button at `:282` stays). Remove `openSettings` from the imports if the REVIEW button was its only other user — it is not (`:282`, `:401`), so keep it.

- [ ] **Step 2: theme.ts**

Delete `MoveBar`, `MoveThick`, `MoveColor`, `MoveCorner`, `MoveMini`, `MovePrefs`, `MOVE_DEFAULTS`, `toMove`, the `move` field and its comment, `move: MOVE_DEFAULTS` in `DEFAULTS`, `move: toMove(p.move),` in `loadSettings`.

- [ ] **Step 3: Settings**

Delete `Swatches`, `DEMO`, `DEMO_IMPORT`, `MoveProgress`; `MOVE_SUBS` keeps EXPORT and IMPORT, `MoveSub` becomes `"export" | "import"`; in `MovePanel` the focus line becomes `return f === "import" ? "import" : "export";`, delete `{sub === "progress" && …}`, and the signature becomes `function MovePanel()` with the call `<MovePanel />`. Delete the imports listed above that no longer resolve (`Bar`, `Frame`, `JobCard`, `MOVE_COLORS`, `Pill`, `THICK`, `MoveBar`, `MoveColor`, `MovePrefs`, `MoveThick`, `Gauge`, `PanelBottom`, `LayoutPanelTop`, `Timer` — grep each first). Trim the INDEX terms.

- [ ] **Step 4: Verify**

```bash
cd bridge/dashboard/web && grep -rn "MOVE_DEFAULTS\|settings\.move\b\|MoveProgress\|\"progress\"" src; npx tsc -p tsconfig.app.json --noEmit && echo tsc-ok
```

Expected: grep empty; `tsc-ok`.

- [ ] **Step 5: Commit**

```bash
git add -A src
git commit -m "move: the dock draws its defaults — the thirteen PROGRESS preferences go (all untouched since they shipped)"
```

---

### Task 8: Four small cuts — boot replay to the palette, the import stub, COPY CURRENT LOGIN, the retired `agent` field

**Files:**
- Modify: `src/App.tsx` (palette commands `:1909`, `onReplayBoot={replayBoot}` `:2502`, `ManagePrefs` `:119-126`, `importedProjects` `:288`, the localStorage write `:661-663`, `importProject` `:1649-1655`, the `imported:` and `onImport:` props `:2492` / `:2500`), `SettingsModal.tsx` (`onReplayBoot` prop `:133` and destructure `:5008`, `replayHover` state, the BOOT SEQUENCE section `:5382-5409`, INDEX row `:240`, `SEC_ICONS` `:456`, `SEC_DESC` `:499`, `MonitorPlay` import; the COPY CURRENT LOGIN button `:4165`; `importLegacy(profiles.profiles, api.profileWrite, settings.agent)` and `if (settings.agent) onPatch({ agent: "" });` in `AiManagementPanel`), `src/components/hud/ProjectsSettings.tsx` (`imported` / `onImport` props, `importPath` state, `doImport`, the `...imported.filter(…)` spread in `rows`, the `.ps-import` block), `src/index.css` (`.ps-import` rules `:4605-4609`), `src/lib/theme.ts` (`agent` field `:450-452`, `DEFAULTS` `agent: ""`, `loadSettings` `agent: str(p.agent, "")`)

**Interfaces:**
- `ProjectsSettingsProps` loses `imported` and `onImport`. `SettingsModalProps` loses `onReplayBoot`. `HudSettings` loses `agent`.

- [ ] **Step 1: Boot replay**

In `App.tsx` add after the `{ id: "settings", … }` palette command:

```ts
    { id: "replay-boot", label: "Replay boot intro", group: "Display", icon: "↻", run: replayBoot },
```

and delete `onReplayBoot={replayBoot}`. In `SettingsModal.tsx` delete the prop, the destructure, `const [replayHover, setReplayHover] = useState(false);`, the whole `<Section title="BOOT SEQUENCE" top>…</Section>`, the INDEX row, the `SEC_ICONS` and `SEC_DESC` entries, and the `MonitorPlay` import.

- [ ] **Step 2: The import stub**

`ProjectsSettings.tsx`: delete `imported` and `onImport` from the props interface and the destructure, `const [importPath, setImportPath] = useState("");`, `const doImport = …`, the `...imported.filter(…)` spread (the `rows` array becomes `groups.map(…)` sorted as before), and the `<div className="ps-import">…</div>` block. `App.tsx`: `ManagePrefs` becomes `{ hidden: Record<string, boolean>; removed: Record<string, boolean> }` and `loadManage` stops reading `imported`; delete the `importedProjects` state, `importProject`, the two props, and `importedProjects` from the localStorage write and its deps. `index.css`: delete the `.ps-import` rules.

- [ ] **Step 3: COPY CURRENT LOGIN**

Delete the one `<MiniBtn … onClick={() => void acc.act("add")} …>COPY CURRENT LOGIN</MiniBtn>` line in `accountsBody`. (`useAccounts.act` keeps accepting `"add"`: the bot's `/accounts add` still uses the route.)

- [ ] **Step 4: The retired `agent` field**

`theme.ts`: delete the field and its two comment lines, `agent: "",` in `DEFAULTS`, and the `agent: str(p.agent, ""),` line. `SettingsModal.tsx` (`AiManagementPanel`): the call becomes `importLegacy(profiles.profiles, api.profileWrite)` and the `if (settings.agent) onPatch({ agent: "" });` line goes.

- [ ] **Step 5: Verify**

```bash
cd bridge/dashboard/web && grep -rn "onReplayBoot\|importProject\|importedProjects\|onImport\|ps-import\|COPY CURRENT LOGIN\|settings\.agent\b" src; npx tsc -p tsconfig.app.json --noEmit && echo tsc-ok
```

Expected: grep empty; `tsc-ok`.

- [ ] **Step 6: Commit**

```bash
git add -A src
git commit -m "settings: boot replay is a palette command; the import stub, COPY CURRENT LOGIN and the retired agent field go"
```

---

### Task 9: One transcript language per surface — DOSSIER on the dashboard, CONTROL PLATE on the Mini App

**Files (dashboard, `bridge/dashboard/web/`):**
- Modify: `src/lib/toolwidget.ts` (`ToolStyle` `:33`, `TOOL_STYLES` `:43-50`, `LEGACY` / `isToolStyle` / `toToolStyle` `:88-102`), `src/lib/toolwidget.check.ts` (the style assertions), `src/lib/theme.ts` (`toolStyle` field `:465`, `DEFAULTS` `toolStyle: "dossier"`, `loadSettings` `:657-661`, `ThemeDef.chat` `:133` and the 24 `chat: "…"` entries, the `toToolStyle` / `ToolStyle` import `:14`), `src/App.tsx:533` (`toolStyle: d.chat`), `src/components/Transcript.tsx:231`, `src/components/hud/Terminal.tsx:400`, `src/components/RunStream.tsx:1573` (default), `src/components/Markdown.tsx:194` (default), `SettingsModal.tsx` (`OutputStylePicker` `:1503-1527`, `TranscriptWell`'s `style` param, `SchemePicker` / `ChatBgPicker` `style` plumbing, the OUTPUT STYLE section `:5453-5465`, INDEX row, `SEC_DESC` entry, `TOOL_STYLES` / `ToolStyle` import), `src/index.css` (the blocks listed in step 5)

**Files (Mini App, `bridge/miniapp/web/`):**
- Delete: `src/routes/output.tsx`
- Modify: `src/lib/toolwidget.ts` (`ToolStyle`, `TOOL_STYLES`, `LEGACY`, `isToolStyle`, `toToolStyle`, `STYLE_KEY`, `useToolStyle`), `src/lib/toolwidget.check.ts:61-74`, `src/router.tsx:8,11-14`, `src/routes/system.tsx` (`OutputStyleRow`, its import, the header line), `src/routes/run.tsx:19,73,283`, `src/components/RunStream.tsx:35,1057`, `src/index.css` (the blocks listed in step 8)

**Interfaces:**
- Dashboard: `ToolStyle = "dossier" | "wire"` — `wire` survives only as the widget material `ResultWidgets.material()` maps DOSSIER to; nothing user-facing offers it. `RunStream` and `Markdown` default `toolStyle` to `"dossier"`.
- Mini App: `ToolStyle = "stamp"`; `useToolStyle` is gone; `run.tsx` and `RunStream.tsx` use the literal.

- [ ] **Step 1: Dashboard types**

`src/lib/toolwidget.ts`: replace the `ToolStyle` line and its comment with

```ts
/** How the whole session reads. One language since the settings remap
 *  (2026-10-15): DOSSIER, a card per turn ranked by tier (index.css, DOSSIER).
 *  `wire` is not a language any more — it is the material DOSSIER draws its
 *  widgets in (ResultWidgets.material), and only that. */
export type ToolStyle = "dossier" | "wire";
```

Delete `TOOL_STYLES` and its comment, `LEGACY`, `isToolStyle`, `toToolStyle`.

`src/lib/toolwidget.check.ts`: delete every assertion that names `TOOL_STYLES`, `isToolStyle` or `toToolStyle`, and those names from the import. Run `node src/lib/toolwidget.check.ts` — silent.

- [ ] **Step 2: theme.ts and App.tsx**

```bash
cd bridge/dashboard/web && grep -c 'chat: "' src/lib/theme.ts   # 24
sed -i '' -E 's/, chat: "(dossier|stamp|wire|signal|press|halo)"//g' src/lib/theme.ts
grep -c 'chat: "' src/lib/theme.ts   # 0
```

Then delete `chat: ToolStyle;` and its comment from `ThemeDef`, the `toolStyle` field and comment from `HudSettings`, `toolStyle: "dossier"` from `DEFAULTS`, the `toolStyle:` line and its four-line comment from `loadSettings`, and `toToolStyle, type ToolStyle` from the import. In `App.tsx` line 533 drop `, toolStyle: d.chat`.

- [ ] **Step 3: The three readers**

`Transcript.tsx:231` delete the `toolStyle={hud?.toolStyle ?? "dossier"}` line. `Terminal.tsx:400` `data-style="dossier"`. `RunStream.tsx:1573` default `toolStyle = "dossier"`; `Markdown.tsx:194` default `toolStyle = "dossier"`.

- [ ] **Step 4: Settings**

Delete `OutputStylePicker`; `TranscriptWell` drops its `style` param and sets `data-style="dossier"` (and passes `toolStyle="dossier"` to `RunStream`, or nothing — the default); `SchemePicker` and `ChatBgPicker` drop their `style` prop and callers; delete the OUTPUT STYLE section and its INDEX row and `SEC_DESC` entry (move the useful terms `output style` into the COLOUR SCHEME row's terms); remove `TOOL_STYLES` / `ToolStyle` from the toolwidget import.

- [ ] **Step 5: Dashboard CSS**

Delete these blocks of `src/index.css`, each from its banner comment to the line before the next banner (`grep -n "^/\* ══\|^/\* ──" src/index.css` lists them; line numbers below are today's):

| Delete | Keep |
|---|---|
| `── CONTROL PLATE ──` materials (`:1705`) | `── WIRE ──` materials (`:1753`) — DOSSIER's widgets |
| `── SIGNAL LOG ──` (`:1790`), `── LEDGER PRESS ──` (`:1815`), `── HALO ──` (`:1833`) materials | |
| `1B · CONTROL PLATE` (`:2162`), `2A · WIRE` (`:2283`), `2B · SIGNAL LOG` (`:2493`), `1A · LEDGER PRESS` (`:2708`), `1C · HALO` (`:2951`) session idioms | `DOSSIER` (`:3146`) and everything after it |

Before deleting a block, `sed -n '<start>,<end>p' src/index.css | grep -n 'dossier\|data-tw="wire"'` — any rule inside a doomed block that also names `[data-style="dossier"]` or `[data-tw="wire"]` is cut out and kept (there are a few combined selectors; a comment near `:3391` says which hooks DOSSIER reads). Then the scattered per-language rules at `:3963-3990` (thought and steps glyphs per language): keep the DOSSIER one, delete the four others.

Verification:

```bash
cd bridge/dashboard/web
grep -c '\[data-style="\(stamp\|wire\|signal\|press\|halo\)"\]' src/index.css   # 0
grep -c 'data-tw="\(stamp\|signal\|press\|halo\)"' src/index.css                  # 0
grep -c 'data-tw="wire"' src/index.css                                            # > 0
grep -c 'data-style="dossier"' src/index.css                                      # > 0
npx tsc -p tsconfig.app.json --noEmit && npx vite build --outDir /tmp/cuts-dist --emptyOutDir | tail -2
```

- [ ] **Step 6: Mini App types and routes**

`src/lib/toolwidget.ts`: `export type ToolStyle = "stamp";` with a one-line comment (the one language on this surface since the settings remap); delete `TOOL_STYLES`, `LEGACY`, `isToolStyle`, `toToolStyle`, `STYLE_KEY`, `useToolStyle` (keep `ChatBg`, `CHAT_BGS`, `toChatBg`, `useChatBg`, the idioms, `widgetForRun`, `shotName`). `src/lib/toolwidget.check.ts`: delete lines 61-74 and the three names from the import; run `node src/lib/toolwidget.check.ts` — silent.

```bash
cd bridge/miniapp/web && git rm -q src/routes/output.tsx
```

`src/router.tsx`: delete the `outputRoute` import, the comment about `/output`, and `outputRoute` from the route list. `src/routes/system.tsx`: delete the `TOOL_STYLES, useToolStyle` import, `<OutputStyleRow />`, `function OutputStyleRow`, and change the header hint `OUTPUT · THEME · LIMITS` to `THEME · LIMITS` and the `OUTPUT STYLE` group label to `TRANSCRIPT` (the `FoldsRow` stays under it). `src/routes/run.tsx`: import only `useChatBg`; delete `const [style] = useToolStyle();`; `data-style="stamp"`. `src/components/RunStream.tsx`: drop `useToolStyle` from the import; line 1057 becomes `const toolStyle: ToolStyle = "stamp";`.

- [ ] **Step 7: Mini App CSS**

Delete from `src/index.css`: `2A · WIRE` (`:517`), `2B · SIGNAL LOG` (`:593`), `1A · LEDGER PRESS` (`:666`), `1C · HALO` (`:780`) session blocks and the `── WIRE ──` (`:1047`), `── SIGNAL LOG ──` (`:1078`), `── LEDGER PRESS ──` (`:1099`), `── HALO ──` (`:1115`) material blocks; keep `1B · CONTROL PLATE` (`:450`) and `── CONTROL PLATE ──` (`:1012`). Same per-block grep for combined selectors naming `stamp` before deleting. Then the scattered rules (`:1657`, `:1668` and any other `[data-style="…"]` not `stamp`).

```bash
cd bridge/miniapp/web
grep -c '\[data-style="\(wire\|signal\|press\|halo\)"\]' src/index.css   # 0
grep -c 'data-tw="\(wire\|signal\|press\|halo\)"' src/index.css          # 0
grep -c 'data-style="stamp"' src/index.css                               # > 0
npx tsc -p tsconfig.app.json --noEmit && npx vite build --outDir /tmp/cuts-mini --emptyOutDir | tail -2
```

- [ ] **Step 8: Look at it (Review Focus 4)**

Before this task's CSS edits, capture a session with a tool widget twice; after, capture the same session the same way, and compare by eye:

```bash
cd ~/Projects/mystical-assistant
tok=$(grep '^DASH_TOKEN=' .env | cut -d= -f2- | tr -d '"')
python3 .mystical/probe/probe.py 8892 /tmp/cuts-dist 8790 &
PRELOAD='localStorage.setItem("hud-settings", JSON.stringify({theme:"flint-ember",headerStyle:"veil",layout:"compact"}))' \
  node .mystical/probe-mac/cdp.mjs "http://127.0.0.1:8892/?skipboot=1&token=$tok&s=<a session id with a Bash result>" /tmp/after-flint.png 1496 939 4000 "" 0 2
PRELOAD='localStorage.setItem("hud-settings", JSON.stringify({theme:"signal"}))' \
  node .mystical/probe-mac/cdp.mjs "http://127.0.0.1:8892/?skipboot=1&token=$tok&s=<the same session>" /tmp/after-signal.png 1496 939 4000 "" 0 2
lsof -ti tcp:8892 -sTCP:LISTEN | xargs kill
```

Expected: the FLINT capture matches the live dashboard; the SIGNAL-theme capture draws the turn as a DOSSIER card with WIRE-material widgets, not as a log viewer. Deliver both with `mcp__verify__Attach`.

- [ ] **Step 9: Commit**

```bash
cd ~/Projects/.worktrees/mystical-assistant/feat-settings-cuts
git add -A bridge/dashboard/web/src bridge/miniapp/web/src
git commit -m "transcript: one language per surface — DOSSIER on the dashboard, CONTROL PLATE on the Mini App; the other languages and the picker go"
```

---

### Task 10: Ship

**Files:**
- Modify: `README.md` (any line naming Claude·FM, nyan, inbound hooks, the CONFIG tab or the output-style picker — `grep -n -i "claude·fm\|nyan\|inbound hook\|output style\|CONFIG tab" README.md`), `docs/superpowers/specs/settings-remap-design.md` (status line: slice 1 shipped, commit)

- [ ] **Step 1: Full verification on the branch**

```bash
cd ~/Projects/.worktrees/mystical-assistant/feat-settings-cuts
~/.cache/mystical-test-venv/bin/python -m pytest tests/ -q 2>&1 | tail -3
~/.cache/mystical-test-venv/bin/python -m pyflakes bridge/dashboard/server.py bridge/miniapp/server.py bridge/store.py
cd bridge/dashboard/web && npx tsc -p tsconfig.app.json --noEmit && for f in src/lib/*.check.ts; do node "$f" || echo "FAILED $f"; done
cd ../../miniapp/web && npx tsc -p tsconfig.app.json --noEmit && for f in src/lib/*.check.ts; do node "$f" || echo "FAILED $f"; done
```

Expected: only the 7 known pytest failures; pyflakes silent; no `FAILED`.

- [ ] **Step 2: Trim the README lines the grep found, commit**

```bash
git commit -am "docs: README no longer lists the radio, the cat, inbound hooks or the output-style picker"
```

- [ ] **Step 3: Integrate** — follow the `bridge-worktree` and `bridge-ship` skills: merge `feat/settings-cuts` into `master` (fast-forward if master has not moved; otherwise merge and re-run step 1 on master), rebuild both dists from master, then restart the bridge (the hooks and agentconfig routes are Python: a restart is required for the backend half; the dist swap is live on reload). Restarting ends every session hosted by the bridge, including the one doing the work — do it from the dashboard's SYSTEM ▸ PLATFORM ▸ RESTART BRIDGE or with `setsid` as the memory `bridge-child-session-sigkill` describes, when nothing else is running.

- [ ] **Step 4: Clean up**

```bash
unlink ~/Projects/.worktrees/mystical-assistant/feat-settings-cuts/bridge/dashboard/web/node_modules
unlink ~/Projects/.worktrees/mystical-assistant/feat-settings-cuts/bridge/miniapp/web/node_modules
git worktree remove ~/Projects/.worktrees/mystical-assistant/feat-settings-cuts
```

Ask before deleting the branch.
