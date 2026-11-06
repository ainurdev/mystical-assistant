# Multi-agent chats: any agent, any account, one channel

Status: built, behind Settings > Experimental, off by default. Approved in chat
2026-11-06. The decisions below override anything older in this file.

## Decisions (final)

1. **Switching provider sends the whole chat, with a dialog.** Prompts, answers, notes and
   tool names go in the prompt; tool output goes in `.mystical/handoff/<chat>.md`. Too big
   for the new model: newest part, and the dialog says so. Returning to a provider resumes
   its own session plus what it missed. A Claude account change copies nothing and has no
   dialog.
2. **Every model's subagents are listed under their chat in the sidebar**, sortable, 3 shown
   by default, expandable. Anything that needs you stays in the 3, then running, then newest.
   Data we can't read shows a "no details available" state.
3. **Messages go to the agent they're addressed to.** Others can read the log on request.
4. **MCP:** servers known to be shareable go to every model. Unknown ones stay where they're
   installed until shared per model. Tools that reveal secrets or change infrastructure stay
   off until enabled by name, with a warning. The first share says where the data goes.
5. **Writers get their own copy. The chat's current main agent reviews and merges**, so two
   agents never negotiate. Merges land as uncommitted changes after a restore point; nothing
   commits or pushes. Conflicts: the main agent resolves them, or asks you with a card.
6. **Limits are per chat and live, in the model picker:** agents (5), helpers per login (3),
   hops between agents (20), plus Helpers: Off / Ask / Auto. Lowering a limit stops nothing.
7. **Interjecting works like steering.** Claude: native. Kimi refused a mid-turn prompt
   (`turn.agent_busy`), so the bridge waits for the running tool, cancels, and prompts the
   same session: tested live, it keeps its context.
8. **Mystical runs agents and decides who gets called.** An agent asks; Mystical checks the
   rules and picks. A profile you @ is final.

Ask mode: a message of yours that clearly asks for a helper needs no card ("get a subagent to
review"). Anything else gets one card listing what would start.

Sections below are the original plan; where they differ, this list and the module docstrings win.

Findings since the plan was written: the 16 "cut off" Kimi turns were all bridge restarts, each
resumed by recovery. Kimi Code times an MCP call out at 60 s, so a card pauses the turn with the
same cancel instead of blocking the call. `delegation_grants` wasn't needed: the rule reads your
last message.

## Second round (agreed 2026-11-06)

Built on the same branch, one commit per feature, in this order: transcript fixes, images in the chat,
agent tools, rules and hooks and availability on the bridge side, transcript proof and receipts, .mystical,
the Agent Tools page.

- **Images:** Send images: As attachment (default) or In the chat, its own switch. See `bridge/chat_images.py`.
- **Pictures an agent shows or looks at:** `figure` events and Attach/Record draw with the answer; the rest stay in WORK.
- **Tools:** `bridge/gateway_tools.py`. Device runs stay Claude's: their route finds a session by its Claude id.
- **Rules:** off by default except instructions after compaction and subagent status. `bridge/rules.py`.
- **Availability:** machine, project, chat, nearest wins. `bridge/tool_policy.py`. Skills are machine-wide per link.
- **Hooks:** dashboard only; the Mini App shows them. `bridge/hooks_config.py`.
- **.mystical:** a layout agents are told about and a browser. Nothing moves, nothing cleans itself. `bridge/mystical_dir.py`.

## Goal

A Mystical chat stops being "one Claude session" and becomes a place where one
or more agents work:

- Start on Claude, switch to Kimi after a turn, switch back, with the context kept.
- Change account the same way.
- Ask for a second agent when you want one. Agents never start one on their own.
- See every agent under its chat in the sidebar, and in a grid with their messages.
- Step in at any time: message one agent, hold the channel, stop one or all.
- Dashboard, Mini App, Telegram bot, OS notifications and the desktop apps all keep
  working, and a one-agent chat looks and feels as it does today.
- Rivendell loses nothing. No new Rivendell features are in scope.

## Findings this plan rests on

- `bridge/profiles.py:347` refuses a provider change once a chat has turns.
  `agent_session_id` holds one id, so it can't remember Kimi and Codex at once.
- A non-Claude session gets only `_MYSTICAL_NOTE` and `_PUSH_NOTE`
  (`runner.py`, `_consume_acp`). It misses "deliver last", the graph pack and the
  Rivendell note, and the push gate is a Claude `--settings` hook (`_push_gate`).
- Of 37 Kimi turns in the live DB, 13 ended with a result, 7 stopped, 1 errored
  and 16 ended on a tool row with nothing after it. The cause of the 16 is unknown.
- Kimi wrote 259 notes to the user in those turns. `lib/dossier.ts` files all of
  them under WORK. The stream parsing is correct.
- Kimi Code 2.4.1 launched a stdio MCP server passed in `session/new` and called
  `tools/list`; it advertises http and sse. Tested without a model turn: a real
  tool call, http and passing servers on resume are still open.
- Rivendell jobs start on `profiles.claude_default` in bypass mode
  (`rivendell.py:1622`, `:1645`).
- `team.py` rebuilds shared transcripts from a whitelist of event types, so new
  event types vanish from team shares unless they are added.
- `claude -p` doesn't spawn agent teams, so vendor team features can't be the base.

## How it works

**One chat, one channel, many agents.** The channel is a log of messages kept by
Mystical. Agents never talk to each other directly. Mystical carries each message,
so everything can be read, held, edited or stopped.

**Each extra agent is a real session** with its own transcript, cards, Stop and
profile, linked to its parent chat. All the session machinery keeps working. It
lists under the parent, never as a separate chat.

**Mystical keeps the shared record; each provider keeps its own memory.** Switching
provider starts or resumes that provider's session and hands it what it missed.

**One shared tool server per session.** Agents connect to Mystical with a token
limited to that session. It offers delegation, channel, ask-the-user cards, goals,
Run and the permitted MCP servers. Mystical holds the credentials.

## Workstreams, in build order

Every one ships alone and leaves master working. Each covers dashboard, Mini App
and bot as it goes (`bridge-feature-slice`), so no surface is left for last.

### 1. Make agent turns trustworthy

- Find out why 16 of 37 Kimi turns have no ending, then fix it. Everything below
  multiplies this.
- Add a "said to you" tier to `lib/dossier.ts` and both `RunStream`s: agent notes
  sit outside the WORK fold, with the latest shown and older ones collapsed. Tools
  and thinking stay in WORK.
- A stopped or cut-off turn shows its last note instead of nothing.
- `acp.py:554`: a result box only takes text that came after the last tool.

Done when: replayed Kimi fixtures show notes outside WORK in both web apps, and
every new turn ends with a closing event.

### 2. Agent layer and prompts

- `bridge/agent_caps.py`: what each provider can do (system prompt, mid-turn input,
  resume, MCP, ask cards, usage meters, compaction). Replaces the `startswith("acp:")`
  checks and `claude_only_refusal`. The UI reads the same table.
- `bridge/prompt_pack.py`: fragments, each marked with what it needs and whether it
  is stable. Nothing names a tool the agent doesn't have.
- Delivery: Claude keeps `--append-system-prompt` with byte-stable packs (the cache
  rule in `runner.py` stands). ACP gets a preamble, resent when compaction is seen.
- Claude stays on `claude -p`. ACP stays one process per turn: a 2-13 s cold start
  is acceptable and restarts stay simple. The existing ponytail stands.

Done when: a Kimi session gets the "deliver last", graph and Rivendell guidance, and
Claude's appended prompt is byte-identical to today's.

### 3. Switching provider and account after a turn

- Table `session_agent_ids (session_id, agent, account, native_id, last_seen_seq)`,
  backfilled from `claude_session_id` and `agent_session_id`.
- `profiles.bind` allows a provider change whenever no turn is running.
- First turn on a new provider: a Markdown transcript at
  `.mystical/handoff/<session>.md` (`team.py` already renders one), plus a built
  digest: your prompts, the last answer, branch, changed files, open questions. No
  model writes it, since the agent you're leaving may be the one doing badly.
- Returning to a provider: resume its own session and add what happened since
  `last_seen_seq`.
- The transcript shows a divider: "Switched to Kimi · account". Per-turn `runtime`
  already records who ran what.
- Picker on all three surfaces; the bot gets it through `/profile`. Hidden on
  Rivendell job sessions, read-only team sessions and device runs.
- Same-provider account changes keep working as they do now.

Why not convert transcripts into the other tool's format: those tools exist on
GitHub, but their authors describe it as context injection rather than a real
migration, and each CLI update can break it.

Done when: Claude to Kimi to Claude in one chat, each answering a question about
earlier work, with Claude resuming its original session.

### 4. Shared tools

- `bridge/tool_gateway.py`: a stdlib MCP server. Tokens are per session and per
  turn, and reach only these tools, never the dashboard token.
- Tool allow-list per agent. Non-Claude agents start with none from external servers.
- Secrets stay in Mystical, for stdio env and for bearer headers. OAuth servers get
  their own login in the gateway: `bridge/mcp.py` says Claude owns its tokens, and
  sharing them risks refresh conflicts.
- Upstream servers start on first use, and a search-then-call tool keeps long tool
  lists out of an agent's context.
- Every call is journaled and can show a permission card. Those cards reach every
  surface through the existing pending-card path.
- Neutral `ask_user`, `run`, goals and Rivendell task tools, so a Kimi session gets
  question cards. `claude_only_refusal` shrinks to what really is Claude-only.
- Skills: `.agents/skills/<id>` symlinks to `.claude/skills/<id>`, with a switch per
  skill. A skill naming Claude-only tools, or relying on `allowed-tools`, stays off
  for other agents until checked. The `/` list returns for agent sessions. Plugin
  skills and plugin MCP servers follow with their own discovery.

Done when: Kimi calls a Rivendell read tool in a real turn with no credential in its
environment, and `reveal_secret` is not listed to it.

### 5. Channel and delegation

Tables:

- `channel_messages`: id, chat, from, to (a name or `all`), kind (`brief`, `message`,
  `result`, `question`, `note`, `human`), body, refs, state (`queued`, `held`,
  `delivered`, `read`, `dropped`), hop count, timestamps.
- `delegation_grants`: chat, the human message that created it, allowed profiles,
  remaining count, expiry.
- `sessions`: `parent_session_id`, `member_name`.

Rules:

- Delegation needs a grant. Only a message typed by the owner creates one (`@profile`,
  or a tap on the card from `request_delegation`). Agent text, Rivendell job prompts
  and other agents' messages never can.
- Tools for a session with a grant: `delegate`, `send`, `check`, `read_channel`.
- The target is a profile, so account, model and mode come along. An `auto` account
  uses `accounts.pick()`, and Claude children use the limit ladder. ACP children get
  input-required parking on a limit, and the parent is told.
- Delegation doesn't block: the parent gets a handle and can end its turn; a result
  wakes it, as `WaitForSession` does.
- Messages are delivered directly to the named agent. Everyone can read the log on
  request. Agents don't receive every message, which keeps cost down.
- Delivery: Claude at the next tool boundary through `steer`; ACP at the end of the
  turn, or at once through cancel-and-resume when you press Interrupt.
- Agent messages are labelled as coming from an agent, and can't answer a card.
- A child's permissions never exceed its parent's.
- Limits: depth 1, a cap on agents per chat, a cap per account, hops between agents
  (past it the channel holds and asks you), identical repeats dropped.
- Writers: one per folder. Extra writers get a worktree. Reviewers are read-only.
  Merging back is a diff you approve.
- Restart: queued messages survive; `recovery.py` resumes cut-off members and
  redelivers, using message ids so nothing runs twice.
- Known gap: an agent with shell access could run `claude -p` itself. Mitigation is
  asking mode and deny rules, plus a prompt rule. Stated openly in Settings.

Done when: Kimi delegates to Claude on a chosen account, they exchange messages, you
interject, and it all survives a bridge restart mid-run, against `fake_acp_agent`
and once live.

### 6. UI

**Sidebar tree (`SessionsPanel`, Mini App `ChatSwitcher`).** A chat with other agents
gets a fold beneath it: Mystical members, Claude's own subagents (`bridge/agents.py`)
and workflows. Each row shows status, name, provider, elapsed time and a needs-you
mark. It opens while agents run and shuts when they're done. Tapping opens the agent
in the main pane with a path back to its parent, and the composer then talks to that
agent. The existing sidebar filter applies to the parent only.

**Grid.** A Chat | Grid switch at the top of a multi-agent chat. One card per agent:
who, account, status, current activity, latest note, usage, waiting card. A channel
rail runs alongside. Actions: message, interrupt, stop, hold channel, stop all. In
the Mini App it becomes a single column plus a Channel tab.

**Chat view.** A delegation row with brief, status and link replaces today's "5
subagents" plate; the plate's click still opens the agent. `@` in the composer picks
a profile. Cards from any agent appear in the parent with a sender label.

**Provider picker.** The existing profile picker, greyed during a turn with the
reason shown. Pickers follow the capability table.

One-agent chats draw none of this.

### 7. Telegram, notifications, desktop

- A member's per-turn pings stay quiet, reusing `_plugin_session`, the way a Rivendell
  job pings once per job. You hear: needs you, run finished, limit hit, channel held.
- Cards use the existing `tgask` route, with the agent's name added.
- Bot: `/agents` lists the current chat's agents with status and stop buttons. A reply
  to an agent's message, or `@name …`, goes to that agent.
- `notices.emit` rows group under the parent chat, so the bell, OS banners and the
  Mac, Windows and Linux shells inherit it. Tapping opens the parent with that agent
  selected. `needs()` covers children because it reads the live status map.
- Telegram bot on agent sessions: never live-tested in this plan's research. Test it
  in workstream 3, before relying on it.

### 8. Rivendell guardrails

Run through the whole build, as a regression suite written before workstream 2:

- Jobs stay on `claude_default` with their job bar: no provider picker, no delegation,
  no grants from job prompts. Queue, once-per-job pings, the newspaper and job grouping
  don't change.
- Task-board guidance and the push check apply to every provider. Move the check from
  a Claude-only hook to a git-level one that any agent's `git push` hits, keeping the
  once-per-branch behaviour and the "Task" card.
- Non-Claude agents reach Rivendell only through the gateway's allow-list. Secret and
  infrastructure tools are refused.
- `team.py` whitelist learns the new event types. A shared multi-agent chat sends the
  parent's transcript plus each member's, and read-only team sessions refuse switching
  and delegation.
- `device_view` and read-only rules are unchanged.

## Testing

- Each workstream adds `tests/` cases, with env pins only in `conftest.py`.
- `tests/fake_acp_agent.py` grows scripted notes, delegation and interrupts.
- A live Kimi smoke per workstream that touches it.
- `bridge-eyes` screenshots of the tree, grid and picker on dashboard and Mini App.

## Risks

- **Anthropic terms.** [Their page](https://code.claude.com/docs/en/legal-and-compliance)
  permits a user signing in to the unmodified binary with their own subscription, bars
  routing plan credentials on behalf of others, and says limits assume ordinary,
  individual use. So: owner's chat only (rule 6), own logins, and caps. Heavy automated
  use could still run into limits. An API-key profile is the clean alternative.
- **Data crossing vendors.** Anything sent to Kimi goes to Moonshot. The first
  cross-provider delegation in a project says so.
- **ACP churn.** Pinned protocol v1, fixtures catch drift.
- **Cost.** Anthropic measured multi-agent systems at about 15x chat in tokens, and
  calls heavily interdependent work, like most coding, a poor fit. Hence opt-in only,
  and best for review, research and well-separated pieces.
