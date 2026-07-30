# Fallback ladder — multi-account Claude + free-agent handoff

**Date:** 2026-07-30
**Scope:** `bridge/accounts.py`, `bridge/freeagent.py`, `bridge/ladder.py` (all new);
`bridge/limits.py`, `bridge/usage.py`, `bridge/runner.py`, `bridge/store.py`,
`bridge/dispatch.py`; dashboard + Mini App session settings.

## Problem

When a turn dies on a usage limit, the bridge has exactly one move: park the session
and resume it when the window resets (`bridge/limits.py`). That is the right last
resort, but it is the *only* resort — a five-hour window that empties at 14:00 means
five hours of nothing, even when the user owns a second Claude account with full
quota, and even when the remaining work is mechanical enough for a weaker model.

## Goal

On a usage limit, walk a **ladder** of runtimes until one accepts the work, governed
by a per-session **policy**:

1. **Another Claude account** — best-quota-first, full fidelity, resumes the same session.
2. **Free agent** — a different provider via one adapter, seeded with a briefing.
3. **Park until reset** — today's behaviour, always the last rung, never removed.

## Non-goals

- Proxy/relay pooling of OAuth tokens. See *Compliance* — this is the banned pattern.
- Using a Claude Pro/Max subscription from a non-Anthropic client. opencode's own docs
  state Anthropic prohibits it; the free agent is a *different-provider* fallback only.
- Reaching the Gemini CLI's or Qwen Code's OAuth daily quotas. Those belong to those
  CLIs' own logins, not to an API key. See *Free-agent providers*.
- Load-balancing for throughput. The ladder is a failure response, not a scheduler.

## Compliance

Two multi-account architectures exist in the wild and Anthropic treats them
differently, so the choice is not stylistic:

- **Relay pooling** (`claude-relay-service`, CLIProxyAPI, PackyCode): a server holds N
  OAuth tokens and answers as if it were the official client. This is enforced against
  — the April 2026 OpenClaw ban wave targeted it.
- **Per-profile rotation** via `CLAUDE_CONFIG_DIR`: each account is an isolated profile
  directory with its own credentials, and every invocation is the real `claude` binary.
  This is accepted; Anthropic's Claude Code team has stated that holding multiple Max
  accounts is not a ToS violation, and that enforcement targets account sharing and
  token reselling.

**This design implements per-profile rotation only.** Every Claude turn remains a
`claude` subprocess spawned by `runner.py`; nothing interposes on the API.

## Prior art

- **[claude-swap](https://github.com/realiti4/claude-swap)** (Python, ~1.4k★). Its
  *session mode* (`cswap run N`) is per-process account isolation — the correct model
  here. Its default `cswap switch` is a **global** swap of `~/.claude/.credentials.json`,
  which would change accounts underneath already-running bridge sessions, so it is not
  usable as-is. Ideas taken: adaptive per-account usage polling, dead-refresh-token
  quarantine, and the `best` / `next-available` / `consume-first` strategies.
- **[opencode](https://github.com/anomalyco/opencode)** (TypeScript, ~191k★). `opencode
  run <prompt> --format json --session <id> --model <provider/model> --auto` is a close
  analogue of the bridge's `claude -p --output-format stream-json --resume`, which makes
  it the cheapest free-agent runtime to adopt. Not adopted for Claude turns.

Neither becomes a dependency. Both were read for their solutions.

---

## Architecture

### 1. `bridge/accounts.py` — profiles as thin overlays

A profile is **not** a copy of `~/.claude`. It is a directory of symlinks with exactly
the account-specific files made real:

```
~/.mystical/accounts/<slot>/
  .credentials.json          real file  — this account's OAuth tokens
  projects   -> ~/.claude/projects       symlink — SHARED transcripts
  skills     -> ~/.claude/skills         symlink
  plugins    -> ~/.claude/plugins        symlink
  settings.json -> ~/.claude/settings.json
  CLAUDE.md  -> ~/.claude/CLAUDE.md
  hooks      -> ~/.claude/hooks
```

This is the load-bearing decision. Six bridge modules resolve `~/.claude` paths
directly:

| Module | Path |
|---|---|
| `transcript_jsonl.py:22` | `PROJECTS_DIR = ~/.claude/projects` |
| `machine.py:16-17` | `SESSIONS_DIR`, `PROJECTS_DIR` |
| `skills.py:24` | `SYSTEM_ROOT = ~/.claude/skills` |
| `agents.py` | `~/.claude/projects/<enc>/<sid>/subagents/` |
| `native.py` | scans `~/.claude/projects` |
| `models.py:19` | `~/.claude/.credentials.json` |

Sharing `projects/` by symlink means **none of them change**. Transcripts, the subagent
viewer, the dashboard session list, and native-session scanning keep working against a
single root, and any account can `--resume` any session because the transcript is in
one place. A profile built by copying instead of symlinking would fragment all six.

`usage.py` reads credentials and must become account-aware (§2). `models.py` also reads
them, but only to enumerate available models for the chat pickers — a list that does not
meaningfully differ between subscription accounts, and which already falls back to the
curated `config` list when the token is unavailable. It keeps reading the default
account's credentials; making it per-account is explicitly out of scope. The remaining
four modules need no change at all.

**API:**

```python
list_accounts()          -> [{slot, email, usage, state, alias}]   # state: ok|exhausted|quarantined|disabled
env_for(slot)            -> {"CLAUDE_CONFIG_DIR": <profile dir>}   # or {} for the default account
pick(exclude=(), strategy="best") -> slot | None
add(slot=None, alias=None) / remove(slot) / disable(slot) / enable(slot)
```

`env_for` is merged in `runner._run_env()` (`runner.py:163`) — the single existing seam
for per-run environment, today carrying only `PONYTAIL_DEFAULT_MODE`. Every code path
that spawns `claude` already routes through it.

**Onboarding.** `/accounts add` instructs the user to run `claude /login` as the other
account in a terminal, then snapshots the resulting credentials into the next free slot
and builds the overlay. No credential entry through Telegram; no password handling.

**Strategies.** `best` (most quota remaining) is the default. `next-available` skips
exhausted slots without preference. `consume-first` prefers the account whose *weekly*
window resets soonest, so perishable quota is spent before it expires.

**Quarantine.** A slot whose refresh token is dead is marked `quarantined`, excluded
from `pick()`, and surfaced in `/accounts` with the recovery instruction (re-login and
`/accounts add --slot N`). A quarantined slot never silently disappears.

### 2. Per-account usage — generalize `usage.py`

`get_usage()` becomes `get_usage(creds_path=None)`, with the module cache keyed by path
rather than global. `_token()` takes the path. Everything else — the 60s TTL, the
`STALE_MAX` last-good fallback, the `RETRY_TTL` behaviour on failure — is unchanged and
now applies per account.

Poll cadence, because `api.anthropic.com/api/oauth/usage` 429s readily and the Claude
CLI polls it too: the **active** account every 60s (today's `CACHE_TTL`), **idle**
accounts every ~5 min, **exhausted** ones every ~10 min. With a handful of accounts
this stays under the traffic a single interactive CLI already generates.

`limits._reset_epoch()` (`limits.py:104`) currently calls `usage.get_usage()` with no
argument and so reads the default account. It must pass the credentials path of the
account the dying session was *running on*, or a session on slot 2 will be parked
against slot 1's reset time.

### 3. `bridge/freeagent.py` — one adapter, four providers

```
opencode run <prompt> --format json --session <id> --model <provider/model> --auto
```

The adapter's whole job is normalizing opencode's JSON event stream into the event shape
`runner.py` already emits, so the dashboard, Mini App, and turn recording need no
per-runtime branching. It does **not** implement the `--permission-prompt-tool stdio`
control protocol: free-agent turns run under `--auto` within the session's existing
permission mode, and a free-agent turn that would need an interactive permission
decision is reported as blocked rather than approved on the user's behalf.

**Provider ladder**, tried in order, first configured one wins:

1. **opencode zen free models** — no card required. Explicitly temporary promotional
   models, so the config lists them by id and tolerates any of them 404ing.
2. **Gemini**, via the OpenAI-compatible endpoint
   `https://generativelanguage.googleapis.com/v1beta/openai/` with an AI Studio key
   (free tier ≈1500 req/day on Flash, no card).
3. **Qwen**, via DashScope's OpenAI compatible-mode endpoint + key.
4. **Ollama local** — no quota, no network, weakest at tool use. opencode's docs
   recommend raising `num_ctx` to 16k–32k or tool calls fail.

Rungs 2 and 3 are wired as opencode custom providers over
`@ai-sdk/openai-compatible`, which is why all four fit behind one adapter.

**Explicit limitation.** opencode has no free Gemini-CLI or Qwen-Code OAuth path; those
CLIs' daily quotas are tied to their own logins. Routing them through opencode uses
their **API-key free tiers** instead. Reaching the Gemini CLI's OAuth quota specifically
would require a second adapter with its own output format, and is out of scope here.

### 4. The handoff

A free agent cannot resume a Claude session — different runtime, different session
store. A handoff therefore starts a **fresh runtime session seeded with a briefing**:

- the **last 3 turns** of the Claude transcript, summarized (reuse the existing one-shot
  summarizer path in `runner.py` used for titling/memory, with `skip_pack=True`);
- the current task statement;
- a continuation instruction in the shape of `limits.NUDGE` — *you are continuing work
  already in progress; review what was done and finish it; do not start over.*

Cross-**account** switches need none of this: shared `projects/` means a plain
`--resume <claude_session_id>` under a different `CLAUDE_CONFIG_DIR` continues the same
transcript. That is the payoff of §1.

Free-agent turns are recorded with their runtime and rendered distinctly in the
dashboard, so work produced by a weaker model is visible rather than indistinguishable
from Claude's.

### 5. Policy and approval

**Schema** (both migrations idempotent, following the `turns.model` precedent at
`store.py:130-133`):

- `sessions.fallback_policy TEXT` — `ask` | `auto` | `wait` ; `NULL` → global default.
- `turns.runtime TEXT` — `NULL` = default Claude account, else `claude:2`,
  `opencode:gemini`, …

**Policies:**

- **`ask`** (default) — one card, on Telegram via the existing inline-keyboard +
  `callback_query` path (`telegram.py:39-54`) and in the dashboard:
  `Switch to account 2 (78% left) · Free agent (Gemini Flash) · Wait for reset (21:40)`.
  Only rungs actually available are offered. **The session is parked immediately**, as
  today, and the card stays actionable on top of that — so an unanswered card degrades
  into current behaviour rather than into a stalled session, and answering it early
  resumes on the chosen rung and cancels the parked entry. There is no timeout into
  `auto`.
- **`auto`** — walk the ladder without asking; notify which rung it landed on.
- **`wait`** — exactly today's behaviour.

Set per session from the dashboard and Mini App session settings, and via a `/policy`
command; the global default lives in `config.py` alongside `AUTO_RESUME`.

### 6. Hook point — `bridge/ladder.py`

`limits.defer()` (`limits.py:177`) keeps its exact contract: it always parks and returns
`(fire_at, first)` or `None` on `MAX_TRIES`. No polymorphic return, no change to its two
callers' happy path (`runner.py:312`, `runner.py:750`).

The escalation lives in a new `bridge/ladder.py`, the one module that reads the policy
and composes `accounts` + `freeagent`. It is consulted **after** the park, so the order
at each limit-death site is:

1. `limits.defer(...)` — park first, unconditionally. This is the safety net; there is
   never a moment where a session is neither parked nor running.
2. `ladder.escalate(session, chat_id, ...)` — reads `sessions.fallback_policy` and
   enumerates available rungs, then:
   - `wait` → returns `None`; the park stands and today's message is sent.
   - `ask` → posts the card; the park stands until the user picks a rung.
   - `auto` → takes the best rung immediately and cancels the parked entry.

Taking a rung cancels the park through a new `limits.cancel(session_id)` — the only
addition to `limits.py`, since the existing `_pending` dict and persisted
`limit_resume.json` already own that state and nothing else may write to them.

Keeping the ladder out of `limits.py` matters: that module's single job is *waiting*
(two wait kinds, one timer, one parking lot), and it is the piece that already works.
The ladder is *choosing*, and it depends on two new modules that `limits.py` must not
import.

Untouched: `MAX_TRIES`, `SERVER_BACKOFF`, the persisted parking lot's format, `boot()`
re-arming, and the whole server-error path. A transient 5xx is not a quota problem and
must not consume a second account — `is_server_error` deaths never reach `ladder`.

### 7. Failure handling

- **No rung available** (every account exhausted, no free provider configured) → park,
  exactly as today. The ladder degrades to current behaviour.
- **A rung fails on arrival** (switched account is also limited, opencode not installed,
  Ollama not running) → that rung is excluded and the ladder continues from the next
  one. `MAX_TRIES` bounds the whole episode, so a misconfigured ladder cannot loop.
- **`opencode` binary missing** → the free-agent rung is simply not offered. Detection
  mirrors `runner.claude_bin()`: resolve once, do not trust ambient `PATH`.
- **Every account quarantined** → park, and say so plainly in the notification, because
  waiting for a reset will not fix a dead refresh token.

## Testing

- `accounts.py` — overlay construction: symlinks point where expected, `.credentials.json`
  is a real file, an existing profile is repaired rather than duplicated. `pick()` per
  strategy against synthetic usage payloads. Quarantine on a dead token.
- `usage.py` — cache isolation per credentials path: two paths do not serve each other's
  numbers, and the stale-payload fallback stays per path.
- `freeagent.py` — opencode JSON events → bridge events, golden-file tested from one
  recorded real run. No network in tests.
- `ladder.py` — table-driven: policy × available rungs → expected action, with
  `accounts`/`freeagent` stubbed. Assert `wait` is byte-for-byte today's behaviour, that
  `ask` leaves the park in place, that `auto` cancels it, and that a server-error death
  never reaches `escalate` at all.
- `limits.py` — `cancel()` removes the entry, rewrites `limit_resume.json`, and re-arms
  the timer for whatever remains. Existing limit/server tests must still pass unchanged.
- `store.py` — both migrations run twice without error.

Tests follow `tests/conftest.py` env isolation; `python3 -m pytest tests/` must stay
clean apart from the three pre-existing `tests/test_learning.py` failures.

## Open question to settle first — ANSWERED 2026-07-30

**Verified by probe** (empty dir + `CLAUDE_CONFIG_DIR claude -p`): the CLI creates
`.claude.json`, `projects/`, `sessions/` *inside* the profile dir and reports "Not
logged in" — so identity AND credentials are profile-scoped, and **accounts run
concurrently**. A second probe confirmed the overlay works end-to-end: symlinked
`projects/` + copied `.credentials.json` ran a real turn whose transcript landed in
the shared `~/.claude/projects` tree. The concurrent branch below is the one built.

`~/.claude.json` — which holds `oauthAccount` and `userID` — lives **outside**
`~/.claude/`. Whether `CLAUDE_CONFIG_DIR` relocates it along with `.credentials.json` is
undocumented (`code.claude.com/docs/en/settings` does not mention the variable at all,
though the binary contains it and per-profile rotation is a known working pattern).

**Test:** point `CLAUDE_CONFIG_DIR` at a temporary directory, run `claude -p "hi"`, and
observe which files appear where.

- **If it relocates** → profiles are fully independent and two bridge sessions can run
  on two accounts **concurrently**, as designed above.
- **If `.claude.json` stays at `$HOME`** → identity is a global file, and accounts must
  be **serialized**: one active account at a time, switching between turns rather than
  across concurrent sessions. The ladder still works; parallelism does not.

This is step 1 of implementation. It changes the concurrency contract, so it is settled
before code, not discovered during it.

## Implementation deltas (2026-07-30)

Built as specced, with these deliberate simplifications:

- **No background usage poller.** Meters are fetched on demand (per-path 60s TTL in
  `usage.py`) by `/accounts`, `pick()` and the parking lot — the adaptive
  active/idle/exhausted cadence is unnecessary when nothing polls unprompted.
- **`list_accounts()` has no `quarantined` state field.** The behaviour exists —
  a dead-token slot has no readable meter, so `pick()` never lands on it and
  `/accounts` shows "usage unknown" — but no separate state machine tracks it.
- **Free-agent turns are blocking, not streamed** (`runner._consume_free_agent`):
  opencode's stdout becomes one `text` event + a `result` event. Switching to
  `--format json` streaming is a contained change once a real event recording exists.
- **Dashboard/Mini App policy picker and runtime badges are not built** — the
  `/policy` command and the Telegram card are the interface; `turns.runtime` is in
  the DB and flows through `transcript()` for a later UI pass.
