# Profiles + ACP agents: run sessions on agents other than Claude, bound to a profile

Status: design approved in chat 2026-10-07 ("go with A", then "implement").
Research: `.mystical/docs/research_notes/Multi-provider support/agent-runtimes.md`
and `profiles-and-backends.md` (capability matrix, ACP pain points, ToS table).

## Problem

1. **Only Claude runs a session.** The one other runtime, `bridge/freeagent.py`,
   is `opencode run --auto` used as a usage-limit fallback. It returns the
   whole reply as one blob, can't show a permission card (no one-shot agent
   mode can — research Q1), and has run 0 turns with 0 keys configured.
2. **"Which account with which settings" lives in the browser.** The PROFILES
   card (`dashboard/web/src/lib/profiles.ts`) is localStorage on one device,
   and APPLY copies values once. The Mini App and the bot never see it. The
   per-message AGENT dropdown has the same problem.

## Goal

- A **profile** is a named, server-side bundle: agent + account + model +
  permission mode + effort + tool switches. Each project has a default
  profile, and a new session takes it. A session keeps its profile on every
  surface. Editing a profile reaches every session that uses it, from that
  session's next turn, except knobs hand-set in that session.
- Sessions can run on **non-Claude agents** through one stdlib **ACP** (Agent
  Client Protocol, v1) client, with the same transcript rows, permission
  cards and Stop as a Claude turn.
- **Nothing with security or ban risk**, enforced in code (below).

Claude keeps its `claude -p` stream-json runner untouched (layout A). It is
still the main runtime.

## Non-goals (later, not here)

- A direct Codex `app-server` client (real reset times, steering).
- Falling back between profiles on a limit, or cross-agent handoff.
- Usage meters, limit parking and auto-resume for agent turns.
- Claude Code pointed at third-party Anthropic-compatible URLs. A profile
  never sets a provider URL for Claude.
- More presets (Cursor, Goose, Kimi, Qwen). Each one is a single table row,
  added when it's wanted.
- Bridge MCP tools (Run/Screenshot/Attach/goals) for agents. Their server env
  carries the dashboard token, and handing it to a third-party CLI violates
  rule 3. This needs a scoped token first.
- The bridge context pack for agents. Its instructions name Claude-only tools
  (AskUserQuestion, the Run tool). Agents read AGENTS.md/CLAUDE.md
  themselves.

## Safety rules (each one enforced in code, each one tested)

1. **Vetted presets only.** Agents come from a fixed table in
   `bridge/acp_agents.py`. There is no custom-command field anywhere. Every
   preset is the vendor's own CLI, or the ACP org's official adapter that
   runs the vendor's CLI.
2. **No login tokens touched.** The bridge never reads, copies or forwards a
   CLI's credential file or token. A subscription login always goes through
   the CLI's own login flow, run by the user in a terminal. The only secrets
   the bridge holds are API keys the user pastes in:
   `~/.mystical/agent-accounts.json`, mode 0600. The API returns them masked
   (`sk-…abcd`) and never logs them.
3. **Scrubbed child environment.** An agent child gets:
   - an allow-list: `PATH HOME USER LOGNAME SHELL LANG LC_* TERM TMPDIR XDG_*`,
     `http(s)_proxy`/`no_proxy` in either case, and `NODE_EXTRA_CA_CERTS`,
     `SSL_CERT_FILE`, `SSL_CERT_DIR`;
   - the preset's own fixed env, such as auto-update off;
   - that account's key var and/or home var.

   Nothing else. No Telegram, dashboard, GitHub, Rivendell or tracker token,
   and no `ANTHROPIC_*` / `CLAUDE_*` variable.
4. **Claude models stay on claude.** An agent profile, or a live model pick,
   whose model id names Claude or Anthropic (`claude`, `anthropic/` and
   `opus`/`sonnet`/`haiku`/`fable` as a path segment, case-insensitive) is
   refused with a 400 ("Claude models run in a Claude profile").
5. **Not offered:**
   - Gemini with a Google login. Consumer logins have been dead since
     2026-06-18, and token piggybacking is a ban; the Gemini preset is API key
     only.
   - Antigravity. Its terms §6 ban third-party access.
   - Copilot. Its ACP mode has auto-approved everything since 1.0.81, #4537.
   - Amp. It has no client approvals.
   - Droid. It leaks context across sessions, #46.
6. **One person per login.** Agent profiles run only for the owner's chat
   (`config.DASH_CHAT_ID`). Any other chat's agent turn ends at start with that
   reason. It's checked in the turn, so every caller is covered, not just /run.
7. **Asking by default.** Each preset starts in its asking mode, so tool use
   shows cards:
   - Codex: its default approval preset.
   - opencode: ships allow-all, so the preset passes `OPENCODE_PERMISSION` as
     ask for edit/bash/webfetch.
   - Gemini: `default`.

## Part 1 — Profiles (Claude only; shippable alone)

### Data

`bridge/profiles.py` (new) keeps `profiles.json` beside `bridge.db`, written
atomically (tmp + `os.replace`), in the `project_config.py` pattern. One list:

```json
[{"id": "p_3k9x", "name": "Work Opus",
  "agent": "claude",            // "claude" | an acp_agents preset id (Part 2)
  "account": "2",               // claude: slot number as string, "" = ambient;
                                // agents: "" = machine login, else an agent-account id
  "model": "claude-opus-5-5",   // "" = the agent's default
  "mode": "bypassPermissions",  // claude permission mode, or an agent mode id
  "effort": "high",             // "" = default
  "tools": null}]               // claude deny list; null = default_disabled_tools()
```

Validation: the name is 1–32 chars and unique; the agent is known; the
account is valid for that agent. A Claude model or mode goes through the
existing `normalize_model_effort` / `normalize_permission_mode`. An agent
model goes through rule 4. An unknown id on update or delete is an error.

Sessions get two columns, `profile_id TEXT` and `effort TEXT`, through
`_SCHEMA` plus an idempotent `ALTER TABLE` in `store.init()`. The change is
additive, so master keeps reading the DB.

The project default is a `profile` field in `project_config.json`, through
`_get_field`/`_set_field`.

### Effective settings (`profiles.effective(session)`)

Per knob: the session's own value (hand-set) wins, then the profile's value,
then today's behaviour:

| knob | session column | profile field | fallback |
|---|---|---|---|
| model | `model` | `model` | no `--model` |
| permission mode | `permission_mode` | `mode` | `MINIAPP_PERMISSION_MODE` |
| effort | `effort` (new) | `effort` | none |
| tools | `disabled_tools` (NULL = unset) | `tools` (null = unset) | `default_disabled_tools()` |
| agent / account | — (from the profile only) | `agent`, `account` | claude / ambient |

A session without a profile behaves exactly as today.

### Writes keep the profile live

`profiles.save_pick(session, field, value)` is the only writer for the three
pickable knobs. On a profiled session, a value equal to the profile's value
stores NULL (follow the profile), and any other value is stored as the
session's own. Picking the profile's value again is therefore "reset". On an
unprofiled session it stores the value, as today.

`save_run_settings` (`miniapp/server.py`, shared by both servers) and both
`/run` handlers go through it. Today `/run` saves the model and mode on every
send; through `save_pick`, a send that matches the profile no longer pins the
session. `effort` joins `model`/`permission_mode` in `save_run_settings`
(`pick: "effort"` is valid too). Effort becomes session-scoped on every
session; the device default only seeds a session that has no effort set.

### Creation and switching

- `runner._resolve_session` creates a new session with
  `profile_id = project default`. A profiled session is created with
  `permission_mode = NULL`, so the profile's mode applies. An unprofiled one
  still gets `_surface_default_permission`.
- A `/run` body may carry `profile_id` for a fresh session, set on creation.
- `POST …/session/profile {session_id, profile_id}` (both servers, one shared
  function):
  - Same agent: allowed any time. It clears the session's model, mode and
    effort overrides, so the new profile shows through. Tools are left alone:
    they're a per-session toggle set.
  - Different agent: allowed only while the session has no turns. Otherwise
    it returns 409 `{"error": "…start a new session…"}`, and the UI offers a
    new session with that profile.
  - `""` unbinds.
- Deleting a profile unbinds its sessions (`profile_id = NULL`) and clears it
  as any project's default.

### Runner

`start_streaming_job` resolves `eff = profiles.effective(session)`. The
caller's explicit model, mode, effort and account still win, as internal
callers (Rivendell, trackers, the limit ladder) do today. With no explicit
account, a Claude profile's account becomes `account_slot`. A non-Claude agent
becomes `runtime = "acp:<agent>"` plus `job.acp_account`. Part 1 only resolves
Claude profiles. `handle_task` (the bot) resolves the same way, and refuses
agent sessions with "continue this one in the Mini App or dashboard".

### Surfaces

- **Session payloads** (`_session_brief` and the dashboard serializer) add
  `profile_id`, the effective `model`/`permission_mode`/`effort`/
  `disabled_tools`, and `overrides` (the knobs set by hand).
- **Routes** (dashboard `/local/…`, Mini App `/api/…`, same JSON):
  - `GET profiles` returns `{profiles, project_defaults}`.
  - `POST profiles` takes `{action: create|update|delete, …}`.
  - `POST session/profile`.
  - `POST project/profile {project, profile_id}`.

  The Mini App gets GET plus `session/profile`. Profiles are edited on the
  dashboard.
- **Dashboard:**
  - The Settings PROFILES card becomes a server-backed editor, with agent,
    account, model, mode, effort and "use this session's tool switches".
  - Saved browser profiles are imported once (POST each, then clear
    `hud-profiles`).
  - The composer's AGENT dropdown is replaced by a PROFILE dropdown, which
    lists the profiles plus "No profile".
  - The model, mode and effort pickers show effective values.
  - Project settings get a default-profile select.
  - The client tolerates a 404 on the new routes (it hides the picker and
    says "restart the bridge"), per the feature-slice rule.
- **Mini App:** a profile picker in the composer, via the existing
  select/sheet component.
- **Bot:** `/profile` lists the profiles with the current session's
  highlighted, and `/profile <name>` binds the chat's latest session. Both
  are added to `HELP`.

## Part 2 — ACP agents

### `bridge/acp_agents.py`: presets, accounts, environment

Presets (v1). Exact commands are verified at implementation time against the
installed versions:

| id | label | command | key var | home var | fixed env |
|---|---|---|---|---|---|
| `codex` | Codex | `npx -y @agentclientprotocol/codex-acp@2.1.1` (pin bumped deliberately) | `OPENAI_API_KEY` | `CODEX_HOME` | — |
| `opencode` | opencode | `opencode acp` | — (providers via `opencode auth login`) | `XDG_DATA_HOME` | `OPENCODE_PERMISSION` (ask), `OPENCODE_DISABLE_AUTOUPDATE=1` |
| `gemini` | Gemini CLI | `gemini --acp` | `GEMINI_API_KEY` (required) | `GEMINI_CLI_HOME` | — |

Each preset also has a login command for "separate login" accounts:
- `codex login --device-auth`
- `opencode auth login`
- none for Gemini, which is API key only.

Accounts per agent:
- **machine login** (`""`): the CLI's own ambient login and config;
- **API key** (kind `key`): `{id, agent, label, kind, key}`, with the key injected
  as the preset's key var;
- **separate login** (kind `home`): `{id, agent, label, kind}`, with
  `~/.mystical/agent-homes/<id>/` (0700) as the preset's home var. The UI
  shows the exact command to run once in a terminal:
  `CODEX_HOME=… codex login --device-auth`.

`env_for(preset, account)` builds the child environment by rule 3.
`available()` lists presets with `installed` (the binary is found on PATH or
in known dirs) and an `install` hint.

### `bridge/acp.py`: the client

- **Transport.** Stdlib only.
  - `Popen(start_new_session=True, stdin/stdout/stderr=PIPE, env=env_for(…))`,
    with cwd set to the session's cwd.
  - Newline-delimited JSON-RPC 2.0, framed on `\n` only (never
    `str.splitlines()`).
  - A reader thread, a stderr drain thread, and a write lock.
  - A pending-response map `id → slot`.
  - Every agent→client request is answered; an unknown method gets `-32601`,
    or the turn hangs (Cursor's blocking `cursor/ask_question`).
- **Handshake.** `initialize {protocolVersion: 1, clientCapabilities: {fs:
  {readTextFile: false, writeTextFile: false}, terminal: false}, clientInfo:
  {name: "mystical-assistant", version}}`. No elicitation, no terminal auth.
  A `-32000` (auth required) anywhere ends the turn with "<agent> needs a
  login: run `<login command>`" and no retry.
- **One process per turn**, like `claude -p`:
  1. spawn and `initialize`;
  2. `session/new {cwd, mcpServers: []}` on the first turn; otherwise
     `session/resume` when `sessionCapabilities.resume` is advertised, else
     `session/load` (the replayed `session/update`s are dropped until its
     response arrives);
  3. apply the session's options;
  4. `session/prompt`, streaming updates until the `stopReason`;
  5. close stdin, wait, kill the group.

  Ponytail ceiling: 2–13 s cold start per turn, and a load replay. If that
  hurts, keep a process per session alive between turns.
- **Prompt content.** A `text` block. Attachments are named in the text, as
  `_with_images` does, since the files are on disk.
- **Options.** `session/new`/`load` return `configOptions` (and/or legacy
  `modes`). Model, mode and effort are applied with
  `session/set_config_option` by category (`model`, `mode`, `thought_level`),
  falling back to `session/set_mode` for mode. Values the agent doesn't offer
  are skipped with a log row. The options seen are cached per agent and
  account (memory plus `~/.mystical/acp-options.json`) for the pickers.
- **Live switch.** `Job.set_run_settings` on an agent job sends the same
  `set_config_option` over the open connection.
- **Event mapping** onto the existing transcript events:

  | ACP `sessionUpdate` | bridge event |
  |---|---|
  | `agent_message_chunk` | buffered → `text` (flushed at a tool call, a permission request, or the turn's end) |
  | `agent_thought_chunk` | buffered → `thinking` |
  | `tool_call` | `tool {name: title or kind, id: toolCallId, summary}` |
  | `tool_call_update` status completed/failed | `tool_done {id, ms, is_error, patch (from diff content), stat}` |
  | `plan` | `job.todos` (the same shape TodoWrite fills) |
  | `usage_update` | `job.ctx_tokens = used`; `job.cost` from `cost.amount` when the currency is USD |
  | `current_mode_update` / `config_option_update` | update the cache, plus a log row |
  | anything else | ignored |

- **Permissions.** `session/request_permission` adds the existing pending
  `permission` card (tool name from the tool call's title, summary from
  rawInput or locations). Allow sends the agent's own `allow_once` optionId,
  Deny its `reject_once`. If either kind is missing, the first option of the
  allow/reject family is used. Pending cards answer `cancelled` on Stop.
- **Stop.** `session/cancel`, then the existing `INTERRUPT_GRACE` escalation
  (SIGTERM, then SIGKILL on the process group).
- **Outcome.** The `stopReason` comes back as `end_turn`, `max_tokens`,
  `max_turn_requests`, `refusal` or `cancelled`. A JSON-RPC error on
  `session/prompt` (Gemini sends HTTP 429 this way) ends the turn as
  `error` with its message. A quota hit that an agent reports only as
  assistant text stays plain text. There is no text classifier: a false
  positive would mark a real answer about rate limits as failed.
  There is no parking and no auto-resume (`_maybe_auto_resume` returns
  False for `acp:` runtimes, and boot recovery already skips sessions with
  no `claude_session_id`).

### Runner integration

- An `AcpJob(Job)` subclass overrides `interrupt`, `respond`,
  `set_run_settings` and `_write_stdin` (always False, so stray stream-json
  writes go nowhere).
- `steer()` refuses agent jobs. The client queues instead.
- `_run_streaming` calls `acp.run_turn(job, …)` for `acp:` runtimes and
  shares its `finally`. The `finally` stores `job.agent_session_id` in the
  new `sessions.agent_session_id` column, never in `claude_session_id`, so
  Claude-only readers (JSONL transcripts, the subagent viewer, native scan,
  recovery) never touch an agent session. The transcript renders from the
  bridge's own event journal.
- The turn's `runtime` is `acp:<agent>`; the account goes in `job.acp_account`.
- `job.boot` shows "starting <label>" until the first update.

### Routes and UI

- **Routes:**
  - `GET /local/agents/presets` returns presets, accounts (keys masked) and
    cached options.
  - `POST /local/agent-accounts {action: create|delete, agent, label, key?|home}`.
  - `POST /local/agents/test {agent, account}` runs `initialize` plus
    `session/new` in a temp dir, then `session/delete`/`close` when
    advertised. It returns `{ok, error?, options}` and fills the options
    cache. It's the TEST button.
- **Dashboard Settings:**
  - An AGENTS section replaces FREE AGENTS: per preset, install state,
    accounts (add key, add separate login with its command shown, delete),
    and TEST.
  - The profile editor's agent select lists Claude plus the installed
    presets. Model and mode selects come from the cached options, with the
    agent's default as the first entry.
- The Mini App needs no Part 2 work beyond profiles listing agent profiles.

### Removed

- `bridge/freeagent.py` and `tests/test_freeagent.py`.
- `runner._consume_free_agent` and its `opencode:` checks.
- `ladder`'s free rung and `resolve_agent`'s `opencode:` branch. The limit
  ladder becomes: another Claude account, then wait for the reset.
- The next-up scout's opencode path (it uses its Claude one-shot, as it
  already does when no free agent is configured).
- The dashboard's FREE AGENTS settings and `/local/freeagents`.
- The composer's free-agent mode list.
- `lib/profiles.ts`, after the import.
- `agentconfig.py` keeps the opencode AGENTS.md/opencode.json editor.

## Testing

- `tests/test_profiles.py`: CRUD validation, `effective()` precedence per
  knob, `save_pick` follow/override/reset, project defaults, deletion
  unbinding, the Claude-model refusal (rule 4).
- `tests/test_profiles_endpoint.py`: both servers' routes, session/profile
  409 across agents, the `/run` no-pin behaviour, owner-only agent runs
  (rule 6).
- `tests/fake_acp_agent.py`: a stdlib script that speaks ACP v1 and is
  scripted by an env var (chunks, a tool call with a diff, a permission
  request, an unknown vendor request, a quota-text ending, resume vs load
  capabilities, auth-required).
- `tests/test_acp.py`: mapping, the permission round trip, cancel, the load
  replay being dropped, `-32601`, `-32000`, junk stdout, a crash, the env scrub (rule 3, which
  asserts no `DASH_TOKEN`/`TELEGRAM`/`ANTHROPIC` var reaches the child), and
  key masking (rule 2).
- `tests/test_acp_runner.py`: an `acp:` turn through `start_streaming_job`
  against the fake agent. It ends `done` with the events journaled; there is
  no `claude_session_id`; auto-resume is skipped; Stop works.
- One live smoke run against the installed `opencode acp`, recorded as a
  replay fixture (`tests/fixtures/acp/opencode-*.ndjson`).
- `bridge-eyes` screenshots of the profile editor, the composer picker, the
  AGENTS section and the Mini App picker.

## Risks

- **ACP churn.** Schema minors land every 1–2 weeks, and v2 drops
  `session/load`. The client pins `protocolVersion: 1`, ignores unknown
  update kinds, and fixtures catch drift.
- **Gemini.** `session/load` can erase a session (#28775, open). Every
  follow-up turn loads, because Gemini has no `resume`. If it bites, keep
  Gemini's process alive between turns.
- **Codex.** One writer per thread (#37403). The session run lock plus
  killing each turn's process before the slot is released covers it.
- **opencode.** It drops rate-limit info over ACP (#52860), so quota hits
  surface only as text.
