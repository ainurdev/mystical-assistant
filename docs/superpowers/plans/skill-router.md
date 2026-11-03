# Skill Router Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** As you type in the dashboard composer, a free rules function picks the Matt Pocock `/command` that fits and shows it in the text where it will be sent: solid when it was auto-applied, dashed when Tab would take it. After a flow step ends, it offers the next step the same way.

**Architecture:** One stdlib module, `bridge/route.py`, holds the rules: `pick()` takes the text plus the session facts and returns one route or `None`. The dashboard calls it through `POST /local/route`, debounced, and draws the result with the existing `/` segment (`CmdWidget`) plus a new dashed ghost widget and one caption line. Two run-time fixes in `bridge/runner.py` reach every surface: a constant grill-round note, and an attachment note that no longer pushes a leading `/command` off the start.

**Tech Stack:** Python 3 stdlib, pytest. React + TypeScript + CodeMirror 6 (dashboard), `*.check.ts` run by node.

**Spec:** `docs/superpowers/specs/skill-router.md` (mockups: `.mystical/design-drafts/skill-router/06-c-ghost.html`, crops `shots/c2-1..4.png`)

## Global Constraints

- Backend is Python stdlib only. No new npm dependencies.
- `tests/conftest.py` pins env before `bridge.config` is imported. Never set env inside a test module.
- Send command names exactly as `commands.available()` lists them. Matt's pack lists as `mattpocock-skills:<skill>`, and the CLI has no bare alias (checked 2026-11-04). The CLI's builtin `code-review` is a different skill.
- `SMART_ZONE = 150_000` tokens · debounce `400` ms · Ask Matt only when nothing matched and text ≥ `200` chars · no start route under `12` chars.
- Auto set, exactly: `grill-with-docs`, `diagnosing-bugs`, `research`, `prototype`, `tdd`. Everything else is a dashed suggestion.
- Auto only when `first` (no turns yet), or when the last turn is `done` and its prompt was a flow command.
- No routing while a turn runs (steer or queue mode). No routing for text that already starts with `/`.
- Anything added to the appended system prompt must be constant per run (runner.py:215-231, prompt cache).
- Every new piece has its own switch in the AI tab (user ask, 2026-11-04). `parent` marks a sub-switch, which is shown and obeyed only while SKILL ROUTER is on:

  | key | env (config.py) | label | default | parent |
  |---|---|---|---|---|
  | `router` | `ROUTER_ENABLE` | SKILL ROUTER | `"0"` (self-running ships OFF) | |
  | `askmatt` | `ROUTER_ASK_MATT` | ASK MATT | `"1"` | router |
  | `autopick` | `ROUTER_AUTO` | AUTO PICKS | `"1"` | router |
  | `nextstep` | `ROUTER_NEXT` | NEXT STEPS | `"1"` | router |
  | `tickets` | `ROUTER_TICKETS` | TICKETS IN FRESH SESSIONS | `"1"` | router |
  | `smartzone` | `ROUTER_ZONE` | SMART ZONE | `"1"` | router |
  | `setupnudge` | `ROUTER_SETUP` | SETUP NUDGE | `"1"` | router |
  | `grillcards` | `GRILL_CARDS` | GRILL AS CARDS | `"0"` (shapes every run, ships OFF) | |

  At go-live, SKILL ROUTER and GRILL AS CARDS are switched ON for this machine.
- Work in a worktree on `feat/skill-router` (bridge-worktree skill). Commit messages are one short line. Never push.

## Review Focus

1. **A routed prompt with attachments.** The attachment note must come after `/name`, or the CLI never runs the skill. Pinned in Task 3.
2. **Backspace on an auto-applied command.** It must stay gone while you edit the same draft, and only a fresh (emptied) draft can be auto-routed again. Pinned in Task 4 (`isDropped`, `shouldAutoApply`).
3. **A late route response.** A reply for text you've since changed, or already sent, must not apply. Pinned in Task 4 (`isStale`).
4. **Matt's pack not installed or disabled.** The router suggests nothing, so no `/name` the CLI would reject. Pinned in Task 1.
5. **The `code-review` name clash.** It must resolve to `mattpocock-skills:code-review`, never the CLI builtin. Pinned in Task 1.

---

### Task 1: The rules (`bridge/route.py`)

**Files:**
- Create: `bridge/route.py` (module docstring: why rules and not a model call, the Ask Matt fallback, and why auto is limited to the safe set)
- Test: `tests/test_route.py`

**Interfaces:**
- Produces:
  - `SMART_ZONE = 150_000`
  - `pick(text: str, *, prompts: list[str], last_status: str | None, ctx_tokens: int | None, first: bool, cmds: dict[str, str], root: str | None, off: frozenset[str] = frozenset()) -> dict | None`
  - `SUBS = ("askmatt", "autopick", "nextstep", "tickets", "smartzone", "setupnudge")`. `off` holds the sub-switches that are off:
    `askmatt` → no Ask Matt fallback · `autopick` → `auto` is always False · `nextstep` → no next-step routes · `tickets` → behave as if there is no `.scratch` dir (implement, `arg=""`, `fresh=False`; after an implement → retro) · `smartzone` → no compact route · `setupnudge` → no setup route
  - It returns `{"name": str, "desc": str, "why": str, "auto": bool, "arg": str, "fresh": bool, "kind": "start"|"next"|"ask"|"setup", "alts": [{"name","desc","why"}]}` (alts ≤ 3), or `None`.
  - `cmds` maps name → description (`commands.available()` turned into a dict). `prompts` holds the session's last ≤6 prompts, oldest first. `root` is the absolute project path.

Rules. The first match wins, and a skill that isn't installed is skipped. `_resolve(skill, cmds)` returns `mattpocock-skills:<skill>` when that is listed, else `None`. The one exception is `compact`, which resolves to the CLI builtin `compact`. Never fall back to a bare name: the builtin `code-review` is a different skill. Patterns are case-insensitive:

| skill | pattern on `text` | why |
|---|---|---|
| diagnosing-bugs | `traceback\|exception\|error:\|stack trace\|\bcrash\|\bbroken\b\|\bfail(s\|ed\|ing)?\b\|regression\|doesn'?t work\|not working\|find out why\|\b(is\|are\|got) (empty\|missing\|stuck\|wrong)\b` | something's broken: get a failing loop first |
| code-review | `\breview\b` (checked **before** diagnosing-bugs) | review the diff against the standards and the spec |
| triage | `\btriage\b\|incoming issues\|bug reports` | sort what came in before building |
| wayfinder | `from scratch\|greenfield\|new app\|rewrite (the\|it all)\|migrate (the whole\|everything)` | too big for one session: map it first |
| to-spec | `\bspec\b\|\bprd\b\|write (it\|this) up` | write the thread up as a spec |
| to-tickets | `tickets\|break (it\|this) (down\|into)\|split (it\|this) into` | split it into tickets with blockers |
| tdd | `test[- ]first\|\btdd\b\|red[- ]green` | build it test-first, one slice at a time |
| prototype | `prototype\|mock ?up\|what should .{0,40} look like` | answer it with throwaway code first |
| research | `\bresearch\b\|look up\|docs for\|what'?s the latest\|compare .{0,30} (to\|with\|vs)` | read primary sources, leave a cited file |
| improve-codebase-architecture | `architecture\|refactor\|tangled\|deepen` | find where the code wants deeper modules |
| teach | `teach me\|help me (learn\|understand)` | learn it over a few sessions |
| handoff | `hand ?off\|in a (new\|fresh\|another) session\|for codex` | write it down for the next session |
| wait-what | `^(what\??\|huh\??\|wait,? what\|i don'?t (get\|understand)( it\| that)?)\W*$` (only when `last_status == "done"`) | re-pitch the last answer in plain words |
| grill-with-docs | `^(add\|build\|create\|make\|implement\|i want\|we need\|let'?s\|can we\|could we\|should we\|how (can\|could\|should) we)\b\|new feature` | a new feature: settle it before building |

- Alts for `grill-with-docs`: `prototype`, `implement`, `grill-me`. For `diagnosing-bugs`: `tdd`. The rest have none.
- **Inside a grill flow** (the last flow command in `prompts` is grill-with-docs or grill-me, and no to-spec, to-tickets or implement came after it), only to-spec, to-tickets, implement, prototype and handoff fire on typed text. You're answering the interview.
- **Ask Matt**: no rule matched and `len(text) >= 200` → `ask-matt`, `kind="ask"`, why `no clear fit: /ask-matt reads the whole map`.
- **Setup**: the result is one of grill-with-docs, to-spec, to-tickets, implement, implement-spec, triage or wayfinder, and `<root>/docs/agents/issue-tracker.md` doesn't exist → `setup-matt-pocock-skills`, `kind="setup"`, `auto=False`, why `once per repo: tracker, labels, docs (then /<skill>)`.
- **Next step** (`text == ""` and `last_status == "done"`): find the last flow command in `prompts`, skipping `/compact …` prompts.
  - grill-with-docs or grill-me → to-spec, why `many sessions of work: write it up`, alt implement `or build it here if one session holds it`.
  - to-spec → to-tickets.
  - to-tickets → implement, with `arg` = the first `*.md` in the newest `.scratch/*/issues/` (path relative to root), `fresh=True`, why `#01 has no blockers`. With no `.scratch` dir: `arg=""`, `fresh=False`, why `pick the first ticket with no blockers`.
  - Shortcut (say so in the code): tickets are walked in file order, one at a time. That honours the blockers-first numbering but ignores a parallel frontier. Upgrade when tickets run side by side.
  - implement `<.scratch/…/NN-x.md>` → implement the next numbered file in that directory, `fresh=True`, why `#NN is next`. When none is left → retro.
  - implement (no ticket), implement-spec or diagnosing-bugs → retro, why `look back: what would have made this easier`.
- **Compact first**: a next step exists, it isn't `fresh`, and `ctx_tokens >= SMART_ZONE` → `compact`, why `{ctx_tokens//1000}k is past the 150k smart zone`, arg `keep the decisions so far; next: /{next_skill}`.
- `kind="start"` routes get `auto = skill in AUTO and (first or last_flow_done)`, where `last_flow_done` means the last prompt was a flow command and `last_status == "done"`. Every other kind has `auto=False`.

- [ ] **Step 1: Write the failing tests** in `tests/test_route.py`. Fixtures: `CMDS` holds every `mattpocock-skills:<skill>` used above plus `"compact"` and the builtin `"code-review"`. `root` is a `tmp_path` with `docs/agents/issue-tracker.md`, unless a test drops it. A `start` table runs through `pytest.mark.parametrize` and checks `(name, auto)`:
  - `"add a weekly digest: every friday at 17:00, one message that sums up what each session shipped this week"`, first=True → `("mattpocock-skills:grill-with-docs", True)`; the same text with first=False and no prompts → `(…grill-with-docs, False)`
  - `"Traceback (most recent call last):\n  File \"x.py\", line 3"` → diagnosing-bugs, True · `"the TURNS tab is empty after a bridge restart, find out why"` → diagnosing-bugs, True
  - `"review the changes in the last commit for bugs"` → `("mattpocock-skills:code-review", False)` (Review Focus 5)
  - `"write it up as a spec"` → to-spec, False · `"break this into tickets"` → to-tickets, False · `"let's do it test-first"` → tdd, True · `"research how other bridges send push notifications"` → research, True · `"prototype three looks for the digest card"` → prototype, True
  - `"/mattpocock-skills:grill-me x"` → None · `"ok"` → None
  - a 220-char prompt with no keyword → `kind == "ask"`, name `mattpocock-skills:ask-matt`
  - prompts=`["/mattpocock-skills:grill-with-docs add X"]`, text `"we need a retry too"` → None (inside a grill flow)
  - `test_not_installed`: cmds `{"compact": "", "code-review": "builtin"}` → None for the feature, bug and review texts (Review Focus 4 and 5: the builtin is never picked)
  - `test_setup_nudge`: without `issue-tracker.md` the feature text gives `kind == "setup"`, why ends `(then /grill-with-docs)`
  - `test_off_*`, one per sub-switch: `off={"askmatt"}` + the 220-char prompt → None · `off={"autopick"}` + the feature text with first=True → auto False · `off={"nextstep"}` + text `""` after a grill → None · `off={"tickets"}` + to-tickets with `.scratch` present → implement, arg `""`, fresh False · `off={"smartzone"}` at 162k → to-spec · `off={"setupnudge"}` without `issue-tracker.md` → grill-with-docs
  - `test_next_*`: grill done at 90k → to-spec · at 162k → compact with arg `"keep the decisions so far; next: /to-spec"` and why `"162k is past the 150k smart zone"` · `[grill, "/compact keep…"]` at 30k → to-spec · to-tickets with `.scratch/feat/issues/01-a.md, 02-b.md` → implement, arg `.scratch/feat/issues/01-a.md`, fresh · implement 01 → 02 · implement 02 → retro · to-tickets with no `.scratch` → implement, arg `""`, fresh False · `last_status="error"` → None
- [ ] **Step 2: Run them and see them fail.** Run: `~/.cache/mystical-test-venv/bin/python -m pytest tests/test_route.py -q`. Expected: `ModuleNotFoundError: No module named 'bridge.route'`.
- [ ] **Step 3: Implement `bridge/route.py`** following the table above. Compile the patterns once at module level; the table order is the matching order.
- [ ] **Step 4: Run them and see them pass.** Same command. Expected: all pass.
- [ ] **Step 5: Commit.** `git add bridge/route.py tests/test_route.py && git commit -m "route: rules that pick Matt's /command for a prompt"`

### Task 2: The endpoint and the AI switch

**Files:**
- Modify: `bridge/config.py` (next to `RELEVANCE_CHECK`, line 173): the eight env flags from the Global Constraints table, same pattern, with those defaults
- Modify: `bridge/aifeatures.py` `FEATURES` (line 39): eight entries in the table's order, the six subs carrying `"parent": "router"`. Each has `hint`, `cost`, `tokens` and `about` written from the spec (every sub's `cost` is `"no extra call"`, `tokens` `"0 (rules only)"`; ASK MATT's cost is `"a normal turn, only when you take it"`; GRILL AS CARDS' tokens `"~40 tokens a run"`). Each `about` ends with what turning it off does. `state()` already passes every spec field through, so `parent` reaches the client.
- Modify: `bridge/dashboard/server.py` `_post_api` (line 1029): the `/local/route` branch
- Test: `tests/test_route.py` (endpoint cases), `tests/test_aifeatures.py` (it already monkeypatches every `env`, so it passes once the config attribute exists)

**Interfaces:**
- Consumes: `route.pick` (Task 1), `commands.available(abs_project) -> list[dict]`, `_abs_project` (server.py:104), `aifeatures.enabled("router")`
- Produces: `POST /local/route` with body `{project, text, prompts, last_status, ctx_tokens, first}`. `router` off → `{"route": None}`. On → `{"route": pick(..., off=frozenset(k for k in route.SUBS if not aifeatures.enabled(k)))}`.

- [ ] **Step 1: Write the failing tests.** Use the handler stub from `tests/test_commands.py:150-162`: `h._post_api("/local/route", {...})` with `aifeatures.enabled` → True and `commands.available` → the `CMDS` list. The feature text gives `route.name == "mattpocock-skills:grill-with-docs"`. With `enabled` → False, it gives `{"route": None}`. With `enabled` False only for `askmatt`, the 220-char prompt gives `{"route": None}`.
- [ ] **Step 2: Run and see them fail.** Run: `~/.cache/mystical-test-venv/bin/python -m pytest tests/test_route.py tests/test_aifeatures.py -q`. Expected: the endpoint tests FAIL.
- [ ] **Step 3: Implement** the config flag, the FEATURES entry, and the server branch. The branch builds the `cmds` dict from `commands.available()` and passes `root=_abs_project(project)`.
- [ ] **Step 4: Run the whole suite.** Run: `~/.cache/mystical-test-venv/bin/python -m pytest tests/ -q` (this Mac, ~7 min; use a 10-min timeout). Expected: only the known macOS-only reds listed in the mac-test-env memory (test_clip_panel round trip, test_startup ×2, test_map_command while graphify is missing). Anything else red is this change.
- [ ] **Step 5: Commit.** `git commit -m "route: /local/route endpoint behind the SKILL ROUTER switch"`

### Task 3: Run-time fixes that reach every surface (`bridge/runner.py`)

**Files:**
- Modify: `bridge/runner.py`: a new constant `_GRILL_NOTE` joins the parts tuple in `_compose_system_prompt` (line 201) when `aifeatures.enabled("grillcards")`, the same way the Rivendell note is gated; and `_with_images` (line 1207)
- Test: `tests/test_route.py`. Also check `tests/test_mcp_startup.py:288-292`, which asserts on `_compose_system_prompt()`, and update it if it pins the exact text.

**Interfaces:**
- Produces: `_GRILL_NOTE` (copy fixed): `"When a grilling skill runs (grill-with-docs, grill-me, grilling), ask each round as one AskUserQuestion card: up to 4 questions, your recommended answer first, worded so yes takes it."`

- [ ] **Step 1: Write the failing tests.**
  - With `aifeatures.enabled` patched True for `grillcards`: `"one AskUserQuestion card" in runner._compose_system_prompt()`, and two calls return identical strings. Patched False: the line is absent.
  - `runner._with_images("/mattpocock-skills:grill-with-docs add X", ["/u/a.png"])` starts with `"/mattpocock-skills:grill-with-docs "`, contains `"/u/a.png"` and ends with `"add X"` (Review Focus 1).
  - `runner._with_images("hi", ["/u/a.png"]) == "The user attached file(s); open them before responding: /u/a.png\n\nhi"`, unchanged.
- [ ] **Step 2: Run and see them fail.** Run: `~/.cache/mystical-test-venv/bin/python -m pytest tests/test_route.py -q -k "grill_note or with_images"`
- [ ] **Step 3: Implement.** Add `_GRILL_NOTE if aifeatures.enabled("grillcards") else ""` to the parts tuple. `_with_images`: when the prompt starts with `/`, split off the first whitespace-delimited token and put the attachment note after it.
- [ ] **Step 4: Run the whole suite** (same command and expectation as Task 2 Step 4).
- [ ] **Step 5: Commit.** `git commit -m "runner: grill rounds as one card; attachments keep a leading /command"`

### Task 4: Client plumbing (`api.ts`, `lib/route.ts`)

**Files:**
- Modify: `bridge/dashboard/web/src/api.ts`: a `Route` type next to `SlashCommand` (line 1519), and `route(body) => req<{route: Route | null}>("/local/route", POST)` next to `commands` (line 2426)
- Create: `bridge/dashboard/web/src/lib/route.ts`, `bridge/dashboard/web/src/lib/route.check.ts`

**Interfaces:**
- Produces:
  - `type Route = { name: string; desc: string; why: string; auto: boolean; arg: string; fresh: boolean; kind: "start" | "next" | "ask" | "setup"; alts: { name: string; desc: string; why: string }[] }`
  - `export const SMART_ZONE = 150_000` (comment: mirrors `bridge/route.py` SMART_ZONE)
  - `shouldAutoApply(text: string, r: Route | null, dropped: boolean): boolean`. True iff `r?.auto && !dropped && text.trim() !== "" && !text.startsWith("/")`.
  - `isDropped(text: string, applied: string | null): boolean`. True iff `applied !== null && !text.startsWith("/" + applied)`.
  - `ghostFor(text: string, r: Route | null): { name: string; desc: string; arg: string } | null`. Null when `!r`, when `r.auto` with text present, or when text starts with `/`. Otherwise `{name, desc, arg: text === "" ? r.arg : ""}`.
  - `isStale(sentText: string, nowText: string, sentSeq: number, nowSeq: number): boolean`. True iff `sentSeq !== nowSeq || sentText !== nowText`.

- [ ] **Step 1: Write `route.check.ts`** in the `slash.check.ts` style (`console.assert` lines, ending with `console.log("route.check: ok")`).
  - Auto applies to a typed feature prompt.
  - Never when text starts with `/`.
  - Never after drop (Review Focus 2).
  - `isDropped("add x", "mattpocock-skills:grill-with-docs") === true`.
  - `ghostFor("", next-route).arg === r.arg`.
  - `ghostFor("add", auto-route) === null`.
  - `isStale` is true on a seq or text mismatch (Review Focus 3).
- [ ] **Step 2: Run and see it fail.** Run: `cd bridge/dashboard/web && node src/lib/route.check.ts`. Expected: a module-not-found error.
- [ ] **Step 3: Implement** `lib/route.ts` and the `api.ts` additions.
- [ ] **Step 4: Run.** `node src/lib/route.check.ts` prints `route.check: ok`, and `npm run build` typechecks clean.
- [ ] **Step 5: Commit.** `git commit -m "dashboard: route client and its pure helpers"`

### Task 5: The ghost segment in the editor (`MarkdownInput.tsx`, `index.css`)

**Files:**
- Modify: `bridge/dashboard/web/src/components/MarkdownInput.tsx`. Handle type (line 28), props (line 121), extensions (lines 161-168), placeholder compartment (`ph`, lines 140 and 210-212).
- Modify: `bridge/dashboard/web/src/index.css`, next to `.cmdseg` (lines 2804-2819)

**Interfaces:**
- Consumes: `ghostFor`'s return shape (Task 4)
- Produces:
  - prop `ghost?: { name: string; desc: string; arg: string } | null`
  - prop `onCmdClick?: () => void`. Fired on mousedown of any `.cmdseg` in the editor, solid or ghost.
  - `MarkdownInputHandle.prepend(s: string): void`. Dispatches `{changes: {from: 0, insert: s}}`, so the caret maps forward.

- [ ] **Step 1: Implement.**
  - `setGhost` StateEffect plus a `ghostDeco` StateField. The field draws `Decoration.widget({ widget: new GhostWidget(name, desc, arg), side: -1 }).range(0)`.
  - `GhostWidget.toDOM` builds the same `ns` / `sg` spans as `CmdWidget`, with class `cmdseg ghost`, followed by `span.ghost-arg` holding `arg`.
  - While a ghost shows, reconfigure `ph` to an empty placeholder so the two don't stack.
  - CSS for `.cmdseg.ghost .sg`: transparent background, accent text, and `box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--acc) 75%, transparent)`. The arrow (`::after`) uses `border-left-color` at 45% accent. `.ghost-arg` uses the placeholder's colour.
- [ ] **Step 2: Verify.** `npm run build` is clean. Look at it per the bridge-eyes skill on a scratch page (or Task 6's live composer), and compare it to crop `c2-3.png`.
- [ ] **Step 3: Commit.** `git commit -m "editor: dashed ghost /command and prepend()"`

### Task 6: Composer wiring (`Composer.tsx`, `App.tsx`)

**Files:**
- Modify: `bridge/dashboard/web/src/components/Composer.tsx`
  - props (lines 494-547)
  - `onKeyDown` (lines 1290-1318)
  - the three layouts: CONSOLE (1342-1362), TABS (1363-1376), CLASSIC (1393-1533)
  - the ctx meter `ctxBlock` (line 1027)
- Modify: `bridge/dashboard/web/src/App.tsx`: the `<Composer>` mount (lines 3034-3074) and `newSession` (line 1829)
- Modify: `bridge/dashboard/web/src/index.css`: `.pb-route` (the caption)

**Interfaces:**
- Consumes: `api.route`, `Route`, `shouldAutoApply`, `isDropped`, `ghostFor`, `isStale`, `SMART_ZONE` (Task 4); `ghost`, `onCmdClick`, `prepend()` (Task 5)
- Produces: Composer props:
  - `routing?: boolean`
  - `routeCtx?: { project: string; prompts: string[]; lastStatus?: string; first: boolean }`
  - `onRouteFresh?: (text: string) => void`
  - `askMatt?: boolean`, `smartZone?: boolean`

- [ ] **Step 1: App.** Pass these to `<Composer>`:
  - `routing={ai.router}`
  - `routeCtx` built from `turns`: the last 6 prompts, the last status, and `first: turns.length === 0`
  - `onRouteFresh={(t) => void newSession(project, t)}`, a draft in a new session that is never sent
  - `askMatt={ai.askmatt}`, `smartZone={ai.smartzone}`
- [ ] **Step 2: Composer behaviour.**
  - **Fetch.** While `routing`, not running, and the text doesn't start with `/`, fetch `api.route` 400 ms after the text settles. Use a seq ref, and drop late replies with `isStale`.
  - **Auto-apply.** `shouldAutoApply` → `editorRef.current.prepend("/" + r.name + " ")`, and remember `applied`.
  - **Dropped.** `isDropped` sets `dropped`. Emptying the text resets both `applied` and `dropped`.
  - **Tab** (after the mention and slash checks): with a ghost showing, `preventDefault`.
    - `fresh` → `onRouteFresh("/name arg")`.
    - Empty text → `setText("/name " + arg)`.
    - Otherwise → `prepend("/name ")`.
  - **Esc** with a ghost showing hides it for this draft. For `kind="setup"` it also sets `localStorage["route.setup.hidden:" + project]`, and setup routes are skipped from then on.
  - **onCmdClick** opens a list of `alts` plus "Ask Matt" (only when `askMatt`) and "Send as typed". Use the markup and classes of the existing `/` list in this file. A pick swaps the leading command; "Send as typed" removes it and sets `dropped`.
- [ ] **Step 3: Caption.** Put `.pb-route` directly under the editor in all three layouts: CONSOLE in place of `pb-hint` while a route shows, TABS after `pb-line`, CLASSIC under the editor inside `cmdbox`. Copy:
  - auto: `AUTO` · why · `⌫ drops it · click it for other fits`
  - start ghost: `ROUTE` · why · `Tab takes it`
  - next: `NEXT` · why · `Tab takes it`, or `Tab opens it in a fresh session` when `fresh`
  - compact: `NEXT` in the warn colour · why · `Tab takes it · then /<next>`
  - ask: `NO CLEAR FIT` · `Tab hands it to /ask-matt, which names the flow · ignore it to send as typed`
  - setup: `ONCE` · why · `Tab takes it · Esc hides it for this repo`
- [ ] **Step 4: Smart-zone mark.** Only when `routing && smartZone`: in `ctxBlock`, draw a 2 px tick at `SMART_ZONE / ctxMax`, and use the warn colour for the label once `ctx >= SMART_ZONE`.
- [ ] **Step 5: Verify.** `npm run build` is clean. Per bridge-eyes, capture the four states (auto, unsure, past the zone, tickets) at 2x in the user's theme, and compare them to `shots/c2-1..4.png`.
- [ ] **Step 6: Commit.** `git commit -m "composer: routed /command as a ghost segment with a caption"`

### Task 7: The AI tab shows the sub-switches under SKILL ROUTER (`SkillsFold.tsx`)

**Files:**
- Modify: `bridge/dashboard/web/src/components/hud/SkillsFold.tsx` (`EXTRA_ICONS` line 29, the `rows.map` at line 162), the `AiFeature` type (add `parent?: string`), `bridge/dashboard/web/src/index.css` (next to `.aim-x`)

**Interfaces:**
- Consumes: `parent` on each feature from `/local/aifeatures` (Task 2)

- [ ] **Step 1: Implement.**
  - A card whose `parent` is off isn't rendered. One whose parent is on gets `data-sub`, drawn as a child of the card before it: an accent rule on its left, inset by the grid gap. The "N of M on" count counts only rendered cards.
  - Icons in `EXTRA_ICONS` (lucide, already a dependency): router `Route`, askmatt `CircleHelp`, autopick `Wand2`, nextstep `SkipForward`, tickets `Ticket`, smartzone `Gauge`, setupnudge `Settings2`, grillcards `MessagesSquare`.
- [ ] **Step 2: Verify.** `npm run build` is clean. Per bridge-eyes, capture the AI tab with SKILL ROUTER off (its six subs hidden) and on (six subs under it), at 2x.
- [ ] **Step 3: Commit.** `git commit -m "ai tab: skill router sub-switches"`

### Task 8: Install, switch on, go live

**Files:** none in the repo. These are machine changes, so ask the user before step 1.

- [ ] **Step 1: Install the plugin.** Run `claude plugin install mattpocock-skills@claude-plugins-official`. Accounts 2 and 3 symlink `~/.claude/plugins` and `settings.json` (checked 2026-11-04), so one install covers every bridge account. Verify: `curl -s 'localhost:8790/local/commands?project=<abs repo>'` lists `mattpocock-skills:grill-with-docs`.
- [ ] **Step 2: Ship.** Merge per the merge-and-cleanup routine, build the dashboard and make it live per the bridge-ship skill (⟳ for the backend changes). Switch SKILL ROUTER and GRILL AS CARDS on in the AI tab (the persisted setting, `POST /local/aifeatures`).
- [ ] **Step 3: Live check.**
  - Type the digest prompt into a new session: the auto segment and caption appear.
  - Send `/mattpocock-skills:grill-with-docs <idea>`: the first round arrives as one card with up to 4 questions.
  - Attach a file to a routed prompt: the skill still runs.
  - Send screenshots of each state to the user.
- [ ] **Step 4:** Offer once: promote the draft into the design system, or delete `drafts/skill-router/` remotely (it was never pushed; DesignSync needs `/design-login`).

Out of scope, from the spec's open questions:
- Which tracker `/setup-matt-pocock-skills` records for this repo. The user answers that when the setup nudge first fires.
- GitHub-tracker ticket lookup. The next step falls back to `/implement` with no argument.
- Routing in the Mini App and the bot. They get only Task 3's run-time fixes.
