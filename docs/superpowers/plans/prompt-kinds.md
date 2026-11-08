# Prompt kinds (one prompt box, R3 · RAIL) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** COMPACT's composer becomes one prompt box that guesses the kind of work you type (DESIGN, BUILD, FIX, SHIP, ASK). A status rail under the text shows the kind, its live facts, its run preset and usage. The three PROMPT BOX shells and their setting go.

**Architecture:** The kinds are pure data plus rules in a new `lib/kinds.ts`, pinned by `kinds.check.ts`. Composer keeps today's TABS tab row and replaces the card's body with line one (+, editor, keys) and the rail. App passes the facts' inputs down and sends each prompt with its kind's run picks through the existing `send(..., { picks })` and queue paths. No bridge change.

**Tech Stack:** React + TypeScript (Vite), lucide-react icons, node `--test` check files with `console.assert` (`tools/strict-assert.mjs` makes them throw).

**Spec:** `docs/superpowers/specs/prompt-kinds.md`. Mockups: `~/Projects/mystical-assistant/.mystical/design-drafts/prompt-kinds/21-rail-final.html` (open it; every state is drawn, with the CSS that draws it).

## Global Constraints

- Work only in `bridge/dashboard/web/src`. No bridge (Python) change, no new dependency.
- COMPACT layout only. DEFAULT layout keeps its composer markup and its router caption untouched.
- Box height must not change with the kind. Rail 30px; kinds segment fixed 188px; preset segment min-width 196px (folded below 700px); key min-width 84px.
- Kind marks use the accent only (`color-mix(in oklab, var(--acc) 70%, var(--txb))` for ink, `var(--acc)` 13% fill for picked). State colours (`--ok`, `--warn`, `--err`) only on facts.
- No focus or kind colour on the box edge (memory: the user removed TABS' focus border on purpose).
- Copy is exact as in the spec tables (key words, starters, facts phrasing).
- Run `npm run check` in `bridge/dashboard/web` (tsc + every `*.check.ts`). Never `tsc -p .`.
- Commit messages: one short line, no body, no co-author lines.

## Review Focus

1. **Answering a docked question:** with `ask?.send`, the box must send the answer exactly as typed. No `/design-first` prefix, no kind picks: a kind on an answer would break the AskDock reply. → Task 3 Step 4 (assert in `kinds.check.ts` via `sendPlan`).
2. **Agent sessions (`agentPick`, Kimi):** no kind picks may be sent (their ids aren't Claude's), and the kinds go dim. → Task 1 `sendPlan` test with `agent: true`.
3. **A typed `/command` or `/goal`:** never guessed over, never prefixed. → Task 1 tests.
4. **Queued while running:** a kind prompt that queues must carry its model, mode and effort. Today `enqueue` deliberately sends only effort. → Task 3 Step 3 (passes `model` and `permission_mode` only when the send carries kind picks).
5. **Steer:** steering a running turn ignores the kind (plain text, no picks). → Task 3 Step 4 note, checked in the capture of Task 5.

---

### Task 1: The kinds as data and rules

**Files:**
- Create: `bridge/dashboard/web/src/lib/kinds.ts`
- Test: `bridge/dashboard/web/src/lib/kinds.check.ts`

**Interfaces:**
- Consumes: `GitStatus` (api.ts), `Turn` (chat.ts), `checksLine` (lib/receipt.ts), `ago` (lib/surfaces).
- Produces (exact):
```ts
export type KindId = "design" | "build" | "fix" | "ship" | "ask";
export const KIND_ORDER: KindId[];                       // ["design","build","fix","ship","ask"]
export interface KindRun { model: string; perm: string; effort: string; ponytail: string }
export interface Kind { id: KindId; name: string; verb: string; starter: string; preset: KindRun }
export const KINDS: Record<KindId, Kind>;
export type KindPick = KindId | "plain" | null;           // null = guessing
export function guessKind(text: string): KindId | null;
export function shownKind(pick: KindPick, text: string): { kind: KindId | null; how: "auto" | "picked" | "plain" | "none" };
export function nextKind(from: KindId | null, dir: 1 | -1): KindId | null;   // …ask → null (plain) → design…
export function presetFor(kind: KindId, saved?: Partial<Record<KindId, Partial<KindRun>>>, session?: Partial<KindRun>): KindRun;
export function sendPlan(o: { kind: KindId | null; text: string; pack: boolean; answering: boolean; agent: boolean; run: KindRun | null }):
  { text: string; run: KindRun | null };
export interface LastCheck { ok: boolean; line: string; at: number | null }
export function lastCheckOf(turns: Turn[]): LastCheck | null;
export interface FactsCtx { git: GitStatus | null; lastCheck: LastCheck | null; designLinked: boolean | null; mapBuiltAt: number | null; pack: boolean }
export type Fact = { text: string; tone?: "ok" | "warn" | "err" };
export function kindFacts(kind: KindId, ctx: FactsCtx): Fact[];
```

- [ ] **Step 1: Write the failing checks** in `kinds.check.ts` (`// Run: node bridge/dashboard/web/src/lib/kinds.check.ts`, imports with `.ts`, `console.assert(cond, "why")` as in `route.check.ts`):
  - guessKind, from the user's real prompts:
    `"merge this into master locally then clean up"`→ship · `"push to main, also make sure the people tab uses those avatars"`→ship · `"create pr to v1 dashboard"`→ship · `"the session list jumps when a turn ends"`→fix · `"fix suggested word when side with another word"`→fix · `"why does the build fail on CI?"`→fix · `"reimagine prompt boxes so each kind of work gets its own"`→design · `"better ui for the plugins tab"`→design · `"add avatar with its border to inbox header as well"`→build · `"what is not pushed on my local branches?"`→ask · `"give me local status on branches and what is not pushed"`→ask · `"go with 1"`, `"continue"`, `"Yes"`, `""`→null · `"/design-first a thing"`, `"/goal ship it"`→null.
  - shownKind: `("plain","fix the x")`→`{kind:null,how:"plain"}`; `("ask","fix the x")`→`{kind:"ask",how:"picked"}`; `(null,"fix the x")`→`{kind:"fix",how:"auto"}`; `(null,"ok")`→`{kind:null,how:"none"}`.
  - nextKind: `("ask",1)`→null; `(null,1)`→"design"; `("design",-1)`→null; `(null,-1)`→"ask".
  - presetFor: defaults equal the spec table; `saved.fix.effort="high"` wins over default; `session.effort="low"` wins over saved.
  - sendPlan: design → `"/design-first " + text`; fix with pack → `"/mattpocock-skills:diagnosing-bugs " + text`; fix without pack → text; build/ship/ask → text; `answering:true` → text unchanged and `run:null`; `agent:true` → text unchanged and `run:null`; `kind:null` → text and `run:null`.
  - lastCheckOf: two turns, the older with a failing checks event and the newer with a passing one → the newer (`ok:true`), `at` from the event's `at`, else the turn's `started`; no checks events → null.
  - kindFacts: ship with `{upstream:"origin/x", ahead:3, behind:0, dirty:0}` → texts joined `"3 to push · 0 to pull"`; dirty 2 → first fact `{text:"2 uncommitted", tone:"warn"}`; upstream `""` with `unpublished:4` → `"4 unpublished"`; ahead 0 and behind 0 → `"in sync"`; fix with a failing LastCheck → first fact tone `"err"`; design unlinked → `"no Claude Design project linked"`; ask with `mapBuiltAt:null` → exactly `[{text:"read-only, changes nothing"}]`; build with pack and dirty 0 → `"grill, then build here · working tree clean"`.

- [ ] **Step 2: Run to see them fail.** `cd bridge/dashboard/web && node --import ./tools/strict-assert.mjs src/lib/kinds.check.ts` → fails (module not found).

- [ ] **Step 3: Implement `lib/kinds.ts`.** Copy from the spec tables (names, verbs, starters, presets with ponytail `""`). Module docstring: why the rules are local (instant, free, no POST per keystroke) and why a typed `/` is never guessed over. Rule order in `guessKind` (first match wins, on lowercased trimmed text, needs ≥ 2 words, `/` start → null):
  1. ship: starts with `merge|push|commit|rebase|ship|release|deploy|clean ?up|integrate`, or contains `create (a )?pr|open (a )?pr|merge (this|it|into)|push (it|this|to)`.
  2. fix: `\b(bug|broken|not working|doesn'?t work|fail(s|ed|ing)?|error|crash\w*|exception|stuck|hang(s|ing)?|freez\w*|slow|lag\w*|wrong|missing|jump(s|ing)?|flicker\w*|regress\w*|can'?t|cannot|isn'?t|won'?t|no longer)\b` or starts with `fix `.
  3. design: `\b(design|redesign|reimagine|mock-?ups?|layout|ui|ux|look and feel|restyle|style|theme|visual\w*)\b`.
  4. ask: ends with `?`, or starts with `what|why|how|where|which|who|when|is|are|does|do|can|could|should|explain|tell me|show me|give me|list`.
  5. build: starts with `add|make|build|implement|create|support|allow|enable|wire|hook up|change|update|rename|move|remove|delete|replace|refactor|improve|extend|write|put|let'?s|lets|we need|i want`.
  Facts copy is exact as in the spec's facts table; the clock is `hhmm(at)` from lib/surfaces.

- [ ] **Step 4: Run to see them pass.** Same command → no output, exit 0. Then `npm run check` → passes.

- [ ] **Step 5: Commit.** `git add src/lib/kinds.ts src/lib/kinds.check.ts && git commit -m "kinds: the five kinds of work as data and rules"`

### Task 2: One prompt box: the PROMPT BOX setting goes

**Files:**
- Modify: `src/lib/theme.ts` (drop `COMPOSER_STYLES`, `ComposerStyle`, `urlComposer`, the `composer` setting and its default/parse; add `kindPresets?: Partial<Record<KindId, Partial<KindRun>>>` to the settings type, default `{}`)
- Modify: `src/lib/chatchrome.ts` (drop `composer`)
- Modify: `src/components/hud/Terminal.tsx:347,780` (`flat = compact`; provider without `composer`)
- Modify: `src/components/hud/SettingsModal.tsx:4981-4996,5121` (remove the PROMPT BOX row; the preview label loses `· {settings.composer}`)
- Modify: `src/components/Composer.tsx` (`shelled = compact`; delete the CONSOLE branch of `shell` and whatever only it used, after grepping each name: `hint`, `editorCol` and the `pb-place`, `pb-set`, `pb-acts` wrappers; TABS still uses `pfx`)
- Modify: `src/index.css` (delete rules that only CONSOLE used: `[data-pb="console"]` and `.pb-cmd`, `.pb-place`, `.pb-set`, `.pb-acts`, `.pb-hint`, `.pb-pfx` where console-only; grep each class before deleting)

**Interfaces:**
- Consumes: `KindId`, `KindRun` (Task 1).
- Produces: `settings.kindPresets` (read by Task 4), and Composer always rendering the TABS shell in COMPACT.

- [ ] **Step 1:** Make the edits above. A stored `"composer"` key in `hud-settings` is ignored, not migrated.
- [ ] **Step 2: Verify.** `npm run check` passes; `grep -rn "COMPOSER_STYLES\|ComposerStyle\|data-pb=\"console\"\|composer ===" src` prints nothing.
- [ ] **Step 3: Commit.** `git commit -am "composer: one prompt box; CONSOLE, CLASSIC and the PROMPT BOX setting go"`

### Task 3: The rail: kinds, facts and the key

**Files:**
- Modify: `src/components/Composer.tsx` (the TABS `shell` body; `submit()`; the router effects)
- Modify: `src/App.tsx` (Composer props; `send()` opts; `enqueue`)
- Modify: `src/components/design/useSessionQueue.ts:9-17` (`EnqueueInput` gains `model?: string; permission_mode?: string`)
- Modify: `src/index.css` (rail rules; port them from the mockup's `.r-ln`, `.r-rail`, `.r-seg`, `.k`, `.kg` CSS, renamed under `.pb-rail`)

**Interfaces:**
- Consumes: everything in Task 1.
- Produces: Composer props `git?: GitStatus | null`, `lastCheck?: LastCheck | null`, `designLinked?: boolean | null`; `onSend(text, images, noPath?, run?: KindRun | null)`; App `send()` opts gain `ponytail?: string`.

- [ ] **Step 1: App.** Pass `git={sessionGit}`, `lastCheck={lastCheckOf(turns)}` (memoised on `turns`) and `designLinked` (`api.projectSettings` for the session's project, cached per project in a ref; `null` until it answers). `onSend={(t, i, noPath, run) => void send(t, i, { ...(noPath ? { noPath: true } : {}), ...(run ? { picks: { model: run.model, perm: run.perm, effort: run.effort }, ponytail: run.ponytail } : {}) })}`. In `send()`, `ponytail: (opts?.ponytail ?? ponytail) || undefined`.
- [ ] **Step 2: Kind picks don't become this browser's defaults.** `send()` with `opts.picks` must not call `patchSettings` (today only `pickRun` does; keep it that way). It still mirrors the picks onto the session row, as today.
- [ ] **Step 3: Queue.** In `enqueue`, when `opts.picks` came from a kind (`run` given), add `model: pk.model, permission_mode: pk.perm` to the `queue.enqueue` input. Plain prompts stay as today (effort only).
- [ ] **Step 4: Composer state and send.** `const [kindPick, setKindPick] = useState<KindPick>(null)`, reset to null when `blank` and on `sessionId` change. `const { kind, how } = shownKind(kindPick, typed)`, forced to `{kind:null, how:"none"}` while `ask?.send` or `onAgent`. In `submit()`, use `sendPlan({ kind, text: typed, pack, answering: !!ask?.send, agent: onAgent, run: kind ? presetFor(kind, settings.kindPresets, sessionOverride) : null })` (the overrides come in Task 4; pass `undefined` for now) and call `onSend(plan.text, images, noPath, plan.run)`. `steer()` stays plain. Delete `designBtn` and `design()`, and the GRILL verb.
- [ ] **Step 5: Router in COMPACT.** Skip the auto-apply effect and the row suggestion while `shelled` (the kinds replace them). Keep the empty-box NEXT ghost. Its caption (`caption(live, "inline")`) renders in the facts segment while it shows.
- [ ] **Step 6: Markup.** Inside `.pb-card`: ledger, attachments, then `.pb-line` = `plusBtn` (round 24px) + editor + `.pb-keys` (the idle key reads `KINDS[kind].verb` or "Send", min-width 84px; running and answering keep today's `actions()` clusters). Below, `.pb-rail`, with four segments: kinds (lit: glyph + word, `data-how="auto|picked"`, AUTO tag when auto; others: 22px glyph buttons with `title=` the name; click → `setKindPick(lit ? "plain" : id)`), facts (`kindFacts` → spans with `data-tone`), preset (Task 4 fills it; for now `runTrigger` as today), usage (Task 4; for now `profileDrop(true)`). Icons from lucide: DraftingCompass, Hammer, Bug, GitMerge, MessageCircleQuestionMark (check the export name in `node_modules/lucide-react`).
- [ ] **Step 7: Keys.** In the editor's keydown: Tab with text and no open list → `setKindPick(nextKind(kind, 1))` (Shift+Tab, -1); Esc with a kind on show and nothing else open → `setKindPick("plain")`. Tab on an empty box with a ghost keeps today's behaviour.
- [ ] **Step 8: Verify.** `npm run check` passes. Then build and capture (Task 5's script) the typed states DESIGN, SHIP and ASK: the rail shows the lit kind with AUTO, the key reads its word, and the box height is the same in all three (measure `.pb-card` in the capture's eval).
- [ ] **Step 9: Commit.** `git commit -am "composer: the kind rail, facts and kind-aware send"`

### Task 4: PRESET popover, usage ring, starter, narrow fold

**Files:**
- Modify: `src/components/Composer.tsx`, `src/index.css`, `src/App.tsx` (pass `kindPresets={settings.kindPresets}` and `onSaveKindPreset={(k, r) => patchSettings({ kindPresets: { ...settings.kindPresets, [k]: r } })}`)

**Interfaces:**
- Consumes: Task 1 `presetFor`, `KINDS`; Task 3 rail.
- Produces: Composer props `kindPresets?: Partial<Record<KindId, Partial<KindRun>>>`, `onSaveKindPreset?: (k: KindId, r: KindRun) => void`.

- [ ] **Step 1: Session overrides.** `const [overrides, setOverrides] = useState<Record<string, Partial<Record<KindId, Partial<KindRun>>>>>({})`, keyed by `sessionId`. Add a comment: `shortcut: in memory, a reload drops them; persist per session if that's missed`. `run = presetFor(kind, kindPresets, overrides[sid]?.[kind])`.
- [ ] **Step 2: Preset segment and popover.** The segment shows the kind's glyph (sliders when plain), model label, mode label, effort label, and trim when not "". Plain shows the session's own picks. Opens `openDrop === "preset"` above the rail: model (`MenuRows` over `modelOpts`), mode (`PERMS`), effort (segmented over `EFFORTS` minus Auto), trim (segmented over `PONYTAILS`, labels Default/Off/Lite/Full/Ultra). With a kind lit, a pick writes `overrides[sid][kind]`, and the footer reads "A change here wins in this session." with the link "Save as {name}'s preset" → `onSaveKindPreset(kind, run)`. With no kind, picks call `onModel`, `onPerm`, `onEffort`, `onPonytail` as the run sheet does. The run sheet trigger (`runTrigger`) leaves the COMPACT shell.
- [ ] **Step 3: Usage ring.** `profileDrop` gains a `ring` variant whose trigger is a 12px SVG ring (stroke `var(--acc)`, dash = % left; `var(--err)` and the refill clock when spent) + `% left` + reset clock. Its menu is unchanged. The COMPACT shell uses the ring; the PONYTAIL chip leaves the shell (trim lives in the preset).
- [ ] **Step 4: Starter.** With `how === "picked"` and a blank box, the editor's placeholder becomes `KINDS[kind].starter` + ` · Tab writes it`; Tab writes the starter as text (one line, kept as written).
- [ ] **Step 5: Working tab.** In `Terminal.tsx`'s nameplate, the running tab appends `· N queued ▾` (opens the queued list, as the `pb-queued` pill does today), and reads `paused · N held` while paused. Then the `pb-queued` and `pb-paused` pills leave the COMPACT shell.
- [ ] **Step 6: Narrow.** Below 700px wide (a `ResizeObserver` on `.pb-card`, or a container query on the composer), the preset shows glyph + model only and usage drops its clock.
- [ ] **Step 7: Verify.** `npm run check` passes. Capture PRESET open, PICK (Fix tapped on an empty box), RUNNING with 2 queued, and NARROW at 560px. Compare with `21-rail-final.html` crops 6–8 and 10.
- [ ] **Step 8: Commit.** `git commit -am "composer: preset popover, usage ring, starters, narrow rail"`

### Task 5: Visual verification against the mockups

**Files:**
- Create: `.mystical/design-drafts/prompt-kinds/_probe/after.sh` (main checkout, git-ignored): it builds the worktree's dist to `/tmp/pk-after`, serves it with `node macos/eyes/roserve.mjs /tmp/pk-after 0` (read-only), and runs `macos/eyes/cdp.mjs` with `PRELOAD="$(node macos/eyes/user.mjs preload);localStorage.setItem('hud-last-session','<id>')"` at 1425×743, DPR 2, typing each state's text with `document.execCommand('insertText', …)` into `.pb-card .cm-content`. One crop per state.

- [ ] **Step 1:** Capture DESIGN, BUILD, FIX, SHIP, ASK, PICK, PRESET, RUNNING, ANSWER (needs a docked ask: skip if none can be staged read-only, and say so) and NARROW (`SIZES`/viewport 900 wide with both sidebars open).
- [ ] **Step 2:** `node macos/eyes/compare.mjs ~/Projects/mystical-assistant/bridge/dashboard/web/dist /tmp/pk-after '.composer'`. Expected: `.composer` gets shorter (92px card vs 140px). Every other flagged row is explained in the report.
- [ ] **Step 3:** Read every crop next to the mockup crop of the same state; list each difference and fix the ones that aren't deliberate.
- [ ] **Step 4: Commit** any fixes: `git commit -am "composer: rail matches the approved mockups"`
