# Next-up board — ranked next steps across recently touched repos

**Date:** 2026-08-02
**Scope:** `bridge/nextup.py` (new); `bridge/dispatch.py`, `bridge/telegram.py`,
`bridge/dashboard/server.py`, `bridge/miniapp/server.py`; dashboard `NextView`;
`tests/test_nextup.py` (new).

## Problem

The bridge knows a great deal about every project on the machine — dirty worktrees,
branches ahead of master, open issues and PRs, sessions that stopped mid-task, curated
project memories — and it uses none of it to suggest anything. Opening the dashboard
means inventing the next task yourself, per repo, from memory. The work that stalls is
the work you forgot was stalled.

## Goal

One ranked list, on demand: the things worth doing right now across the repos you have
touched recently, each with a reason and a button that opens a session already asking
for it.

The list mixes three kinds of item deliberately:

- **Loose ends** — uncommitted diffs, branches never merged, sessions that died mid-task.
- **Direction** — the next thing worth building, from what exists and what the project
  is for.
- **Risk** — what looks broken, untested, or fragile.

Ranking them against each other is the point. A separate list per kind would be three
lists to triage instead of one answer.

## Non-goals

- A task tracker. Items are derived from repo state on every refresh and are not
  persisted, edited, assigned, or completed. GitHub issues already exist for that; the
  board *reads* them.
- Scheduled or background sweeps. Nothing runs unless you ask (see *Freshness*).
- Repos with no recent session activity. A machine with 200 clones must not cost 200
  scouts.
- Writing to repos. Scouts are read-only (see *Scout leash*).

## Shape

Five stages, on demand, in `bridge/nextup.py`. Standard library only, matching the rest
of the server.

### 1 · Pick repos

`store.list_sessions_all` plus the machine registry give repos with session activity in
the last `NEXTUP_DAYS` (default 7), capped at `NEXTUP_MAX_REPOS` (default 6), most
recently active first. Nothing outside that set is examined.

The cap is a hard ceiling, not a hint: it bounds the worst-case cost of a refresh to a
number you can state in advance.

### 2 · Gather facts — no model

Per repo, plain Python, roughly 50ms:

| Source | Facts |
|---|---|
| `bridge/git.py` | dirty file count and names, branch, commits ahead of default, worktrees |
| `bridge/github.py` | open issue count, open PR count, remote slug |
| `bridge/store.py` | sessions whose last turn ended `stopped`/`error`, with that turn's prompt; pinned memories for the repo |

This bundle is the scout's starting knowledge. Handing it over is what keeps the scout
from spending tokens rediscovering `git status`.

### 3 · Scout — one read-only agent per repo, in parallel

One agent turn per repo, spawned concurrently, each given its repo's fact bundle and
told to return JSON: at most three items of
`{title, why, effort: "small"|"medium"|"large", evidence}`.

**Leash.** Read files, grep, inspect git. No edits, no shell commands. Enforced by
`--permission-mode plan` on the Claude path and `--auto` inside the repo on the
opencode path, plus an explicit instruction in the prompt.

**Routing.** `freeagent.available()` non-empty → `freeagent.build_cmd` on the first
available rung with `freeagent.run_env()`. Otherwise
`runner.run_blocking(model="haiku", skip_pack=True)`. Both interfaces exist today and
need no changes.

This is the first *deliberate* use of the free-agent rung. Until now `freeagent.py` was
reachable only through `ladder.py` when a usage limit killed a turn. Scouting is
exactly the workload a free provider is good enough for: bounded, read-only, structured
output, no session continuity. The ladder's limit-death path is untouched.

**Timeout.** `NEXTUP_SCOUT_TIMEOUT`, default 120s, per repo. A scout that overruns is
killed and its repo falls back to its facts.

### 4 · Rank

One more cheap call, same routing, receives every repo's items and returns a single
ranked list of at most ten, each with a one-line reason. Cross-repo judgment is the
value here: deciding that a half-finished migration in one repo outranks a lint failure
in another is not something a per-repo scout can do.

### 5 · Cache

`~/.bridge_state/nextup.json`. One entry per repo, keyed on
`HEAD sha + hash of the dirty-file list + open issue/PR counts`. A repo whose key is
unchanged reuses its stored items and is not scouted.

So a refresh after working in one repo costs one scout and one rank, not six and one.
The rank runs whenever *any* repo's key moved, because ranking is over the merged set
and a stale order missing the fresh repo's items would be worse than no refresh. When
no key moved, the whole board is served from cache and nothing is spawned at all.

## Freshness

On demand only. `GET /api/next` serves the cache instantly. `POST /api/next/refresh`
recomputes in a worker thread and returns immediately; clients poll the state endpoint
they already poll. Nothing computes while you are not looking.

## Surfaces

The backend is the feature. Both frontends read the same JSON.

**Ship order:**

1. `bridge/nextup.py` + Telegram `/next` — the top five, each with an inline **Start**
   button. No frontend build required, and the phone is where the question actually
   gets asked.
2. Dashboard `NextView`, in the pattern of `HistoryView`/`MemoryView` — the same list,
   the same Start button.

**Start.** `nextup` attaches the repo's `cwd` to each item as it collects scout output —
the model never supplies a path. A `to_prompt(item)` helper composes the opening prompt
from `title`, `why` and `evidence`; the model is not asked to write a prompt. Start then
reuses the existing create-session and `queue_manager.enqueue` path: a new session in
that repo, pre-titled from `title`, with that prompt as its first turn. No new run
machinery, and the reasoning is in context from the first token.

## Failure

Every stage fails open, following `bridge/relevance.py`: a flaky helper must never be
the reason there is no answer.

| Failure | Result |
|---|---|
| No recent repos | Empty state: "nothing touched in the last 7 days" |
| No opencode binary or keys | Haiku path |
| No model reachable at all | Heuristic list, no reasons |
| Scout times out or exits non-zero | That repo contributes its raw facts as items |
| Scout returns unparseable JSON | Dropped, same fallback as a timeout |
| Rank call fails | Heuristic order over the collected items |

**Heuristic order**, used whenever ranking is unavailable: session that died mid-task >
dirty worktree with commits ahead > open PR > open issue > everything else. Within a
tier, most recently active repo first.

## Cost

Worst case per full refresh: six scouts and one rank. On the free rung, zero. On the
haiku fallback, roughly $0.15 cold and near zero for a sweep where nothing changed,
since unchanged repos are served from cache.

## Testing

`tests/test_nextup.py`, in the existing style — fake binaries, temporary repos, no
network:

- A repo whose cache key is unchanged is not scouted; the key moves when HEAD moves and
  when the dirty-file list changes.
- A scout that times out still yields items for its repo.
- A failed rank call yields the heuristic order and a non-empty list.
- `NEXTUP_DAYS` and `NEXTUP_MAX_REPOS` are both respected.
- Routing picks the free rung when `freeagent.available()` is non-empty and haiku
  otherwise.

## Settings

| Name | Default | Meaning |
|---|---|---|
| `NEXTUP_ENABLE` | `1` | Off disables the endpoints and the `/next` command |
| `NEXTUP_DAYS` | `7` | How recent a repo's activity must be to qualify |
| `NEXTUP_MAX_REPOS` | `6` | Hard ceiling on repos scouted per refresh |
| `NEXTUP_SCOUT_TIMEOUT` | `120` | Seconds per scout |
| `NEXTUP_MODEL` | `haiku` | Model for the Claude fallback path |
