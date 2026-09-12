# Fresh-session panel — one instrument, four questions, one repo

The empty-session screen becomes a single panel that answers four different
questions about **this** repo — what to finish, what's wrong, what's unknown,
what looks off — instead of a machine-wide board bolted under a hero.

Extends [next-up-board-design.md](next-up-board-design.md). The board itself
does not change; this adds a project-scoped, multi-question cut of it.

## Problem

`FreshState` (`bridge/dashboard/web/src/components/hud/Terminal.tsx:87`) renders
five unrelated strips: face, quote, caret, a LAST COMMIT row with RUN, and a
left-aligned `NextView` block under a centred layout. Three specific faults:

- **Scope is a lie.** `NextView.tsx:64` filters items to the current project,
  but `nextup.refresh()` (`nextup.py:404`) scouts every repo touched in the last
  `NEXTUP_DAYS` — up to `NEXTUP_MAX_REPOS` (6) — and the header prints the
  machine-wide `6 repo(s)`. On a screen about one project you pay for six.
- **One question only.** The scout asks "what is most worth doing here next?"
  and nothing else. Measured over 964 first prompts in `bridge.db`, that shape
  covers maybe a third of how sessions actually open.
- **No way to say "not that".** A bad top item is permanent furniture until the
  repo's git state moves.

## Evidence

All figures from `bridge.db`, first turn of every session (`turns.seq = min`),
n = 964, 2026-09-12.

| Signal | Value |
|---|---|
| Sessions whose first prompt was the **only** prompt | **52%** |
| Median first-prompt length | **113 chars** |
| First prompts starting with a slash command | **0.6%** (6) |
| `run the project`, verbatim | **10 exact repeats** |
| Mentions a branch/PR | 10% · says "check" 12% · pasted log 6% |

Shape mix: fix/bug 11%, explain-why 10%, **design/UI 10%**, build/add 8%,
run-verify 4%, report 4%, research 3%. Top opening words: `make · check · when ·
i · what · add · remove · how · run · better · fix`.

Two readings drive the design. **The first prompt is usually the whole session**
— so what this screen offers is not a warm-up, it is the work. And **design/UI
is a top-three shape**, which is why POLISH ships despite a read-only scout
never seeing a rendered pixel.

Prior art: Marc Nuri's ai-beacon ships "workflow templates — opinionated,
built-in prompts that prime a new session for a specific task instead of
dropping the agent at a blank prompt", with exactly two (Implement Issue,
Review PR). Neither it nor the Fuselab agent-UX survey designs an empty state;
that part is ours. Two patterns worth taking: show an item **beside the signals
that produced it, with one-click dismiss**, and **lead with one item**, not a
list of equals.

## Goal

- The panel scouts and reports **this repo only**. No machine-wide count, no
  cross-repo ranking, ~6× cheaper per refresh.
- **Four tabs**, one scout each, sharing one facts payload and one cache entry.
- An item can be **dismissed**; it returns when the repo state moves.
- The Mini App and the WORK tab keep the global board, unchanged.

## Non-goals

- No Mini App work. It has no fresh-session screen (verified: no `FreshState`
  equivalent in `bridge/miniapp/web/src`). It gains the backend for free.
- No starter-prompt chips. A chip that types `why is ` saves seven keystrokes;
  the scouted items are the real suggestion.
- No VERIFY tab. `run the project` is the most repeated first prompt on the
  machine, and the RUN button on the status line already is it.
- No change to `rank()`, the global board, or `to_prompt()`.

## Shape

```
        ( face — unchanged, container 150 → 112 )
     MYSTICAL-ASSISTANT · FRESH SESSION
       "idle, but never asleep…"
     ~ ❯ awaiting your command ▮

┌ ⎇ master · 69 dirty · 41 ahead ─────────── ▸ RUN ┐
│ last  feat(shell): the right cap reads as…   11h │
├──────────────────────────────────────────────────┤
│  NEXT    REVIEW    RESEARCH    POLISH         ↻  │
│                                                  │
│  Land 69 uncommitted file(s)          ▸ START  ✕ │
│  dirty worktree on master, 41 unpushed           │
│  ···  .claude/skills/brainstorming/SKILL.md      │
│                                                  │
│  Push 41 commit(s) on master          ▸ START    │
│  Finish: "why is staging worktree listed?"       │
└──────────────────────────────────────────────────┘
```

### 1 · Hero

Unchanged except size: the face container 150 → 112, its inner disc 92 → 72,
the column `gap` 20 → 14. The quote, caret line and rotating faces stay exactly
as they are — they are the product's character, they were just eating 45% of
the viewport with a real panel now below them.

### 2 · Status line

Absorbs the LAST COMMIT strip (`Terminal.tsx:192`) and the RUN / SET UP RUN
buttons, which today sit in their own row. It reads **existing endpoints only**:
`api.git(project, branch)` for branch / `dirty` / `ahead`, and the `api.gitLog`
call `FreshState` already makes for the commit subject. It deliberately does not
take these from `nextup.facts()` — that would make `GET /local/next` compute
facts on every read, and the numbers must be there whether or not the board is
enabled or has ever been refreshed.

RUN keeps its border (it is an action); SET UP RUN stays bare (it opens a tab).
That rule is the header's, from `9a59b7e3`.

### 3 · The four scouts

One `facts()` payload, four questions. Each is `_SCOUT` with its middle
paragraph swapped; the JSON reply shape, the parse, the caps and the read-only
posture are shared.

| Tab | Question the scout is asked | Leans on |
|---|---|---|
| **NEXT** | What is most worth doing here next? *(today's `_SCOUT`, verbatim)* | `stalled`, `dirty`, `ahead`, `issues`, `tasks_due` |
| **REVIEW** | Read what changed on this branch. What is wrong, risky or half-done in it? | `branch`, `ahead`, `files`, the diff it reads itself |
| **RESEARCH** | What open question should be answered before more is built here? Name the decision, not the task. | `issues`, `worktrees`, docs, `files` |
| **POLISH** | Of the recently-changed UI files, what breaks this repo's design system — hardcoded colour instead of a token, magic-number alignment, a state that was never designed, something that only works in one theme? | `files` filtered to `.tsx/.ts/.css`, plus the repo's token source |

POLISH gets one extra fact the others don't: the repo's design-token source, if
one is findable (`lib/shell.ts`, a `tokens.*`, a `*-design` skill readme). Absent
one it falls back to `_heuristic` like any scout that returns nothing.

**Failure is unchanged and per-tab:** a scout that times out or returns garbage
leaves its tab showing `_heuristic(f)`, exactly as today. There is always a list.

### 4 · Cache and scope

`nextup.json` today:

```json
{"items": [...], "generated": 0, "repos": [], "cache": {"<cwd>": {"key": "…", "items": [...]}}}
```

becomes:

```json
{"items": [...], "generated": 0, "repos": [],
 "cache": {"<cwd>": {"key": "…", "items": [...],
                     "kinds": {"review": [...], "research": [...], "polish": [...]}}},
 "dismissed": {"<item id>": 0}}
```

- `items` and `cache[cwd].items` keep their exact meaning — the global board and
  its NEXT-kind per-repo cache. The WORK tab and Mini App read these and are
  untouched.
- `kinds` is additive and lazily filled: a tab that has never been opened has no
  entry and shows `_heuristic` until its first refresh.
- `key` stays `cache_key(f)` and governs **every** kind. One repo state, one
  key — moving the repo invalidates all four tabs together, which is correct:
  the same commit changes what is next, what is worth reviewing and what is
  freshly unpolished.

New signatures, both defaulting to today's behaviour:

```python
def board(chat_id, project=None, kind="next") -> dict
def refresh(chat_id, project=None, kind="next") -> dict
```

`project` set → `recent_repos()` is skipped entirely; the one `cwd` is resolved
via `_abs(project)` and scouted alone, `rank()` is skipped (≤3 items need no
ranking), and the response's `repos` is that one repo. The concurrency guard
keys on `(chat_id, project, kind)` instead of `chat_id`.

### 5 · Dismiss

`POST /local/next/dismiss {id}` adds the id to `dismissed`; `board()` filters it
out. Item ids are already `f"{cache_key}-{n}"` (`nextup.py:436`), so an item
dismissed against one repo state cannot survive that state changing — the id
simply stops existing. Pruning is therefore one line in `_write`: drop any
dismissed id whose `cache_key` prefix is no longer in `cache`.

## Surfaces

| File | Change |
|---|---|
| `bridge/nextup.py` | `project`/`kind` args; `_SCOUT_REVIEW/_RESEARCH/_POLISH`; `kinds` cache; `dismissed` |
| `bridge/dashboard/server.py:338` | `GET /local/next` reads `?project=&kind=` |
| `bridge/dashboard/server.py:907` | `POST /local/next` reads `{project, kind}`; new `POST /local/next/dismiss` |
| `bridge/dashboard/web/src/api.ts` | `nextBoard(opts?)`, `refreshNext(opts?)`, `dismissNext(id)`; `NextKind` type |
| `.../components/FreshPanel.tsx` | **new** — status line, tabs, items, dismiss |
| `.../components/hud/Terminal.tsx` | `FreshState`: shrink hero, drop the commit strip and `NextView`, mount `FreshPanel` |
| `.../components/NextView.tsx` | drop the now-unused `project` prop and its filter |
| `bridge/aifeatures.py:58` | reword the `nextup` `about` — four questions, one repo |

Mini App: nothing. `bridge/miniapp/web/src/routes/work.tsx` calls
`api.getNextUp()` with no arguments and keeps getting the global NEXT board.

## Cost

A refresh from this screen scouts **one** repo for **one** kind — one free-rung
call, or one `haiku` call if the free rung is unavailable. Today the same button
scouts up to six repos and then runs a ranking call on top. Opening a tab that
is already cached and whose repo has not moved spends nothing, as now.

Ceiling: four tabs × one repo = at most four scouts per repo state, only for
tabs actually opened. `NEXTUP_SCOUT_TIMEOUT` and `NEXTUP_MODEL` are unchanged
and apply per scout.

With the NEXT-UP BOARD switch off, the panel still renders — status line, tabs
and whatever `_heuristic` last cached — and spends nothing. Today the whole block is hidden
(`Terminal.tsx:214`); the status line and RUN are free facts and should not
disappear with an AI switch. REFRESH is hidden instead, matching how
`NextView.tsx:91` already explains a switched-off board.

## Testing

`tests/test_nextup.py` extends with, all stubbing the scout:

1. `refresh(chat, project="/x", kind="next")` scouts exactly one repo — assert
   one call, and that `recent_repos` was never consulted.
2. Each of the four kinds writes to its own `kinds` slot and leaves the others
   untouched.
3. `board(chat)` with no arguments returns the pre-existing global board shape
   byte-for-byte — the Mini App contract.
4. A scout raising still yields `_heuristic` items for that kind only.
5. A dismissed id is absent from `board()`, and reappears once `cache_key`
   changes.

Frontend gate is `tsc -b` plus a build, as ever. Visual check via **bridge-eyes**
against a worktree build: the panel in at least two themes, since POLISH exists
precisely because themes drift.

## Open question for the plan

`FreshPanel` needs the repo's design-token source for POLISH. Resolving it
(`lib/shell.ts` vs a skill readme vs nothing) is per-repo guesswork. The plan
should start with the dumbest version — glob three known names, pass what hits,
pass nothing when none do — and only get cleverer if POLISH items come back
visibly generic.
